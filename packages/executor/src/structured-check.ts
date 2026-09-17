import type { Page } from 'playwright';
import { describeCondition, type UiCondition, type UiConditionLeaf } from '../../contracts/src/static-ui.ts';
import { resolveTarget } from './static-target.ts';

async function probe(page: Page, c: UiConditionLeaf, timeout: number): Promise<boolean> {
  if (c.kind === 'url')
    return c.match === 'equals' ? page.url() === c.expected : page.url().includes(c.expected);
  const target = resolveTarget(page, c.target);
  const count = await target.count();
  if (c.kind === 'count') return count === c.count;
  if (c.kind === 'hidden') {
    for (const item of await target.all()) if (await item.isVisible()) return false;
    return true;
  }
  if (count !== 1) return false;
  if (c.kind === 'visible') return target.isVisible();
  if (!(await target.isVisible())) return false;
  if (c.kind === 'position') {
    const box = await target.boundingBox(),
      viewport = page.viewportSize();
    if (!box || !viewport) return false;
    const x = (box.x + box.width / 2) / viewport.width,
      y = (box.y + box.height / 2) / viewport.height;
    return (
      (c.region.endsWith('right') ? x >= 0.5 && x <= 1 : x >= 0 && x < 0.5) &&
      (c.region.startsWith('top') ? y >= 0 && y <= 1 / 3 : y >= 2 / 3 && y <= 1)
    );
  }
  if (c.kind === 'enabled' || c.kind === 'disabled') {
    // Read a snapshot instead of starting a locator wait with a nearly-expired
    // polling budget (a 1ms timeout could turn a disabled control into a miss).
    const disabled = await target.evaluateAll((elements) => {
      const el = elements.length === 1 ? elements[0] : undefined;
      return el ? el.matches(':disabled') || !!el.closest('[aria-disabled="true"]') : null;
    });
    return disabled !== null && (c.kind === 'disabled' ? disabled : !disabled);
  }
  if (c.kind === 'checked') {
    const state = await target.evaluateAll((elements) => {
      const el = elements.length === 1 ? elements[0] : undefined;
      if (!el) return null;
      return el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)
        ? el.checked
        : el.getAttribute('aria-checked') === 'true'
          ? true
          : el.getAttribute('aria-checked') === 'false'
            ? false
            : null;
    });
    return state !== null && state === c.checked;
  }
  if (c.kind === 'value') {
    const value = await target.evaluateAll((elements) => {
      const el = elements.length === 1 ? elements[0] : undefined;
      if (!el) return null;
      return el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
        ? el.value
        : el.getAttribute('contenteditable') === 'true'
          ? (el as HTMLElement).innerText
          : null;
    });
    return value !== null && value === c.expected;
  }
  const text = await target.evaluateAll((elements) =>
    elements.length === 1 ? (elements[0] as HTMLElement).innerText : null,
  );
  if (text == null) return false;
  if (c.kind === 'nonempty') return text.trim().length > 0;
  const actual = text.replace(/\s+/g, ' ').trim();
  const expected = c.expected.replace(/\s+/g, ' ').trim();
  return c.match === 'equals' ? actual === expected : actual.includes(expected);
}
export async function evaluateCondition(page: Page, condition: UiCondition, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let failed: string[] = [];
  do {
    if (page.isClosed()) throw new Error('浏览器页面已关闭');
    const conditions = 'conditions' in condition ? condition.conditions : [condition];
    const results: boolean[] = [];
    failed = [];
    for (const c of conditions) {
      // Explicit oracles must not be weakened through an AI fallback.
      const pass = await probe(page, c, Math.max(1, Math.min(1000, until - Date.now()))).catch((error) => {
        if (page.isClosed()) throw error;
        return false;
      });
      results.push(pass);
      if (!pass) failed.push(describeCondition(c));
    }
    if (condition.kind === 'any' ? results.some(Boolean) : results.every(Boolean))
      return {
        pass: true,
        thought: 'Playwright 已逐项重新验证：' + describeCondition(condition),
        cacheTier: 'L2' as const,
      };
    if (Date.now() >= until)
      return { pass: false, thought: '等待后仍不满足：' + failed.join('；'), cacheTier: 'L2' as const };
    await new Promise((r) => setTimeout(r, 150));
  } while (true);
}
