'use client';
import { WebsiteFilter } from './website-filter';
import { Pagination } from './pagination';
import { SideDrawer } from './side-drawer';
import { useEffect, useState, useRef } from 'react';
import { Compass, Plus, ArrowLeft, Play, Save, Loader2 } from 'lucide-react';
import { api, post, patch, go, Badge, date, TERMINAL, type Project, type Meta, type Knowledge } from './api';
import { StepEditor, type Website, type LoginProfile } from './websites';
import { AssertionsEditor, ParametersEditor } from './structured-editor';
import type { Notify } from './workbench';
import { caseRoute, rememberedWebsite, rememberWebsite } from './case-runner';
import {
  requirementLines,
  type DiscoveryCandidate,
  type Observation,
} from '../../../packages/contracts/src/discovery';
type Draft = {
  id: string;
  revision: number;
  status: string;
  content: DiscoveryCandidate;
  reviewNote: string | null;
  publishedCaseId: string | null;
};
type Discovery = {
  draftCounts?: Record<string, number>;
  pageCount?: number;
  projectId: string;
  phase: 'MAIN' | 'BOUNDARY' | 'DIVERGENT';
  baselineRunId: string | null;
  baselineDiscoveryId: string | null;
  domainRules: { id: string; title: string; text: string }[];
  id: string;
  title: string;
  taskId: string;
  environmentId: string;
  requirements: string;
  status: string;
  maxPages: number;
  createdAt: string;
  drafts: Draft[];
  report: {
    observations?: Observation[];
    summary?: string;
    gaps?: string[];
    actionHistory?: { from: string; target: string; text: string; outcome: string }[];
  };
  run: { id: string; status: string; error: string | null; usage: { actions: number } } | null;
};
const phases = {
  MAIN: '阶段一 · 主链路',
  BOUNDARY: '阶段二 · 边界探索',
  DIVERGENT: '阶段三 · 发散探索',
} as const;
type Baseline = { id: string; createdAt: string; cases: { title: string; result: string }[] };
export function DiscoveryView({
  project,
  meta,
  id,
  notify,
  refresh,
}: {
  project: Project;
  meta: Meta;
  id?: string;
  notify: Notify;
  refresh: () => Promise<void>;
}) {
  if (id && id !== 'new') return <DiscoveryDetail key={id} id={id} project={project} notify={notify} />;
  return (
    <DiscoveryList
      key={project.id + (id || '')}
      project={project}
      meta={meta}
      create={id === 'new'}
      notify={notify}
      refresh={refresh}
    />
  );
}
function DiscoveryList({
  project,
  meta,
  create,
  notify,
  refresh,
}: {
  project: Project;
  meta: Meta;
  create: boolean;
  notify: Notify;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [history, setHistory] = useState(false),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0),
    [currentPage, setCurrentPage] = useState(1),
    [listLoading, setListLoading] = useState(true),
    [listError, setListError] = useState('');
  const [rows, setRows] = useState<Discovery[]>([]),
    [sites, setSites] = useState<Website[]>([]),
    [sessions, setSessions] = useState<LoginProfile[]>([]);
  const [environmentId, setEnv] = useState(''),
    [title, setTitle] = useState(''),
    [requirements, setRequirements] = useState(''),
    [startPath, setStart] = useState(''),
    [sessionId, setSession] = useState(''),
    [maxPages, setMaxPages] = useState(4),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Discovery['phase']>('MAIN'),
    [prior, setPrior] = useState(''),
    [baselineId, setBaseline] = useState(''),
    [baselines, setBaselines] = useState<Baseline[]>([]),
    [knowledge, setKnowledge] = useState<Knowledge[]>([]),
    [knowledgeId, setKnowledgeId] = useState('');
  useEffect(() => {
    api<Knowledge[]>(`/knowledge/releases?projectId=${project.id}`)
      .then(setKnowledge)
      .catch((e) => notify(e.message, true));
  }, [project.id]);
  useEffect(() => {
    setPrior('');
    setBaseline('');
    setBaselines([]);
  }, [phase, environmentId]);
  useEffect(() => {
    setBaseline('');
    setBaselines([]);
    if (prior)
      api<Baseline[]>(`/discoveries/${prior}/baselines`)
        .then(setBaselines)
        .catch((e) => notify(e.message, true));
  }, [prior]);
  useEffect(() => {
    let alive = true;
    api<Website[]>(`/websites?projectId=${project.id}`)
      .then((s) => {
        if (!alive) return;
        setSites(s);
        setLoaded(true);
        const preferred =
          new URLSearchParams(window.location.hash.split('?')[1]).get('website') ||
          rememberedWebsite(project.id);
        setEnv((old) => old || s.find((x) => x.enabled && x.id === preferred)?.id || '');
      })
      .catch((e) => {
        if (alive) {
          setListError(e.message);
          notify(e.message, true);
        }
      });
    return () => {
      alive = false;
    };
  }, [project.id]);
  useEffect(() => {
    if (create || !loaded) return;
    const controller = new AbortController();
    let reading = false;
    setListLoading(true);
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const params = new URLSearchParams({
          projectId: project.id,
          page: String(page),
          size: String(pageSize),
          website: environmentId,
          filter,
          search,
          history: String(history),
        });
        const result = await api<{ rows: Discovery[]; total: number; page: number }>(
          `/discoveries?${params}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setRows(result.rows);
          setTotal(result.total);
          setCurrentPage(result.page);
          setListLoading(false);
          setListError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setListError((e as Error).message);
          setListLoading(false);
        }
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
  }, [create, loaded, project.id, environmentId, page, pageSize, filter, search, history]);
  useEffect(() => {
    setSession('');
    setSessions([]);
    if (environmentId && environmentId !== 'new') {
      rememberWebsite(project.id, environmentId);
      setStart(sites.find((s) => s.id === environmentId)?.baseUrl || '/');
      api<LoginProfile[]>(`/websites/${environmentId}/sessions`)
        .then(setSessions)
        .catch((e) => notify(e.message, true));
    }
  }, [environmentId]);
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>{create ? '新建网站探索' : '探索用例'}</h1>
          <p>
            {create
              ? '选择网站，描述本次要探索的功能，Agent 将生成待审核的用例草稿。'
              : '结合需求探索网站，审核草稿后加入用例库。'}
          </p>
        </div>
        <button
          className={'button ' + (create ? 'outline' : 'primary')}
          onClick={() =>
            go(create ? 'discoveries' : `discoveries/new?website=${encodeURIComponent(environmentId)}`)
          }
        >
          <Plus size={17} />
          {create ? '返回探索列表' : '新建网站探索'}
        </button>
      </div>
      {!create && (
        <div className="panel context-bar">
          <WebsiteFilter
            sites={sites}
            value={environmentId}
            history={history}
            onChange={(v) => {
              setEnv(v);
              setPage(1);
            }}
            onHistory={(v) => {
              setHistory(v);
              setPage(1);
              if (!v && !sites.find((s) => s.id === environmentId)?.enabled) setEnv('');
            }}
          />
          <a className="context-link" href={`#/cases${environmentId ? `?website=${environmentId}` : ''}`}>
            打开用例库 →
          </a>
        </div>
      )}
      {create ? (
        <form
          className="panel form-panel"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const env =
                environmentId === 'new'
                  ? await post<Website>('/websites', {
                      projectId: project.id,
                      name: title.slice(0, 100),
                      baseUrl: url,
                    })
                  : sites.find((s) => s.id === environmentId)!;
              const row = await post<Discovery>('/discoveries', {
                environmentId: env.id,
                title,
                requirements,
                sessionId: sessionId || null,
                maxPages,
                startPath: startPath || env.baseUrl,
                phase,
                baselineDiscoveryId: phase === 'MAIN' ? null : prior,
                baselineRunId: phase === 'MAIN' ? null : baselineId,
                knowledgeReleaseId: knowledgeId || null,
              });
              await refresh();
              go(`discoveries/${row.id}`);
              try {
                await post(`/discoveries/${row.id}/start`, { idempotencyKey: crypto.randomUUID() });
              } catch (e) {
                notify((e as Error).message, true);
              }
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>定义本次探索</h2>
          <details className="advanced-options">
            <summary>探索阶段 · {phases[phase]}（可调整）</summary>
            <label htmlFor="discovery-phase">探索阶段</label>
            <select
              id="discovery-phase"
              value={phase}
              onChange={(e) => setPhase(e.target.value as Discovery['phase'])}
            >
              {Object.entries(phases).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <div className="notice">
              先建立主链路基线，再检查必填、格式和业务边界，最后探索预览、帮助、侧栏等非主流程。系统会记录实际动作、比较路径，停止重复探索。
            </div>
          </details>
          <label htmlFor="discovery-title">探索名称</label>
          <input
            id="discovery-title"
            required
            minLength={2}
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：商品搜索与筛选"
          />
          <div className="field-row">
            <div>
              <label htmlFor="discovery-site">网站</label>
              <select
                id="discovery-site"
                required
                value={environmentId}
                onChange={(e) => setEnv(e.target.value)}
              >
                <option value="">选择网站</option>
                {sites
                  .filter((s) => s.enabled)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                {phase === 'MAIN' && <option value="new">输入一个新网站</option>}
              </select>
            </div>
            <div>
              <label htmlFor="discovery-session">登录身份</label>
              <select id="discovery-session" value={sessionId} onChange={(e) => setSession(e.target.value)}>
                <option value="">访客 · 无需登录</option>
                {sessions
                  .filter((s) => s.enabled)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          {phase !== 'MAIN' && (
            <div className="field-row">
              <div>
                <label htmlFor="discovery-prior">上一阶段探索</label>
                <select
                  id="discovery-prior"
                  required
                  value={prior}
                  onChange={(e) => setPrior(e.target.value)}
                >
                  <option value="">选择同一网站的上一阶段</option>
                  {rows
                    .filter(
                      (r) =>
                        r.environmentId === environmentId &&
                        r.phase === (phase === 'BOUNDARY' ? 'MAIN' : 'BOUNDARY'),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label htmlFor="discovery-baseline">上一阶段正式验证记录</label>
                <select
                  id="discovery-baseline"
                  required
                  value={baselineId}
                  onChange={(e) => setBaseline(e.target.value)}
                >
                  <option value="">{baselines.length ? '选择验证基线' : '请先审核发布并完成正式验证'}</option>
                  {baselines.map((r) => (
                    <option key={r.id} value={r.id}>
                      {date(r.createdAt)} · {r.cases.map((c) => c.title + ' ' + c.result).join('、')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <details className="advanced-options">
            <summary>补充领域知识（可选）</summary>
            <label htmlFor="discovery-knowledge">领域知识版本（可选）</label>
            <select
              id="discovery-knowledge"
              value={knowledgeId}
              onChange={(e) => setKnowledgeId(e.target.value)}
            >
              <option value="">本次只使用需求正文和已验证基线</option>
              {knowledge
                .filter((k) => k.content.rules.length)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.version}
                  </option>
                ))}
            </select>
          </details>
          {environmentId === 'new' && (
            <>
              <label htmlFor="discovery-url">网站地址</label>
              <input
                id="discovery-url"
                type="url"
                required
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setStart(e.target.value);
                }}
                placeholder="https://test.example.com"
              />
              <p className="muted">需要登录的网站请先在“登录会话”配置测试身份，再返回选择该网站。</p>
            </>
          )}
          <details className="advanced-options">
            <summary>探索范围 · 最多 {maxPages} 页</summary>
            <div className="field-row">
              <div>
                <label htmlFor="discovery-start">探索入口</label>
                <input
                  id="discovery-start"
                  value={startPath}
                  onChange={(e) => setStart(e.target.value)}
                  placeholder="完整 URL 或路径，留空使用网站地址"
                />
              </div>
              <div>
                <label htmlFor="discovery-limit">最多观察页面</label>
                <input
                  id="discovery-limit"
                  type="number"
                  min={1}
                  max={8}
                  required
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                />
              </div>
            </div>
          </details>
          <label htmlFor="discovery-requirements">需求文档内容</label>
          <textarea
            id="discovery-requirements"
            required
            minLength={5}
            maxLength={40000}
            rows={10}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder={
              '粘贴需求、角色、业务规则和验收标准，每条独立一行。\n例如：商品列表应支持按名称搜索；空关键词显示全部商品。\n有疑问的规则将进入草稿的待确认问题。'
            }
          />
          <label htmlFor="discovery-file">导入文本或 Markdown 文档</label>
          <input
            id="discovery-file"
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 160000 || !/\.(txt|md|markdown)$/i.test(file.name)) {
                notify('请选择不超过 160 KB 的文本或 Markdown 文件', true);
                return;
              }
              const text = await file.text();
              if (text.length > 40000) notify('需求最多 40000 字，请缩小本次范围', true);
              else setRequirements(text);
            }}
          />
          <div className="notice">
            本次最多 10 分钟。登录后禁止非只读网络请求；依赖 POST
            查询、弹窗或需要写入才能到达的页面会记录为未覆盖项。Word/PDF 可先粘贴正文。
          </div>
          <div className="form-footer">
            <span className="muted">不会把未审核草稿加入正式用例库。</span>
            <button
              className="button primary"
              disabled={busy || !meta.model.configured || !meta.vision.configured || !environmentId}
            >
              {busy ? <Loader2 className="spin" size={17} /> : <Compass size={17} />}开始探索
            </button>
          </div>
        </form>
      ) : (
        <section className="panel discoveries-panel">
          <div className="record-toolbar">
            <div className="tabs">
              {[
                ['all', '全部探索'],
                ['review', '待审核'],
                ['active', '探索中'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={filter === id ? 'selected' : ''}
                  onClick={() => {
                    setFilter(id);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              aria-label="搜索探索"
              maxLength={100}
              placeholder="搜索探索名称"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {listError ? (
            <div className="notice error" role="alert">
              {listError}
            </div>
          ) : listLoading ? (
            <div className="empty compact">正在加载探索…</div>
          ) : rows.length ? (
            <div className="table-scroll">
              <table className="task-table">
                <thead>
                  <tr>
                    <th>探索 / 网站</th>
                    <th>探索状态</th>
                    <th>用例草稿</th>
                    <th>创建时间</th>
                    <th>下一步</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pending = r.draftCounts?.DRAFT || 0,
                      published = r.draftCounts?.PUBLISHED || 0;
                    return (
                      <tr key={r.id} data-discovery-id={r.id}>
                        <td>
                          <a className="record-title" href={`#/discoveries/${r.id}`}>
                            {r.title}
                          </a>
                          <small>
                            {sites.find((s) => s.id === r.environmentId)?.name || '历史网站'} ·{' '}
                            {phases[r.phase || 'MAIN']}
                          </small>
                        </td>
                        <td>
                          <Badge status={r.status} />
                          <small>已观察 {r.pageCount || 0} 页</small>
                        </td>
                        <td>
                          <strong>
                            {pending ? `待审核 ${pending} 条` : published ? '审核已完成' : '暂无待审草稿'}
                          </strong>
                          <small>
                            已入库 {published} 条
                            {r.draftCounts?.REJECTED ? ` · 已驳回 ${r.draftCounts.REJECTED} 条` : ''}
                          </small>
                        </td>
                        <td className="muted nowrap">{date(r.createdAt)}</td>
                        <td>
                          <a
                            className={'button ' + (pending ? 'primary' : 'outline')}
                            href={`#/discoveries/${r.id}`}
                          >
                            {pending
                              ? '审核草稿'
                              : ['RUNNING', 'QUEUED'].includes(r.status)
                                ? '查看进度'
                                : '查看探索'}
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <Compass size={30} />
              <h3>{!loaded ? '正在加载探索…' : '暂无符合条件的探索'}</h3>
              <p>从网站和需求开始探索，生成草稿后由您校准并入库。</p>
            </div>
          )}
          <Pagination
            label="探索"
            total={total}
            page={currentPage}
            size={pageSize}
            onPage={setPage}
            onSize={(v) => {
              setPageSize(v);
              setPage(1);
            }}
          />
        </section>
      )}
    </>
  );
}
function DiscoveryDetail({ id, project, notify }: { id: string; project: Project; notify: Notify }) {
  const [reviewNotice, setReviewNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const loadOrder = useRef(0);
  const [reviewOpen, setReviewOpen] = useState(false),
    [reviewDirty, setReviewDirty] = useState(false),
    [reviewBusy, setReviewBusy] = useState(false);
  const [row, setRow] = useState<Discovery | null>(null),
    [selected, setSelected] = useState(''),
    [sessions, setSessions] = useState<LoginProfile[]>([]),
    [busy, setBusy] = useState(false);
  async function load() {
    const order = ++loadOrder.current;
    const d = await api<Discovery>(`/discoveries/${id}`);
    if (order !== loadOrder.current) return d;
    setRow(d);
    setSelected((old) => old || d.drafts[0]?.id || '');
    return d;
  }
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (alive) void load().catch((e) => notify(e.message, true));
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => {
    if (row?.environmentId)
      api<LoginProfile[]>(`/websites/${row.environmentId}/sessions`)
        .then(setSessions)
        .catch((e) => notify(e.message, true));
  }, [row?.environmentId]);
  if (!row)
    return (
      <div className="empty">
        <Loader2 className="spin" />
        正在读取探索
      </div>
    );
  const draft = row.drafts.find((d) => d.id === selected),
    observations = row.report.observations || [],
    published = row.drafts.filter((d) => d.publishedCaseId);
  const operation = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="back" onClick={() => go('discoveries')}>
        <ArrowLeft size={16} />
        返回探索列表
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">探索过程与需求依据</div>
          <h1>{row.title}</h1>
          <p>
            {phases[row.phase || 'MAIN']} ·{' '}
            {row.baselineRunId ? (
              <>
                基线：<a href={`/#/runs/${row.baselineRunId}`}>{row.baselineRunId.slice(0, 8)}</a>
              </>
            ) : (
              '发布后需正式验证通过，才能建立主链路基线'
            )}
          </p>
          <p>
            <Badge status={row.status} /> · 已观察 {observations.length}/{row.maxPages} 页 · 待审{' '}
            {row.drafts.filter((d) => d.status === 'DRAFT').length} 条 · 已发布 {published.length} 条
          </p>
        </div>
        <div className="button-group">
          {row.run && !TERMINAL.has(row.run.status) ? (
            <button
              className="button outline"
              disabled={busy}
              onClick={() => operation(() => post(`/runs/${row.run!.id}/cancel`))}
            >
              停止探索
            </button>
          ) : !row.run ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                operation(() => post(`/discoveries/${id}/start`, { idempotencyKey: crypto.randomUUID() }))
              }
            >
              启动探索
            </button>
          ) : null}
          {!!published.length && (
            <a
              className="button primary"
              href={`#/${caseRoute(
                row.environmentId,
                published.map((d) => d.publishedCaseId!),
              )}`}
            >
              去用例库测试 · {published.length} 条
            </a>
          )}
        </div>
      </div>
      {row.run?.error && (
        <div className="notice error">探索中断：{row.run.error}。已保存的页面仍可查看。</div>
      )}
      {!row.drafts.length && (
        <div className="notice">
          {row.run && !TERMINAL.has(row.run.status)
            ? 'Agent 正在结合需求观察网站，页面证据会陆续出现。生成草稿后即可审核。'
            : row.status === 'COMPLETED'
              ? '未发现有足够依据的新用例，请查看观察与未覆盖项。'
              : '此探索尚未产生用例草稿。'}{' '}
          探索完成不代表测试通过。
        </div>
      )}
      {row.report.summary && <div className="notice">{row.report.summary}</div>}
      {!!row.drafts.length && (
        <section className="panel discovery-drafts">
          <div className="panel-heading">
            <h2>用例草稿 · {row.drafts.length}</h2>
            <span className="muted">先校准步骤和预期，确认后加入用例库</span>
          </div>
          <div className="table-scroll">
            <table className="task-table">
              <thead>
                <tr>
                  <th>用例</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {row.drafts.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.content.test.title}</strong>
                      <small>
                        {d.content.test.steps.length} 个步骤 · {d.content.test.assertions.length} 项验证
                      </small>
                    </td>
                    <td>
                      <span className={'badge ' + (d.status === 'DRAFT' ? 'warning' : 'success')}>
                        {d.status === 'DRAFT' ? '待审核' : d.status === 'PUBLISHED' ? '已入库' : '已驳回'}
                      </span>
                    </td>
                    <td>
                      {d.publishedCaseId ? (
                        <a
                          className="button outline"
                          href={`#/${caseRoute(row.environmentId, [d.publishedCaseId])}`}
                        >
                          在用例库查看
                        </a>
                      ) : (
                        <button
                          className={'button ' + (d.status === 'DRAFT' ? 'primary' : 'outline')}
                          onClick={() => {
                            setSelected(d.id);
                            setReviewDirty(false);
                            setReviewNotice(null);
                            setReviewOpen(true);
                          }}
                        >
                          {d.status === 'DRAFT' ? '审核校准' : '查看草稿'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {reviewOpen && draft && (
        <SideDrawer
          title={`审核校准 · ${draft.content.test.title}`}
          notice={reviewNotice}
          dirty={reviewDirty}
          busy={reviewBusy}
          onClose={() => setReviewOpen(false)}
        >
          {draft.publishedCaseId && (
            <div className="notice">
              已加入用例库，可继续编辑或执行。
              <a href={`#/${caseRoute(row.environmentId, [draft.publishedCaseId])}`}>查看用例 →</a>
            </div>
          )}
          <DraftEditor
            key={`${draft.id}-${draft.revision}`}
            draft={draft}
            row={row}
            sessions={sessions}
            notify={(message, error) => setReviewNotice({ message, error })}
            saved={load}
            onDirtyChange={setReviewDirty}
            onBusyChange={setReviewBusy}
          />
        </SideDrawer>
      )}
      {!!row.report.actionHistory?.length && (
        <details className="panel form-panel">
          <summary>操作与路径记录（防止重复探索）</summary>
          <ol>
            {row.report.actionHistory.map((a, i) => (
              <li key={i}>
                <strong>{a.text}</strong> · {a.outcome}
                <p className="muted">
                  {a.from} → {a.target}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <details className="panel form-panel">
        <summary>需求原文与未覆盖项</summary>
        <ol>
          {requirementLines(row.requirements).map((r) => (
            <li key={r.id} id={`R${r.id}`}>
              <strong>R{r.id}</strong> {r.text}
            </li>
          ))}
        </ol>
        <h3>未覆盖 / 待确认</h3>
        <ul>
          {(row.report.gaps || ['探索结束后生成覆盖说明']).map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      </details>
      {!!observations.length && (
        <details className="panel form-panel" open={!row.drafts.length}>
          <summary>页面观察与截图（{observations.length}）</summary>
          <div className="discovery-evidence">
            {observations.map((o) => (
              <article key={o.id}>
                <h3>
                  {o.id} · {o.title}
                </h3>
                <p className="muted">{o.url}</p>
                <p>{o.description}</p>
                {o.evidenceIds[0] && (
                  <a href={`/api/evidence/${o.evidenceIds[0]}`} target="_blank" rel="noreferrer">
                    <img src={`/api/evidence/${o.evidenceIds[0]}`} alt={`${o.id} 页面探索截图`} />
                  </a>
                )}
              </article>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
function DraftEditor({
  draft,
  row,
  sessions,
  notify,
  saved,
  onDirtyChange,
  onBusyChange,
}: {
  onDirtyChange: (v: boolean) => void;
  onBusyChange: (v: boolean) => void;
  draft: Draft;
  row: Discovery;
  sessions: LoginProfile[];
  notify: Notify;
  saved: () => Promise<unknown>;
}) {
  const [form, setForm] = useState(draft.content),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(
    () => onDirtyChange(dirty || !!note.trim() || confirmed),
    [dirty, note, confirmed, onDirtyChange],
  );
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  const change = (v: DiscoveryCandidate) => {
    setForm(v);
    setDirty(true);
    setConfirmed(false);
  };
  const test = form.test,
    editable = draft.status === 'DRAFT',
    req = requirementLines(row.requirements);
  async function review(decision: 'publish' | 'reject') {
    setBusy(true);
    try {
      await post(`/discovery-drafts/${draft.id}/review`, {
        revision: draft.revision,
        decision,
        note,
        confirmed,
      });
      await saved();
      notify(
        decision === 'publish' ? '已发布到功能与用例，可创建正式测试任务' : '草稿已驳回，审核记录已保留',
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel form-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await patch(`/discovery-drafts/${draft.id}`, {
            revision: draft.revision,
            content: {
              ...form,
              test: {
                ...test,
                assertions: test.assertions,
              },
            },
          });
          await saved();
          notify('草稿修改已保存，请重新核对后发布');
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-heading">
        <h2>人工审核与校准</h2>
        <span className="version">
          草稿 v{draft.revision} ·{' '}
          {form.basis === 'requirement' ? '需求依据' : form.basis === 'observed' ? '页面观察' : '待确认假设'}
        </span>
      </div>
      <div className="notice discovery-source">
        <strong>依据与待确认问题</strong>
        <ul>
          {form.requirementRefs.map((id) => (
            <li key={id}>
              R{id}：{req.find((r) => r.id === id)?.text}
            </li>
          ))}
          {form.reviewQuestions.map((q, i) => (
            <li key={`q${i}`}>{q}</li>
          ))}
        </ul>
        <p>页面证据：{form.observationIds.join('、')}。页面现状不能替代需求的正确预期。</p>
        {!!form.knowledgeRuleRefs?.length && (
          <ul>
            {form.knowledgeRuleRefs.map((id) => (
              <li key={id}>
                领域规则 {id}：{row.domainRules?.find((r) => r.id === id)?.text}
              </li>
            ))}
          </ul>
        )}
        {form.observationIds.map((id) => {
          const o = row.report.observations?.find((o) => o.id === id);
          return o?.evidenceIds[0] ? (
            <a
              className="button outline"
              key={id}
              href={`/api/evidence/${o.evidenceIds[0]}`}
              target="_blank"
              rel="noreferrer"
            >
              查看 {id} 截图
            </a>
          ) : null;
        })}
      </div>
      <fieldset disabled={!editable || busy} className="discovery-fields">
        <div className="field-row">
          <div>
            <label htmlFor="draft-feature">所属功能</label>
            <input
              id="draft-feature"
              minLength={2}
              required
              value={form.featureName}
              onChange={(e) => change({ ...form, featureName: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="draft-title">用例名称</label>
            <input
              id="draft-title"
              required
              minLength={2}
              value={test.title}
              onChange={(e) => change({ ...form, test: { ...test, title: e.target.value } })}
            />
          </div>
        </div>
        <label htmlFor="draft-description">功能说明</label>
        <textarea
          id="draft-description"
          value={form.description}
          onChange={(e) => change({ ...form, description: e.target.value })}
        />
        <div className="field-row">
          <div>
            <label htmlFor="draft-start">入口 URL 或路径</label>
            <input
              id="draft-start"
              required
              value={test.startPath}
              onChange={(e) => change({ ...form, test: { ...test, startPath: e.target.value } })}
            />
          </div>
          <div>
            <label htmlFor="draft-session">正式执行的登录身份</label>
            <select
              id="draft-session"
              value={test.sessionId || ''}
              onChange={(e) => change({ ...form, test: { ...test, sessionId: e.target.value || null } })}
            >
              <option value="">访客</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.enabled}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label htmlFor="draft-preconditions">前提与测试数据</label>
        <textarea
          id="draft-preconditions"
          value={test.preconditions}
          onChange={(e) => change({ ...form, test: { ...test, preconditions: e.target.value } })}
        />
        <StepEditor
          label="操作步骤"
          steps={test.steps}
          onChange={(steps) => change({ ...form, test: { ...test, steps } })}
        />
        <AssertionsEditor
          value={test.assertions}
          onChange={(assertions) => change({ ...form, test: { ...test, assertions } })}
        />
        <ParametersEditor
          value={test.parameters ?? {}}
          onChange={(parameters) => change({ ...form, test: { ...test, parameters } })}
        />
        <StepEditor
          label="清理步骤"
          steps={test.cleanup}
          onChange={(cleanup) => change({ ...form, test: { ...test, cleanup } })}
        />
        <p className="muted">
          需要准备的数据必须已存在或写入操作步骤。清理留空时不会删除业务数据；浏览器会话自动回收。
        </p>
        {editable && (
          <button className="button outline" disabled={busy || !dirty}>
            <Save size={16} />
            保存草稿修改
          </button>
        )}
      </fieldset>
      {editable ? (
        <>
          <label htmlFor="draft-note">审核意见 / 校准说明</label>
          <textarea
            id="draft-note"
            minLength={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="说明预期依据、已解决的疑问，以及测试数据和清理方式。"
          />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={dirty}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已核对需求依据、预期、登录身份、测试数据及清理方式
          </label>
          <div className="form-footer">
            <span className="muted">
              {dirty ? '有未保存的修改，请先保存再审核。' : '草稿已保存。填写审核意见并确认后可发布。'}
            </span>
            <div className="button-group">
              <button
                type="button"
                className="button outline"
                disabled={busy || dirty || !confirmed || note.trim().length < 2}
                onClick={() => review('reject')}
              >
                驳回草稿
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || dirty || !confirmed || note.trim().length < 2}
                onClick={() => review('publish')}
              >
                审核通过并发布
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="notice">
          {draft.status === 'PUBLISHED'
            ? '已发布到功能与用例。后续修改请到用例库；此处保留审核时的版本。'
            : '已驳回，未加入正式用例库。'}
          <p>审核意见：{draft.reviewNote}</p>
        </div>
      )}
    </form>
  );
}
