'use client';
import { PricingSettings } from './model-pricing';
import { product } from './product';
import { useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  Copy,
  Layers,
  Plus,
  Play,
  Save,
  Upload,
  RotateCcw,
  ArrowLeft,
  Loader2,
  Wrench,
  Globe,
  Code,
  Shield,
  Check,
  ExternalLink,
  Activity,
} from 'lucide-react';
import {
  api,
  post,
  patch,
  go,
  date,
  Badge,
  type Knowledge,
  type Project,
  type Meta,
  type Skill,
  type Draft,
  type Tool,
  type User,
  type Run,
} from './api';
import type { Notify } from './workbench';
export function KnowledgeView({ project, notify }: { project: Project; notify: Notify }) {
  const [releases, setReleases] = useState<Knowledge[]>([]),
    [tab, setTab] = useState('overview');
  useEffect(() => {
    api<Knowledge[]>(`/knowledge/releases?projectId=${project.id}`)
      .then(setReleases)
      .catch((e) => notify(e.message, true));
  }, [project.id]);
  const k = releases[0],
    page = k?.content.pages.find((p) => p.id === tab);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试领域知识</div>
          <h1>领域知识</h1>
          <p>让规则、场景与断言在同一份可追溯知识中对齐。</p>
        </div>
        {k && (
          <span className="release-tag">
            <Check size={14} />
            固定快照 · v{k.version}
          </span>
        )}
      </div>
      {!k ? (
        <div className="empty">暂无已发布知识快照</div>
      ) : (
        <>
          <div className="knowledge-summary">
            <div>
              <BookOpen size={24} />
              <strong>{k.name}</strong>
              <span>{k.content.pages.length} 篇 Wiki</span>
              <span>{k.content.rules.length} 条业务规则</span>
            </div>
            <code>SHA256 {k.hash.slice(0, 18)}</code>
          </div>
          <div className="knowledge-layout">
            <aside className="panel knowledge-nav">
              <small>领域 WIKI</small>
              {k.content.pages.map((p) => (
                <button key={p.id} className={tab === p.id ? 'selected' : ''} onClick={() => setTab(p.id)}>
                  <FileIcon />
                  {p.title}
                  <ChevronRight size={13} />
                </button>
              ))}
              <small>结构化知识</small>
              <button className={tab === 'rules' ? 'selected' : ''} onClick={() => setTab('rules')}>
                <Shield size={15} />
                业务规则
                <ChevronRight size={13} />
              </button>
              <button className={tab === 'ontology' ? 'selected' : ''} onClick={() => setTab('ontology')}>
                <Layers size={15} />
                本体与覆盖关系
                <ChevronRight size={13} />
              </button>
            </aside>
            <article className="panel knowledge-document">
              {page ? (
                <>
                  <div className="eyebrow">知识条目 / {page.id.toUpperCase()}</div>
                  <h2>{page.title}</h2>
                  <div className="document-meta">
                    <span>来源：{page.source}</span>
                    <span>状态：样例规则</span>
                  </div>
                  <p className="document-body">{page.body}</p>
                  <div className="notice">
                    <BookOpen size={18} />
                    <span>Wiki 解释知识，正式规则提供业务预期。运行观察不会自动修改当前规则。</span>
                  </div>
                  <h3>关联规则</h3>
                  <div className="related-rules">
                    {k.content.rules
                      .filter((r) => page.body.includes(r.id) || tab === 'overview')
                      .map((r) => (
                        <button key={r.id} onClick={() => setTab('rules')}>
                          <span>{r.id}</span>
                          {r.title}
                          <ChevronRight size={15} />
                        </button>
                      ))}
                  </div>
                </>
              ) : tab === 'rules' ? (
                <>
                  <div className="eyebrow">业务规则版本</div>
                  <h2>正式规则清单</h2>
                  <p>此版本适用于审批样例系统。真实业务规则需另行审核发布。</p>
                  <div className="rules-list">
                    {k.content.rules.map((r) => (
                      <section key={r.id}>
                        <span className="rule-id">{r.id}</span>
                        <div>
                          <h3>{r.title}</h3>
                          <p>{r.text}</p>
                          <small>
                            来源 {r.source} · {r.owner}
                          </small>
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="eyebrow">领域概念与关系</div>
                  <h2>从业务概念到测试证据</h2>
                  <p>通过稳定 ID 连接业务实体、约束与验证场景。</p>
                  <div className="ontology-concepts">
                    {k.content.ontology.entities.map((e) => (
                      <span key={e}>{e}</span>
                    ))}
                  </div>
                  <div className="ontology-flow">
                    <div>
                      <strong>业务规则</strong>
                      <small>角色 / 状态 / 约束</small>
                    </div>
                    <ChevronRight />
                    <div>
                      <strong>测试场景</strong>
                      <small>动作 / 数据 / 前置条件</small>
                    </div>
                    <ChevronRight />
                    <div>
                      <strong>独立断言</strong>
                      <small>预期 / 实测 / 证据</small>
                    </div>
                  </div>
                  <h3>已建模的验证关系</h3>
                  <div className="relation-grid">
                    {k.content.ontology.relations.map((r, i) => (
                      <div key={i}>
                        <span>{r.from}</span>
                        <small>verifies</small>
                        <strong>{r.to}</strong>
                      </div>
                    ))}
                  </div>
                  <p className="muted">这是当前知识包已建模的关系，不代表穷尽所有业务风险。</p>
                </>
              )}
            </article>
          </div>
        </>
      )}
    </>
  );
}
function FileIcon() {
  return <BookOpen size={15} />;
}
type DebugSkill = Skill & {
  debugRuns: Pick<Run, 'id' | 'status' | 'summary' | 'cleanupStatus' | 'createdAt'>[];
};
export function SkillsView({
  project,
  meta,
  user,
  notify,
}: {
  project: Project;
  meta: Meta;
  user: User;
  notify: Notify;
}) {
  const [skills, setSkills] = useState<Skill[]>([]),
    [editing, setEditing] = useState<Skill | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [selected, setSelected] = useState<DebugSkill | null>(null),
    [debugMode, setDebugMode] = useState(meta.model.configured ? 'deepagents' : 'catalog'),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api<Skill[]>(`/skills?projectId=${project.id}`)
      .then(setSkills)
      .catch((e) => notify(e.message, true));
  useEffect(() => {
    void refresh();
  }, [project.id]);
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    const timer = setInterval(
      () =>
        api<DebugSkill>(`/skills/${id}`)
          .then(setSelected)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  }, [selected?.id]);
  function clone(s: Skill) {
    setEditing(null);
    setDraft({ ...s.draft, name: `${s.name} · 我的版本` });
    setSelected(null);
  }
  async function details(s: Skill) {
    setSelected(await api<DebugSkill>(`/skills/${s.id}`));
    setDraft(null);
  }
  if (draft)
    return (
      <>
        <button
          className="back"
          onClick={() => {
            setDraft(null);
            setEditing(null);
          }}
        >
          <ArrowLeft size={16} />
          返回技能库
        </button>
        <div className="page-heading">
          <div>
            <div className="eyebrow">可复用的测试方法</div>
            <h1>{editing ? '编辑 Skill 草稿' : '创建自定义 Skill'}</h1>
            <p>编写测试方法，复用已注册工具。业务预期由规则与断言维护。</p>
          </div>
          <span className="version">草稿 · 不影响已发布版本</span>
        </div>
        <form
          className="skill-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = editing
                ? await patch<Skill>(`/skills/${editing.id}/draft`, { draft })
                : await post<Skill>('/skills', { projectId: project.id, draft });
              setDraft(null);
              setEditing(null);
              await refresh();
              await details(result);
              notify('Skill 草稿已保存，接下来可以隔离调试');
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <section className="panel form-panel">
            <div className="field-row">
              <div>
                <label htmlFor="skill-name">Skill 名称</label>
                <input
                  id="skill-name"
                  required
                  minLength={2}
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="skill-description">适用场景</label>
                <input
                  id="skill-description"
                  required
                  minLength={4}
                  maxLength={300}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
            </div>
            <label htmlFor="skill-instructions">测试方法与操作说明</label>
            <textarea
              id="skill-instructions"
              className="instructions"
              required
              minLength={20}
              maxLength={8000}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
            <p className="muted">写清适用范围、检查顺序和停止条件。文本中的授权或代码不具有执行权限。</p>
            <h3>关联场景</h3>
            <div className="case-picker">
              {meta.cases.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={draft.caseIds.includes(c.id)}
                    onChange={(e) => {
                      const ids = e.target.checked
                        ? [...draft.caseIds, c.id]
                        : draft.caseIds.filter((x) => x !== c.id);
                      const rules = [
                        ...new Set([
                          ...meta.cases.filter((c) => ids.includes(c.id)).flatMap((c) => c.ruleIds),
                          'R10',
                        ]),
                      ];
                      setDraft({ ...draft, caseIds: ids, ruleIds: rules });
                    }}
                  />
                  <span>{c.id}</span>
                  {c.title}
                </label>
              ))}
            </div>
            <div className="form-footer">
              <span className="muted">
                {draft.caseIds.length} 个场景 · {draft.ruleIds.length} 条规则依赖
              </span>
              <button className="button primary" disabled={busy || !draft.caseIds.length}>
                {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}保存 Skill 草稿
              </button>
            </div>
          </section>
          <aside className="panel context-card">
            <h3>工具与规则依赖</h3>
            <div className="dependency-list">
              {draft.toolIds.map((t) => (
                <div key={t}>
                  <Wrench size={14} />
                  <code>{t}</code>
                </div>
              ))}
            </div>
            <h3>自动关联的规则</h3>
            <div className="chips">
              {draft.ruleIds.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </div>
            <div className="notice">
              正式发布前需要对当前草稿完整调试，并由管理员确认。输入：goal；输出：CaseResult[]。
            </div>
          </aside>
        </form>
      </>
    );
  if (selected) {
    const good = selected.debugRuns.find(
      (r) =>
        r.status === 'COMPLETED' &&
        r.cleanupStatus === 'CLEAN' &&
        r.summary.length === selected.draft.caseIds.length &&
        r.summary.every((c) => c.result === 'PASS'),
    );
    return (
      <>
        <button className="back" onClick={() => setSelected(null)}>
          <ArrowLeft size={16} />
          返回技能库
        </button>
        <div className="page-heading">
          <div>
            <div className="eyebrow">测试技能与版本</div>
            <h1>{selected.name}</h1>
            <p>{selected.description}</p>
          </div>
          <div className="button-group">
            <button className="button outline" onClick={() => clone(selected)}>
              <Copy size={16} />
              复制为新 Skill
            </button>
            {!selected.template && (selected.ownerId === user.id || user.role === 'ADMIN') && (
              <button
                className="button outline"
                onClick={() => {
                  setEditing(selected);
                  setDraft(selected.draft);
                }}
              >
                编辑草稿
              </button>
            )}
          </div>
        </div>
        <div className="skill-detail-grid">
          <section className="panel form-panel">
            <div className="panel-heading">
              <h2>当前草稿</h2>
              <code>{selected.draftHash.slice(0, 12)}</code>
            </div>
            <pre className="skill-method">{selected.draft.instructions}</pre>
            <div className="chips">
              {selected.draft.caseIds.map((id) => (
                <span key={id}>{id}</span>
              ))}
            </div>
            <label htmlFor="debug-mode">调试计划方式</label>
            <select id="debug-mode" value={debugMode} onChange={(e) => setDebugMode(e.target.value)}>
              <option value="deepagents" disabled={!meta.model.configured}>
                Deep Agents · 真实模型规划
              </option>
              <option value="catalog">目录计划 · 不调用 LLM</option>
            </select>
            <div className="skill-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const k = await api<Knowledge[]>(`/knowledge/releases?projectId=${project.id}`);
                    const result = await post<{ taskId: string }>(`/skills/${selected.id}/debug-runs`, {
                      environmentId: project.environments[0]?.id,
                      knowledgeReleaseId: k[0]?.id,
                      mode: debugMode,
                    });
                    go(`tasks/${result.taskId}`);
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Play size={16} />
                创建隔离调试任务
              </button>
              {user.role === 'ADMIN' && (
                <button
                  className="button outline"
                  disabled={busy || !good}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await post(`/skills/${selected.id}/releases`, { debugRunId: good!.id });
                      await details(selected);
                      await refresh();
                      notify('Skill 已发布，可在新任务中选用');
                    } catch (e) {
                      notify((e as Error).message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Upload size={16} />
                  发布当前草稿
                </button>
              )}
            </div>
            <p className="muted">
              {good
                ? '当前草稿已完成全量调试，管理员可以发布。'
                : '发布要求：当前草稿全部用例通过且清理成功。调试任务需要先确认计划。'}
            </p>
            <h3>当前草稿的调试记录</h3>
            {selected.debugRuns.length ? (
              selected.debugRuns.map((r) => (
                <button className="debug-row" key={r.id} onClick={() => go(`runs/${r.id}`)}>
                  <code>{r.id.slice(0, 8)}</code>
                  <Badge status={r.status} />
                  <span>{r.summary.length} 个结果</span>
                  <ChevronRight size={16} />
                </button>
              ))
            ) : (
              <div className="empty compact">尚未完成当前草稿的调试。</div>
            )}
          </section>
          <aside className="panel form-panel">
            <h2>发布版本</h2>
            <p>回退只改变新任务默认版本，在途任务保持已锁定版本。</p>
            {selected.releases.length ? (
              selected.releases.map((r) => (
                <div className="release-row" key={r.id}>
                  <div>
                    <strong>
                      v{r.version}{' '}
                      {r.id === selected.activeReleaseId && (
                        <span className="badge status-pass">当前默认</span>
                      )}
                    </strong>
                    <small>
                      {date(r.createdAt)} · {r.hash.slice(0, 10)}
                    </small>
                  </div>
                  {user.role === 'ADMIN' && r.id !== selected.activeReleaseId && !r.disabled && (
                    <button
                      className="button outline small"
                      onClick={async () => {
                        try {
                          await post(`/skills/${selected.id}/rollback`, { releaseId: r.id });
                          await details(selected);
                          await refresh();
                          notify('新任务默认版本已回退');
                        } catch (e) {
                          notify((e as Error).message, true);
                        }
                      }}
                    >
                      <RotateCcw size={14} />
                      回退
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="empty compact">尚无发布版本</div>
            )}
          </aside>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试技能库</div>
          <h1>技能库</h1>
          <p>把测试经验写成可复用的方法，交给 Agent 在受控范围内使用。</p>
        </div>
        <span className="method-tag">
          {skills.length} 个 Skill · {skills.filter((s) => s.activeReleaseId).length} 个已发布
        </span>
      </div>
      <div className="skill-intro">
        <Layers size={26} />
        <div>
          <h3>从模板复制，开始您的第一个 Skill</h3>
          <p>编辑方法 → 选择场景 → 隔离调试 → 管理员发布 → 在任务中复用。</p>
        </div>
      </div>
      <div className="skill-grid">
        {skills.map((s) => (
          <article className="panel skill-card" key={s.id}>
            <div className="skill-card-top">
              <span className="skill-icon">
                <Layers size={23} />
              </span>
              <span className={'tag ' + (s.template ? '' : 'custom')}>
                {s.template ? '内置模板' : '自定义 Skill'}
              </span>
            </div>
            <h2>{s.name}</h2>
            <p>{s.description}</p>
            <div className="chips">
              <span>{s.draft.caseIds.length} 个场景</span>
              <span>{s.draft.toolIds.length} 个工具</span>
              <span>{s.activeReleaseId ? '已发布' : '草稿'}</span>
            </div>
            <div className="skill-card-actions">
              <button className="button outline" onClick={() => void details(s)}>
                查看与调试
                <ChevronRight size={14} />
              </button>
              <button
                className="icon-button"
                title="复制 Skill"
                aria-label={`复制 ${s.name}`}
                onClick={() => clone(s)}
              >
                <Copy size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
export function ToolsView({ project, notify }: { project: Project; notify: Notify }) {
  const [tools, setTools] = useState<Tool[]>([]),
    [filter, setFilter] = useState('全部');
  useEffect(() => {
    api<Tool[]>(`/tools?projectId=${project.id}`)
      .then(setTools)
      .catch((e) => notify(e.message, true));
  }, [project.id]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">测试工具与授权范围</div>
          <h1>工具中心</h1>
          <p>注册具体能力，限定环境与权限，记录每次调用的实际结果。</p>
        </div>
        <span className="release-tag">{tools.length} 个受控工具</span>
      </div>
      <div className="notice">
        <Shield size={18} />
        <span>
          工具凭证仅在执行侧注入。当前提供 SDK 与审批样例 HTTP 适配器；新增业务系统需要维护者接入并验证契约。
        </span>
      </div>
      <div className="tabs standalone">
        {['全部', 'SDK', 'HTTP'].map((t) => (
          <button key={t} className={t === filter ? 'selected' : ''} onClick={() => setFilter(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="tool-grid">
        {tools
          .filter((t) => filter === '全部' || t.type === filter)
          .map((t) => (
            <article className="panel tool-card" key={t.id}>
              <div className="tool-heading">
                <span className="tool-icon">
                  {t.type === 'HTTP' ? <Globe size={24} /> : <Code size={24} />}
                </span>
                <div>
                  <h2>{t.name}</h2>
                  <code>{t.id}</code>
                </div>
                <span className={'badge ' + (t.available ? 'status-pass' : 'status-blocked')}>
                  {t.available ? '已注册' : '待配置'}
                </span>
              </div>
              <p>{t.description}</p>
              <dl>
                <dt>接入方式</dt>
                <dd>
                  {t.type} · v{t.version}
                </dd>
                <dt>副作用范围</dt>
                <dd>{t.effect === 'read' ? '只读查询' : '隔离测试环境内写操作'}</dd>
                <dt>授权范围</dt>
                <dd>{t.scope}</dd>
                <dt>凭证处理</dt>
                <dd>{t.credential}</dd>
              </dl>
            </article>
          ))}
      </div>
    </>
  );
}
export function SettingsView({
  project,
  meta,
  user,
  notify,
  refresh,
}: {
  project: Project;
  meta: Meta;
  user: User;
  notify: Notify;
  refresh: () => Promise<void>;
}) {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null),
    [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [audit, setAudit] = useState<{ id: string; action: string; targetId: string; createdAt: string }[]>([]);
  const load = () => {
    if (user.role === 'ADMIN')
      Promise.all([
        api<Record<string, unknown>>('/admin/health'),
        api<typeof audit>(`/admin/audit?projectId=${project.id}`),
      ])
        .then(([h, a]) => {
          setHealth(h);
          setAudit(a);
        })
        .catch((e) => notify(e.message, true));
  };
  useEffect(load, [project.id]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">工作空间与执行配置</div>
          <h1>空间设置</h1>
          <p>查看执行能力与环境状态，管理受邀成员和运行开关。</p>
        </div>
        <span className="version">{user.role === 'ADMIN' ? '管理员视图' : '只读视图'}</span>
      </div>
      <div className="settings-grid">
        <section className="panel form-panel">
          <h2>工作空间</h2>
          <p>
            <strong>{product.name}</strong> · {product.tagline}
          </p>
          <dl className="settings-details">
            <dt>空间名称</dt>
            <dd>{project.name}</dd>
            <dt>环境性质</dt>
            <dd>{project.sample ? '独立测试样例' : '业务测试环境'}</dd>
            <dt>规划模型</dt>
            <dd>
              {meta.model.name} · {meta.model.configured ? '已配置' : '未配置'}
            </dd>
            <dt>视觉模型</dt>
            <dd>{meta.vision.configured ? meta.vision.name : '未配置 · 不会自动伪装为视觉执行'}</dd>
            <dt>执行引擎</dt>
            <dd>{meta.workers} 个在线 Worker</dd>
          </dl>
          <h3>可用环境</h3>
          {project.environments.map((e) => (
            <div className="environment-row" key={e.id}>
              <Globe size={18} />
              <div>
                <strong>{e.name}</strong>
                <code>{e.baseUrl}</code>
              </div>
              <span className="badge status-pass">已启用</span>
            </div>
          ))}
        </section>
        <section className="panel form-panel">
          <h2>运行状态</h2>
          {health ? (
            <div className="health-grid">
              {[
                ['database', '数据库'],
                ['redis', '任务队列'],
                ['sample', '样例业务'],
              ].map(([id, label]) => (
                <div key={id}>
                  <span className={'dot ' + (health[id] ? 'online' : 'offline')} />
                  <strong>{label}</strong>
                  <small>{health[id] ? '已连接' : '不可用'}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">详细健康检查由管理员查看。</p>
          )}
          <div className="execution-switch">
            <div>
              <strong>{meta.executionEnabled ? '任务执行已开放' : '任务执行已暂停'}</strong>
              <p>暂停会拒绝新执行，并在下一工具调用前阻止在途任务继续操作；资源清理仍会进行。</p>
            </div>
            {user.role === 'ADMIN' && (
              <button
                className={'button ' + (meta.executionEnabled ? 'danger' : 'primary')}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await post('/admin/execution', { enabled: !meta.executionEnabled });
                    await refresh();
                    notify('执行开关已更新');
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {meta.executionEnabled ? '暂停执行' : '恢复执行'}
              </button>
            )}
          </div>
          <div className="notice">
            模型价格在下方设置，网关和凭证仍由服务端配置。费用按模型用量和价格快照估算，执行同时受
            Token、调用次数与时长预算约束。
          </div>
        </section>
      </div>
      <PricingSettings user={user} notify={notify} />
      {user.role === 'ADMIN' && (
        <div className="settings-grid">
          <section className="panel form-panel">
            <h2>添加受邀测试人员</h2>
            <p>创建当前项目的账号，由管理员通过既有渠道提供给用户。</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await post('/admin/users', { email, name, password, projectId: project.id });
                  setEmail('');
                  setName('');
                  setPassword('');
                  notify('受邀账号已创建，未向外部发送消息');
                  load();
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label htmlFor="invite-name">姓名</label>
              <input
                id="invite-name"
                minLength={2}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <label htmlFor="invite-email">邮箱</label>
              <input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label htmlFor="invite-password">初始密码（至少 12 位）</label>
              <input
                id="invite-password"
                type="password"
                minLength={12}
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="button primary" disabled={busy}>
                <Plus size={16} />
                创建受邀账号
              </button>
            </form>
          </section>
          <section className="panel form-panel">
            <h2>近期管理记录</h2>
            <div className="audit-list">
              {audit.slice(0, 15).map((a) => (
                <div key={a.id}>
                  <Activity size={14} />
                  <div>
                    <strong>{a.action}</strong>
                    <small>
                      {a.targetId.slice(0, 18)} · {date(a.createdAt)}
                    </small>
                  </div>
                </div>
              ))}
              {!audit.length && <p className="muted">暂无记录</p>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
