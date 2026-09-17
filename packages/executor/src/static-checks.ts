import { z } from 'zod';
import type { Page } from 'playwright';
import { feedbackSchema, compileFeedback, bindFeedback, probeFeedback } from './feedback-check.ts';
import { bindTemplate, toTemplate, type RuntimeBindings } from './static-target.ts';
import { uiConditionSchema } from '../../contracts/src/static-ui.ts';
import { evaluateCondition } from './structured-check.ts';
import { hash } from '../../config/src/index.ts';
import { learnedCheckSchema, evaluateLearnedCheck, type LearningEvidence } from './learned-check.ts';

const simpleCheckSchema = z.object({
  kind: z.enum(['text-visible', 'text-hidden', 'url-equals']),
  expected: z.string().min(1).max(4000),
});
export const checkSchema = z.union([
  simpleCheckSchema,
  feedbackSchema,
  learnedCheckSchema,
  z.object({ kind: z.literal('structured'), expected: z.string(), condition: uiConditionSchema }),
]);
export type StaticCheck = z.infer<typeof checkSchema>;
export function restoreLearnedCheck(
  expected: string,
  saved: StaticCheck | undefined,
  bindings: RuntimeBindings,
): StaticCheck | undefined {
  if (saved?.kind !== 'learned-ui') return;
  const restored = checkSchema.parse(JSON.parse(bindTemplate(JSON.stringify(saved), bindings)));
  return restored.expected === expected ? restored : undefined;
}

// Only this explicit, documented grammar is deterministic. Never derive a new
// business expectation from the page observed on a successful run.
export function compileCheck(text: string): StaticCheck | undefined {
  const match = /^(文本可见|文本不可见|页面URL等于)[：:]\s*(.+)$/s.exec(text.trim());
  if (!match || !match[2].trim()) return compileFeedback(text);
  return {
    kind: match[1] === '文本可见' ? 'text-visible' : match[1] === '文本不可见' ? 'text-hidden' : 'url-equals',
    expected: match[2].trim(),
  };
}

export async function materializeCheck(page: Page, check: StaticCheck) {
  return check.kind === 'form-feedback' ? bindFeedback(page, check).catch(() => undefined) : check;
}
export function templateCheck(check: StaticCheck, bindings: RuntimeBindings) {
  return checkSchema.parse(JSON.parse(toTemplate(JSON.stringify(check), bindings)));
}
export function restoreCheck(
  current: StaticCheck,
  saved: StaticCheck,
  bindings: RuntimeBindings,
): StaticCheck | undefined {
  const old = checkSchema.parse(JSON.parse(bindTemplate(JSON.stringify(saved), bindings)));
  if (current.kind !== old.kind || current.expected !== old.expected) return;
  if (
    current.kind === 'structured' &&
    old.kind === 'structured' &&
    hash(current.condition) !== hash(old.condition)
  )
    return;
  if (current.kind === 'form-feedback' && old.kind === 'form-feedback') {
    if (hash(current.intent) !== hash(old.intent) || !old.binding) return;
    return { ...current, binding: old.binding };
  }
  return current;
}

export async function evaluateCheck(
  page: Page,
  check: StaticCheck,
  timeoutMs = 5000,
  evidence: LearningEvidence[] = [],
): Promise<{ pass: boolean; thought: string; cacheTier: 'L2'; unavailable?: boolean }> {
  if (check.kind === 'learned-ui') return evaluateLearnedCheck(page, check, timeoutMs, evidence);
  if (check.kind === 'structured') return evaluateCondition(page, check.condition, timeoutMs);
  const end = Date.now() + timeoutMs;
  do {
    if (page.isClosed()) throw new Error('浏览器页面已关闭');
    let pass = false;
    let thought = '';
    if (check.kind === 'form-feedback') {
      try {
        const result = await probeFeedback(page, check);
        if (result.pass || result.unavailable) return { ...result, cacheTier: 'L2' as const };
        thought = result.thought;
      } catch (error) {
        if (page.isClosed()) throw error;
        return {
          pass: false,
          unavailable: true,
          thought: '复合验证的静态定位不可用，转入逐级回退',
          cacheTier: 'L2' as const,
        };
      }
    } else if (check.kind === 'url-equals') pass = page.url() === check.expected;
    else {
      const targets = page.getByText(check.expected, { exact: true });
      let visible = 0;
      for (const target of await targets.all()) if (await target.isVisible()) visible++;
      // Multiple visible matches do not satisfy a unique positive assertion.
      pass = check.kind === 'text-visible' ? visible === 1 : visible === 0;
    }
    if (pass)
      return { pass: true, thought: 'Playwright 已按本次用例的明确预期重新验证', cacheTier: 'L2' as const };
    if (Date.now() >= end)
      return {
        pass: false,
        thought: thought || 'Playwright 等待后，当前页面仍不满足用例预期；未修改预期或重复业务操作',
        cacheTier: 'L2' as const,
      };
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (true);
}
