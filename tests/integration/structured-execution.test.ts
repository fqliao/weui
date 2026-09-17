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
import type { UiTarget } from '../../packages/contracts/src/static-ui.ts';

test(
  'structured cases run cold and warm with zero tokens, with current data and bounded AI fallback',
  { skip: !config.visionReady, timeout: 600000 },
  async (t) => {
    let broken = false;
    const submissions: any[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) text += chunk;
        const value = JSON.parse(text);
        submissions.push(value);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'Ready', result: broken ? '错误结果' : value.name }));
        return;
      }
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        `<!doctype html><meta charset=utf-8><title>静态能力验收</title><style>body{font:20px Arial;padding:30px;background:white}label{display:block;margin:12px}input,select,button{font:20px Arial;padding:10px}#help[hidden],#options[hidden]{display:none}</style><h1>静态能力验收</h1><label>测试名称<input id=name></label><label>国家<select aria-label=国家 id=country><option value=cn>中国</option><option value=uk>英国</option></select></label><label>订阅通知<input type=checkbox id=subscribe checked></label><button aria-label=查看帮助 onmouseenter="document.getElementById('help').hidden=false">查看帮助</button><p id=help hidden>帮助已显示</p><button aria-label=部门 role=combobox aria-haspopup=listbox aria-expanded=false onclick="this.setAttribute('aria-expanded','true');document.getElementById('options').hidden=false">选择部门</button><div id=options hidden role=listbox><div role=option onclick="document.querySelector('[role=combobox]').textContent=this.textContent;document.querySelector('[role=combobox]').setAttribute('aria-expanded','false');document.getElementById('options').hidden=true">研发部</div></div><label>确认框<input onkeydown="if(event.key==='Enter'){fetch('/submit',{method:'POST',body:JSON.stringify({name:document.getElementById('name').value,country:document.getElementById('country').value,subscribe:document.getElementById('subscribe').checked})}).then(r=>r.json()).then(r=>{document.getElementById('status').textContent=r.status;document.getElementById('result').textContent=r.result})}"></label><p id=status>Pending</p><p id=result>尚未提交</p>`,
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
      name: '结构化静态能力验收',
      baseUrl: origin,
    });
    const results: any[] = [];
    const label = (value: string): UiTarget => ({ by: 'label', value });
    const role = (value: string, role: UiTarget['role'] = 'button'): UiTarget => ({
      by: 'role',
      role,
      value,
    });
    const css = (value: string): UiTarget => ({ by: 'css', value });
    try {
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', {
        name: '常见控件与参数断言',
      });
      const definition = {
        title: '控件参数与结构化断言',
        startPath: '/?case={{caseId}}',
        parameters: { name: '回归-{{runId}}', country: 'uk' },
        steps: [
          { kind: 'input', text: '填写测试名称', target: label('测试名称'), value: '{{data.name}}' },
          {
            kind: 'select',
            text: '选择国家',
            target: label('国家'),
            value: '{{data.country}}',
            selectBy: 'value',
          },
          { kind: 'check', text: '取消订阅通知', target: label('订阅通知'), checked: false },
          { kind: 'check', text: '再次确认取消订阅', target: label('订阅通知'), checked: false },
          { kind: 'hover', text: '显示帮助', target: role('查看帮助') },
          {
            kind: 'select',
            text: '选择部门',
            target: role('部门', 'combobox'),
            value: '研发部',
            selectBy: 'label',
          },
          { kind: 'press', text: '回车提交验收', target: label('确认框'), key: 'Enter' },
          {
            kind: 'wait',
            text: '等待处理完成',
            condition: { kind: 'text', target: css('#status'), expected: 'Ready', match: 'equals' },
            timeoutMs: 3000,
          },
        ],
        assertions: [
          {
            kind: 'structured',
            condition: { kind: 'text', target: css('#result'), expected: '{{data.name}}', match: 'equals' },
            timeoutMs: 500,
          },
          {
            kind: 'structured',
            condition: {
              kind: 'all',
              conditions: [
                { kind: 'value', target: label('国家'), expected: 'uk' },
                { kind: 'checked', target: label('订阅通知'), checked: false },
                { kind: 'visible', target: css('#help') },
              ],
            },
            timeoutMs: 500,
          },
          { kind: 'structured', condition: { kind: 'url', expected: 'case={{caseId}}', match: 'contains' } },
        ],
        cleanup: [{ kind: 'check', text: '恢复订阅控件', target: label('订阅通知'), checked: true }],
      };
      const c = await client.call(`/web-features/${feature.id}/cases`, 'POST', definition);
      const invalid = await client.call(
        `/web-features/${feature.id}/cases`,
        'POST',
        { ...definition, title: '拒绝缺少参数', parameters: {} },
        400,
      );
      assert.match(JSON.stringify(invalid), /参数/);
      assert.equal(submissions.length, 0);
      async function run(caseId: string, label: string, mode = 'l2') {
        const before = submissions.length;
        const started = await client.call('/case-runs', 'POST', {
          projectId: site.projectId,
          environmentId: site.id,
          caseIds: [caseId],
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
          caseId,
          result: summary.result,
          message: summary.message,
          execution: summary.execution,
          metrics: summary.metrics,
          routes: events.map((e) => e.payload as any),
          submissions: submissions.length - before,
        };
        results.push(result);
        await fs.mkdir('.runtime/verification', { recursive: true });
        await fs.writeFile(
          '.runtime/verification/structured-execution.json',
          JSON.stringify({ siteId: site.id, caseId: c.id, results }, null, 2),
        );
        console.log(
          JSON.stringify({
            ...result,
            routes: result.routes.map((r) => `${r.operation}:${r.tier}:${r.outcome}`),
            execution: { ...result.execution, changes: result.execution?.changes?.length },
          }),
        );
        return result;
      }
      for (const label of ['首次按结构化配置静态执行', '动态参数二次静态回放']) {
        const result = await run(c.id, label);
        assert.equal(result.result, 'PASS');
        assert.equal(result.metrics.modelCalls, 0);
        assert.equal(result.metrics.inputTokens + result.metrics.outputTokens, 0);
        assert.equal(result.execution.l2Hits, 11);
        assert.equal(result.submissions, 1);
        assert.deepEqual(submissions.at(-1), { name: `回归-${result.id}`, country: 'uk', subscribe: false });
      }
      const cacheStatus = await client.call(`/websites/${site.id}/cache-status?browserName=chrome`);
      assert.equal(cacheStatus[c.id].partial, false);
      assert.equal(cacheStatus[c.id].operations.length, 11);
      const beforeFailure = await db.executionCache.findUniqueOrThrow({
        where: { id: results[0].execution.key },
      });
      broken = true;
      const fail = await run(c.id, '业务结果变错，保持原始断言');
      assert.equal(fail.result, 'FAIL');
      assert.equal(fail.metrics.modelCalls, 0);
      assert.equal(fail.execution.published, false);
      assert.equal(fail.submissions, 1);
      assert.equal(
        (await db.executionCache.findUniqueOrThrow({ where: { id: beforeFailure.id } })).encryptedArtifact,
        beforeFailure.encryptedArtifact,
      );
      broken = false;

      const mixed = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: 'AI 定位后沉淀下拉与勾选',
        startPath: '/',
        steps: [
          { kind: 'select', text: '国家下拉框', selectBy: 'label', value: '英国' },
          { kind: 'check', text: '订阅通知复选框', checked: false },
        ],
        assertions: [
          {
            kind: 'structured',
            condition: {
              kind: 'all',
              conditions: [
                { kind: 'value', target: label('国家'), expected: 'uk' },
                { kind: 'checked', target: label('订阅通知'), checked: false },
              ],
            },
          },
        ],
      });
      const cold = await run(mixed.id, '无定位步骤通过 AI 学习');
      assert.equal(cold.result, 'PASS');
      assert.ok(cold.metrics.modelCalls > 0);
      assert.equal(cold.execution.aiOperations, 2);
      const warm = await run(mixed.id, '学习后完整静态执行');
      assert.equal(warm.result, 'PASS');
      assert.equal(warm.metrics.modelCalls, 0);
      assert.equal(warm.execution.l2Hits, 3);
      async function breakCache(native: boolean) {
        const row = await db.executionCache.findUniqueOrThrow({ where: { id: cold.execution.key } });
        const artifact = artifactSchema.parse(
          decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`),
        );
        const channel = Object.values(artifact.channels).find((v) => v.operations.length === 3)!;
        const op = channel.operations[0];
        op.commands[0].target = { by: 'css', value: '#missing-test-only' };
        if (native) {
          const entries = channel.nativeByOperation[op.key].caches as any[];
          assert.ok(entries.some((e) => e.type === 'locate'));
          for (const e of entries)
            if (e.type === 'locate') e.cache = { xpaths: ['//*[@id="missing-test-only-l1"]'] };
        }
        await db.executionCache.update({
          where: { id: row.id },
          data: { encryptedArtifact: encryptSecret(artifact, `execution-cache:${row.id}`) },
        });
      }
      await breakCache(false);
      const l1 = await run(mixed.id, '二级失效先回退一级');
      assert.equal(l1.result, 'PASS');
      assert.equal(l1.metrics.modelCalls, 0);
      assert.equal(l1.execution.l1Hits, 1);
      assert.deepEqual(
        l1.routes.filter((r) => r.operation === 1).map((r) => `${r.tier}:${r.outcome}`),
        ['L2:fallback', 'L1:miss', 'L1:hit'],
      );
      await breakCache(true);
      const ai = await run(mixed.id, '一级也失效后实时定位');
      assert.equal(ai.result, 'PASS');
      assert.ok(ai.metrics.modelCalls > 0);
      assert.deepEqual(
        ai.routes.filter((r) => r.operation === 1).map((r) => `${r.tier}:${r.outcome}`),
        ['L2:fallback', 'L1:miss', 'L1:fallback', 'AI:hit'],
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
