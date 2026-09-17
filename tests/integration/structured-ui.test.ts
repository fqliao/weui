import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEngine } from '../../packages/executor/src/launch.ts';
import {
  commandForTarget,
  replayCommands,
  type StaticCommand,
} from '../../packages/executor/src/static-replay.ts';
import { evaluateCondition } from '../../packages/executor/src/structured-check.ts';
import type { UiTarget } from '../../packages/contracts/src/static-ui.ts';
test(
  'structured UI controls and assertions execute deterministically without a model',
  { timeout: 120000 },
  async (t) => {
    const browser = await browserEngine();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const html = `<style>body{font:18px Arial;padding:30px}input,textarea,select,button,[contenteditable]{margin:12px;padding:8px}label{display:block}</style><label>姓名<input></label><label>日期<input type=date></label><label>数量<input type=number></label><label>说明<textarea></textarea></label><div contenteditable=true role=textbox aria-label=富文本>原文</div><label>国家<select aria-label=国家><option value=cn>中国</option><option value=uk>英国</option></select></label><label>同意<input type=checkbox checked onchange="window.changes=(window.changes||0)+1"></label><label>大号<input type=radio name=size></label><button role=switch aria-label=通知 aria-checked=false onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')">通知</button><button aria-label=帮助 onmouseenter="document.getElementById('help').hidden=false">帮助</button><p id=help hidden>帮助已展开</p><label>搜索<input onkeydown="if(event.key==='Enter'){document.getElementById('result').textContent=this.value}"></label><p id=result>尚未搜索</p><button role=combobox aria-label=部门 aria-haspopup=listbox aria-expanded=false onclick="this.setAttribute('aria-expanded','true');document.getElementById('options').hidden=false">选择部门</button><div id=options role=listbox hidden><div role=option onclick="document.querySelector('[role=combobox]').textContent=this.textContent;document.getElementById('options').hidden=true;document.querySelector('[role=combobox]').setAttribute('aria-expanded','false')">研发部</div></div>`;
    await page.setContent(html);
    let writes = 0;
    const label = (value: string): UiTarget => ({ by: 'label', value });
    async function execute(
      kind: StaticCommand['kind'],
      target: UiTarget,
      value?: string,
      options: Partial<StaticCommand> = {},
    ) {
      const c = await commandForTarget(page, kind, target, { runtimeInput: true, ...options });
      assert.ok(c);
      assert.equal(
        await replayCommands(page, [c], value, async () => {
          writes++;
        }),
        true,
      );
      return c;
    }
    await t.test('text, number, date, textarea and rich text use current values', async () => {
      for (const [name, value] of [
        ['姓名', '张三-run2'],
        ['日期', '2026-09-16'],
        ['数量', '12'],
        ['说明', '多行\n说明'],
        ['富文本', '新的正文'],
      ]) {
        const c = await execute('Input', label(name), value);
        assert.equal(
          (await evaluateCondition(page, { kind: 'value', target: label(name), expected: value }, 50)).pass,
          true,
        );
        if (name === '富文本')
          assert.equal(
            await replayCommands(page, [c], '再次改变', async () => {
              writes++;
            }),
            true,
          );
      }
      await execute('Input', label('姓名'), '');
      assert.equal(await page.getByLabel('姓名', { exact: true }).inputValue(), '');
    });
    await t.test('native select and ARIA combobox select by explicit option', async () => {
      await execute('Select', label('国家'), '英国', { selectBy: 'label' });
      assert.equal(await page.getByLabel('国家').inputValue(), 'uk');
      await execute('Select', label('国家'), 'cn', { selectBy: 'value' });
      await execute('Select', { by: 'role', role: 'combobox', value: '部门' }, '研发部', {
        selectBy: 'label',
      });
      assert.equal(await page.getByRole('combobox', { name: '部门' }).innerText(), '研发部');
    });
    await t.test('set checked is idempotent; radio and ARIA switches preserve state', async () => {
      const start = writes;
      await execute('SetChecked', label('同意'), undefined, { checked: true });
      assert.equal(writes, start);
      await execute('SetChecked', label('同意'), undefined, { checked: false });
      assert.equal(await page.getByLabel('同意').isChecked(), false);
      await execute('SetChecked', label('大号'), undefined, { checked: true });
      await execute('SetChecked', { by: 'role', role: 'switch', value: '通知' }, undefined, {
        checked: true,
      });
      assert.equal(
        (
          await evaluateCondition(
            page,
            { kind: 'checked', target: { by: 'role', role: 'switch', value: '通知' }, checked: true },
            50,
          )
        ).pass,
        true,
      );
    });
    await t.test('hover and target-scoped Enter produce the requested UI behavior', async () => {
      await execute('Hover', { by: 'role', role: 'button', value: '帮助' });
      assert.equal(
        (await evaluateCondition(page, { kind: 'visible', target: { by: 'text', value: '帮助已展开' } }, 50))
          .pass,
        true,
      );
      await execute('Input', label('搜索'), '红茶');
      await execute('Press', label('搜索'), undefined, { key: 'Enter' });
      assert.equal(
        (
          await evaluateCondition(
            page,
            { kind: 'text', target: { by: 'css', value: '#result' }, match: 'equals', expected: '红茶' },
            50,
          )
        ).pass,
        true,
      );
    });
    await t.test(
      'wait retries delayed content and checks AND/OR, count, hidden, disabled and URL',
      async () => {
        await page.evaluate(() =>
          setTimeout(() => (document.getElementById('result')!.textContent = '延迟完成'), 300),
        );
        assert.equal(
          (
            await evaluateCondition(
              page,
              {
                kind: 'all',
                conditions: [
                  {
                    kind: 'text',
                    target: { by: 'css', value: '#result' },
                    match: 'contains',
                    expected: '延迟完成',
                  },
                  { kind: 'count', target: { by: 'css', value: 'select option' }, count: 2 },
                ],
              },
              1500,
            )
          ).pass,
          true,
        );
        assert.equal(
          (
            await evaluateCondition(
              page,
              {
                kind: 'any',
                conditions: [
                  { kind: 'visible', target: { by: 'text', value: '不存在' } },
                  { kind: 'url', match: 'equals', expected: 'about:blank' },
                ],
              },
              50,
            )
          ).pass,
          true,
        );
        assert.equal(
          (await evaluateCondition(page, { kind: 'hidden', target: { by: 'css', value: '#options' } }, 50))
            .pass,
          true,
        );
        await page.getByLabel('数量').evaluate((el) => el.setAttribute('disabled', ''));
        assert.equal(
          (await evaluateCondition(page, { kind: 'disabled', target: label('数量') }, 50)).pass,
          true,
        );
        assert.equal(
          (await evaluateCondition(page, { kind: 'enabled', target: label('数量') }, 50)).pass,
          false,
        );
      },
    );
    await t.test(
      'wrong states fail; duplicate/disabled options never dispatch; partial popup failure never restarts',
      async () => {
        assert.equal(
          (await evaluateCondition(page, { kind: 'value', target: label('国家'), expected: 'wrong' }, 50))
            .pass,
          false,
        );
        const c = await commandForTarget(page, 'Select', label('国家'), {
          runtimeInput: true,
          selectBy: 'label',
        });
        assert.ok(c);
        await page
          .getByLabel('国家')
          .evaluate((el) => el.insertAdjacentHTML('beforeend', '<option value=duplicate>中国</option>'));
        const start = writes;
        assert.equal(
          await replayCommands(page, [c], '中国', async () => {
            writes++;
          }),
          false,
        );
        assert.equal(writes, start);
        const combo = await commandForTarget(
          page,
          'Select',
          { by: 'role', role: 'combobox', value: '部门' },
          { runtimeInput: true, selectBy: 'label' },
        );
        assert.ok(combo);
        await assert.rejects(
          () =>
            replayCommands(page, [combo], '缺失选项', async () => {
              writes++;
            }),
          { code: 'CACHE_PARTIAL_REPLAY' },
        );
        assert.equal(writes, start + 1);
      },
    );
  },
);
