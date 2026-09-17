import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '../tests/helpers.ts';
import { config } from '../packages/config/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../packages/executor/src/browser.ts';
import { MidsceneBrowserAgent } from '../packages/executor/src/midscene-agent.ts';
const fixture = JSON.parse(await fs.readFile('.runtime/verification/cache-observability.json', 'utf8'));
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
  await page.goto(config.WEB_ORIGIN + '/#/cases');
  await page.getByRole('heading', { name: '用例库', exact: true }).waitFor();
  const agent = new MidsceneBrowserAgent(page, {
    modelConfig: midsceneModelConfig(),
    generateReport: false,
    persistExecutionDump: false,
    replanningCycleLimit: 3,
  });
  try {
    const negative = page.locator('.library-case').filter({ hasText: '错误账号登录提示（访客）' });
    await negative.locator('.cache-badges button').first().waitFor();
    const selected = await negative.locator('input[type=checkbox]').isChecked();
    await negative.scrollIntoViewIfNeeded();
    await agent.aiTap('用例“错误账号登录提示（访客）”下方的二级缓存状态按钮');
    await page.getByRole('dialog').waitFor();
    await page.locator('.cache-operation').first().waitFor();
    assert.equal(
      await negative.locator('input[type=checkbox]').isChecked(),
      selected,
      'Cache inspection must not toggle case selection',
    );
    await page.screenshot({ path: '.runtime/verification/cache-inspector-l2.png', fullPage: true });
    await agent.aiTap('右侧缓存抽屉顶部的“一级 · 规划与定位”标签');
    await page.getByRole('tab', { name: '一级 · 规划与定位' }).waitFor();
    assert.match(await page.locator('.cache-operation-list').innerText(), /XPath/);
    await page.screenshot({ path: '.runtime/verification/cache-inspector-l1.png', fullPage: true });
    await agent.aiTap('右侧缓存抽屉右上角的关闭图标');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const runId = fixture.runs.at(-1).id;
    await page.goto(config.WEB_ORIGIN + `/#/runs/${runId}`);
    await page.locator('.case-metric-row').waitFor();
    assert.match(await page.locator('.case-metric-row').innerText(), /¥0.000000/);
    await page.getByRole('button', { name: '历史趋势', exact: true }).scrollIntoViewIfNeeded();
    await agent.aiTap('当前用例耗时指标右侧的“历史趋势”按钮');
    await page.locator('.case-trend svg').first().waitFor();
    assert.equal(await page.locator('.case-trend svg').count(), 3);
    assert.equal(await page.locator('.case-trend').first().locator('circle').count(), 5);
    await page.screenshot({ path: '.runtime/verification/case-history-trends.png', fullPage: true });
    await page.locator('.cache-summary').scrollIntoViewIfNeeded();
    await agent.aiTap('当前用例结果中的“查看二级缓存”');
    await page.getByRole('dialog').waitFor();
    await page.locator('.cache-field textarea').first().waitFor();
    if ((await page.getByRole('tab', { name: '二级 · 静态操作' }).getAttribute('aria-selected')) !== 'true') {
      await agent.aiTap('右侧缓存抽屉顶部的“二级 · 静态操作”标签');
    }
    assert.equal(
      await page.getByRole('tab', { name: '二级 · 静态操作' }).getAttribute('aria-selected'),
      'true',
    );
    const beforeEdit = await client.call(`/execution-caches/${fixture.cacheId}`);
    const editedSelector = beforeEdit.l2[0].fields[0].value === '#query' ? 'input#query' : '#query';
    await agent.aiInput('第一个操作的 CSS 定位输入框', { value: editedSelector });
    await agent.aiTap('缓存抽屉底部的“保存缓存”按钮');
    await page.locator('.drawer-notice').filter({ hasText: '已保存' }).waitFor();
    const detail = await client.call(`/execution-caches/${fixture.cacheId}`);
    assert.equal(detail.l2[0].fields[0].value, editedSelector);
    assert.equal(detail.edited, true);
    await agent.aiTap('缓存抽屉顶部的“更新记录”标签');
    await page.locator('.cache-revisions .diff-after').first().waitFor();
    assert.match(await page.locator('.cache-revisions').innerText(), /input#query/);
    await page.screenshot({ path: '.runtime/verification/cache-update-diff.png', fullPage: true });
    await agent.aiTap('右侧缓存抽屉右上角的关闭图标');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.case-performance').scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Report must fit mobile viewport',
    );
    await page.screenshot({ path: '.runtime/verification/case-history-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        bothTierInspectors: true,
        caseSelectionUnchanged: true,
        uiSavedSelector: true,
        fieldDiffVisible: true,
        charts: 3,
        historyPoints: 5,
        mobile: true,
      }),
    );
  } finally {
    await agent.destroy();
  }
} finally {
  await browser.close();
}
