'use client';
import { useEffect, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { api, date, Badge, type Result, type Run } from './api';
import { resultMetrics, type CaseHistoryPoint } from '../../../packages/contracts/src/case-metrics';
import { executionModeLabels, type ExecutionMode } from '../../../packages/contracts/src/execution-cache';
type History = { items: CaseHistoryPoint[]; nextCursor: string | null };
const money = (v: number | null) => (v === null ? '未记录 / 未定价' : `¥${v.toFixed(6)}`);
function Trend({
  items,
  metric,
  label,
}: {
  items: CaseHistoryPoint[];
  metric: 'durationMs' | 'tokens' | 'costCny';
  label: string;
}) {
  const points = [...items].reverse();
  const values = points.map((p) =>
    metric === 'tokens'
      ? p.inputTokens === null || p.outputTokens === null
        ? null
        : p.inputTokens + p.outputTokens
      : metric === 'durationMs'
        ? p.durationMs / 1000
        : p.costCny,
  );
  const max = Math.max(...values.filter((v): v is number => v !== null), 0.001);
  const coord = (v: number, i: number) =>
    `${38 + (points.length === 1 ? 144 : (i * 288) / (points.length - 1))},${110 - (v / max) * 82}`;
  const segments: string[] = [];
  let segment = '';
  values.forEach((v, i) => {
    if (v === null) {
      if (segment) segments.push(segment);
      segment = '';
    } else segment += `${coord(v, i)} `;
  });
  if (segment) segments.push(segment);
  return (
    <figure className="case-trend">
      <figcaption>{label}</figcaption>
      {!values.some((v) => v !== null) ? (
        <p className="muted">暂无可用记录</p>
      ) : (
        <svg
          viewBox="0 0 352 144"
          role="img"
          aria-label={`${label}，按运行先后排列。悬停查看数值，点击数据点查看报告。`}
        >
          <line x1="38" x2="326" y1="110" y2="110" stroke="currentColor" opacity=".2" />
          <line x1="38" x2="326" y1="28" y2="28" stroke="currentColor" opacity=".1" strokeDasharray="3 3" />
          <text x="34" y="22" fontSize="10">
            {metric === 'costCny'
              ? `¥${max.toFixed(6)}`
              : max.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}
          </text>
          {segments.map((s, i) => (
            <polyline key={i} points={s} fill="none" stroke="var(--primary, #127e6a)" strokeWidth="2" />
          ))}
          {values.map((v, i) =>
            v === null ? null : (
              <a
                key={points[i].runId}
                href={`#/runs/${points[i].runId}`}
                aria-label={`${date(points[i].finishedAt)}，${label} ${v}`}
              >
                <circle
                  cx={coord(v, i).split(',')[0]}
                  cy={coord(v, i).split(',')[1]}
                  r="4"
                  fill={points[i].result === 'PASS' ? '#127e6a' : '#b65b44'}
                >
                  <title>
                    {date(points[i].finishedAt)} ·{' '}
                    {metric === 'costCny'
                      ? money(v)
                      : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}{' '}
                    · {points[i].result} · v{points[i].revision}
                  </title>
                </circle>
              </a>
            ),
          )}
          <text x="38" y="132" fontSize="10">
            {date(points[0].finishedAt)}
          </text>
          <text x="326" y="132" textAnchor="end" fontSize="10">
            {date(points.at(-1)!.finishedAt)}
          </text>
        </svg>
      )}
    </figure>
  );
}
export function CasePerformance({ run, result }: { run: Run; result: Result }) {
  const [expanded, setExpanded] = useState(false),
    [history, setHistory] = useState<History | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [browser, setBrowser] = useState(run.manifest.browser?.name ?? '');
  const m = resultMetrics(result, run.usage, run.manifest.plan.cases.length);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setBusy(true);
    setHistory(null);
    setError('');
    api<History>(`/web-cases/${result.caseId}/history${browser ? `?browserName=${browser}` : ''}`)
      .then((v) => {
        if (alive) setHistory(v);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [expanded, result.caseId, run.finishedAt, browser, reload]);
  async function more() {
    if (!history?.nextCursor) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<History>(
        `/web-cases/${result.caseId}/history?cursor=${history.nextCursor}${browser ? `&browserName=${browser}` : ''}`,
      );
      setHistory((old) =>
        old
          ? {
              items: [...old.items, ...next.items.filter((p) => !old.items.some((o) => o.runId === p.runId))],
              nextCursor: next.nextCursor,
            }
          : next,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="case-performance">
      <div className="case-metric-row">
        <div>
          <span>用例耗时</span>
          <strong>
            {(m.durationMs / 1000).toFixed(2)} <small>秒</small>
          </strong>
        </div>
        <div>
          <span>Token</span>
          <strong>
            {m.inputTokens === null || m.outputTokens === null
              ? '未记录'
              : (m.inputTokens + m.outputTokens).toLocaleString()}
          </strong>
          <small>{m.inputTokens !== null && `输入 ${m.inputTokens} · 输出 ${m.outputTokens}`}</small>
        </div>
        <div>
          <span>预估模型费用 · 人民币</span>
          <strong>{money(m.costCny)}</strong>
        </div>
        <div>
          <span>模型调用</span>
          <strong>
            {m.modelCalls ?? '未记录'} <small>次</small>
          </strong>
        </div>
        <button className="button outline" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          <ChartNoAxesCombined size={18} />
          {expanded ? '收起历史趋势' : '历史趋势'}
        </button>
      </div>
      <p className="case-metric-note">
        {m.source === 'single-run'
          ? '旧记录：Token 与费用取自该次单用例运行。'
          : m.source === 'unavailable'
            ? '旧批量运行未记录单用例 Token 和费用。'
            : '包含此用例的登录准备、操作、验证与清理；费用按运行时定价快照估算。'}
      </p>
      {expanded && (
        <section className="case-history" aria-label="用例执行历史趋势">
          <div className="case-history-heading">
            <div>
              <h3>此用例的执行趋势</h3>
              <p>按运行先后排列；包含不同用例版本。点击数据点查看报告，缺失数据不连线。</p>
            </div>
            <label>
              浏览器
              <select value={browser} onChange={(e) => setBrowser(e.target.value)}>
                <option value="">全部浏览器</option>
                <option value="chrome">Chrome</option>
                <option value="edge">Edge</option>
                <option value="firefox">Firefox</option>
              </select>
            </label>
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button onClick={() => setReload((v) => v + 1)}>重试</button>
            </div>
          )}
          {!history && busy ? (
            <p>正在读取历史记录…</p>
          ) : history && !history.items.length ? (
            <p>尚无已结束的历史运行。</p>
          ) : (
            history && (
              <>
                <div className="case-trends">
                  <Trend items={history.items} metric="durationMs" label="耗时 · 秒" />
                  <Trend items={history.items} metric="tokens" label="Token · 输入 + 输出" />
                  <Trend items={history.items} metric="costCny" label="预估费用 · 人民币" />
                </div>
                <details>
                  <summary>查看 {history.items.length} 次运行明细</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>运行时间</th>
                          <th>结果</th>
                          <th>版本 / 浏览器</th>
                          <th>策略</th>
                          <th>耗时</th>
                          <th>Token</th>
                          <th>费用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.items.map((p) => (
                          <tr key={p.runId}>
                            <td>
                              <a href={`#/runs/${p.runId}`}>{date(p.finishedAt)}</a>
                              {p.runId === run.id && ' · 本次'}
                            </td>
                            <td>
                              <Badge status={p.result} />
                            </td>
                            <td>
                              v{p.revision} · {p.browser}
                            </td>
                            <td>
                              {executionModeLabels[p.mode as ExecutionMode] ?? p.mode}
                              <small>
                                L2 {p.l2Hits} / L1 {p.l1Hits}
                              </small>
                            </td>
                            <td>{(p.durationMs / 1000).toFixed(2)} 秒</td>
                            <td>
                              {p.inputTokens === null || p.outputTokens === null
                                ? '未记录'
                                : (p.inputTokens + p.outputTokens).toLocaleString()}
                            </td>
                            <td>{money(p.costCny)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                {history.nextCursor && (
                  <button className="button outline" disabled={busy} onClick={more}>
                    {busy ? '正在读取…' : '加载更早的 30 次'}
                  </button>
                )}
              </>
            )
          )}
        </section>
      )}
    </div>
  );
}
