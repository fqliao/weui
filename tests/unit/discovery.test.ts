import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNavigation, validateCandidates } from '../../packages/discovery/src/policy.ts';
import { Convergence, validateBaseline } from '../../packages/discovery/src/convergence.ts';
const origin = 'http://127.0.0.1:5189';
test('按阶段验证基线：主链路须通过，禁止跳级和未知结果', () => {
  const previous = { phase: 'MAIN', environmentId: 'site' };
  const run = {
    status: 'COMPLETED',
    cleanupStatus: 'CLEAN',
    manifest: { environmentId: 'site', plan: { cases: [{ id: 'published' }] } },
    summary: [{ caseId: 'published', result: 'PASS' }],
  };
  assert.doesNotThrow(() => validateBaseline('BOUNDARY', previous, 'site', ['published'], run));
  assert.throws(() => validateBaseline('DIVERGENT', previous, 'site', ['published'], run));
  assert.throws(() => validateBaseline('BOUNDARY', previous, 'site', ['unpublished'], run));
  for (const result of ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'SKIPPED'])
    assert.throws(() =>
      validateBaseline('BOUNDARY', previous, 'site', ['published'], {
        ...run,
        summary: [{ caseId: 'published', result }],
      }),
    );
  assert.doesNotThrow(() =>
    validateBaseline('DIVERGENT', { ...previous, phase: 'BOUNDARY' }, 'site', ['published'], {
      ...run,
      summary: [{ caseId: 'published', result: 'FAIL' }],
    }),
  );
  assert.throws(() =>
    validateBaseline('DIVERGENT', { ...previous, phase: 'BOUNDARY' }, 'site', ['published'], {
      ...run,
      cleanupStatus: 'FAILED',
    }),
  );
});
test('操作与路径双层收敛：重复操作拒绝、相似页面不增加覆盖、新路径提高优先级', () => {
  const tracker = new Convergence(),
    page = { url: origin + '/orders', title: '订单', controls: ['预览', '帮助'] };
  assert.equal(tracker.observe(page), true);
  tracker.before({ from: page.url, target: origin + '/preview', text: '打开预览' });
  assert.equal(tracker.observe(page), false);
  assert.match(tracker.history[0].outcome, /重复/);
  assert.throws(() => tracker.before({ from: page.url, target: origin + '/preview', text: '再次打开预览' }));
  const choices = tracker.rank([{ url: origin + '/orders' }, { url: origin + '/help' }]);
  assert.equal(choices[0].url, origin + '/help');
  assert.ok(choices[0].priority > choices[0].novelty);
  assert.equal(tracker.observe({ ...page, url: origin + '/help', title: '帮助' }), true);
});
test('探索导航不能提交、删除、退出或跳出网站范围', () => {
  assert.equal(safeNavigation('商品目录', '/products', origin, [origin]), origin + '/products');
  for (const [text, href] of [
    ['删除商品', '/products'],
    ['商品', '/delete?id=1'],
    ['退出', '/logout'],
    ['帮助', 'http://example.org'],
    ['商品', 'javascript:alert(1)'],
  ])
    assert.throws(() => safeNavigation(text, href, origin, [origin]));
});
test('草稿来源须是已观察页面和真实需求，模型不能选择身份或直接发布', () => {
  const obs = [
    {
      id: 'P1',
      url: origin + '/',
      title: '商店',
      description: '商品目录',
      controls: [],
      evidenceIds: ['screenshot'],
    },
  ];
  const draft = {
    featureName: '商品目录',
    description: '',
    basis: 'requirement',
    requirementRefs: [1],
    observationIds: ['P1'],
    reviewQuestions: [],
    test: {
      title: '展示商品',
      startPath: origin + '/',
      sessionId: 'model-selected-secret',
      steps: [],
      assertions: ['显示商品目录'],
      enabled: true,
    },
  };
  const raw = { summary: '已观察', gaps: [], candidates: [draft] };
  const output = validateCandidates(raw, obs, '展示商品目录', 'approved-session');
  assert.equal(output.candidates[0].test.sessionId, 'approved-session');
  assert.equal(output.candidates[0].test.enabled, false);
  for (const change of [
    { requirementRefs: [9] },
    { observationIds: ['invented'] },
    { test: { ...draft.test, startPath: origin + '/unseen' } },
    { requirementRefs: [] },
  ])
    assert.throws(() =>
      validateCandidates({ ...raw, candidates: [{ ...draft, ...change }] }, obs, '展示商品目录', null),
    );
});
