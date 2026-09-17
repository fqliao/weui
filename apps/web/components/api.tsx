export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: {
      runId: string;
      caseId: string;
      caseTitle: string;
      executionMessage?: string;
      reviewable?: boolean;
    },
  ) {
    super(message);
  }
}
export async function api<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const r = await fetch('/api' + url, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.message || '请求失败', r.status, data.code, data.details);
  return data as T;
}
export const post = <T = unknown,>(url: string, body: unknown = {}) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T = unknown,>(url: string, body: unknown) =>
  api<T>(url, { method: 'PATCH', body: JSON.stringify(body) });
export type User = { id: string; name: string; email: string; role: string };
export type Environment = {
  revision: number;
  id: string;
  name: string;
  baseUrl: string;
  adapter: string;
  enabled: boolean;
  config: { fault?: string; browser?: import('../../../packages/contracts/src/browser-choice').BrowserName };
};
export type Project = {
  id: string;
  name: string;
  description: string;
  sample: boolean;
  environments: Environment[];
};
export type CaseSpec = {
  browser?: import('../../../packages/contracts/src/browser').BrowserCase;
  id: string;
  title: string;
  category: string;
  ruleIds: string[];
  steps: string[];
  assertionIds: string[];
  expected: string;
  reason?: string;
};
export type Plan = {
  summary: string;
  cases: CaseSpec[];
  missingRequirements: string[];
  mode: string;
  vision: boolean;
};
export type PlanRow = { id: string; revision: number; hash: string; content: Plan; usage: Usage };
export type Usage = {
  charges?: import('../../../packages/contracts/src/pricing').ModelCharge[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costCny?: number;
  priced: boolean;
  actions: number;
  visionCalls: number;
};
export type Result = {
  metrics?: import('../../../packages/contracts/src/case-metrics').CaseMetrics;
  execution?: import('../../../packages/contracts/src/execution-cache').ExecutionStats;
  caseId: string;
  title: string;
  result: string;
  cause: string | null;
  message: string;
  assertions: { id: string; ruleId: string; expected: unknown; actual: unknown; passed: boolean }[];
  evidenceIds: string[];
  startedAt: string;
  finishedAt: string;
};
export type Evidence = { id: string; caseId: string; kind: string; fileName: string; bytes: number };
export type Task = {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  status: string;
  revision: number;
  mode: string;
  error: string | null;
  createdAt: string;
  knowledgeReleaseId: string;
  skillReleaseId: string | null;
  debugSkillId: string | null;
  budget: { maxActions: number; timeoutMs: number };
  plans: PlanRow[];
  runs: Run[];
};
export type Run = {
  id: string;
  taskId: string;
  status: string;
  summary: Result[];
  usage: Usage;
  error: string | null;
  cleanupStatus: string;
  retry?: { allowed: boolean; reason: string; noBusinessActions: boolean };
  browserCleanup?: 'CLOSED' | 'FAILED' | 'NOT_RECORDED';
  createdAt: string;
  finishedAt: string | null;
  task: Task;
  evidence: Evidence[];
  feedback: { id: string; rating: number; comment: string }[];
  manifest: {
    executionMode?: import('../../../packages/contracts/src/execution-cache').ExecutionMode;
    browser?: {
      name: import('../../../packages/contracts/src/browser-choice').BrowserName;
      engine: 'playwright';
    };
    sample: boolean;
    debug: boolean;
    revision: number;
    knowledgeReleaseId: string;
    knowledgeHash: string;
    skillHash: string | null;
    skillReleaseId: string | null;
    planHash: string;
    plan: Plan;
    budget: { maxActions: number; timeoutMs: number };
    model: string;
    models?: {
      planner: import('../../../packages/contracts/src/pricing').ModelTarget;
      vision: import('../../../packages/contracts/src/pricing').ModelTarget;
    };
    environment: { baseUrl: string; adapter: string };
    codeVersion: string;
  };
};
export type Meta = {
  version: string;
  model: { configured: boolean; name: string; defaultMode: string; priced: boolean };
  vision: { configured: boolean; name: string | null };
  workers: number;
  executionEnabled: boolean;
  cases: CaseSpec[];
};
export type Knowledge = {
  id: string;
  name: string;
  version: string;
  hash: string;
  content: {
    pages: { id: string; title: string; body: string; source: string }[];
    rules: { id: string; title: string; text: string; source: string; owner: string }[];
    ontology: { entities: string[]; relations: { from: string; type: string; to: string }[] };
  };
};
export type Draft = {
  name: string;
  description: string;
  instructions: string;
  toolIds: string[];
  ruleIds: string[];
  caseIds: string[];
  inputSchema: { goal: 'string' };
  outputSchema: { cases: 'CaseResult[]' };
};
export type Release = { id: string; version: number; hash: string; disabled: boolean; createdAt: string };
export type Skill = {
  id: string;
  name: string;
  description: string;
  template: boolean;
  ownerId: string;
  draft: Draft;
  draftHash: string;
  activeReleaseId: string | null;
  releases: Release[];
};
export type Tool = {
  id: string;
  name: string;
  type: string;
  description: string;
  version: string;
  effect: string;
  available: boolean;
  scope: string;
  credential: string;
};
export const TERMINAL = new Set(['COMPLETED', 'ERROR', 'CANCELLED']);
export const statusNames: Record<string, string> = {
  DRAFT: '草稿',
  PLANNING: '正在规划',
  AWAITING_APPROVAL: '待确认计划',
  QUEUED: '等待执行',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  ERROR: '执行异常',
  CANCEL_REQUESTED: '正在取消',
  CANCELLED: '已取消',
  PASS: '通过',
  FAIL: '不成立',
  BLOCKED: '阻断',
  INCONCLUSIVE: '证据不足',
  SKIPPED: '未执行',
};
export function go(route: string) {
  window.location.hash = '#/' + route;
}
export function date(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
export function Badge({ status }: { status: string }) {
  return (
    <span className={'badge status-' + status.toLowerCase()}>
      <i />
      {statusNames[status] || status}
    </span>
  );
}
