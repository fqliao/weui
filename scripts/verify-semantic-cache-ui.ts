import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '../tests/helpers.ts';
import { config } from '../packages/config/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../packages/executor/src/browser.ts';
import { MidsceneBrowserAgent } from '../packages/executor/src/midscene-agent.ts';

const fixture = JSON.parse(await fs.readFile('.runtime/verification/execution-cache.json', 'utf8'));
const warm = fixture.results.find((r: any) => r.mode === 'l2' && r.calls === 0 && r.result === 'PASS');
assert.ok(warm, 'A verified semantic warm run is required');
const client = new Client();
await client.login();
const browser = await browserEngine();
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies([
    {
      name: 'uiagent_session',
      value: client.cookie.slice(client.cookie.indexOf('=') + 1),
      domain: new URL(config.WEB_ORIGIN).hostname,
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(config.WEB_ORIGIN + `/#/runs/${warm.id}`);
  await page.locator('.cache-summary').waitFor();
  const agent = new MidsceneBrowserAgent(page, {
    modelConfig: midsceneModelConfig(),
    generateReport: false,
    persistExecutionDump: false,
  });
  try {
    assert.match(await page.locator('.cache-summary').innerText(), /目标语义和本次参数/);
    assert.match(await page.locator('.case-metric-row').innerText(), /¥0.000000/);
    await page.locator('.cache-summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.runtime/verification/semantic-cache-report.png', fullPage: true });
    await agent.aiTap('当前用例结果中的“查看二级缓存”');
    await page.getByRole('dialog').waitFor();
    await page.locator('.cache-operation').first().waitFor();
    const l2Tab = page.getByRole('tab', { name: '二级 · 静态操作' });
    if ((await l2Tab.getAttribute('aria-selected')) !== 'true') {
      await agent.aiTap('右侧缓存抽屉顶部的“二级 · 静态操作”标签，在“一级 · 规划与定位”右边');
    }
    assert.equal(await l2Tab.getAttribute('aria-selected'), 'true');
    await agent.aiTap('右侧抽屉第一个操作下方的“查看缓存内容与校验信息”');
    const content = await page.locator('.cache-operation').first().innerText();
    assert.match(content, /"guard"/);
    assert.match(content, /"target"/);
    assert.match(content, /"by": "label"/);
    await page.screenshot({ path: '.runtime/verification/semantic-cache-inspector.png', fullPage: true });
    const detail = await client.call(`/execution-caches/${warm.execution.key}`);
    assert.ok(detail.l2.some((op: any) => JSON.parse(op.content).check?.kind === 'text-visible'));
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        runId: warm.id,
        semanticReport: true,
        zeroCost: true,
        targetAndGuardVisible: true,
        originalCheckVisible: true,
      }),
    );
  } finally {
    await agent.destroy();
  }
} finally {
  await browser.close();
}
