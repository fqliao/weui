import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Client, budget, poll } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { db } from '../../packages/db/src/index.ts';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
test(
  'Firefox 探索、证据、Chrome 人工校准、发布和正式执行闭环',
  { skip: !config.visionReady || !config.llmKey, timeout: 1200000 },
  async () => {
    let writes = 0,
      deletes = 0;
    const server = createServer((q, r) => {
      if (q.method === 'POST') {
        writes++;
        r.end('write');
        return;
      }
      if (q.url?.startsWith('/delete')) {
        deletes++;
        r.end('deleted');
        return;
      }
      const products = q.url?.startsWith('/products');
      const searchPanel = `<section><label>商品名称<input id="keyword" placeholder="必填：商品名称" style="font:inherit;padding:10px;margin:10px"></label><button type="button" onclick="document.getElementById('query-feedback').textContent=document.getElementById('keyword').value.trim()?'查询完成':'请输入商品名称'">查询商品</button><button type="button" onclick="document.getElementById('query-feedback').textContent='尚未查询'">重置查询</button><p id="query-feedback">尚未查询</p></section>`;
      r.setHeader('content-type', 'text/html; charset=utf-8');
      r.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>探索验收商店</title><style>body{font:20px Arial;background:#f4f7f6;color:#183c32;margin:50px auto;max-width:950px}main{background:white;padding:40px;border-radius:18px}nav{display:flex;gap:24px}a{color:#125d4a}h1{margin:35px 0}li{padding:12px}button{padding:12px}</style><main><nav><a href="/">商店首页</a><a href="/products">商品目录</a><a href="/delete?id=1">删除商品</a></nav><h1>${products ? '商品目录' : '探索验收商店'}</h1>${products ? '<ul><li>红茶 · 20 元</li><li>咖啡 · 30 元</li></ul>' + searchPanel : '<p>欢迎选购茶饮和咖啡。点击商品目录查看商品与价格。</p>'}<form method="post" action="/order"><button>创建订单</button></form></main><script>fetch('/telemetry',{method:'POST'}).catch(()=>{})</script></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      browserName: 'firefox',
      projectId: 'sample-project',
      name: '探索闭环验收商店',
      baseUrl: origin,
    });
    try {
      const discovery = await client.call('/discoveries', 'POST', {
        environmentId: site.id,
        title: '发现商店首页和商品目录',
        startPath: '/',
        requirements:
          '首页显示探索验收商店和欢迎选购提示。\n通过商品目录导航进入目录页，目录显示红茶 20 元和咖啡 30 元。\n请探索首页和商品目录两个页面，分别沉淀页面展示用例。本次不创建订单。',
        maxPages: 2,
      });
      const before = await client.call(`/websites/${site.id}/features`);
      assert.equal(before.length, 0);
      const key = randomUUID();
      const run = await client.call(`/discoveries/${discovery.id}/start`, 'POST', { idempotencyKey: key });
      assert.equal(
        (await client.call(`/discoveries/${discovery.id}/start`, 'POST', { idempotencyKey: key })).id,
        run.id,
      );
      const done = await client.finished(run.id);
      assert.equal(done.status, 'COMPLETED', done.error || JSON.stringify(done.summary));
      assert.equal(done.summary.length, 0, '探索不产生正式测试通过结论');
      assert.equal(done.browserCleanup, 'CLOSED');
      const detail = await client.call(`/discoveries/${discovery.id}`);
      assert.equal(detail.report.observations.length, 2);
      assert.equal(detail.report.actionHistory.length, 1);
      assert.match(detail.report.actionHistory[0].outcome, /到达/);
      assert.ok(detail.report.observations.every((o: any) => o.evidenceIds.length > 0));
      assert.ok(detail.report.blockedRequests > 0);
      assert.equal(writes, 0);
      assert.equal(deletes, 0);
      assert.ok(detail.drafts.length > 0);
      assert.ok(detail.drafts.every((d: any) => d.status === 'DRAFT' && !d.publishedCaseId));
      assert.equal((await client.call(`/websites/${site.id}/features`)).length, 0);
      const draft = detail.drafts[0];
      await client.call(
        '/tasks',
        'POST',
        {
          projectId: 'sample-project',
          environmentId: site.id,
          goal: '绕过审核运行草稿',
          mode: 'catalog',
          caseIds: [draft.id],
          budget,
        },
        400,
      );
      await client.call(
        `/discovery-drafts/${draft.id}/review`,
        'POST',
        { revision: 1, decision: 'publish', confirmed: false, note: '尚未确认' },
        400,
      );
      const edited = await client.call(`/discovery-drafts/${draft.id}`, 'PATCH', {
        revision: 1,
        content: {
          ...draft.content,
          test: {
            ...draft.content.test,
            title: '人工校准的商品目录展示',
            startPath: origin + '/products',
            steps: [],
            assertions: ['页面的商品目录中显示红茶 20 元和咖啡 30 元'],
            cleanup: [],
            sessionId: null,
          },
        },
      });
      await client.call(
        `/discovery-drafts/${draft.id}/review`,
        'POST',
        { revision: 1, decision: 'publish', confirmed: true, note: '旧版本不可发布' },
        409,
      );
      let formal: any;
      const browser = await browserEngine(),
        context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      let ui: PlaywrightAgent | undefined;
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
        await page.setViewportSize({ width: 1600, height: 1150 });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        ui = new PlaywrightAgent(page, {
          modelConfig: midsceneModelConfig(),
          generateReport: false,
          persistExecutionDump: false,
          autoPrintReportMsg: false,
        });
        await page.goto(config.WEB_ORIGIN + `/#/discoveries/${discovery.id}`, {
          waitUntil: 'domcontentloaded',
        });
        await ui.aiWaitFor('页面显示用例草稿列表，以及审核校准按钮', { timeoutMs: 30000 });
        await ui.aiTap('人工校准的商品目录展示 所在行的审核校准按钮');
        await ui.aiAssert('右侧抽屉显示人工审核与校准表单');
        await fs.mkdir('.runtime/screenshots', { recursive: true });
        await page.screenshot({ path: '.runtime/screenshots/discovery-review-chrome.png', fullPage: true });
        await ui.aiInput('人工审核与校准中的用例名称输入框', { value: '人工审核的目录展示用例' });
        await ui.aiAct('向下滚动，点击保存草稿修改按钮', { deepThink: true });
        await poll(
          async () =>
            (await client.call(`/discoveries/${discovery.id}`)).drafts.some(
              (d: any) => d.id === draft.id && d.revision > edited.revision,
            ),
          20000,
        );
        await ui.aiWaitFor('页面显示草稿修改已保存，或保存草稿修改按钮已禁用', { timeoutMs: 20000 });
        await ui.aiAct('在右侧审核抽屉内滚动到底部，让审核意见与校准说明的大文本框和审核确认复选框完整显示', {
          deepThink: true,
        });
        await ui.aiInput('审核意见 / 校准说明的大文本输入框', {
          value: '已按需求 R2 校准目录展示预期，无需准备或删除业务数据',
        });
        await ui.aiTap('我已核对需求依据、预期、登录身份、测试数据及清理方式前面的复选框');
        await page.screenshot({ path: '.runtime/screenshots/discovery-before-publish.png', fullPage: true });
        const formState = await page.evaluate(() => ({
          note: (document.querySelector('#draft-note') as HTMLTextAreaElement)?.value,
          buttons: [...document.querySelectorAll('button')]
            .filter((b) => /审核通过并发布|保存草稿修改/.test(b.textContent || ''))
            .map((b) => ({ label: b.textContent, disabled: b.disabled })),
          confirmed: (document.querySelector('label.inline-check input') as HTMLInputElement)?.checked,
        }));
        assert.ok(
          formState.note?.length &&
            formState.confirmed &&
            formState.buttons.some((b) => b.label?.includes('审核通过并发布') && !b.disabled),
          JSON.stringify(formState),
        );
        await ui.aiTap('审核通过并发布按钮');
        await ui.aiWaitFor('页面显示已发布到功能与用例', { timeoutMs: 20000 });
        await page.screenshot({
          path: '.runtime/screenshots/discovery-published-chrome.png',
          fullPage: true,
        });
        await ui.aiAct('在右侧抽屉内滚动到顶部，点击查看用例链接进入用例库', { deepThink: true });
        await page.waitForSelector('.library-case');
        await ui.aiTap('运行所选 1 条按钮');
        const directRunId = await poll(async () =>
          page.url().includes('/runs/') ? page.url().split('/runs/')[1] : null,
        );
        formal = await client.finished(directRunId);
        assert.equal(formal.usage.modelCalls, 0, '审核发布后直跑，无需重新规划');
        assert.deepEqual(errors, []);
      } finally {
        const pages = await context.pages();
        if (pages[0])
          await pages[0]
            .screenshot({ path: '.runtime/screenshots/discovery-review-last.png', fullPage: true })
            .catch(() => {});
        await ui?.destroy();
        await browser.close();
      }
      const published = {
        caseId: (await client.call(`/discoveries/${discovery.id}`)).drafts.find((d: any) => d.id === draft.id)
          .publishedCaseId,
      };
      assert.ok(published.caseId);
      await client.call(
        `/discovery-drafts/${draft.id}/review`,
        'POST',
        { revision: edited.revision, decision: 'publish', confirmed: true, note: '重复提交不可重复发布' },
        409,
      );
      const cases = await client.call(`/websites/${site.id}/features`);
      assert.equal(cases.flatMap((f: any) => f.cases).length, 1);
      assert.equal(formal.manifest.plan.cases[0].id, published.caseId);
      assert.equal(formal.summary[0].result, 'PASS', JSON.stringify(formal.summary));
      const next = {
        environmentId: site.id,
        title: '商品目录边界探索',
        startPath: '/products',
        requirements:
          '目录页的商品名称查询字段是必填项。保持商品名称为空并点击查询商品按钮时，必须显示“请输入商品名称”，这是本阶段需要新增的边界用例；重置查询按钮恢复“尚未查询”。',
        maxPages: 1,
        phase: 'BOUNDARY',
        baselineDiscoveryId: discovery.id,
        baselineRunId: formal.id,
      };
      await client.call('/discoveries', 'POST', { ...next, baselineRunId: null }, 400);
      await client.call('/discoveries', 'POST', { ...next, phase: 'DIVERGENT' }, 400);
      const boundary = await client.call('/discoveries', 'POST', next);
      assert.equal(boundary.phase, 'BOUNDARY');
      assert.equal(boundary.baselineRunId, formal.id);
      const choices = await client.call(`/discoveries/${discovery.id}/baselines`);
      assert.ok(choices.some((r: any) => r.id === formal.id));
      const boundaryRun = await client.call(`/discoveries/${boundary.id}/start`, 'POST', {
        idempotencyKey: randomUUID(),
      });
      assert.equal((await client.finished(boundaryRun.id)).status, 'COMPLETED');
      const boundaryDetail = await client.call(`/discoveries/${boundary.id}`);
      assert.equal(boundaryDetail.report.stage, 'BOUNDARY');
      const boundaryDraft = boundaryDetail.drafts[0];
      assert.ok(boundaryDraft);
      const boundaryEdit = await client.call(`/discovery-drafts/${boundaryDraft.id}`, 'PATCH', {
        revision: boundaryDraft.revision,
        content: {
          ...boundaryDraft.content,
          test: {
            ...boundaryDraft.content.test,
            title: '人工确认商品名称必填边界',
            startPath: origin + '/products',
            sessionId: null,
            steps: [{ kind: 'tap', text: '查询商品按钮' }],
            assertions: ['页面显示请输入商品名称'],
            cleanup: [{ kind: 'tap', text: '重置查询按钮' }],
          },
        },
      });
      const boundaryPublished = await client.call(`/discovery-drafts/${boundaryDraft.id}/review`, 'POST', {
        revision: boundaryEdit.revision,
        decision: 'publish',
        confirmed: true,
        note: '按需求确认商品名称必填提示，独立新页面保持空输入，最后重置查询状态。',
      });
      const boundaryFormal = await client.run('正式验证商品名称必填边界', {
        environmentId: site.id,
        caseIds: [boundaryPublished.caseId],
        budget,
      });
      assert.equal(boundaryFormal.summary[0].result, 'PASS');
      const divergent = await client.call('/discoveries', 'POST', {
        ...next,
        phase: 'DIVERGENT',
        title: '寻找商品目录额外入口',
        requirements:
          '在完成目录主链路和价格边界验证后，寻找帮助、预览等非主流程入口；不存在时记录缺口，避免重复已有用例。',
        baselineDiscoveryId: boundary.id,
        baselineRunId: boundaryFormal.id,
      });
      const divergentRun = await client.call(`/discoveries/${divergent.id}/start`, 'POST', {
        idempotencyKey: randomUUID(),
      });
      assert.equal((await client.finished(divergentRun.id)).status, 'COMPLETED');
      const divergentDetail = await client.call(`/discoveries/${divergent.id}`);
      assert.equal(divergentDetail.report.stage, 'DIVERGENT');
      assert.ok(divergentDetail.report.gaps.length > 0);
      if (detail.drafts.length > 1)
        await client.call(`/discovery-drafts/${detail.drafts[1].id}/review`, 'POST', {
          revision: 1,
          decision: 'reject',
          confirmed: true,
          note: '此条暂不纳入本轮测试',
        });
      const privateProject = await db.project.create({
        data: { name: '探索权限隔离验收', description: '临时权限测试' },
      });
      const outsider = new Client();
      await outsider.login(true);
      await outsider.call(`/discoveries?projectId=${privateProject.id}`, 'GET', undefined, 403);
      const isolated = await db.discovery.create({
        data: {
          projectId: privateProject.id,
          environmentId: site.id,
          taskId: randomUUID(),
          title: '隔离探索',
          requirements: '隔离需求',
          maxPages: 1,
        },
      });
      const isolatedDraft = await db.discoveryDraft.create({
        data: { discoveryId: isolated.id, content: edited.content },
      });
      await outsider.call(`/discoveries/${isolated.id}`, 'GET', undefined, 403);
      await outsider.call(
        `/discovery-drafts/${isolatedDraft.id}`,
        'PATCH',
        { revision: 1, content: edited.content },
        403,
      );
      await outsider.call(
        `/discovery-drafts/${isolatedDraft.id}/review`,
        'POST',
        { revision: 1, decision: 'publish', confirmed: true, note: '越权发布' },
        403,
      );
      await db.discoveryDraft.delete({ where: { id: isolatedDraft.id } });
      await db.discovery.delete({ where: { id: isolated.id } });
      await db.project.delete({ where: { id: privateProject.id } });
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/discovery-flow.json',
        JSON.stringify(
          {
            discoveryId: discovery.id,
            explorationRunId: run.id,
            formalRunId: formal.id,
            caseId: published.caseId,
            pages: detail.report.observations.length,
            drafts: detail.drafts.length,
            boundaryDiscoveryId: boundary.id,
            boundaryFormalRunId: boundaryFormal.id,
            divergentDiscoveryId: divergent.id,
            exploratoryWrites: 0,
            exploratoryDeletes: deletes,
          },
          null,
          2,
        ),
      );
    } finally {
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    }
  },
);
