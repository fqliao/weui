import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config, publicError } from '../../config/src/index.ts';
import { db } from '../../db/src/index.ts';
export const queueName = 'ui-agent-mvp';
export const redisConnection = () =>
  new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
export const queue = new Queue(queueName, {
  connection: redisConnection(),
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86400 }, removeOnFail: { age: 7 * 86400 } },
});
let publishing = false;
export async function publishOutbox() {
  if (publishing) return;
  publishing = true;
  try {
    const rows = await db.outbox.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    for (const row of rows) {
      await queue.add(
        row.kind,
        { referenceId: row.referenceId, ...(row.payload as object) },
        { jobId: row.id },
      );
      await db.outbox.update({ where: { id: row.id }, data: { deliveredAt: new Date() } });
    }
  } catch (e) {
    console.error('outbox', publicError(e));
  } finally {
    publishing = false;
  }
}
