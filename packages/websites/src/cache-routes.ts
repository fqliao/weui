import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, json } from '../../db/src/index.ts';
import { identity, type Identity } from '../../auth/src/index.ts';
import { AppError } from '../../config/src/index.ts';
import { websiteAccess } from './index.ts';
import { decryptSecret, encryptSecret } from './vault.ts';
import { artifactSchema } from '../../executor/src/cache-artifact.ts';
import { cacheViews, cacheChanges, editCache } from '../../executor/src/cache-review.ts';
import type { CacheDetail } from '../../contracts/src/execution-cache.ts';
import type { RunManifest, CaseResult, Usage } from '../../contracts/src/index.ts';
import { resultMetrics, type CaseHistoryPoint } from '../../contracts/src/case-metrics.ts';
import { browserNameSchema } from '../../contracts/src/browser-choice.ts';
import { assertionLabel } from '../../contracts/src/static-ui.ts';

async function accessibleCache(user: Identity, id: string) {
  const row = await db.executionCache.findUnique({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', '缓存不存在或已过期清除', 404);
  const env = await websiteAccess(user, row.environmentId);
  if (row.projectId !== env.projectId) throw new AppError('SCOPE', '缓存不属于此空间', 403);
  return row;
}
async function detail(row: Awaited<ReturnType<typeof accessibleCache>>): Promise<CacheDetail> {
  const artifact = artifactSchema.parse(decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`));
  const [c, run, audits] = await Promise.all([
    db.webCase.findUnique({ where: { id: row.caseId }, select: { title: true } }),
    db.run.findUnique({ where: { id: row.sourceRunId }, select: { manifest: true } }),
    db.auditEvent.findMany({
      where: {
        projectId: row.projectId,
        targetId: row.id,
        action: { in: ['execution-cache.edit', 'execution-cache.publish'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  const actorIds = audits.filter((a) => a.action === 'execution-cache.edit').map((a) => a.actorId);
  const users = await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
  const manifest = run?.manifest as unknown as RunManifest | undefined;
  const spec = manifest?.plan.cases.find((c) => c.id === row.caseId);
  const views = (tier: 'L1' | 'L2') =>
    cacheViews(artifact, tier).map((op) => ({
      ...op,
      label:
        op.phase === 'case'
          ? (spec?.browser?.steps[op.index]?.text ??
            (spec?.browser?.assertions[op.index - spec.browser.steps.length] !== undefined
              ? assertionLabel(spec.browser.assertions[op.index - spec.browser.steps.length])
              : undefined) ??
            op.label)
          : op.label,
    }));
  return {
    id: row.id,
    caseId: row.caseId,
    title: c?.title ?? '历史用例',
    browser: (run?.manifest as any)?.browser?.name ?? 'chrome',
    generation: row.generation,
    caseRevision: row.caseRevision,
    sourceRunId: row.sourceRunId,
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    edited: artifact.edited ?? false,
    l1: views('L1'),
    l2: views('L2'),
    revisions: audits.map((a) => {
      const d = a.detail as any;
      return {
        id: a.id,
        at: a.createdAt.toISOString(),
        generation: d.generation,
        source: d.source,
        runId: d.runId,
        actor:
          a.action === 'execution-cache.edit'
            ? (users.find((u) => u.id === a.actorId)?.name ?? '测试人员')
            : '执行引擎',
        changes: d.changes ?? [],
      };
    }),
  };
}
export function registerCacheRoutes(app: FastifyInstance) {
  const idOf = (q: { params: unknown }) => (q.params as { id: string }).id;
  app.get('/api/execution-caches/:id', async (q) =>
    detail(await accessibleCache(await identity(q), idOf(q))),
  );
  app.patch('/api/execution-caches/:id', async (q) => {
    const user = await identity(q),
      row = await accessibleCache(user, idOf(q));
    const b = z
      .object({
        generation: z.number().int().positive(),
        tier: z.enum(['L1', 'L2']),
        edits: z
          .array(z.object({ path: z.string().max(500), value: z.string().trim().min(1).max(4000) }))
          .min(1)
          .max(300),
      })
      .parse(q.body);
    if (row.generation !== b.generation)
      throw new AppError('REVISION_CONFLICT', '缓存已更新，请重新加载后修改', 409);
    if (row.expiresAt <= new Date())
      throw new AppError('CACHE_EXPIRED', '缓存已过期，请重新执行用例生成缓存', 409);
    const before = artifactSchema.parse(decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`));
    const after = editCache(before, b.tier, b.edits),
      changes = cacheChanges(before, after);
    if (!changes.length) return detail(row);
    await db.$transaction(async (tx) => {
      const n = await tx.executionCache.updateMany({
        where: { id: row.id, generation: b.generation },
        data: {
          generation: { increment: 1 },
          encryptedArtifact: encryptSecret(after, `execution-cache:${row.id}`),
        },
      });
      if (!n.count) throw new AppError('REVISION_CONFLICT', '缓存已更新，请重新加载后修改', 409);
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          projectId: row.projectId,
          action: 'execution-cache.edit',
          targetId: row.id,
          detail: json({
            generation: b.generation + 1,
            source: 'manual',
            caseId: row.caseId,
            tier: b.tier,
            changes,
          }),
        },
      });
    });
    return detail(await accessibleCache(user, row.id));
  });
  app.get('/api/web-cases/:id/history', async (q) => {
    const user = await identity(q),
      caseId = idOf(q);
    const c = await db.webCase.findUnique({ where: { id: caseId }, include: { feature: true } });
    if (!c) throw new AppError('NOT_FOUND', '用例不存在', 404);
    const env = await websiteAccess(user, c.feature.environmentId);
    const { browserName, cursor } = z
      .object({ browserName: browserNameSchema.optional(), cursor: z.string().uuid().optional() })
      .parse(q.query);
    const rows = await db.run.findMany({
      where: {
        projectId: env.projectId,
        finishedAt: { not: null },
        summary: { array_contains: [{ caseId }] },
        ...(browserName ? { manifest: { path: ['browser', 'name'], equals: browserName } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, manifest: true, summary: true, usage: true, finishedAt: true },
    });
    const items: CaseHistoryPoint[] = rows.slice(0, 30).flatMap((row) => {
      const m = row.manifest as unknown as RunManifest,
        r = (row.summary as unknown as CaseResult[]).find((r) => r.caseId === caseId);
      if (!r) return [];
      return [
        {
          ...resultMetrics(r, row.usage as unknown as Usage, m.plan.cases.length),
          runId: row.id,
          finishedAt: r.finishedAt,
          result: r.result,
          revision: m.plan.cases.find((c) => c.id === caseId)?.browser?.revision ?? 0,
          browser: m.browser?.name ?? 'chrome',
          mode: r.execution?.mode ?? m.executionMode ?? 'realtime',
          l2Hits: r.execution?.l2Hits ?? 0,
          l1Hits: r.execution?.l1Hits ?? 0,
        },
      ];
    });
    return { items, nextCursor: rows.length > 30 ? rows[29].id : null };
  });
}
