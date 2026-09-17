import test from 'node:test';
import assert from 'node:assert/strict';
import { caseUsageDelta, resultMetrics } from '../../packages/contracts/src/case-metrics.ts';
import { emptyUsage } from '../../packages/contracts/src/index.ts';
import { recordUsage, officialFlash } from '../../packages/pricing/src/calculate.ts';
test('per-case metrics isolate charges including login and retain actual historical CNY rates', () => {
  const before = emptyUsage();
  before.visionCalls = 2;
  recordUsage(
    before,
    { version: 1, updatedAt: '', models: [officialFlash] },
    officialFlash,
    'vision',
    1000,
    10,
  );
  const after = structuredClone(before);
  after.visionCalls += 3;
  recordUsage(
    after,
    { version: 1, updatedAt: '', models: [officialFlash] },
    officialFlash,
    'vision',
    2000,
    20,
  );
  const m = caseUsageDelta(before, after, 2345);
  assert.equal(m.inputTokens, 2000);
  assert.equal(m.outputTokens, 20);
  assert.equal(m.modelCalls, 3);
  assert.equal(m.costCny, after.charges![1].costCny);
  assert.equal(m.durationMs, 2345);
  const zero = caseUsageDelta(after, after, 1);
  assert.equal(zero.costCny, 0);
  assert.equal(zero.modelCalls, 0);
});
test('old batch metrics remain missing and foreign/unknown prices do not appear as free CNY', () => {
  const r = { startedAt: '2026-09-15T00:00:00Z', finishedAt: '2026-09-15T00:00:10Z' };
  const u = { ...emptyUsage(), inputTokens: 10 };
  const m = resultMetrics(r, u, 4);
  assert.equal(m.source, 'unavailable');
  assert.equal(m.inputTokens, null);
  assert.equal(m.durationMs, 10000);
  assert.equal(resultMetrics(r, u, 1).costCny, null);
});
