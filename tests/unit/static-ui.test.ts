import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreCheck, templateCheck, type StaticCheck } from '../../packages/executor/src/static-checks.ts';
import { webCaseSchema } from '../../packages/contracts/src/browser.ts';
import { expandParameters, mapStrings, describeCondition } from '../../packages/contracts/src/static-ui.ts';
import { caseCapabilities } from '../../packages/contracts/src/static-capability.ts';
const target = { by: 'label' as const, value: '姓名' };
test('parameters are literal, declared, snapshotted and reject missing or recursive references', () => {
  assert.equal(
    expandParameters('{{data.name}}/{{runId}}/{{caseId}}', 'r2', 'c', { name: '测试-{{runId}}' }),
    '测试-r2/r2/c',
  );
  assert.equal(expandParameters('{{data.name}}', 'r', 'c', { name: 'a"`$()\\值' }), 'a"`$()\\值');
  assert.throws(() => expandParameters('{{data.missing}}', 'r', 'c'), /未定义/);
  const c = {
    title: '参数输入',
    parameters: { name: '测试-{{runId}}' },
    steps: [{ kind: 'input', text: '姓名', value: '{{data.name}}', target }],
    assertions: [{ kind: 'structured', condition: { kind: 'value', target, expected: '{{data.name}}' } }],
  };
  assert.ok(webCaseSchema.safeParse(c).success);
  assert.equal(webCaseSchema.safeParse({ ...c, parameters: {} }).success, false);
  assert.equal(
    webCaseSchema.safeParse({ ...c, parameters: { name: '{{data.other}}', other: 'x' } }).success,
    false,
  );
  const actual = mapStrings(c.steps, (v) => expandParameters(v, 'r3', 'c', c.parameters));
  assert.equal(actual[0].value, '测试-r3');
  assert.equal(c.steps[0].value, '{{data.name}}');
});
test('bounded conditions and controls reject script injection, unknown keys and unbounded waits', () => {
  const base = {
    title: '条件验证',
    steps: [],
    assertions: [
      {
        kind: 'structured',
        condition: {
          kind: 'all',
          conditions: [
            { kind: 'visible', target },
            { kind: 'count', target, count: 1 },
          ],
        },
      },
    ],
  };
  assert.ok(webCaseSchema.safeParse(base).success);
  for (const condition of [
    { kind: 'evaluate', script: 'return true' },
    { kind: 'count', target, count: -1 },
    { kind: 'visible', target: { by: 'role', value: 'x' } },
  ])
    assert.equal(
      webCaseSchema.safeParse({ ...base, assertions: [{ kind: 'structured', condition }] }).success,
      false,
    );
  assert.equal(
    webCaseSchema.safeParse({ ...base, steps: [{ kind: 'press', text: '快捷键', key: 'Control+O' }] })
      .success,
    false,
  );
  assert.equal(
    webCaseSchema.safeParse({ ...base, steps: [{ kind: 'wait', text: '等待', timeoutMs: 100000 }] }).success,
    false,
  );
});
test('structured cache restores reordered JSON fields and current runtime data without changing the oracle', () => {
  const old: StaticCheck = {
    kind: 'structured',
    expected: 'result 等于 run-one',
    condition: {
      kind: 'text',
      target: { by: 'css', value: '#result' },
      expected: 'run-one',
      match: 'equals',
    },
  };
  const saved = templateCheck(old, { runId: 'run-one' });
  const current: StaticCheck = {
    kind: 'structured',
    expected: 'result 等于 run-two',
    condition: {
      kind: 'text',
      match: 'equals',
      expected: 'run-two',
      target: { value: '#result', by: 'css' },
    },
  };
  assert.deepEqual(restoreCheck(current, saved, { runId: 'run-two' }), current);
  assert.equal(
    restoreCheck(
      {
        ...current,
        condition: {
          kind: 'text',
          target: { by: 'css', value: '#result' },
          expected: 'run-two',
          match: 'contains',
        },
      },
      saved,
      {
        runId: 'run-two',
      },
    ),
    undefined,
  );
});

test('capability preview preserves operation names and distinguishes definitions from AI-dependent steps', () => {
  const c = webCaseSchema.parse({
    title: '能力预览',
    steps: [
      { kind: 'select', text: '选择国家', value: '中国', target },
      { kind: 'hover', text: '帮助菜单' },
    ],
    assertions: [{ kind: 'structured', condition: { kind: 'visible', target } }, '页面符合设计要求'],
  });
  const caps = caseCapabilities(c);
  assert.deepEqual(
    caps.map((c) => c.level),
    ['static', 'learn', 'static', 'ai'],
  );
  assert.match(caps[0].title, /选择国家/);
  assert.match(describeCondition({ kind: 'value', target, expected: '{{data.name}}' }), /data.name/);
});
