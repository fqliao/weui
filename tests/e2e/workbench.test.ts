import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { Client } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { fixtureWebsite, fixtureAccount } from '../fixtures/website.ts';
test(
  'Web 自助添加网站、编辑功能用例、确认 Midscene 执行并查看报告',
  { skip: !config.visionReady, timeout: 1200000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite(),
      browser = await browserEngine(),
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const siteName = `Web 体验 ${Date.now().toString().slice(-6)}`;
    let site: any, agent: PlaywrightAgent | undefined;
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
      await page.setViewportSize({ width: 1440, height: 1100 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
        replanningCycleLimit: 12,
      });
      await page.goto(config.WEB_ORIGIN + '/#/websites', { waitUntil: 'domcontentloaded' });
      await agent.aiTap('右上角添加网站按钮');
      await agent.aiInput('网站名称输入框', { value: siteName });
      await agent.aiInput('网站地址输入框', { value: fixture.origin });
      await agent.aiTap('保存网站按钮');
      await agent.aiAssert('页面显示网站已保存的提示，或左侧我的测试网站列表包含刚添加的网站');
      site = (await client.call('/websites?projectId=sample-project')).find((s: any) => s.name === siteName);
      assert.ok(site);
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.screenshot({ path: '.runtime/screenshots/websites-midscene.png', fullPage: true });
      await agent.aiTap('左侧导航用例库');
      await agent.aiTap('新建功能按钮');
      await agent.aiInput('功能名称输入框', { value: '商品查询' });
      await agent.aiInput('业务规则与说明输入框', { value: '输入商品名，页面应显示相应搜索结果' });
      await agent.aiTap('保存功能按钮');
      await agent.aiTap('新建用例按钮');
      await agent.aiInput('用例名称输入框', { value: '查询绿茶' });
      await agent.aiScroll(undefined, { direction: 'down', distance: 650 });
      await agent.aiInput('操作步骤下方，自然语言操作下拉框右侧的单行输入框', {
        value: '在商品名称输入框填写绿茶，然后点击查询商品按钮',
      });
      await agent.aiInput('预期结果输入框，每行一条页面断言', { value: '搜索结果显示绿茶' });
      await agent.aiAct('滚动到页面底部，点击保存用例按钮', { deepThink: true });
      await page.screenshot({ path: '.runtime/screenshots/case-save-debug.png', fullPage: true });
      const features = await client.call(`/websites/${site.id}/features`);
      assert.equal(features[0].cases[0].title, '查询绿茶');
      await page.screenshot({ path: '.runtime/screenshots/case-editor-midscene.png', fullPage: true });
      await agent.aiTap('左侧导航的运行测试按钮');
      await agent.aiAct(`在测试网站下拉框中选择“${siteName}”`, { deepThink: true });
      await agent.aiTap('查询绿茶用例左边的复选框');
      await agent.aiTap('运行所选用例按钮');
      await agent.aiWaitFor('页面显示业务验证结果', { timeoutMs: 30000 });
      const runId = page.url().split('/runs/')[1];
      assert.ok(runId);
      const run = await client.finished(runId);
      assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
      assert.equal(run.manifest.environment.adapter, 'midscene-web-v1');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await agent.aiAssert('页面的业务验证结果为通过，存在执行截图');
      await page.screenshot({ path: '.runtime/screenshots/web-run-midscene.png', fullPage: true });
      assert.deepEqual(errors, []);
      await fs.writeFile(
        '.runtime/verification/web-midscene-e2e.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            runId,
            model: process.env.MIDSCENE_MODEL_NAME,
            uiModelCalls: agent.metrics.calls,
            result: 'PASS',
          },
          null,
          2,
        ),
      );
    } finally {
      await agent?.destroy();
      await browser.close();
      if (site) await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);

test(
  'Web 保存登录配置、隐藏凭证并生成登录验证计划',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: `登录体验 ${Date.now().toString().slice(-6)}`,
      baseUrl: fixture.origin,
    });
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
        },
      ]);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 1100 });
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
      });
      await page.goto(config.WEB_ORIGIN + '/#/sessions', { waitUntil: 'domcontentloaded' });
      await agent.aiTap(`我的测试网站列表中的“${site.name}”`);
      await agent.aiInput('身份名称输入框', { value: '普通测试用户' });
      await agent.aiInput('标签仅为“账号”的输入框', { value: fixtureAccount.username });
      await agent.aiInput('账号右侧、标签仅为“密码”的空白输入框，位于“密码输入框描述”上方', {
        value: fixtureAccount.password,
      });
      await agent.aiInput('账号输入框描述的输入框', { value: '邮箱输入框' });
      await agent.aiScroll(undefined, { direction: 'down', distance: 500 });
      await agent.aiInput('登录成功的页面特征输入框', { value: '页面显示欢迎，测试用户' });
      await agent.aiTap('保存登录配置按钮');
      await page.screenshot({ path: '.runtime/screenshots/session-editor-midscene.png', fullPage: true });
      const invalid = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input:invalid,textarea:invalid,select:invalid')).map((el) => ({
          id: el.id,
          message: (el as HTMLInputElement).validationMessage,
        })),
      );
      const profiles = await client.call(`/websites/${site.id}/sessions`);
      assert.equal(profiles.length, 1, JSON.stringify(invalid));
      assert.equal(profiles[0].hasSecret, true);
      assert.ok(!JSON.stringify(profiles).includes(fixtureAccount.password));
      await agent.aiTap('生成登录验证计划按钮');
      await agent.aiWaitFor('页面显示确认计划并执行按钮', { timeoutMs: 60000 });
      await agent.aiTap('确认计划并执行按钮');
      await agent.aiWaitFor('页面显示业务验证结果', { timeoutMs: 30000 });
      const runId = page.url().split('/runs/')[1];
      const run = await client.finished(runId);
      assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
      await fs.writeFile(
        '.runtime/verification/web-login-e2e.json',
        JSON.stringify(
          { at: new Date().toISOString(), runId, result: 'PASS', uiModelCalls: agent.metrics.calls },
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
