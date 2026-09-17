'use client';
import { OutcomeReviewHistory } from './outcome-review';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  Square,
  Activity,
  BookOpen,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import {
  api,
  post,
  patch,
  go,
  date,
  Badge,
  TERMINAL,
  statusNames,
  type Project,
  type Meta,
  type Knowledge,
  type Skill,
  type Task,
  type Run,
  type Result,
} from './api';
import type { Notify } from './workbench';
import { FeedbackList } from './feedback';
import { RunCost } from './model-pricing';
import type { Feature } from './websites';
import { RunMonitor, type ProgressEvent } from './run-monitor';
import { browserLabels, type BrowserName } from '../../../packages/contracts/src/browser-choice';
import { BrowserSelect } from './browser-select';
import { ExecutionModeSelect } from './execution-mode';
import type { ExecutionMode } from '../../../packages/contracts/src/execution-cache';
export function NewTask({ project, meta, notify }: { project: Project; meta: Meta; notify: Notify }) {
  const [webFeatures, setWebFeatures] = useState<Feature[]>([]),
    [caseIds, setCaseIds] = useState<string[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]),
    [skills, setSkills] = useState<Skill[]>([]),
    [env, setEnv] = useState(project.environments[0]?.id || ''),
    [release, setRelease] = useState(''),
    [skill, setSkill] = useState(''),
    [goal, setGoal] = useState(''),
    [mode, setMode] = useState(meta.model.configured ? meta.model.defaultMode : 'catalog'),
    [maxActions, setMaxActions] = useState(100),
    [busy, setBusy] = useState(false);
  const custom = project.environments.find((e) => e.id === env)?.adapter === 'midscene-web-v1';
  const [browserName, setBrowserName] = useState<BrowserName>('chrome');
  useEffect(
    () => setBrowserName(project.environments.find((e) => e.id === env)?.config.browser ?? 'chrome'),
    [env],
  );
  useEffect(() => {
    setCaseIds([]);
    setWebFeatures([]);
    if (custom)
      void api<Feature[]>(`/websites/${env}/features`)
        .then(setWebFeatures)
        .catch((e) => notify(e.message, true));
  }, [env, custom]);
  useEffect(() => {
    Promise.all([
      api<Knowledge[]>(`/knowledge/releases?projectId=${project.id}`),
      api<Skill[]>(`/skills?projectId=${project.id}`),
    ])
      .then(([k, s]) => {
        setKnowledge(k);
        setRelease(k.find((v) => v.content.rules.some((r) => r.id === 'R01'))?.id || k[0]?.id || '');
        setSkills(s);
      })
      .catch((e) => notify(e.message, true));
  }, [project.id]);
  return (
    <>
      <button className="back" onClick={() => go('tasks')}>
        <ArrowLeft size={16} />
        返回工作台
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试目标与执行范围</div>
          <h1>创建测试任务</h1>
          <p>告诉 Agent 要验证什么，执行前您可以检查和调整计划。</p>
        </div>
        <span className="step-label">01 输入目标 → 02 确认计划 → 03 执行验证</span>
      </div>
      <form
        className="create-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const t = await post<Task>('/tasks', {
              projectId: project.id,
              environmentId: env,
              browserName,
              knowledgeReleaseId: custom ? undefined : release,
              skillReleaseId: custom ? undefined : skill || undefined,
              caseIds: custom ? caseIds : undefined,
              goal,
              mode,
              budget: { timeoutMs: 600000, maxActions, maxModelCalls: 60, maxTokens: 150000, maxCostUsd: 1 },
            });
            await post(`/tasks/${t.id}/plans`);
            go(`tasks/${t.id}`);
          } catch (e) {
            notify((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <section className="panel form-panel">
          <div className="section-number">
            01 <span>测试目标</span>
          </div>
          <label htmlFor="goal">您希望验证什么？</label>
          <textarea
            id="goal"
            className="goal-input"
            placeholder="例如：验证申请提交后，另一位审批人能正常审批通过，并检查实际保存的状态与审批记录。"
            minLength={4}
            maxLength={4000}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            required
          />
          <div className="field-hint">
            <span>描述业务目标、角色和关注的风险。</span>
            <span>{goal.length}/4000</span>
          </div>
          {!custom && (
            <div className="prompt-suggestions">
              {[
                '验证申请创建、提交和审批的正常流程',
                '验证自审批、角色权限和跨租户隔离',
                '验证表单标题和金额边界',
                '验证重复提交只生效一次',
              ].map((text) => (
                <button type="button" key={text} onClick={() => setGoal(text)}>
                  {text}
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          )}
          <div className="section-number section-spaced">
            02 <span>执行上下文</span>
          </div>
          <div className="field-row">
            <div>
              <label htmlFor="environment">测试环境</label>
              <select id="environment" value={env} onChange={(e) => setEnv(e.target.value)} required>
                {project.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <BrowserSelect id="task-browser" value={browserName} onChange={setBrowserName} disabled={busy} />
            {!custom && (
              <div>
                <label htmlFor="knowledge">知识快照</label>
                <select id="knowledge" value={release} onChange={(e) => setRelease(e.target.value)} required>
                  {knowledge
                    .filter((k) => k.content.rules.some((r) => /^R\d+/.test(r.id)))
                    .map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name} · v{k.version}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
          {custom && (
            <div className="website-case-picker">
              <label>本次测试用例（最多 12 条）</label>
              {webFeatures
                .filter((f) => f.enabled)
                .map((f) => (
                  <div key={f.id}>
                    <h4>{f.name}</h4>
                    {f.cases
                      .filter((c) => c.enabled)
                      .map((c) => (
                        <label className="inline-check" key={c.id}>
                          <input
                            type="checkbox"
                            checked={caseIds.includes(c.id)}
                            onChange={(e) =>
                              setCaseIds(
                                e.target.checked ? [...caseIds, c.id] : caseIds.filter((id) => id !== c.id),
                              )
                            }
                          />
                          {c.title}
                          <small className="muted">v{c.revision}</small>
                        </label>
                      ))}
                  </div>
                ))}
              {!webFeatures.some((f) => f.enabled && f.cases.some((c) => c.enabled)) && (
                <p>
                  此网站还没有可执行用例。
                  <button type="button" className="button outline" onClick={() => go('cases')}>
                    添加功能与用例
                  </button>
                </p>
              )}
              <small className="muted">
                知识快照由所选用例的前置条件和预期生成。页面断言由 Midscene 执行。
              </small>
            </div>
          )}
          {!custom && (
            <>
              <label htmlFor="skill">
                测试 Skill <span className="muted">可选</span>
              </label>
              <select id="skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">根据测试目标规划</option>
                {skills
                  .filter((s) => s.activeReleaseId)
                  .map((s) => (
                    <option key={s.id} value={s.activeReleaseId!}>
                      {s.name} · v{s.releases.find((r) => r.id === s.activeReleaseId)?.version}
                    </option>
                  ))}
              </select>
              <small className="muted">只显示已发布的 Skill。草稿请在技能库隔离调试。</small>
            </>
          )}
          <div className="field-row">
            <div>
              <label htmlFor="mode">计划生成方式</label>
              <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="deepagents" disabled={!meta.model.configured}>
                  Deep Agents · {meta.model.name}
                  {!meta.model.configured ? '（未配置）' : ''}
                </option>
                <option value="catalog">用例计划 · 按所选范围执行</option>
              </select>
            </div>
            <div>
              <label htmlFor="max-actions">工具动作上限</label>
              <input
                id="max-actions"
                type="number"
                min={1}
                max={500}
                value={maxActions}
                onChange={(e) => setMaxActions(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="form-footer">
            <span className="muted">最长执行 10 分钟，可在运行中取消。</span>
            <button
              className="button primary"
              disabled={busy || !env || (custom ? !caseIds.length || caseIds.length > 12 : !release)}
            >
              {busy ? <Loader2 size={17} className="spin" /> : <Play size={17} />}生成测试计划
            </button>
          </div>
        </section>
        <aside className="context-column">
          <div className="panel context-card">
            <span className="context-icon">
              <BookOpen size={23} />
            </span>
            <h3>带着领域知识工作</h3>
            <p>
              {custom
                ? '计划锁定用例、预期和登录配置版本。UI 操作与页面断言由 Midscene 执行，后台业务证据需单独接入。'
                : '计划绑定固定的规则快照、工具和 Skill 版本。关键业务结论由独立程序断言核验。'}
            </p>
            <ul className="check-list">
              <li>
                <Check size={15} />
                读取已发布的业务规则
              </li>
              <li>
                <Check size={15} />
                明确角色和业务对象
              </li>
              <li>
                <Check size={15} />
                逐项关联动作与断言
              </li>
              <li>
                <Check size={15} />
                保留证据与未知状态
              </li>
            </ul>
          </div>
          <div className="sample-note">
            <Shield size={20} />
            <div>
              <strong>{custom ? 'Midscene 操作您的网站' : '当前为独立样例系统'}</strong>
              <p>
                {!custom
                  ? '会真实操作浏览器、创建隔离数据并查询数据库结果。样例验证不代表企业业务接入已验收。'
                  : '执行前请确认角色、对象和环境范围。'}
              </p>
            </div>
          </div>
          {mode === 'catalog' && (
            <div className="notice">
              用例计划不调用规划模型；执行时仍由 Midscene 调用视觉模型操作和验证页面。
            </div>
          )}
        </aside>
      </form>
    </>
  );
}
export function TaskDetail({ id, meta, notify }: { id: string; meta: Meta; notify: Notify }) {
  const [task, setTask] = useState<Task | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [vision, setVision] = useState(false);
  const key = useRef('');
  if (!key.current && typeof window !== 'undefined') key.current = crypto.randomUUID();
  useEffect(() => {
    let alive = true;
    const read = () =>
      api<Task>(`/tasks/${id}`)
        .then((t) => {
          if (alive) setTask(t);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    void read();
    const timer = setInterval(read, 1800);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  const row = task?.plans?.[0],
    plan = row?.content;
  useEffect(() => {
    if (row) {
      setSelected(row.content.cases.map((c) => c.id));
      setVision(row.content.vision);
      key.current = crypto.randomUUID();
    }
  }, [row?.revision]);
  if (error) return <div className="notice error">{error}</div>;
  if (!task)
    return (
      <div className="empty">
        <Loader2 className="spin" />
        正在读取任务
      </div>
    );
  const latest = task.runs?.[0],
    editable = task.status === 'AWAITING_APPROVAL';
  async function regenerate() {
    setBusy(true);
    try {
      await post(`/tasks/${id}/plans`);
      setTask(await api<Task>(`/tasks/${id}`));
      notify('已提交计划生成');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    try {
      let revision = row!.revision;
      if (selected.length !== plan!.cases.length || vision !== plan!.vision) {
        const revised = await patch<{ revision: number }>(`/tasks/${id}/plans/${revision}`, {
          caseIds: selected,
          vision,
        });
        revision = revised.revision;
      }
      const run = await post<Run>(`/tasks/${id}/runs`, { revision, idempotencyKey: key.current });
      go(`runs/${run.id}`);
    } catch (e) {
      notify((e as Error).message, true);
      setTask(await api<Task>(`/tasks/${id}`));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="back" onClick={() => go('tasks')}>
        <ArrowLeft size={16} />
        返回工作台
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试计划确认</div>
          <h1 className="task-title">{task.title}</h1>
          <p>
            任务 {task.id.slice(0, 8)} · {date(task.createdAt)} ·{' '}
            {task.mode === 'deepagents' ? 'Agent 规划' : '目录计划'}
          </p>
        </div>
        <Badge status={task.status} />
      </div>
      <div className="goal-summary">
        <span>
          <FileText size={18} />
          原始测试目标
        </span>
        <p>{task.goal}</p>
        <div className="chips">
          <span>知识 {task.knowledgeReleaseId}</span>
          <span>
            {task.debugSkillId
              ? 'Skill 草稿调试'
              : task.skillReleaseId
                ? `Skill ${task.skillReleaseId.slice(0, 12)}`
                : '未指定 Skill'}
          </span>
          <span>
            最多 {task.budget.maxActions} 个动作 · {task.budget.timeoutMs / 60000} 分钟
          </span>
          <span>角色按场景固定：申请人 / 审批人</span>
        </div>
      </div>
      {task.error && (
        <div className="notice error">
          <AlertCircle size={18} />
          <div>
            <strong>任务需要处理</strong>
            <p>{task.error}</p>
            <button className="button outline" disabled={busy} onClick={regenerate}>
              重新生成计划
            </button>
          </div>
        </div>
      )}
      {task.status === 'PLANNING' && (
        <section className="panel planning">
          <span className="planning-orbit">
            <LayersIcon />
          </span>
          <h2>正在组织测试计划</h2>
          <p>读取知识、关联场景与独立断言。计划生成后等待您确认。</p>
          <div className="muted">
            <Loader2 size={16} className="spin" />
            可以离开页面，稍后从任务列表继续。
          </div>
        </section>
      )}
      {plan && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  测试计划 <span className="version">revision {row!.revision}</span>
                </h2>
                <p>{plan.summary}</p>
              </div>
              <span className="method-tag">{plan.cases.length} 个场景</span>
            </div>
            {plan.missingRequirements.length > 0 && (
              <div className="notice error">缺少关键依据：{plan.missingRequirements.join('；')}</div>
            )}
            <div className="plan-list">
              {plan.cases.map((c) => (
                <label className={'plan-item ' + (selected.includes(c.id) ? 'chosen' : '')} key={c.id}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${c.id}`}
                    checked={selected.includes(c.id)}
                    disabled={!editable}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, c.id] : old.filter((x) => x !== c.id),
                      )
                    }
                  />
                  <div className="plan-content">
                    <div className="plan-title">
                      <span className="case-code">{c.id}</span>
                      <strong>{c.title}</strong>
                      <span className="category">{c.category}</span>
                    </div>
                    <p>{c.reason}</p>
                    <div className="steps">
                      {c.steps.map((s, i) => (
                        <span key={s}>
                          {i + 1}. {s}
                          {i < c.steps.length - 1 && <ChevronRight size={12} />}
                        </span>
                      ))}
                    </div>
                    <div className="expectation">
                      <Shield size={15} />
                      <span>预期：{c.expected}</span>
                    </div>
                    <div className="rule-links">
                      {c.ruleIds.map((id) => (
                        <span key={id}>{id}</span>
                      ))}
                      <small>来自已锁定规则快照</small>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </section>
          <div className="confirmation-bar">
            <div>
              <strong>{editable ? `已选择 ${selected.length} 个场景` : '计划已锁定'}</strong>
              <small>规则与断言不可由 Agent 或运行过程改写。</small>
              <small>
                UI 操作统一使用 Midscene · {meta.vision.configured ? meta.vision.name : '尚未配置视觉模型'}
              </small>
            </div>
            <div className="button-group">
              {editable && (
                <>
                  <button className="button outline" disabled={busy} onClick={regenerate}>
                    <RefreshCw size={15} />
                    重新规划
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !selected.length ||
                      plan.missingRequirements.length > 0 ||
                      !meta.executionEnabled ||
                      !meta.vision.configured
                    }
                    onClick={confirm}
                  >
                    {busy ? <Loader2 className="spin" size={17} /> : <Play size={17} />}确认计划并执行
                  </button>
                </>
              )}
              {latest && (
                <button className="button primary" onClick={() => go(`runs/${latest.id}`)}>
                  查看最近运行
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {task.status === 'DRAFT' && (
        <button className="button primary" onClick={regenerate} disabled={busy}>
          生成计划
        </button>
      )}
      {task.runs?.length > 0 && (
        <section className="panel run-history">
          <h2>运行历史</h2>
          {task.runs.map((r) => (
            <button key={r.id} onClick={() => go(`runs/${r.id}`)}>
              <span>{r.id.slice(0, 8)}</span>
              <Badge status={r.status} />
              <span className="muted">{date(r.createdAt)}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </section>
      )}
    </>
  );
}
function LayersIcon() {
  return <Activity size={32} />;
}
export function RunDetail({ id, notify }: { id: string; notify: Notify }) {
  const [run, setRun] = useState<Run | null>(null),
    [events, setEvents] = useState<ProgressEvent[]>([]),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [comment, setComment] = useState(''),
    [rating, setRating] = useState(4),
    [category, setCategory] = useState('体验反馈');
  const retryKey = useRef('');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('l2');
  const refreshRun = useRef<() => void>(() => {});
  if (!retryKey.current && typeof window !== 'undefined') retryKey.current = crypto.randomUUID();
  useEffect(() => {
    let alive = true,
      reading = false,
      ended = false,
      lastRead = 0;
    setRun(null);
    setEvents([]);
    setError('');
    retryKey.current = crypto.randomUUID();
    const read = async () => {
      if (reading || !alive) return;
      reading = true;
      await api<Run>(`/runs/${id}`)
        .then((v) => {
          if (alive) {
            setRun(v);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
      reading = false;
      lastRead = Date.now();
    };
    refreshRun.current = () => void read();
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    void read();
    // Reviews and resource recovery can change retry eligibility after execution ends.
    // Keep visible reports fresh even after the execution event stream has closed.
    const timer = setInterval(() => {
      if (!ended || Date.now() - lastRead >= 15000) refreshVisible();
    }, 4000);
    const source = new EventSource(`/api/runs/${id}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('run-event', (e) => {
      if (!alive) return;
      const data = JSON.parse((e as MessageEvent).data);
      setEvents((old) => (old.some((x) => x.seq === data.seq) ? old : [...old, data].slice(-5000)));
      if (data.kind === 'evidence') void read();
    });
    source.addEventListener('snapshot', (e) => {
      const snapshot = JSON.parse((e as MessageEvent).data);
      if (alive) setRun((old) => (old ? { ...old, ...snapshot } : old));
    });
    source.addEventListener('end', () => {
      ended = true;
      source.close();
      setConnected(false);
      void read();
    });
    return () => {
      alive = false;
      source.close();
      clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [id]);
  if (error && !run) return <div className="notice error">{error}</div>;
  if (!run)
    return (
      <div className="empty">
        <Loader2 className="spin" />
        正在加载运行记录
      </div>
    );
  const terminal = TERMINAL.has(run.status),
    counts = Object.fromEntries(
      ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'SKIPPED'].map((s) => [
        s,
        run.summary.filter((r) => r.result === s).length,
      ]),
    ),
    total = run.manifest.plan.cases.length;
  async function retry() {
    setBusy(true);
    try {
      const r = await post<Run>(`/tasks/${run!.taskId}/runs`, {
        revision: run!.manifest.revision,
        idempotencyKey: retryKey.current,
        parentRunId: id,
        executionMode,
      });
      go(`runs/${r.id}`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="back" onClick={() => go('tasks')}>
        <ArrowLeft size={16} />
        返回测试记录
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试运行报告</div>
          <h1 className="task-title">{run.task.title}</h1>
          <p>
            运行 {id.slice(0, 8)} · {date(run.createdAt)} ·{' '}
            {run.manifest.sample ? '独立审批样例' : '业务测试环境'}
          </p>
        </div>
        <div className="button-group">
          <button className="button outline" onClick={() => refreshRun.current()}>
            <RefreshCw size={16} />
            刷新状态
          </button>
          {terminal ? (
            <>
              {!run.manifest.sample && (
                <ExecutionModeSelect
                  id="regression-execution-mode"
                  value={executionMode}
                  disabled={busy}
                  onChange={(v) => {
                    setExecutionMode(v);
                    retryKey.current = crypto.randomUUID();
                  }}
                />
              )}
              <a className="button outline" href={`/api/runs/${id}/report?format=markdown`}>
                <Download size={16} />
                导出报告
              </a>
              <button
                className="button primary"
                onClick={retry}
                disabled={busy || run.retry?.allowed === false}
                title={
                  run.retry?.allowed === false
                    ? run.retry.reason
                    : '使用此运行保存的原用例版本回归；修改用例后请从用例库重新运行'
                }
              >
                <RefreshCw size={16} />
                一键回归
              </button>
            </>
          ) : (
            <button
              className="button danger"
              disabled={busy || run.status === 'CANCEL_REQUESTED'}
              onClick={async () => {
                setBusy(true);
                try {
                  await post(`/runs/${id}/cancel`);
                  notify('取消请求已受理，正在停止动作与回收资源');
                  setRun(await api<Run>(`/runs/${id}`));
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Square size={15} />
              {run.status === 'CANCEL_REQUESTED' ? '正在取消' : '取消执行'}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="notice error">状态更新失败：{error}。正在自动重试，也可以点击“刷新状态”。</div>
      )}
      <section className="run-banner">
        <div>
          <Badge status={run.status} />
          <strong>
            {!terminal
              ? '正在执行测试'
              : run.status === 'COMPLETED' && counts.PASS === total && total > 0
                ? `全部通过 · ${total} 条用例`
                : `执行已结束 · ${counts.PASS} 条通过，${total - counts.PASS} 条需关注`}
          </strong>
          <p>
            {run.error ||
              (terminal
                ? counts.PASS === total && total > 0
                  ? '本次配置的用例已全部验证通过，详细结果和截图见下方。'
                  : '选择下方用例，查看未通过项的具体原因和证据。'
                : '您可以关闭页面，后台会继续执行；重新进入即可查看进度。')}
          </p>
        </div>
        <div className="run-progress">
          <strong>
            {run.summary.length}
            <span> / {total}</span>
          </strong>
          <span>场景已形成结果</span>
          <div className="progress-track">
            <i style={{ width: `${total ? (run.summary.length / total) * 100 : 0}%` }} />
          </div>
          <small>
            {!terminal
              ? connected
                ? '实时事件已连接'
                : '正在重连 · 状态查询仍有效'
              : run.cleanupStatus === 'NOT_REQUIRED' || run.retry?.noBusinessActions
                ? '业务数据：无需清理（未执行业务写动作）'
                : run.cleanupStatus === 'CLEAN'
                  ? '业务数据：清理流程已完成'
                  : run.cleanupStatus === 'NOT_CONFIGURED'
                    ? '业务数据：未配置清理步骤'
                    : `业务数据清理：${run.cleanupStatus}`}
          </small>
          {terminal && (
            <small>
              {run.browserCleanup === 'CLOSED'
                ? '浏览器及隔离会话：已自动回收'
                : run.browserCleanup === 'FAILED'
                  ? '浏览器资源回收失败'
                  : '浏览器会话在运行结束时自动回收'}
            </small>
          )}
        </div>
      </section>
      {terminal && run.retry && (!run.retry.allowed || run.retry.noBusinessActions) && (
        <div className={run.retry.allowed ? 'notice' : 'notice error'}>
          {run.retry.reason}
          {run.retry.noBusinessActions && (
            <button className="button outline" onClick={() => go('cases')}>
              编辑功能与用例
            </button>
          )}
        </div>
      )}
      {run.cleanupStatus === 'FAILED' && (
        <div className="notice error">
          测试数据清理异常，相关命名空间已保留供维护者处理。此运行不能作为健康的发布结果。
        </div>
      )}
      <div className="result-stats">
        {Object.entries(counts).map(([s, n]) => (
          <div key={s}>
            <Badge status={s} />
            <strong>{n}</strong>
          </div>
        ))}
        <div>
          <span className="muted">工具动作</span>
          <strong>
            {run.usage.actions}
            <small>/{run.manifest.budget.maxActions}</small>
          </strong>
        </div>
      </div>
      {terminal && (
        <OutcomeReviewHistory
          runId={id}
          onUpdated={() => {
            void api<Run>(`/runs/${id}`)
              .then(setRun)
              .catch((e) => notify(e.message, true));
          }}
        />
      )}
      <RunMonitor
        run={run}
        events={events}
        renderResult={(result) => <ResultDetail result={result} run={run} />}
      />
      <details className="panel execution-log">
        <summary>执行时间线与事件</summary>
        <div className="timeline-panel">
          <div className="panel-heading">
            <h2>执行时间线</h2>
            <span className={'dot ' + (!terminal && connected ? 'online' : '')} />
          </div>
          <div className="timeline">
            {events
              .filter((e) =>
                [
                  'queued',
                  'started',
                  'action.started',
                  'case.completed',
                  'cleanup.error',
                  'finished',
                ].includes(e.kind),
              )
              .slice(-35)
              .reverse()
              .map((e) => (
                <div className="timeline-item" key={e.seq}>
                  <i />
                  <div>
                    <strong>
                      {e.payload.label ||
                        e.payload.title ||
                        e.payload.message ||
                        (e.kind === 'finished' ? '运行结束' : e.kind)}
                    </strong>
                    <small>
                      {e.payload.caseId || '任务'} · 事件 {e.seq}
                    </small>
                  </div>
                </div>
              ))}
            {!events.length && <p className="muted">正在读取持久化事件…</p>}
          </div>
        </div>
      </details>
      <details className="panel manifest-panel">
        <summary>运行配置、版本与模型费用</summary>
        <div>
          <h2>可追溯运行快照</h2>
          <p>本次运行固定使用以下版本。</p>
        </div>
        <div className="manifest-grid">
          <div>
            <small>测试浏览器</small>
            <strong>
              {run.manifest.browser ? browserLabels[run.manifest.browser.name] : '历史运行未记录浏览器选项'}
            </strong>
            <code>{run.manifest.browser ? 'Midscene / Playwright' : '请查看原始执行时间线'}</code>
          </div>
          <div>
            <small>知识快照</small>
            <strong>{run.manifest.knowledgeReleaseId}</strong>
            <code>{run.manifest.knowledgeHash.slice(0, 14)}</code>
          </div>
          <div>
            <small>Skill 版本</small>
            <strong>{run.manifest.skillReleaseId || (run.manifest.debug ? '隔离草稿调试' : '未指定')}</strong>
            <code>{run.manifest.skillHash?.slice(0, 14) || '—'}</code>
          </div>
          <div>
            <small>模型调用 / Token</small>
            <strong>
              {run.usage.modelCalls + run.usage.visionCalls} 次 /{' '}
              {run.usage.inputTokens + run.usage.outputTokens}
            </strong>
            <code>
              {run.manifest.models?.vision.model ||
                run.usage.charges?.find((c) => c.role === 'vision')?.model ||
                (run.usage.visionCalls ? '视觉模型（历史名称未记录）' : '未调用视觉模型')}
            </code>
          </div>
          <RunCost run={run} />
        </div>
      </details>
      {terminal && (
        <section className="panel feedback-panel">
          <div>
            <h2>这次验证对您有帮助吗？</h2>
            <p>反馈保存在当前工作空间，提交后可在下方及左侧「反馈记录」查看。</p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post(`/runs/${id}/feedback`, { rating, category, comment });
                setComment('');
                notify('反馈已保存到本平台，可在下方查看');
                setRun(await api<Run>(`/runs/${id}`));
              } catch (e) {
                notify((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="field-row">
              <div>
                <label htmlFor="rating">帮助程度</label>
                <select id="rating" value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option value={n} key={n}>
                      {n} / 5
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="feedback-category">反馈类型</label>
                <select id="feedback-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {['体验反馈', '结论纠正', '知识问题', '工具故障'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </div>
            </div>
            <textarea
              aria-label="反馈内容"
              placeholder="哪一步需要改进？结论是否符合您的业务预期？"
              minLength={3}
              maxLength={2000}
              required
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="form-footer">
              <small className="muted">已收到 {run.feedback?.length || 0} 条反馈</small>
              <button className="button primary" disabled={busy}>
                提交反馈
              </button>
            </div>
          </form>
        </section>
      )}
      {terminal && (
        <FeedbackList projectId={run.task.projectId} runId={run.id} refreshKey={run.feedback?.length || 0} />
      )}
      {run.manifest.debug && (
        <button className="button outline" onClick={() => go('skills')}>
          <CheckCircle2 size={16} />
          返回技能库查看调试与发布
        </button>
      )}
    </>
  );
}
function evidenceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '未记录';
  if (typeof value === 'object' && 'thought' in value && typeof value.thought === 'string')
    return value.thought;
  return JSON.stringify(value, null, 2);
}
function ResultDetail({ result, run }: { result: Result; run: Run }) {
  const evidence = run.evidence?.filter((e) => result.evidenceIds.includes(e.id)) || [],
    screenshot = evidence.filter((e) => e.kind === 'screenshot').at(-1),
    reports = evidence.filter((e) => e.kind === 'midscene-report'),
    primary = reports.find((e) => e.fileName.endsWith('-final.midscene.html')) || reports.at(-1),
    history = evidence.filter(
      (e) => (e.kind === 'midscene-report' || e.kind === 'trace') && e.id !== primary?.id,
    );
  return (
    <div className="result-detail">
      <div className="detail-title">
        <h3>预期与实际</h3>
      </div>
      {result.assertions.length > 0 && (
        <div className="assertions">
          {result.assertions.map((a) => (
            <div className={'assertion ' + (a.passed ? '' : 'failed')} key={a.id}>
              <div>
                {a.passed ? <Check size={16} /> : <AlertCircle size={16} />}
                <strong>{a.passed ? '验证通过' : '验证未通过'}</strong>
              </div>
              <dl>
                <dt>预期</dt>
                <dd>{evidenceText(a.expected)}</dd>
                <dt>实际</dt>
                <dd>{evidenceText(a.actual)}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
      {screenshot ? (
        <a
          href={`/api/evidence/${screenshot.id}`}
          target="_blank"
          rel="noreferrer"
          className="button outline small"
        >
          <span>查看最终截图原图 ↗</span>
        </a>
      ) : (
        <div className="notice">此场景没有可用截图；请结合事件与其他证据判断。</div>
      )}
      <div className="evidence-links">
        {primary && (
          <a className="button outline small" href={`/api/evidence/${primary.id}`}>
            <Download size={14} />
            下载 Midscene 报告
          </a>
        )}
        {history.length > 0 && (
          <details className="report-history">
            <summary>阶段报告与历史附件（{history.length}）</summary>
            <div className="evidence-links">
              {history.map((e, i) => (
                <a
                  className="button outline small"
                  key={e.id}
                  href={`/api/evidence/${e.id}`}
                  title={e.fileName}
                >
                  <Download size={14} />
                  {e.kind === 'trace'
                    ? `历史 Trace ${i + 1}`
                    : e.fileName.match(/-assert-(\d+)\./)
                      ? `断言 ${e.fileName.match(/-assert-(\d+)\./)![1]} 阶段报告`
                      : `探索 / 执行阶段 ${i + 1} 报告`}
                </a>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
