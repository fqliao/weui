import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { Client, poll } from '../helpers.ts';
import { fixtureWebsite } from '../fixtures/website.ts';
import { config } from '../../packages/config/src/index.ts';
import { db } from '../../packages/db/src/index.ts';
import { passwordHash } from '../../packages/auth/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';

test(
  '报告入口、价格快照与工作空间反馈：API 权限和 Chrome 体验',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '报告价格与反馈验收',
      baseUrl: fixture.origin,
    });
    const outsider = await db.user.create({
      data: {
        email: `feedback-${randomUUID()}@example.test`,
        name: '反馈权限验证',
        passwordHash: passwordHash('Test-only-65487'),
        role: 'TESTER',
      },
    });
    const reader = new Client();
    await reader.call('/auth/login', 'POST', { email: outsider.email, password: 'Test-only-65487' });
    let browser: Awaited<ReturnType<typeof browserEngine>> | undefined,
      agent: PlaywrightAgent | undefined,
      runId = '';
    try {
      const prices = await client.call('/model-pricing');
      const flash = prices.book.models.find((p: any) => p.model === 'deepseek-flash');
      assert.equal(flash.peak.input, 2);
      assert.equal(flash.offPeak.output, 4);
      await new Client().call('/model-pricing', 'GET', undefined, 401);
      await reader.call(
        '/admin/model-pricing',
        'POST',
        { updatedAt: prices.book.updatedAt, models: prices.book.models },
        403,
      );
      await client.call(
        '/admin/model-pricing',
        'POST',
        { updatedAt: prices.book.updatedAt, models: [{ ...flash, peak: { ...flash.peak, input: -1 } }] },
        400,
      );
      await client.call(
        '/admin/model-pricing',
        'POST',
        { updatedAt: prices.book.updatedAt, models: [flash, flash] },
        400,
      );
      const saved = await client.call('/admin/model-pricing', 'POST', {
        updatedAt: prices.book.updatedAt,
        models: prices.book.models,
      });
      await client.call(
        '/admin/model-pricing',
        'POST',
        { updatedAt: prices.book.updatedAt, models: prices.book.models },
        409,
      );
      assert.deepEqual((await client.call('/model-pricing')).book, saved.book);
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '报告验收' });
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '报告价格验证用例',
        startPath: '/',
        steps: [],
        assertions: ['页面显示测试商店', '页面包含查询商品按钮'],
      });
      const submitted = await client.call('/case-runs', 'POST', {
        projectId: 'sample-project',
        environmentId: site.id,
        caseIds: [c.id],
        idempotencyKey: randomUUID(),
      });
      runId = submitted.id;
      const run = await client.finished(runId);
      assert.equal(run.summary[0].result, 'PASS', run.error || run.summary[0].message);
      assert.equal(
        run.evidence.filter((e: any) => e.kind === 'midscene-report').length,
        1,
        '两次断言只生成一份最终完整报告',
      );
      assert.equal(
        run.evidence.filter((e: any) => e.kind === 'screenshot').length,
        3,
        '两次断言及最终截图都保留',
      );
      assert.equal(run.usage.priced, true);
      assert.ok(run.usage.costCny > 0);
      assert.equal(run.manifest.models.vision.model, process.env.MIDSCENE_MODEL_NAME);
      assert.deepEqual(run.manifest.pricing, saved.book);
      assert.equal(
        run.usage.inputTokens,
        run.usage.charges.reduce((s: number, r: any) => s + r.inputTokens, 0),
      );
      const cost = await client.call(`/runs/${runId}/cost`);
      assert.equal(cost.status, 'recorded');
      assert.equal(cost.currency, 'CNY');
      assert.equal(run.usage.costUsd, 0);
      assert.equal(run.manifest.budget.maxCostCny, 10);
      assert.equal(cost.costCny, run.usage.costCny);
      await reader.call(`/runs/${runId}/cost`, 'GET', undefined, 403);
      await reader.call('/feedback?projectId=sample-project', 'GET', undefined, 403);
      await reader.call(
        `/runs/${runId}/feedback`,
        'POST',
        { rating: 5, category: '体验反馈', comment: '不应写入' },
        403,
      );
      await new Client().call('/feedback?projectId=sample-project', 'GET', undefined, 401);
      const comment = `反馈查看验收 ${randomUUID().slice(0, 8)}：过程清楚，建议保留单一报告入口。`;
      for (let i = 0; i < 11; i++)
        await client.call(`/runs/${runId}/feedback`, 'POST', {
          rating: 4,
          category: '工具故障',
          comment: `分页验证记录 ${i + 1}`,
        });
      const one = await client.call(`/feedback?projectId=sample-project&runId=${runId}&page=1&size=10`);
      const two = await client.call(`/feedback?projectId=sample-project&runId=${runId}&page=2&size=10`);
      assert.equal(one.items.length, 10);
      assert.equal(two.items.length, 1);
      assert.equal(one.total, 11);
      assert.ok(one.items[0].author && one.items[0].createdAt && one.items[0].title);
      assert.ok(!one.items.some((a: any) => two.items.some((b: any) => b.id === a.id)));
      assert.equal(
        (await client.call(`/feedback?projectId=sample-project&runId=${runId}&category=体验反馈`)).total,
        0,
      );
      await db.membership.create({ data: { userId: outsider.id, projectId: 'sample-project' } });
      assert.equal((await reader.call(`/feedback?projectId=sample-project&runId=${runId}`)).total, 11);
      browser = await browserEngine();
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
      await page.setViewportSize({ width: 1550, height: 1100 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
      });
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${runId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.run-cost');
      assert.equal(await page.title(), 'WeUI 智能 UI 测试平台');
      assert.match(await page.$eval('.sidebar .brand', (e) => e.textContent), /WeUI/);
      assert.equal(
        await page.$$eval(
          '.result-detail a',
          (links) => links.filter((a) => a.textContent?.includes('下载 Midscene 报告')).length,
        ),
        1,
      );
      await agent.aiAct('向下滚动到反馈表单和估算模型费用区域', { deepThink: true });
      await agent.aiInput('反馈内容输入框（哪一步需要改进）', { value: comment });
      assert.match(await page.$eval('.run-cost', (e) => e.textContent), /¥/);
      await agent.aiTap('提交反馈按钮');
      await poll(
        async () =>
          (await client.call(`/feedback?projectId=sample-project&runId=${runId}&category=体验反馈`)).total ===
          1,
      );
      await poll(async () =>
        (await page.$eval('.feedback-records', (e) => e.textContent))?.includes(comment),
      );
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.screenshot({ path: '.runtime/screenshots/report-feedback-chrome.png', fullPage: true });
      await agent.aiTap('左侧导航中的反馈记录');
      await poll(async () => page.url().endsWith('/feedback'));
      await page.waitForSelector('[aria-label="筛选反馈类型"]');
      await agent.aiAct('在筛选反馈类型下拉框中选择体验反馈', { deepThink: true });
      await poll(async () =>
        (await page.$eval('.feedback-records', (e) => e.textContent))?.includes(comment),
      );
      await page.screenshot({ path: '.runtime/screenshots/feedback-list-chrome.png', fullPage: true });
      await agent.aiTap('左侧空间设置导航');
      await page.waitForSelector('.pricing-settings .price-table');
      await agent.aiAct('向下滚动到模型价格设置表格', { deepThink: true });
      assert.match(await page.$eval('.pricing-settings', (e) => e.textContent), /人民币（元）\/ 百万 Token/);
      assert.match(await page.$eval('.pricing-settings', (e) => e.textContent), /2026-09-15/);
      await page.screenshot({ path: '.runtime/screenshots/model-pricing-chrome.png', fullPage: true });
      const textBefore = JSON.stringify((await client.call(`/runs/${runId}`)).usage);
      await agent.aiTap('使用已核验的官方价格按钮');
      await agent.aiTap('保存模型价格按钮');
      await poll(async () => (await client.call('/model-pricing')).book.updatedAt !== saved.book.updatedAt);
      assert.equal(
        JSON.stringify((await client.call(`/runs/${runId}`)).usage),
        textBefore,
        '设置保存不改写历史费用',
      );
      assert.deepEqual(errors, []);
      const feedback = await client.call(
        `/feedback?projectId=sample-project&runId=${runId}&category=体验反馈`,
      );
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/report-tools.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            runId,
            siteId: site.id,
            result: run.summary[0].result,
            reportCount: 1,
            screenshots: 3,
            costCny: cost.costCny,
            visionCalls: run.usage.visionCalls,
            uiCalls: agent.metrics.calls,
            feedbackId: feedback.items[0].id,
            feedbackPagination: true,
            projectAccessChecked: true,
            priceSnapshotPreserved: true,
            feedbackRemovedAfterVerification: true,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error);
      const pages = browser?.contexts().flatMap((context) => context.pages());
      for (const page of pages ?? []) {
        if (page.url().startsWith(config.WEB_ORIGIN)) {
          console.error('UI verification stopped at', page.url());
          await page
            .screenshot({ path: '.runtime/screenshots/report-tools-failure.png', fullPage: true })
            .catch(() => {});
        }
      }
      throw error;
    } finally {
      if (runId) {
        const r = await client.call(`/runs/${runId}`).catch(() => null);
        if (r && !['COMPLETED', 'ERROR', 'CANCELLED'].includes(r.status)) {
          await client.call(`/runs/${runId}/cancel`, 'POST');
          await client.finished(runId);
        }
      }
      await agent?.destroy().catch(() => {});
      await browser?.close().catch(() => {});
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      if (runId)
        await db.feedback.deleteMany({
          where: {
            runId,
            OR: [{ comment: { startsWith: '分页验证记录 ' } }, { comment: { startsWith: '反馈查看验收 ' } }],
          },
        });
      await db.session.deleteMany({ where: { userId: outsider.id } });
      await db.membership.deleteMany({ where: { userId: outsider.id } });
      await db.user.delete({ where: { id: outsider.id } });
      await fixture.close();
      await db.$disconnect();
    }
  },
);
