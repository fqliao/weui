import { z } from 'zod';
import { db, json } from '../../db/src/index.ts';
import { config } from '../../config/src/index.ts';
import type { PriceBook } from '../../contracts/src/pricing.ts';
import { endpoint, officialFlash } from './calculate.ts';
import { hash } from '../../config/src/index.ts';
export { recordUsage, findPrice } from './calculate.ts';
export const modelTargets = () => ({
  planner: { model: config.LLM_MODEL, baseUrl: endpoint(config.LLM_BASE_URL) },
  vision: {
    model: process.env.MIDSCENE_MODEL_NAME || '',
    baseUrl: endpoint(process.env.MIDSCENE_MODEL_BASE_URL || ''),
  },
});
const rate = z.object({
  input: z.number().min(0).max(10000),
  cacheRead: z.number().min(0).max(10000),
  output: z.number().min(0).max(10000),
});
export const priceModelsSchema = z
  .array(
    z.object({
      currency: z.enum(['CNY', 'USD']).optional(),
      model: z.string().trim().min(1).max(150),
      baseUrl: z
        .url()
        .refine(
          (v) =>
            /^https?:\/\//.test(v) &&
            !new URL(v).username &&
            !new URL(v).password &&
            !new URL(v).search &&
            !new URL(v).hash,
        )
        .transform(endpoint),
      peak: rate,
      offPeak: rate.optional(),
      sourceUrl: z.union([z.literal(''), z.url().refine((v) => /^https?:\/\//.test(v))]),
      verifiedAt: z.iso.date(),
      source: z.enum(['official', 'manual', 'environment']),
    }),
  )
  .max(30)
  .refine(
    (rows) => new Set(rows.map((r) => `${r.baseUrl}|${r.model}`)).size === rows.length,
    '同一服务地址和模型不能重复配置',
  );
export function defaultBook(): PriceBook {
  const models = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].map((model) => ({
    ...officialFlash,
    model,
  }));
  if (config.LLM_INPUT_USD_PER_MILLION || config.LLM_OUTPUT_USD_PER_MILLION) {
    const target = modelTargets().planner;
    const existing = models.findIndex((p) => p.model === target.model && p.baseUrl === target.baseUrl);
    if (existing >= 0) models.splice(existing, 1);
    models.push({
      ...target,
      currency: 'USD',
      peak: {
        input: config.LLM_INPUT_USD_PER_MILLION,
        cacheRead: config.LLM_INPUT_USD_PER_MILLION,
        output: config.LLM_OUTPUT_USD_PER_MILLION,
      },
      sourceUrl: '',
      verifiedAt: new Date().toISOString().slice(0, 10),
      source: 'environment',
    });
  }
  return { version: 1, updatedAt: new Date().toISOString(), models };
}
export async function ensurePriceBook() {
  await db.setting.createMany({
    data: [{ key: 'model_pricing', value: json(defaultBook()) }],
    skipDuplicates: true,
  });
  const old = await readPriceBook();
  const book = migrateOfficialCny(old);
  if (book === old) return;
  await db.$transaction(async (tx) => {
    const changed = await tx.setting.updateMany({
      where: { key: 'model_pricing', value: { equals: json(old) } },
      data: { value: json(book) },
    });
    if (!changed.count) return;
    await tx.setting.createMany({
      data: [{ key: `model_pricing_archive:${hash(old)}`, value: json(old) }],
      skipDuplicates: true,
    });
    await tx.auditEvent.create({
      data: {
        actorId: 'system',
        action: 'model-pricing.cny-migration',
        targetId: 'model_pricing',
        detail: json({ previous: old, current: book }),
      },
    });
  });
}
export function migrateOfficialCny(book: PriceBook): PriceBook {
  let changed = false;
  const models = book.models.map((row) => {
    if (
      row.currency === 'CNY' ||
      row.source !== 'official' ||
      row.baseUrl !== officialFlash.baseUrl ||
      !['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(row.model)
    )
      return row;
    changed = true;
    return { ...officialFlash, model: row.model };
  });
  return changed
    ? {
        ...book,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(book.updatedAt) + 1)).toISOString(),
        models,
      }
    : book;
}
export async function readPriceBook(): Promise<PriceBook> {
  return (
    ((await db.setting.findUnique({ where: { key: 'model_pricing' } }))?.value as unknown as PriceBook) ??
    defaultBook()
  );
}
