import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { config } from '../../packages/config/src/index.ts';
import { Client, poll } from '../helpers.ts';
import { fixtureWebsite } from '../fixtures/website.ts';

test(
  'Chrome 用例分页、跨页选择、右侧抽屉保存和未保存提醒',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '分页抽屉体验验收',
      baseUrl: fixture.origin,
    });
    const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '分页功能' });
    const otherFeature = await client.call(`/websites/${site.id}/features`, 'POST', {
      name: '跨功能选择验收',
    });
    for (let i = 1; i <= 13; i++)
      await client.call(`/web-features/${i === 13 ? otherFeature.id : feature.id}/cases`, 'POST', {
        title: `分页用例 ${String(i).padStart(2, '0')}`,
        startPath: '/',
        steps: [],
        assertions: ['页面显示测试商店'],
      });
    const cases = (await client.call(`/websites/${site.id}/features`)).flatMap((f: any) => f.cases);
    const browser = await browserEngine(),
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    let agent: PlaywrightAgent | undefined;
    try {
      await context.addCookies([
        {
          name: 'uiagent_session',
          value: client.cookie.split('=')[1],
          domain: new URL(config.WEB_ORIGIN).hostname,
          path: '/',
          httpOnly: true,
        },
      ]);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1550, height: 1100 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
      });
      await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${site.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.library-case');
      assert.equal((await page.$$('.library-case')).length, 10);
      assert.equal(await page.$('#case-title'), null, '初始列表不挂载下方编辑表单');
      await agent.aiTap(`${cases[0].title} 左边的复选框`);
      await agent.aiAct('滚动到用例列表底部，点击下一页按钮', { deepThink: true });
      assert.equal((await page.$$('.library-case')).length, 3);
      await agent.aiAct(`滚动到用例列表，勾选 ${cases[10].title} 左边的复选框`, { deepThink: true });
      assert.match(await page.$eval('.library-execution', (e) => e.textContent), /运行所选 2 条/);
      await agent.aiTap(`${cases[10].title} 所在行的编辑校准按钮`);
      assert.equal((await page.$$('dialog[open]')).length, 1);
      const geometry = await page.$eval('dialog[open]', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, right: r.right, w: innerWidth };
      });
      assert.ok(geometry.x > 600 && Math.abs(geometry.right - geometry.w) < 2, '抽屉贴右且保留左侧列表');
      await agent.aiInput('右侧抽屉中的用例名称输入框', { value: '分页校准已保存' });
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.screenshot({ path: '.runtime/screenshots/case-drawer-chrome.png', fullPage: true });
      await agent.aiAct('在右侧用例编辑抽屉中向下滚动，点击保存用例按钮', { deepThink: true });
      await poll(async () => !(await page.$('dialog[open]')));
      const saved = (await client.call(`/websites/${site.id}/features`))[0].cases.find(
        (c: any) => c.id === cases[10].id,
      );
      assert.equal(saved.title, '分页校准已保存');
      assert.equal(saved.revision, 2);
      assert.equal((await page.$$('.library-case')).length, 3, '保存后保留分页');
      await agent.aiTap('分页校准已保存 所在行的编辑校准按钮');
      await agent.aiInput('右侧抽屉中的用例名称输入框', { value: '不应保存的临时修改' });
      await agent.aiTap('右侧抽屉右上角的关闭用例编辑按钮');
      assert.ok(await page.$('.discard-confirm'));
      await agent.aiTap('继续编辑按钮');
      assert.ok(await page.$('dialog[open]'));
      await agent.aiTap('右侧抽屉右上角的关闭用例编辑按钮');
      await agent.aiTap('放弃修改并关闭按钮');
      assert.equal(await page.$('dialog[open]'), null);
      assert.equal(
        (await client.call(`/websites/${site.id}/features`))[0].cases.find((c: any) => c.id === saved.id)
          .title,
        saved.title,
      );
      await page.screenshot({ path: '.runtime/screenshots/case-pagination-chrome.png', fullPage: true });
      await agent.aiAct('滚动到新建用例按钮并点击', { deepThink: true });
      assert.equal(await page.$eval('#case-title', (e) => (e as HTMLInputElement).value), '');
      await agent.aiTap('右侧抽屉右上角的关闭用例编辑按钮');
      await page.goto(`${config.WEB_ORIGIN}/#/new?website=${site.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.library-case');
      assert.equal((await page.$$('.library-case')).length, 3, '旧运行入口复用用例库，保留页码');
      assert.match(await page.$eval('.library-execution', (e) => e.textContent), /已选 2 条/);
      await agent.aiAct('在每页用例数下拉框中选择 20 条', { deepThink: true });
      assert.equal((await page.$$('.library-case')).length, 13);
      assert.equal((await page.$$('.library-case input:checked')).length, 2);
      await agent.aiAct('在功能筛选下拉框中选择跨功能选择验收', { deepThink: true });
      assert.equal((await page.$$('.library-case')).length, 1);
      assert.match(await page.$eval('.library-execution', (e) => e.textContent), /已选 2 条/);
      await agent.aiTap('分页用例 13 左边的复选框');
      assert.match(await page.$eval('.library-execution', (e) => e.textContent), /已选 3 条/);
      await agent.aiAct('在功能筛选下拉框中选择全部功能', { deepThink: true });
      assert.equal((await page.$$('.library-case input:checked')).length, 3);
      assert.deepEqual(errors, []);
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/case-library.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            caseId: saved.id,
            count: 13,
            pageSize: 10,
            savedRevision: 2,
            crossPageSelection: true,
            crossFeatureSelection: true,
            drawerSave: true,
            discardProtection: true,
            modelCalls: agent.metrics.calls,
          },
          null,
          2,
        ),
      );
    } finally {
      await agent?.destroy();
      await browser.close();
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);
