import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Client } from '../helpers.ts';
import { db } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import type { ExecutionMode } from '../../packages/contracts/src/execution-cache.ts';
import { artifactSchema } from '../../packages/executor/src/execution-cache.ts';
import { decryptSecret, encryptSecret } from '../../packages/websites/src/vault.ts';

test(
  'L2 → L1 → AI: cold/warm/forced modes, layout drift, failure baseline and canvas bypass',
  { skip: !config.visionReady, timeout: 900000 },
  async (t) => {
    let layout = 1,
      broken = false,
      writes = 0;
    const inputs: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.url === '/transient') {
        res.setHeader('content-type', 'text/html;charset=utf-8');
        res.end(
          `<!doctype html><meta charset="utf-8"><style>body{font:22px Arial;padding:60px}button{font:22px Arial;padding:12px;display:block;margin:20px}canvas{border:1px solid}</style><h1>画布流程验证</h1><button onclick="document.getElementById('drawing').hidden=false">显示画布</button><div id="drawing" hidden><canvas width="300" height="120"></canvas><button onclick="document.getElementById('drawing').remove();document.getElementById('result').textContent='画布已关闭，流程完成'">关闭画布</button></div><p id="result">流程未完成</p>`,
        );
        return;
      }
      if (req.method === 'POST') {
        writes++;
        let body = '';
        for await (const chunk of req) body += chunk;
        inputs.push(JSON.parse(body).value);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: broken ? '搜索结果：咖啡' : '搜索结果：红茶' }));
        return;
      }
      const canvas = req.url === '/canvas';
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        `<!doctype html><html><meta charset="utf-8"><title>缓存验收</title><style>body{font:20px Arial;padding:50px;background:white;color:#163e34}input,button{font:20px Arial;padding:12px;margin:14px 0;display:block}button{background:#147c62;color:white;border:0}#result{padding:20px;background:#e7f4ee}</style><body><h1>商品查询</h1>${layout === 2 ? '<p>新版商品查询页面</p>' : ''}${canvas ? '<canvas width="120" height="70"></canvas>' : ''}<label>商品名称<input id="query-${layout}" placeholder="输入商品名称"></label><button id="submit" onclick="fetch('/query',{method:'POST',body:JSON.stringify({value:document.querySelector('input').value})}).then(r=>r.json()).then(r=>document.getElementById('result').textContent=r.text)">查询商品</button><div id="result">尚未查询</div></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await db.$disconnect();
    });
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '三级执行缓存验收',
      baseUrl: origin,
    });
    const results: any[] = [];
    try {
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '查询缓存' });
      const content = {
        title: '缓存查询红茶',
        startPath: '/',
        steps: [
          { kind: 'input', text: '商品名称输入框', value: '红茶-{{runId}}' },
          { kind: 'tap', text: '查询商品按钮' },
        ],
        assertions: ['文本可见：搜索结果：红茶'],
      };
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', content);
      async function run(mode: ExecutionMode, caseId = c.id) {
        const before = writes;
        const started = await client.call('/case-runs', 'POST', {
          projectId: site.projectId,
          environmentId: site.id,
          caseIds: [caseId],
          browserName: 'chrome',
          executionMode: mode,
          idempotencyKey: randomUUID(),
        });
        const done = await client.finished(started.id);
        const r = done.summary[0];
        assert.equal(done.manifest.executionMode, mode);
        const entry = {
          id: done.id,
          mode,
          result: r.result,
          cause: r.cause,
          message: r.message,
          execution: r.execution,
          calls: done.usage.visionCalls,
          tokens: done.usage.inputTokens + done.usage.outputTokens,
          ms: Date.parse(done.finishedAt) - Date.parse(done.startedAt),
          writes: writes - before,
        };
        results.push(entry);
        console.log(JSON.stringify(entry));
        await fs.mkdir('.runtime/verification', { recursive: true });
        await fs.writeFile(
          '.runtime/verification/execution-cache.json',
          JSON.stringify({ siteId: site.id, caseId: c.id, results }, null, 2),
        );
        return entry;
      }
      const cold = await run('realtime');
      assert.equal(cold.result, 'PASS');
      assert.ok(cold.calls > 0);
      assert.equal(cold.execution.l2Hits, 0);
      assert.equal(cold.execution.l1Hits, 0);
      assert.equal(cold.execution.published, true);
      let status = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[c.id].l1, true);
      assert.equal(status[c.id].l2, true);
      const warm = await run('l2');
      assert.equal(warm.result, 'PASS');
      assert.equal(warm.calls, 0, 'Warm L2 must execute with zero model calls');
      assert.equal(warm.writes, 1);
      assert.equal(inputs.at(-1), `红茶-${warm.id}`);
      assert.notEqual(inputs[0], inputs[1], 'Dynamic inputs must not reuse the old run value');
      assert.equal(warm.execution.l2Hits, 3);
      const l1 = await run('l1');
      assert.equal(l1.result, 'PASS');
      assert.equal(l1.execution.l2Hits, 0);
      assert.ok(l1.execution.l1Hits >= 2);
      assert.ok(l1.calls < cold.calls);
      assert.equal(l1.execution.published, true);
      // Only mutate this test's encrypted cache: prove native XPath misses fall
      // through to the model and rebuild both layers without changing the oracle.
      const nativeRow = await db.executionCache.findUniqueOrThrow({ where: { id: l1.execution.key } });
      const nativeArtifact = artifactSchema.parse(
        decryptSecret(nativeRow.encryptedArtifact, `execution-cache:${nativeRow.id}`),
      );
      for (const channel of Object.values(nativeArtifact.channels))
        for (const native of Object.values(channel.nativeByOperation))
          for (const entry of native.caches as any[])
            if (entry.type === 'locate')
              entry.cache = { xpaths: ['//*[@id="invalidated-test-only-cache-target"]'] };
      await db.executionCache.update({
        where: { id: nativeRow.id },
        data: { encryptedArtifact: encryptSecret(nativeArtifact, `execution-cache:${nativeRow.id}`) },
      });
      const nativeMiss = await run('l1');
      assert.equal(nativeMiss.result, 'PASS');
      assert.ok(nativeMiss.calls > l1.calls);
      assert.ok(nativeMiss.execution.fallbacks > 0);
      assert.equal(nativeMiss.execution.published, true);
      const fresh = await run('realtime');
      assert.equal(fresh.result, 'PASS');
      assert.equal(fresh.execution.l1Hits, 0);
      assert.equal(fresh.execution.l2Hits, 0);
      assert.ok(fresh.calls > 0);
      layout = 2;
      const changed = await run('l2');
      assert.equal(changed.result, 'PASS');
      assert.equal(
        changed.execution.fallbacks,
        0,
        'Semantic labels survive unrelated layout/generated id changes',
      );
      assert.equal(changed.writes, 1);
      assert.equal(changed.execution.published, true);
      const rewarmed = await run('l2');
      assert.equal(rewarmed.result, 'PASS');
      assert.equal(rewarmed.calls, 0);
      const generation = await db.executionCache.findUniqueOrThrow({ where: { id: rewarmed.execution.key } });
      broken = true;
      const failed = await run('l2');
      assert.equal(failed.result, 'FAIL');
      assert.equal(failed.writes, 1);
      assert.equal(
        failed.calls,
        0,
        'An explicit failed assertion stays failed without AI rewriting the expectation',
      );
      assert.equal(failed.execution.published, false);
      assert.equal(
        (await db.executionCache.findUniqueOrThrow({ where: { id: generation.id } })).generation,
        generation.generation,
        'A failed result must never replace a PASS baseline',
      );
      broken = false;
      const naturalCase = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        ...content,
        title: '复杂自然语言预期每次实时验证',
        assertions: ['页面搜索结果包含红茶，并且不包含咖啡'],
      });
      const naturalCold = await run('realtime', naturalCase.id);
      assert.equal(naturalCold.result, 'PASS');
      status = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[naturalCase.id].partial, true);
      assert.equal(status[naturalCase.id].l2Ready, 2);
      broken = true;
      const naturalFailed = await run('l2', naturalCase.id);
      assert.equal(naturalFailed.result, 'FAIL');
      assert.equal(naturalFailed.execution.l2Hits, 2);
      assert.ok(
        naturalFailed.calls > 0,
        'Complex natural-language expectations still require live AI validation',
      );
      assert.equal(naturalFailed.execution.published, false);
      assert.equal(naturalFailed.writes, 1);
      broken = false;
      const canvasCase = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        ...content,
        title: 'Canvas 实时验证',
        startPath: '/canvas',
      });
      const canvas = await run('l2', canvasCase.id);
      assert.equal(canvas.result, 'PASS');
      assert.equal(canvas.execution.l2Hits, 0);
      assert.equal(canvas.execution.l1Hits, 0);
      assert.match(canvas.execution.bypassReason, /Canvas/);
      assert.equal(canvas.execution.published, false);
      const manual = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        ...content,
        title: '指定始终实时',
        cachePolicy: 'realtime',
      });
      const realtime = await run('l2', manual.id);
      assert.equal(realtime.result, 'PASS');
      assert.match(realtime.execution.bypassReason, /始终实时/);
      assert.equal(realtime.execution.published, false);
      const transientCase = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '单条自然语言步骤中进入并离开 Canvas',
        startPath: '/transient',
        steps: [{ kind: 'act', text: '先点击显示画布按钮，然后点击关闭画布按钮。' }],
        assertions: ['显示画布已关闭，流程完成'],
      });
      const transient = await run('l2', transientCase.id);
      assert.equal(transient.result, 'PASS');
      assert.match(transient.execution.bypassReason, /Canvas/);
      assert.equal(
        transient.execution.published,
        false,
        'Transient canvas inside one aiAct must disable cache publication',
      );
      status = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[manual.id].reason, '始终实时推理');
      const revised = await client.call(`/web-cases/${c.id}`, 'PATCH', {
        ...c.content,
        revision: c.revision,
        title: '更新后的查询用例',
      });
      assert.equal(revised.revision, 2);
      status = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[c.id].l1, false);
      assert.equal(status[c.id].l2, false);
      await fs.writeFile(
        '.runtime/verification/execution-cache.json',
        JSON.stringify(
          {
            passed: true,
            siteId: site.id,
            caseId: c.id,
            results,
            revisionInvalidation: true,
            failedBaselinePreserved: true,
          },
          null,
          2,
        ),
      );
    } finally {
      const current = await db.environment.findUniqueOrThrow({ where: { id: site.id } });
      await client.call(`/websites/${site.id}`, 'PATCH', {
        projectId: site.projectId,
        name: site.name,
        baseUrl: origin,
        enabled: false,
        revision: current.revision,
      });
    }
  },
);
