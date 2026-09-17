import type { ModelCharge, ModelTarget, PriceBook } from '../../contracts/src/pricing.ts';
import type { Usage } from '../../contracts/src/index.ts';
import { charge } from './calculate.ts';

export function estimateCny(
  usage: Usage,
  book: PriceBook,
  vision: ModelTarget,
  createdAt: string,
  plannerModel: string,
) {
  const tokens = usage.inputTokens + usage.outputTokens;
  const base = { currency: 'CNY' as const };
  const notes = [
    '金额以人民币（元）计；缓存明细缺失时按未命中计价，按用量收集时段估算，实际扣费以模型服务账单为准。',
  ];
  if (usage.charges?.length) {
    let reference = false;
    const rows = usage.charges.map((row) => {
      if (row.currency === 'CNY') return row;
      reference = true;
      // Re-price recorded tokens, not USD amounts. Preserve original snapshots.
      return charge(book, row, row.role, row.inputTokens, row.outputTokens, row.at, row.cachedInputTokens);
    });
    const covered = rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    const known = rows.filter((r) => r.costCny != null);
    const complete = covered === tokens && known.length === rows.length;
    return {
      ...base,
      status: !known.length ? 'unknown' : !complete ? 'partial' : reference ? 'reference' : 'recorded',
      costCny: known.length ? known.reduce((n, r) => n + r.costCny!, 0) : null,
      models: [...new Set(rows.map((r) => r.model))],
      rows,
      notes: [
        reference
          ? '历史记录使用美元价格，现按已记录的模型、Token、时间及当前人民币单价重新估算；原始美元记录保留，未采用汇率换算。'
          : '按调用时保存的人民币单价估算；后续修改价格不会改变此记录。',
        ...(!complete ? ['部分用量缺少人民币单价或明细，仅显示已知部分。'] : []),
        ...notes,
      ],
      sources: [...new Set(rows.map((r) => r.sourceUrl).filter(Boolean))],
    };
  }
  if (!tokens && !usage.modelCalls && !usage.visionCalls)
    return {
      ...base,
      status: 'unused',
      costCny: 0,
      models: [],
      notes: ['本次运行未调用模型。'],
      sources: [],
    };
  if (!tokens)
    return {
      ...base,
      status: 'unknown',
      costCny: null,
      models: [],
      notes: ['模型调用未返回 Token 明细，无法估算费用。'],
      sources: [],
    };
  if (!usage.modelCalls && usage.visionCalls) {
    const row = charge(book, vision, 'vision', usage.inputTokens, usage.outputTokens, createdAt);
    return {
      ...base,
      status: row.costCny == null ? 'unknown' : 'reference',
      costCny: row.costCny ?? null,
      models: [vision.model],
      rows: [row],
      notes: [
        '历史运行未记录视觉模型和价格。假设使用当前视觉模型及当前人民币单价，按运行开始时段提供参考估算，未改写历史记录。',
        ...notes,
      ],
      sources: row.sourceUrl ? [row.sourceUrl] : [],
    };
  }
  return {
    ...base,
    status: 'unknown',
    costCny: null,
    models: plannerModel === 'catalog' ? [] : [plannerModel],
    notes: ['历史记录缺少模型用量拆分，无法可靠估算。新运行会保存模型和人民币单价明细。'],
    sources: [],
  };
}
