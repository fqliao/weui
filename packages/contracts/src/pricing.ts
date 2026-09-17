export type TokenRate = { input: number; cacheRead: number; output: number };
export type ModelTarget = { model: string; baseUrl: string };
export type ModelPrice = ModelTarget & {
  /** Missing on older records means USD. */
  currency?: 'CNY' | 'USD';
  peak: TokenRate;
  offPeak?: TokenRate;
  sourceUrl: string;
  verifiedAt: string;
  source: 'official' | 'manual' | 'environment';
};
export type PriceBook = { version: 1; updatedAt: string; models: ModelPrice[] };
export type ModelCharge = ModelTarget & {
  currency?: 'CNY' | 'USD';
  role: 'planner' | 'vision';
  at: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  rate: TokenRate | null;
  period: 'peak' | 'offPeak' | 'flat' | 'unknown';
  costUsd: number | null;
  costCny?: number | null;
  sourceUrl: string;
  verifiedAt: string;
};
