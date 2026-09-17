import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, poll } from '../helpers.ts';
import { fixtureWebsite } from '../fixtures/website.ts';
import { config } from '../../packages/config/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { MidsceneBrowserAgent } from '../../packages/executor/src/midscene-agent.ts';

test(
  'Web 浏览器选择：保存 Firefox 默认值、单次 Edge 执行及报告展示',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    let site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '浏览器选择界面验收',
      baseUrl: fixture.origin,
    });
    const browser = await browserEngine();
    let agent: MidsceneBrowserAgent | undefined;
    let runId = '';
    try {
      const f = await client.call(`/websites/${site.id}/features`, 'POST', { name: '页面展示' });
      const c = await client.call(`/web-features/${f.id}/cases`, 'POST', {
        title: '商店首页正常展示',
        startPath: '/',
        steps: [],
        assertions: ['页面主标题为测试商店'],
      });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
      await context.addCookies([
        {
          name: 'uiagent_session',
          value: client.cookie.split('=').slice(1).join('='),
          domain: new URL(config.WEB_ORIGIN).hostname,
          path: '/',
        },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      agent = new MidsceneBrowserAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
      });
      await page.goto(`${config.WEB_ORIGIN}/#/websites?website=${site.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('#site-browser');
      assert.equal(await page.inputValue('#site-browser'), 'chrome');
      assert.deepEqual(
        await page.$$eval('#site-browser option', (options) =>
          options.map((o) => (o as HTMLOptionElement).value),
        ),
        ['chrome', 'edge', 'firefox'],
      );
      await agent.aiAct('将默认测试浏览器下拉框选择为 Firefox', { deepThink: true });
      assert.equal(await page.inputValue('#site-browser'), 'firefox');
      await agent.aiTap('保存网站按钮');
      site = await poll(async () => {
        const rows = await client.call('/websites?projectId=sample-project');
        return rows.find((s: any) => s.id === site.id && s.config.browser === 'firefox') ?? null;
      });
      await page.screenshot({ path: '.runtime/screenshots/browser-default-firefox.png', fullPage: true });
      await page.goto(`${config.WEB_ORIGIN}/#/new?website=${site.id}&cases=${c.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('#cases-browser');
      await poll(async () => (await page.inputValue('#cases-browser')) === 'firefox');
      await agent.aiAct('将测试浏览器下拉框选择为 Microsoft Edge', { deepThink: true });
      assert.equal(await page.inputValue('#cases-browser'), 'edge');
      await page.screenshot({ path: '.runtime/screenshots/browser-run-edge.png', fullPage: true });
      await agent.aiTap('运行所选用例按钮');
      runId = await poll(async () => (page.url().includes('/runs/') ? page.url().split('/runs/')[1] : null));
      const run = await client.finished(runId);
      assert.equal(run.manifest.browser.name, 'edge');
      assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.run-monitor');
      await agent.aiAct('滚动到运行配置、版本与模型费用，点击展开', { deepThink: true });
      await page.waitForSelector('.manifest-grid');
      assert.match((await page.textContent('.manifest-grid')) ?? '', /Microsoft Edge/);
      assert.match((await page.textContent('.monitor-screen')) ?? '', /Microsoft Edge/);
      assert.match((await page.textContent('.manifest-grid')) ?? '', /Midscene \/ Playwright/);
      await page.screenshot({ path: '.runtime/screenshots/browser-edge-report.png', fullPage: true });
      assert.deepEqual(errors, []);
      await fs.writeFile(
        '.runtime/verification/browser-choice-ui.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            runId,
            defaultBrowser: 'firefox',
            runBrowser: 'edge',
            result: 'PASS',
          },
          null,
          2,
        ),
      );
    } finally {
      await agent?.destroy();
      await browser.close();
      if (runId) {
        const r = await client.call(`/runs/${runId}`);
        if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(r.status)) {
          await client.call(`/runs/${runId}/cancel`, 'POST');
          await client.finished(runId);
        }
      }
      const rows = await client.call('/websites?projectId=sample-project');
      site = rows.find((s: any) => s.id === site.id);
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);
