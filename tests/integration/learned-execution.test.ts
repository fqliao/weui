import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '../helpers.ts';
import { config } from '../../packages/config/src/index.ts';
import { db } from '../../packages/db/src/index.ts';
import { fixtureWebsite, fixtureAccount } from '../fixtures/website.ts';

test(
  'natural-language login, parameterized search and controls learn whole-case zero-token replay',
  { timeout: 900000, skip: !config.visionReady },
  async () => {
    const client = new Client();
    await client.login();
    // A slow login forces Midscene polling; its internal Sleep must not mark a
    // fully learned read-only condition as an incomplete write recording.
    const fixture = await fixtureWebsite({ loginDelayMs: 4500 });
    let broken = false;
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        `<!doctype html><meta charset=utf-8><style>body{font:20px Arial;padding:30px}input,button{font:20px Arial;margin:20px;padding:10px}</style><h1>任务状态验收</h1><label>订阅通知<input type=checkbox id=notify ${broken ? '' : 'checked'}></label><button id=submit ${broken ? '' : 'disabled'}>提交任务</button><p style="color:red">需要确认</p>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const sites: any[] = [],
      results: any[] = [];
    try {
      for (const [name, baseUrl] of [
        ['通用学习登录查询', fixture.origin],
        ['通用学习控件状态', origin],
      ])
        sites.push(await client.call('/websites', 'POST', { projectId: 'sample-project', name, baseUrl }));
      const login = await client.call(`/websites/${sites[0].id}/sessions`, 'POST', {
        name: '自动沉淀登录',
        kind: 'form',
        ...fixtureAccount,
        config: {
          loginPath: '/login',
          usernameField: '邮箱输入框',
          passwordField: '密码输入框',
          submitInstruction: '点击登录按钮',
          successAssertion: '页面显示欢迎，测试用户',
        },
      });
      const features: any[] = [];
      for (const site of sites)
        features.push(
          await client.call(`/websites/${site.id}/features`, 'POST', { name: '原预期自动沉淀验收' }),
        );
      async function create(index: number, content: any) {
        return client.call(`/web-features/${features[index].id}/cases`, 'POST', content);
      }
      const loginCase = await create(0, {
        title: '自然语言登录成功',
        startPath: '/login',
        sessionId: login.id,
        verifySessionOnly: true,
        steps: [],
        assertions: ['页面显示欢迎，测试用户'],
      });
      const searchCase = await create(0, {
        title: '动态查询自然语言结果',
        startPath: '/',
        steps: [
          {
            kind: 'input',
            text: '商品名称',
            target: { by: 'label', value: '商品名称' },
            value: '红茶-{{runId}}',
          },
          { kind: 'tap', text: '查询商品', target: { by: 'role', role: 'button', value: '查询商品' } },
        ],
        assertions: ['页面显示文本“搜索结果：红茶-{{runId}}”'],
        cleanup: [
          { kind: 'tap', text: '清空结果按钮' },
          { kind: 'wait', text: '页面显示尚未查询' },
        ],
      });
      const controlsCase = await create(1, {
        title: '自然语言控件状态',
        startPath: '/',
        steps: [],
        assertions: ['订阅通知已勾选，提交任务按钮处于禁用状态'],
      });
      async function run(site: any, c: any, label: string, expected = 'PASS') {
        const start = await client.call('/case-runs', 'POST', {
          projectId: site.projectId,
          environmentId: site.id,
          caseIds: [c.id],
          browserName: 'chrome',
          executionMode: 'l2',
          idempotencyKey: randomUUID(),
        });
        const done = await client.finished(start.id),
          s = done.summary[0];
        const routes = await db.runEvent.findMany({
          where: { runId: done.id, kind: { in: ['cache.route', 'cache.check.learned'] } },
          select: { kind: true, payload: true },
          orderBy: { seq: 'asc' },
        });
        const result = {
          label,
          id: done.id,
          result: s.result,
          metrics: s.metrics,
          execution: s.execution,
          routes,
        };
        results.push(result);
        await fs.mkdir('.runtime/verification', { recursive: true });
        await fs.writeFile(
          '.runtime/verification/learned-execution.json',
          JSON.stringify({ results }, null, 2),
        );
        console.log(
          JSON.stringify({
            label,
            id: done.id,
            result: s.result,
            metrics: s.metrics,
            l2: s.execution?.l2Hits,
            ai: s.execution?.aiOperations,
            reasons: s.execution?.aiReasons,
          }),
        );
        assert.equal(s.result, expected, s.message);
        return s;
      }
      for (const [site, c] of [
        [sites[0], loginCase],
        [sites[0], searchCase],
        [sites[1], controlsCase],
      ]) {
        const first = await run(site, c, `${c.title}首次学习`);
        assert.ok(first.metrics.modelCalls > 0);
        const warm = await run(site, c, `${c.title}完整回放`);
        assert.equal(warm.metrics.modelCalls, 0, JSON.stringify(warm.execution));
        assert.equal(warm.metrics.inputTokens + warm.metrics.outputTokens, 0);
      }
      const cacheBefore = await db.executionCache.findMany({
        where: { caseId: controlsCase.id },
        select: { id: true, encryptedArtifact: true },
      });
      broken = true;
      const failure = await run(sites[1], controlsCase, '控件实际状态变错', 'FAIL');
      assert.ok(failure.execution.aiOperations > 0);
      assert.equal(failure.execution.published, false);
      const failedRoutes = results
        .at(-1)
        .routes.filter((r: any) => r.kind === 'cache.route')
        .map((r: any) => `${r.payload.tier}:${r.payload.outcome}`);
      assert.deepEqual(failedRoutes, ['L2:fallback', 'L1:miss', 'AI:hit']);
      assert.deepEqual(
        await db.executionCache.findMany({
          where: { caseId: controlsCase.id },
          select: { id: true, encryptedArtifact: true },
        }),
        cacheBefore,
      );
      const unsupported = await create(1, {
        title: '不能静态表达的视觉预期',
        startPath: '/',
        steps: [],
        assertions: ['页面显示红色的需要确认文字'],
      });
      const visual = await run(sites[1], unsupported, '视觉语义保留 AI');
      assert.ok(visual.execution.aiReasons.some((r: any) => r.reason.includes('无法完整表达')));
      const structured = await client.call(`/websites/${sites[0].id}/sessions`, 'POST', {
        name: '显式结构化成功条件',
        kind: 'storage',
        storageState: { cookies: [{ name: 'test_session', value: 'authorized', domain: '127.0.0.1' }] },
        config: {
          loginPath: '/storage',
          successAssertion: {
            kind: 'structured',
            condition: {
              kind: 'text',
              target: { by: 'role', role: 'heading', value: '欢迎，测试用户' },
              match: 'equals',
              expected: '欢迎，测试用户',
            },
          },
        },
      });
      const explicit = await create(0, {
        title: '结构化登录直接静态验证',
        startPath: '/storage',
        sessionId: structured.id,
        verifySessionOnly: true,
        steps: [],
        assertions: [structured.config.successAssertion],
      });
      const cold = await run(sites[0], explicit, '结构化登录首次执行');
      assert.equal(cold.metrics.modelCalls, 0);
    } finally {
      for (const site of sites)
        await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await fixture.close();
      await db.$disconnect();
    }
  },
);
