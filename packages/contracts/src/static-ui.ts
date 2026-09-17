import { z } from 'zod';

export const uiTargetSchema = z
  .object({
    by: z.enum(['label', 'role', 'testId', 'placeholder', 'text', 'css']),
    value: z.string().trim().min(1).max(2000),
    role: z
      .enum([
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'switch',
        'combobox',
        'option',
        'tab',
        'menuitem',
        'heading',
        'alert',
        'dialog',
        'row',
        'cell',
        'listitem',
      ])
      .optional(),
  })
  .refine((t) => t.by !== 'role' || !!t.role, '按角色定位时请选择角色');
export type UiTarget = z.infer<typeof uiTargetSchema>;
const target = { target: uiTargetSchema };
const expected = z.string().max(4000);
export const conditionLeafSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'), ...target }),
  z.object({ kind: z.literal('hidden'), ...target }),
  z.object({ kind: z.literal('enabled'), ...target }),
  z.object({ kind: z.literal('disabled'), ...target }),
  z.object({ kind: z.literal('nonempty'), ...target }),
  z.object({
    kind: z.literal('position'),
    ...target,
    region: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
  }),
  z.object({ kind: z.literal('checked'), ...target, checked: z.boolean() }),
  z.object({ kind: z.literal('text'), ...target, expected, match: z.enum(['equals', 'contains']) }),
  z.object({ kind: z.literal('value'), ...target, expected }),
  z.object({ kind: z.literal('count'), ...target, count: z.number().int().min(0).max(10000) }),
  z.object({ kind: z.literal('url'), expected: expected.min(1), match: z.enum(['equals', 'contains']) }),
]);
export const uiConditionSchema = z.union([
  conditionLeafSchema,
  z.object({ kind: z.enum(['all', 'any']), conditions: z.array(conditionLeafSchema).min(1).max(10) }),
]);
export type UiCondition = z.infer<typeof uiConditionSchema>;
export type UiConditionLeaf = z.infer<typeof conditionLeafSchema>;
export const keySchema = z.enum([
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Backspace',
  'Delete',
]);
export const parametersSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
      .refine((v) => !['constructor', 'prototype'].includes(v)),
    z.string().max(4000),
  )
  .refine((v) => Object.keys(v).length <= 30, '最多 30 个数据参数');
export const conditionNames: Record<UiConditionLeaf['kind'], string> = {
  visible: '可见',
  hidden: '不可见',
  enabled: '可操作',
  disabled: '禁用',
  nonempty: '文本非空',
  position: '页面位置',
  checked: '勾选状态',
  text: '文本',
  value: '输入或选中值',
  count: '元素数量',
  url: '页面 URL',
};
export function describeCondition(c: UiCondition): string {
  if (c.kind === 'all' || c.kind === 'any')
    return `${c.kind === 'all' ? '全部满足' : '任一满足'}：${c.conditions.map(describeCondition).join('；')}`;
  const name = 'target' in c ? `${c.target.role ? c.target.role + ' ' : ''}${c.target.value}` : '页面 URL';
  if (c.kind === 'text' || c.kind === 'url')
    return `${name} ${c.kind === 'text' ? '文本' : ''}${c.match === 'equals' ? '等于' : '包含'} ${c.expected}`;
  if (c.kind === 'value') return `${name} 的值等于 ${c.expected}`;
  if (c.kind === 'count') return `${name} 的匹配数量等于 ${c.count}`;
  if (c.kind === 'checked') return `${name} ${c.checked ? '已勾选' : '未勾选'}`;
  if (c.kind === 'position') return `${name} 位于页面 ${c.region}`;
  return `${name} ${conditionNames[c.kind as UiConditionLeaf['kind']]}`;
}
export const structuredAssertionSchema = z.object({
  kind: z.literal('structured'),
  condition: uiConditionSchema,
  timeoutMs: z.number().int().min(100).max(30000).optional(),
});
export type StructuredAssertion = z.infer<typeof structuredAssertionSchema>;
export type WebAssertion = string | StructuredAssertion;
export const assertionLabel = (a: WebAssertion) =>
  typeof a === 'string' ? a : describeCondition(a.condition);

// Replace only declared slots, never evaluate expressions or recursively expand
// user parameter text. Missing variables must fail before browser actions.
export function expandParameters(
  text: string,
  runId: string,
  caseId: string,
  parameters: Record<string, string> = {},
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    if (key === 'runId') return runId;
    if (key === 'caseId') return caseId;
    if (key.startsWith('data.') && Object.hasOwn(parameters, key.slice(5)))
      return parameters[key.slice(5)].replaceAll('{{runId}}', runId).replaceAll('{{caseId}}', caseId);
    throw new Error(`未定义的测试参数：${key}`);
  });
}
export function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}
