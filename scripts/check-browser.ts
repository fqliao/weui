import { browserEngine } from '../packages/executor/src/launch.ts';
import { publicError } from '../packages/config/src/index.ts';
import { browserNameSchema } from '../packages/contracts/src/browser-choice.ts';
let browser: Awaited<ReturnType<typeof browserEngine>> | undefined;
try {
  browser = await browserEngine({
    browserName: browserNameSchema.parse(process.argv[2] ?? 'chrome'),
    onEvent: async (e) => {
      console.log(JSON.stringify(e));
    },
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.screenshot();
  await context.close();
  console.log('浏览器启动、隔离会话和截图检查通过。');
} catch (error) {
  console.error(publicError(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
