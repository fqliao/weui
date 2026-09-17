import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client, poll, budget } from '../helpers.ts';
import { db, json } from '../../packages/db/src/index.ts';
import { config, hash } from '../../packages/config/src/index.ts';
import { ToolGateway } from '../../packages/tools/src/gateway.ts';
import { emptyUsage, type RunManifest } from '../../packages/contracts/src/index.ts';
const client = new Client(),
  tester = new Client();
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { skip: !config.visionReady }, fn);
let healthy: any;
before(async () => {
  await client.login();
  await tester.login(true);
});
after(async () => {
  await db.$disconnect();
});
test('登录、会话注销、跨站写入与测试人员管理权限', async () => {
  const anonymous = new Client();
  await anonymous.call('/projects', 'GET', undefined, 401);
  await anonymous.call('/auth/login', 'POST', { email: 'admin@uiagent.local', password: 'incorrect' }, 401);
  await tester.call('/admin/execution', 'POST', { enabled: false }, 403);
  const bad = await fetch(config.API_ORIGIN + '/api/tasks', {
    method: 'POST',
    headers: {
      origin: 'https://untrusted.example',
      'content-type': 'application/json',
      cookie: client.cookie,
    },
    body: '{}',
  });
  assert.equal(bad.status, 403);
  const logout = new Client();
  await logout.login(true);
  await logout.call('/auth/logout', 'POST', {});
  await logout.call('/projects', 'GET', undefined, 401);
});
test('Web 可访问；平台服务与 Worker 已连接', async () => {
  assert.equal((await fetch(config.WEB_ORIGIN)).status, 200);
  const h = await client.call('/admin/health');
  assert.equal(h.database, true);
  assert.equal(h.redis, true);
  assert.equal(h.sample, true);
  assert.ok((await client.call('/meta')).workers > 0);
});
test('确认版本冲突拒绝；并发重复确认只生成一次运行', async () => {
  const task = await client.plan('平台验证 C01 C02');
  const updated = await client.call(`/tasks/${task.id}/plans/${task.revision}`, 'PATCH', {
    caseIds: ['C01'],
  });
  await client.call(
    `/tasks/${task.id}/runs`,
    'POST',
    { revision: task.revision, idempotencyKey: randomUUID() },
    409,
  );
  const key = randomUUID(),
    requests = Array.from({ length: 3 }, () =>
      client.call(`/tasks/${task.id}/runs`, 'POST', { revision: updated.revision, idempotencyKey: key }),
    );
  const runs = await Promise.all(requests);
  assert.equal(new Set(runs.map((r) => r.id)).size, 1);
  healthy = await client.finished(runs[0].id);
  assert.equal(healthy.status, 'COMPLETED', healthy.error);
  assert.equal(healthy.cleanupStatus, 'CLEAN');
  assert.equal(healthy.summary[0].result, 'PASS');
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
  assert.equal(await db.outbox.count({ where: { kind: 'run', referenceId: healthy.id } }), 1);
  assert.equal(await db.sampleRecord.count({ where: { namespace: { startsWith: healthy.id } } }), 0);
});
test('持久化 SSE 支持重连游标，截图与 Midscene 报告都是真实证据', async () => {
  const events = await db.runEvent.findMany({ where: { runId: healthy.id }, orderBy: { seq: 'asc' } }),
    cursor = events[Math.floor(events.length / 2)].seq;
  const r = await fetch(`${config.API_ORIGIN}/api/runs/${healthy.id}/events`, {
    headers: { cookie: client.cookie, 'Last-Event-ID': String(cursor) },
    signal: AbortSignal.timeout(20000),
  });
  const stream = await r.text();
  const ids = [...stream.matchAll(/^id: (\d+)/gm)].map((x) => BigInt(x[1]));
  assert.ok(ids.length);
  assert.ok(ids.every((id) => id > cursor));
  assert.match(stream, /event: end/);
  const report = await client.call(`/runs/${healthy.id}/report`);
  assert.equal(report.counts.PASS, 1);
  assert.equal(
    report.evidence.some((e: any) => 'path' in e),
    false,
  );
  for (const e of healthy.evidence) {
    const response = await fetch(config.API_ORIGIN + `/api/evidence/${e.id}`, {
      headers: { cookie: client.cookie },
    });
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 100);
    if (e.kind === 'screenshot') assert.equal(Buffer.from(bytes.slice(1, 4)).toString(), 'PNG');
    else {
      const text = Buffer.from(bytes).toString('utf8');
      assert.ok(text.toLowerCase().includes('midscene'));
      assert.ok(!text.includes(config.SAMPLE_SERVICE_KEY));
      assert.ok(!text.includes('sample_session='));
    }
  }
});
test('历史反馈不会覆盖原始机器结果', async () => {
  const summary = JSON.stringify(healthy.summary);
  await tester.call(`/runs/${healthy.id}/feedback`, 'POST', {
    rating: 4,
    category: '体验反馈',
    comment: '断言和证据可以对应，报告符合预期。',
  });
  const run = await client.call(`/runs/${healthy.id}`);
  assert.equal(JSON.stringify(run.summary), summary);
  assert.ok(run.feedback.length);
});
test('项目外用户不能读任务、运行、证据和 SSE', async () => {
  const foreign = await db.project.create({
    data: { name: '权限隔离验证', description: '自动化创建的权限反例项目' },
  });
  const user = await db.user.findUniqueOrThrow({ where: { email: process.env.BOOTSTRAP_TESTER_EMAIL! } });
  const task = await db.task.create({
    data: {
      projectId: foreign.id,
      environmentId: 'unused',
      creatorId: user.id,
      title: '隔离任务',
      goal: '不可跨项目读取',
      mode: 'catalog',
      knowledgeReleaseId: 'unused',
      budget: json(budget),
    },
  });
  const run = await db.run.create({
    data: {
      taskId: task.id,
      projectId: foreign.id,
      creatorId: user.id,
      idempotencyKey: randomUUID(),
      manifest: json(healthy.manifest),
      summary: [],
      usage: json(emptyUsage()),
    },
  });
  const evidence = await db.evidence.create({
    data: {
      runId: run.id,
      caseId: 'C01',
      kind: 'screenshot',
      fileName: 'restricted.png',
      path: 'restricted.png',
      contentType: 'image/png',
      bytes: 1,
    },
  });
  await client.call(`/tasks/${task.id}`, 'GET', undefined, 403);
  await tester.call(`/runs/${run.id}`, 'GET', undefined, 403);
  await client.call(`/evidence/${evidence.id}`, 'GET', undefined, 403);
  await client.call(`/runs/${run.id}/events`, 'GET', undefined, 403);
  await db.evidence.delete({ where: { id: evidence.id } });
  await db.run.delete({ where: { id: run.id } });
  await db.task.delete({ where: { id: task.id } });
  await db.project.delete({ where: { id: foreign.id } });
});
test('执行开关与环境开关在提交时生效', async () => {
  const task = await client.plan('开关检查 C01');
  await client.call('/admin/execution', 'POST', { enabled: false });
  try {
    await client.call(
      `/tasks/${task.id}/runs`,
      'POST',
      { revision: task.revision, idempotencyKey: randomUUID() },
      503,
    );
  } finally {
    await client.call('/admin/execution', 'POST', { enabled: true });
  }
  const env = await client.environment('none');
  const t = await client.plan('环境停用 C01', { environmentId: env.id });
  await client.call(`/admin/environments/${env.id}`, 'PATCH', { enabled: false });
  await client.call(
    `/tasks/${t.id}/runs`,
    'POST',
    { revision: t.revision, idempotencyKey: randomUUID() },
    400,
  );
});
test('停用、缺配置、未知工具和越界工具地址被拒绝', async () => {
  const t = await client.plan('视觉配置检查 C01');
  if (!config.visionReady)
    await client.call(
      `/tasks/${t.id}/runs`,
      'POST',
      { revision: t.revision, idempotencyKey: randomUUID() },
      400,
    );
  await client.call(
    '/admin/environments',
    'POST',
    { projectId: 'sample-project', name: '未授权地址', baseUrl: 'http://169.254.169.254' },
    400,
  );
  const gateway = new ToolGateway(
    healthy.id,
    'none',
    0,
    healthy.manifest,
    emptyUsage(),
    new AbortController().signal,
  );
  await assert.rejects(() =>
    gateway.http(healthy.id + '-C01', 'https://untrusted.example/internal/observations'),
  );
  await assert.rejects(() => gateway.http(healthy.id + '-C01', '/internal/observations?namespace=other-run'));
  await assert.rejects(() => gateway.http('another-run-C01', '/internal/observations'));
});
test('运行中的取消会终止后续动作并收尾，不生成通过结论', async () => {
  const env = await client.environment('none', 4000);
  const task = await client.plan('取消场景 C01 C02', { environmentId: env.id });
  const run = await client.submit(task);
  await poll(
    async () =>
      await db.action.findFirst({
        where: { runId: run.id, tool: 'midscene.ui', input: { path: ['label'], equals: '保存申请按钮' } },
      }),
    120000,
  );
  await client.call(`/runs/${run.id}/cancel`, 'POST', {});
  const end = await client.finished(run.id);
  assert.equal(end.status, 'CANCELLED');
  assert.ok(end.summary.every((c: any) => c.result !== 'PASS'));
  assert.ok(end.summary.some((c: any) => c.caseId === 'C02' && c.result === 'SKIPPED'));
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(
    await db.sampleRecord.count({ where: { namespace: { startsWith: run.id } } }),
    0,
    '取消后的迟到写入必须被隔离清理',
  );
});
test('Worker 失联由租约回收器标记未知结果，旧执行者不能继续', async () => {
  const task = await client.plan('租约回收验证 C01');
  const manifest = { ...healthy.manifest, revision: task.revision } as RunManifest;
  const run = await db.run.create({
    data: {
      taskId: task.id,
      projectId: task.projectId,
      creatorId: task.creatorId,
      status: 'RUNNING',
      leaseOwner: 'lost-worker',
      leaseEpoch: 1,
      heartbeatAt: new Date(Date.now() - 60000),
      startedAt: new Date(Date.now() - 60000),
      idempotencyKey: randomUUID(),
      manifest: json(manifest),
      summary: [],
      usage: json(emptyUsage()),
    },
  });
  await db.action.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      caseId: 'C01',
      tool: 'browser.run_case',
      status: 'STARTED',
      leaseEpoch: 1,
      input: { write: true },
    },
  });
  const end = await client.finished(run.id);
  assert.equal(end.status, 'ERROR');
  assert.equal(end.summary[0].result, 'INCONCLUSIVE');
  assert.equal(end.cleanupStatus, 'FAILED');
  const gateway = new ToolGateway(
    run.id,
    'lost-worker',
    1,
    manifest,
    emptyUsage(),
    new AbortController().signal,
  );
  await assert.rejects(() => gateway.call('C01', 'browser.run_case', '旧执行者', {}, async () => true));
  await client.call(
    `/tasks/${task.id}/runs`,
    'POST',
    { revision: task.revision, idempotencyKey: randomUUID(), parentRunId: run.id },
    400,
  );
  await client.call(
    `/tasks/${task.id}/runs`,
    'POST',
    { revision: task.revision, idempotencyKey: randomUUID() },
    400,
  );
});
test('Skill 复制、当前草稿全量调试、发布、旧版本锁定与回退', async () => {
  const template = (await client.call('/skills?projectId=sample-project'))[0];
  const draft = {
    ...template.draft,
    name: '验证技能-' + randomUUID().slice(0, 5),
    caseIds: ['C11'],
    ruleIds: ['R03', 'R08', 'R10'],
  };
  const skill = await tester.call('/skills', 'POST', { projectId: 'sample-project', draft });
  await client.call(`/skills/${skill.id}/releases`, 'POST', { debugRunId: healthy.id }, 400);
  const debug = await tester.call(`/skills/${skill.id}/debug-runs`, 'POST', {
    environmentId: 'sample-environment',
    knowledgeReleaseId: 'sample-knowledge-v1',
    mode: 'catalog',
  });
  const task = await tester.planned(debug.taskId),
    run = await tester.finished((await tester.submit(task)).id);
  assert.equal(run.summary[0].result, 'PASS');
  assert.equal(run.cleanupStatus, 'CLEAN');
  await tester.call(`/skills/${skill.id}/releases`, 'POST', { debugRunId: run.id }, 403);
  const v1 = await client.call(`/skills/${skill.id}/releases`, 'POST', { debugRunId: run.id });
  const pinned = await client.plan('复用发布方法 C11', { skillReleaseId: v1.id });
  await tester.call(`/skills/${skill.id}/draft`, 'PATCH', {
    draft: { ...draft, instructions: draft.instructions + ' 新增说明：先检查审计计数。' },
  });
  await client.call(`/skills/${skill.id}/releases`, 'POST', { debugRunId: run.id }, 400);
  const debug2 = await tester.call(`/skills/${skill.id}/debug-runs`, 'POST', {
    environmentId: 'sample-environment',
    knowledgeReleaseId: 'sample-knowledge-v1',
    mode: 'catalog',
  });
  const t2 = await tester.planned(debug2.taskId),
    r2 = await tester.finished((await tester.submit(t2)).id);
  const v2 = await client.call(`/skills/${skill.id}/releases`, 'POST', { debugRunId: r2.id });
  assert.equal(v2.version, 2);
  const pinnedRun = await client.finished((await client.submit(pinned)).id);
  assert.equal(pinnedRun.manifest.skillHash, v1.hash);
  assert.equal(pinnedRun.manifest.skillReleaseId, v1.id);
  await client.call(`/skills/${skill.id}/rollback`, 'POST', { releaseId: v1.id });
  const detail = await client.call(`/skills/${skill.id}`);
  assert.equal(detail.activeReleaseId, v1.id);
  assert.equal(detail.releases.length, 2);
  assert.ok(detail.debugRuns.length);
});
