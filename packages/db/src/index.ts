import { PrismaClient, Prisma } from '@prisma/client';
import '../../config/src/index.ts';
const globalDb = globalThis as unknown as { uiAgentDb?: PrismaClient };
export const db = globalDb.uiAgentDb ?? new PrismaClient({ log: ['error'] });
globalDb.uiAgentDb = db;
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export async function event(runId: string, kind: string, payload: unknown) {
  const row = await db.runEvent.create({ data: { runId, kind, payload: json(payload) } });
  return { ...row, seq: String(row.seq) };
}
export async function audit(
  actorId: string,
  action: string,
  targetId: string,
  detail: unknown = {},
  projectId?: string,
) {
  await db.auditEvent.create({ data: { actorId, action, targetId, projectId, detail: json(detail) } });
}
