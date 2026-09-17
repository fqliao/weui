'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  Plus,
  BookOpen,
  Layers,
  Wrench,
  Settings,
  LogOut,
  ArrowUpRight,
  ChevronRight,
  FlaskConical,
  Command,
  Check,
  Loader2,
  Globe,
  KeyRound,
  Compass,
  MessageSquare,
  House,
  Zap,
  Monitor,
  FileCheck2,
} from 'lucide-react';
import { api, post, go, type User, type Project, type Meta, ApiError } from './api';
import { TaskDetail, RunDetail, NewTask } from './tasks';
import { KnowledgeView, SkillsView, ToolsView, SettingsView } from './resources';
import { WebsitesView } from './websites';
import { DiscoveryView } from './discovery';
import { CaseRunner } from './case-runner';
import { FeedbackList } from './feedback';
import { product } from './product';
import { TestRecords } from './test-records';
import { Home } from './home';
type Notice = { message: string; error: boolean };
export default function Workbench() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(''),
    [meta, setMeta] = useState<Meta | null>(null),
    [route, setRoute] = useState('home'),
    [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback((message: string, error = false) => {
    setNotice({ message, error });
    window.setTimeout(() => setNotice(null), 7000);
  }, []);
  async function refresh() {
    try {
      const [p, m] = await Promise.all([api<Project[]>('/projects'), api<Meta>('/meta')]);
      setProjects(p);
      setProjectId((old) => (old && p.some((v) => v.id === old) ? old : p[0]?.id || ''));
      setMeta(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else notify((e as Error).message, true);
    }
  }
  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setLoading(false));
    const read = () => setRoute(window.location.hash.replace(/^#\//, '') || 'home');
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [user]);
  const project = projects.find((p) => p.id === projectId),
    [section, id] = route.split('?')[0].split('/');
  const query = route.includes('?') ? route.slice(route.indexOf('?') + 1) : '';
  if (loading)
    return (
      <div className="boot">
        <div className="brand-mark">
          <Layers />
        </div>
        <p>正在打开工作空间</p>
        <Loader2 className="spin" size={20} />
      </div>
    );
  if (!user) return <Login onLogin={setUser} />;
  const nav = [
    { id: 'home', label: '首页', icon: House },
    { id: 'discoveries', label: '探索用例', icon: Compass },
    { id: 'cases', label: '用例库', icon: FlaskConical },
    { id: 'tasks', label: '测试记录', icon: Activity },
    { id: 'feedback', label: '反馈记录', icon: MessageSquare },
    { id: 'websites', label: '网站管理', icon: Globe },
    { id: 'sessions', label: '登录会话', icon: KeyRound },
    { id: 'knowledge', label: '领域知识', icon: BookOpen },
    { id: 'skills', label: '技能库', icon: Layers },
    { id: 'tools', label: '工具中心', icon: Wrench },
    { id: 'settings', label: '空间设置', icon: Settings },
  ];
  const active =
    section === 'new' ? 'cases' : ['runs', 'plan', 'sample'].includes(section) ? 'tasks' : section;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/home" aria-label={product.name}>
          <span className="brand-mark">
            <Layers size={23} />
          </span>
          <span>
            {product.shortName}
            <small>智能 UI 测试平台</small>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="project-initial">QA</span>
          <div>
            <small>当前工作空间</small>
            <select
              aria-label="工作空间"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                go('home');
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button className="button primary new-button" onClick={() => go('cases')}>
          <Plus size={18} />
          选择用例测试<span>↗</span>
        </button>
        <div className="nav-label">工作空间</div>
        <nav>
          {nav.map((n, i) => (
            <div key={n.id}>
              {i === 5 && <div className="nav-label">配置与扩展</div>}
              <button
                key={n.id}
                className={'nav-item ' + (active === n.id ? 'active' : '')}
                onClick={() => go(n.id)}
              >
                <n.icon size={19} />
                {n.label}
                {active === n.id && <i />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine">
            <span className={'dot ' + (meta?.workers ? 'online' : 'offline')} />
            <div>
              <strong>{meta?.workers ? '执行引擎在线' : '等待执行引擎'}</strong>
              <small>{meta?.workers || 0} 个 Worker · 独立浏览器</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">工作空间</span>
            <ChevronRight size={14} />
            <strong>
              {section === 'new'
                ? '用例库'
                : section === 'runs'
                  ? '运行报告'
                  : nav.find((n) => n.id === section)?.label || '测试任务'}
            </strong>
          </div>
          <div className="topbar-meta">
            <span className="version">MVP · v0.2 · Midscene</span>
            {project?.sample && (
              <span className="sample-label">
                <FlaskConical size={13} />
                空间包含审批样例
              </span>
            )}
            <div className="user topbar-user" role="group" aria-label="当前用户">
              <span className="avatar" aria-hidden="true">
                {user.name.slice(0, 1)}
              </span>
              <div className="user-details">
                <strong title={user.name}>{user.name}</strong>
                <small>{user.role === 'ADMIN' ? '空间管理员' : '测试人员'}</small>
              </div>
              <button
                className="icon-button"
                title="退出登录"
                aria-label="退出登录"
                onClick={async () => {
                  await post('/auth/logout');
                  setUser(null);
                }}
              >
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </header>
        <main className="main-content">
          {!meta || !project ? (
            <div className="empty">
              <Loader2 className="spin" />
              正在加载工作空间…
            </div>
          ) : (
            <>
              {!meta.executionEnabled && (
                <div className="notice warning">管理员已暂停执行。您仍可阅读报告、维护草稿与创建计划。</div>
              )}
              {section === 'home' && <Home key={project.id} project={project} />}
              {section === 'tasks' && !id && (
                <TestRecords
                  key={project.id}
                  project={project}
                  notify={notify}
                  requestedSiteId={new URLSearchParams(query).get('website') || ''}
                />
              )}
              {section === 'plan' && <NewTask project={project} meta={meta} notify={notify} />}
              {section === 'sample' && (
                <CaseRunner
                  key={`${project.id}:${query}`}
                  query={query}
                  project={{
                    ...project,
                    environments: project.environments.filter((e) => e.adapter === 'sample-approval-v1'),
                  }}
                  meta={meta}
                  notify={notify}
                />
              )}
              {['websites', 'sessions', 'cases', 'new'].includes(section) && (
                <WebsitesView
                  key={project.id}
                  project={project}
                  requestedSiteId={new URLSearchParams(query).get('website') || ''}
                  section={section === 'new' ? 'cases' : section}
                  selectedCaseIds={new URLSearchParams(query).get('cases') || ''}
                  meta={meta}
                  notify={notify}
                  refresh={refresh}
                />
              )}
              {section === 'tasks' && id && <TaskDetail key={id} id={id} meta={meta} notify={notify} />}
              {section === 'runs' && id && <RunDetail key={id} id={id} notify={notify} />}
              {section === 'knowledge' && (
                <KnowledgeView key={project.id} project={project} notify={notify} />
              )}
              {section === 'discoveries' && (
                <DiscoveryView
                  key={project.id}
                  project={project}
                  meta={meta}
                  id={id}
                  notify={notify}
                  refresh={refresh}
                />
              )}
              {section === 'skills' && (
                <SkillsView key={project.id} project={project} meta={meta} user={user} notify={notify} />
              )}
              {section === 'tools' && <ToolsView key={project.id} project={project} notify={notify} />}
              {section === 'feedback' && <FeedbackList key={project.id} projectId={project.id} />}
              {section === 'settings' && (
                <SettingsView project={project} meta={meta} user={user} notify={notify} refresh={refresh} />
              )}
            </>
          )}
        </main>
        <footer className="footer">
          <span>
            {product.name} · {product.tagline}
          </span>
          <span>真实浏览器执行 · 过程与结果可追溯</span>
        </footer>
      </div>
      {notice && (
        <div role="alert" className={'toast ' + (notice.error ? 'error' : '')}>
          <Check size={18} />
          {notice.message}
          <button aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('admin@uiagent.local'),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="login-layout">
      <div className="login-story">
        <div className="brand light">
          <span className="brand-mark">
            <Layers />
          </span>
          <span>{product.name}</span>
        </div>
        <div>
          <div className="eyebrow">面向测试团队的网站功能验证</div>
          <h1>
            从网站探索，
            <br />
            到用例回归。
          </h1>
          <p>{product.description}</p>
          <ul className="login-highlights">
            <li>
              <FileCheck2 size={18} />
              <span>
                <strong>探索生成草稿，人工确认预期</strong>
                <small>让测试用例可编辑、可校准、可复用。</small>
              </span>
            </li>
            <li>
              <Zap size={18} />
              <span>
                <strong>分层缓存，让回归减少重复推理</strong>
                <small>静态回放、规划与定位复用、实时推理按需切换。</small>
              </span>
            </li>
            <li>
              <Monitor size={18} />
              <span>
                <strong>过程可见，验证有据</strong>
                <small>保留执行画面、断言结果与模型消耗。</small>
              </span>
            </li>
          </ul>
        </div>
        <small>统一管理网站、登录身份、测试用例与运行证据，复用领域知识和测试方法。</small>
      </div>
      <div className="login-form">
        <div className="eyebrow">测试工作空间</div>
        <h2>登录平台</h2>
        <p>登录受邀账号，打开您的测试工作空间。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const r = await post<{ user: User }>('/auth/login', { email, password });
              onLogin(r.user);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="email">工作邮箱</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? <Loader2 size={18} className="spin" /> : <ArrowUpRight size={18} />}进入工作空间
          </button>
        </form>
        <div className="login-help">
          <Command size={16} />
          请使用管理员分配的账号登录。需要访问权限或重置密码，请联系管理员。
        </div>
      </div>
    </div>
  );
}
export type Notify = (message: string, error?: boolean) => void;
