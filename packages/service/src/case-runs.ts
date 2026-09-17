import { z } from 'zod';
import { db, json } from '../../db/src/index.ts';
import { AppError, hash } from '../../config/src/index.ts';
import { projectAccess, type Identity } from '../../auth/src/index.ts';
import { budgetSchema, emptyUsage, type CaseSpec, type Plan } from '../../contracts/src/index.ts';
import { createTask, submitRun } from './index.ts';
import { browserNameSchema } from '../../contracts/src/browser-choice.ts';
import { executionModeSchema } from '../../contracts/src/execution-cache.ts';

const selectionSchema = z.object({
  executionMode: executionModeSchema.default('l2'),
  browserName: browserNameSchema.optional(),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  caseIds: z
    .array(z.string().min(1))
    .min(1)
    .max(12)
    .refine((ids) => new Set(ids).size === ids.length),
  idempotencyKey: z.string().min(8).max(100),
  budget: budgetSchema.default({
    timeoutMs: 600000,
    maxActions: 100,
    maxModelCalls: 60,
    maxTokens: 150000,
    maxCostUsd: 1,
  }),
});

// A request key identifies the complete Task + Plan + Run operation, including retries
// after a lost HTTP response. The execution still passes through submitRun's guards.
export async function runSelectedCases(user: Identity, input: unknown) {
  const data = selectionSchema.parse(input);
  await projectAccess(user, data.projectId);
  const requestHash = hash({ ...data, idempotencyKey: undefined });
  const id = `cases-${hash([user.id, data.projectId, data.idempotencyKey])}`;
  let task = await db.task.findUnique({ where: { id } });
  if (!task) {
    const env = await db.environment.findFirst({
      where: { id: data.environmentId, projectId: data.projectId, enabled: true },
    });
    if (!env) throw new AppError('ENVIRONMENT', '网站不存在或已停用');
    const knowledge =
      env.adapter === 'sample-approval-v1'
        ? await db.knowledgeRelease.findFirst({
            where: { projectId: data.projectId, published: true, id: 'sample-knowledge-v1' },
          })
        : null;
    try {
      task = await createTask(
        user,
        {
          ...data,
          mode: 'catalog',
          goal: `执行所选 ${data.caseIds.length} 条测试用例`,
          knowledgeReleaseId: knowledge?.id,
        },
        undefined,
        { id, requestHash },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      task = await db.task.findUniqueOrThrow({ where: { id } });
    }
  }
  const snapshot = task.browserSnapshot as {
    directRequestHash?: string;
    cases: CaseSpec[];
    environmentRevision?: number;
  };
  if (snapshot.directRequestHash !== requestHash)
    throw new AppError('IDEMPOTENCY_CONFLICT', '此提交已绑定其他用例或配置，请重新提交', 409);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id=${id} FOR UPDATE`;
    if (await tx.planRevision.findUnique({ where: { taskId_revision: { taskId: id, revision: 1 } } })) return;
    const plan: Plan = {
      summary: `执行人工选定的 ${snapshot.cases.length} 条用例，按当前保存版本验证`,
      cases: snapshot.cases.map((c) => ({ ...c, reason: '用户直接选择已保存用例' })),
      missingRequirements: [],
      mode: 'catalog',
      vision: true,
      ...(snapshot.environmentRevision ? { environmentRevision: snapshot.environmentRevision } : {}),
    };
    await tx.planRevision.create({
      data: { taskId: id, revision: 1, content: json(plan), hash: hash(plan), usage: json(emptyUsage()) },
    });
    await tx.task.update({
      where: { id },
      data: {
        revision: 1,
        status: 'AWAITING_APPROVAL',
        title:
          snapshot.cases.length === 1
            ? snapshot.cases[0].title
            : `${snapshot.cases[0].title} 等 ${snapshot.cases.length} 条用例`,
      },
    });
  });
  return submitRun(user, id, 1, data.idempotencyKey);
}
