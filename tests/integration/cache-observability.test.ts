import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Client } from '../helpers.ts';
import { db } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import type { CacheDetail } from '../../packages/contracts/src/execution-cache.ts';

test(
  'cache inspectors save both tiers with diffs, reject stale/protected edits, and persist isolated per-case metrics',
  { skip: !config.visionReady, timeout: 600000 },
  async (t) => {
    const server = createServer((q, r) => {
      r.setHeader('content-type', 'text/html;charset=utf-8');
      r.end(
        '<!doctype html><html><meta charset="utf-8"><style>body{font:22px Arial;padding:50px}input,button{display:block;font:22px Arial;padding:12px;margin:16px}#result{padding:20px}</style><h1>缓存检查验收</h1><label>商品名称<input id="query"></label><button id="search" onclick="document.getElementById(\'result\').textContent=\'查询结果：红茶\'">查询</button><p id="result">尚未查询</p></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.$disconnect();
    });
    const c = new Client();
    await c.login();
    const site = await c.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '缓存详情与趋势验收',
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    });
    const runs: any[] = [];
    try {
      const f = await c.call(`/websites/${site.id}/features`, 'POST', { name: '缓存可观测性' });
      const input = {
        title: '查询红茶缓存验收',
        startPath: '/',
        steps: [
          { kind: 'input', text: '商品名称输入框', value: '红茶' },
          { kind: 'tap', text: '查询按钮' },
        ],
        assertions: ['文本可见：查询结果：红茶'],
      };
      const a = await c.call(`/web-features/${f.id}/cases`, 'POST', input);
      const b = await c.call(`/web-features/${f.id}/cases`, 'POST', { ...input, title: '独立计量验收' });
      const run = async (mode: string, caseIds = [a.id]) => {
        const created = await c.call('/case-runs', 'POST', {
          projectId: site.projectId,
          environmentId: site.id,
          caseIds,
          browserName: 'chrome',
          executionMode: mode,
          idempotencyKey: randomUUID(),
        });
        const done = await c.finished(created.id);
        assert.ok(
          done.summary.every((r: any) => r.result === 'PASS'),
          JSON.stringify(done.summary),
        );
        assert.equal(
          done.summary.reduce((n: number, r: any) => n + r.metrics.inputTokens + r.metrics.outputTokens, 0),
          done.usage.inputTokens + done.usage.outputTokens,
        );
        assert.ok(
          Math.abs(
            done.summary.reduce((n: number, r: any) => n + r.metrics.costCny, 0) - done.usage.costCny,
          ) < 1e-10,
        );
        runs.push({
          id: done.id,
          mode,
          summary: done.summary.map((r: any) => ({
            caseId: r.caseId,
            result: r.result,
            metrics: r.metrics,
            execution: { ...r.execution, changes: r.execution.changes?.length },
          })),
        });
        console.log(JSON.stringify(runs.at(-1)));
        return done;
      };
      const cold = await run('realtime');
      const key = cold.summary[0].execution.key;
      let detail = (await c.call(`/execution-caches/${key}`)) as CacheDetail;
      assert.ok(detail.l1[0].fields.length > 0);
      assert.ok(detail.revisions[0].changes.length > 0);
      const field = detail.l1[0].fields.find((f) => f.path.includes('xpaths'))!;
      assert.ok(field);
      const edited = (await c.call(`/execution-caches/${key}`, 'PATCH', {
        generation: detail.generation,
        tier: 'L1',
        edits: [{ path: field.path, value: `(${field.value})[1]` }],
      })) as CacheDetail;
      assert.equal(edited.edited, true);
      assert.equal(edited.generation, detail.generation + 1);
      assert.equal(edited.revisions[0].source, 'manual');
      assert.ok(
        edited.revisions[0].changes.some(
          (v) => v.before === field.value && v.after === `(${field.value})[1]`,
        ),
      );
      await c.call(
        `/execution-caches/${key}`,
        'PATCH',
        { generation: detail.generation, tier: 'L1', edits: [{ path: field.path, value: field.value }] },
        409,
      );
      await c.call(
        `/execution-caches/${key}`,
        'PATCH',
        {
          generation: edited.generation,
          tier: 'L2',
          edits: [{ path: 'case.operations.2.passed', value: 'true' }],
        },
        400,
      );
      await run('l1');
      detail = await c.call(`/execution-caches/${key}`);
      assert.equal(detail.edited, false);
      const css = detail.l2[0].fields[0];
      const updated = (await c.call(`/execution-caches/${key}`, 'PATCH', {
        generation: detail.generation,
        tier: 'L2',
        edits: [{ path: css.path, value: 'input#query' }],
      })) as CacheDetail;
      assert.equal(updated.l2[0].fields[0].value, 'input#query');
      const verified = await run('l2');
      assert.ok(verified.summary[0].execution.l2Hits > 0);
      assert.ok(verified.usage.visionCalls > 0, 'Manually edited cache must revalidate assertions');
      const warm = await run('l2');
      assert.equal(warm.usage.visionCalls, 0);
      assert.equal(warm.summary[0].metrics.costCny, 0);
      assert.equal(warm.summary[0].execution.changes.length, 0);
      const batch = await run('l2', [a.id, b.id]);
      assert.equal(batch.summary[0].metrics.costCny, 0);
      assert.ok(batch.summary[1].metrics.costCny > 0);
      const history = await c.call(`/web-cases/${a.id}/history?browserName=chrome`);
      assert.equal(history.items.length, 5);
      assert.ok(history.items.every((r: any) => r.source === 'measured'));
      assert.equal(history.items[0].runId, batch.id);
      const otherHistory = await c.call(`/web-cases/${b.id}/history`);
      assert.equal(otherHistory.items.length, 1);
      const firefox = await c.call(`/web-cases/${a.id}/history?browserName=firefox`);
      assert.equal(firefox.items.length, 0);
      const status = await c.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[a.id].id, key);
      assert.ok(status[a.id].changedAt);
      const foreign = await db.project.create({
        data: { name: '缓存权限验收', description: 'isolated test' },
      });
      const foreignEnv = await db.environment.create({
        data: {
          projectId: foreign.id,
          name: '隔离网站',
          baseUrl: site.baseUrl,
          adapter: 'midscene-web-v1',
          credentialRef: '',
          config: {},
        },
      });
      const foreignKey = randomUUID();
      try {
        await db.executionCache.create({
          data: {
            id: foreignKey,
            projectId: foreign.id,
            environmentId: foreignEnv.id,
            caseId: a.id,
            caseRevision: 1,
            encryptedArtifact: 'not-readable',
            sourceRunId: cold.id,
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        await c.call(`/execution-caches/${foreignKey}`, 'GET', undefined, 403);
        await c.call(
          `/execution-caches/${foreignKey}`,
          'PATCH',
          { generation: 1, tier: 'L2', edits: [{ path: css.path, value: '#query' }] },
          403,
        );
      } finally {
        await db.executionCache.deleteMany({ where: { id: foreignKey } });
        await db.environment.delete({ where: { id: foreignEnv.id } });
        await db.project.delete({ where: { id: foreign.id } });
      }
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/cache-observability.json',
        JSON.stringify(
          {
            siteId: site.id,
            caseId: a.id,
            cacheId: key,
            runs,
            historyCount: history.items.length,
            checks:
              'both tiers edited, stale/protected/cross-project writes rejected, exact changes, isolated CNY metrics, warm zero tokens',
          },
          null,
          2,
        ),
      );
    } finally {
      await c.call(`/websites/${site.id}`, 'PATCH', {
        projectId: site.projectId,
        name: site.name,
        baseUrl: site.baseUrl,
        revision: site.revision,
        enabled: false,
      });
    }
  },
);
