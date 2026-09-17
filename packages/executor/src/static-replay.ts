import type { Page } from 'playwright';
import { z } from 'zod';
import { hash, AppError } from '../../config/src/index.ts';
import { keySchema } from '../../contracts/src/static-ui.ts';
import {
  guardSchema,
  targetSchema,
  recordTarget,
  checkTarget,
  bindTemplate,
  toTemplate,
  resolveTarget,
  type StaticTarget,
  type RuntimeBindings,
} from './static-target.ts';

export const fingerprintSchema = z.object({ url: z.string(), image: z.string(), dom: z.string() });
export type Fingerprint = z.infer<typeof fingerprintSchema>;
export const commandSchema = z.object({
  kind: z.enum(['Tap', 'Input', 'Select', 'SetChecked', 'Hover', 'Press']),
  selectBy: z.enum(['label', 'value']).optional(),
  checked: z.boolean().optional(),
  key: keySchema.optional(),
  selector: z.string().max(4000),
  value: z.string().max(4000).optional(),
  runtimeInput: z.boolean().optional(),
  valueTemplate: z.string().max(4000).optional(),
  target: targetSchema.optional(),
  guard: guardSchema.optional(),
  before: fingerprintSchema,
});
export type StaticCommand = z.infer<typeof commandSchema>;
export async function uncacheablePageReason(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    if (visible.some((el) => el.tagName === 'CANVAS')) return '页面包含 Canvas / WebGL，使用实时视觉推理';
    if (visible.some((el) => el.tagName === 'IFRAME')) return '页面包含 iframe，使用实时视觉推理';
    if (visible.some((el) => el.tagName.includes('-') && !el.shadowRoot))
      return '页面包含不可读取内部结构的自定义元素，使用实时视觉推理';
    if (
      visible
        .filter((el) => el.tagName.toLowerCase() === 'svg')
        .some(
          (el) =>
            el.querySelector('animate,animateTransform,animateMotion') ||
            (el.getBoundingClientRect().width > 160 && el.getBoundingClientRect().height > 100),
        )
    )
      return '页面包含动态或大型 SVG 图形，使用实时视觉推理';
    return null;
  });
}
export async function fingerprint(page: Page): Promise<Fingerprint> {
  const dom = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    return visible.map((el) => ({
      tag: el.tagName,
      id: el.id,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
      text: Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(''),
      value:
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
          ? el.value
          : undefined,
      checked: el instanceof HTMLInputElement ? el.checked : undefined,
      disabled: el.getAttribute('disabled'),
      expanded: el.getAttribute('aria-expanded'),
      href: el.getAttribute('href'),
    }));
  });
  const image = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  return { url: page.url(), image: hash(image.toString('base64')), dom: hash(dom) };
}
export async function recordCommand(
  page: Page,
  name: string,
  param: any,
  runtimeInput: boolean,
  bindings: RuntimeBindings = {},
): Promise<StaticCommand | null> {
  if (!['Input', 'Tap'].includes(name) || !Array.isArray(param?.locate?.center)) return null;
  const selector = await page.evaluate(
    ([x, y]) => {
      let el = document.elementFromPoint(x, y);
      if (!el || el.closest('iframe')) return null;
      // elementFromPoint returns an open-shadow host rather than the inner target.
      // Replaying a click/fill on the host would not reproduce the native action.
      if (el.shadowRoot) return null;
      el =
        el.closest(
          'input,textarea,button,a,select,[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[contenteditable="true"]',
        ) || el;
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1)
        return '#' + CSS.escape(el.id);
      const parts: string[] = [];
      while (el && el !== document.documentElement) {
        const tag = el.tagName.toLowerCase();
        const parent: HTMLElement | null = el.parentElement;
        if (!parent) return null;
        parts.unshift(
          `${tag}:nth-of-type(${
            Array.from(parent.children)
              .filter((n) => n.tagName === el!.tagName)
              .indexOf(el) + 1
          })`,
        );
        el = parent;
      }
      return 'html > ' + parts.join(' > ');
    },
    param.locate.center as [number, number],
  );
  if (!selector) return null;
  const semantic = await recordTarget(page, selector, bindings);
  if (!semantic) return null;
  if (
    name === 'Input' &&
    !['input', 'textarea'].includes(semantic.guard.identity.tag) &&
    !semantic.guard.identity.editable
  )
    return null;
  // Unsupported input modes stay with Midscene; do not approximate their semantics.
  if (name === 'Input' && param.mode && !['replace', 'clear'].includes(param.mode)) return null;
  return {
    kind: name as StaticCommand['kind'],
    selector,
    ...semantic,
    before: await fingerprint(page),
    ...(name === 'Input'
      ? runtimeInput
        ? { runtimeInput: true }
        : { valueTemplate: toTemplate(String(param.value ?? ''), bindings) }
      : {}),
  };
}
// Compile only bounded commands from a unique element, never arbitrary JS.
export async function commandForTarget(
  page: Page,
  kind: StaticCommand['kind'],
  target: StaticTarget,
  options: Partial<StaticCommand> = {},
  bindings: RuntimeBindings = {},
) {
  const element = resolveTarget(page, target);
  if ((await element.count()) !== 1) return null;
  const selector = await element.evaluate((el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1)
      return '#' + CSS.escape(el.id);
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) return '';
      parts.unshift(
        `${node.tagName.toLowerCase()}:nth-of-type(${
          Array.from(parent.children)
            .filter((n) => n.tagName === node!.tagName)
            .indexOf(node) + 1
        })`,
      );
      node = parent;
    }
    return 'html > ' + parts.join(' > ');
  });
  const semantic = await recordTarget(page, selector, bindings);
  if (!semantic) return null;
  return commandSchema.parse({ ...options, kind, selector, ...semantic, before: await fingerprint(page) });
}
export async function commandAtPoint(
  page: Page,
  kind: StaticCommand['kind'],
  center: [number, number],
  options: Partial<StaticCommand> = {},
  bindings: RuntimeBindings = {},
) {
  const located = await recordCommand(page, 'Tap', { locate: { center } }, false, bindings);
  return located ? commandSchema.parse({ ...located, ...options, kind }) : null;
}
export async function replayCommands(
  page: Page,
  commands: StaticCommand[],
  input: string | undefined,
  beforeWrite: () => Promise<void>,
  onMiss?: (reason: string) => void,
  bindings: RuntimeBindings = {},
) {
  let completed = 0;
  for (const command of commands) {
    // Old screenshot-only artifacts are readable but must never execute under
    // the new policy. A fresh successful run records semantic guards.
    const checked =
      command.target && command.guard
        ? await checkTarget(page, command.target, command.guard, bindings)
        : { locator: null, reason: '旧缓存缺少目标语义校验，需要重新生成' };
    if (!checked.locator) {
      onMiss?.(checked.reason);
      if (completed)
        throw new AppError(
          'CACHE_PARTIAL_REPLAY',
          '静态脚本已执行部分操作，后续页面发生变化。停止自动回放，避免重复提交；请核对本次结果。',
        );
      return false;
    }
    const target = checked.locator;
    const value = command.runtimeInput
      ? input
      : command.valueTemplate !== undefined
        ? bindTemplate(command.valueTemplate, bindings)
        : command.value;
    if (['Input', 'Select'].includes(command.kind) && value === undefined)
      throw new AppError('CACHE_INPUT', '静态输入缺少当前运行参数');
    if (command.kind === 'Input' && !(await target.isEditable())) {
      onMiss?.('输入目标不可编辑');
      if (completed) throw new AppError('CACHE_PARTIAL_REPLAY', '部分操作已执行，后续输入目标不可编辑');
      return false;
    }
    const control = await target.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el instanceof HTMLInputElement ? el.type : '',
      role: el.getAttribute('role'),
      popup: el.getAttribute('aria-haspopup'),
      expanded: el.getAttribute('aria-expanded'),
      checked:
        el instanceof HTMLInputElement
          ? el.checked
          : el.getAttribute('aria-checked') === 'true'
            ? true
            : el.getAttribute('aria-checked') === 'false'
              ? false
              : null,
      options:
        el instanceof HTMLSelectElement
          ? Array.from(el.options).map((o) => ({
              label: o.label,
              value: o.value,
              disabled:
                o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
            }))
          : [],
    }));
    let reason = '';
    const customSelect =
      control.tag !== 'select' &&
      (control.role === 'combobox' || control.popup === 'listbox') &&
      command.selectBy !== 'value';
    if (
      command.kind === 'Select' &&
      !customSelect &&
      (control.tag !== 'select' ||
        control.options.filter(
          (o) => (command.selectBy === 'value' ? o.value : o.label) === value && !o.disabled,
        ).length !== 1)
    )
      reason = '下拉控件或选项不唯一 / 不可用';
    if (command.kind === 'Press' && !command.key) reason = '缺少按键配置';
    if (
      command.kind === 'SetChecked' &&
      ((!['checkbox', 'radio'].includes(control.type) &&
        !['checkbox', 'radio', 'switch'].includes(control.role ?? '')) ||
        typeof command.checked !== 'boolean' ||
        control.checked === null ||
        ((control.type === 'radio' || control.role === 'radio') && !command.checked))
    )
      reason = '目标不支持此勾选状态';
    if (reason) {
      onMiss?.(reason);
      if (completed) throw new AppError('CACHE_PARTIAL_REPLAY', reason);
      return false;
    }
    if (command.kind === 'SetChecked' && control.checked === command.checked) {
      completed++;
      continue;
    }
    // Trial checks hit testing/stability without dispatching an actual click.
    try {
      await target.click({ trial: true, timeout: 3000 });
    } catch {
      onMiss?.('目标被遮挡或无法稳定操作');
      if (completed) throw new AppError('CACHE_PARTIAL_REPLAY', '部分操作已执行，后续目标无法操作');
      return false;
    }
    // Persist the write intent before dispatch, including timeout/unknown outcomes.
    await beforeWrite();
    if (command.kind === 'Tap') await target.click({ timeout: 3000 });
    else if (command.kind === 'Hover') await target.hover({ timeout: 3000 });
    else if (command.kind === 'Press') await target.press(command.key!, { timeout: 3000 });
    else if (command.kind === 'Select') {
      if (customSelect) {
        // Opening a custom popup is itself an action. Never rerun the entire
        // operation if the option later disappears or becomes ambiguous.
        if (control.expanded !== 'true') await target.click({ timeout: 3000 });
        const option = page.getByRole('option', { name: value!, exact: true });
        try {
          await option.waitFor({ state: 'visible', timeout: 3000 });
          await option.click({ trial: true, timeout: 3000 });
        } catch {
          throw new AppError(
            'CACHE_PARTIAL_REPLAY',
            '下拉框已打开，但选项无法唯一定位；停止重放以免重复操作',
          );
        }
        await beforeWrite();
        await option.click({ timeout: 3000 });
        completed++;
        continue;
      }
      const option = control.options.find(
        (o) => (command.selectBy === 'value' ? o.value : o.label) === value,
      )!;
      await target.selectOption({ value: option.value }, { timeout: 3000 });
      if ((await target.inputValue()) !== option.value)
        throw new AppError('CACHE_INPUT_POSTCONDITION', '下拉选择结果与本次参数不符');
    } else if (command.kind === 'SetChecked') {
      if (control.type === 'checkbox' || control.type === 'radio')
        await target.setChecked(command.checked!, { timeout: 3000 });
      else await target.click({ timeout: 3000 });
      const selected = await target.evaluate((el) =>
        el instanceof HTMLInputElement
          ? el.checked
          : el.getAttribute('aria-checked') === 'true'
            ? true
            : el.getAttribute('aria-checked') === 'false'
              ? false
              : null,
      );
      if (selected !== command.checked)
        throw new AppError('CACHE_INPUT_POSTCONDITION', '勾选状态未达到用例要求');
    } else {
      await target.fill(value!, { timeout: 3000 });
      const deadline = Date.now() + 3000;
      while (
        (await target.evaluate((el) =>
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : (el as HTMLElement).innerText,
        )) !== value
      ) {
        if (Date.now() >= deadline)
          throw new AppError(
            'CACHE_INPUT_POSTCONDITION',
            '输入动作已派发，但字段值不等于本次参数；停止自动重试，请检查当前页面',
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    completed++;
  }
  return true;
}
