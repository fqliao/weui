import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPlan, planTask } from '../../packages/agent/src/index.ts';
import { CASES, RULES } from '../../packages/knowledge/src/catalog.ts';
import { verifyCase, type Observation } from '../../packages/assertions/src/index.ts';
import { validateSkill } from '../../packages/service/src/index.ts';
import { redactTraceValue } from '../../packages/executor/src/index.ts';
import { hash, config } from '../../packages/config/src/index.ts';
import { passwordHash, checkPassword } from '../../packages/auth/src/index.ts';
const selection = {
  summary: '测试计划',
  cases: [{ caseId: 'C01', reason: '用户要求' }],
  missingRequirements: [],
};
const allowed = CASES.map((c) => c.id),
  rules = RULES.map((r) => r.id);
const record = {
  id: 'r1',
  namespace: 'test-scope',
  status: 'PENDING',
  amount: 100,
  applicant: 'applicant',
  reviewer: null,
  submitCount: 1,
  tenant: 'A',
  title: 'test',
};
test('计划只能选择已注册用例，不能改写业务预期', () => {
  const p = canonicalPlan(
    { ...selection, cases: [{ ...selection.cases[0], expected: '伪造通过' } as any] },
    'deepagents',
    allowed,
    rules,
  );
  assert.equal(p.cases[0].expected, CASES[0].expected);
  assert.throws(() =>
    canonicalPlan({ ...selection, cases: [{ caseId: 'X99', reason: '伪造' }] }, 'deepagents', allowed, rules),
  );
});
test('未知、重复、缺少规则、Skill 越界的计划被拒绝', () => {
  assert.throws(() =>
    canonicalPlan(
      { ...selection, cases: [...selection.cases, ...selection.cases] },
      'catalog',
      allowed,
      rules,
    ),
  );
  assert.throws(() => canonicalPlan(selection, 'catalog', ['C02'], rules));
  assert.throws(() => canonicalPlan(selection, 'catalog', allowed, []));
});
test('目录模式明确无 LLM，按显式 ID 选择', async () => {
  const r = await planTask(
    '请检查 C11 重复提交',
    'catalog',
    { rules: RULES, pages: [] },
    null,
    new AbortController().signal,
  );
  assert.equal(r.usage.modelCalls, 0);
  assert.deepEqual(
    r.plan.cases.map((c) => c.id),
    ['C11'],
  );
});
test('成功提示不能掩盖未持久化记录', () => {
  const a = verifyCase('C01', { records: [], audit: [] }, { message: '保存成功', visibleRecords: 1 });
  assert.ok(a.some((x) => !x.passed));
});
test('越权审批与重复提交分别由持久化断言识别', () => {
  const a = verifyCase(
    'C09',
    {
      records: [{ ...record, status: 'APPROVED' }],
      audit: [{ recordId: 'r1', action: 'approve', actor: 'applicant', namespace: record.namespace }],
    },
    { message: '成功', visibleRecords: 1 },
  );
  assert.ok(a.filter((x) => !x.passed).length >= 2);
  const b = verifyCase(
    'C11',
    { records: [{ ...record, submitCount: 2 }], audit: [] },
    { message: '提交成功', visibleRecords: 1 },
  );
  assert.equal(b.find((x) => x.id === 'record.submitCount')?.passed, false);
});
test('每条断言 ID 与规则依赖都包含在对应场景声明中', () => {
  for (const c of CASES) {
    const actual = verifyCase(c.id, { records: [record], audit: [] }, { message: '无权', visibleRecords: 0 });
    for (const a of actual) {
      assert.ok(c.ruleIds.includes(a.ruleId), `${c.id} missing ${a.ruleId}`);
      assert.ok(c.assertionIds.includes(a.id), `${c.id} missing ${a.id}`);
    }
  }
});
test('Skill 不能引入任意工具、遗漏独立断言或规则', () => {
  const d = {
    name: '我的方法',
    description: '检查合法保存',
    instructions: '读取固定业务规则，然后执行浏览器动作，核对独立业务结果。',
    caseIds: ['C01'],
    ruleIds: rules,
    toolIds: [
      'knowledge.search',
      'browser.run_case',
      'business.query',
      'fixture.prepare',
      'fixture.cleanup',
      'assertions.verify',
    ],
    inputSchema: { goal: 'string' },
    outputSchema: { cases: 'CaseResult[]' },
  };
  assert.equal(validateSkill(d).caseIds[0], 'C01');
  assert.throws(() => validateSkill({ ...d, toolIds: [...d.toolIds, 'shell.exec'] }));
  assert.throws(() => validateSkill({ ...d, ruleIds: ['R01'] }));
  assert.throws(() => validateSkill({ ...d, toolIds: ['browser.run_case'] }));
});
test('Trace 脱敏保留长快照且清除凭证', () => {
  const value = {
    headers: [
      { name: 'Cookie', value: 'secret' },
      { name: 'Authorization', value: 'Bearer secret' },
    ],
    snapshot: 'x'.repeat(8000),
    message: config.SAMPLE_SERVICE_KEY,
  };
  const out = redactTraceValue(value) as typeof value;
  assert.equal(out.snapshot.length, 8000);
  assert.equal(out.message, '[REDACTED]');
  assert.ok(!JSON.stringify(out.headers).includes('secret'));
});
test('哈希不依赖对象属性顺序，内容变化可检测', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.notEqual(hash({ a: 1 }), hash({ a: 2 }));
});
test('密码使用随机盐并严格比对', () => {
  const first = passwordHash('a-secure-password');
  assert.notEqual(first, passwordHash('a-secure-password'));
  assert.ok(checkPassword('a-secure-password', first));
  assert.equal(checkPassword('wrong-password', first), false);
});
