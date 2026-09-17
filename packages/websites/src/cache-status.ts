import { db } from '../../db/src/index.ts';
import { hash } from '../../config/src/index.ts';
import { modelTargets } from '../../pricing/src/index.ts';
import { decryptSecret } from './vault.ts';
import { artifactSchema, CACHE_VERSION } from '../../executor/src/execution-cache.ts';
import { snapshotCases } from './index.ts';
import type { BrowserName } from '../../contracts/src/browser-choice.ts';
import type { RunManifest } from '../../contracts/src/index.ts';
import type { CacheStatus } from '../../contracts/src/execution-cache.ts';
export async function caseCacheStatuses(environmentId: string, browserName: BrowserName) {
  const env = await db.environment.findUniqueOrThrow({ where: { id: environmentId } });
  const cases = await db.webCase.findMany({
    where: { deletedAt: null, feature: { environmentId } },
    include: { feature: true },
  });
  const rows = await db.executionCache.findMany({
    where: { projectId: env.projectId, environmentId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: 'desc' },
  });
  const runs = await db.run.findMany({
    where: { id: { in: rows.map((r) => r.sourceRunId) } },
    select: { id: true, manifest: true },
  });
  const statuses: Record<string, CacheStatus> = {};
  const updates = await db.auditEvent.findMany({
    where: {
      projectId: env.projectId,
      targetId: { in: rows.map((r) => r.id) },
      action: { in: ['execution-cache.publish', 'execution-cache.edit'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const c of cases) {
    const none: CacheStatus = { l1: false, l2: false, partial: false };
    statuses[c.id] = none;
    if ((c.content as any).cachePolicy === 'realtime') {
      none.reason = '始终实时推理';
      continue;
    }
    if (!c.enabled || !c.feature.enabled) {
      none.reason = '用例已停用';
      continue;
    }
    try {
      const [current] = await snapshotCases(env.id, [c.id]);
      for (const row of rows.filter((r) => r.caseId === c.id && r.caseRevision === c.revision)) {
        const m = runs.find((r) => r.id === row.sourceRunId)?.manifest as unknown as RunManifest | undefined;
        const prior = m?.plan.cases.find((s) => s.id === c.id);
        if (
          !m ||
          !prior ||
          m.browser?.name !== browserName ||
          m.plan.environmentRevision !== env.revision ||
          hash(current.browser) !== hash(prior.browser) ||
          hash(m.models?.vision) !== hash(modelTargets().vision)
        )
          continue;
        const artifact = artifactSchema.parse(
          decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`),
        );
        if (artifact.version !== CACHE_VERSION) {
          none.reason = '校验机制已升级，运行通过后生成新版缓存';
          continue;
        }
        const channels = Object.values(artifact.channels),
          ops = channels.flatMap((ch) => ch.operations);
        const l1 = channels.some((ch) =>
            Object.values(ch.nativeByOperation).some((native) => native.caches.length > 0),
          ),
          l2 = ops.some((op) => op.complete);
        statuses[c.id] = {
          id: row.id,
          generation: row.generation,
          edited: artifact.edited ?? false,
          l2Ready: ops.filter((op) => op.complete).length,
          operations: Object.entries(artifact.channels).flatMap(([phase, ch]) =>
            ch.operations.map((op, index) => ({
              phase,
              index,
              kind: op.kind,
              complete: op.complete,
              label: op.label,
              reason: op.learning?.reason,
              learned: op.check?.kind === 'learned-ui',
            })),
          ),
          operationCount: ops.length,
          changedAt: updates.find((a) => a.targetId === row.id)?.createdAt.toISOString(),
          changeCount: (updates.find((a) => a.targetId === row.id)?.detail as any)?.changes?.length ?? 0,
          l1,
          l2,
          partial: l2 && ops.some((op) => !op.complete),
          sourceRunId: row.sourceRunId,
          updatedAt: row.updatedAt.toISOString(),
        };
        break;
      }
    } catch {
      none.reason = '配置已变化或缓存不可读取';
    }
  }
  return statuses;
}
