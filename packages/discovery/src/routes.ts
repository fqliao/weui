import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, json } from '../../db/src/index.ts';
import { identity, projectAccess, type Identity } from '../../auth/src/index.ts';
import { config, hash, AppError } from '../../config/src/index.ts';
import { websiteAccess, originsOf, profileForRun } from '../../websites/src/index.ts';
import { assertAllowedUrl } from '../../websites/src/policy.ts';
import { candidateSchema, discoveryInputSchema, requirementLines } from '../../contracts/src/discovery.ts';
import { budgetSchema, emptyUsage, type CaseSpec, type Plan } from '../../contracts/src/index.ts';
import { submitRun } from '../../service/src/index.ts';
import { readRunControl } from '../../service/src/run-control.ts';
import { validateBaseline } from './convergence.ts';
import type { DiscoverySnapshot } from '../../contracts/src/discovery.ts';
import { configuredBrowser } from '../../contracts/src/browser-choice.ts';

export function registerDiscoveryRoutes(app: FastifyInstance) {
  const idOf = (q: { params: unknown }) => (q.params as { id: string }).id;
  async function access(user: Identity, id: string) {
    const row = await db.discovery.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', '探索任务不存在', 404);
    await projectAccess(user, row.projectId);
    return row;
  }
  app.get('/api/discoveries', async (q) => {
    const u = await identity(q),
      b = z
        .object({
          projectId: z.string(),
          page: z.coerce.number().int().min(1).optional(),
          size: z.coerce.number().int().min(1).max(50).default(10),
          website: z.string().optional(),
          filter: z.enum(['all', 'review', 'active']).default('all'),
          search: z.string().max(100).default(''),
          history: z.enum(['true', 'false']).default('false'),
        })
        .parse(q.query);
    await projectAccess(u, b.projectId);
    const environments = b.page
      ? await db.environment.findMany({
          where: {
            projectId: b.projectId,
            ...(b.history === 'false' ? { enabled: true } : {}),
            ...(b.website ? { id: b.website } : {}),
          },
          select: { id: true },
        })
      : [];
    const activeTasks =
      b.filter === 'active'
        ? await db.task.findMany({
            where: {
              projectId: b.projectId,
              status: { in: ['RUNNING', 'QUEUED', 'PLANNING', 'CANCEL_REQUESTED'] },
            },
            select: { id: true },
          })
        : [];
    const where = {
      projectId: b.projectId,
      ...(b.page ? { environmentId: { in: environments.map((e) => e.id) } } : {}),
      ...(b.search ? { title: { contains: b.search, mode: 'insensitive' as const } } : {}),
      ...(b.filter === 'review' ? { drafts: { some: { status: 'DRAFT' } } } : {}),
      ...(b.filter === 'active' ? { taskId: { in: activeTasks.map((t) => t.id) } } : {}),
    };
    const total = b.page ? await db.discovery.count({ where }) : 0;
    const page = b.page ? Math.min(b.page, Math.max(1, Math.ceil(total / b.size))) : 1;
    const rows = await db.discovery.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: b.page ? b.size : 100,
      ...(b.page ? { skip: (page - 1) * b.size } : {}),
    });
    const tasks = await db.task.findMany({
      where: { id: { in: rows.map((r) => r.taskId) } },
      select: { id: true, status: true },
    });
    const counts = await db.discoveryDraft.groupBy({
      by: ['discoveryId', 'status'],
      where: { discoveryId: { in: rows.map((r) => r.id) } },
      _count: true,
    });
    const items = rows.map(({ requirements: _requirements, report: _report, ...row }) => ({
      ...row,
      status: tasks.find((t) => t.id === row.taskId)?.status,
      draftCounts: Object.fromEntries(
        counts.filter((c) => c.discoveryId === row.id).map((c) => [c.status, c._count]),
      ),
      pageCount: ((_report as any)?.observations || []).length,
    }));
    return b.page ? { rows: items, total, page } : items;
  });
  app.post('/api/discoveries', async (q) => {
    const u = await identity(q),
      b = discoveryInputSchema.parse(q.body),
      env = await websiteAccess(u, b.environmentId);
    if (!env.enabled) throw new AppError('ENVIRONMENT', '网站已停用');
    if (!config.llmKey || !config.visionReady)
      throw new AppError('MODEL_NOT_CONFIGURED', '探索需要配置规划模型和 Midscene 视觉模型');
    assertAllowedUrl(b.startPath, env.baseUrl, originsOf(env));
    const profile = b.sessionId ? await db.loginProfile.findUnique({ where: { id: b.sessionId } }) : null;
    if (b.sessionId) await profileForRun(b.sessionId, profile?.revision ?? -1, env.id);
    let baseline: DiscoverySnapshot['baseline'];
    if (b.phase !== 'MAIN') {
      if (!b.baselineDiscoveryId || !b.baselineRunId)
        throw new AppError('DISCOVERY_BASELINE', '请先选择上一阶段探索与正式验证运行');
      const previous = await access(u, b.baselineDiscoveryId);
      const run = await db.run.findUnique({ where: { id: b.baselineRunId } });
      if (!run || run.projectId !== env.projectId) throw new AppError('DISCOVERY_BASELINE', '基线运行不可用');
      const drafts = await db.discoveryDraft.findMany({
        where: { discoveryId: previous.id, status: 'PUBLISHED' },
      });
      validateBaseline(
        b.phase,
        previous,
        env.id,
        drafts.flatMap((d) => (d.publishedCaseId ? [d.publishedCaseId] : [])),
        run,
      );
      const control = await readRunControl(run);
      if (!control.retry.allowed) throw new AppError('DISCOVERY_BASELINE', control.retry.reason);
      baseline = { discoveryId: previous.id, runId: run.id, cases: (run.manifest as any).plan.cases };
    } else if (b.baselineDiscoveryId || b.baselineRunId)
      throw new AppError('DISCOVERY_PHASE', '主链路阶段不接受其他阶段作为基线');
    let domainRules: NonNullable<DiscoverySnapshot['domainRules']> = [];
    if (b.knowledgeReleaseId) {
      const knowledge = await db.knowledgeRelease.findFirst({
        where: { id: b.knowledgeReleaseId, projectId: env.projectId, published: true },
      });
      if (!knowledge || hash(knowledge.content) !== knowledge.hash)
        throw new AppError('KNOWLEDGE', '知识版本不可用');
      domainRules = z
        .array(z.object({ id: z.string(), title: z.string(), text: z.string() }))
        .max(100)
        .parse((knowledge.content as any).rules);
      if (JSON.stringify(domainRules).length > 30000)
        throw new AppError('KNOWLEDGE', '知识范围过大，请选择聚焦的知识版本');
    }
    const id = randomUUID(),
      taskId = randomUUID();
    const spec: CaseSpec = {
      id,
      title: b.title,
      category: '网站探索',
      ruleIds: [],
      steps: ['浏览网站并记录页面证据，生成待审草稿'],
      expected: '探索不产生业务通过结论',
      assertionIds: [],
      browser: {
        title: b.title,
        startPath: b.startPath,
        sessionId: b.sessionId,
        sessionRevision: profile?.revision ?? null,
        verifySessionOnly: false,
        preconditions: '',
        steps: [],
        assertions: ['探索不执行正式断言'],
        cleanup: [],
        enabled: true,
        revision: 1,
        featureId: id,
        featureRevision: 1,
      },
    };
    const plan: Plan = {
      summary: '按需求探索网站，输出人工审核草稿',
      cases: [{ ...spec, reason: '用户发起的网站探索' }],
      missingRequirements: [],
      mode: 'deepagents',
      vision: true,
      environmentRevision: env.revision,
    };
    const discovery: DiscoverySnapshot = {
      id,
      requirements: b.requirements,
      maxPages: b.maxPages,
      phase: b.phase,
      baseline,
      domainRules,
    };
    const content = {
      rules: domainRules,
      pages: requirementLines(b.requirements).map((r) => ({
        id: `R${r.id}`,
        title: `需求 ${r.id}`,
        body: r.text,
        source: `discovery:${id}`,
      })),
    };
    return db.$transaction(async (tx) => {
      const knowledge = await tx.knowledgeRelease.create({
        data: {
          id: `discovery-${id}`,
          projectId: env.projectId,
          name: '探索需求快照',
          version: '1',
          hash: hash(content),
          content: json(content),
        },
      });
      await tx.task.create({
        data: {
          id: taskId,
          projectId: env.projectId,
          environmentId: env.id,
          creatorId: u.id,
          title: `探索 · ${b.title}`,
          goal: b.title,
          knowledgeReleaseId: knowledge.id,
          mode: 'deepagents',
          status: 'AWAITING_APPROVAL',
          revision: 1,
          budget: json(
            budgetSchema.parse({
              timeoutMs: 600000,
              maxActions: 150,
              maxModelCalls: 60,
              maxTokens: 150000,
              maxCostUsd: 1,
            }),
          ),
          browserSnapshot: json({
            cases: [spec],
            environmentRevision: env.revision,
            discovery,
            browserName: configuredBrowser(env.config),
          }),
        },
      });
      await tx.planRevision.create({
        data: { taskId, revision: 1, content: json(plan), hash: hash(plan), usage: json(emptyUsage()) },
      });
      const row = await tx.discovery.create({
        data: {
          id,
          taskId,
          environmentId: env.id,
          projectId: env.projectId,
          title: b.title,
          requirements: b.requirements,
          maxPages: b.maxPages,
          phase: b.phase,
          baselineDiscoveryId: b.baselineDiscoveryId,
          baselineRunId: b.baselineRunId,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: u.id,
          projectId: env.projectId,
          action: 'discovery.create',
          targetId: id,
          detail: { requirementsHash: hash(b.requirements), maxPages: b.maxPages },
        },
      });
      return row;
    });
  });
  app.get('/api/discoveries/:id', async (q) => {
    const row = await access(await identity(q), idOf(q));
    const [task, drafts] = await Promise.all([
      db.task.findUniqueOrThrow({
        where: { id: row.taskId },
        include: {
          runs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { evidence: { select: { id: true, kind: true, fileName: true } } },
          },
        },
      }),
      db.discoveryDraft.findMany({
        where: { discoveryId: row.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const run = task.runs[0];
    return {
      ...row,
      status: task.status,
      run: run
        ? { id: run.id, status: run.status, error: run.error, usage: run.usage, evidence: run.evidence }
        : null,
      drafts,
      domainRules: (task.browserSnapshot as any)?.discovery?.domainRules || [],
    };
  });
  app.get('/api/discoveries/:id/baselines', async (q) => {
    const row = await access(await identity(q), idOf(q));
    const published = (
      await db.discoveryDraft.findMany({ where: { discoveryId: row.id, status: 'PUBLISHED' } })
    ).flatMap((d) => (d.publishedCaseId ? [d.publishedCaseId] : []));
    const runs = await db.run.findMany({
      where: { projectId: row.projectId, task: { environmentId: row.environmentId }, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return runs.flatMap((run) => {
      try {
        validateBaseline(
          row.phase === 'MAIN' ? 'BOUNDARY' : 'DIVERGENT',
          row,
          row.environmentId,
          published,
          run,
        );
        return [
          {
            id: run.id,
            createdAt: run.createdAt,
            cases: (run.summary as any[]).map((c) => ({ title: c.title, result: c.result })),
          },
        ];
      } catch {
        return [];
      }
    });
  });
  app.post('/api/discoveries/:id/start', async (q) => {
    const u = await identity(q),
      row = await access(u, idOf(q));
    const b = z.object({ idempotencyKey: z.string().min(8).max(100) }).parse(q.body);
    return submitRun(u, row.taskId, 1, b.idempotencyKey);
  });
  async function draftAccess(user: Identity, id: string) {
    const draft = await db.discoveryDraft.findUnique({ where: { id }, include: { discovery: true } });
    if (!draft) throw new AppError('NOT_FOUND', '用例草稿不存在', 404);
    await projectAccess(user, draft.discovery.projectId);
    return draft;
  }
  app.patch('/api/discovery-drafts/:id', async (q) => {
    const u = await identity(q),
      draft = await draftAccess(u, idOf(q));
    const b = z.object({ revision: z.number().int(), content: candidateSchema }).parse(q.body);
    const env = await websiteAccess(u, draft.discovery.environmentId);
    assertAllowedUrl(b.content.test.startPath, env.baseUrl, originsOf(env));
    // Provenance is generated from the frozen exploration, never rewritten by an editor.
    const old = candidateSchema.parse(draft.content);
    const content = {
      ...b.content,
      basis: old.basis,
      requirementRefs: old.requirementRefs,
      observationIds: old.observationIds,
      knowledgeRuleRefs: old.knowledgeRuleRefs,
    };
    const updated = await db.discoveryDraft.updateMany({
      where: { id: draft.id, revision: b.revision, status: 'DRAFT' },
      data: { content: json(content), revision: { increment: 1 } },
    });
    if (!updated.count) throw new AppError('REVISION_CONFLICT', '草稿已改变或已处理，请刷新', 409);
    return db.discoveryDraft.findUniqueOrThrow({ where: { id: draft.id } });
  });
  app.post('/api/discovery-drafts/:id/review', async (q) => {
    const u = await identity(q),
      draft = await draftAccess(u, idOf(q));
    const b = z
      .object({
        revision: z.number().int(),
        decision: z.enum(['publish', 'reject']),
        confirmed: z.boolean(),
        note: z.string().trim().min(2).max(2000),
      })
      .parse(q.body);
    if (!b.confirmed) throw new AppError('REVIEW_REQUIRED', '请确认已核对需求、预期、数据和清理方式');
    return db.$transaction(async (tx) => {
      const claimed = await tx.discoveryDraft.updateMany({
        where: { id: draft.id, revision: b.revision, status: 'DRAFT' },
        data: {
          status: b.decision === 'publish' ? 'PUBLISHED' : 'REJECTED',
          reviewerId: u.id,
          reviewNote: b.note,
          reviewedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (!claimed.count) throw new AppError('REVISION_CONFLICT', '草稿已改变或已处理，请刷新', 409);
      const current = await tx.discoveryDraft.findUniqueOrThrow({ where: { id: draft.id } });
      const candidate = candidateSchema.parse(current.content);
      let caseId: string | null = null;
      if (b.decision === 'publish') {
        const env = await tx.environment.findUniqueOrThrow({ where: { id: draft.discovery.environmentId } });
        if (!env.enabled) throw new AppError('ENVIRONMENT', '网站已停用');
        assertAllowedUrl(candidate.test.startPath, env.baseUrl, originsOf(env));
        if (candidate.test.sessionId) {
          const p = await tx.loginProfile.findUnique({ where: { id: candidate.test.sessionId } });
          if (
            !p?.enabled ||
            p.environmentId !== env.id ||
            (p.expiresAt && p.expiresAt.getTime() <= Date.now())
          )
            throw new AppError('SESSION', '请选择本网站的有效登录会话');
        }
        let feature = await tx.webFeature.findFirst({
          where: { environmentId: env.id, name: candidate.featureName, enabled: true },
        });
        feature ??= await tx.webFeature.create({
          data: { environmentId: env.id, name: candidate.featureName, description: candidate.description },
        });
        const c = await tx.webCase.create({
          data: {
            featureId: feature.id,
            title: candidate.test.title,
            content: json({ ...candidate.test, enabled: true }),
            enabled: true,
          },
        });
        caseId = c.id;
        await tx.discoveryDraft.update({ where: { id: draft.id }, data: { publishedCaseId: caseId } });
      }
      await tx.auditEvent.create({
        data: {
          actorId: u.id,
          projectId: draft.discovery.projectId,
          action: `discovery.${b.decision}`,
          targetId: draft.id,
          detail: json({ revision: b.revision, note: b.note, caseId, contentHash: hash(candidate) }),
        },
      });
      return { caseId, status: b.decision === 'publish' ? 'PUBLISHED' : 'REJECTED' };
    });
  });
}
