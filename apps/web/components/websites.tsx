'use client';
import { useEffect, useRef, useState } from 'react';
import { Globe, Plus, Save, ArrowRight, Trash2, ChevronUp, ChevronDown, KeyRound } from 'lucide-react';
import { api, post, patch, go, ApiError, type Project, type Meta } from './api';
import type { Notify } from './workbench';
import type { WebCaseInput, WebStep } from '../../../packages/contracts/src/browser';
import { caseRoute, rememberedWebsite, rememberWebsite } from './case-runner';
import { RunCasesButton } from './run-cases-button';
import { SideDrawer } from './side-drawer';
import { DeleteCasesDialog, type DeletionTarget } from './delete-cases-dialog';
import { Pagination, pageItems } from './pagination';
import { RunStartError } from './run-start-error';
import { BrowserSelect } from './browser-select';
import { browserLabels, type BrowserName } from '../../../packages/contracts/src/browser-choice';
import { WebsiteFilter } from './website-filter';
import { ExecutionModeSelect, CacheBadges, useCacheStatuses } from './execution-mode';
import type { ExecutionMode } from '../../../packages/contracts/src/execution-cache';
import { StepEditor, AssertionsEditor, ParametersEditor } from './structured-editor';
export { StepEditor } from './structured-editor';
import { CaseCapabilities } from './case-capabilities';
import type { WebAssertion } from '../../../packages/contracts/src/static-ui';

export type Website = {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  revision: number;
  config: { allowedOrigins: string[]; browser?: BrowserName };
};
export type LoginProfile = {
  id: string;
  name: string;
  kind: 'form' | 'storage';
  enabled: boolean;
  revision: number;
  expiresAt: string | null;
  hasSecret: boolean;
  config: {
    loginPath: string;
    usernameField: string;
    passwordField: string;
    submitInstruction: string;
    successAssertion: WebAssertion;
  };
};
export type WebCaseRow = {
  id: string;
  title: string;
  revision: number;
  enabled: boolean;
  content: WebCaseInput;
};
export type Feature = {
  id: string;
  name: string;
  description: string;
  revision: number;
  enabled: boolean;
  cases: WebCaseRow[];
};
const lines = (value: string) =>
  value
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
const blankCase: WebCaseInput = {
  title: '',
  startPath: '/',
  sessionId: null,
  verifySessionOnly: false,
  preconditions: '',
  steps: [{ kind: 'act', text: '' }],
  assertions: [''],
  cleanup: [],
  enabled: true,
};
const blankLogin = {
  name: '',
  kind: 'form' as 'form' | 'storage',
  enabled: true,
  expiresAt: '',
  config: {
    loginPath: '/login',
    usernameField: '用户名输入框',
    passwordField: '密码输入框',
    submitInstruction: '点击登录按钮',
    successAssertion: '',
  },
};
const budgets = { timeoutMs: 600000, maxActions: 100, maxModelCalls: 60, maxTokens: 150000, maxCostUsd: 1 };

export function WebsitesView({
  project,
  section,
  meta,
  notify,
  refresh,
  requestedSiteId = '',
  selectedCaseIds = '',
}: {
  project: Project;
  section: string;
  meta: Meta;
  notify: Notify;
  refresh: () => Promise<void>;
  requestedSiteId?: string;
  selectedCaseIds?: string;
}) {
  const [sites, setSites] = useState<Website[]>([]),
    [siteId, setSiteId] = useState(
      () =>
        new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.split('?')[1]).get(
          'website',
        ) || rememberedWebsite(project.id),
    ),
    [loaded, setLoaded] = useState(false),
    [showDisabled, setShowDisabled] = useState(false),
    [newSite, setNewSite] = useState(false);
  async function load() {
    const data = await api<Website[]>(`/websites?projectId=${project.id}`);
    setSites(data);
    setLoaded(true);
    setSiteId((old) =>
      data.some((s) => s.id === old && (s.enabled || s.id === requestedSiteId))
        ? old
        : data.find((s) => s.enabled)?.id || '',
    );
    await refresh();
  }
  useEffect(() => {
    void load().catch((e) => notify(e.message, true));
  }, [project.id]);
  useEffect(() => {
    if (requestedSiteId) {
      setSiteId(requestedSiteId);
      setNewSite(false);
    }
  }, [requestedSiteId]);
  const site = sites.find((s) => s.id === siteId);
  useEffect(() => {
    if (siteId) rememberWebsite(project.id, siteId);
  }, [siteId, project.id]);
  if (section === 'cases')
    return (
      <>
        <div className="page-heading compact-heading">
          <div>
            <h1>用例库</h1>
            <p>校准测试步骤与预期，选择用例直接测试或回归。</p>
          </div>
          <a className="button outline" href={`#/discoveries/new?website=${encodeURIComponent(siteId)}`}>
            <Plus size={17} />
            探索新用例
          </a>
        </div>
        <div className="panel context-bar">
          <WebsiteFilter
            sites={sites}
            value={siteId}
            onChange={setSiteId}
            history={showDisabled}
            all={false}
            onHistory={(v) => {
              setShowDisabled(v);
              if (!v && !site?.enabled) setSiteId(sites.find((s) => s.enabled)?.id || '');
            }}
          />
          {site && (
            <a className="context-link" href={`#/websites?website=${site.id}`}>
              网站与登录配置
            </a>
          )}
          <details className="context-more">
            <summary>更多</summary>
            <div>
              <a href="#/plan">按测试目标规划</a>
              {project.sample && <a href="#/sample">运行内置审批样例</a>}
            </div>
          </details>
        </div>
        {!meta.vision.configured && (
          <div className="notice warning">视觉模型尚未配置，配置后可执行测试。</div>
        )}
        {!loaded ? (
          <div className="empty">正在加载用例库…</div>
        ) : site ? (
          <Features key={site.id} site={site} notify={notify} selectedCaseIds={selectedCaseIds} />
        ) : (
          <EmptyWebsite />
        )}
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">网站与用例管理</div>
          <h1>{section === 'sessions' ? '登录会话' : '网站管理'}</h1>
          <p>接入网站，配置登录身份，用自然语言描述功能与预期。</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setNewSite(true);
            go('websites');
          }}
        >
          <Plus size={17} />
          添加网站
        </button>
      </div>
      {
        <div className="onboarding-strip">
          {[
            ['websites', '1 · 网站地址'],
            ['sessions', '2 · 登录会话'],
            ['cases', '3 · 功能与用例'],
          ].map(([route, label]) => (
            <button
              key={route}
              className={section === route ? 'selected' : ''}
              onClick={() =>
                go(route === 'new' ? caseRoute(siteId) : `${route}?website=${encodeURIComponent(siteId)}`)
              }
            >
              {label}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      }
      {!meta.vision.configured && (
        <div className="notice warning">Midscene 视觉模型尚未配置。可以维护网站与用例，配置后即可执行。</div>
      )}
      <div className="website-layout">
        <aside className="panel website-list">
          <h3>我的测试网站</h3>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
            />
            显示已停用网站
          </label>
          {sites
            .filter((s) => s.enabled || showDisabled)
            .map((s) => (
              <button
                key={s.id}
                className={'website-choice ' + (s.id === siteId && !newSite ? 'selected' : '')}
                onClick={() => {
                  setSiteId(s.id);
                  setNewSite(false);
                }}
              >
                <Globe size={17} />
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.baseUrl}</small>
                  <small>
                    {s.enabled ? '已启用' : '已停用'} · v{s.revision} ·{' '}
                    {browserLabels[s.config.browser ?? 'chrome']}
                  </small>
                </span>
              </button>
            ))}
          {loaded && !sites.some((s) => s.enabled || showDisabled) && (
            <p className="muted">先添加一个测试网站。</p>
          )}
        </aside>
        <div>
          {section === 'websites' &&
            (newSite || !site ? (
              <SiteEditor
                key="new"
                projectId={project.id}
                notify={notify}
                saved={async (s) => {
                  setSiteId(s.id);
                  setNewSite(false);
                  await load();
                }}
              />
            ) : (
              <SiteEditor
                key={`${site.id}:${site.revision}`}
                row={site}
                projectId={project.id}
                notify={notify}
                saved={load}
              />
            ))}
          {section === 'sessions' &&
            (site ? <Sessions key={site.id} site={site} notify={notify} /> : <EmptyWebsite />)}
        </div>
      </div>
    </>
  );
}
function EmptyWebsite() {
  return (
    <div className="panel empty">
      <Globe />
      <p>请先添加并选择测试网站。</p>
      <button className="button primary" onClick={() => go('websites')}>
        添加网站
      </button>
    </div>
  );
}
function SiteEditor({
  row,
  projectId,
  notify,
  saved,
}: {
  row?: Website;
  projectId: string;
  notify: Notify;
  saved: (s: Website) => Promise<void>;
}) {
  const [name, setName] = useState(row?.name || ''),
    [browserName, setBrowserName] = useState<BrowserName>(row?.config.browser ?? 'chrome'),
    [url, setUrl] = useState(row?.baseUrl || ''),
    [origins, setOrigins] = useState(
      row?.config.allowedOrigins.filter((o) => o !== new URL(row.baseUrl).origin).join('\n') || '',
    ),
    [enabled, setEnabled] = useState(row?.enabled ?? true),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="panel form-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body = {
            projectId,
            name,
            baseUrl: url,
            allowedOrigins: lines(origins),
            browserName,
            enabled,
            revision: row?.revision,
          };
          const result = row
            ? await patch<Website>(`/websites/${row.id}`, body)
            : await post<Website>('/websites', body);
          await saved(result);
          notify('网站已保存，可以配置登录会话和功能用例');
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{row ? '网站配置' : '添加测试网站'}</h2>
      <label htmlFor="site-name">网站名称</label>
      <input
        id="site-name"
        required
        minLength={2}
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="例如：订单管理 · 测试环境"
      />
      <label htmlFor="site-url">网站地址</label>
      <input
        id="site-url"
        type="url"
        required
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://test.example.com"
      />
      <small className="muted">填写执行服务器能够访问的测试地址，支持内网。不要填入账号密码。</small>
      <BrowserSelect
        id="site-browser"
        label="默认测试浏览器"
        value={browserName}
        onChange={setBrowserName}
        disabled={busy}
      />
      <label htmlFor="site-origins">额外允许的域名（可选，每行一个完整地址）</label>
      <textarea
        id="site-origins"
        value={origins}
        onChange={(e) => setOrigins(e.target.value)}
        rows={3}
        placeholder={'https://sso.example.com\nhttps://cdn.example.com'}
      />
      <small className="muted">网站主域名自动加入。跨域登录、API 和静态资源所需域名也应加入。</small>
      <label className="inline-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用此网站
      </label>
      <div className="form-footer">
        <span className="muted">UI 操作引擎：Midscene</span>
        <button className="button primary" disabled={busy}>
          <Save size={16} />
          保存网站
        </button>
      </div>
    </form>
  );
}
function Sessions({ site, notify }: { site: Website; notify: Notify }) {
  const [rows, setRows] = useState<LoginProfile[]>([]),
    [selected, setSelected] = useState<LoginProfile | undefined>();
  async function load() {
    setRows(await api<LoginProfile[]>(`/websites/${site.id}/sessions`));
  }
  useEffect(() => {
    void load().catch((e) => notify(e.message, true));
  }, [site.id]);
  return (
    <>
      <div className="panel resource-summary">
        <KeyRound />
        <div>
          <h3>每条用例选择一个登录身份</h3>
          <p>支持账号密码登录、导入 Cookie / localStorage。不需要登录的页面，在用例中选择“访客”。</p>
        </div>
      </div>
      <div className="resource-pills">
        <button className="button outline" onClick={() => setSelected(undefined)}>
          <Plus size={15} />
          新建登录配置
        </button>
        {rows.map((r) => (
          <button className="button outline" key={r.id} onClick={() => setSelected(r)}>
            {r.name} · v{r.revision}
            {!r.enabled ? ' · 停用' : ''}
          </button>
        ))}
      </div>
      <SessionEditor
        key={selected ? `${selected.id}:${selected.revision}` : 'new'}
        site={site}
        row={selected}
        notify={notify}
        saved={async (r) => {
          await load();
          setSelected(r);
        }}
      />
    </>
  );
}
function SessionEditor({
  site,
  row,
  notify,
  saved,
}: {
  site: Website;
  row?: LoginProfile;
  notify: Notify;
  saved: (r: LoginProfile) => Promise<void>;
}) {
  const [form, setForm] = useState({
      ...blankLogin,
      ...row,
      expiresAt: row?.expiresAt
        ? new Date(new Date(row.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : '',
      config: { ...blankLogin.config, ...row?.config },
    }),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [state, setState] = useState(''),
    [busy, setBusy] = useState(false);
  function configField(k: keyof typeof blankLogin.config, value: string) {
    setForm({ ...form, config: { ...form.config, [k]: value } });
  }
  async function verify() {
    if (!row) return;
    setBusy(true);
    try {
      const feature = await post<Feature>(`/websites/${site.id}/features`, {
        name: `登录验证 · ${row.name}`,
        description: '验证已保存登录配置的成功条件',
      });
      const c = await post<WebCaseRow>(`/web-features/${feature.id}/cases`, {
        title: `验证登录 · ${row.name}`,
        sessionId: row.id,
        verifySessionOnly: true,
        startPath: row.config.loginPath,
        steps: [],
        assertions: [row.config.successAssertion],
        cleanup: [],
      });
      const task = await post<{ id: string }>('/tasks', {
        projectId: site.projectId,
        environmentId: site.id,
        goal: `验证登录配置 ${row.name}`,
        caseIds: [c.id],
        mode: 'catalog',
        budget: budgets,
      });
      await post(`/tasks/${task.id}/plans`);
      go(`tasks/${task.id}`);
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
          const body = {
            ...form,
            expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
            username: username || undefined,
            password: password || undefined,
            storageState: form.kind === 'storage' && state ? JSON.parse(state) : undefined,
          };
          const r = row
            ? await patch<LoginProfile>(`/login-profiles/${row.id}`, body)
            : await post<LoginProfile>(`/websites/${site.id}/sessions`, body);
          setPassword('');
          setUsername('');
          setState('');
          await saved(r);
          notify('登录配置已加密保存');
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{row ? '编辑登录配置' : '新建登录配置'}</h2>
      <div className="field-row">
        <div>
          <label htmlFor="login-name">身份名称</label>
          <input
            id="login-name"
            required
            minLength={2}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="普通用户 / 审批人"
          />
        </div>
        <div>
          <label htmlFor="login-kind">登录方式</label>
          <select
            id="login-kind"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as 'form' | 'storage' })}
          >
            <option value="form">账号密码 · Midscene 登录</option>
            <option value="storage">导入 Cookie / localStorage</option>
          </select>
        </div>
      </div>
      <label htmlFor="login-path">
        {form.kind === 'form' ? '登录页面路径或 URL' : '会话验证页面路径或 URL'}
      </label>
      <input
        id="login-path"
        required
        value={form.config.loginPath}
        onChange={(e) => configField('loginPath', e.target.value)}
      />
      {form.kind === 'form' ? (
        <>
          <div className="field-row">
            <div>
              <label htmlFor="login-username">账号{row ? '（留空保留）' : ''}</label>
              <input
                id="login-username"
                autoComplete="off"
                required={!row || row.kind !== 'form'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="login-password">密码{row ? '（留空保留）' : ''}</label>
              <input
                id="login-password"
                type="password"
                autoComplete="new-password"
                required={!row || row.kind !== 'form'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="field-row">
            <div>
              <label htmlFor="username-field">账号输入框描述</label>
              <input
                id="username-field"
                required
                value={form.config.usernameField}
                onChange={(e) => configField('usernameField', e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password-field">密码输入框描述</label>
              <input
                id="password-field"
                required
                value={form.config.passwordField}
                onChange={(e) => configField('passwordField', e.target.value)}
              />
            </div>
          </div>
          <label htmlFor="login-submit">登录操作</label>
          <input
            id="login-submit"
            required
            value={form.config.submitInstruction}
            onChange={(e) => configField('submitInstruction', e.target.value)}
          />
        </>
      ) : (
        <>
          <label htmlFor="storage-state">登录状态 JSON{row ? '（留空保留）' : ''}</label>
          <textarea
            id="storage-state"
            rows={6}
            required={!row || row.kind !== 'storage'}
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder={
              '{"cookies":[{"name":"session","value":"…","domain":"test.example.com","path":"/"}],"origins":[]}'
            }
          />
          <small className="muted">
            从已授权的测试浏览器导出 cookies / origins。Cookie 使用精确主机名；仅支持配置范围内的域名。SSO /
            验证码可先人工登录，再导入会话。
          </small>
        </>
      )}
      <AssertionsEditor
        title="登录成功条件"
        maxItems={1}
        value={[form.config.successAssertion]}
        onChange={([successAssertion]) => setForm({ ...form, config: { ...form.config, successAssertion } })}
      />
      <p className="muted">
        结构化条件由 Playwright 等待并验证；自然语言在首次通过后自动尝试沉淀，完整覆盖时后续无需 AI。
      </p>
      <label htmlFor="login-expiry">会话有效期（可选，本地时间）</label>
      <input
        id="login-expiry"
        type="datetime-local"
        value={form.expiresAt}
        onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
      />
      <label className="inline-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        启用此登录配置
      </label>
      <div className="form-footer">
        <small className="muted">凭证加密保存，不在任务报告中返回。登录过程由视觉模型辅助定位。</small>
        <div className="button-group">
          {row && (
            <button type="button" className="button outline" disabled={busy} onClick={verify}>
              生成登录验证计划
            </button>
          )}
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            保存登录配置
          </button>
        </div>
      </div>
    </form>
  );
}
function Features({
  site,
  notify,
  selectedCaseIds = '',
}: {
  site: Website;
  notify: Notify;
  selectedCaseIds?: string;
}) {
  const [drawerNotice, setDrawerNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [browserName, setBrowserName] = useState<BrowserName>(site.config.browser ?? 'chrome');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('l2');
  const [runError, setRunError] = useState<Error | null>(null);
  const [featureDirty, setFeatureDirty] = useState(false),
    [featureBusy, setFeatureBusy] = useState(false);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const pageCheckbox = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<DeletionTarget[]>([]);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false),
    [editorDirty, setEditorDirty] = useState(false),
    [editorBusy, setEditorBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<Feature[]>([]),
    [sessions, setSessions] = useState<LoginProfile[]>([]),
    [featureId, setFeatureId] = useState(''),
    [editorFeatureId, setEditorFeatureId] = useState(''),
    [editingFeature, setEditingFeature] = useState(false),
    [newFeature, setNewFeature] = useState(false),
    [caseRow, setCaseRow] = useState<WebCaseRow | undefined>(),
    [showDisabled, setShowDisabled] = useState(false);
  async function load() {
    const [f, profiles] = await Promise.all([
      api<Feature[]>(`/websites/${site.id}/features`),
      api<LoginProfile[]>(`/websites/${site.id}/sessions`),
    ]);
    setFeatures(f);
    setSessions(profiles);
    setLoading(false);
    setSelectedCases((old) => old.filter((id) => f.some((x) => x.cases.some((c) => c.id === id))));
  }
  useEffect(() => {
    void load().catch((e) => notify(e.message, true));
  }, [site.id]);
  useEffect(() => {
    if (!loading)
      setSelectedCases([
        ...new Set(
          selectedCaseIds.split(',').filter((id) => features.some((f) => f.cases.some((c) => c.id === id))),
        ),
      ]);
  }, [selectedCaseIds, loading]);
  const feature = features.find((f) => f.id === featureId);
  const editorFeature = features.find((f) => f.id === editorFeatureId);
  const allCases = features.flatMap((f) => f.cases.map((c) => ({ ...c, feature: f })));
  const cacheStatuses = useCacheStatuses(
    site.id,
    browserName,
    allCases.map((c) => `${c.id}:${c.revision}`).join(','),
  );
  const filteredCases = allCases.filter(
    (c) =>
      (!featureId || c.feature.id === featureId) &&
      (showDisabled || (c.enabled && c.feature.enabled)) &&
      `${c.title} ${c.feature.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const paged = pageItems(filteredCases, page, pageSize);
  const pageIds = paged.items.map((c) => c.id);
  const selectedOnPage = pageIds.filter((id) => selectedCases.includes(id)).length;
  const allPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const outsideFilterCount = selectedCases.filter((id) => !filteredCases.some((c) => c.id === id)).length;
  useEffect(() => {
    if (pageCheckbox.current) pageCheckbox.current.indeterminate = selectedOnPage > 0 && !allPageSelected;
  }, [selectedOnPage, allPageSelected]);
  function requestDelete(ids: string[]) {
    setDeleting(
      allCases
        .filter((c) => ids.includes(c.id))
        .map((c) => ({
          id: c.id,
          revision: c.revision,
          title: c.title,
          featureName: c.feature.name,
        })),
    );
  }
  function edit(row?: WebCaseRow, f = feature || features.find((x) => x.enabled)) {
    if (!f) {
      setNewFeature(true);
      setDrawerNotice(null);
      setEditingFeature(true);
      return;
    }
    setDrawerNotice(null);
    setEditorFeatureId(f.id);
    setCaseRow(row);
    setEditorDirty(false);
    setEditorOpen(true);
  }
  const executableIds = selectedCases.filter(
    (id) => site.enabled && allCases.some((c) => c.id === id && c.enabled && c.feature.enabled),
  );
  const executionHint =
    selectedCases.length > 12
      ? '单次运行最多 12 条，请减少选择后运行；可批量删除全部所选用例。'
      : executableIds.length !== selectedCases.length
        ? '所选项包含停用的网站、功能或用例，请启用或取消勾选后运行。'
        : '可跨功能、跨页选择；单次运行最多 12 条。';
  return (
    <>
      {!site.enabled && (
        <div className="notice warning">此网站已停用，可以查看和校准历史用例，启用网站后可执行。</div>
      )}
      <section className="panel case-library-panel">
        <div className="library-filters">
          <label>
            功能
            <select
              aria-label="筛选功能"
              value={featureId}
              onChange={(e) => {
                setFeatureId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部功能 · {allCases.length} 条</option>
              {features.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name} · {f.cases.length}
                  {f.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            查找用例
            <input
              aria-label="查找用例"
              placeholder="搜索用例名称或功能"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => {
                setShowDisabled(e.target.checked);
                setPage(1);
              }}
            />
            包含停用用例
          </label>
        </div>
        <div className="library-actions">
          <div className="button-group">
            <button className="button outline" onClick={() => edit()}>
              <Plus size={15} />
              新建用例
            </button>
            <button
              className="button text-button"
              onClick={() => {
                setNewFeature(true);
                setDrawerNotice(null);
                setEditingFeature(true);
              }}
            >
              新建功能
            </button>
            {feature && (
              <button
                className="button text-button"
                onClick={() => {
                  setNewFeature(false);
                  setDrawerNotice(null);
                  setEditingFeature(true);
                }}
              >
                编辑功能
              </button>
            )}
          </div>
          <span className="muted">{filteredCases.length} 条用例 · 编辑在右侧打开</span>
        </div>
        {feature?.description && <p className="feature-description">{feature.description}</p>}
        <div className="library-selection">
          <label className="inline-check">
            <input
              ref={pageCheckbox}
              type="checkbox"
              checked={allPageSelected}
              disabled={!pageIds.length}
              onChange={(e) =>
                setSelectedCases(
                  e.target.checked
                    ? [...new Set([...selectedCases, ...pageIds])]
                    : selectedCases.filter((id) => !pageIds.includes(id)),
                )
              }
            />
            全选本页
          </label>
          <button
            className="button text-button"
            disabled={!filteredCases.length || filteredCases.every((c) => selectedCases.includes(c.id))}
            onClick={() =>
              setSelectedCases([...new Set([...selectedCases, ...filteredCases.map((c) => c.id)])])
            }
          >
            全选筛选结果（{filteredCases.length} 条）
          </button>
          {!!selectedCases.length && (
            <button className="button text-button" onClick={() => setSelectedCases([])}>
              清空选择
            </button>
          )}
          {!!outsideFilterCount && <small className="muted">含筛选范围外已选 {outsideFilterCount} 条</small>}
        </div>
        <div className="library-execution">
          <div>
            <strong>已选 {selectedCases.length} 条</strong>
            <small role="status">{executionHint}</small>
          </div>
          <button
            className="button outline text-danger"
            disabled={!selectedCases.length}
            onClick={() => requestDelete(selectedCases)}
          >
            <Trash2 size={15} />
            删除所选
          </button>
          <div className="execution-browser">
            <BrowserSelect compact id="cases-browser" value={browserName} onChange={setBrowserName} />
          </div>
          <div className="execution-browser">
            <ExecutionModeSelect
              id="cases-execution-mode"
              value={executionMode}
              onChange={setExecutionMode}
            />
          </div>
          <RunCasesButton
            executionMode={executionMode}
            browserName={browserName}
            projectId={site.projectId}
            siteId={site.id}
            caseIds={executableIds.length === selectedCases.length ? executableIds : []}
            notify={notify}
            onError={setRunError}
            label={`运行所选 ${selectedCases.length} 条`}
          />
        </div>
        {runError && (
          <RunStartError
            error={runError}
            onClose={() => setRunError(null)}
            onExclude={
              runError instanceof ApiError &&
              runError.details?.caseId &&
              selectedCases.includes(runError.details.caseId)
                ? () => {
                    setSelectedCases((old) =>
                      old.filter((id) => id !== (runError as ApiError).details?.caseId),
                    );
                    setRunError(null);
                  }
                : undefined
            }
            onEdit={
              runError instanceof ApiError && runError.details?.caseId
                ? () => {
                    const c = allCases.find((c) => c.id === (runError as ApiError).details?.caseId);
                    if (c) edit(c, c.feature);
                  }
                : undefined
            }
          />
        )}
        <div className="library-cases">
          {paged.items.map((c) => (
            <div className="library-case" key={c.id}>
              <div className="case-summary">
                <label className="case-check">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${c.title}`}
                    checked={selectedCases.includes(c.id)}
                    onChange={(e) =>
                      setSelectedCases(
                        e.target.checked
                          ? [...selectedCases, c.id]
                          : selectedCases.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.feature.name} · {c.content.steps.length} 个步骤 · {c.content.assertions.length}{' '}
                      项验证 · v{c.revision}
                      {!c.enabled || !c.feature.enabled ? ' · 已停用' : ''}
                    </small>
                  </span>
                </label>
                <CacheBadges status={cacheStatuses[c.id]} realtime={c.content.cachePolicy === 'realtime'} />
                <CaseCapabilities content={c.content} status={cacheStatuses[c.id]} />
              </div>
              <div className="button-group">
                <button
                  className="button text-button text-danger"
                  aria-label={`删除 ${c.title}`}
                  onClick={() => requestDelete([c.id])}
                >
                  删除
                </button>
                <button className="button outline" onClick={() => edit(c, c.feature)}>
                  编辑校准
                </button>
                <RunCasesButton
                  executionMode={executionMode}
                  browserName={browserName}
                  projectId={site.projectId}
                  siteId={site.id}
                  caseIds={site.enabled && c.feature.enabled && c.enabled ? [c.id] : []}
                  notify={notify}
                  onError={setRunError}
                />
              </div>
            </div>
          ))}
          {!filteredCases.length && (
            <div className="empty compact">
              {loading
                ? '正在加载用例…'
                : search || featureId
                  ? '没有符合筛选条件的用例'
                  : '暂无用例。可以新建用例，或探索网站并审核草稿后加入这里。'}
            </div>
          )}
          <Pagination
            total={filteredCases.length}
            page={paged.current}
            size={pageSize}
            onPage={setPage}
            onSize={(v) => {
              setPageSize(v);
              setPage(1);
            }}
          />
        </div>
      </section>
      {!!deleting.length && (
        <DeleteCasesDialog
          siteId={site.id}
          siteName={site.name}
          cases={deleting}
          onClose={() => setDeleting([])}
          onRefresh={load}
          onDeleted={(ids) => {
            setFeatures((old) =>
              old.map((f) => ({ ...f, cases: f.cases.filter((c) => !ids.includes(c.id)) })),
            );
            setSelectedCases((old) => old.filter((id) => !ids.includes(id)));
            setDeleting([]);
            notify(`已删除 ${ids.length} 条用例，历史报告已保留`);
            void load().catch((e) => notify(`删除已完成，列表刷新失败：${e.message}`, true));
          }}
        />
      )}
      {editingFeature && (
        <SideDrawer
          notice={drawerNotice}
          title={newFeature ? '新建功能' : '编辑功能'}
          dirty={featureDirty}
          busy={featureBusy}
          description="功能用于归类用例和记录共同的业务规则。"
          onClose={() => setEditingFeature(false)}
        >
          <FeatureEditor
            key={newFeature ? 'new' : feature?.id}
            site={site}
            row={newFeature ? undefined : feature}
            onDirtyChange={setFeatureDirty}
            onBusyChange={setFeatureBusy}
            notify={(message, error) => {
              setDrawerNotice({ message, error });
              if (!error) notify(message);
            }}
            saved={async (f) => {
              await load();
              setFeatureId(f.id);
              setEditingFeature(false);
              setNewFeature(false);
            }}
          />
        </SideDrawer>
      )}
      {editorOpen && editorFeature && (
        <SideDrawer
          notice={drawerNotice}
          title={caseRow ? `编辑校准 · ${caseRow.title}` : '新建测试用例'}
          dirty={editorDirty}
          busy={editorBusy}
          onClose={() => setEditorOpen(false)}
        >
          {!caseRow && (
            <div className="new-case-feature">
              <label>
                所属功能
                <select
                  aria-label="新用例所属功能"
                  value={editorFeatureId}
                  onChange={(e) => setEditorFeatureId(e.target.value)}
                >
                  {features
                    .filter((f) => f.enabled)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          )}
          <CaseEditor
            key={caseRow ? `${caseRow.id}:${caseRow.revision}` : `new-${site.id}`}
            feature={editorFeature}
            sessions={sessions}
            row={caseRow}
            notify={(message, error) => {
              setDrawerNotice({ message, error });
              if (!error) notify(message);
            }}
            onDirtyChange={setEditorDirty}
            onBusyChange={setEditorBusy}
            saved={async (r) => {
              await load();
              setCaseRow(r);
              setEditorOpen(false);
              setEditorDirty(false);
            }}
          />
        </SideDrawer>
      )}
    </>
  );
}
function FeatureEditor({
  site,
  row,
  notify,
  saved,
  onDirtyChange,
  onBusyChange,
}: {
  site: Website;
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
  row?: Feature;
  notify: Notify;
  saved: (f: Feature) => Promise<void>;
}) {
  const [name, setName] = useState(row?.name || ''),
    [description, setDescription] = useState(row?.description || ''),
    [enabled, setEnabled] = useState(row?.enabled ?? true),
    [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  return (
    <form
      className="panel form-panel"
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body = { name, description, enabled, revision: row?.revision };
          const r = row
            ? await patch<Feature>(`/web-features/${row.id}`, body)
            : await post<Feature>(`/websites/${site.id}/features`, body);
          await saved(r);
          notify('功能已保存');
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{row ? '编辑功能' : '新建功能'}</h2>
      <label htmlFor="feature-name">功能名称</label>
      <input
        id="feature-name"
        required
        minLength={2}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="例如：创建订单"
      />
      <label htmlFor="feature-description">业务规则与说明</label>
      <textarea
        id="feature-description"
        rows={4}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="描述角色、入口、业务规则和边界条件"
      />
      <label className="inline-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用功能
      </label>
      <button className="button primary" disabled={busy}>
        保存功能
      </button>
    </form>
  );
}
function CaseEditor({
  feature,
  sessions,
  row,
  notify,
  saved,
  onDirtyChange,
  onBusyChange,
}: {
  feature: Feature;
  sessions: LoginProfile[];
  row?: WebCaseRow;
  notify: Notify;
  saved: (c: WebCaseRow) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [form, setForm] = useState<WebCaseInput>(row?.content || { ...blankCase }),
    [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(row?.content || blankCase);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  return (
    <form
      className="panel form-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body = { ...form, revision: row?.revision };
          const r = row
            ? await patch<WebCaseRow>(`/web-cases/${row.id}`, body)
            : await post<WebCaseRow>(`/web-features/${feature.id}/cases`, body);
          await saved(r);
          notify('用例已保存，可以直接测试');
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-heading">
        <h2>{row ? '编辑测试用例' : '新建测试用例'}</h2>
        {row && <span className="version">v{row.revision}</span>}
      </div>
      <label htmlFor="case-title">用例名称</label>
      <input
        id="case-title"
        required
        minLength={2}
        maxLength={120}
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        placeholder="创建订单成功"
      />
      <div className="field-row">
        <div>
          <label htmlFor="case-path">功能入口路径或 URL</label>
          <input
            id="case-path"
            required
            value={form.startPath}
            onChange={(e) => setForm({ ...form, startPath: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="case-session">登录身份</label>
          <select
            id="case-session"
            value={form.sessionId || ''}
            onChange={(e) => setForm({ ...form, sessionId: e.target.value || null })}
          >
            <option value="">访客 · 无需登录</option>
            {sessions.map((s) => (
              <option disabled={!s.enabled} key={s.id} value={s.id}>
                {s.name}
                {!s.enabled ? '（已停用）' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={form.verifySessionOnly}
          disabled={!form.sessionId}
          onChange={(e) => setForm({ ...form, verifySessionOnly: e.target.checked })}
        />
        使用登录完成时的页面，跳过入口导航
      </label>
      {form.sessionId && form.steps.some((s) => /登录|login/i.test(s.text)) && (
        <div className="notice warning">
          已选登录身份会在步骤开始前自动登录。若只验证登录成功，可勾选“使用登录完成时的页面”并删除重复登录步骤；错误账号登录应另建访客用例，明确填写测试输入。成功与失败预期请拆成两条用例。
          {form.steps.length === 1 && form.steps[0].kind === 'act' && (
            <div className="button-group">
              <button
                type="button"
                className="button outline"
                onClick={() => setForm({ ...form, steps: [], verifySessionOnly: true })}
              >
                改为仅验证已保存身份
              </button>
            </div>
          )}
        </div>
      )}
      <label className="inline-check">
        <input
          type="checkbox"
          checked={form.cachePolicy === 'realtime'}
          onChange={(e) => setForm({ ...form, cachePolicy: e.target.checked ? 'realtime' : 'auto' })}
        />
        此用例始终实时推理，不读写缓存
      </label>
      <small className="muted">
        适合 Canvas、跨域 iframe、封闭 Shadow DOM、动态 SVG
        等依赖实时视觉的用例；运行时也会检查页面是否适合缓存。
      </small>
      <label htmlFor="case-preconditions">前置条件与测试数据</label>
      <textarea
        id="case-preconditions"
        rows={3}
        value={form.preconditions}
        onChange={(e) => setForm({ ...form, preconditions: e.target.value })}
        placeholder="例如：商品 A 有库存；测试数据已准备。需要自动操作的准备步骤请写在下面。"
      />
      <StepEditor label="操作步骤" steps={form.steps} onChange={(steps) => setForm({ ...form, steps })} />
      <AssertionsEditor value={form.assertions} onChange={(assertions) => setForm({ ...form, assertions })} />
      <ParametersEditor
        value={form.parameters ?? {}}
        onChange={(parameters) => setForm({ ...form, parameters })}
      />
      <StepEditor
        label="清理步骤"
        steps={form.cleanup}
        onChange={(cleanup) => setForm({ ...form, cleanup })}
      />
      <small className="muted">
        留空时不自动清理业务数据。会话在用例结束后销毁，清理失败会记录并停止后续用例。
      </small>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        启用此用例
      </label>
      <div className="form-footer">
        <span className="muted">保存修改只影响新任务，已确认任务保留原快照。</span>
        <div className="button-group">
          <button className="button primary" disabled={busy}>
            <Save size={16} />
            保存用例
          </button>
        </div>
      </div>
    </form>
  );
}
