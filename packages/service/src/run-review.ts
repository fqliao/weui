import { z } from 'zod';
import { db, json } from '../../db/src/index.ts';
import { projectAccess, type Identity } from '../../auth/src/index.ts';
import { AppError } from '../../config/src/index.ts';
import { readRunControl } from './run-control.ts';

export const outcomeReviewSchema = z.object({
  caseId: z.string().min(1),
  fingerprint: z.string().min(1),
  resolution: z.enum(['NO_BUSINESS_CHANGE', 'DATA_CLEANED']),
  note: z.string().trim().min(1).max(1000),
  confirmed: z.literal(true),
});
export async function reviewRunOutcome(user: Identity, runId: string, input: unknown) {
  const body = outcomeReviewSchema.parse(input);
  const existing = await db.run.findUnique({ where: { id: runId }, include: { task: true } });
  if (!existing) throw new AppError('NOT_FOUND', '运行不存在', 404);
  await projectAccess(user, existing.projectId);
  return db.$transaction(async (tx) => {
    // Same environment lock as a direct start, then the historical run lock.
    // Only completed runs are reviewable; review never cancels or cleans a run.
    await tx.$queryRaw`SELECT id FROM "Environment" WHERE id=${existing.task.environmentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Run" WHERE id=${runId} FOR UPDATE`;
    const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
    const control = await readRunControl(run, tx, body.caseId);
    if (!control.review || control.review.fingerprint !== body.fingerprint)
      throw new AppError('REVIEW_CHANGED', '运行记录已变化或无需人工核对，请刷新后查看。', 409);
    if (control.retry.allowed) return { reviewed: true, caseId: body.caseId };
    if (!control.review.pendingCases.some((c) => c.id === body.caseId))
      throw new AppError('REVIEW_SCOPE', '此用例不在待核对范围内', 409);
    await tx.auditEvent.create({
      data: {
        actorId: user.id,
        projectId: run.projectId,
        action: 'run.outcome.reviewed',
        targetId: runId,
        detail: json({
          caseId: body.caseId,
          fingerprint: body.fingerprint,
          resolution: body.resolution,
          note: body.note,
          caseTitle:
            (run.manifest as any).plan.cases.find((c: any) => c.id === body.caseId)?.title ?? body.caseId,
          reviewerName: user.name,
          originalCleanupStatus: run.cleanupStatus,
        }),
      },
    });
    return { reviewed: true, caseId: body.caseId };
  });
}
