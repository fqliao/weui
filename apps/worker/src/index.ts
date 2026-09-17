import { Worker } from 'bullmq';
import { caseUsageDelta } from '../../../packages/contracts/src/case-metrics.ts';
import { randomUUID } from 'node:crypto';
import { db, json, event } from '../../../packages/db/src/index.ts';
import { config, hash, publicError, AppError } from '../../../packages/config/src/index.ts';
import { planTask } from '../../../packages/agent/src/index.ts';
import { validateSkill } from '../../../packages/service/src/index.ts';
import { queueName, redisConnection, publishOutbox, queue } from '../../../packages/queue/src/index.ts';
import { browserEngine, executeCase } from '../../../packages/executor/src/index.ts';
import { ToolGateway } from '../../../packages/tools/src/gateway.ts';
import { executeDiscovery } from '../../../packages/discovery/src/executor.ts';
import {
  emptyUsage,
  type RunManifest,
  type CaseResult,
  type SkillDraft,
  type Usage,
  type CaseSpec,
} from '../../../packages/contracts/src/index.ts';
const owner = `worker-${randomUUID()}`,
  controllers = new Map<string, AbortController>();
function unexecuted(manifest: RunManifest, done: CaseResult[], message: string): CaseResult[] {
  return manifest.plan.cases
    .filter((c) => !done.some((d) => d.caseId === c.id))
    .map((c) => ({
      caseId: c.id,
      title: c.title,
      result: 'SKIPPED',
      cause: 'NOT_EXECUTED',
      message,
      assertions: [],
      evidenceIds: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempt: 1,
    }));
}
async function planning(taskId: string) {
  const claim = await db.task.updateMany({
    where: { id: taskId, status: 'PLANNING', planningLeaseOwner: null },
    data: { planningLeaseOwner: owner, planningHeartbeatAt: new Date() },
  });
  if (!claim.count) return;
  const controller = new AbortController();
  controllers.set(taskId, controller);
  const heartbeat = setInterval(
    () =>
      void db.task
        .updateMany({
          where: { id: taskId, status: 'PLANNING', planningLeaseOwner: owner },
          data: { planningHeartbeatAt: new Date() },
        })
        .catch(() => controller.abort()),
    5000,
  );
  try {
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } }),
      knowledge = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: task.knowledgeReleaseId } });
    if (
      !knowledge.published ||
      knowledge.projectId !== task.projectId ||
      hash(knowledge.content) !== knowledge.hash
    )
      throw new AppError('KNOWLEDGE', '知识发布版本无效');
    let skill: SkillDraft | null = task.debugSkillContent ? validateSkill(task.debugSkillContent) : null;
    if (task.skillReleaseId) {
      const r = await db.skillRelease.findUniqueOrThrow({
        where: { id: task.skillReleaseId },
        include: { skill: true },
      });
      if (r.disabled || r.skill.projectId !== task.projectId)
        throw new AppError('SKILL_RELEASE', 'Skill 不可用');
      skill = validateSkill(r.content);
    }
    const { plan, usage } = await planTask(
      task.goal,
      task.mode as 'catalog' | 'deepagents',
      knowledge.content,
      skill,
      controller.signal,
      task.budget,
      (task.browserSnapshot as unknown as { cases: CaseSpec[] } | null)?.cases,
    );
    if ((task.browserSnapshot as { environmentRevision?: number } | null)?.environmentRevision)
      plan.environmentRevision = (
        task.browserSnapshot as { environmentRevision: number }
      ).environmentRevision;
    await db.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: { id: taskId, status: 'PLANNING', planningLeaseOwner: owner },
        data: {
          status: 'AWAITING_APPROVAL',
          revision: { increment: 1 },
          planningLeaseOwner: null,
          planningHeartbeatAt: null,
          error: null,
        },
      });
      if (!updated.count) throw new AppError('LEASE_LOST', '规划租约已失效');
      const current = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await tx.planRevision.create({
        data: {
          taskId,
          revision: current.revision,
          content: json(plan),
          hash: hash(plan),
          usage: json(usage),
        },
      });
    });
  } catch (e) {
    await db.task.updateMany({
      where: { id: taskId, status: 'PLANNING', planningLeaseOwner: owner },
      data: { status: 'ERROR', error: publicError(e), planningLeaseOwner: null, planningHeartbeatAt: null },
    });
  } finally {
    clearInterval(heartbeat);
    controllers.delete(taskId);
  }
}
async function running(runId: string) {
  const claim = await db.run.updateMany({
    where: { id: runId, status: 'QUEUED', leaseOwner: null },
    data: {
      status: 'RUNNING',
      leaseOwner: owner,
      leaseEpoch: { increment: 1 },
      heartbeatAt: new Date(),
      startedAt: new Date(),
    },
  });
  if (!claim.count) return;
  const run = await db.run.findUniqueOrThrow({ where: { id: runId } }),
    manifest = run.manifest as unknown as RunManifest;
  const controller = new AbortController();
  controllers.set(runId, controller);
  const usage = { ...emptyUsage(), ...(run.usage as unknown as Usage) };
  const gateway = new ToolGateway(runId, owner, run.leaseEpoch, manifest, usage, controller.signal);
  let results: CaseResult[] = [],
    finalStatus = 'COMPLETED',
    error: string | undefined,
    cleanupFailed = false,
    browser: Awaited<ReturnType<typeof browserEngine>> | undefined;
  const deadline = setTimeout(
    () => controller.abort(new AppError('BUDGET', '任务超过时间预算')),
    manifest.budget.timeoutMs,
  );
  let checking = false;
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const current = await db.run.findUniqueOrThrow({ where: { id: runId } });
      if (
        current.leaseOwner !== owner ||
        current.leaseEpoch !== run.leaseEpoch ||
        current.cancelRequestedAt ||
        current.status === 'CANCEL_REQUESTED'
      )
        controller.abort(new AppError('CANCELLED', '取消或租约失效'));
      else
        await db.run.updateMany({
          where: { id: runId, leaseOwner: owner, leaseEpoch: run.leaseEpoch, status: 'RUNNING' },
          data: { heartbeatAt: new Date() },
        });
    } catch {
      controller.abort(new Error('任务状态存储不可用'));
    } finally {
      checking = false;
    }
  }, 500);
  try {
    await db.task.update({ where: { id: run.taskId }, data: { status: 'RUNNING' } });
    await event(runId, 'started', { message: 'Worker 已取得隔离执行租约', sample: manifest.sample, owner });
    await gateway.active();
    if (hash(manifest.plan) !== manifest.planHash) throw new AppError('MANIFEST', '运行计划哈希不一致');
    browser = await browserEngine({
      browserName: manifest.browser?.name,
      signal: controller.signal,
      beforeAttempt: () => gateway.active(),
      onEvent: async ({ type, ...details }) => {
        await event(runId, type, details);
      },
    });
    if (manifest.discovery) await executeDiscovery(gateway, browser);
    for (const spec of manifest.discovery ? [] : manifest.plan.cases) {
      await gateway.active();
      await event(runId, 'case.started', { caseId: spec.id, title: spec.title });
      const beforeUsage = structuredClone(usage);
      const output = await executeCase(gateway, browser, spec);
      output.result.metrics = caseUsageDelta(
        beforeUsage,
        usage,
        Math.max(0, Date.parse(output.result.finishedAt) - Date.parse(output.result.startedAt)),
      );
      results.push(output.result);
      cleanupFailed ||= output.cleanupFailed;
      await db.run.updateMany({
        where: { id: runId, leaseOwner: owner, leaseEpoch: run.leaseEpoch },
        data: { summary: json(results), usage: json(usage) },
      });
      await event(runId, 'case.completed', output.result);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (output.result.cause === 'BUDGET') throw new AppError('BUDGET', output.result.message);
      if (cleanupFailed) throw new AppError('CLEANUP_FAILED', '隔离数据清理失败，已停止后续用例');
    }
  } catch (e) {
    const current = await db.run.findUniqueOrThrow({ where: { id: runId } });
    finalStatus = current.cancelRequestedAt ? 'CANCELLED' : 'ERROR';
    error = publicError(e);
    const skipped = unexecuted(
      manifest,
      results,
      finalStatus === 'CANCELLED' ? '用户取消，未执行' : '执行已停止，未执行',
    );
    if (!results.length && finalStatus === 'ERROR' && skipped.length) {
      skipped[0].result = 'BLOCKED';
      skipped[0].cause = e instanceof AppError ? e.code : 'ENVIRONMENT';
      skipped[0].message = error;
    }
    results.push(...skipped);
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    controllers.delete(runId);
    if (browser) {
      try {
        await browser.close();
        await event(runId, 'browser.closed', { message: '浏览器及隔离会话已自动关闭' });
      } catch (e) {
        await event(runId, 'browser.cleanup.failed', {
          message: '浏览器资源回收失败',
          error: publicError(e),
        });
      }
    }
    const current = await db.run.findUniqueOrThrow({ where: { id: runId } });
    if (current.cancelRequestedAt) finalStatus = 'CANCELLED';
    const cleanupStatus = cleanupFailed
      ? 'FAILED'
      : manifest.environment.adapter === 'midscene-web-v1' &&
          results.every((r) => r.businessWriteAttempts === 0 || r.result === 'SKIPPED')
        ? 'NOT_REQUIRED'
        : manifest.plan.cases.some(
              (c) => c.browser && c.browser.steps.some((s) => s.kind !== 'wait') && !c.browser.cleanup.length,
            )
          ? 'NOT_CONFIGURED'
          : 'CLEAN';
    const done = await db.run.updateMany({
      where: {
        id: runId,
        leaseOwner: owner,
        leaseEpoch: run.leaseEpoch,
        status: { in: ['RUNNING', 'CANCEL_REQUESTED'] },
      },
      data: {
        status: finalStatus,
        summary: json(results),
        usage: json(usage),
        error,
        finishedAt: new Date(),
        cleanupStatus,
        heartbeatAt: new Date(),
      },
    });
    if (done.count) {
      await db.task.update({ where: { id: run.taskId }, data: { status: finalStatus, error } });
      await event(runId, 'finished', {
        status: finalStatus,
        cleanupStatus,
        usage,
        error,
      });
    }
  }
}
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await db.setting.upsert({
      where: { key: `worker:${owner}` },
      update: { value: { heartbeat: new Date().toISOString(), pid: process.pid } },
      create: { key: `worker:${owner}`, value: { heartbeat: new Date().toISOString(), pid: process.pid } },
    });
    const cutoff = new Date(Date.now() - 30000);
    await db.task.updateMany({
      where: {
        status: 'PLANNING',
        planningLeaseOwner: { not: null },
        planningHeartbeatAt: { lt: new Date(Date.now() - config.MODEL_TIMEOUT_MS - 30000) },
      },
      data: { status: 'ERROR', error: '规划 Worker 失联，请重新生成计划', planningLeaseOwner: null },
    });
    for (const stale of await db.run.findMany({
      where: {
        OR: [
          { status: 'RUNNING', heartbeatAt: { lt: cutoff } },
          { status: 'CANCEL_REQUESTED', leaseOwner: null },
          { status: 'CANCEL_REQUESTED', heartbeatAt: { lt: cutoff } },
        ],
      },
    })) {
      const manifest = stale.manifest as unknown as RunManifest,
        done = stale.summary as unknown as CaseResult[];
      const pending = unexecuted(manifest, done, '执行取消或 Worker 失联，未重放');
      const actions = await db.action.findMany({ where: { runId: stale.id } });
      for (const row of pending)
        if (actions.some((a) => a.caseId === row.caseId && (a.input as { write?: boolean }).write)) {
          row.result = 'INCONCLUSIVE';
          row.cause = 'UNKNOWN';
          row.message = 'Worker 失联，可能存在未确认的副作用；禁止重放';
        }
      const state = stale.cancelRequestedAt ? 'CANCELLED' : 'ERROR';
      const changed = await db.run.updateMany({
        where: {
          id: stale.id,
          status: stale.status,
          leaseEpoch: stale.leaseEpoch,
          heartbeatAt: stale.heartbeatAt,
        },
        data: {
          status: state,
          error: state === 'ERROR' ? 'Worker 失联；浏览器现场不自动恢复' : null,
          summary: json([...done, ...pending]),
          leaseEpoch: { increment: 1 },
          finishedAt: new Date(),
          cleanupStatus: actions.length ? 'FAILED' : 'CLEAN',
        },
      });
      if (changed.count) {
        await db.task.update({ where: { id: stale.taskId }, data: { status: state } });
        await event(stale.id, 'finished', { status: state, message: '取消或失联处理完成，未重放任何写操作' });
      }
    }
  } catch (e) {
    console.error('sweep', publicError(e));
  } finally {
    sweeping = false;
  }
}
const worker = new Worker(
  queueName,
  async (job) => {
    if (job.name === 'plan') await planning(job.data.referenceId);
    else if (job.name === 'run') await running(job.data.referenceId);
  },
  { connection: redisConnection(), concurrency: config.WORKER_CONCURRENCY, lockDuration: 30000 },
);
worker.on('failed', (_j, e) => console.error('worker job failed', publicError(e)));
worker.on('error', (e) => console.error('worker connection', publicError(e)));
const publishTimer = setInterval(() => void publishOutbox(), 750),
  sweepTimer = setInterval(() => void sweep(), 3000);
await publishOutbox();
await sweep();
console.log(`Worker ready ${owner}`);
async function shutdown() {
  clearInterval(publishTimer);
  clearInterval(sweepTimer);
  for (const c of controllers.values()) c.abort(new Error('Worker 正在退出'));
  await worker.close();
  await queue.close();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
