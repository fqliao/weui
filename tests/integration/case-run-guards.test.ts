import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, json } from '../../packages/db/src/index.ts';
import { passwordHash } from '../../packages/auth/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { CASES } from '../../packages/knowledge/src/catalog.ts';
import { Client } from '../helpers.ts';
import { fixtureWebsite } from '../fixtures/website.ts';

test(
  '直跑接口权限、并发去重、停用与前次未知结果保护',
  { skip: !config.visionReady, timeout: 120000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '直跑接口保护验收',
      baseUrl: fixture.origin,
    });
    const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '只读页面检查' });
    const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
      title: '首页可见',
      startPath: '/',
      steps: [],
      assertions: ['页面显示测试商店'],
    });
    const user = await db.user.create({
      data: {
        email: `isolated-${randomUUID()}@example.test`,
        name: '权限测试临时用户',
        passwordHash: passwordHash('Test-only-8653'),
        role: 'TESTER',
      },
    });
    const skippedCase = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
      title: '同批次未执行用例',
      startPath: '/',
      steps: [],
      assertions: ['页面显示测试商店'],
    });
    let runId: string | undefined;
    try {
      const body = {
        projectId: 'sample-project',
        environmentId: site.id,
        caseIds: [c.id, skippedCase.id],
        budget: { maxActions: 1 },
        idempotencyKey: randomUUID(),
      };
      const outsider = new Client();
      await outsider.call('/auth/login', 'POST', { email: user.email, password: 'Test-only-8653' });
      await outsider.call('/case-runs', 'POST', body, 403);
      const starts = await Promise.all(
        Array.from({ length: 5 }, () => client.call('/case-runs', 'POST', body)),
      );
      assert.equal(new Set(starts.map((r) => r.id)).size, 1);
      runId = starts[0].id;
      await outsider.call(`/runs/${runId}/preview`, 'GET', undefined, 403);
      const done = await client.finished(runId!);
      assert.equal(done.summary[0].result, 'INCONCLUSIVE', JSON.stringify(done.summary));
      // Create an uncertain write record only inside this disposable test run.
      const original = done.summary;
      await db.action.create({
        data: {
          id: randomUUID(),
          runId: runId!,
          caseId: c.id,
          tool: 'midscene.ui',
          status: 'UNKNOWN_OUTCOME',
          leaseEpoch: 1,
          input: json({ phase: 'case', write: true }),
          output: json({ writeAttempted: true }),
          finishedAt: new Date(),
        },
      });
      const rejected = await client.call(
        '/case-runs',
        'POST',
        { ...body, idempotencyKey: randomUUID() },
        409,
      );
      assert.equal(rejected.code, 'PREVIOUS_RUN');
      assert.equal(rejected.details.runId, runId);
      assert.equal(rejected.details.caseId, c.id);
      // Checking a safe case first must not skip the unsafe case from the same run.
      await client.call(
        '/case-runs',
        'POST',
        { ...body, caseIds: [skippedCase.id, c.id], idempotencyKey: randomUUID() },
        409,
      );
      const independent = await client.call('/case-runs', 'POST', {
        ...body,
        caseIds: [skippedCase.id],
        idempotencyKey: randomUUID(),
      });
      await client.finished(independent.id);
      assert.ok(original.length);
      await client.call(
        '/case-runs',
        'POST',
        { ...body, caseIds: ['C01'], idempotencyKey: randomUUID() },
        400,
      );
      // Sample selection also freezes the exact requested subset (without a planner).
      const env = await client.environment('none');
      try {
        const sample = await client.call('/case-runs', 'POST', {
          projectId: 'sample-project',
          environmentId: env.id,
          caseIds: ['C04'],
          budget: { maxActions: 1 },
          idempotencyKey: randomUUID(),
        });
        assert.deepEqual(
          sample.manifest.plan.cases.map((x: any) => x.id),
          ['C04'],
        );
        assert.equal(sample.manifest.plan.cases[0].expected, CASES.find((x) => x.id === 'C04')!.expected);
        await client.finished(sample.id);
      } finally {
        await db.environment.update({ where: { id: env.id }, data: { enabled: false } });
      }
    } finally {
      if (runId) {
        const r = await client.call(`/runs/${runId}`);
        if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(r.status)) {
          await client.call(`/runs/${runId}/cancel`, 'POST');
          await client.finished(runId);
        }
      }
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      await fixture.close();
    }
  },
);
