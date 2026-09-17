'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Monitor, Loader2, CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import { api, Badge, TERMINAL, type Result, type Run } from './api';
import { browserLabels } from '../../../packages/contracts/src/browser-choice';
import { executionModeLabels } from '../../../packages/contracts/src/execution-cache';
import { CasePerformance } from './case-performance';
import { CacheDiff, CacheInspector } from './cache-inspector';
import { assertionLabel } from '../../../packages/contracts/src/static-ui';
import { stepCapability, assertionCapability } from '../../../packages/contracts/src/static-capability';
export type ProgressEvent = {
  seq: string;
  kind: string;
  payload: {
    label?: string;
    message?: string;
    caseId?: string;
    title?: string;
    index?: number;
    phase?: string;
    passed?: boolean;
    tier?: string;
    outcome?: string;
    operation?: number;
  };
};
type Frame = { caseId: string; capturedAt: string; phase: string; image?: string };
function OperationRoute({
  trace,
  operation,
  fallback,
}: {
  trace: ProgressEvent[];
  operation: number;
  fallback: string;
}) {
  const routes = trace.filter(
    (e) => e.kind === 'cache.route' && e.payload.phase === 'case' && e.payload.operation === operation,
  );
  const hits = [...new Set(routes.filter((e) => e.payload.outcome === 'hit').map((e) => e.payload.tier))];
  const labels: Record<string, string> = {
    L2: '二级静态执行 · 无模型调用',
    L1: '一级缓存执行',
    AI: '已使用 AI 实时推理',
  };
  return (
    <small
      className={`execution-capability ${hits.includes('AI') ? 'ai' : hits.length ? 'static' : 'learn'}`}
      title={routes.map((e) => e.payload.message).join('\n')}
    >
      {hits.length
        ? hits.map((t) => labels[t!] ?? t).join(' → ')
        : (routes.at(-1)?.payload.message ?? fallback)}
    </small>
  );
}
function shotLabel(name: string) {
  const step = name.match(/step-(\d+)/),
    assertion = name.match(/assert-(\d+)/);
  return step
    ? `步骤 ${step[1]}`
    : assertion
      ? `验证 ${assertion[1]}`
      : name.includes('final')
        ? '结束画面'
        : '页面截图';
}
export function RunMonitor({
  run,
  events,
  renderResult,
}: {
  run: Run;
  events: ProgressEvent[];
  renderResult?: (result: Result) => ReactNode;
}) {
  const browserLabel = run.manifest.browser ? browserLabels[run.manifest.browser.name] : '浏览器';
  const terminal = TERMINAL.has(run.status);
  const [frame, setFrame] = useState<Frame | null>(null),
    [cacheTier, setCacheTier] = useState<'L1' | 'L2' | null>(null),
    [previewError, setPreviewError] = useState(''),
    [chosenCase, setChosenCase] = useState(''),
    [shotId, setShotId] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true,
      reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const data = await api<{ frame: Frame | null }>(`/runs/${run.id}/preview`);
        if (alive) {
          setFrame(data.frame);
          setPreviewError('');
          setNow(Date.now());
        }
      } catch {
        if (alive) {
          setPreviewError('画面暂时无法更新，正在重试');
          setNow(Date.now());
        }
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = terminal ? undefined : setInterval(() => void read(), 2000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [run.id, terminal]);
  const latestCase = [...events].reverse().find((e) => e.kind === 'case.started')?.payload.caseId;
  const currentId =
    chosenCase ||
    (!terminal ? latestCase : run.summary.find((r) => r.result !== 'PASS')?.caseId) ||
    run.manifest.plan.cases[0]?.id;
  const spec = run.manifest.plan.cases.find((c) => c.id === currentId);
  const result = run.summary.find((r) => r.caseId === currentId);
  const trace = events.filter((e) => e.payload.caseId === currentId);
  const staticDispatches = trace.filter(
    (e) => e.kind === 'midscene.action' && e.payload.tier === 'L2',
  ).length;
  const shots = run.evidence.filter((e) => e.caseId === currentId && e.kind === 'screenshot');
  const shot =
    shots.find((e) => e.id === shotId) || (terminal || currentId !== latestCase ? shots.at(-1) : undefined);
  const live = !shot && !terminal && frame?.caseId === currentId && frame?.phase === 'browser';
  const source = shot
    ? `/api/evidence/${shot.id}`
    : live && frame?.image
      ? `data:image/jpeg;base64,${frame.image}`
      : undefined;
  const lastAction = [...trace]
    .reverse()
    .find((e) => ['action.started', 'action.completed', 'action.error'].includes(e.kind));
  const stale = frame && now - Date.parse(frame.capturedAt) > 10000;
  return (
    <section className="panel run-monitor">
      <div className="panel-heading">
        <div>
          <h2>{terminal ? '测试结果与过程' : '正在执行 · 浏览器与步骤'}</h2>
          <p>
            {terminal
              ? '选择用例和关键截图，核对每一步及验证结果。'
              : `真实 ${browserLabel} 画面约每 2 秒更新，复杂操作可能需要等待模型处理。`}
          </p>
        </div>
        <Monitor size={22} />
      </div>
      <div className="monitor-cases">
        {run.manifest.plan.cases.map((c) => {
          const r = run.summary.find((s) => s.caseId === c.id);
          return (
            <button
              key={c.id}
              className={`button ${c.id === currentId ? 'primary' : 'outline'}`}
              onClick={() => {
                setChosenCase(c.id);
                setShotId('');
              }}
            >
              <span>{c.title}</span>
              {r ? <Badge status={r.result} /> : <small>{latestCase === c.id ? '执行中' : '等待执行'}</small>}
            </button>
          );
        })}
        {chosenCase && !terminal && (
          <button
            className="button outline"
            onClick={() => {
              setChosenCase('');
              setShotId('');
            }}
          >
            跟随当前用例
          </button>
        )}
      </div>
      {result && spec?.browser && (
        <CasePerformance key={`${run.id}-${result.caseId}`} run={run} result={result} />
      )}
      <div className="monitor-grid">
        <div className="monitor-screen">
          <div className="screen-caption">
            <strong>{shot ? shotLabel(shot.fileName) : terminal ? '执行已结束' : '实时浏览器'}</strong>
            <span>
              {live && frame
                ? `${new Date(frame.capturedAt).toLocaleTimeString()}${stale ? ' · 画面尚未更新' : ''}`
                : browserLabel}
            </span>
          </div>
          {source ? (
            <a href={source} target="_blank" rel="noreferrer">
              <img src={source} alt={`${spec?.title || '测试'} ${shot ? '步骤截图' : '实时浏览器画面'}`} />
            </a>
          ) : (
            <div className="preview-empty">
              {!terminal && <Loader2 className="spin" />}
              <strong>
                {frame?.caseId === currentId && frame?.phase === 'authentication' && !terminal
                  ? '正在准备登录身份 · 凭据画面已隐藏'
                  : terminal
                    ? '此用例未保存可用画面'
                    : latestCase === currentId
                      ? '正在打开网页，等待首帧画面'
                      : '等待此用例开始'}
              </strong>
            </div>
          )}
          {previewError && !terminal && <p className="notice warning">{previewError}</p>}
          <div className="frame-strip">
            {!terminal && (
              <button className={!shotId ? 'selected' : ''} onClick={() => setShotId('')}>
                实时画面
              </button>
            )}
            {shots.map((e) => (
              <button
                className={shot?.id === e.id ? 'selected' : ''}
                key={e.id}
                onClick={() => setShotId(e.id)}
              >
                {shotLabel(e.fileName)}
              </button>
            ))}
          </div>
        </div>
        <div className="monitor-steps">
          <h3>{spec?.title}</h3>
          <p className="current-action" aria-live="polite">
            {result
              ? result.message
              : lastAction
                ? `${lastAction.kind === 'action.started' ? '正在：' : lastAction.kind === 'action.error' ? '中断：' : '已完成：'}${lastAction.payload.label}`
                : '等待执行引擎'}
          </p>
          <h4>操作步骤</h4>
          {result?.execution && (
            <div className="cache-summary">
              <strong>{executionModeLabels[result.execution.mode]} · 本次执行</strong>
              <p>
                二级静态执行 {result.execution.l2Hits} 项 · 一级缓存命中 {result.execution.l1Hits} 项 ·
                实时推理 {result.execution.aiOperations} 步
              </p>
              {!!result.execution.l2Direct && (
                <small>其中 {result.execution.l2Direct} 项按结构化配置直接执行，无需首次 AI 生成缓存。</small>
              )}
              {(result.execution.l2Replayed ?? 0) > 0 && (
                <p>
                  已静态执行 {result.execution.l2Replayed} 步；
                  {result.execution.validationVersion === 'semantic-v1'
                    ? '操作按目标语义和本次参数校验，业务结果每次重新验证。'
                    : '仅基线校验通过的步骤计为命中（旧版机制）。'}
                </p>
              )}
              {result.execution.l2Replayed === undefined && staticDispatches > 0 && (
                <p>已派发 {staticDispatches} 次静态 UI 动作；结果基线未通过时仍会回退，不计完整命中。</p>
              )}
              <small>
                {result.execution.bypassReason ??
                  (result.execution.published
                    ? result.execution.changes
                      ? result.execution.changes.length
                        ? `缓存更新 ${result.execution.changes.length} 处`
                        : '缓存内容未变化，已续期'
                      : '验证通过，已更新适用缓存'
                    : '未发布新缓存')}{' '}
                · 缓存失效回退 {result.execution.fallbacks} 次
              </small>
              {result.execution.aiOperations > 0 && (
                <details>
                  <summary>为什么本次仍使用 AI（{result.execution.aiOperations} 个环节）</summary>
                  <p className="muted">
                    缓存缺失或条件尚不能静态表达，也会使用
                    AI；不计入“缓存失效回退”。环节数不等于模型调用次数。
                  </p>
                  {result.execution.aiReasons?.length ? (
                    <ul>
                      {result.execution.aiReasons.map((r, i) => (
                        <li key={i}>
                          {r.phase === 'authentication' ? '登录准备' : '用例'} · {r.label}：{r.reason}
                          {r.learned && <strong> · 已沉淀静态条件</strong>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">此历史运行未记录详细分类，请展开下方缓存过程查看。</p>
                  )}
                </details>
              )}
              <div className="button-group">
                <button className="text-link" onClick={() => setCacheTier('L1')}>
                  查看一级缓存
                </button>
                <button className="text-link" onClick={() => setCacheTier('L2')}>
                  查看二级缓存
                </button>
              </div>
              {!!result.execution.changes?.length && (
                <details>
                  <summary>本次更新了哪些内容</summary>
                  <CacheDiff changes={result.execution.changes} />
                </details>
              )}
            </div>
          )}
          {!terminal && trace.some((e) => e.kind === 'cache.route') && (
            <p className="muted" aria-live="polite">
              {[...trace].reverse().find((e) => e.kind === 'cache.route')?.payload.message}
            </p>
          )}
          {trace.some((e) => e.kind === 'cache.route') && (
            <details className="cache-trace">
              <summary>查看缓存命中与回退过程</summary>
              {trace
                .filter((e) => e.kind === 'cache.route')
                .map((e) => (
                  <p key={e.seq}>
                    <strong>
                      {e.payload.tier}
                      {e.payload.operation
                        ? ` · ${e.payload.phase === 'authentication' ? '登录' : '用例'}操作 ${e.payload.operation}`
                        : ''}
                    </strong>
                    {e.payload.label && <small>{e.payload.label}</small>} · {e.payload.message}
                  </p>
                ))}
            </details>
          )}
          {spec?.browser ? (
            <ol className="step-list">
              {spec.browser.steps.map((s, index) => {
                const state = [...trace]
                  .reverse()
                  .find(
                    (e) =>
                      e.payload.phase === 'case' && e.payload.index === index && e.kind.startsWith('step.'),
                  );
                const done = state?.kind === 'step.completed',
                  failed = state?.kind === 'step.error',
                  running = state?.kind === 'step.started' && !terminal;
                return (
                  <li key={index} className={failed ? 'failed' : done ? 'done' : ''}>
                    {done ? (
                      <CheckCircle2 size={17} />
                    ) : failed ? (
                      <AlertCircle size={17} />
                    ) : running ? (
                      <Loader2 className="spin" size={17} />
                    ) : (
                      <Circle size={17} />
                    )}
                    <div>
                      <strong>
                        {index + 1}. {s.text}
                      </strong>
                      <OperationRoute
                        trace={trace}
                        operation={index + 1}
                        fallback={stepCapability(s).label}
                      />
                      <small>
                        {done
                          ? '操作完成'
                          : failed
                            ? state.payload.message || '操作中断'
                            : running
                              ? '执行中'
                              : terminal
                                ? '未完成 / 无完成记录'
                                : '待执行'}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <ol>
              {spec?.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
          {spec?.browser && !spec.browser.steps.length && (
            <p className="muted">
              {spec.browser.verifySessionOnly ? '使用登录配置建立会话后直接验证' : '打开页面后直接验证'}
            </p>
          )}
          <h4>验证结果</h4>
          <ul className="step-list">
            {(spec?.browser?.assertions || [spec?.expected || '']).map((label, index) => {
              const check = [...trace]
                .reverse()
                .find((e) => e.payload.index === index && e.kind.startsWith('assertion.'));
              const passed =
                check?.kind === 'assertion.completed'
                  ? check.payload.passed
                  : result?.assertions[index]?.passed;
              return (
                <li key={index} className={passed === false ? 'failed' : passed ? 'done' : ''}>
                  {passed === undefined ? (
                    <Circle size={17} />
                  ) : passed ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <AlertCircle size={17} />
                  )}
                  <div>
                    <strong>{assertionLabel(label)}</strong>
                    <OperationRoute
                      trace={trace}
                      operation={(spec?.browser?.steps.length ?? 0) + index + 1}
                      fallback={assertionCapability(label).label}
                    />
                    <small>
                      {passed === undefined
                        ? !terminal && check?.kind === 'assertion.started'
                          ? '正在验证'
                          : '尚未验证'
                        : passed
                          ? '验证通过'
                          : '验证不成立'}
                    </small>
                    {check?.payload.message && <small>{check.payload.message}</small>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {result && renderResult && <div className="monitor-result">{renderResult(result)}</div>}
      {cacheTier && result?.execution?.key && (
        <CacheInspector
          id={result.execution.key}
          initialTier={cacheTier}
          onClose={() => setCacheTier(null)}
        />
      )}
    </section>
  );
}
