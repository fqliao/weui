import { Redis } from 'ioredis';
import type { Page } from 'playwright';
import { config } from '../../config/src/index.ts';
import type { ToolGateway } from '../../tools/src/gateway.ts';

const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  commandTimeout: 1500,
});
redis.on('error', () => {});
export type BrowserFrame = {
  caseId: string;
  capturedAt: string;
  phase: 'authentication' | 'browser';
  image?: string;
};
export const previewKey = (id: string) => `ui-agent:preview:${id}`;
export async function readPreview(id: string): Promise<BrowserFrame | null> {
  const frame = await redis.get(previewKey(id));
  return frame ? JSON.parse(frame) : null;
}
export function browserPreview(page: Page, g: ToolGateway, caseId: string, sensitive: boolean) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending || stopped) return;
    pending = (async () => {
      await g.active();
      if (!sensitive && (page.isClosed() || page.url() === 'about:blank')) return;
      const image = sensitive
        ? undefined
        : Buffer.from(await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64');
      if (stopped) return;
      await redis.set(
        previewKey(g.runId),
        JSON.stringify({
          caseId,
          capturedAt: new Date().toISOString(),
          phase: sensitive ? 'authentication' : 'browser',
          image,
        }),
        'EX',
        86400,
      );
    })()
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 2000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
