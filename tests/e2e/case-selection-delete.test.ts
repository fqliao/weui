import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { config } from '../../packages/config/src/index.ts';
import { Client, poll } from '../helpers.ts';

test(
  'Chrome + Midscene：跨页全选、取消、单删、批删、冲突提示与停用项',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '全选删除体验验收',
      baseUrl: 'http://127.0.0.1:5199',
    });
    const f1 = await client.call(`/websites/${site.id}/features`, 'POST', { name: '批量验收' });
    const f2 = await client.call(`/websites/${site.id}/features`, 'POST', { name: '其他功能' });
    const cases = [];
    for (let i = 1; i <= 14; i++)
      cases.push(
        await client.call(`/web-features/${i > 12 ? f2.id : f1.id}/cases`, 'POST', {
          title: `选择删除验收 ${String(i).padStart(2, '0')}`,
          startPath: '/',
          steps: [],
          assertions: ['页面可见'],
          enabled: i !== 14,
        }),
      );
    const browser = await browserEngine();
    let agent: PlaywrightAgent | undefined;
    try {
      const context = await browser.newContext({ viewport: { width: 1550, height: 1100 } });
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
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${site.id}`);
      await page.waitForSelector('.library-case');
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
      });
      const selected = async (n: number) => {
        await poll(
          async () => (await page.locator('.library-execution strong').innerText()) === `已选 ${n} 条`,
        );
      };
      const runDisabled = () =>
        page.locator('.library-execution button').filter({ hasText: '运行所选' }).isDisabled();
      assert.equal(await page.locator('.library-case').count(), 10);
      await agent.aiTap('选择删除验收 01 左边的复选框');
      await selected(1);
      assert.equal(
        await page.locator('.library-selection input').evaluate((e) => (e as HTMLInputElement).indeterminate),
        true,
      );
      await agent.aiTap('全选本页复选框');
      await selected(10);
      await agent.aiAct('滚动到用例列表底部，点击下一页', { deepThink: true });
      assert.equal(await page.locator('.library-case').count(), 3);
      assert.equal(await page.locator('.library-case input:checked').count(), 0);
      await agent.aiAct('滚动到用例工具栏，点击全选筛选结果（13 条）', { deepThink: true });
      await selected(13);
      assert.equal(await runDisabled(), true, '不允许把超过上限的选择截断执行');
      assert.equal(await page.locator('.library-case input:checked').count(), 3);
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.screenshot({ path: '.runtime/screenshots/cases-select-all.png', fullPage: true });
      await agent.aiTap('删除所选按钮');
      assert.equal(await page.locator('.case-delete-list li').count(), 13);
      assert.match(await page.locator('.case-delete-dialog').innerText(), /历史报告/);
      await agent.aiTap('删除确认对话框中的取消按钮');
      assert.equal(
        (await client.call(`/websites/${site.id}/features`)).flatMap((f: any) => f.cases).length,
        14,
      );
      await agent.aiTap('清空选择按钮');
      await selected(0);
      await agent.aiTap('选择删除验收 13 所在行的删除按钮');
      assert.equal(await page.locator('.case-delete-list li').count(), 1);
      await agent.aiTap('确认删除 1 条按钮');
      await poll(async () => !(await page.$('dialog[open]')));
      assert.equal(await page.locator('.library-case').count(), 2);
      await agent.aiTap('全选本页复选框');
      await selected(2);
      assert.equal(await runDisabled(), false);
      await agent.aiTap('删除所选按钮');
      await client.call(`/web-cases/${cases[10].id}`, 'PATCH', {
        ...cases[10].content,
        revision: 1,
        title: '已被他人校准的验收用例',
      });
      await agent.aiTap('确认删除 2 条按钮');
      await page.waitForSelector('.case-delete-dialog [role="alert"]');
      assert.match(
        await page.locator('.case-delete-dialog [role="alert"]').innerText(),
        /本次未删除任何用例/,
      );
      await agent.aiTap('刷新列表并重新选择按钮');
      await poll(async () => !(await page.$('dialog[open]')));
      await agent.aiTap('删除所选按钮');
      assert.match(await page.locator('.case-delete-list').innerText(), /已被他人校准/);
      await page.screenshot({ path: '.runtime/screenshots/cases-delete-confirm.png', fullPage: true });
      await agent.aiTap('确认删除 2 条按钮');
      await poll(async () => !(await page.$('dialog[open]')));
      await selected(0);
      assert.equal(await page.locator('.library-case').count(), 10, '最后一页删除后回到有效页');
      assert.match(await page.locator('.case-pagination').innerText(), /1 \/ 1/);
      await agent.aiAct('滚动到用例筛选栏，勾选包含停用用例', { deepThink: true });
      await agent.aiTap('全选筛选结果（11 条）按钮');
      await selected(11);
      assert.equal(await runDisabled(), true, '有停用项时不静默执行所选的子集');
      assert.match(await page.locator('.library-execution').innerText(), /包含停用/);
      await agent.aiTap('删除所选按钮');
      assert.equal(await page.locator('.case-delete-list li').count(), 11);
      await agent.aiTap('确认删除 11 条按钮');
      await poll(async () => !(await page.$('dialog[open]')));
      await selected(0);
      assert.equal(await page.locator('.library-case').count(), 0);
      assert.equal(
        (await client.call(`/websites/${site.id}/features`)).flatMap((f: any) => f.cases).length,
        0,
      );
      assert.deepEqual(errors, []);
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/case-selection-delete.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            selectedAcrossPages: 13,
            deleted: 14,
            cancellationPreservedCases: true,
            staleRevisionBlocked: true,
            paginationClamped: true,
            noPartialRun: true,
            pageErrors: errors,
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
    }
  },
);
