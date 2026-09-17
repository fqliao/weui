import { AppError } from '../../config/src/index.ts';
import type { Observation } from '../../contracts/src/discovery.ts';
export const phaseNames = { MAIN: '主链路', BOUNDARY: '边界探索', DIVERGENT: '发散探索' } as const;
export const phaseInstructions = {
  MAIN: '优先标准业务入口，梳理必填字段、完整有效数据和目标闭环。仅设计正向基线用例。必须由人审核并正式执行 PASS 后才能进入边界探索。',
  BOUNDARY:
    '基于已通过的主链路及业务规则，设计必填留空、错误格式、业务边界和前端校验提示用例。每个负向用例独立，预期必须来自需求或领域规则，未定义则标记假设；不扩展无关入口。',
  DIVERGENT:
    '基于已完成边界验证，优先探索未访问的预览、帮助、侧栏等非主流程入口。避免再次复述已验证路径，记录未覆盖隐藏路径和候选用例。',
} as const;
export function validateBaseline(
  phase: string,
  previous: { phase: string; environmentId: string },
  environmentId: string,
  publishedIds: string[],
  run: { status: string; cleanupStatus: string; manifest: any; summary: any },
) {
  if (
    previous.phase !== (phase === 'BOUNDARY' ? 'MAIN' : 'BOUNDARY') ||
    previous.environmentId !== environmentId
  )
    throw new AppError('DISCOVERY_PHASE', '必须选择同一网站的上一阶段探索，不能跳过阶段');
  const cases = run.manifest?.plan?.cases;
  if (
    run.status !== 'COMPLETED' ||
    run.cleanupStatus === 'FAILED' ||
    run.manifest?.discovery ||
    run.manifest?.environmentId !== environmentId ||
    !Array.isArray(cases) ||
    !cases.length ||
    cases.some((c: any) => !publishedIds.includes(c.id))
  )
    throw new AppError('DISCOVERY_BASELINE', '请选择上一阶段已审核用例的正式测试运行作为基线');
  if (
    !Array.isArray(run.summary) ||
    run.summary.length !== cases.length ||
    cases.some(
      (c: any) =>
        !run.summary.some(
          (s: any) =>
            s.caseId === c.id &&
            (phase === 'BOUNDARY' ? s.result === 'PASS' : ['PASS', 'FAIL'].includes(s.result)),
        ),
    )
  )
    throw new AppError(
      'DISCOVERY_BASELINE',
      phase === 'BOUNDARY'
        ? '主链路尚未全部验证通过，不能进入边界探索'
        : '边界验证存在阻断或未知结果，请先处理后再发散探索',
    );
}
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。；、：:,.!?！？]/g, '');
function canonicalUrl(url: string) {
  const u = new URL(url);
  u.searchParams.sort();
  return u.toString();
}
function grams(text: string) {
  const s = normalize(text);
  return new Set(Array.from({ length: Math.max(1, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
}
export function similarity(a: string, b: string) {
  const left = grams(a),
    right = grams(b),
    union = new Set([...left, ...right]);
  return union.size ? [...left].filter((v) => right.has(v)).length / union.size : 1;
}
export type ExplorationAction = { from: string; target: string; text: string; outcome: string };
export class Convergence {
  history: ExplorationAction[] = [];
  states: { url: string; signature: string }[] = [];
  private pending: ExplorationAction | undefined;
  observe(view: Pick<Observation, 'url' | 'title' | 'controls'>) {
    const state = {
      url: canonicalUrl(view.url),
      signature: normalize([view.title, ...view.controls].join('|')),
    };
    const repeated = this.states.some(
      (s) => s.url === state.url && similarity(s.signature, state.signature) >= 0.94,
    );
    if (this.pending) {
      this.pending.outcome = repeated ? '重复页面状态' : `到达 ${state.url}`;
      this.pending = undefined;
    }
    if (!repeated) this.states.push(state);
    return !repeated;
  }
  before(action: Omit<ExplorationAction, 'outcome'>) {
    if (
      this.history.some(
        (h) =>
          canonicalUrl(h.from) === canonicalUrl(action.from) &&
          (canonicalUrl(h.target) === canonicalUrl(action.target) || similarity(h.text, action.text) >= 0.94),
      )
    )
      throw new AppError('EXPLORE_REPEAT', '同一页面的相同或高度相似操作已经执行，停止重复动作');
    this.pending = { ...action, outcome: '执行中' };
    this.history.push(this.pending);
  }
  failed() {
    if (this.pending) this.pending.outcome = '导航失败，未重放';
    this.pending = undefined;
  }
  rank<T extends { url: string }>(links: T[]) {
    const repetition = this.history.slice(-3).filter((h) => /重复|失败/.test(h.outcome)).length;
    return links
      .map((link) => {
        const path = new URL(link.url).pathname + new URL(link.url).hash;
        const known = this.states.map((s) => new URL(s.url).pathname + new URL(s.url).hash);
        const novelty = 1 - Math.max(0, ...known.map((p) => similarity(p, path)));
        return {
          ...link,
          novelty: Number(novelty.toFixed(3)),
          priority: Number((novelty * (1 + repetition)).toFixed(3)),
        };
      })
      .sort((a, b) => b.priority - a.priority);
  }
}
