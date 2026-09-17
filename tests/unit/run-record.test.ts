import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordExecution,
  recordDuration,
  recordDurationLabel,
} from '../../packages/contracts/src/run-record.ts';
import type { ExecutionStats } from '../../packages/contracts/src/execution-cache.ts';

const execution = (l2Hits: number, l1Hits: number, aiOperations: number): ExecutionStats => ({
  l2Hits,
  l1Hits,
  aiOperations,
  fallbacks: 0,
  published: false,
  key: 'test',
  mode: 'l2',
});

test('测试方式按实际路径汇总，不将所选策略当作命中结果', () => {
  assert.equal(recordExecution('l2', [], 'COMPLETED').label, '方式未记录');
  assert.equal(recordExecution('l2', [], 'QUEUED').label, '尚未执行');
  assert.equal(
    recordExecution('l2', [{ execution: execution(6, 0, 0) }], 'COMPLETED', 0).label,
    '二级静态执行',
  );
  assert.equal(
    recordExecution('l2', [{ execution: execution(0, 2, 0) }], 'COMPLETED', 0).label,
    '一级缓存执行',
  );
  const mixed = recordExecution(
    'l2',
    [{ execution: execution(3, 0, 0) }, { execution: execution(0, 1, 2) }],
    'COMPLETED',
    4,
  );
  assert.equal(mixed.label, '二级 + 一级 + AI');
  assert.equal(mixed.ai, 2);
  assert.equal(mixed.mode, 'l2');
  assert.equal(recordExecution('l2', [{ execution: execution(3, 0, 0) }], 'ERROR', 1).label, '二级 + AI');
  assert.equal(recordExecution(undefined, [], 'COMPLETED').mode, null);
});

test('运行耗时排除排队时间，区分运行中与历史缺失记录', () => {
  const start = '2026-09-16T08:00:00Z';
  assert.deepEqual(recordDuration(start, '2026-09-16T08:00:14.384Z', 'COMPLETED'), {
    durationMs: 14384,
    durationState: 'finished',
  });
  assert.deepEqual(recordDuration(start, null, 'RUNNING', Date.parse(start) + 1234), {
    durationMs: 1234,
    durationState: 'running',
  });
  assert.deepEqual(recordDuration(null, null, 'QUEUED'), { durationMs: null, durationState: 'queued' });
  assert.deepEqual(recordDuration(start, null, 'ERROR'), { durationMs: null, durationState: 'unavailable' });
  assert.equal(recordDuration(start, '2026-09-16T07:00:00Z', 'ERROR').durationMs, null);
  assert.equal(recordDurationLabel(14384), '14.38 秒');
  assert.equal(recordDurationLabel(65000), '1 分 5 秒');
  assert.equal(recordDurationLabel(3660000), '1 小时 1 分');
  assert.equal(recordDurationLabel(null), '—');
});
