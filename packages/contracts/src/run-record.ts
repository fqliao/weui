import { executionModeSchema, type ExecutionMode, type ExecutionStats } from './execution-cache.ts';

export type RunRecordExecution = {
  mode: ExecutionMode | null;
  label: string;
  detail: string;
  l2: number;
  l1: number;
  ai: number;
};
export type RunRecordPerformance = {
  durationMs: number | null;
  durationState: 'finished' | 'running' | 'queued' | 'unavailable';
  costCny: number | null;
  costStatus: string;
  costNote: string;
};

export function recordExecution(
  mode: unknown,
  summary: { execution?: ExecutionStats }[],
  status: string,
  visionCalls?: number,
): RunRecordExecution {
  const parsed = executionModeSchema.safeParse(mode);
  const stats = summary.flatMap((r) => (r.execution ? [r.execution] : []));
  const count = (key: 'l2Hits' | 'l1Hits' | 'aiOperations') => stats.reduce((n, s) => n + (s[key] || 0), 0);
  const l2 = count('l2Hits'),
    l1 = count('l1Hits'),
    ai = count('aiOperations');
  const tiers = [l2 > 0 && '二级', l1 > 0 && '一级', (ai > 0 || (visionCalls ?? 0) > 0) && 'AI'].filter(
    Boolean,
  );
  const label =
    tiers.length > 1
      ? tiers.join(' + ')
      : tiers[0] === '二级'
        ? '二级静态执行'
        : tiers[0] === '一级'
          ? '一级缓存执行'
          : tiers[0] === 'AI'
            ? 'AI 实时推理'
            : status === 'QUEUED'
              ? '尚未执行'
              : ['RUNNING', 'CANCEL_REQUESTED'].includes(status)
                ? '执行中'
                : '方式未记录';
  return {
    mode: parsed.success ? parsed.data : null,
    label,
    l2,
    l1,
    ai,
    detail: stats.length
      ? `二级静态 ${l2} 项 · 一级命中 ${l1} 项 · AI 环节 ${ai} 项${stats.length < summary.length ? ' · 部分用例未记录方式' : ''}${(visionCalls ?? 0) > 0 ? ` · 视觉模型调用 ${visionCalls} 次` : ''}`
      : '暂无完整的缓存执行明细',
  };
}

export function recordDuration(
  start: string | Date | null,
  end: string | Date | null,
  status: string,
  now = Date.now(),
) {
  if (!start)
    return {
      durationMs: null,
      durationState: status === 'QUEUED' ? ('queued' as const) : ('unavailable' as const),
    };
  const running = ['RUNNING', 'CANCEL_REQUESTED'].includes(status);
  const elapsed = (end ? new Date(end).getTime() : running ? now : NaN) - new Date(start).getTime();
  return {
    durationMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    durationState:
      Number.isFinite(elapsed) && elapsed >= 0
        ? running
          ? ('running' as const)
          : ('finished' as const)
        : ('unavailable' as const),
  };
}

export function recordDurationLabel(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} 秒`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 3600
    ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
