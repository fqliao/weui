import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEngine } from '../../packages/executor/src/launch.ts';
import { learnCheck, evaluateLearnedCheck } from '../../packages/executor/src/learned-check.ts';
import { templateCheck, restoreLearnedCheck } from '../../packages/executor/src/static-checks.ts';

test('learned proofs retain the full oracle, bind targets, recheck data and fall back on changes', async () => {
  const browser = await browserEngine();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent('<p id="result">提交完成-run-one</p>');
    let calls = 0;
    const expected = '页面显示提交完成-run-one';
    const query = async <T>(prompt: string): Promise<T> => {
      calls++;
      if (prompt.startsWith('独立审查')) return { equivalent: true, reason: '完整保留文本条件' } as T;
      return {
        supported: true,
        reason: '纯文本',
        clauses: [
          {
            source: expected,
            checks: [{ node: 0, kind: 'text', expected: '提交完成-run-one', match: 'equals' }],
          },
        ],
      } as T;
    };
    const learned = await learnCheck(page, expected, query);
    assert.ok(learned.check, learned.reason);
    assert.equal(calls, 2);
    assert.equal((await evaluateLearnedCheck(page, learned.check, 0)).pass, true);
    const saved = templateCheck(learned.check, { runId: 'run-one' });
    // Compiler interpretation changes retry refusals, while already learned v2
    // proofs must remain readable without paying for another model compilation.
    if (saved.kind !== 'learned-ui') throw new Error('missing learned proof');
    saved.compilerVersion = 2;
    await page.locator('#result').evaluate((el) => (el.textContent = '提交完成-run-two'));
    const restored = restoreLearnedCheck('页面显示提交完成-run-two', saved, { runId: 'run-two' });
    assert.equal(restored?.kind, 'learned-ui');
    if (restored?.kind !== 'learned-ui') throw new Error('missing proof');
    assert.equal((await evaluateLearnedCheck(page, restored, 0)).pass, true);
    assert.equal(restoreLearnedCheck('新的预期', saved, { runId: 'run-two' }), undefined);
    await page.locator('#result').evaluate((el) => (el.textContent = '提交失败'));
    const changed = await evaluateLearnedCheck(page, restored, 0);
    assert.equal(changed.pass, false);
    assert.equal(changed.unavailable, true);
    let unsupportedCalls = 0;
    const refused = await learnCheck(page, '页面显示红色三角图标', async <T>() => {
      unsupportedCalls++;
      return {} as T;
    });
    assert.equal(refused.check, undefined);
    assert.equal(unsupportedCalls, 0);
    const backend = await learnCheck(page, '登录后数据库密码校验正确且权限隔离有效', async <T>() => {
      unsupportedCalls++;
      return {} as T;
    });
    assert.equal(backend.check, undefined);
    assert.equal(unsupportedCalls, 0);
    await page.setContent('<p id="result">成功</p>');
    const partial = await learnCheck(
      page,
      '页面显示成功并且右上角显示机构',
      async <T>() =>
        ({
          supported: true,
          reason: 'ok',
          clauses: [{ source: '页面显示成功', checks: [{ node: 0, kind: 'visible' }] }],
        }) as T,
    );
    assert.equal(partial.check, undefined);
    assert.match(partial.reason, /完整覆盖/);
    let invalidProposals = 0;
    const invented = await learnCheck(page, '页面显示处理结果', async <T>() => {
      invalidProposals++;
      return {
        supported: true,
        reason: 'ok',
        clauses: [
          {
            source: '页面显示处理结果',
            checks: [{ node: 0, kind: 'text', expected: '成功', match: 'equals' }],
          },
        ],
      } as T;
    });
    assert.equal(invented.check, undefined);
    assert.match(invented.reason, /并非来自原始/);
    assert.equal(invalidProposals, 2, 'invalid proposal is repaired only once');
    assert.equal(invented.retryable, true);
    let proposals = 0,
      reviews = 0;
    const evidence = [{ phase: 'case', key: 'submit-operation', kind: 'tap', label: '提交处理' }];
    const corrected = await learnCheck(
      page,
      '页面显示处理结果',
      async <T>(prompt: string) => {
        assert.match(prompt, /submit-operation/);
        if (prompt.startsWith('独立审查')) {
          reviews++;
          return { equivalent: true, reason: '仅要求处理结果存在，身份由程序守卫' } as T;
        }
        proposals++;
        if (proposals === 2) assert.match(prompt, /上次编译未通过程序校验/);
        return {
          supported: true,
          reason: '检查处理结果存在',
          clauses: [
            {
              source: '页面显示处理结果',
              checks:
                proposals === 1
                  ? [{ node: 0, kind: 'text', expected: '成功', match: 'equals' }]
                  : [{ node: 0, kind: 'nonempty' }],
            },
          ],
        } as T;
      },
      { evidence },
    );
    assert.ok(corrected.check, corrected.reason);
    assert.equal(proposals, 2);
    assert.equal(reviews, 1, 'repaired definitions still require semantic review');
    assert.equal((await evaluateLearnedCheck(page, corrected.check, 0, evidence)).pass, true);
    assert.equal((await evaluateLearnedCheck(page, corrected.check, 0)).unavailable, true);
    assert.equal(
      (await evaluateLearnedCheck(page, corrected.check, 0, [{ ...evidence[0], kind: 'input' }])).unavailable,
      true,
    );
    let reviewed = 0;
    const rejected = await learnCheck(
      page,
      '页面显示成功',
      async <T>() =>
        (++reviewed === 1
          ? {
              supported: true,
              reason: 'ok',
              clauses: [
                {
                  source: '页面显示成功',
                  checks: [{ node: 0, kind: 'text', expected: '成功', match: 'equals' }],
                },
              ],
            }
          : { equivalent: false, reason: '语义遗漏' }) as T,
    );
    assert.equal(rejected.check, undefined);
    assert.equal(reviewed, 2);
    await page.setContent(
      '<label>订阅通知<input id="notify" type="checkbox" checked></label><button id="submit" disabled>提交任务</button>',
    );
    const states = await learnCheck(
      page,
      '订阅通知已勾选，提交任务按钮处于禁用状态',
      async <T>(prompt: string) =>
        (prompt.startsWith('独立审查')
          ? { equivalent: true, reason: 'ok' }
          : {
              supported: true,
              reason: 'ok',
              clauses: [
                { source: '订阅通知已勾选', checks: [{ node: 0, kind: 'checked', checked: true }] },
                { source: '提交任务按钮处于禁用状态', checks: [{ node: 1, kind: 'disabled' }] },
              ],
            }) as T,
    );
    assert.ok(states.check, states.reason);
    assert.equal((await evaluateLearnedCheck(page, states.check, 0)).pass, true);
  } finally {
    await browser.close();
  }
});
