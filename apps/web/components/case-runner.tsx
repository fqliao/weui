'use client';
import { useEffect, useRef, useState } from 'react';
import { Play, Compass, Loader2 } from 'lucide-react';
import { api, post, go, ApiError, type Project, type Meta, type Run } from './api';
import type { Feature } from './websites';
import type { Notify } from './workbench';
import { NewTask } from './tasks';
import { Pagination, pageItems } from './pagination';
import { RunStartError } from './run-start-error';
import { BrowserSelect } from './browser-select';
import { browserLabels, type BrowserName } from '../../../packages/contracts/src/browser-choice';
import { ExecutionModeSelect, CacheBadges, useCacheStatuses } from './execution-mode';
import type { ExecutionMode } from '../../../packages/contracts/src/execution-cache';
import { assertionLabel } from '../../../packages/contracts/src/static-ui';

export const websiteKey = (projectId: string) => `tracelab:website:${projectId}`;
export function rememberedWebsite(projectId: string) {
  return typeof window === 'undefined' ? '' : sessionStorage.getItem(websiteKey(projectId)) || '';
}
export function rememberWebsite(projectId: string, id: string) {
  if (id) sessionStorage.setItem(websiteKey(projectId), id);
}
export function caseRoute(site: string, ids: string[] = []) {
  return `cases?website=${encodeURIComponent(site)}${ids.length ? `&cases=${ids.map(encodeURIComponent).join(',')}` : ''}`;
}
type Choice = {
  id: string;
  title: string;
  feature: string;
  revision?: number;
  steps: string[];
  assertions: string[];
  session: string;
};
export function CaseRunner({
  project,
  meta,
  notify,
  query = '',
}: {
  project: Project;
  meta: Meta;
  notify: Notify;
  query?: string;
}) {
  const params = new URLSearchParams(query);
  const [site, setSite] = useState(() => {
    const requested = params.get('website') || rememberedWebsite(project.id);
    return (
      project.environments.find((e) => e.enabled && e.id === requested)?.id ||
      project.environments.find((e) => e.enabled && e.adapter === 'midscene-web-v1')?.id ||
      project.environments.find((e) => e.enabled)?.id ||
      ''
    );
  });
  const [choices, setChoices] = useState<Choice[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expert, setExpert] = useState(false),
    [maxActions, setMaxActions] = useState(100);
  const [runError, setRunError] = useState<Error | null>(null);
  const key = useRef('');
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10);
  const env = project.environments.find((e) => e.id === site);
  const [browserName, setBrowserName] = useState<BrowserName>(env?.config.browser ?? 'chrome');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('l2');
  const cacheStatuses = useCacheStatuses(env?.adapter === 'midscene-web-v1' ? site : '', browserName);
  useEffect(() => {
    setBrowserName(env?.config.browser ?? 'chrome');
    key.current = '';
  }, [site, env?.config.browser]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setChoices([]);
    setSelected([]);
    setPage(1);
    setSearch('');
    setError('');
    setRunError(null);
    key.current = '';
    rememberWebsite(project.id, site);
    const read = async () => {
      let rows: Choice[] = [];
      if (env?.adapter === 'midscene-web-v1') {
        const features = await api<Feature[]>(`/websites/${site}/features`);
        rows = features
          .filter((f) => f.enabled)
          .flatMap((f) =>
            f.cases
              .filter((c) => c.enabled)
              .map((c) => ({
                id: c.id,
                title: c.title,
                feature: f.name,
                revision: c.revision,
                steps: c.content.steps.map((s) => s.text),
                assertions: c.content.assertions.map(assertionLabel),
                session: c.content.sessionId ? '使用用例保存的登录身份' : '访客会话',
              })),
          );
      } else if (env?.adapter === 'sample-approval-v1') {
        rows = meta.cases.map((c) => ({
          ...c,
          feature: c.category,
          assertions: [c.expected],
          session: '审批样例身份',
        }));
      }
      if (!alive) return;
      setChoices(rows);
      const requested = new URLSearchParams(query).get('cases')?.split(',') || [];
      setSelected(
        rows
          .filter((c) => requested.includes(c.id))
          .map((c) => c.id)
          .slice(0, 12),
      );
    };
    void read()
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [site, project.id, env?.adapter, query]);
  function select(ids: string[]) {
    setSelected(ids);
    key.current = '';
  }
  const visible = choices.filter((c) =>
    `${c.title} ${c.feature}`.toLowerCase().includes(search.toLowerCase()),
  );
  const paged = pageItems(visible, page, pageSize);
  if (expert)
    return (
      <>
        <button className="back" onClick={() => setExpert(false)}>
          ← 返回选择用例
        </button>
        <NewTask project={project} meta={meta} notify={notify} />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">用例选择与回归执行</div>
          <h1>运行测试用例</h1>
          <p>选择已校准的用例，直接开始测试。运行后可查看过程、验证结果并再次回归。</p>
        </div>
        <button
          className="button outline"
          onClick={() => go(`discoveries/new?website=${encodeURIComponent(site)}`)}
        >
          <Compass size={17} />
          探索新用例
        </button>
      </div>
      <section className="panel case-runner">
        <div className="field-row">
          <div>
            <label htmlFor="run-website">测试网站</label>
            <select id="run-website" value={site} disabled={busy} onChange={(e) => setSite(e.target.value)}>
              {project.environments
                .filter((e) => e.enabled)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.adapter === 'sample-approval-v1' ? ' · 样例' : ''}
                  </option>
                ))}
            </select>
            <p className="muted">{env?.baseUrl || '请先添加网站'}</p>
          </div>
          <div>
            <label htmlFor="case-search">查找用例</label>
            <input
              id="case-search"
              placeholder="用例名称或功能"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <BrowserSelect
          id="run-browser"
          value={browserName}
          disabled={busy}
          onChange={(value) => {
            setBrowserName(value);
            key.current = '';
          }}
        />
        <ExecutionModeSelect
          id="runner-execution-mode"
          value={executionMode}
          disabled={busy}
          onChange={(v) => {
            setExecutionMode(v);
            key.current = '';
          }}
        />
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {runError && <RunStartError error={runError} onClose={() => setRunError(null)} />}
        <div className="case-toolbar">
          <strong>可执行用例 · {choices.length}</strong>
          <div className="button-group">
            <button
              className="button outline"
              disabled={busy || !visible.length}
              onClick={() =>
                select([...new Set([...selected, ...paged.items.map((c) => c.id)])].slice(0, 12))
              }
            >
              选择本页（合计最多 12 条）
            </button>
            <button className="button outline" disabled={busy || !selected.length} onClick={() => select([])}>
              清空选择
            </button>
            <a className="button outline" href={`#/cases?website=${encodeURIComponent(site)}`}>
              编辑用例
            </a>
          </div>
        </div>
        {loading ? (
          <div className="empty">
            <Loader2 className="spin" />
            正在读取用例
          </div>
        ) : !choices.length ? (
          <div className="empty">
            <h3>这个网站还没有可执行用例</h3>
            <p>探索生成草稿并审核发布，或在用例库中手动添加。</p>
            <a className="button primary" href={`#/discoveries/new?website=${encodeURIComponent(site)}`}>
              探索生成用例
            </a>
          </div>
        ) : !visible.length ? (
          <div className="empty">没有匹配的用例，请调整搜索词。</div>
        ) : (
          <div className="case-choices">
            {paged.items.map((c) => (
              <article className={`case-choice ${selected.includes(c.id) ? 'selected' : ''}`} key={c.id}>
                <label className="case-check">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${c.title}`}
                    checked={selected.includes(c.id)}
                    disabled={busy || (!selected.includes(c.id) && selected.length >= 12)}
                    onChange={(e) =>
                      select(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
                    }
                  />
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.feature} · {c.revision ? `v${c.revision} · ` : ''}
                      {c.session}
                    </small>
                  </span>
                </label>
                {env?.adapter === 'midscene-web-v1' && <CacheBadges status={cacheStatuses[c.id]} />}
                <details>
                  <summary>
                    {c.steps.length} 个步骤 · {c.assertions.length} 项验证 · 查看内容
                  </summary>
                  <ol>
                    {c.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  <strong>预期结果</strong>
                  <ul>
                    {c.assertions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </details>
              </article>
            ))}
          </div>
        )}
        {!loading && (
          <Pagination
            total={visible.length}
            page={paged.current}
            size={pageSize}
            onPage={setPage}
            onSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        )}
        <details className="advanced-options">
          <summary>高级选项</summary>
          <label htmlFor="run-budget">工具动作上限（整次运行共享）</label>
          <input
            id="run-budget"
            type="number"
            min={1}
            max={500}
            value={maxActions}
            disabled={busy}
            onChange={(e) => {
              setMaxActions(Number(e.target.value));
              key.current = '';
            }}
          />
          <p className="muted">默认沿用用例中的登录身份、步骤和预期，执行前自动保存版本快照。</p>
          <button className="button outline" onClick={() => setExpert(true)}>
            按目标规划（知识 / Skill / Agent）
          </button>
        </details>
        <div className="case-run-footer">
          <div>
            <strong>已选择 {selected.length} 条用例</strong>
            <small>翻页保留选择 · 最多 12 条 · {browserLabels[browserName]} / Midscene</small>
          </div>
          <button
            className="button primary"
            disabled={
              busy ||
              loading ||
              !selected.length ||
              !meta.executionEnabled ||
              !meta.vision.configured ||
              !Number.isInteger(maxActions) ||
              maxActions < 1 ||
              maxActions > 500
            }
            onClick={async () => {
              setBusy(true);
              setError('');
              setRunError(null);
              if (!key.current) key.current = crypto.randomUUID();
              try {
                const run = await post<Run>('/case-runs', {
                  projectId: project.id,
                  environmentId: site,
                  browserName,
                  executionMode,
                  caseIds: selected,
                  idempotencyKey: key.current,
                  budget: { maxActions },
                });
                go(`runs/${run.id}`);
              } catch (e) {
                if (e instanceof ApiError && e.status < 500) key.current = '';
                setRunError(e as Error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            {busy ? '正在开始测试' : '运行所选用例'}
          </button>
        </div>
        {!meta.vision.configured && (
          <p className="notice warning">配置 Midscene 视觉模型后即可执行，用例编辑仍可使用。</p>
        )}
      </section>
    </>
  );
}
