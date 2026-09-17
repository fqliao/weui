import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, json } from '../../../packages/db/src/index.ts';
import { identity, admin, projectAccess } from '../../../packages/auth/src/index.ts';
import { accessibleRun } from '../../../packages/service/src/index.ts';
import { AppError, hash } from '../../../packages/config/src/index.ts';
import { readPriceBook, modelTargets, priceModelsSchema } from '../../../packages/pricing/src/index.ts';
import { officialFlash, findPrice } from '../../../packages/pricing/src/calculate.ts';
import { estimateCny } from '../../../packages/pricing/src/report.ts';
import type { PriceBook } from '../../../packages/contracts/src/pricing.ts';
import type { RunManifest, Usage } from '../../../packages/contracts/src/index.ts';

export function registerPlatformRoutes(app: FastifyInstance) {
  app.get('/api/model-pricing', async (q) => {
    await identity(q);
    return { book: await readPriceBook(), targets: modelTargets(), official: officialFlash };
  });
  app.post('/api/admin/model-pricing', async (q) => {
    const user = await identity(q);
    admin(user);
    const body = z.object({ updatedAt: z.string(), models: priceModelsSchema }).parse(q.body);
    const old = await readPriceBook();
    if (body.updatedAt !== old.updatedAt)
      throw new AppError('CONFLICT', '价格已被其他管理员修改，请刷新后重试', 409);
    const models = body.models.map((row) => {
      const prev = findPrice(old, row);
      if (prev && hash(prev) === hash(row)) return row;
      if (row.currency !== 'CNY')
        throw new AppError('CURRENCY', '请按人民币单价保存；已有美元报价仅保留作历史参考');
      const official = { ...officialFlash, model: row.model };
      const isOfficial =
        ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(row.model) &&
        hash(row) === hash(official);
      return isOfficial
        ? official
        : { ...row, source: 'manual' as const, verifiedAt: new Date().toISOString().slice(0, 10) };
    });
    const book: PriceBook = {
      version: 1,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(old.updatedAt) + 1)).toISOString(),
      models,
    };
    await db.$transaction(async (tx) => {
      const updated = await tx.setting.updateMany({
        where: { key: 'model_pricing', value: { equals: json(old) } },
        data: { value: json(book) },
      });
      if (!updated.count) throw new AppError('CONFLICT', '价格已变化，请刷新后重试', 409);
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          action: 'model-pricing.update',
          targetId: 'model_pricing',
          detail: json({ previous: old, current: book }),
        },
      });
    });
    return { book, targets: modelTargets(), official: officialFlash };
  });
  app.get('/api/runs/:id/cost', async (q) => {
    const run = await accessibleRun(await identity(q), (q.params as { id: string }).id);
    const usage = run.usage as unknown as Usage,
      manifest = run.manifest as unknown as RunManifest;
    return estimateCny(
      usage,
      await readPriceBook(),
      modelTargets().vision,
      run.createdAt.toISOString(),
      manifest.model,
    );
  });
  app.get('/api/feedback', async (q) => {
    const user = await identity(q);
    const query = z
      .object({
        projectId: z.string().min(1),
        runId: z.string().optional(),
        category: z.enum(['体验反馈', '结论纠正', '知识问题', '工具故障']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        size: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(q.query);
    await projectAccess(user, query.projectId);
    const where = {
      run: { projectId: query.projectId },
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.category ? { category: query.category } : {}),
    };
    const [rows, total] = await db.$transaction([
      db.feedback.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.size,
        take: query.size,
        include: { run: { select: { task: { select: { title: true } } } } },
      }),
      db.feedback.count({ where }),
    ]);
    const authors = await db.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, name: true },
    });
    return {
      total,
      page: query.page,
      size: query.size,
      items: rows.map(({ run, userId, ...row }) => ({
        ...row,
        title: run.task.title,
        author: authors.find((u) => u.id === userId)?.name || '已停用成员',
      })),
    };
  });
}
