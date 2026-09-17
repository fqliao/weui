import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '../tests/helpers.ts';
const rows = await Promise.all(
  Array.from({ length: 5 }, async (_, i) => {
    const client = new Client();
    await client.login();
    const start = Date.now();
    const task = await client.plan(`并发验证 ${i + 1} C01`, {
      budget: { timeoutMs: 600000, maxActions: 100, maxModelCalls: 60, maxTokens: 150000, maxCostUsd: 1 },
    });
    const run = await client.finished((await client.submit(task)).id);
    assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
    return {
      runId: run.id,
      durationMs: Date.now() - start,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }),
);
const edges = rows
  .flatMap((r) => [
    { time: Date.parse(r.startedAt), delta: 1 },
    { time: Date.parse(r.finishedAt), delta: -1 },
  ])
  .sort((a, b) => a.time - b.time || a.delta - b.delta);
let current = 0,
  maxActive = 0;
for (const e of edges) {
  current += e.delta;
  maxActive = Math.max(maxActive, current);
}
assert.ok(maxActive <= 2);
await fs.writeFile(
  '.runtime/verification/concurrency-midscene.json',
  JSON.stringify({ kind: '5 API sessions with real Midscene browser execution', maxActive, rows }, null, 2),
);
console.log(`5 sessions completed; max active runs: ${maxActive}`);
