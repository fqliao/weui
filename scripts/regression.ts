import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Client, budget } from '../tests/helpers.ts';
const client = new Client();
await client.login();
let results: any[] = [];
await fs.mkdir('.runtime/verification', { recursive: true });
if (process.argv.includes('--resume'))
  try {
    results = JSON.parse(
      await fs.readFile('.runtime/verification/business-regression-midscene.json', 'utf8'),
    ).rounds.filter(
      (r: any) =>
        r.status === 'COMPLETED' &&
        r.cleanup === 'CLEAN' &&
        r.results.length === 12 &&
        r.results.every((c: any) => c.result === 'PASS'),
    );
  } catch {}
for (let round = 1; round <= 3; round++) {
  if (results.some((r) => r.round === round)) continue;
  const started = Date.now(),
    run = await client.run('完整验证全部 12 个注册场景', {
      title: `回归基线 · 第 ${round} 轮 · 全部 12 场景`,
      budget: { ...budget, maxActions: 500, maxModelCalls: 150, maxTokens: 500000 },
    });
  results.push({
    round,
    runId: run.id,
    status: run.status,
    cleanup: run.cleanupStatus,
    durationMs: Date.now() - started,
    usage: run.usage,
    results: run.summary,
  });
  await fs.writeFile(
    '.runtime/verification/business-regression-midscene.json',
    JSON.stringify(
      {
        environment: '独立审批样例',
        rounds: results,
        total: results.flatMap((r) => r.results).length,
        passed: results.flatMap((r) => r.results).filter((r) => r.result === 'PASS').length,
      },
      null,
      2,
    ),
  );
  console.log(
    `Round ${round}: ${run.summary.filter((c: any) => c.result === 'PASS').length}/12 PASS, actions=${run.usage.actions}, status=${run.status}, cleanup=${run.cleanupStatus}`,
  );
  assert.equal(run.status, 'COMPLETED', run.error);
  assert.equal(run.cleanupStatus, 'CLEAN');
  assert.equal(run.summary.length, 12);
  assert.ok(
    run.summary.every((c: any) => c.result === 'PASS'),
    JSON.stringify(run.summary.filter((c: any) => c.result !== 'PASS')),
  );
}
