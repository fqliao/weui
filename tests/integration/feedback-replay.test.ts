import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEngine } from '../../packages/executor/src/launch.ts';
import {
  compileCheck,
  evaluateCheck,
  materializeCheck,
  restoreCheck,
  templateCheck,
} from '../../packages/executor/src/static-checks.ts';

test(
  'compound feedback replay preserves every clause and treats changed renderings as unavailable',
  { timeout: 120000 },
  async (t) => {
    const browser = await browserEngine();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const expectation =
      '登录表单仍然可见，显示红色警告 Incorrect Login Account or password，旁边有三角感叹号图标';
    const html = (
      value = 'old-run',
      color = '#fbd4d8',
      path = 'M12 2 1 21h22z M11 8h2v6h-2z M11 16h2v2h-2z',
    ) =>
      `<style>body{font:16px Arial;padding:40px}form{width:600px}div[role=alert]{display:flex;align-items:center;gap:10px;background:${color};color:#ce203a;padding:20px}svg{width:24px;height:24px;fill:currentColor}input{display:block;margin:10px}</style><form><label>Login Account<input value="${value}"></label><label>Password<input type=password></label><div role=alert><svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="${path}"></path></svg><span>Incorrect Login Account or password.</span></div></form>`;
    await page.setContent(html());
    const check = compileCheck(expectation)!;
    const bound = await materializeCheck(page, check);
    assert.ok(bound?.kind === 'form-feedback' && bound.binding?.appearance);
    assert.equal((await evaluateCheck(page, bound, 10)).pass, true);

    await t.test('changed account data and unrelated content do not invalidate the check', async () => {
      await page.setContent(html('new-run') + '<p> unrelated changing clock 17:31 </p>');
      assert.equal((await evaluateCheck(page, bound, 10)).pass, true);
    });
    await t.test('missing expected message remains a business failure', async () => {
      await page
        .getByText('Incorrect Login Account or password.', { exact: true })
        .evaluate((el) => (el.textContent = 'Login successful'));
      const result = await evaluateCheck(page, bound, 10);
      assert.equal(result.pass, false);
      assert.ok(!result.unavailable);
    });
    await t.test(
      'color, icon geometry, hidden icon and relative position require original live oracle',
      async () => {
        await page.setContent(html('new-run', '#c2ffd0'));
        assert.equal((await evaluateCheck(page, bound, 10)).unavailable, true);
        await page.setContent(html('new-run', '#fbd4d8', 'M0 0h24v24H0z'));
        assert.equal((await evaluateCheck(page, bound, 10)).unavailable, true);
        await page.setContent(html());
        await page.locator('svg').evaluate((el) => (el.style.opacity = '0'));
        assert.equal((await evaluateCheck(page, bound, 10)).unavailable, true);
        await page.setContent(html());
        await page.locator('svg').evaluate((el) => (el.style.transform = 'translateY(100px)'));
        assert.equal((await evaluateCheck(page, bound, 10)).unavailable, true);
      },
    );
    await t.test('unsupported clauses and ambiguous form fields never produce a partial oracle', async () => {
      assert.equal(compileCheck(expectation + '，并显示余额为100元'), undefined);
      assert.equal(compileCheck('登录表单可见，显示绿色成功提示 Success，旁边有三角感叹号图标'), undefined);
      await page.setContent(html() + '<label>Login Account<input></label>');
      assert.equal((await evaluateCheck(page, bound, 10)).unavailable, true);
      await page.setContent(html().replace('<form>', '<div>').replace('</form>', '</div>'));
      assert.equal(await materializeCheck(page, check), undefined);
    });
    await t.test(
      'restoration requires the current immutable expectation and supports run templates',
      async () => {
        await page.setContent(html());
        const templated = templateCheck(bound, { runId: 'old-run' });
        assert.ok(restoreCheck(check, templated, { runId: 'new-run' }));
        assert.equal(
          restoreCheck(compileCheck(expectation.replace('password', 'username'))!, templated, {}),
          undefined,
        );
        assert.equal(restoreCheck(check, check, {}), undefined);
        const wait = compileCheck('登录表单显示 Incorrect Login Account or password 错误提示')!;
        const waitBound = await materializeCheck(page, wait);
        assert.ok(waitBound);
        assert.equal((await evaluateCheck(page, waitBound, 10)).pass, true);
      },
    );
  },
);
