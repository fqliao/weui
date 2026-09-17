import type { Usage, CaseResult } from './index.ts';
export type CaseMetrics = {
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number | null;
  costCny: number | null;
  source: 'measured' | 'single-run' | 'unavailable';
};
export type CaseHistoryPoint = CaseMetrics & {
  runId: string;
  finishedAt: string;
  result: string;
  revision: number;
  browser: string;
  mode: string;
  l2Hits: number;
  l1Hits: number;
};
export function usageMetrics(
  usage: Usage,
  durationMs: number,
  source: CaseMetrics['source'] = 'measured',
): CaseMetrics {
  const tokens = usage.inputTokens + usage.outputTokens;
  const charges = usage.charges ?? [];
  const allCny =
    charges.length > 0 &&
    charges.every((c) => c.currency === 'CNY' && c.costCny != null) &&
    charges.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0) === tokens;
  return {
    durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    modelCalls: usage.modelCalls + usage.visionCalls,
    costCny: tokens === 0 ? 0 : allCny ? charges.reduce((n, c) => n + c.costCny!, 0) : null,
    source,
  };
}
export function caseUsageDelta(before: Usage, after: Usage, durationMs: number): CaseMetrics {
  return usageMetrics(
    {
      ...after,
      inputTokens: after.inputTokens - before.inputTokens,
      outputTokens: after.outputTokens - before.outputTokens,
      modelCalls: after.modelCalls - before.modelCalls,
      visionCalls: after.visionCalls - before.visionCalls,
      charges: (after.charges ?? []).slice(before.charges?.length ?? 0),
    },
    durationMs,
  );
}
export function resultMetrics(
  result: Pick<CaseResult, 'startedAt' | 'finishedAt' | 'metrics'>,
  usage: Usage,
  caseCount: number,
): CaseMetrics {
  const durationMs = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt));
  return (
    result.metrics ??
    (caseCount === 1
      ? usageMetrics(usage, durationMs, 'single-run')
      : {
          durationMs,
          inputTokens: null,
          outputTokens: null,
          modelCalls: null,
          costCny: null,
          source: 'unavailable',
        })
  );
}
