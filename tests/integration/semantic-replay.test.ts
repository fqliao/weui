import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEngine } from '../../packages/executor/src/launch.ts';
import {
  recordCommand,
  replayCommands,
  type StaticCommand,
} from '../../packages/executor/src/static-replay.ts';
import { compileCheck, evaluateCheck } from '../../packages/executor/src/static-checks.ts';
import { checkTarget, toTemplate, bindTemplate } from '../../packages/executor/src/static-target.ts';

test(
  'semantic replay isolates runtime data, validates targets and expectations, and never repeats dispatched writes',
  { timeout: 120000 },
  async (t) => {
    const browser = await browserEngine();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const html = (id: string, note = '') =>
      `<style>body{padding:30px}input,button{display:block;margin:20px;padding:12px}</style>${note}<label>账号<input id="${id}" value="old-data"></label><button id="submit" onclick="window.submits=(window.submits||0)+1;document.getElementById('result').textContent='提交成功'">提交</button><p id="result">尚未提交</p>`;
    await page.setContent(html('generated-1'));
    const record = async (selector: string, kind: 'Input' | 'Tap') => {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box);
      const command = await recordCommand(
        page,
        kind,
        { value: 'old-run', locate: { center: [box.x + box.width / 2, box.y + box.height / 2] } },
        kind === 'Input',
        { runId: 'old-run' },
      );
      assert.ok(command);
      return command;
    };
    const input = await record('#generated-1', 'Input');
    const tap = await record('#submit', 'Tap');
    assert.equal(input.target?.by, 'label');
    assert.equal(tap.target?.by, 'role');
    let writes = 0;
    const beforeWrite = async () => {
      writes++;
    };
    await t.test('changed run data, generated ids and unrelated layout reuse operations', async () => {
      await page.setContent(html('generated-2', '<p>新版布局 / 时间已变化</p>'));
      assert.equal(await replayCommands(page, [input, tap], 'invalid-new-run', beforeWrite), true);
      assert.equal(await page.getByLabel('账号').inputValue(), 'invalid-new-run');
      assert.equal(await page.evaluate(() => (window as any).submits), 1);
      assert.equal(writes, 2);
    });
    await t.test('an invalid saved locator is a cache miss before any write', async () => {
      const result = await checkTarget(page, { by: 'css', value: '[invalid' }, tap.guard!, {}, 10);
      assert.equal(result.locator, null);
      assert.match(result.reason, /定位表达式/);
      assert.equal(writes, 2);
    });
    await t.test('ambiguous or changed targets reject before dispatch', async () => {
      await page.setContent(html('generated-3') + '<label>账号<input></label>');
      assert.match((await checkTarget(page, input.target!, input.guard!, {}, 10)).reason, /2 个/);
      await page.setContent(html('generated-3').replace('>提交</button>', '>删除</button>'));
      assert.equal((await checkTarget(page, tap.target!, tap.guard!, {}, 10)).locator, null);
      const changedTarget: StaticCommand = { ...tap, target: { by: 'css', value: '#submit' } };
      assert.match((await checkTarget(page, changedTarget.target!, tap.guard!, {}, 10)).reason, /语义/);
      assert.equal(writes, 2);
    });
    await t.test('partial multi-action failure never repeats the first click', async () => {
      await page.setContent(
        '<button id="a" onclick="window.countA=(window.countA||0)+1;document.getElementById(\'b\').textContent=\'已变化\'">第一步</button><button id="b">第二步</button>',
      );
      const a = await record('#a', 'Tap'),
        b = await record('#b', 'Tap');
      const start = writes;
      await assert.rejects(() => replayCommands(page, [a, b], undefined, beforeWrite), {
        code: 'CACHE_PARTIAL_REPLAY',
      });
      assert.equal(writes - start, 1);
      assert.equal(await page.evaluate(() => (window as any).countA), 1);
    });
    await t.test('input postcondition checks current value and does not retry a rejected value', async () => {
      await page.setContent(
        '<label>账号<input id="account" oninput="this.value=this.value.toUpperCase()"></label>',
      );
      const command = await record('#account', 'Input');
      const start = writes;
      await assert.rejects(() => replayCommands(page, [command], 'lowercase', beforeWrite), {
        code: 'CACHE_INPUT_POSTCONDITION',
      });
      assert.equal(writes - start, 1);
      assert.equal(await page.locator('#account').inputValue(), 'LOWERCASE');
    });
    await t.test('read-only expectations are re-evaluated, never inferred from a previous PASS', async () => {
      await page.setContent('<p>提交失败</p>');
      const check = compileCheck('文本可见：提交成功')!;
      assert.equal((await evaluateCheck(page, check, 10)).pass, false);
      await page.setContent('<p>提交成功</p>');
      assert.equal((await evaluateCheck(page, check, 10)).pass, true);
      assert.equal(compileCheck('红色警告和三角图标显示，登录表单仍可见'), undefined);
      assert.equal(compileCheck('没有错误提示'), undefined);
      await page.setContent('<p>提交成功</p><p>提交成功</p>');
      assert.equal((await evaluateCheck(page, check, 10)).pass, false);
      assert.equal((await evaluateCheck(page, compileCheck('文本不可见：提交成功')!, 10)).pass, false);
      assert.equal(
        (await evaluateCheck(page, compileCheck('页面URL等于：https://different.example/')!, 10)).pass,
        false,
      );
    });
    await t.test('URL guards and runtime templates preserve exact routing and values', async () => {
      await page.setContent(html('url-guard'));
      const command = await record('#url-guard', 'Input');
      const result = await checkTarget(
        page,
        command.target!,
        { ...command.guard!, url: 'https://different.example/' },
        {},
        10,
      );
      assert.match(result.reason, /URL/);
      assert.equal(toTemplate('invalid-unique-run', { runId: 'unique-run' }), 'invalid-{{runId}}');
      assert.equal(bindTemplate('invalid-{{runId}}', { runId: 'next-run' }), 'invalid-next-run');
    });
  },
);
