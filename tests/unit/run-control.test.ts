import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRunControl } from '../../packages/service/src/run-control.ts';
function trace() {
  return {
    run: {
      id: 'r',
      status: 'COMPLETED',
      cleanupStatus: 'NOT_CONFIGURED',
      manifest: {
        environment: { adapter: 'midscene-web-v1' },
        codeVersion: 'mvp-0.2.0',
        toolVersions: { 'midscene.ui': '1.0.0' },
        plan: { cases: [{ id: 'c' }] },
      },
      summary: [{ caseId: 'c', result: 'INCONCLUSIVE' }],
    },
    actions: [
      {
        id: 'a',
        tool: 'midscene.ui',
        status: 'UNKNOWN_OUTCOME',
        input: { write: true },
        output: null,
        finishedAt: new Date(),
      },
    ],
    events: [
      { kind: 'action.started', payload: { actionId: 'a' } },
      { kind: 'action.error', payload: { actionId: 'a' } },
      { kind: 'midscene.action', payload: { caseId: 'c', message: '登录 UI 操作' } },
      { kind: 'case.completed', payload: { caseId: 'c' } },
      { kind: 'finished', payload: {} },
    ] as { kind: string; payload: Record<string, unknown> }[],
  };
}
test('完整历史记录证明只执行登录时，可自动解除误判', () => {
  const t = trace();
  const r = assessRunControl(t.run, t.actions, t.events);
  assert.equal(r.retry.allowed, true);
  assert.equal(r.retry.noBusinessActions, true);
  assert.equal(t.actions[0].status, 'UNKNOWN_OUTCOME');
});
test('实际业务动作或成功的早期写入不能被会话关闭掩盖', () => {
  const t = trace();
  t.events.push(
    { kind: 'midscene.action', payload: { caseId: 'c', message: 'Midscene UI 操作' } },
    { kind: 'browser.closed', payload: {} },
  );
  const r = assessRunControl(t.run, t.actions, t.events);
  assert.equal(r.retry.allowed, false);
  assert.equal(r.browserCleanup, 'CLOSED');
});
test('缺失终态事件、动作回执或版本不明时不自动放行', () => {
  for (const kind of ['finished', 'action.error', 'case.completed']) {
    const t = trace();
    assert.equal(
      assessRunControl(
        t.run,
        t.actions,
        t.events.filter((e) => e.kind !== kind),
      ).retry.allowed,
      false,
    );
  }
  const t = trace();
  t.run.manifest.codeVersion = 'unknown';
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
});
test('业务清理失败、资源回收失败和未完成动作继续阻止重跑', () => {
  const t = trace();
  t.run.cleanupStatus = 'FAILED';
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
  t.run.cleanupStatus = 'NOT_CONFIGURED';
  t.events.push({ kind: 'browser.cleanup.failed', payload: {} });
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
  t.events.pop();
  t.actions[0].status = 'STARTED';
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
});
test('新记录中的只读等待不算业务写入，但真正的写入仍受保护', () => {
  const t = trace();
  t.events.push({ kind: 'midscene.action', payload: { caseId: 'c', phase: 'case', write: false } });
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, true);
  t.events.push({ kind: 'midscene.action', payload: { caseId: 'c', phase: 'case', write: true } });
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
});

test('按所选用例检查，不把同批次未知动作传播到未执行用例', () => {
  const base = trace();
  const t = { ...base, actions: base.actions.map((a) => ({ ...a, caseId: 'c' })) };
  t.run.manifest.plan.cases.push({ id: 'unexecuted' });
  t.run.summary.push({ caseId: 'unexecuted', result: 'SKIPPED' });
  t.events.push({ kind: 'midscene.action', payload: { caseId: 'c', phase: 'case', write: true } });
  assert.equal(assessRunControl(t.run, t.actions, t.events).retry.allowed, false);
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'c').retry.allowed, false);
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'unexecuted').retry.allowed, true);
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'missing').retry.allowed, false);
  t.run.cleanupStatus = 'FAILED';
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'unexecuted').retry.allowed, false);
});

test('仅认证被预算中断的用例可单独重跑，全批次重跑继续检查未知动作', () => {
  const base = trace();
  const t = { ...base, actions: base.actions.map((a) => ({ ...a, caseId: 'c' })) };
  t.run.manifest.plan.cases.push({ id: 'auth' });
  t.run.summary.push({ caseId: 'auth', result: 'BLOCKED' });
  t.events.push({ kind: 'midscene.action', payload: { caseId: 'c', phase: 'case', write: true } });
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'auth').retry.allowed, true);
  t.run.status = 'RUNNING';
  assert.equal(assessRunControl(t.run, t.actions, t.events, 'auth').retry.allowed, false);
});
