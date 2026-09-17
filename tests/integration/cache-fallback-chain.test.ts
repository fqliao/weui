import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Client } from '../helpers.ts';
import { db } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { artifactSchema } from '../../packages/executor/src/cache-artifact.ts';
import { decryptSecret, encryptSecret } from '../../packages/websites/src/vault.ts';

test(
  'full static feedback, L2 to L1, L2 to L1 to AI, and failed oracle preservation',
  { skip: !config.visionReady, timeout: 600000 },
  async (t) => {
    let writes = 0,
      broken = false;
    const inputs: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        inputs.push(JSON.parse(body).value);
        writes++;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            color: broken ? '#008800' : '#cf1f38',
            background: broken ? '#c2ffd0' : '#fbd4d8',
          }),
        );
        return;
      }
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        `<!doctype html><meta charset=utf-8><style>body{font:20px Arial;padding:50px;background:white}form{width:700px}input,button{display:block;margin:16px 0;padding:14px;font:20px Arial}#feedback{display:flex;align-items:center;gap:12px;background:#fbd4d8;color:#cf1f38;padding:20px}#feedback[hidden]{display:none}svg{width:28px;height:28px;fill:currentColor}</style><h1>登录</h1><form onsubmit="event.preventDefault();fetch('/login',{method:'POST',body:JSON.stringify({value:document.querySelector('input').value})}).then(r=>r.json()).then(r=>{document.getElementById('feedback').hidden=false;document.getElementById('feedback').style.color=r.color;document.getElementById('feedback').style.backgroundColor=r.background})"><label>Login Account<input></label><label>Password<input type=password></label><button>Login</button><div role=alert id=feedback hidden><svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2 1 21h22z M11 8h2v6h-2z M11 16h2v2h-2z"></path></svg><span>Incorrect Login Account or password.</span></div></form>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.$disconnect();
    });
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const client = new Client();
    await client.login();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '完整静态与逐级回退验收',
      baseUrl: origin,
    });
    const results: any[] = [];
    try {
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '登录反馈缓存' });
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '错误账号复合反馈',
        startPath: '/',
        steps: [
          { kind: 'input', text: 'Login Account 输入框', value: 'invalid-{{runId}}' },
          { kind: 'input', text: 'Password 输入框', value: 'invalid-test-only' },
          { kind: 'tap', text: 'Login 登录按钮' },
          { kind: 'wait', text: '登录表单显示 Incorrect Login Account or password 错误提示' },
        ],
        assertions: [
          '登录表单仍然可见，显示红色警告 Incorrect Login Account or password，旁边有三角感叹号图标',
        ],
      });
      async function run(label: string, mode = 'l2') {
        const before = writes;
        const started = await client.call('/case-runs', 'POST', {
          projectId: site.projectId,
          environmentId: site.id,
          caseIds: [c.id],
          browserName: 'chrome',
          executionMode: mode,
          idempotencyKey: randomUUID(),
        });
        const done = await client.finished(started.id),
          summary = done.summary[0];
        const events = await db.runEvent.findMany({
          where: { runId: done.id, kind: 'cache.route' },
          orderBy: { seq: 'asc' },
          select: { payload: true },
        });
        const result = {
          label,
          id: done.id,
          result: summary.result,
          execution: summary.execution,
          metrics: summary.metrics,
          routes: events.map((e) => e.payload as any),
          writes: writes - before,
        };
        results.push(result);
        console.log(
          JSON.stringify({
            ...result,
            routes: result.routes.map((r) => `${r.operation}:${r.tier}:${r.outcome}`),
            execution: { ...result.execution, changes: result.execution?.changes?.length },
          }),
        );
        await fs.writeFile(
          '.runtime/verification/cache-fallback-chain.json',
          JSON.stringify({ siteId: site.id, caseId: c.id, results }, null, 2),
        );
        assert.equal(result.writes, 1, 'A fallback must never repeat the login submission');
        assert.equal(inputs.at(-1), `invalid-${done.id}`);
        return result;
      }
      const cold = await run('实时生成', 'realtime');
      assert.equal(cold.result, 'PASS');
      const warm = await run('完整二级');
      assert.equal(warm.result, 'PASS');
      assert.equal(warm.metrics.modelCalls, 0);
      assert.equal(warm.execution.l2Hits, 5);
      const status = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(status[c.id].partial, false);

      async function breakCaches(native: boolean) {
        const row = await db.executionCache.findUniqueOrThrow({ where: { id: cold.execution.key } });
        const artifact = artifactSchema.parse(
          decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`),
        );
        const channel = Object.values(artifact.channels).find((c) => c.operations.length === 5)!;
        const op = channel.operations[0];
        op.commands[0].target = { by: 'css', value: '#invalid-test-only-l2' };
        if (native) {
          const entries = channel.nativeByOperation[op.key].caches as any[];
          assert.ok(entries.some((e) => e.type === 'locate'));
          for (const entry of entries)
            if (entry.type === 'locate') entry.cache = { xpaths: ['//*[@id="invalid-test-only-l1"]'] };
        }
        await db.executionCache.update({
          where: { id: row.id },
          data: { encryptedArtifact: encryptSecret(artifact, `execution-cache:${row.id}`) },
        });
      }
      await breakCaches(false);
      const l1 = await run('二级失效，一级命中');
      assert.equal(l1.result, 'PASS');
      assert.equal(l1.metrics.modelCalls, 0);
      assert.equal(l1.execution.l1Hits, 1);
      assert.equal(l1.execution.l2Hits, 4);
      assert.deepEqual(
        l1.routes.filter((r) => r.operation === 1).map((r) => `${r.tier}:${r.outcome}`),
        ['L2:fallback', 'L1:miss', 'L1:hit'],
      );
      await breakCaches(true);
      const ai = await run('二级和一级失效，实时重定位');
      assert.equal(ai.result, 'PASS');
      assert.ok(ai.metrics.modelCalls > 0);
      assert.deepEqual(
        ai.routes.filter((r) => r.operation === 1).map((r) => `${r.tier}:${r.outcome}`),
        ['L2:fallback', 'L1:miss', 'L1:fallback', 'AI:hit'],
      );
      const recovered = await run('回退后恢复完整二级');
      assert.equal(recovered.result, 'PASS');
      assert.equal(recovered.metrics.modelCalls, 0);
      assert.equal(recovered.execution.l2Hits, 5);
      const prior = await db.executionCache.findUniqueOrThrow({ where: { id: cold.execution.key } });
      broken = true;
      const fail = await run('警告颜色错误，原始断言失败');
      assert.equal(fail.result, 'FAIL');
      assert.ok(fail.metrics.modelCalls > 0);
      assert.equal(fail.execution.published, false);
      assert.deepEqual(
        fail.routes.filter((r) => r.operation === 5).map((r) => `${r.tier}:${r.outcome}`),
        ['L2:fallback', 'L1:miss', 'AI:hit'],
      );
      const after = await db.executionCache.findUniqueOrThrow({ where: { id: prior.id } });
      assert.equal(after.encryptedArtifact, prior.encryptedArtifact);
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
