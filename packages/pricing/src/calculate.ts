import type { ModelCharge, ModelPrice, ModelTarget, PriceBook } from '../../contracts/src/pricing.ts';
import type { Usage } from '../../contracts/src/index.ts';

export const officialFlash: ModelPrice = {
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  currency: 'CNY',
  peak: { input: 2, cacheRead: 0.04, output: 8 },
  offPeak: { input: 1, cacheRead: 0.02, output: 4 },
  sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  verifiedAt: '2026-09-15',
  source: 'official',
};
export function endpoint(value: string) {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}
export function findPrice(book: PriceBook, target: ModelTarget) {
  return book.models.find(
    (p) => p.model === target.model && endpoint(p.baseUrl) === endpoint(target.baseUrl),
  );
}
export function peakTime(at: string) {
  const beijing = new Date(Date.parse(at) + 8 * 3600000);
  const day = beijing.getUTCDay(),
    hour = beijing.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}
export function charge(
  book: PriceBook,
  target: ModelTarget,
  role: ModelCharge['role'],
  inputTokens: number,
  outputTokens: number,
  at = new Date().toISOString(),
  cachedInputTokens?: number,
): ModelCharge {
  const price = findPrice(book, target);
  const period = !price ? 'unknown' : !price.offPeak ? 'flat' : peakTime(at) ? 'peak' : 'offPeak';
  const rate = price ? (period === 'offPeak' ? price.offPeak! : price.peak) : null;
  const cached =
    cachedInputTokens === undefined ? undefined : Math.min(inputTokens, Math.max(0, cachedInputTokens));
  const currency = price?.currency ?? 'USD';
  const amount = rate
    ? ((inputTokens - (cached ?? 0)) * rate.input +
        (cached ?? 0) * rate.cacheRead +
        outputTokens * rate.output) /
      1e6
    : null;
  return {
    ...target,
    role,
    at,
    inputTokens,
    outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    rate,
    period,
    currency,
    costUsd: currency === 'USD' ? amount : null,
    costCny: currency === 'CNY' ? amount : null,
    sourceUrl: price?.sourceUrl ?? '',
    verifiedAt: price?.verifiedAt ?? '',
  };
}
// One charge per collected metrics delta. Missing cache details use cache-miss
// rates, so this is an estimate, never a provider invoice.
export function recordUsage(
  usage: Usage,
  book: PriceBook,
  target: ModelTarget,
  role: ModelCharge['role'],
  input: number,
  output: number,
  cached?: number,
) {
  input = Math.max(0, input);
  output = Math.max(0, output);
  if (!input && !output) return;
  usage.inputTokens += input;
  usage.outputTokens += output;
  (usage.charges ??= []).push(charge(book, target, role, input, output, undefined, cached));
  usage.costUsd = usage.charges.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
  usage.costCny = usage.charges.reduce((sum, c) => sum + (c.costCny ?? 0), 0);
  usage.priced =
    usage.charges.every((c) => (c.currency === 'CNY' ? c.costCny != null : c.costUsd !== null)) &&
    usage.charges.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0) ===
      usage.inputTokens + usage.outputTokens;
}
