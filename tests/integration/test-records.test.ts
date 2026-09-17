import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, json } from '../../packages/db/src/index.ts';
import { Client, budget } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { PlaywrightAgent } from '@midscene/web/playwright';

test('运行记录按次分页、排除探索、结果筛选、停用网站与项目权限', async () => {
  const client = new Client();
  await client.login();
  const { user } = await client.call('/auth/me');
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: '记录列表隔离验证',
    baseUrl: 'http://127.0.0.1:5199',
  });
  const taskIds: string[] = [],
    runIds: string[] = [];
  let discoveryId = '';
  try {
    for (let i = 0; i < 2; i++) {
      const task = await db.task.create({
        data: {
          projectId: site.projectId,
          environmentId: site.id,
          creatorId: user.id,
          title: i ? '隔离验证探索' : '记录分页验证',
          goal: '仅验证列表数据，未执行业务',
          status: 'COMPLETED',
          knowledgeReleaseId: 'sample-knowledge-v1',
          budget: json(budget),
        },
      });
      taskIds.push(task.id);
    }
    const discovery = await db.discovery.create({
      data: {
        projectId: site.projectId,
        environmentId: site.id,
        taskId: taskIds[1],
        title: '隔离验证探索',
        requirements: '列表测试',
        maxPages: 2,
        report: { observations: [{ id: 'P1' }] },
        drafts: {
          create: [
            { content: {}, status: 'DRAFT' },
            { content: {}, status: 'PUBLISHED' },
          ],
        },
      },
    });
    discoveryId = discovery.id;
    for (let i = 0; i < 16; i++) {
      const r = await db.run.create({
        data: {
          taskId: taskIds[i === 15 ? 1 : 0],
          projectId: site.projectId,
          creatorId: user.id,
          status: i === 14 ? 'ERROR' : 'COMPLETED',
          manifest: { browser: { name: 'firefox' }, plan: { cases: [{ id: 'case-1' }] } },
          summary: i === 14 ? [] : [{ caseId: 'case-1', result: i === 13 ? 'FAIL' : 'PASS' }],
          usage: {},
          idempotencyKey: randomUUID(),
          parentRunId: i > 0 && i < 15 ? runIds[0] : null,
          createdAt: new Date(Date.now() + i),
        },
      });
      runIds.push(r.id);
    }
    const base = `/test-records?projectId=${site.projectId}&website=${site.id}`;
    const first = await client.call(base),
      second = await client.call(`${base}&page=2`);
    assert.equal(first.total, 15);
    assert.equal(first.rows.length, 10);
    assert.equal(second.rows.length, 5);
    assert.equal(new Set([...first.rows, ...second.rows].map((r: any) => r.id)).size, 15);
    assert.ok(!first.rows.concat(second.rows).some((r: any) => r.id === runIds[15]));
    assert.equal(first.rows[0].parentRunId, runIds[0]);
    assert.equal(first.rows[0].browser, 'firefox');
    assert.equal((await client.call(`${base}&filter=passed`)).total, 13);
    assert.equal((await client.call(`${base}&filter=attention`)).total, 2);
    assert.equal((await client.call(`${base}&filter=active`)).total, 0);
    assert.equal((await client.call(`${base}&search=不存在`)).total, 0);
    assert.equal((await client.call(`${base}&page=99`)).page, 2);
    const list = await client.call(`/discoveries?projectId=${site.projectId}`);
    const item = list.find((d: any) => d.id === discoveryId);
    assert.deepEqual(item.draftCounts, { DRAFT: 1, PUBLISHED: 1 });
    assert.equal(item.pageCount, 1);
    const discoveries = await client.call(
      `/discoveries?projectId=${site.projectId}&website=${site.id}&page=1&filter=review`,
    );
    assert.equal(discoveries.total, 1);
    assert.equal(discoveries.rows[0].id, discoveryId);
    assert.equal(
      (await client.call(`/discoveries?projectId=${site.projectId}&website=${site.id}&page=1&filter=active`))
        .total,
      0,
    );
    if (config.visionReady) {
      const browser = await browserEngine();
      let agent: PlaywrightAgent | undefined;
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
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
        await page.goto(`${config.WEB_ORIGIN}/#/tasks?website=${site.id}`);
        await page.waitForSelector('[data-run-id]');
        assert.equal(await page.locator('[data-run-id]').count(), 10);
        agent = new PlaywrightAgent(page, {
          modelConfig: midsceneModelConfig(),
          generateReport: false,
          persistExecutionDump: false,
          autoPrintReportMsg: false,
        });
        await agent.aiTap('需要关注筛选按钮');
        await page.waitForFunction(() => document.querySelectorAll('[data-run-id]').length === 2);
        assert.deepEqual(
          new Set(
            await page
              .locator('[data-run-id]')
              .evaluateAll((els) => els.map((el) => el.getAttribute('data-run-id'))),
          ),
          new Set([runIds[13], runIds[14]]),
        );
        await agent.aiTap('全部通过筛选按钮');
        await page.waitForFunction(() => document.querySelectorAll('[data-run-id]').length === 10);
        await agent.aiAct('滚动到测试记录底部，点击下一页', { deepThink: true });
        await page.waitForFunction(() => document.querySelectorAll('[data-run-id]').length === 3);
        await page.goto(`${config.WEB_ORIGIN}/#/discoveries?website=${site.id}`);
        await page.waitForSelector('[data-discovery-id]');
        assert.equal(await page.locator('[data-discovery-id]').count(), 1);
        await agent.aiTap('待审核筛选按钮');
        await page.waitForSelector('[data-discovery-id]');
        assert.match(await page.locator('[data-discovery-id]').innerText(), /待审核 1 条/);
        assert.match(await page.locator('[data-discovery-id]').innerText(), /已入库 1 条/);
        assert.deepEqual(errors, []);
      } finally {
        await agent?.destroy();
        await browser.close();
      }
    }
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    assert.equal((await client.call(base)).total, 0);
    assert.equal(
      (await client.call(`/discoveries?projectId=${site.projectId}&website=${site.id}&page=1`)).total,
      0,
    );
    assert.equal(
      (await client.call(`/discoveries?projectId=${site.projectId}&website=${site.id}&page=1&history=true`))
        .total,
      1,
    );
    assert.equal((await client.call(`${base}&history=true`)).total, 15);
    await client.call('/test-records?projectId=not-an-authorized-project', 'GET', undefined, 403);
    await client.call(`${base}&size=200`, 'GET', undefined, 400);
  } finally {
    if (discoveryId) {
      await db.discoveryDraft.deleteMany({ where: { discoveryId } });
      await db.discovery.delete({ where: { id: discoveryId } });
    }
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.task.deleteMany({ where: { id: { in: taskIds } } });
    const current = await db.environment.findUnique({ where: { id: site.id } });
    if (current?.enabled)
      await client.call(`/websites/${site.id}`, 'PATCH', {
        ...site,
        revision: current.revision,
        enabled: false,
      });
    await db.$disconnect();
  }
});
