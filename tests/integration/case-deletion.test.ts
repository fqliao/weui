import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '../helpers.ts';
import { db, json } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';

test('用例删除：版本冲突整批回滚、项目和网站隔离、历史快照保留', async () => {
  const client = new Client();
  await client.login();
  const { user } = await client.call('/auth/me');
  const site = await client.call('/websites', 'POST', {
    projectId: 'sample-project',
    name: '用例删除接口验收',
    baseUrl: 'http://127.0.0.1:5199',
  });
  const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '删除验收' });
  const privateProject = await db.project.create({ data: { name: '删除隔离项目', description: '权限验收' } });
  const foreignSite = await db.environment.create({
    data: {
      projectId: privateProject.id,
      name: '其他项目的网站',
      baseUrl: site.baseUrl,
      adapter: 'midscene-web-v1',
      credentialRef: 'none',
      config: {},
    },
  });
  const foreignFeature = await db.webFeature.create({
    data: { environmentId: foreignSite.id, name: '隔离功能', description: '' },
  });
  const content = { title: '待删除用例', startPath: '/', steps: [], assertions: ['页面显示测试商店'] };
  const foreignCase = await db.webCase.create({
    data: { featureId: foreignFeature.id, title: '其他项目用例', content },
  });
  let historicalRunId = '';
  try {
    const cases = [];
    for (let i = 0; i < 5; i++)
      cases.push(
        await client.call(`/web-features/${feature.id}/cases`, 'POST', {
          ...content,
          title: `删除验证 ${i + 1}`,
          enabled: i !== 4,
        }),
      );
    const sorted = cases.slice(0, 3).sort((a, b) => a.id.localeCompare(b.id));
    const stale = sorted[2];
    await client.call(`/web-cases/${stale.id}`, 'PATCH', {
      ...stale.content,
      revision: 1,
      title: '别人已校准',
    });
    const route = `/websites/${site.id}/cases/delete`;
    const batch = sorted.map((c) => ({ id: c.id, revision: 1 }));
    await client.call(route, 'POST', { cases: batch }, 409);
    assert.equal(await db.webCase.count({ where: { featureId: feature.id, deletedAt: { not: null } } }), 0);
    assert.equal(
      await db.auditEvent.count({
        where: { action: 'web-case.delete', targetId: { in: cases.map((c) => c.id) } },
      }),
      0,
    );
    await client.call(route, 'POST', { cases: [batch[0], batch[0]] }, 400);
    await client.call(route, 'POST', { cases: [] }, 400);
    await client.call(`/web-cases/${cases[0].id}`, 'DELETE', {}, 400);
    await client.call(`/web-cases/${foreignCase.id}`, 'DELETE', { revision: 1 }, 403);
    await client.call(
      `/websites/${foreignSite.id}/cases/delete`,
      'POST',
      { cases: [{ id: foreignCase.id, revision: 1 }] },
      403,
    );
    await client.call(route, 'POST', { cases: [batch[0], { id: foreignCase.id, revision: 1 }] }, 409);
    assert.equal((await db.webCase.findUniqueOrThrow({ where: { id: batch[0].id } })).deletedAt, null);
    assert.equal((await db.webCase.findUniqueOrThrow({ where: { id: foreignCase.id } })).deletedAt, null);

    // Keep a completed report fixture based on a real frozen plan; deletion must
    // never rewrite old expectations, results, or task configuration.
    const task = await client.plan('删除后保留快照', { environmentId: site.id, caseIds: [cases[3].id] });
    const manifest = { plan: task.plans[0].content, environment: site, browser: { name: 'chrome' } };
    const summary = [{ caseId: cases[3].id, title: cases[3].title, result: 'PASS', message: '历史报告夹具' }];
    const run = await db.run.create({
      data: {
        taskId: task.id,
        projectId: site.projectId,
        creatorId: user.id,
        status: 'COMPLETED',
        manifest: json(manifest),
        summary: json(summary),
        usage: {},
        cleanupStatus: 'NOT_REQUIRED',
        idempotencyKey: randomUUID(),
      },
    });
    historicalRunId = run.id;
    await client.call(`/web-cases/${cases[3].id}`, 'DELETE', { revision: 1 });
    await client.call(`/web-cases/${cases[3].id}`, 'PATCH', { ...content, revision: 2 }, 404);
    await client.call(
      '/case-runs',
      'POST',
      {
        projectId: site.projectId,
        environmentId: site.id,
        caseIds: [cases[3].id],
        idempotencyKey: randomUUID(),
      },
      400,
    );
    const report = await client.call(`/runs/${run.id}`);
    assert.deepEqual(report.manifest, manifest);
    assert.deepEqual(report.summary, summary);
    assert.deepEqual((await client.call(`/tasks/${task.id}`)).plans, task.plans);
    const exported = await fetch(`${config.API_ORIGIN}/api/runs/${run.id}/report`, {
      headers: { cookie: client.cookie },
    });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /历史报告夹具/);
    const disabled = await client.call(`/web-cases/${cases[4].id}`, 'DELETE', { revision: 1 });
    assert.equal(disabled.count, 1, '停用用例也可删除');
    const finalBatch = batch.map((c) => ({ ...c, revision: c.id === stale.id ? 2 : 1 }));
    const attempts = await Promise.all(
      [1, 2].map(async () => {
        const response = await fetch(`${config.API_ORIGIN}/api${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: client.cookie, origin: config.WEB_ORIGIN },
          body: JSON.stringify({ cases: finalBatch }),
        });
        await response.text();
        return response.status;
      }),
    );
    assert.deepEqual(attempts.sort(), [200, 409], '并发重复删除只允许一次提交');
    const listed = await client.call(`/websites/${site.id}/features`);
    assert.equal(listed[0].cases.length, 0);
    assert.equal(await db.webCase.count({ where: { featureId: feature.id, deletedAt: { not: null } } }), 5);
    assert.equal(
      await db.auditEvent.count({
        where: { action: 'web-case.delete', targetId: { in: cases.map((c) => c.id) } },
      }),
      5,
    );
  } finally {
    if (historicalRunId) await db.run.delete({ where: { id: historicalRunId } });
    await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
    await db.webCase.delete({ where: { id: foreignCase.id } });
    await db.webFeature.delete({ where: { id: foreignFeature.id } });
    await db.environment.delete({ where: { id: foreignSite.id } });
    await db.project.delete({ where: { id: privateProject.id } });
  }
});
test.after(async () => {
  await db.$disconnect();
});
