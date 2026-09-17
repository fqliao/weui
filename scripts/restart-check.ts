import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from '../tests/helpers.ts';
import { config, hash } from '../packages/config/src/index.ts';
const client = new Client();
await client.login();
const baseline = JSON.parse(await fs.readFile('.runtime/verification/business-regression.json', 'utf8'));
const id = baseline.rounds.at(-1).runId,
  run = await client.call('/runs/' + id);
const screenshot = run.evidence.find((e: any) => e.kind === 'screenshot');
const response = await fetch(config.API_ORIGIN + '/api/evidence/' + screenshot.id, {
  headers: { cookie: client.cookie },
});
assert.equal(response.status, 200);
const evidenceHash = createHash('sha256')
  .update(Buffer.from(await response.arrayBuffer()))
  .digest('hex');
const current = {
  id,
  summaryHash: hash(run.summary),
  manifestHash: hash(run.manifest),
  evidenceId: screenshot.id,
  evidenceHash,
  status: run.status,
};
if (process.argv.includes('--before')) {
  await fs.writeFile('.runtime/verification/restart-before.json', JSON.stringify(current, null, 2));
  console.log('Restart baseline captured');
} else {
  const before = JSON.parse(await fs.readFile('.runtime/verification/restart-before.json', 'utf8'));
  assert.deepEqual(current, before);
  await fs.writeFile(
    '.runtime/verification/restart.json',
    JSON.stringify(
      {
        ok: true,
        services: ['Web', 'API', 'Worker', 'sample', 'project PostgreSQL', 'project Redis'],
        ...current,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log('Restart verified: report, manifest and protected screenshot unchanged');
}
