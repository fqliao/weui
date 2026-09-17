import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { Client, poll } from '../helpers.ts';
import { fixtureWebsite, fixtureAccount } from '../fixtures/website.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { config } from '../../packages/config/src/index.ts';
import { db } from '../../packages/db/src/index.ts';

test(
  '用例直跑：幂等、登录隐藏、实时画面、步骤证据、Chrome 选择与回归',
  { skip: !config.visionReady, timeout: 900000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '简洁测试流程验收',
      baseUrl: fixture.origin,
    });
    const browser = await browserEngine();
    let agent: PlaywrightAgent | undefined;
    const runIds: string[] = [];
    try {
      const session = await client.call(`/websites/${site.id}/sessions`, 'POST', {
        name: '验收账号',
        kind: 'form',
        config: {
          loginPath: '/login',
          usernameField: '邮箱输入框',
          passwordField: '密码输入框',
          successAssertion: '页面显示欢迎，测试用户',
        },
        ...fixtureAccount,
      });
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', {
        name: '商品查询',
        description: '查询商品并核对页面结果',
      });
      const content = {
        title: '查询红茶',
        startPath: '/app',
        sessionId: session.id,
        steps: [
          { kind: 'input', text: '商品名称输入框', value: '红茶' },
          { kind: 'tap', text: '查询商品按钮' },
        ],
        assertions: ['搜索结果显示红茶'],
        cleanup: [{ kind: 'tap', text: '清空结果按钮' }],
      };
      const first = await client.call(`/web-features/${feature.id}/cases`, 'POST', content);
      const negative = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '页面错误预期验证',
        startPath: '/',
        steps: [],
        assertions: ['页面主标题是蓝莓仓库'],
      });
      const disabled = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '已停用案例',
        startPath: '/',
        steps: [],
        assertions: ['显示测试商店'],
        enabled: false,
      });
      const request = {
        projectId: 'sample-project',
        environmentId: site.id,
        caseIds: [first.id],
        idempotencyKey: randomUUID(),
      };
      await client.call('/case-runs', 'POST', { ...request, caseIds: [first.id, first.id] }, 400);
      await client.call(
        '/case-runs',
        'POST',
        { ...request, caseIds: [disabled.id], idempotencyKey: randomUUID() },
        400,
      );
      await client.call(
        '/case-runs',
        'POST',
        { ...request, caseIds: ['unpublished-draft'], idempotencyKey: randomUUID() },
        400,
      );
      const responses = await Promise.all([
        client.call('/case-runs', 'POST', request),
        client.call('/case-runs', 'POST', request),
        client.call('/case-runs', 'POST', request),
      ]);
      assert.equal(new Set(responses.map((r) => r.id)).size, 1);
      const runId = responses[0].id;
      runIds.push(runId);
      assert.deepEqual(
        responses[0].manifest.plan.cases.map((c: any) => c.id),
        [first.id],
      );
      await client.call('/case-runs', 'POST', { ...request, caseIds: [negative.id] }, 409);
      await client.call('/case-runs', 'POST', { ...request, idempotencyKey: randomUUID() }, 409);
      const anonymous = new Client();
      await anonymous.call(`/runs/${runId}/preview`, 'GET', undefined, 401);
      let hiddenLogin = false,
        actualFrame = false;
      const completed = await poll(async () => {
        const { frame } = await client.call(`/runs/${runId}/preview`);
        if (frame?.phase === 'authentication') {
          hiddenLogin = true;
          assert.equal(frame.image, undefined);
        }
        if (frame?.image) {
          actualFrame = true;
          assert.ok(Buffer.from(frame.image, 'base64').length > 1000);
        }
        const run = await client.call(`/runs/${runId}`);
        return ['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status) ? run : null;
      }, 500000);
      assert.equal(completed.summary[0].result, 'PASS', JSON.stringify(completed.summary));
      assert.ok(hiddenLogin, '登录阶段仅发布隐藏状态');
      assert.ok(actualFrame, '实际发布浏览器 JPEG 画面');
      assert.equal(completed.usage.modelCalls, 0, '直跑不调用规划模型');
      const events = await db.runEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
      assert.equal(
        events.filter((e) => e.kind === 'step.completed' && (e.payload as any).phase === 'case').length,
        2,
      );
      assert.ok(events.some((e) => e.kind === 'assertion.completed' && (e.payload as any).passed));
      assert.ok(completed.evidence.some((e: any) => e.fileName.includes('step-1.png')));
      assert.equal(await db.run.count({ where: { taskId: completed.taskId } }), 1);
      assert.equal((await client.call('/case-runs', 'POST', request)).id, runId);
      // A subsequent edit must not rewrite the frozen regression baseline.
      await client.call(`/web-cases/${first.id}`, 'PATCH', {
        ...content,
        title: '查询红茶（已校准）',
        revision: 1,
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });
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
      });
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.goto(`${config.WEB_ORIGIN}/#/new?website=${site.id}`, { waitUntil: 'domcontentloaded' });
      await agent.aiWaitFor('页面显示查询红茶（已校准）和页面错误预期验证两个用例');
      assert.equal(
        await page.$eval('.website-filter select', (el) => (el as HTMLSelectElement).value),
        site.id,
      );
      assert.equal(await page.$('#goal'), null, '默认界面不要求目标规划');
      await agent.aiTap('页面错误预期验证 左边的复选框');
      await page.screenshot({ path: '.runtime/screenshots/case-selection-chrome.png', fullPage: true });
      await agent.aiAct('点击运行所选用例按钮，如未看到请向下滚动', { deepThink: true });
      const selectedRunId = await poll(async () =>
        page.url().includes('/runs/') ? page.url().split('/runs/')[1] : null,
      );
      runIds.push(selectedRunId);
      const fail = await client.finished(selectedRunId);
      assert.equal(fail.summary.length, 1);
      assert.equal(fail.summary[0].caseId, negative.id);
      assert.equal(fail.summary[0].result, 'FAIL', JSON.stringify(fail.summary));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await agent.aiWaitFor('页面显示本次测试标题与不成立的验证结果', { timeoutMs: 30000 });
      await agent.aiAssert('执行已结束，页面存在不成立的验证结果');
      await page.screenshot({ path: '.runtime/screenshots/case-failure-chrome.png', fullPage: true });
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${runId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        (shortId) => document.body.textContent?.includes(`运行 ${shortId}`),
        runId.slice(0, 8),
      );
      await agent.aiTap('一键回归按钮');
      const regressionId = await poll(async () =>
        page.url().includes('/runs/') && !page.url().endsWith(runId) ? page.url().split('/runs/')[1] : null,
      );
      runIds.push(regressionId);
      // Capture the real in-progress monitor before waiting for completion.
      await poll(async () => {
        const data = await client.call(`/runs/${regressionId}/preview`);
        return data.frame?.image ? true : null;
      }, 180000);
      await agent.aiAct('向下滚动到正在执行的浏览器与步骤区域', { deepThink: true });
      await agent.aiWaitFor('页面显示真实浏览器画面，里面有商品查询页面', { timeoutMs: 30000 });
      await page.screenshot({ path: '.runtime/screenshots/case-live-chrome.png', fullPage: true });
      const regression = await client.finished(regressionId);
      assert.equal(regression.parentRunId, runId);
      assert.equal(regression.manifest.planHash, completed.manifest.planHash);
      assert.equal(regression.manifest.plan.cases[0].browser.revision, 1);
      assert.equal(regression.summary[0].result, 'PASS', JSON.stringify(regression.summary));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await agent.aiAct('滚动到测试结果与过程区域，点击步骤 1 截图按钮', { deepThink: true });
      await agent.aiAssert('测试结果与过程区域显示操作步骤与通过的验证结果');
      await page.screenshot({ path: '.runtime/screenshots/case-replay-chrome.png', fullPage: true });
      assert.deepEqual(errors, []);
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/case-runs.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            runId,
            selectedRunId,
            regressionId,
            hiddenLogin,
            actualFrame,
            duplicateRuns: false,
            selectedResult: 'FAIL',
            regressionResult: 'PASS',
            uiModelCalls: agent.metrics.calls,
          },
          null,
          2,
        ),
      );
    } finally {
      await agent?.destroy();
      await browser.close();
      for (const id of runIds) {
        const run = await client.call(`/runs/${id}`);
        if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status)) {
          await client.call(`/runs/${id}/cancel`, 'POST');
          await client.finished(id);
        }
      }
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);
