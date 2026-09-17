import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { browserEngine, midsceneModelConfig } from '../packages/executor/src/browser.ts';
import { config } from '../packages/config/src/index.ts';
import { Client } from '../tests/helpers.ts';
const client = new Client();
await client.login();
const browser = await browserEngine();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addCookies([
    {
      name: 'uiagent_session',
      value: client.cookie.split('=')[1],
      domain: new URL(config.WEB_ORIGIN).hostname,
      path: '/',
    },
  ]);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fs.mkdir('.runtime/screenshots', { recursive: true });
  const agent = new PlaywrightAgent(page, {
    modelConfig: midsceneModelConfig(),
    generateReport: false,
    persistExecutionDump: false,
  });
  try {
    for (const route of ['websites', 'sessions', 'cases', 'new']) {
      await page.goto(config.WEB_ORIGIN + '/#/' + route, { waitUntil: 'domcontentloaded' });
      await agent.aiWaitFor('工作台内容加载完成');
      await page.screenshot({ path: `.runtime/screenshots/${route}.png`, fullPage: true });
    }
  } finally {
    await agent.destroy();
  }
} finally {
  await browser.close();
}
