import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charge,
  officialFlash,
  peakTime,
  recordUsage,
  findPrice,
} from '../../packages/pricing/src/calculate.ts';
import { emptyUsage } from '../../packages/contracts/src/index.ts';
import type { PriceBook } from '../../packages/contracts/src/pricing.ts';
import { estimateCny } from '../../packages/pricing/src/report.ts';
import { migrateOfficialCny } from '../../packages/pricing/src/index.ts';
const book: PriceBook = { version: 1, updatedAt: '2026-09-15', models: [officialFlash] };
test('官方 Flash 时段按北京时间工作日边界计算，周末空闲', () => {
  for (const [at, peak] of [
    ['2026-09-15T00:59:59Z', false],
    ['2026-09-15T01:00:00Z', true],
    ['2026-09-15T03:59:59Z', true],
    ['2026-09-15T04:00:00Z', false],
    ['2026-09-15T06:00:00Z', true],
    ['2026-09-15T10:00:00Z', false],
    ['2026-09-19T02:00:00Z', false],
    ['2026-09-20T17:00:00Z', false],
  ] as const)
    assert.equal(peakTime(at), peak, at);
});
test('分开计算缓存命中与输出；缓存未知按未命中估算', () => {
  assert.equal(charge(book, officialFlash, 'vision', 1e6, 1e6, '2026-09-15T02:00:00Z').costCny, 10);
  assert.equal(charge(book, officialFlash, 'vision', 1e6, 1e6, '2026-09-15T12:00:00Z').costCny, 5);
  assert.equal(charge(book, officialFlash, 'planner', 1e6, 0, '2026-09-15T02:00:00Z', 1e6).costCny, 0.04);
  assert.equal(charge(book, officialFlash, 'planner', 1e6, 0, '2026-09-15T02:00:00Z', 500000).costCny, 1.02);
});
test('未知模型与代理地址不能冒用官方单价，兼容官方 /v1', () => {
  assert.ok(findPrice(book, { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1/' }));
  assert.equal(
    charge(book, { ...officialFlash, baseUrl: 'https://proxy.example.test' }, 'vision', 100, 20).costCny,
    null,
  );
  assert.equal(charge(book, { ...officialFlash, model: 'unknown' }, 'vision', 100, 20).costCny, null);
});
test('模型用量只累计增量，未知价格或历史未分摊用量标为部分计价', () => {
  const u = emptyUsage();
  recordUsage(u, book, officialFlash, 'planner', 1000, 100, 500);
  recordUsage(u, book, officialFlash, 'vision', 2000, 200);
  recordUsage(u, book, officialFlash, 'vision', 0, 0);
  assert.equal(u.inputTokens, 3000);
  assert.equal(u.outputTokens, 300);
  assert.equal(u.charges?.length, 2);
  assert.equal(u.priced, true);
  assert.equal(u.costUsd, 0, '人民币费用不得写入美元字段');
  const cost = u.costCny;
  recordUsage(u, book, { ...officialFlash, model: 'unknown' }, 'vision', 100, 10);
  assert.equal(u.priced, false);
  assert.equal(u.costCny, cost);
  const legacy = { ...emptyUsage(), inputTokens: 50 };
  recordUsage(legacy, book, officialFlash, 'vision', 100, 10);
  assert.equal(legacy.priced, false);
});
test('历史美元费用按 Token 重算人民币，保留原币种快照', () => {
  const usdPrice = {
    ...officialFlash,
    currency: undefined,
    peak: { input: 0.3, cacheRead: 0.006, output: 1.2 },
    offPeak: { input: 0.15, cacheRead: 0.003, output: 0.6 },
  };
  const old = charge({ ...book, models: [usdPrice] }, usdPrice, 'vision', 1e6, 1e6, '2026-09-15T02:00:00Z');
  assert.equal(old.costUsd, 1.5);
  assert.equal(old.costCny, null);
  const usage = {
    ...emptyUsage(),
    visionCalls: 1,
    inputTokens: 1e6,
    outputTokens: 1e6,
    costUsd: 1.5,
    charges: [old],
  };
  const copy = structuredClone(usage);
  const result = estimateCny(usage, book, officialFlash, old.at, 'catalog');
  assert.equal(result.status, 'reference');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.costCny, 10);
  assert.deepEqual(usage, copy);
  const unpriced = estimateCny(usage, { ...book, models: [] }, officialFlash, old.at, 'catalog');
  assert.equal(unpriced.status, 'unknown');
  assert.equal(unpriced.costCny, null);
});
test('人民币运行保持原价；官方美元配置迁移不会改写自定义美元报价', () => {
  const c = charge(book, officialFlash, 'vision', 1e6, 0, '2026-09-15T02:00:00Z');
  const usage = { ...emptyUsage(), visionCalls: 1, inputTokens: 1e6, charges: [c] };
  const next = structuredClone(book);
  next.models[0].peak.input = 99;
  assert.equal(estimateCny(usage, next, officialFlash, c.at, 'catalog').costCny, 2);
  const legacy = {
    ...officialFlash,
    currency: undefined,
    peak: { input: 0.3, cacheRead: 0.006, output: 1.2 },
  };
  const manual = { ...legacy, model: 'my-model', source: 'manual' as const };
  const source = { ...book, models: [legacy, manual] },
    copy = structuredClone(source);
  const migrated = migrateOfficialCny(source);
  assert.equal(migrated.models[0].currency, 'CNY');
  assert.equal(migrated.models[0].peak.input, 2);
  assert.deepEqual(migrated.models[1], manual);
  assert.deepEqual(source, copy);
  assert.equal(migrateOfficialCny(migrated), migrated, '重复启动不能覆盖人民币自定义价格');
});
test('更改价格不改变已保存的调用价格和费用', () => {
  const snapshot = structuredClone(book),
    usage = emptyUsage();
  recordUsage(usage, snapshot, officialFlash, 'vision', 1e6, 1e6);
  const prior = structuredClone(usage);
  const changed = structuredClone(book);
  changed.models[0].peak.input = 99;
  assert.deepEqual(usage, prior);
  assert.equal(usage.charges?.[0].rate?.input, peakTime(usage.charges![0].at) ? 2 : 1);
});
