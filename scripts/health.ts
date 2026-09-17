import { config } from '../packages/config/src/index.ts';
import { db } from '../packages/db/src/index.ts';
import { Redis } from 'ioredis';
const result: Record<string, unknown> = {};
for (const [name, url] of [
  ['api', config.API_ORIGIN + '/health'],
  ['web', config.WEB_ORIGIN],
  ['sample', config.SAMPLE_ORIGIN + '/health'],
])
  try {
    result[name] = (await fetch(url, { signal: AbortSignal.timeout(15000) })).ok;
  } catch {
    result[name] = false;
  }
const redis = new Redis(config.REDIS_URL, {
  connectTimeout: 3000,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
try {
  result.redis = (await redis.ping()) === 'PONG';
} catch {
  result.redis = false;
} finally {
  redis.disconnect();
}
try {
  await db.$queryRaw`SELECT 1`;
  result.database = true;
  result.workers = (await db.setting.findMany({ where: { key: { startsWith: 'worker:' } } })).filter(
    (w) => Date.now() - Date.parse((w.value as { heartbeat: string }).heartbeat) < 10000,
  ).length;
} catch {
  result.database = false;
} finally {
  await db.$disconnect();
}
console.log(JSON.stringify(result, null, 2));
if (Object.values(result).some((v) => v === false) || !result.workers) process.exitCode = 1;
