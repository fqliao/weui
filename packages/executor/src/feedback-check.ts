import { z } from 'zod';
import type { Locator, Page } from 'playwright';
import { hash } from '../../config/src/index.ts';
import { recordTarget, resolveTarget, targetSchema } from './static-target.ts';

export const feedbackSchema = z.object({
  kind: z.literal('form-feedback'),
  expected: z.string().min(1).max(4000),
  intent: z.object({ form: z.string(), message: z.string(), appearance: z.boolean() }),
  binding: z
    .object({
      url: z.string(),
      messageText: z.string(),
      fields: z.array(z.object({ target: targetSchema, type: z.string(), tag: z.string() })).min(1),
      appearance: z
        .object({
          colors: z.record(z.string(), z.string()),
          iconHash: z.string(),
          svgHash: z.string(),
        })
        .optional(),
    })
    .optional(),
});
export type FeedbackCheck = z.infer<typeof feedbackSchema>;

// Whole-sentence grammar, not keyword matching. Unsupported clauses keep the
// entire assertion on Midscene; never silently drop color/icon/relationship.
export function compileFeedback(text: string): FeedbackCheck | undefined {
  const complex =
    /^([\p{Script=Han}A-Za-z0-9 _-]{1,30}表单)(?:仍然|仍)?可见[，,]\s*显示红色警告\s+([^，,；;\n]+)[，,]\s*旁边有三角(?:形)?感叹号图标[。]?$/u.exec(
      text.trim(),
    );
  const simple = /^([\p{Script=Han}A-Za-z0-9 _-]{1,30}表单)显示\s+([^，,；;\n]+?)\s+错误提示[。]?$/u.exec(
    text.trim(),
  );
  const match = complex ?? simple;
  if (!match) return;
  return {
    kind: 'form-feedback',
    expected: text.trim(),
    intent: { form: match[1], message: match[2].trim(), appearance: Boolean(complex) },
  };
}

async function cssPath(locator: Locator) {
  return locator.evaluate((el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1)
      return '#' + CSS.escape(el.id);
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) return '';
      const index =
        Array.from(parent.children)
          .filter((n) => n.tagName === node!.tagName)
          .indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
    }
    return 'html > ' + parts.join(' > ');
  });
}

async function appearance(message: Locator) {
  const alert = message.locator('xpath=ancestor-or-self::*[@role="alert"][1]');
  if ((await alert.count()) !== 1 || !(await alert.isVisible())) return;
  const icons = await alert.locator('svg').all();
  const visible: Locator[] = [];
  for (const icon of icons) if (await icon.isVisible()) visible.push(icon);
  if (visible.length !== 1) return;
  const icon = visible[0];
  const a = await icon.boundingBox(),
    b = await message.boundingBox();
  if (!a || !b || a.width < 8 || a.height < 8 || a.width > 100 || a.height > 100) return;
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const gap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  if (overlap < Math.min(a.height, b.height) / 2 || gap > Math.max(40, b.height * 3)) return;
  const colors = await alert.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor,
      borderRightColor: s.borderRightColor,
      borderBottomColor: s.borderBottomColor,
      borderLeftColor: s.borderLeftColor,
    };
  });
  // Freeze only the small icon's observed rendering, never the whole page or
  // variable account value. A changed rendering needs live semantic judgment.
  const svg = await icon.evaluate((el) => ({ viewBox: el.getAttribute('viewBox'), geometry: el.innerHTML }));
  const image = await icon.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', timeout: 2000 });
  return { colors, svgHash: hash(svg), iconHash: hash(image.toString('base64')) };
}

export async function bindFeedback(page: Page, check: FeedbackCheck): Promise<FeedbackCheck | undefined> {
  const messages = page.getByText(check.intent.message, { exact: false });
  if ((await messages.count()) !== 1 || !(await messages.isVisible())) return;
  const messageText = (await messages.innerText()).replace(/\s+/g, ' ').trim();
  if (messageText.length > 600) return;
  const form = messages.locator('xpath=ancestor::form[1]');
  if ((await form.count()) !== 1 || !(await form.isVisible())) return;
  const fields: NonNullable<FeedbackCheck['binding']>['fields'] = [];
  for (const control of await form.locator('input:not([type="hidden"]),textarea,select').all()) {
    if (!(await control.isVisible())) continue;
    const recorded = await recordTarget(page, await cssPath(control));
    if (!recorded) return;
    fields.push({
      target: recorded.target,
      tag: recorded.guard.identity.tag,
      type: recorded.guard.identity.type,
    });
  }
  if (!fields.length) return;
  const look = check.intent.appearance ? await appearance(messages) : undefined;
  if (check.intent.appearance && !look) return;
  return {
    ...check,
    binding: { url: page.url(), messageText, fields, ...(look ? { appearance: look } : {}) },
  };
}

export async function probeFeedback(page: Page, check: FeedbackCheck) {
  const binding = check.binding;
  if (!binding) return { pass: false, unavailable: true, thought: '复合预期尚未形成完整静态验证记录' };
  if (page.url() !== binding.url)
    return { pass: false, unavailable: true, thought: '验证页面入口已变化，需要重新定位验证目标' };
  const message = page.getByText(binding.messageText, { exact: true });
  const count = await message.count();
  if (count === 0 || (count === 1 && !(await message.isVisible())))
    return { pass: false, thought: '当前页面没有显示用例要求的错误提示' };
  if (count !== 1)
    return { pass: false, unavailable: true, thought: '错误提示出现多个匹配，静态验证无法确定目标' };
  const form = message.locator('xpath=ancestor::form[1]');
  if ((await form.count()) !== 1)
    return { pass: false, unavailable: true, thought: '表单与提示区域的关联结构已变化' };
  if (!(await form.isVisible())) return { pass: false, thought: '用例要求可见的表单当前不可见' };
  const formHandle = await form.elementHandle();
  try {
    for (const field of binding.fields) {
      const target = resolveTarget(page, field.target);
      if ((await target.count()) !== 1)
        return { pass: false, unavailable: true, thought: '表单字段定位已变化，需要重新分析' };
      if (!(await target.isVisible())) return { pass: false, thought: '用例要求可见的表单字段当前不可见' };
      const identity = await target.evaluate(
        (el, f) => ({
          form: el.closest('form') === f,
          tag: el.tagName.toLowerCase(),
          type: el instanceof HTMLInputElement ? el.type : '',
        }),
        formHandle,
      );
      if (!identity.form || identity.tag !== field.tag || identity.type !== field.type)
        return { pass: false, unavailable: true, thought: '表单字段语义或所属表单已变化' };
    }
  } finally {
    await formHandle?.dispose();
  }
  if (check.intent.appearance) {
    const current = await appearance(message);
    if (!current || !binding.appearance || hash(current) !== hash(binding.appearance))
      return {
        pass: false,
        unavailable: true,
        thought: '警告颜色、图标形状或相邻关系发生变化，需要按原预期重新判断',
      };
  }
  return {
    pass: true,
    thought: check.intent.appearance
      ? '已静态核对错误文本、表单字段、警告颜色、图标图像及相邻关系'
      : '已静态核对错误文本与所属表单的可见性',
  };
}
