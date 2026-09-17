import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Client } from '../helpers.ts';
import { fixtureWebsite } from '../fixtures/website.ts';
import { config } from '../../packages/config/src/index.ts';
import { db } from '../../packages/db/src/index.ts';

test(
  '浏览器选择：默认 Chrome、Edge、Firefox 正式执行与冻结回归',
  { skip: !config.visionReady, timeout: 900000 },
  async () => {
    const client = new Client();
    await client.login();
    const fixture = await fixtureWebsite();
    let site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '多浏览器适配验收',
      baseUrl: fixture.origin,
    });
    const runs: string[] = [];
    try {
      assert.equal(site.config.browser, 'chrome');
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, browserName: 'safari' }, 400);
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '查询与清空' });
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '多浏览器商品查询',
        startPath: '/',
        steps: [
          { kind: 'input', text: '商品名称输入框', value: '旧值' },
          { kind: 'input', text: '商品名称输入框', value: '' },
          { kind: 'wait', text: '商品名称输入框为空，显示输入商品名称占位提示' },
          { kind: 'input', text: '商品名称输入框', value: '红茶' },
          { kind: 'act', text: '点击查询商品按钮' },
        ],
        assertions: ['搜索结果显示红茶'],
        cleanup: [{ kind: 'tap', text: '清空结果按钮' }],
      });
      for (const requested of [undefined, 'edge', 'firefox'] as const) {
        if (requested === 'edge') {
          site = await client.call(`/websites/${site.id}`, 'PATCH', { ...site, browserName: 'edge' });
          site = await client.call(`/websites/${site.id}`, 'PATCH', { ...site });
          assert.equal(site.config.browser, 'edge', 'omitted field preserves saved browser');
        }
        const input = {
          projectId: 'sample-project',
          environmentId: site.id,
          caseIds: [c.id],
          idempotencyKey: randomUUID(),
          ...(requested === 'firefox' ? { browserName: requested } : {}),
        };
        const submitted = await client.call('/case-runs', 'POST', input);
        runs.push(submitted.id);
        assert.equal((await client.call('/case-runs', 'POST', input)).id, submitted.id);
        await client.call(
          '/case-runs',
          'POST',
          { ...input, browserName: requested === 'firefox' ? 'edge' : 'firefox' },
          409,
        );
        const run = await client.finished(submitted.id);
        assert.equal(run.summary[0].result, 'PASS', JSON.stringify(run.summary));
        assert.equal(run.manifest.browser.name, requested ?? 'chrome');
        assert.equal(run.manifest.browser.engine, 'playwright');
        assert.equal(run.browserCleanup, 'CLOSED');
        assert.equal(run.cleanupStatus, 'CLEAN');
        assert.ok(run.evidence.some((e: any) => e.kind === 'midscene-report'));
        const ready = await db.runEvent.findFirstOrThrow({ where: { runId: run.id, kind: 'browser.ready' } });
        assert.equal((ready.payload as any).browserName, requested ?? 'chrome');
        if (requested === 'firefox') {
          const regression = await client.submit(run.task, { parentRunId: run.id });
          runs.push(regression.id);
          const done = await client.finished(regression.id);
          assert.equal(
            done.manifest.browser.name,
            'firefox',
            'regression preserves Firefox despite website default Edge',
          );
          assert.equal(done.summary[0].result, 'PASS', JSON.stringify(done.summary));
        }
      }
      await fs.writeFile(
        '.runtime/verification/browser-choice.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            engine: 'playwright',
            browsers: ['chrome', 'edge', 'firefox'],
            runs,
            result: 'PASS',
          },
          null,
          2,
        ),
      );
    } finally {
      for (const id of runs) {
        const run = await client.call(`/runs/${id}`);
        if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status)) {
          await client.call(`/runs/${id}/cancel`, 'POST');
          await client.finished(id);
        }
      }
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await fixture.close();
      await db.$disconnect();
    }
  },
);
