import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '../helpers.ts';
import { db } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { fixtureWebsite, fixtureAccount } from '../fixtures/website.ts';
const budget = { timeoutMs: 600000, maxActions: 100, maxModelCalls: 60, maxTokens: 150000, maxCostUsd: 1 };
test('网站、会话、功能、用例、版本与项目隔离闭环', async () => {
  const client = new Client();
  await client.login();
  const fixture = await fixtureWebsite();
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: '接口验收网站',
    baseUrl: fixture.origin,
  });
  try {
    await client.call(
      '/websites',
      'POST',
      { projectId: 'sample-project', name: '非法网站', baseUrl: 'file:///etc/passwd' },
      400,
    );
    const session = await client.call(`/websites/${site.id}/sessions`, 'POST', {
      name: '测试用户',
      kind: 'form',
      config: { loginPath: '/login', successAssertion: '页面显示欢迎，测试用户' },
      ...fixtureAccount,
    });
    assert.equal(session.hasSecret, true);
    assert.ok(!JSON.stringify(session).includes(fixtureAccount.password));
    assert.ok(!('encryptedSecret' in session));
    const stored = await db.loginProfile.findUniqueOrThrow({ where: { id: session.id } });
    assert.ok(!stored.encryptedSecret.includes(fixtureAccount.password));
    const listed = await client.call(`/websites/${site.id}/sessions`);
    assert.ok(!JSON.stringify(listed).includes(fixtureAccount.password));
    const f = await client.call(`/websites/${site.id}/features`, 'POST', {
      name: '商品搜索',
      description: '按名称搜索商品',
    });
    const content = {
      title: '搜索商品',
      startPath: '/app',
      sessionId: session.id,
      steps: [
        { kind: 'input', text: '商品名称输入框', value: '红茶' },
        { kind: 'tap', text: '查询商品按钮' },
      ],
      assertions: ['搜索结果显示红茶'],
      cleanup: [{ kind: 'tap', text: '清空结果按钮' }],
    };
    const c = await client.call(`/web-features/${f.id}/cases`, 'POST', content);
    const task = await client.plan('验证商品查询', { environmentId: site.id, caseIds: [c.id], budget });
    assert.equal(task.plans[0].content.cases[0].browser.revision, 1);
    assert.equal(task.plans[0].content.vision, true);
    const modified = await client.call(`/web-cases/${c.id}`, 'PATCH', {
      ...content,
      title: '修改后的查询',
      assertions: ['搜索结果显示咖啡'],
      revision: 1,
    });
    assert.equal(modified.revision, 2);
    await client.call(`/web-cases/${c.id}`, 'PATCH', { ...content, revision: 1 }, 409);
    const frozen = await client.call(`/tasks/${task.id}`);
    assert.equal(frozen.plans[0].content.cases[0].expected, '搜索结果显示红茶');
    await client.call(`/login-profiles/${session.id}`, 'PATCH', { ...session, revision: 1 });
    if (config.visionReady)
      await client.call(
        `/tasks/${task.id}/runs`,
        'POST',
        { revision: task.revision, idempotencyKey: randomUUID() },
        400,
      );
    const outsider = new Client();
    await outsider.login(true);
    const privateProject = await db.project.create({
      data: { name: '测试隔离项目', description: '仅用于权限验证' },
    });
    await outsider.call(`/websites?projectId=${privateProject.id}`, 'GET', undefined, 403);
    await db.project.delete({ where: { id: privateProject.id } });
    const s2 = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '其他网站',
      baseUrl: fixture.origin,
    });
    const f2 = await client.call(`/websites/${s2.id}/features`, 'POST', { name: '其他功能' });
    await client.call(`/web-features/${f2.id}/cases`, 'POST', content, 400);
    await client.call(`/websites/${s2.id}`, 'PATCH', { ...s2, enabled: false });
  } finally {
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    await fixture.close();
  }
});
test(
  '真实 Midscene：访客、表单登录、会话导入、错误断言和越域阻断',
  { skip: !config.visionReady, timeout: 1200000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: 'Midscene 实测网站',
      baseUrl: fixture.origin,
    });
    try {
      const f = await client.call(`/websites/${site.id}/features`, 'POST', {
        name: '通用商品查询',
        description: '验证新网站，不使用审批适配器',
      });
      const login = await client.call(`/websites/${site.id}/sessions`, 'POST', {
        name: '表单登录实测',
        kind: 'form',
        config: {
          loginPath: '/login',
          usernameField: '邮箱输入框',
          passwordField: '密码输入框',
          submitInstruction: '点击登录按钮',
          successAssertion: '页面显示欢迎，测试用户',
        },
        ...fixtureAccount,
      });
      const imported = await client.call(`/websites/${site.id}/sessions`, 'POST', {
        name: '导入会话实测',
        kind: 'storage',
        config: { loginPath: '/storage', successAssertion: '页面显示欢迎，测试用户' },
        storageState: { cookies: [{ name: 'test_session', value: 'authorized', domain: '127.0.0.1' }] },
      });
      async function runCase(
        title: string,
        startPath: string,
        sessionId: string | null,
        assertion: string,
        steps: unknown[] = [],
      ) {
        const c = await client.call(`/web-features/${f.id}/cases`, 'POST', {
          title,
          startPath,
          sessionId,
          steps,
          assertions: [assertion],
          cleanup: steps.length ? [{ kind: 'tap', text: '清空结果按钮' }] : [],
        });
        const t = await client.plan(title, { environmentId: site.id, caseIds: [c.id], budget });
        return client.finished((await client.submit(t)).id);
      }
      const results = [];
      for (const [title, startPath, sessionId] of [
        ['访客商品查询', '/', null],
        ['表单登录商品查询', '/app', login.id],
        ['会话导入商品查询', '/storage', imported.id],
      ] as const) {
        const r = await runCase(title, startPath, sessionId, '页面搜索结果显示红茶', [
          { kind: 'input', text: '商品名称输入框', value: '红茶' },
          { kind: 'tap', text: '查询商品按钮' },
        ]);
        assert.equal(r.summary[0].result, 'PASS', JSON.stringify(r.summary));
        assert.ok(r.usage.visionCalls > 0);
        assert.ok(r.evidence.some((e: any) => e.kind === 'midscene-report'));
        assert.equal(r.cleanupStatus, 'CLEAN');
        results.push({ id: r.id, result: r.summary[0].result });
      }
      const failed = await runCase('错误断言必须失败', '/', null, '页面显示紫色独角兽正在跳舞');
      assert.equal(failed.summary[0].result, 'FAIL', JSON.stringify(failed.summary));
      results.push({ id: failed.id, result: 'FAIL' });
      const redirect = await runCase('跨域导航必须阻断', '/redirect', null, '页面正常');
      assert.equal(redirect.summary[0].result, 'BLOCKED', JSON.stringify(redirect.summary));
      results.push({ id: redirect.id, result: 'BLOCKED' });
      const fs = await import('node:fs/promises');
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/midscene-web.json',
        JSON.stringify(
          { at: new Date().toISOString(), model: process.env.MIDSCENE_MODEL_NAME, results },
          null,
          2,
        ),
      );
    } finally {
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);
test('导入 localStorage 登录后保留网站刷新令牌', { skip: !config.visionReady, timeout: 300000 }, async () => {
  const client = new Client();
  await client.login();
  const fixture = await fixtureWebsite();
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: 'localStorage 刷新验证',
    browserName: 'firefox',
    baseUrl: fixture.origin,
  });
  try {
    const session = await client.call(`/websites/${site.id}/sessions`, 'POST', {
      name: '本地存储登录',
      kind: 'storage',
      config: { loginPath: '/local-session', successAssertion: '页面显示欢迎，测试用户' },
      storageState: {
        origins: [{ origin: fixture.origin, localStorage: [{ name: 'auth-token', value: 'initial' }] }],
      },
    });
    const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '会话令牌刷新' });
    const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
      title: '保留刷新后的登录状态',
      sessionId: session.id,
      startPath: '/local-session/check',
      steps: [],
      assertions: ['页面显示会话已刷新，测试用户'],
    });
    const task = await client.plan('验证刷新后的登录状态', {
      environmentId: site.id,
      caseIds: [c.id],
      mode: config.llmKey ? 'deepagents' : 'catalog',
      budget,
    });
    assert.equal(task.plans[0].content.cases[0].id, c.id);
    assert.equal(task.plans[0].content.cases[0].expected, '页面显示会话已刷新，测试用户');
    const run = await client.finished((await client.submit(task)).id);
    assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      '.runtime/verification/localstorage-midscene.json',
      JSON.stringify({ at: new Date().toISOString(), runId: run.id, result: 'PASS' }, null, 2),
    );
  } finally {
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    await fixture.close();
  }
});

test('Edge 登录处理中等待成功页面再断言', { skip: !config.visionReady, timeout: 300000 }, async () => {
  const client = new Client();
  await client.login();
  const fixture = await fixtureWebsite({ loginDelayMs: 12000 });
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: 'Chrome 异步登录验证',
    browserName: 'edge',
    baseUrl: fixture.origin,
  });
  try {
    const session = await client.call(`/websites/${site.id}/sessions`, 'POST', {
      name: '异步登录账号',
      kind: 'form',
      config: {
        loginPath: '/login',
        usernameField: '邮箱输入框',
        passwordField: '密码输入框',
        submitInstruction: '点击登录按钮',
        successAssertion: '页面显示欢迎，测试用户',
      },
      ...fixtureAccount,
    });
    const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '异步登录' });
    const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
      title: '等待登录完成',
      sessionId: session.id,
      verifySessionOnly: true,
      startPath: '/login',
      steps: [],
      assertions: ['页面显示欢迎，测试用户'],
    });
    const task = await client.plan('等待登录成功再验证', { environmentId: site.id, caseIds: [c.id], budget });
    const run = await client.finished((await client.submit(task)).id);
    assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
    const ready = await db.runEvent.findFirst({ where: { runId: run.id, kind: 'browser.ready' } });
    assert.equal((ready?.payload as any).browserName, 'edge');
    assert.equal((ready?.payload as any).engine, 'playwright');
    assert.match((ready?.payload as any).version, /^\d+\./);
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      '.runtime/verification/chrome-async-login.json',
      JSON.stringify({ runId: run.id, result: 'PASS', browser: (ready?.payload as any).version }, null, 2),
    );
  } finally {
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    await fixture.close();
  }
});

test(
  '未执行 UI 的规划失败不需要业务清理，可重新执行',
  { skip: !config.visionReady, timeout: 300000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '无副作用重跑验证',
      baseUrl: fixture.origin,
    });
    try {
      const f = await client.call(`/websites/${site.id}/features`, 'POST', { name: '定位失败处理' });
      const c = await client.call(`/web-features/${f.id}/cases`, 'POST', {
        title: '已登录页面重复登录',
        startPath: '/already-logged-in',
        steps: [
          {
            kind: 'act',
            text: '在用户名和密码输入框分别填写 tester 和 test-password，然后点击 Login 按钮。必须存在这些控件才能执行；若当前页面已登录且没有登录表单，报告无法继续，不执行其他动作。',
          },
        ],
        assertions: ['页面显示 Dashboard'],
        cleanup: [{ kind: 'tap', text: '清空结果按钮' }],
      });
      const task = await client.plan('验证没有执行任何点击时可重跑', {
        environmentId: site.id,
        caseIds: [c.id],
        budget,
      });
      const run = await client.finished((await client.submit(task)).id);
      assert.equal(run.summary[0].result, 'BLOCKED', JSON.stringify(run.summary));
      assert.equal(run.summary[0].businessWriteAttempts, 0);
      assert.equal(run.cleanupStatus, 'NOT_REQUIRED');
      assert.equal(run.browserCleanup, 'CLOSED');
      assert.equal(run.retry.allowed, true);
      const failed = await db.action.findFirstOrThrow({ where: { runId: run.id, status: 'ERROR' } });
      assert.equal((failed.output as any).writeAttempted, false);
      assert.equal(await db.runEvent.count({ where: { runId: run.id, kind: 'cleanup.started' } }), 0);
      const retry = await client.submit(task, { parentRunId: run.id });
      const retried = await client.finished(retry.id);
      assert.equal(retried.summary[0].result, 'BLOCKED');
      assert.equal(retried.cleanupStatus, 'NOT_REQUIRED');
      const fs = await import('node:fs/promises');
      await fs.writeFile(
        '.runtime/verification/cleanup-retry.json',
        JSON.stringify(
          { first: run.id, retry: retry.id, result: 'PASS', browserCleanup: retried.browserCleanup },
          null,
          2,
        ),
      );
    } finally {
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
    }
  },
);

test.after(async () => {
  await db.$disconnect();
});
