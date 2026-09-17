'use client';
import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight } from 'lucide-react';
import { api, Badge, date, statusNames, type Project, type Result, type Task } from './api';
import type { Notify } from './workbench';
import { type Website } from './websites';
import { WebsiteFilter } from './website-filter';
import { Pagination } from './pagination';
import { rememberedWebsite, rememberWebsite } from './case-runner';
import { browserLabels, type BrowserName } from '../../../packages/contracts/src/browser-choice';
import { executionModeLabels } from '../../../packages/contracts/src/execution-cache';
import {
  recordDurationLabel,
  type RunRecordExecution,
  type RunRecordPerformance,
} from '../../../packages/contracts/src/run-record';

type RecordRow = {
  id: string;
  status: string;
  summary: Result[];
  createdAt: string;
  parentRunId: string | null;
  websiteName: string;
  browser: BrowserName;
  caseCount: number;
  execution: RunRecordExecution;
  performance: RunRecordPerformance;
  task: { id: string; title: string; environmentId: string };
};
type Records = { rows: RecordRow[]; total: number; page: number };
export function TestRecords({
  project,
  notify,
  requestedSiteId = '',
}: {
  project: Project;
  notify: Notify;
  requestedSiteId?: string;
}) {
  const [sites, setSites] = useState<Website[]>([]),
    [website, setWebsite] = useState(requestedSiteId || rememberedWebsite(project.id));
  const [history, setHistory] = useState(false),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [ready, setReady] = useState(false);
  const [data, setData] = useState<Records | null>(null),
    [error, setError] = useState('');
  const [plans, setPlans] = useState<Task[]>([]),
    [tab, setTab] = useState('runs');
  useEffect(() => {
    let alive = true;
    api<Website[]>(`/websites?projectId=${project.id}`)
      .then((rows) => {
        if (!alive) return;
        const choices = [
          ...rows,
          ...project.environments
            .filter((e) => !rows.some((r) => r.id === e.id))
            .map((e) => ({ ...e, projectId: project.id, config: { allowedOrigins: [] } })),
        ];
        setSites(choices);
        setWebsite((old) => (choices.some((s) => s.id === old && s.enabled) ? old : ''));
        setReady(true);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);
  useEffect(() => {
    if (requestedSiteId) {
      setWebsite(requestedSiteId);
      setPage(1);
    }
  }, [requestedSiteId]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setData(null);
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const params = new URLSearchParams({
          projectId: project.id,
          website,
          search,
          filter,
          history: String(history),
          page: String(page),
          size: String(size),
        });
        const result = await api<Records>(`/test-records?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(read, 4000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [ready, project.id, website, search, filter, history, page, size]);
  useEffect(() => {
    if (tab !== 'plans') return;
    let alive = true;
    api<(Task & { environmentId: string; browserSnapshot?: { discovery?: unknown } })[]>(
      `/tasks?projectId=${project.id}`,
    )
      .then((rows) => {
        if (alive)
          setPlans(
            rows.filter(
              (t) =>
                !t.runs.length &&
                !t.debugSkillId &&
                !t.browserSnapshot?.discovery &&
                (!website || t.environmentId === website),
            ),
          );
      })
      .catch((e) => notify(e.message, true));
    return () => {
      alive = false;
    };
  }, [tab, website, project.id]);
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>测试记录</h1>
          <p>每次测试独立留档，查看执行过程、验证结果和回归记录。</p>
        </div>
        <a
          className="button primary"
          href={`#/cases${website ? `?website=${encodeURIComponent(website)}` : ''}`}
        >
          选择用例测试
          <ArrowUpRight size={16} />
        </a>
      </div>
      <div className="panel context-bar">
        <WebsiteFilter
          sites={sites}
          value={website}
          history={history}
          onChange={(v) => {
            setWebsite(v);
            rememberWebsite(project.id, v);
            setPage(1);
          }}
          onHistory={(v) => {
            setHistory(v);
            if (!v && !sites.find((s) => s.id === website)?.enabled) setWebsite('');
            setPage(1);
          }}
        />
        <a className="context-link" href="#/discoveries">
          查看探索与审核
        </a>
      </div>
      <section className="panel records-panel">
        <div className="record-toolbar">
          <div className="tabs">
            <button className={tab === 'runs' ? 'selected' : ''} onClick={() => setTab('runs')}>
              测试运行
            </button>
            <button className={tab === 'plans' ? 'selected' : ''} onClick={() => setTab('plans')}>
              未执行计划
            </button>
          </div>
          {tab === 'runs' && (
            <input
              aria-label="搜索测试记录"
              maxLength={100}
              placeholder="搜索测试名称"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          )}
        </div>
        {tab === 'runs' ? (
          <>
            <div className="record-filters" aria-label="运行结果筛选">
              {[
                ['all', '全部'],
                ['active', '进行中'],
                ['attention', '需要关注'],
                ['passed', '全部通过'],
              ].map(([id, label]) => (
                <button
                  className={'filter-chip ' + (filter === id ? 'selected' : '')}
                  key={id}
                  onClick={() => {
                    setFilter(id);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
              <span className="muted">{data ? `共 ${data.total} 次运行` : '正在读取…'}</span>
            </div>
            {error ? (
              <div className="notice error" role="alert">
                {error}
              </div>
            ) : !data ? (
              <div className="empty compact">正在加载测试记录…</div>
            ) : data.rows.length ? (
              <div className="table-scroll">
                <table className="task-table run-records">
                  <thead>
                    <tr>
                      <th>测试 / 网站</th>
                      <th>执行状态</th>
                      <th>验证结果</th>
                      <th>测试方式</th>
                      <th title="从开始执行到结束，包含浏览器准备与清理，不含排队">耗时</th>
                      <th>预估费用（元）</th>
                      <th>创建时间</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} data-run-id={r.id}>
                        <td>
                          <a className="record-title" href={`#/runs/${r.id}`}>
                            {r.task.title}
                          </a>
                          <small>
                            {r.websiteName} · {r.caseCount} 条用例{r.parentRunId ? ' · 回归' : ''} ·{' '}
                            {r.id.slice(0, 8)}
                          </small>
                        </td>
                        <td>
                          <Badge status={r.status} />
                        </td>
                        <td>
                          <div className="result-mini">
                            {r.summary.length ? (
                              ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'SKIPPED'].map((s) => {
                                const n = r.summary.filter((c) => c.result === s).length;
                                return n ? (
                                  <span key={s} className={'mini-' + s.toLowerCase()}>
                                    {statusNames[s]} {n}
                                  </span>
                                ) : null;
                              })
                            ) : (
                              <span className="muted">
                                {['QUEUED', 'RUNNING'].includes(r.status) ? '等待验证结果' : '未形成结果'}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="record-execution" title={r.execution.detail}>
                          <span
                            className={
                              r.execution.ai || r.execution.label.includes('AI')
                                ? 'record-method ai'
                                : 'record-method'
                            }
                          >
                            {r.execution.label}
                          </span>
                          <small>
                            {r.execution.mode
                              ? `策略：${executionModeLabels[r.execution.mode]}`
                              : '策略未记录'}
                          </small>
                          <small>{browserLabels[r.browser]}</small>
                        </td>
                        <td className="record-number" title="运行总耗时，包含浏览器准备与清理，不含排队">
                          {recordDurationLabel(r.performance.durationMs)}
                          {r.performance.durationState !== 'finished' && (
                            <small>
                              {r.performance.durationState === 'running'
                                ? '进行中'
                                : r.performance.durationState === 'queued'
                                  ? '排队中'
                                  : '未记录'}
                            </small>
                          )}
                        </td>
                        <td className="record-number" title={r.performance.costNote}>
                          {r.performance.costCny === null
                            ? '—'
                            : `${r.performance.costStatus === 'partial' ? '≥' : r.performance.costStatus === 'reference' ? '≈' : ''}¥${r.performance.costCny.toFixed(6)}`}
                          <small>
                            {r.performance.costCny === null
                              ? r.status === 'QUEUED'
                                ? '待执行'
                                : '未记录 / 未定价'
                              : r.performance.costStatus === 'partial'
                                ? '部分计价'
                                : r.performance.costStatus === 'reference'
                                  ? '参考估算'
                                  : r.performance.durationState === 'running'
                                    ? '当前累计'
                                    : '人民币估算'}
                          </small>
                        </td>
                        <td className="muted nowrap">{date(r.createdAt)}</td>
                        <td>
                          <a className="button outline" href={`#/runs/${r.id}`}>
                            {['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(r.status)
                              ? '查看进度'
                              : '查看结果'}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                <Activity size={28} />
                <h3>暂无符合条件的测试记录</h3>
                <p>在用例库中选择用例执行，过程和结果会显示在这里。</p>
              </div>
            )}
            {data && (
              <Pagination
                label="记录"
                total={data.total}
                page={data.page}
                size={size}
                onPage={setPage}
                onSize={(v) => {
                  setSize(v);
                  setPage(1);
                }}
              />
            )}
          </>
        ) : (
          <div className="pending-plans">
            {plans.length ? (
              plans.map((t) => (
                <a className="pending-plan" key={t.id} href={`#/tasks/${t.id}`}>
                  <strong>{t.title}</strong>
                  <Badge status={t.status} />
                  <span>查看计划 →</span>
                </a>
              ))
            ) : (
              <div className="empty compact">暂无未执行计划。通常可以直接从用例库运行测试。</div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
