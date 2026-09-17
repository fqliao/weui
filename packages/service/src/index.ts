import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db, json, audit } from '../../db/src/index.ts';
import { AppError, config, hash } from '../../config/src/index.ts';
import {
  taskSchema,
  skillDraftSchema,
  type Plan,
  type RunManifest,
  emptyUsage,
  terminalStatuses,
  type SkillDraft,
} from '../../contracts/src/index.ts';
import { toolCatalog, CASES, RULES } from '../../knowledge/src/catalog.ts';
import { projectAccess, type Identity } from '../../auth/src/index.ts';
import { PROMPT_VERSION } from '../../agent/src/index.ts';
import { WEB_ADAPTER } from '../../websites/src/policy.ts';
import { snapshotCases, caseKnowledge, profileForRun } from '../../websites/src/index.ts';
import { readRunControl } from './run-control.ts';
import { readPriceBook, modelTargets } from '../../pricing/src/index.ts';
import { configuredBrowser, browserNameSchema } from '../../contracts/src/browser-choice.ts';
import { executionModeSchema, type ExecutionMode } from '../../contracts/src/execution-cache.ts';

export function validateSkill(draft: unknown) {
  const parsed = skillDraftSchema.parse(draft);
  if ([parsed.caseIds, parsed.toolIds, parsed.ruleIds].some((ids) => new Set(ids).size !== ids.length))
    throw new AppError('DUPLICATE_DEPENDENCY', 'Skill 的用例、工具与规则不能重复');
  if (parsed.toolIds.some((id) => !toolCatalog.some((t) => t.id === id)))
    throw new AppError('UNKNOWN_TOOL', 'Skill 引用了未注册工具');
  if (parsed.caseIds.some((id) => !CASES.some((c) => c.id === id)))
    throw new AppError('UNKNOWN_CASE', 'Skill 引用了未注册用例');
  if (parsed.ruleIds.some((id) => !RULES.some((r) => r.id === id)))
    throw new AppError('UNKNOWN_RULE', 'Skill 引用了未注册规则');
  const required = CASES.filter((c) => parsed.caseIds.includes(c.id)).flatMap((c) => c.ruleIds);
  if (required.some((id) => !parsed.ruleIds.includes(id)))
    throw new AppError('MISSING_RULE', 'Skill 未声明所选用例的全部规则依赖');
  const requiredTools = [
    'browser.run_case',
    'business.query',
    'fixture.prepare',
    'fixture.cleanup',
    'assertions.verify',
  ];
  if (requiredTools.some((id) => !parsed.toolIds.includes(id)))
    throw new AppError('MISSING_TOOL', 'Skill 缺少执行、查询、准备、清理或独立断言工具');
  return parsed;
}
export async function createTask(
  user: Identity,
  input: unknown,
  debug?: { id: string; hash: string; content: SkillDraft },
  direct?: { id: string; requestHash: string },
) {
  const data = taskSchema.parse(input);
  await projectAccess(user, data.projectId);
  const env = await db.environment.findFirst({
    where: { id: data.environmentId, projectId: data.projectId, enabled: true },
  });
  if (!env) throw new AppError('ENVIRONMENT', '环境不可用或无权访问');
  if (!['sample-approval-v1', WEB_ADAPTER].includes(env.adapter))
    throw new AppError('ADAPTER_NOT_INSTALLED', '尚未安装此业务适配器');
  const { caseIds, browserName, executionMode, ...taskData } = data;
  let browserSnapshot: Record<string, unknown> | undefined;
  if (env.adapter === WEB_ADAPTER) {
    if (!caseIds?.length) throw new AppError('CASES', '请先创建功能用例，再选择本次测试范围');
    if (data.skillReleaseId || debug)
      throw new AppError('SKILL_SCOPE', '审批样例 Skill 不能用于自定义网站；请在网站用例中编写测试方法');
    const cases = await snapshotCases(env.id, caseIds);
    browserSnapshot = { cases, environmentRevision: env.revision };
    taskData.knowledgeReleaseId = (await caseKnowledge(data.projectId, cases)).id;
  }
  if (!taskData.knowledgeReleaseId) throw new AppError('KNOWLEDGE', '请选择知识快照');
  if (direct) {
    if (env.adapter === 'sample-approval-v1') {
      if (!caseIds?.length || caseIds.some((id) => !CASES.some((c) => c.id === id)))
        throw new AppError('CASES', '所选样例用例不存在');
      browserSnapshot = { cases: caseIds.map((id) => CASES.find((c) => c.id === id)!) };
    }
    browserSnapshot = { ...browserSnapshot, directRequestHash: direct.requestHash };
  }
  if (data.mode === 'deepagents' && !config.llmKey)
    throw new AppError('MODEL_NOT_CONFIGURED', '规划模型尚未配置');
  const knowledge = await db.knowledgeRelease.findFirst({
    where: { id: taskData.knowledgeReleaseId, projectId: data.projectId, published: true },
  });
  if (!knowledge) throw new AppError('KNOWLEDGE', '知识快照不可用');
  if (data.skillReleaseId) {
    const release = await db.skillRelease.findFirst({
      where: { id: data.skillReleaseId, disabled: false, skill: { projectId: data.projectId } },
    });
    if (!release) throw new AppError('SKILL_RELEASE', 'Skill 发布版本不可用');
  }
  browserSnapshot = {
    ...browserSnapshot,
    browserName: browserName ?? configuredBrowser(env.config),
    executionMode: executionMode ?? 'l2',
  };
  const record = {
    ...taskData,
    knowledgeReleaseId: taskData.knowledgeReleaseId,
    browserSnapshot: browserSnapshot ? json(browserSnapshot) : undefined,
    title: data.title || data.goal.slice(0, 70),
    creatorId: user.id,
    budget: json(data.budget),
    debugSkillId: debug?.id,
    debugSkillHash: debug?.hash,
    debugSkillContent: debug ? json(debug.content) : undefined,
  };
  let created = true;
  if (direct)
    created =
      (await db.task.createMany({ data: [{ ...record, id: direct.id }], skipDuplicates: true })).count === 1;
  const task = direct
    ? await db.task.findUniqueOrThrow({ where: { id: direct.id } })
    : await db.task.create({ data: record });
  if (created) await audit(user.id, 'task.create', task.id, { mode: task.mode }, task.projectId);
  return task;
}
export async function accessibleTask(user: Identity, id: string) {
  const task = await db.task.findUnique({
    where: { id },
    include: { plans: { orderBy: { revision: 'desc' }, take: 1 }, runs: { orderBy: { createdAt: 'desc' } } },
  });
  if (!task) throw new AppError('NOT_FOUND', '任务不存在', 404);
  await projectAccess(user, task.projectId);
  return task;
}
export function owns(user: Identity, creatorId: string) {
  if (user.id !== creatorId && user.role !== 'ADMIN')
    throw new AppError('FORBIDDEN', '只能修改自己创建的任务', 403);
}
export async function requestPlan(user: Identity, id: string) {
  const task = await accessibleTask(user, id);
  if ((task.browserSnapshot as { discovery?: unknown } | null)?.discovery)
    throw new AppError('DISCOVERY', '探索任务请在探索与用例沉淀中查看，不使用正式测试规划');
  owns(user, task.creatorId);
  await db.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({
      where: { id, status: { in: ['DRAFT', 'AWAITING_APPROVAL', 'ERROR', 'COMPLETED', 'CANCELLED'] } },
      data: { status: 'PLANNING', error: null, planningLeaseOwner: null, planningHeartbeatAt: null },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT', '任务正在规划或执行', 409);
    await tx.outbox.create({
      data: { kind: 'plan', referenceId: id, dedupeKey: `plan-${id}-${randomUUID()}`, payload: {} },
    });
  });
  return { id, status: 'PLANNING' };
}
export async function updatePlan(
  user: Identity,
  id: string,
  revision: number,
  caseIds: string[],
  vision: boolean,
) {
  const task = await accessibleTask(user, id);
  owns(user, task.creatorId);
  if ((task.browserSnapshot as { discovery?: unknown } | null)?.discovery)
    throw new AppError('DISCOVERY', '探索范围已锁定，请创建新的探索任务');
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length)
    throw new AppError('INVALID_CASES', '请选择不重复的用例');
  return db.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({
      where: { id, revision, status: 'AWAITING_APPROVAL' },
      data: { revision: { increment: 1 } },
    });
    if (!claimed.count) throw new AppError('REVISION_CONFLICT', '计划已改变或已执行，请刷新后确认', 409);
    const old = await tx.planRevision.findUniqueOrThrow({
      where: { taskId_revision: { taskId: id, revision } },
    });
    const p = old.content as unknown as Plan;
    if (caseIds.some((c) => !p.cases.some((v) => v.id === c)))
      throw new AppError('INVALID_CASES', '调整只能从本次已审核范围内选择用例；扩大范围请重新规划');
    const plan = { ...p, vision: true, cases: p.cases.filter((c) => caseIds.includes(c.id)) };
    return tx.planRevision.create({
      data: {
        taskId: id,
        revision: revision + 1,
        content: json(plan),
        hash: hash(plan),
        usage: old.usage as Prisma.InputJsonValue,
      },
    });
  });
}
export async function submitRun(
  user: Identity,
  taskId: string,
  revision: number,
  key: string,
  parentRunId?: string,
  executionMode?: ExecutionMode,
) {
  const task = await accessibleTask(user, taskId);
  owns(user, task.creatorId);
  if (key.length < 8 || key.length > 100) throw new AppError('IDEMPOTENCY_KEY', '提交幂等键长度应为 8-100');
  if (
    config.EXECUTION_ENABLED === 'false' ||
    (await db.setting.findUnique({ where: { key: 'execution_enabled' } }))?.value === false
  )
    throw new AppError('EXECUTION_PAUSED', '管理员已暂停新任务执行', 503);
  const existing = await db.run.findUnique({
    where: { taskId_idempotencyKey: { taskId, idempotencyKey: key } },
  });
  const requestedMode = executionModeSchema.parse(
    executionMode ?? (task.browserSnapshot as { executionMode?: string } | null)?.executionMode ?? 'l2',
  );
  if (existing) {
    if (((existing.manifest as any).executionMode ?? 'l2') !== requestedMode)
      throw new AppError('IDEMPOTENCY_CONFLICT', '同一次请求不能变更缓存执行方式', 409);
    return existing;
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id=${taskId} FOR UPDATE`;
    const repeat = await tx.run.findUnique({
      where: { taskId_idempotencyKey: { taskId, idempotencyKey: key } },
    });
    if (repeat) {
      if (((repeat.manifest as any).executionMode ?? 'l2') !== requestedMode)
        throw new AppError('IDEMPOTENCY_CONFLICT', '同一次请求不能变更缓存执行方式', 409);
      return repeat;
    }
    const t = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    if (
      t.revision !== revision ||
      !['AWAITING_APPROVAL', 'COMPLETED', 'ERROR', 'CANCELLED'].includes(t.status)
    )
      throw new AppError('REVISION_CONFLICT', '计划已改变或任务正在执行，请刷新', 409);
    const planRow = await tx.planRevision.findUniqueOrThrow({
      where: { taskId_revision: { taskId, revision } },
    });
    const plan = planRow.content as unknown as Plan;
    if (plan.missingRequirements.length)
      throw new AppError('MISSING_REQUIREMENTS', '关键规则或需求缺失，不能确认执行');
    const env = await tx.environment.findUniqueOrThrow({ where: { id: t.environmentId } });
    const project = await tx.project.findUniqueOrThrow({ where: { id: t.projectId } });
    if (!env.enabled || env.projectId !== t.projectId) throw new AppError('ENVIRONMENT', '环境已禁用');
    if (project.sample && config.ALLOW_SAMPLE_ENVIRONMENT !== 'true')
      throw new AppError('SAMPLE_DISABLED', '此部署未开放样例环境');
    if (!config.visionReady)
      throw new AppError('VISION_NOT_CONFIGURED', 'Midscene 视觉模型未配置，暂时只能维护用例和生成计划');
    if (env.adapter === WEB_ADAPTER) {
      if (plan.environmentRevision !== env.revision)
        throw new AppError('ENVIRONMENT_CHANGED', '网站配置已改变，请重新创建任务');
      for (const c of plan.cases) {
        if (!c.browser) throw new AppError('INVALID_PLAN', '网站用例缺少执行快照');
        if (c.browser.sessionId) await profileForRun(c.browser.sessionId, c.browser.sessionRevision!, env.id);
      }
    }
    const knowledge = await tx.knowledgeRelease.findUniqueOrThrow({ where: { id: t.knowledgeReleaseId } });
    if (
      !knowledge.published ||
      knowledge.projectId !== t.projectId ||
      hash(knowledge.content) !== knowledge.hash
    )
      throw new AppError('KNOWLEDGE_CHANGED', '知识版本不可用或哈希不一致');
    let skill: SkillDraft | null = null,
      skillHash: string | null = null;
    if (t.debugSkillId) {
      skill = validateSkill(t.debugSkillContent);
      skillHash = t.debugSkillHash;
    } else if (t.skillReleaseId) {
      const r = await tx.skillRelease.findUniqueOrThrow({
        where: { id: t.skillReleaseId },
        include: { skill: true },
      });
      if (r.disabled || r.skill.projectId !== t.projectId || hash(r.content) !== r.hash)
        throw new AppError('SKILL_RELEASE', 'Skill 版本已失效');
      skill = validateSkill(r.content);
      skillHash = r.hash;
    }
    if (skill && plan.cases.some((c) => !skill.caseIds.includes(c.id)))
      throw new AppError('SKILL_SCOPE', '计划超出 Skill 用例范围');
    const previous = await tx.run.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
    if (!previous && (t.browserSnapshot as { directRequestHash?: string } | null)?.directRequestHash) {
      // A fresh selection must not provide a way around a previous uncertain
      // execution of the same website/case. Serialize concurrent direct starts.
      await tx.$queryRaw`SELECT id FROM "Environment" WHERE id=${env.id} FOR UPDATE`;
      for (const selected of plan.cases) {
        const latest = await tx.run.findFirst({
          where: {
            task: { environmentId: env.id },
            manifest: { path: ['plan', 'cases'], array_contains: [{ id: selected.id }] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (!latest) continue;
        const control = await readRunControl(latest, tx, selected.id);
        if (!control.retry.allowed)
          throw new AppError('PREVIOUS_RUN', `${selected.title}：${control.retry.reason}`, 409, {
            runId: latest.id,
            caseId: selected.id,
            caseTitle: selected.title,
            reviewable: !!control.review?.pendingCases.length,
            executionMessage: (latest.summary as { caseId: string; message?: string }[])
              .find((r) => r.caseId === selected.id)
              ?.message?.slice(0, 800),
          });
      }
    }
    const discovery = (t.browserSnapshot as unknown as { discovery?: RunManifest['discovery'] } | null)
      ?.discovery;
    if (previous && discovery)
      throw new AppError('DISCOVERY', '此探索已启动，请新建探索以保留本次草稿与审核记录');
    if (previous && parentRunId !== previous.id)
      throw new AppError('PARENT_RUN', '重新执行必须明确引用最近一次运行，不能绕过未知结果检查');
    if (parentRunId) {
      const parent = await tx.run.findUnique({ where: { id: parentRunId } });
      if (!parent || parent.taskId !== taskId || !terminalStatuses.has(parent.status))
        throw new AppError('PARENT_RUN', '重跑引用无效');
      const control = await readRunControl(parent, tx);
      if (!control.retry.allowed) throw new AppError('UNKNOWN_OUTCOME', control.retry.reason);
      if (control.retry.noBusinessActions)
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            projectId: parent.projectId,
            action: 'run.retry.checked',
            targetId: parent.id,
            detail: json({ reason: control.retry.reason, decision: 'no_business_actions' }),
          },
        });
    }
    const manifest: RunManifest = {
      executionMode: requestedMode,
      browser: {
        name: browserNameSchema.parse(
          (t.browserSnapshot as { browserName?: string } | null)?.browserName ??
            configuredBrowser(env.config),
        ),
        engine: 'playwright',
      },
      ...(discovery ? { discovery } : {}),
      version: '1',
      projectId: t.projectId,
      environmentId: env.id,
      environment: {
        baseUrl: env.baseUrl,
        adapter: env.adapter,
        credentialRef: env.credentialRef,
        config: env.config as Record<string, unknown>,
      },
      plan,
      planHash: planRow.hash,
      revision,
      knowledgeReleaseId: knowledge.id,
      knowledgeHash: knowledge.hash,
      skillReleaseId: t.skillReleaseId,
      skillHash,
      skillContent: skill,
      toolVersions: Object.fromEntries(toolCatalog.map((x) => [x.id, x.version])),
      assertionsVersion:
        env.adapter === WEB_ADAPTER ? 'midscene-ui-assertions-1.0.0' : 'sample-assertions-1.0.0',
      codeVersion: process.env.BUILD_REVISION || 'mvp-0.2.0',
      model: t.mode === 'deepagents' ? config.LLM_MODEL : 'catalog',
      models: modelTargets(),
      pricing: await readPriceBook(),
      promptVersion: PROMPT_VERSION,
      budget: {
        ...(t.budget as RunManifest['budget']),
        maxCostCny: (t.budget as RunManifest['budget']).maxCostCny ?? config.RUN_MAX_COST_CNY,
      },
      sample: env.adapter === 'sample-approval-v1',
      debug: Boolean(t.debugSkillId),
    };
    const run = await tx.run.create({
      data: {
        taskId,
        projectId: t.projectId,
        creatorId: user.id,
        idempotencyKey: key,
        parentRunId,
        manifest: json(manifest),
        summary: [],
        usage: parentRunId ? json(emptyUsage()) : (planRow.usage as Prisma.InputJsonValue),
      },
    });
    await tx.outbox.create({
      data: { kind: 'run', referenceId: run.id, dedupeKey: `run-${run.id}`, payload: {} },
    });
    await tx.task.update({ where: { id: taskId }, data: { status: 'QUEUED' } });
    await tx.runEvent.create({
      data: { runId: run.id, kind: 'queued', payload: { message: '计划已确认，等待 Worker' } },
    });
    return run;
  });
}
export async function accessibleRun(user: Identity, id: string) {
  const run = await db.run.findUnique({
    where: { id },
    include: { task: true, evidence: { orderBy: { createdAt: 'asc' } }, feedback: true },
  });
  if (!run) throw new AppError('NOT_FOUND', '运行不存在', 404);
  await projectAccess(user, run.projectId);
  return { ...run, ...(await readRunControl(run)) };
}
export async function cancelRun(user: Identity, id: string) {
  const run = await accessibleRun(user, id);
  owns(user, run.creatorId);
  if (terminalStatuses.has(run.status)) return { status: run.status };
  await db.run.updateMany({
    where: { id, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
    data: { status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date() },
  });
  await audit(user.id, 'run.cancel', id, {}, run.projectId);
  return { status: 'CANCEL_REQUESTED' };
}
