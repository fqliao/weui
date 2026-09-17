import type { Prisma } from '@prisma/client';
import { db } from '../../db/src/index.ts';
import { hash } from '../../config/src/index.ts';
type RunRecord = { id: string; status: string; cleanupStatus: string; manifest: unknown; summary: unknown };
type ActionRecord = {
  id: string;
  caseId?: string;
  tool: string;
  status: string;
  input: unknown;
  output: unknown;
  finishedAt: Date | null;
};
type EventRecord = { kind: string; payload: unknown };
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' ? (value as Record<string, any>) : {};
export function assessRunControl(
  run: RunRecord,
  actions: ActionRecord[],
  events: EventRecord[],
  caseId?: string,
) {
  if (caseId && object(run.manifest).environment?.adapter === 'midscene-web-v1') {
    const original = object(run.manifest),
      cases = original.plan?.cases;
    const selected = Array.isArray(cases) ? cases.filter((c: unknown) => object(c).id === caseId) : [];
    const results = Array.isArray(run.summary) ? run.summary.filter((r) => object(r).caseId === caseId) : [];
    const scopedActions = actions.filter((a) => !a.caseId || a.caseId === caseId);
    const actionIds = new Set(scopedActions.map((a) => a.id));
    const scopedEvents = events.filter((e) => {
      const p = object(e.payload);
      return p.caseId ? p.caseId === caseId : p.actionId ? actionIds.has(p.actionId) : true;
    });
    return assessRunControl(
      {
        ...run,
        manifest: { ...original, plan: { ...original.plan, cases: selected } },
        summary:
          selected.length === 1 && results.length === 1 ? results : [{ caseId, result: 'INCONCLUSIVE' }],
      },
      scopedActions,
      scopedEvents,
    );
  }
  const manifest = object(run.manifest),
    summary = Array.isArray(run.summary) ? run.summary : [];
  const browserCleanup = events.some((e) => e.kind === 'browser.cleanup.failed')
    ? 'FAILED'
    : events.some((e) => e.kind === 'browser.closed')
      ? 'CLOSED'
      : 'NOT_RECORDED';
  const result = (allowed: boolean, reason: string, noBusinessActions = false) => ({
    retry: { allowed, reason, noBusinessActions },
    browserCleanup,
  });
  if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status)) return result(false, '运行尚未结束。');
  if (run.cleanupStatus === 'FAILED')
    return result(
      false,
      '配置的清理未完成或执行租约异常。请核对本次产生的数据后再执行，浏览器会话回收不能替代业务清理。',
    );
  if (browserCleanup === 'FAILED') return result(false, '浏览器资源回收失败，请先检查执行进程。');
  const uncertain =
    summary.some((r) => object(r).result === 'INCONCLUSIVE') ||
    actions.some((a) => ['STARTED', 'UNKNOWN_OUTCOME'].includes(a.status));
  if (!uncertain)
    return result(true, '可重新执行，每次使用新的隔离浏览器会话。', run.cleanupStatus === 'NOT_REQUIRED');
  // Only this registered adapter/version guarantees a durable event before every UI action.
  // Require a complete trace; missing records or a crashed Worker never count as proof of no writes.
  const supported =
    manifest.environment?.adapter === 'midscene-web-v1' &&
    manifest.codeVersion === 'mvp-0.2.0' &&
    manifest.toolVersions?.['midscene.ui'] === '1.0.0';
  const complete =
    supported &&
    Array.isArray(manifest.plan?.cases) &&
    summary.length === manifest.plan.cases.length &&
    summary.length > 0 &&
    manifest.plan.cases.every((c: unknown) => summary.some((r) => object(r).caseId === object(c).id)) &&
    events.some((e) => e.kind === 'finished') &&
    actions.length > 0 &&
    actions.every(
      (a) =>
        a.tool === 'midscene.ui' &&
        a.status !== 'STARTED' &&
        a.finishedAt &&
        events.some((e) => e.kind === 'action.started' && object(e.payload).actionId === a.id) &&
        events.some(
          (e) => ['action.completed', 'action.error'].includes(e.kind) && object(e.payload).actionId === a.id,
        ),
    ) &&
    summary.every(
      (r) =>
        object(r).result === 'SKIPPED' ||
        events.some((e) => e.kind === 'case.completed' && object(e.payload).caseId === object(r).caseId),
    );
  const businessUi = events.some((e) => {
    if (e.kind !== 'midscene.action') return false;
    const p = object(e.payload);
    return p.phase ? p.phase !== 'authentication' && p.write !== false : p.message !== '登录 UI 操作';
  });
  const recordedWrite = actions.some(
    (a) =>
      object(a.input).phase &&
      object(a.input).phase !== 'authentication' &&
      object(a.output).writeAttempted === true,
  );
  if (complete && !businessUi && !recordedWrite)
    return result(
      true,
      '已自动核对：本次未尝试业务写动作，无需删除业务数据。请先修正用例步骤；重新执行仍使用原计划。',
      true,
    );
  return result(
    false,
    '上次操作中断，尚不能确定是否产生了业务影响。请查看上次运行，核对实际结果并修正用例；关闭浏览器不会自动确认业务结果。',
  );
}
export async function readRunControl(
  run: RunRecord,
  store: Pick<Prisma.TransactionClient, 'action' | 'runEvent' | 'auditEvent'> = db,
  caseId?: string,
) {
  const [actions, events] = await Promise.all([
    store.action.findMany({
      where: { runId: run.id },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        caseId: true,
        tool: true,
        status: true,
        input: true,
        output: true,
        finishedAt: true,
      },
    }),
    store.runEvent.findMany({
      orderBy: { seq: 'asc' },
      where: {
        runId: run.id,
        kind: {
          in: [
            'finished',
            'case.completed',
            'action.started',
            'action.completed',
            'action.error',
            'midscene.action',
            'browser.closed',
            'browser.cleanup.failed',
          ],
        },
      },
      select: { kind: true, payload: true },
    }),
  ]);
  const original = assessRunControl(run, actions, events, caseId);
  const cases = object(run.manifest).plan?.cases as { id: string; title?: string }[] | undefined;
  const canReview =
    !original.retry.allowed &&
    object(run.manifest).environment?.adapter === 'midscene-web-v1' &&
    ['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status) &&
    run.cleanupStatus !== 'FAILED' &&
    original.browserCleanup === 'CLOSED' &&
    Array.isArray(cases) &&
    cases.length > 0 &&
    (!caseId || cases.some((c) => c.id === caseId));
  if (!canReview) return { ...original, review: null };
  // Bind a human check to the exact immutable trace, not merely a case ID or
  // current case revision. New executions and changed evidence need a new check.
  const fingerprint = hash({
    run: {
      id: run.id,
      status: run.status,
      cleanupStatus: run.cleanupStatus,
      manifest: run.manifest,
      summary: run.summary,
    },
    actions,
    events,
  });
  const records = await store.auditEvent.findMany({
    where: { targetId: run.id, action: 'run.outcome.reviewed' },
    orderBy: { createdAt: 'asc' },
  });
  const reviewed = new Set(
    records
      .filter((r) => object(r.detail).fingerprint === fingerprint)
      .map((r) => object(r.detail).caseId as string),
  );
  const pending = cases!.filter(
    (c) =>
      (!caseId || c.id === caseId) &&
      !assessRunControl(run, actions, events, c.id).retry.allowed &&
      !reviewed.has(c.id),
  );
  if (!pending.length)
    return {
      ...original,
      retry: {
        allowed: true,
        reason: '已记录人工核对结果，可使用新的隔离浏览器会话重新测试。原测试结论保留。',
        noBusinessActions: false,
      },
      review: { fingerprint, pendingCases: [], reviewedCaseIds: [...reviewed] },
    };
  return {
    ...original,
    review: {
      fingerprint,
      pendingCases: pending.map((c) => ({ id: c.id, title: c.title ?? c.id })),
      reviewedCaseIds: [...reviewed],
    },
  };
}
