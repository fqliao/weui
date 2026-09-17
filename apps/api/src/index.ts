import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, json, audit } from '../../../packages/db/src/index.ts';
import { config, AppError, hash, publicError } from '../../../packages/config/src/index.ts';
import {
  identity,
  projectAccess,
  admin,
  checkPassword,
  passwordHash,
  createSession,
  sameOrigin,
} from '../../../packages/auth/src/index.ts';
import {
  createTask,
  requestPlan,
  updatePlan,
  submitRun,
  accessibleTask,
  accessibleRun,
  cancelRun,
  validateSkill,
} from '../../../packages/service/src/index.ts';
import { toolCatalog, CASES } from '../../../packages/knowledge/src/catalog.ts';
import {
  summarize,
  type CaseResult,
  terminalStatuses,
  type RunManifest,
  type Usage,
} from '../../../packages/contracts/src/index.ts';
import { recordExecution, recordDuration } from '../../../packages/contracts/src/run-record.ts';
import { estimateCny } from '../../../packages/pricing/src/report.ts';
import { queue, publishOutbox, redisConnection } from '../../../packages/queue/src/index.ts';
import { registerWebsiteRoutes } from '../../../packages/websites/src/index.ts';
import { registerDiscoveryRoutes } from '../../../packages/discovery/src/routes.ts';
import { runSelectedCases } from '../../../packages/service/src/case-runs.ts';
import { reviewRunOutcome } from '../../../packages/service/src/run-review.ts';
import { readRunControl } from '../../../packages/service/src/run-control.ts';
import { executionModeSchema } from '../../../packages/contracts/src/execution-cache.ts';
import { readPreview } from '../../../packages/executor/src/preview.ts';
import { registerPlatformRoutes } from './platform.ts';
import {
  ensurePriceBook,
  readPriceBook,
  findPrice,
  modelTargets,
} from '../../../packages/pricing/src/index.ts';
const app = Fastify({
  bodyLimit: 128 * 1024,
  logger: { level: 'warn', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'] },
});
await app.register(cookie);
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
app.addHook('onRequest', async (q) => {
  sameOrigin(q);
});
app.setErrorHandler((e, _q, r) => {
  if (e instanceof AppError)
    return r
      .code(e.status)
      .send({ code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
  if (e instanceof z.ZodError)
    return r.code(400).send({
      code: 'VALIDATION',
      message: '输入不完整或格式不正确',
      issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  if ((e as { code?: string }).code === 'P2002')
    return r.code(409).send({ code: 'CONFLICT', message: '此记录或版本已经存在，请刷新后重试' });
  const status = (e as { statusCode?: number }).statusCode;
  if (status && status < 500) return r.code(status).send({ code: 'REQUEST_ERROR', message: publicError(e) });
  console.error('api', publicError(e));
  return r.code(500).send({ code: 'INTERNAL', message: '服务暂时不可用，请查看运行日志' });
});
const params = (q: { params: unknown }) => q.params as { id: string; revision: string };
registerWebsiteRoutes(app);
registerDiscoveryRoutes(app);
await ensurePriceBook();
registerPlatformRoutes(app);
app.post('/api/case-runs', async (q) => runSelectedCases(await identity(q), q.body));
app.get('/api/runs/:id/outcome-review', async (q) => {
  const u = await identity(q);
  const run = await db.run.findUnique({ where: { id: params(q).id } });
  if (!run) throw new AppError('NOT_FOUND', '运行不存在', 404);
  await projectAccess(u, run.projectId);
  const control = await readRunControl(run);
  const records = await db.auditEvent.findMany({
    where: { targetId: run.id, action: 'run.outcome.reviewed' },
    orderBy: { createdAt: 'asc' },
  });
  return {
    runId: run.id,
    ...control,
    records: records.map((r) => ({ id: r.id, createdAt: r.createdAt, ...(r.detail as object) })),
  };
});
app.post('/api/runs/:id/outcome-review', async (q) =>
  reviewRunOutcome(await identity(q), params(q).id, q.body),
);
app.get('/api/runs/:id/preview', async (q, r) => {
  await accessibleRun(await identity(q), params(q).id);
  r.header('cache-control', 'no-store');
  return { frame: await readPreview(params(q).id) };
});
function publicRun<T extends { evidence?: { path: string }[] }>(r: T) {
  return { ...r, evidence: r.evidence?.map(({ path: _path, ...rest }) => rest) };
}
app.get('/health', async () => {
  await db.$queryRaw`SELECT 1`;
  return { ok: true, service: 'ui-agent-api' };
});
app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (q, r) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(q.body);
  const user = await db.user.findUnique({ where: { email: b.email.toLowerCase() } });
  if (!user || !user.enabled || !checkPassword(b.password, user.passwordHash))
    throw new AppError('LOGIN_FAILED', '邮箱或密码不正确', 401);
  await createSession(r, user.id);
  await audit(user.id, 'auth.login', user.id);
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role } };
});
app.post('/api/auth/logout', async (q, r) => {
  if (q.cookies.uiagent_session)
    await db.session.deleteMany({ where: { id: hash(q.cookies.uiagent_session) } });
  r.clearCookie('uiagent_session', { path: '/' });
  return { ok: true };
});
app.get('/api/auth/me', async (q) => ({ user: await identity(q) }));
app.get('/api/meta', async (q) => {
  await identity(q);
  const workers = await db.setting.findMany({ where: { key: { startsWith: 'worker:' } } });
  const online = workers.filter(
    (w) => Date.now() - Date.parse((w.value as { heartbeat: string }).heartbeat) < 10000,
  ).length;
  return {
    version: '0.2.0',
    model: {
      configured: Boolean(config.llmKey),
      name: config.LLM_MODEL,
      defaultMode: config.AGENT_MODE,
      priced: Boolean(findPrice(await readPriceBook(), modelTargets().planner)),
    },
    vision: { configured: config.visionReady, name: process.env.MIDSCENE_MODEL_NAME || null },
    workers: online,
    executionEnabled:
      (await db.setting.findUnique({ where: { key: 'execution_enabled' } }))?.value !== false &&
      config.EXECUTION_ENABLED !== 'false',
    cases: CASES,
    limits: { maxActions: 500, timeoutMs: 600000 },
  };
});
app.get('/api/projects', async (q) => {
  const u = await identity(q);
  return db.project.findMany({
    where: { memberships: { some: { userId: u.id } } },
    include: { environments: { where: { enabled: true } } },
    orderBy: { createdAt: 'asc' },
  });
});
app.get('/api/test-records', async (q) => {
  const user = await identity(q);
  const query = z
    .object({
      projectId: z.string(),
      website: z.string().optional(),
      search: z.string().max(100).default(''),
      filter: z.enum(['all', 'active', 'attention', 'passed']).default('all'),
      history: z.enum(['true', 'false']).default('false'),
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(50).default(10),
    })
    .parse(q.query);
  await projectAccess(user, query.projectId);
  const [discoveries, environments] = await Promise.all([
    db.discovery.findMany({ where: { projectId: query.projectId }, select: { taskId: true } }),
    db.environment.findMany({
      where: { projectId: query.projectId, ...(query.history === 'false' ? { enabled: true } : {}) },
    }),
  ]);
  const attention = ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'SKIPPED'].map((result) => ({
    summary: { array_contains: [{ result }] },
  }));
  const where = {
    projectId: query.projectId,
    taskId: { notIn: discoveries.map((d) => d.taskId) },
    task: {
      debugSkillId: null,
      environmentId: {
        in: environments.filter((e) => !query.website || e.id === query.website).map((e) => e.id),
      },
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
    },
    ...(query.filter === 'active'
      ? { status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } }
      : query.filter === 'attention'
        ? { OR: [{ status: { in: ['ERROR', 'CANCELLED'] } }, ...attention] }
        : query.filter === 'passed'
          ? { status: 'COMPLETED', summary: { not: [] }, NOT: { OR: attention } }
          : {}),
  };
  const total = await db.run.count({ where });
  const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.size)));
  const rows = await db.run.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * query.size,
    take: query.size,
    select: {
      id: true,
      status: true,
      summary: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      usage: true,
      parentRunId: true,
      manifest: true,
      task: { select: { id: true, title: true, environmentId: true } },
    },
  });
  const book = await readPriceBook(),
    vision = modelTargets().vision;
  return {
    total,
    page,
    rows: rows.map(({ manifest, usage, ...r }) => {
      const m = manifest as unknown as RunManifest;
      const u = usage as unknown as Usage;
      const recordedUsage = ['inputTokens', 'outputTokens', 'modelCalls', 'visionCalls'].every(
        (key) =>
          typeof (u as any)?.[key] === 'number' && Number.isFinite((u as any)[key]) && (u as any)[key] >= 0,
      );
      const cost =
        recordedUsage && r.startedAt
          ? estimateCny(u, book, vision, r.createdAt.toISOString(), m.model)
          : {
              costCny: null,
              status: 'unknown',
              notes: [r.status === 'QUEUED' ? '开始执行后统计费用' : '历史记录缺少用量或开始时间'],
            };
      return {
        ...r,
        execution: recordExecution(
          m.executionMode,
          r.summary as unknown as CaseResult[],
          r.status,
          u?.visionCalls,
        ),
        performance: {
          ...recordDuration(r.startedAt, r.finishedAt, r.status),
          costCny: cost.costCny,
          costStatus: cost.status,
          costNote: cost.notes.join(' '),
        },
        websiteName: environments.find((e) => e.id === r.task.environmentId)?.name || '历史网站',
        browser: (manifest as any).browser?.name ?? 'chrome',
        caseCount: (manifest as any).plan?.cases?.length ?? 0,
      };
    }),
  };
});
app.get('/api/tasks', async (q) => {
  const u = await identity(q),
    query = z
      .object({
        projectId: z.string(),
        search: z.string().max(100).optional(),
        status: z.string().optional(),
      })
      .parse(q.query);
  await projectAccess(u, query.projectId);
  return db.task.findMany({
    where: {
      projectId: query.projectId,
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { goal: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
});
app.post('/api/tasks', async (q) => createTask(await identity(q), q.body));
app.get('/api/tasks/:id', async (q) => accessibleTask(await identity(q), params(q).id));
app.post('/api/tasks/:id/plans', async (q) => requestPlan(await identity(q), params(q).id));
app.patch('/api/tasks/:id/plans/:revision', async (q) => {
  const b = z
    .object({ caseIds: z.array(z.string()).min(1).max(12), vision: z.boolean().default(false) })
    .parse(q.body);
  return updatePlan(
    await identity(q),
    params(q).id,
    z.coerce.number().int().positive().parse(params(q).revision),
    b.caseIds,
    b.vision,
  );
});
app.post('/api/tasks/:id/runs', async (q) => {
  const b = z
    .object({
      revision: z.number().int().positive(),
      idempotencyKey: z.string().min(8).max(100),
      parentRunId: z.string().optional(),
      executionMode: executionModeSchema.optional(),
    })
    .parse(q.body);
  return submitRun(
    await identity(q),
    params(q).id,
    b.revision,
    b.idempotencyKey,
    b.parentRunId,
    b.executionMode,
  );
});
app.get('/api/runs/:id', async (q) => publicRun(await accessibleRun(await identity(q), params(q).id)));
app.post('/api/runs/:id/cancel', async (q) => cancelRun(await identity(q), params(q).id));
app.get('/api/runs/:id/events', async (q, r) => {
  const u = await identity(q),
    id = params(q).id;
  await accessibleRun(u, id);
  const last = z
    .string()
    .regex(/^\d{1,20}$/)
    .parse(q.headers['last-event-id'] ?? (q.query as { after?: string }).after ?? '0');
  let cursor = BigInt(last),
    closed = false,
    busy = false;
  r.hijack();
  r.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  r.raw.flushHeaders();
  const send = (kind: string, data: unknown, seq?: bigint) => {
    if (!closed) r.raw.write(`${seq ? `id: ${seq}\n` : ''}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      // A long-lived connection must not outlive session or project authorization.
      const currentUser = await identity(q);
      await projectAccess(currentUser, (await db.run.findUniqueOrThrow({ where: { id } })).projectId);
      const rows = await db.runEvent.findMany({
        where: { runId: id, seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: 200,
      });
      for (const row of rows) {
        send('run-event', { ...row, seq: String(row.seq) }, row.seq);
        cursor = row.seq;
      }
      const run = await db.run.findUniqueOrThrow({ where: { id } });
      send('snapshot', {
        status: run.status,
        summary: run.summary,
        usage: run.usage,
        error: run.error,
        cleanupStatus: run.cleanupStatus,
      });
      if (terminalStatuses.has(run.status) && rows.length < 200) {
        send('end', { status: run.status });
        closed = true;
        clearInterval(timer);
        r.raw.end();
      } else if (!rows.length) r.raw.write(': keepalive\n\n');
    } catch {
      closed = true;
      clearInterval(timer);
      r.raw.end();
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), 800);
  r.raw.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
  void tick();
});
app.get('/api/runs/:id/report', async (q, r) => {
  const run = await accessibleRun(await identity(q), params(q).id),
    results = run.summary as unknown as CaseResult[];
  if ((q.query as { format?: string }).format === 'markdown') {
    const lines = [
      `# 测试运行报告`,
      ``,
      `任务：${run.task.title}`,
      `运行 ID：${run.id}`,
      `执行状态：${run.status}`,
      `环境：${(run.manifest as unknown as RunManifest).sample ? '独立样例系统' : '业务测试环境'}`,
      ``,
      ...results.flatMap((c) => [
        `## ${c.caseId} ${c.title} - ${c.result}`,
        c.message,
        ...c.assertions.map(
          (a) =>
            `- ${a.id} (${a.ruleId}): ${a.passed ? '通过' : '不成立'}；预期 ${JSON.stringify(a.expected)}；实际 ${JSON.stringify(a.actual)}`,
        ),
        ``,
      ]),
      `## 缺陷候选`,
      ...results
        .filter((c) => c.result === 'FAIL')
        .map((c) => `- ${c.title}：${c.message}。请人工复核后提交缺陷平台。`),
      ``,
      `本文件是报告和缺陷草稿，未向外部平台发送。`,
    ];
    return r
      .header('content-disposition', `attachment; filename="run-${run.id}.md"`)
      .type('text/markdown; charset=utf-8')
      .send(lines.join('\n'));
  }
  return { ...publicRun(run), counts: summarize(results) };
});
app.get('/api/evidence/:id', async (q, r) => {
  const u = await identity(q);
  const evidence = await db.evidence.findUnique({ where: { id: params(q).id }, include: { run: true } });
  if (!evidence) throw new AppError('NOT_FOUND', '证据不存在', 404);
  await projectAccess(u, evidence.run.projectId);
  const target = path.resolve(config.evidenceDir, evidence.path);
  if (!target.startsWith(config.evidenceDir + path.sep)) throw new AppError('PATH', '证据路径无效', 403);
  const data = await fs.readFile(target);
  r.header('cache-control', 'private, no-store');
  r.header('x-content-type-options', 'nosniff');
  if (evidence.kind !== 'screenshot')
    r.header('content-disposition', `attachment; filename="${evidence.fileName}"`);
  return r.type(evidence.contentType).send(data);
});
app.post('/api/runs/:id/feedback', async (q) => {
  const u = await identity(q),
    run = await accessibleRun(u, params(q).id);
  const b = z
    .object({
      rating: z.number().int().min(1).max(5),
      category: z.enum(['体验反馈', '结论纠正', '知识问题', '工具故障']),
      comment: z.string().trim().min(3).max(2000),
    })
    .parse(q.body);
  return db.feedback.create({ data: { runId: run.id, userId: u.id, ...b } });
});
app.get('/api/knowledge/releases', async (q) => {
  const u = await identity(q),
    projectId = z.string().parse((q.query as { projectId: string }).projectId);
  await projectAccess(u, projectId);
  return db.knowledgeRelease.findMany({
    where: { projectId, published: true },
    orderBy: { createdAt: 'desc' },
  });
});
app.get('/api/knowledge/releases/:id', async (q) => {
  const u = await identity(q),
    k = await db.knowledgeRelease.findUnique({ where: { id: params(q).id } });
  if (!k || !k.published) throw new AppError('NOT_FOUND', '知识版本不存在', 404);
  await projectAccess(u, k.projectId);
  return k;
});
app.get('/api/tools', async (q) => {
  const u = await identity(q);
  const projectId = z.string().parse((q.query as { projectId: string }).projectId);
  await projectAccess(u, projectId);
  return toolCatalog.map((t) => ({
    ...t,
    available: t.id.startsWith('midscene.') ? config.visionReady : true,
    scope: '项目授权 + 当前 run 数据命名空间',
    credential: t.type === 'HTTP' ? '执行侧注入（不回显）' : '无需外部凭证',
  }));
});
app.get('/api/skills', async (q) => {
  const u = await identity(q),
    projectId = z.string().parse((q.query as { projectId: string }).projectId);
  await projectAccess(u, projectId);
  return db.skill.findMany({
    where: { projectId },
    include: { releases: { orderBy: { version: 'desc' } } },
    orderBy: { createdAt: 'asc' },
  });
});
app.post('/api/skills', async (q) => {
  const u = await identity(q),
    body = z.object({ projectId: z.string(), draft: z.unknown() }).parse(q.body);
  await projectAccess(u, body.projectId);
  const draft = validateSkill(body.draft);
  const skill = await db.skill.create({
    data: {
      projectId: body.projectId,
      name: draft.name,
      description: draft.description,
      ownerId: u.id,
      draft: json(draft),
      draftHash: hash(draft),
    },
  });
  await audit(u.id, 'skill.create', skill.id, {}, skill.projectId);
  return skill;
});
async function skillAccess(q: Parameters<typeof identity>[0], id: string, edit = false) {
  const user = await identity(q);
  const skill = await db.skill.findUnique({
    where: { id },
    include: { releases: { orderBy: { version: 'desc' } } },
  });
  if (!skill) throw new AppError('NOT_FOUND', 'Skill 不存在', 404);
  await projectAccess(user, skill.projectId);
  if (edit && (skill.template || (skill.ownerId !== user.id && user.role !== 'ADMIN')))
    throw new AppError('FORBIDDEN', skill.template ? '模板请复制后修改' : '无权修改此 Skill', 403);
  return { user, skill };
}
app.get('/api/skills/:id', async (q) => {
  const { skill } = await skillAccess(q, params(q).id);
  const runs = await db.run.findMany({
    where: { task: { debugSkillId: skill.id, debugSkillHash: skill.draftHash } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, status: true, summary: true, cleanupStatus: true, createdAt: true },
  });
  return { ...skill, debugRuns: runs };
});
app.patch('/api/skills/:id/draft', async (q) => {
  const { user, skill } = await skillAccess(q, params(q).id, true);
  const draft = validateSkill((q.body as { draft: unknown }).draft);
  const updated = await db.skill.update({
    where: { id: skill.id },
    data: { name: draft.name, description: draft.description, draft: json(draft), draftHash: hash(draft) },
  });
  await audit(user.id, 'skill.edit', skill.id, { hash: updated.draftHash }, skill.projectId);
  return updated;
});
app.post('/api/skills/:id/debug-runs', async (q) => {
  const { user, skill } = await skillAccess(q, params(q).id);
  const draft = validateSkill(skill.draft);
  const b = z
    .object({
      environmentId: z.string(),
      knowledgeReleaseId: z.string(),
      mode: z.enum(['catalog', 'deepagents']).default('catalog'),
    })
    .parse(q.body);
  const task = await createTask(
    user,
    {
      projectId: skill.projectId,
      ...b,
      goal: `调试 Skill：${skill.name}。${draft.description}。用例 ${draft.caseIds.join(' ')}`,
      title: `Skill 调试 · ${skill.name}`,
      budget: { timeoutMs: 600000, maxActions: 100, maxModelCalls: 60, maxTokens: 150000, maxCostUsd: 1 },
    },
    { id: skill.id, hash: skill.draftHash, content: draft },
  );
  await requestPlan(user, task.id);
  return { taskId: task.id };
});
app.post('/api/skills/:id/releases', async (q) => {
  const { user, skill } = await skillAccess(q, params(q).id);
  admin(user);
  const b = z.object({ debugRunId: z.string() }).parse(q.body);
  const run = await accessibleRun(user, b.debugRunId);
  const manifest = run.manifest as unknown as RunManifest,
    results = run.summary as unknown as CaseResult[];
  if (
    run.task.debugSkillId !== skill.id ||
    manifest.skillHash !== skill.draftHash ||
    run.status !== 'COMPLETED' ||
    run.cleanupStatus !== 'CLEAN' ||
    !results.length ||
    results.some((c) => c.result !== 'PASS')
  )
    throw new AppError('DEBUG_REQUIRED', '请使用当前草稿完成全部调试用例并清理成功后发布');
  if (results.length !== validateSkill(skill.draft).caseIds.length)
    throw new AppError('DEBUG_COVERAGE', '调试未覆盖 Skill 声明的全部用例');
  const release = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Skill" WHERE id=${skill.id} FOR UPDATE`;
    const latest = await tx.skill.findUniqueOrThrow({ where: { id: skill.id } });
    if (latest.draftHash !== skill.draftHash)
      throw new AppError('DRAFT_CHANGED', '草稿已经改变，请重新调试', 409);
    const version =
      (await tx.skillRelease.aggregate({ where: { skillId: skill.id }, _max: { version: true } }))._max
        .version ?? 0;
    const r = await tx.skillRelease.create({
      data: {
        skillId: skill.id,
        version: version + 1,
        content: latest.draft as never,
        hash: latest.draftHash,
        debugRunId: run.id,
        publisherId: user.id,
      },
    });
    await tx.skill.update({ where: { id: skill.id }, data: { activeReleaseId: r.id } });
    return r;
  });
  await audit(user.id, 'skill.publish', release.id, { version: release.version }, skill.projectId);
  return release;
});
app.post('/api/skills/:id/rollback', async (q) => {
  const { user, skill } = await skillAccess(q, params(q).id);
  admin(user);
  const releaseId = z.string().parse((q.body as { releaseId: string }).releaseId);
  const release = await db.skillRelease.findFirst({
    where: { id: releaseId, skillId: skill.id, disabled: false },
  });
  if (!release) throw new AppError('RELEASE', '目标版本不可用');
  await db.skill.update({ where: { id: skill.id }, data: { activeReleaseId: releaseId } });
  await audit(user.id, 'skill.rollback', skill.id, { releaseId }, skill.projectId);
  return { ok: true };
});
app.post('/api/admin/execution', async (q) => {
  const u = await identity(q);
  admin(u);
  const enabled = z.boolean().parse((q.body as { enabled: boolean }).enabled);
  await db.setting.upsert({
    where: { key: 'execution_enabled' },
    create: { key: 'execution_enabled', value: enabled },
    update: { value: enabled },
  });
  await audit(u.id, 'execution.toggle', 'platform', { enabled });
  return { enabled };
});
app.post('/api/admin/users', async (q) => {
  const u = await identity(q);
  admin(u);
  const b = z
    .object({
      email: z.string().email(),
      name: z.string().min(2).max(50),
      password: z.string().min(12).max(100),
      projectId: z.string(),
      role: z.enum(['ADMIN', 'TESTER']).default('TESTER'),
    })
    .parse(q.body);
  await projectAccess(u, b.projectId);
  const user = await db.user.create({
    data: {
      email: b.email.toLowerCase(),
      name: b.name,
      passwordHash: passwordHash(b.password),
      role: b.role,
      memberships: { create: { projectId: b.projectId } },
    },
    select: { id: true, email: true, name: true, role: true },
  });
  await audit(u.id, 'user.create', user.id, {}, b.projectId);
  return user;
});
app.post('/api/admin/environments', async (q) => {
  const u = await identity(q);
  admin(u);
  const b = z
    .object({
      projectId: z.string(),
      name: z.string().min(2).max(100),
      baseUrl: z.string().url(),
      fault: z
        .enum([
          'none',
          'fake-success',
          'validation-bypass',
          'permission-bypass',
          'duplicate-submit',
          'wrong-state',
          'query-unavailable',
          'cleanup-failure',
        ])
        .default('none'),
      delayMs: z.number().min(0).max(15000).default(0),
    })
    .parse(q.body);
  await projectAccess(u, b.projectId);
  const project = await db.project.findUniqueOrThrow({ where: { id: b.projectId } });
  if (!project.sample || b.baseUrl !== config.SAMPLE_ORIGIN)
    throw new AppError(
      'ADAPTER_REQUIRED',
      '当前安装的适配器仅支持预配置审批样例地址。接入真实系统需注册对应业务适配器。',
    );
  const env = await db.environment.create({
    data: {
      projectId: b.projectId,
      name: b.name,
      baseUrl: b.baseUrl,
      adapter: 'sample-approval-v1',
      credentialRef: 'SAMPLE_SERVICE_KEY',
      config: { sample: true, fault: b.fault, delayMs: b.delayMs },
    },
  });
  await audit(u.id, 'environment.create', env.id, { fault: b.fault }, b.projectId);
  return env;
});
app.patch('/api/admin/environments/:id', async (q) => {
  const u = await identity(q);
  admin(u);
  const env = await db.environment.findUniqueOrThrow({ where: { id: params(q).id } });
  await projectAccess(u, env.projectId);
  const enabled = z.boolean().parse((q.body as { enabled: boolean }).enabled);
  await db.environment.update({ where: { id: env.id }, data: { enabled } });
  await audit(u.id, 'environment.toggle', env.id, { enabled }, env.projectId);
  return { enabled };
});
app.get('/api/admin/audit', async (q) => {
  const u = await identity(q);
  admin(u);
  const projectId = z.string().parse((q.query as { projectId: string }).projectId);
  await projectAccess(u, projectId);
  return db.auditEvent.findMany({
    where: { OR: [{ projectId }, { projectId: null, actorId: u.id }] },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
});
app.get('/api/admin/health', async (q) => {
  const u = await identity(q);
  admin(u);
  let redis = false;
  const probe = redisConnection();
  try {
    redis = (await probe.ping()) === 'PONG';
  } catch {
  } finally {
    probe.disconnect();
  }
  let sample = false;
  try {
    sample = (await fetch(new URL('/health', config.SAMPLE_ORIGIN), { signal: AbortSignal.timeout(2000) }))
      .ok;
  } catch {}
  return {
    database: true,
    redis,
    sample,
    outboxPending: await db.outbox.count({ where: { deliveredAt: null } }),
    queue: await queue.getJobCounts('waiting', 'active', 'failed', 'completed').catch(() => ({})),
    modelConfigured: Boolean(config.llmKey),
    visionConfigured: config.visionReady,
  };
});
const outboxTimer = setInterval(() => void publishOutbox(), 1000);
await app.listen({ host: process.env.API_HOST || '127.0.0.1', port: config.API_PORT });
console.log(`API http://127.0.0.1:${config.API_PORT}`);
async function close() {
  clearInterval(outboxTimer);
  await app.close();
  await queue.close();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
