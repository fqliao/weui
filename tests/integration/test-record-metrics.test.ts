import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { db, json } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { browserEngine } from '../../packages/executor/src/browser.ts';
import { Client, budget } from '../helpers.ts';

test('记录列表显示实际方式、运行耗时与人民币估价，缺失数据不当作免费', async () => {
  const client = new Client();
  await client.login();
  const { user } = await client.call('/auth/me');
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: '记录指标隔离验证',
    baseUrl: 'http://127.0.0.1:5199',
  });
  let taskId = '';
  const ids: string[] = [];
  try {
    const task = await db.task.create({
      data: {
        projectId: site.projectId,
        environmentId: site.id,
        creatorId: user.id,
        title: '记录指标验证',
        goal: '只验证列表，不执行业务',
        status: 'COMPLETED',
        knowledgeReleaseId: 'sample-knowledge-v1',
        budget: json(budget),
      },
    });
    taskId = task.id;
    const zero = { inputTokens: 0, outputTokens: 0, modelCalls: 0, visionCalls: 0 };
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const priced = i === 1 || i === 3;
      const usage =
        i === 2
          ? {}
          : priced
            ? {
                ...zero,
                inputTokens: 1000,
                outputTokens: 100,
                visionCalls: 1,
                charges: [
                  {
                    model: 'test-model',
                    baseUrl: 'http://127.0.0.1',
                    role: 'vision',
                    currency: 'CNY',
                    at: new Date().toISOString(),
                    inputTokens: i === 3 ? 500 : 1000,
                    outputTokens: 100,
                    rate: null,
                    period: 'flat',
                    costUsd: null,
                    costCny: 0.003832,
                    sourceUrl: '',
                    verifiedAt: '',
                  },
                ],
              }
            : zero;
      const row = await db.run.create({
        data: {
          taskId,
          projectId: site.projectId,
          creatorId: user.id,
          status: 'COMPLETED',
          idempotencyKey: randomUUID(),
          manifest: { executionMode: 'l2', browser: { name: 'chrome' }, plan: { cases: [{ id: 'case-1' }] } },
          summary: [
            {
              caseId: 'case-1',
              result: 'PASS',
              ...(i === 2
                ? {}
                : {
                    execution: {
                      mode: 'l2',
                      l2Hits: 5,
                      l1Hits: 0,
                      aiOperations: priced ? 1 : 0,
                      fallbacks: 0,
                      published: true,
                      key: 'test',
                    },
                  }),
            },
          ],
          usage: json(usage),
          createdAt: new Date(Date.now() - 60000 - i),
          startedAt: i === 2 ? null : new Date(now - 20000),
          finishedAt: i === 2 ? null : new Date(now - 5616),
        },
      });
      ids.push(row.id);
    }
    const records = await client.call(`/test-records?projectId=${site.projectId}&website=${site.id}`);
    const rows = ids.map((id) => records.rows.find((r: any) => r.id === id));
    assert.equal(rows[0].execution.label, '二级静态执行');
    assert.equal(rows[0].performance.costCny, 0);
    assert.equal(rows[0].performance.durationMs, 14384);
    assert.equal(rows[1].execution.label, '二级 + AI');
    assert.equal(rows[1].execution.mode, 'l2');
    assert.equal(rows[1].performance.costCny, 0.003832);
    assert.equal(rows[1].performance.costStatus, 'recorded');
    assert.equal(rows[2].execution.label, '方式未记录');
    assert.equal(rows[2].performance.costCny, null);
    assert.equal(rows[2].performance.durationMs, null);
    assert.equal(rows[3].performance.costStatus, 'partial');

    const browser = await browserEngine();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
      await context.addCookies([
        {
          name: 'uiagent_session',
          value: client.cookie.slice(client.cookie.indexOf('=') + 1),
          domain: new URL(config.WEB_ORIGIN).hostname,
          path: '/',
          httpOnly: true,
        },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${config.WEB_ORIGIN}/#/tasks?website=${site.id}`);
      await page.waitForSelector(`[data-run-id="${ids[0]}"]`);
      const text = (id: string) => page.locator(`[data-run-id="${id}"]`).innerText();
      assert.match(await text(ids[0]), /二级静态执行[\s\S]*二级缓存优先[\s\S]*14.38 秒[\s\S]*¥0.000000/);
      assert.match(await text(ids[1]), /二级 \+ AI[\s\S]*¥0.003832/);
      assert.match(await text(ids[2]), /方式未记录[\s\S]*未记录 \/ 未定价/);
      assert.match(await text(ids[3]), /≥¥0.003832[\s\S]*部分计价/);
      assert.deepEqual(await page.locator('.run-records th').allTextContents(), [
        '测试 / 网站',
        '执行状态',
        '验证结果',
        '测试方式',
        '耗时',
        '预估费用（元）',
        '创建时间',
        '',
      ]);
      await mkdir('.runtime/verification', { recursive: true });
      await page.screenshot({ path: '.runtime/verification/test-record-metrics.png', fullPage: true });
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 1050 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `page overflow at ${width}px`,
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  } finally {
    await db.run.deleteMany({ where: { id: { in: ids } } });
    if (taskId) await db.task.delete({ where: { id: taskId } });
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    await db.$disconnect();
  }
});
