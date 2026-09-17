import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, poll } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { browserEngine } from '../../packages/executor/src/launch.ts';

test(
  'testers can edit structured controls, waits, parameters and assertions in the case drawer',
  { timeout: 180000 },
  async () => {
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '结构化编辑界面验收',
      baseUrl: config.SAMPLE_ORIGIN,
    });
    const browser = await browserEngine();
    try {
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '参数编辑与验证' });
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '界面编辑结构化用例',
        startPath: '/',
        steps: [{ kind: 'input', text: '名称输入框', value: '原值' }],
        assertions: ['页面正确显示结果'],
      });
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
      await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${site.id}`);
      const row = page.locator('.library-case').filter({ hasText: '界面编辑结构化用例' });
      await row.getByText(/执行能力/).click();
      assert.match(await row.innerText(), /需要 AI|AI 定位/);
      await row.getByRole('button', { name: '编辑校准' }).click();
      const drawer = page.getByRole('dialog');
      await drawer.waitFor();
      await drawer.getByRole('checkbox', { name: '指定控件定位，优先静态执行' }).check();
      await drawer.getByLabel('操作步骤 1 定位内容', { exact: true }).fill('姓名');
      await drawer.getByLabel('操作步骤 1 输入值', { exact: true }).fill('{{data.name}}');
      await drawer.getByRole('button', { name: '添加参数', exact: true }).click();
      await drawer.getByLabel('参数 1 名称', { exact: true }).fill('name');
      await drawer.getByLabel('参数 1 值', { exact: true }).fill('测试-{{runId}}');
      await drawer.getByRole('button', { name: '添加操作步骤', exact: true }).click();
      await drawer.getByLabel('操作步骤 2 类型', { exact: true }).selectOption('wait');
      await drawer.getByLabel('操作步骤 2 描述', { exact: true }).fill('等待提交成功');
      await drawer.getByRole('checkbox', { name: '使用结构化等待条件' }).check();
      await drawer.getByLabel('操作步骤 2 定位方式', { exact: true }).selectOption('text');
      await drawer.getByLabel('操作步骤 2 定位内容', { exact: true }).fill('提交成功');
      await drawer.getByLabel('操作步骤 2 超时', { exact: true }).fill('3000');
      await drawer.getByLabel('验证 1 验证方式', { exact: true }).selectOption('structured');
      await drawer.getByLabel('验证 1 条件', { exact: true }).selectOption('value');
      await drawer.getByLabel('验证 1 定位内容', { exact: true }).fill('姓名');
      await drawer.getByLabel('验证 1 预期值', { exact: true }).fill('{{data.name}}');
      await drawer.getByRole('button', { name: '添加验证', exact: true }).click();
      await drawer.getByLabel('验证 2 验证方式', { exact: true }).selectOption('ai');
      await drawer.getByLabel('验证 2 描述', { exact: true }).fill('页面排版合理，无文字遮挡');
      await fs.mkdir('.runtime/verification', { recursive: true });
      await drawer.getByLabel('验证 1 预期值', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: '.runtime/verification/structured-editor.png' });
      await drawer.getByRole('button', { name: '保存用例', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      const saved = await poll(async () => {
        const features = await client.call(`/websites/${site.id}/features`);
        const updated = features.flatMap((f: any) => f.cases).find((v: any) => v.id === c.id);
        return updated?.revision === 2 ? updated : null;
      });
      assert.equal(saved.content.parameters.name, '测试-{{runId}}');
      assert.equal(saved.content.steps[0].target.value, '姓名');
      assert.equal(saved.content.steps[1].condition.kind, 'visible');
      assert.equal(saved.content.steps[1].timeoutMs, 3000);
      assert.equal(saved.content.assertions[0].condition.expected, '{{data.name}}');
      assert.equal(saved.content.assertions[1], '页面排版合理，无文字遮挡');
      await row.locator('.case-capabilities summary').click();
      assert.match(await row.innerText(), /3\/4 项具备静态条件/);
      assert.match(await row.innerText(), /需要 AI/);
      await row.getByRole('button', { name: '编辑校准' }).click();
      await drawer.waitFor();
      assert.equal(await drawer.getByLabel('操作步骤 1 定位内容', { exact: true }).inputValue(), '姓名');
      assert.equal(await drawer.getByLabel('验证 1 验证方式', { exact: true }).inputValue(), 'structured');
      assert.equal(await drawer.getByLabel('参数 1 值', { exact: true }).inputValue(), '测试-{{runId}}');
      assert.deepEqual(errors, []);
      const verification = JSON.parse(
        await fs.readFile('.runtime/verification/structured-execution.json', 'utf8'),
      );
      for (const r of [
        verification.results[0],
        verification.results.find((r: any) => r.label === '无定位步骤通过 AI 学习'),
      ].filter(Boolean)) {
        await page.goto(`${config.WEB_ORIGIN}/#/runs/${r.id}`);
        await page.locator('.cache-summary').waitFor();
        await poll(async () => (await page.locator('.monitor-steps .execution-capability').count()) > 0);
        const text = await page.locator('.monitor-steps').innerText();
        assert.match(text, /二级静态执行/);
        if (r.execution.aiOperations > 0) assert.match(text, /已使用 AI 实时推理/);
        else assert.match(await page.locator('.case-metric-row').innerText(), /¥0.000000/);
        await page.screenshot({
          path: `.runtime/verification/structured-${r.execution.aiOperations > 0 ? 'mixed' : 'zero'}-report.png`,
        });
      }
      console.log(
        JSON.stringify({
          saved: true,
          reopened: true,
          capabilities: true,
          reportTiers: true,
          screenshots: '.runtime/verification/structured-*.png',
        }),
      );
    } finally {
      await browser.close();
      const sites = await client.call('/websites?projectId=sample-project');
      const current = sites.find((s: any) => s.id === site.id);
      await client.call(`/websites/${site.id}`, 'PATCH', { ...current, enabled: false });
    }
  },
);
