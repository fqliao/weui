import { z } from 'zod';

export const browserNameSchema = z.enum(['chrome', 'edge', 'firefox']);
export type BrowserName = z.infer<typeof browserNameSchema>;
export const browserLabels: Record<BrowserName, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
};
export function configuredBrowser(config: unknown): BrowserName {
  const name = (config as { browser?: unknown } | null)?.browser;
  return browserNameSchema.parse(name ?? 'chrome');
}
