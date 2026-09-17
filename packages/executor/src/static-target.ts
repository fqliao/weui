import { z } from 'zod';
import type { Locator, Page } from 'playwright';

export type RuntimeBindings = { runId?: string };
export const targetSchema = z.object({
  by: z.enum(['label', 'role', 'testId', 'placeholder', 'text', 'css']),
  value: z.string().min(1).max(4000),
  role: z.string().optional(),
});
export const guardSchema = z.object({
  version: z.literal(1),
  url: z.string(),
  identity: z.record(z.string(), z.string()),
});
export type StaticTarget = z.infer<typeof targetSchema>;
export type TargetGuard = z.infer<typeof guardSchema>;

export function bindTemplate(value: string, bindings: RuntimeBindings = {}) {
  return bindings.runId ? value.replaceAll('{{runId}}', bindings.runId) : value;
}
export function toTemplate(value: string, bindings: RuntimeBindings = {}) {
  return bindings.runId ? value.replaceAll(bindings.runId, '{{runId}}') : value;
}
export function resolveTarget(page: Page, target: StaticTarget, bindings: RuntimeBindings = {}) {
  const value = bindTemplate(target.value, bindings);
  if (target.by === 'label') return page.getByLabel(value, { exact: true });
  if (target.by === 'role')
    return page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: value, exact: true });
  if (target.by === 'testId') return page.getByTestId(value);
  if (target.by === 'placeholder') return page.getByPlaceholder(value, { exact: true });
  if (target.by === 'text') return page.getByText(value, { exact: true });
  return page.locator(value);
}

export async function targetIdentity(locator: Locator) {
  return locator.evaluate((el) => {
    const input =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    const label = input
      ? Array.from(el.labels ?? [])
          .map((l) => {
            const copy = l.cloneNode(true) as Element;
            copy.querySelectorAll('input,textarea,select,button').forEach((control) => control.remove());
            return copy.textContent;
          })
          .join(' ')
      : '';
    const labelled = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const tag = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type : el instanceof HTMLButtonElement ? el.type : '';
    const role =
      el.getAttribute('role') ||
      (tag === 'button' || (tag === 'input' && ['button', 'submit'].includes(type))
        ? 'button'
        : tag === 'a'
          ? 'link'
          : '');
    const result: Record<string, string> = {
      tag,
      type,
      role,
      ...(el.getAttribute('contenteditable') === 'true' ? { editable: 'true' } : {}),
      label: (el.getAttribute('aria-label') || labelled || label || '').replace(/\s+/g, ' ').trim(),
      text:
        input || el.getAttribute('contenteditable') === 'true'
          ? ''
          : ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
      name: el.getAttribute('name') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
      testId: el.getAttribute('data-testid') ?? '',
      href: el instanceof HTMLAnchorElement ? el.href : '',
    };
    const form = el.closest('form');
    if (form) {
      result.formAction = form.action;
      result.formMethod = form.method;
      result.formName = form.getAttribute('aria-label') || form.getAttribute('name') || '';
    }
    // Generated ids and input values are not semantic identity. An id remains
    // a required identity check only when it is the sole locator contract.
    if (!result.label && !result.text && !result.name && !result.placeholder && !result.testId)
      result.id = el.id;
    return result;
  });
}

export async function recordTarget(page: Page, selector: string, bindings: RuntimeBindings = {}) {
  const locator = page.locator(selector);
  const identity = await targetIdentity(locator);
  const candidates: StaticTarget[] = [];
  if (identity.label) candidates.push({ by: 'label', value: identity.label });
  if (['button', 'link'].includes(identity.role) && (identity.label || identity.text))
    candidates.push({ by: 'role', role: identity.role, value: identity.label || identity.text });
  if (identity.testId) candidates.push({ by: 'testId', value: identity.testId });
  if (identity.placeholder) candidates.push({ by: 'placeholder', value: identity.placeholder });
  candidates.push({ by: 'css', value: selector });
  for (const target of candidates) {
    const candidate = resolveTarget(page, target);
    if ((await candidate.count()) !== 1) continue;
    if (!(await candidate.evaluate((el, css) => el === document.querySelector(css), selector))) continue;
    // Anonymous nth-of-type elements have no stable semantic contract.
    if (
      target.by === 'css' &&
      !Object.entries(identity).some(
        ([k, v]) => ['label', 'text', 'name', 'placeholder', 'testId', 'id'].includes(k) && v,
      )
    )
      return null;
    return {
      target: { ...target, value: toTemplate(target.value, bindings) },
      guard: {
        version: 1 as const,
        url: toTemplate(page.url(), bindings),
        identity: Object.fromEntries(Object.entries(identity).map(([k, v]) => [k, toTemplate(v, bindings)])),
      },
    };
  }
  return null;
}

export async function checkTarget(
  page: Page,
  target: StaticTarget,
  guard: TargetGuard,
  bindings: RuntimeBindings = {},
  timeoutMs = 3000,
) {
  const end = Date.now() + timeoutMs;
  let reason = '';
  do {
    if (page.url() !== bindTemplate(guard.url, bindings)) reason = '当前页面 URL 与操作入口不符';
    else
      try {
        const locator = resolveTarget(page, target, bindings);
        const count = await locator.count();
        if (count !== 1) reason = `定位匹配到 ${count} 个元素，需要唯一目标`;
        else if (!(await locator.isVisible()) || !(await locator.isEnabled()))
          reason = '目标不可见或尚不可操作';
        else {
          const identity = await targetIdentity(locator);
          const mismatch = Object.entries(guard.identity)
            .filter(([k, v]) => identity[k] !== bindTemplate(v, bindings))
            .map(([k]) => k);
          if (!mismatch.length) return { locator, reason: '' };
          reason = `目标语义发生变化（${mismatch.join('、')}）`;
        }
      } catch (error) {
        if (page.isClosed()) throw error;
        reason = '定位表达式无效，或目标在页面重绘中暂不可用';
      }
    if (Date.now() >= end) return { locator: null, reason };
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (true);
}
