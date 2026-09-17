import { db } from '../packages/db/src/index.ts';
import { config } from '../packages/config/src/index.ts';
const id = process.argv[2];
if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Usage: pnpm exec tsx scripts/reconcile.ts <run-id>');
const run = await db.run.findUniqueOrThrow({ where: { id } });
if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status))
  throw new Error('Only terminal runs can be reconciled');
const manifest = run.manifest as any;
if (!manifest.sample || manifest.environment.adapter !== 'sample-approval-v1')
  throw new Error('This command only supports the isolated sample adapter');
for (const c of manifest.plan.cases) {
  const namespace = `${id}-${c.id}`;
  // Explicit operator reconciliation of our sample fault fixture; results stay immutable.
  const setting = await db.setting.findUnique({ where: { key: `fixture:${namespace}` } });
  if (setting && (setting.value as any).fault === 'cleanup-failure')
    await db.setting.update({
      where: { key: setting.key },
      data: { value: { ...(setting.value as object), fault: 'none' } },
    });
  const response = await fetch(new URL(`/internal/fixtures/${namespace}`, config.SAMPLE_ORIGIN), {
    method: 'DELETE',
    headers: { 'x-service-key': config.SAMPLE_SERVICE_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Cleanup failed: ${response.status}`);
}
if (await db.sampleRecord.count({ where: { namespace: { startsWith: id + '-' } } }))
  throw new Error('Residual records found');
await db.auditEvent.create({
  data: {
    actorId: 'local-operator',
    projectId: run.projectId,
    action: 'sample.reconcile',
    targetId: id,
    detail: { originalCleanupStatus: run.cleanupStatus },
  },
});
console.log(`Reconciled ${id}; original run results and cleanup status retained for audit.`);
await db.$disconnect();
