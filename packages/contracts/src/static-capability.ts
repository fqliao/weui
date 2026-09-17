import type { WebCaseInput, WebStep } from './browser.ts';
import { assertionLabel, type WebAssertion } from './static-ui.ts';
export type Capability = { level: 'static' | 'learn' | 'ai'; label: string; reason: string };
export function stepCapability(s: WebStep): Capability {
  if (s.kind === 'wait')
    return s.condition
      ? { level: 'static', label: '可直接静态验证', reason: '按结构化条件等待，本次仍重新检查' }
      : assertionCapability(s.text);
  if (s.kind === 'act')
    return {
      level: 'learn',
      label: '首次需 AI 规划',
      reason: '点击和输入可在通过后沉淀；复杂动作可能仍需 AI',
    };
  if (s.target)
    return { level: 'static', label: '可直接静态操作', reason: '已配置明确定位；定位不可用时逐级回退' };
  return { level: 'learn', label: '首次需 AI 定位', reason: '通过后保存控件定位；再次执行优先使用二级缓存' };
}
export function assertionCapability(a: WebAssertion): Capability {
  if (typeof a !== 'string')
    return {
      level: 'static',
      label: '可直接静态验证',
      reason: '每次按结构化条件检查，失败不会由 AI 放宽预期',
    };
  if (/^(文本可见|文本不可见|页面URL等于)[：:]/.test(a))
    return {
      level: 'static',
      label: '可直接静态验证',
      reason: '明确文本或 URL 条件每次由 Playwright 重新检查',
    };
  return {
    level: 'ai',
    label: '需要 AI 判断或校准',
    reason: '首次验证后自动尝试沉淀完整静态条件；不能完整表达时保留 AI，具体覆盖及原因见缓存记录',
  };
}
export function caseCapabilities(c: WebCaseInput) {
  return [
    ...c.steps.map((s, i) => ({ index: i, title: `操作 ${i + 1} · ${s.text}`, ...stepCapability(s) })),
    ...c.assertions.map((a, i) => ({
      index: c.steps.length + i,
      title: `验证 ${i + 1} · ${assertionLabel(a)}`,
      ...assertionCapability(a),
    })),
  ];
}
