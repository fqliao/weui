import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, poll } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { browserEngine } from '../../packages/executor/src/launch.ts';

test(
  'login conditions can be edited structurally and AI reasons are visible in reports',
  { timeout: 180000 },
  async () => {
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '登录静态编辑验收',
      baseUrl: config.SAMPLE_ORIGIN,
    });
    const session = await client.call(`/websites/${site.id}/sessions`, 'POST', {
      name: '登录条件编辑',
      kind: 'storage',
      storageState: {
        cookies: [
          { name: 'test_session', value: 'editor-fixture', domain: new URL(config.SAMPLE_ORIGIN).hostname },
        ],
        origins: [],
      },
      config: { loginPath: '/', successAssertion: '页面显示测试用户' },
    });
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
      const page = await context.newPage(),
        errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${config.WEB_ORIGIN}/#/sessions?website=${site.id}`);
      await page.getByRole('button', { name: '登录条件编辑 · v1', exact: true }).click();
      await page.getByLabel('验证 1 验证方式', { exact: true }).selectOption('structured');
      await page.getByLabel('验证 1 条件', { exact: true }).selectOption('all');
      await page.getByLabel('验证 1 子条件 1 定位方式', { exact: true }).selectOption('text');
      await page.getByLabel('验证 1 子条件 1 定位内容', { exact: true }).fill('测试用户');
      await page.getByRole('button', { name: '添加子条件', exact: true }).click();
      await page.getByLabel('验证 1 子条件 2 条件', { exact: true }).selectOption('position');
      await page.getByLabel('验证 1 子条件 2 定位方式', { exact: true }).selectOption('text');
      await page.getByLabel('验证 1 子条件 2 定位内容', { exact: true }).fill('测试用户');
      await page.getByLabel('验证 1 子条件 2 页面位置', { exact: true }).selectOption('top-right');
      await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
      const saved: any = await poll(async () => {
        const rows = await client.call(`/websites/${site.id}/sessions`);
        return rows.find((r: any) => r.id === session.id && r.revision === 2);
      });
      assert.equal(saved.config.successAssertion.condition.conditions[1].region, 'top-right');
      await page.reload();
      await page.getByRole('button', { name: '登录条件编辑 · v2', exact: true }).click();
      assert.equal(await page.getByLabel('验证 1 验证方式', { exact: true }).inputValue(), 'structured');
      await page.getByLabel('验证 1 子条件 2 页面位置', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: '.runtime/verification/learned-login-editor.png' });
      const evidence = JSON.parse(await fs.readFile('.runtime/verification/learned-execution.json', 'utf8'));
      const cold = evidence.results.find((r: any) => r.execution.aiReasons?.some((a: any) => a.learned));
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${cold.id}`);
      await page.getByText(/为什么本次仍使用 AI/).click();
      assert.match(await page.locator('.cache-summary').innerText(), /已沉淀静态条件/);
      assert.match(await page.locator('.cache-summary').innerText(), /缓存失效回退/);
      await page.screenshot({ path: '.runtime/verification/learned-ai-reasons.png' });
      const warm = evidence.results.find((r: any) => r.label === '自然语言登录成功完整回放');
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${warm.id}`);
      await page.locator('.cache-summary').waitFor();
      assert.match(await page.locator('.case-metric-row').innerText(), /¥0.000000/);
      await page.screenshot({ path: '.runtime/verification/learned-zero-report.png' });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ edited: true, reopened: true, aiReasons: true, zeroReport: true }));
    } finally {
      await browser.close();
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    }
  },
);
