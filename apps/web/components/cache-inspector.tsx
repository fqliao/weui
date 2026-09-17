'use client';
import { useEffect, useState } from 'react';
import { api, patch, date, go } from './api';
import { SideDrawer } from './side-drawer';
import type { CacheChange, CacheDetail } from '../../../packages/contracts/src/execution-cache';

export function CacheDiff({ changes }: { changes: CacheChange[] }) {
  return (
    <div className="cache-diff">
      {changes.map((c, i) => (
        <div key={`${c.tier}-${c.path}-${i}`}>
          <strong>
            {c.tier === 'L1' ? '一级' : '二级'} ·{' '}
            {c.path.replace(/operations\.(\d+)/, (_, n) => `操作 ${Number(n) + 1}`)}
          </strong>
          <div className="diff-before">
            <span>更新前</span>
            <code>{c.before}</code>
          </div>
          <div className="diff-after">
            <span>更新后</span>
            <code>{c.after}</code>
          </div>
        </div>
      ))}
    </div>
  );
}
export function CacheInspector({
  id,
  initialTier,
  onClose,
}: {
  id: string;
  initialTier: 'L1' | 'L2';
  onClose: () => void;
}) {
  const [data, setData] = useState<CacheDetail | null>(null),
    [tier, setTier] = useState(initialTier),
    [tab, setTab] = useState<'content' | 'changes'>('content');
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const dirty = Object.keys(edits).length > 0;
  const invalid = Object.fromEntries(
    Object.entries(edits).flatMap(([path, value]) => {
      if (!value.trim()) return [[path, '定位不能为空']];
      if (path.includes('.xpaths.')) {
        try {
          document.createExpression(value, null);
        } catch {
          return [[path, '请输入有效 XPath，CSS 定位请在二级缓存中修改']];
        }
      }
      if (path.endsWith('.selector') && !CSS.supports(`selector(${value})`))
        return [[path, '请输入有效的 CSS 选择器']];
      return [];
    }),
  );
  async function load() {
    setBusy(true);
    try {
      setData(await api<CacheDetail>(`/execution-caches/${id}`));
      setEdits({});
      setNotice(null);
    } catch (e) {
      setNotice({ message: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  async function save() {
    setBusy(true);
    try {
      const next = await patch<CacheDetail>(`/execution-caches/${id}`, {
        generation: data!.generation,
        tier,
        edits: Object.entries(edits).map(([path, value]) => ({ path, value })),
      });
      setData(next);
      setEdits({});
      setNotice({ message: '已保存。下次执行将按原用例预期重新验证，通过后更新基线。' });
      window.dispatchEvent(new Event('cache-updated'));
    } catch (e) {
      setNotice({ message: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const ops = data?.[tier === 'L1' ? 'l1' : 'l2'] ?? [];
  return (
    <SideDrawer
      title={`${tier === 'L1' ? '一级' : '二级'}缓存${data ? ` · ${data.title}` : ''}`}
      description="查看当前缓存版本、校准定位，并追踪每次更新。"
      notice={notice}
      dirty={dirty}
      busy={busy}
      onClose={onClose}
    >
      {!data ? (
        <button className="button outline" disabled={busy} onClick={load}>
          {busy ? '正在读取…' : '重新加载'}
        </button>
      ) : (
        <>
          <div className="cache-inspector-meta">
            <span>
              缓存版本 <b>g{data.generation}</b>
            </span>
            <span>
              用例 v{data.caseRevision} · {data.browser}
            </span>
            <span>更新：{date(data.updatedAt)}</span>
            <span>有效期至：{date(data.expiresAt)}</span>
            <button
              className="text-link"
              onClick={() => {
                onClose();
                go(`runs/${data.sourceRunId}`);
              }}
            >
              查看基线运行 →
            </button>
          </div>
          {data.edited && <p className="notice warning">定位已人工校准，等待下一次执行验证。</p>}
          {Date.parse(data.expiresAt) <= Date.now() && (
            <p className="notice warning">缓存已过期，可查看记录；重新运行用例后生成新缓存。</p>
          )}
          <div className="cache-tabs" role="tablist" aria-label="缓存详情">
            {(['L1', 'L2'] as const).map((t) => (
              <button
                role="tab"
                aria-selected={tab === 'content' && tier === t}
                disabled={busy || dirty}
                key={t}
                onClick={() => {
                  setTier(t);
                  setTab('content');
                }}
              >
                {t === 'L1' ? '一级 · 规划与定位' : '二级 · 静态操作'}
              </button>
            ))}
            <button
              role="tab"
              aria-selected={tab === 'changes'}
              disabled={dirty}
              onClick={() => setTab('changes')}
            >
              更新记录
            </button>
          </div>
          {tab === 'content' ? (
            <>
              <p className="muted">
                {tier === 'L1'
                  ? '可编辑 XPath 和规划中的定位描述。Midscene 的匹配上下文保持固定。'
                  : '优先按标签、角色等语义定位。修改 CSS 后使用该定位并重新核对目标语义；输入来自本次参数，业务预期不随缓存更新。'}
              </p>
              <div className="cache-operation-list">
                {ops.map((op) => {
                  const changed = data.revisions[0]?.changes.some(
                    (c) => c.tier === tier && c.path.startsWith(`${op.phase}.operations.${op.index}.`),
                  );
                  return (
                    <section key={`${op.phase}-${op.key}`} className="cache-operation">
                      <header>
                        <strong>
                          {op.phase === 'authentication' ? '登录准备' : '用例'} · {op.index + 1}. {op.label}
                        </strong>
                        {changed && <span className="cache-update-mark">最近有更新</span>}
                      </header>
                      {tier === 'L2' && (
                        <p className="muted">
                          {op.complete
                            ? '已有执行记录，运行时仍会重新校验'
                            : '此操作需一级缓存 / 实时推理，或等待校准验证'}
                        </p>
                      )}
                      {op.fields.map((field) => (
                        <label
                          key={field.path}
                          className={field.path in edits ? 'cache-field modified' : 'cache-field'}
                        >
                          <span>
                            {field.label}
                            {data.revisions[0]?.changes.some(
                              (c) => c.tier === tier && c.path === field.path.replace('.native.', '.'),
                            ) && <small className="cache-update-mark">最近更新</small>}
                            {field.path in edits && <small> · 未保存修改</small>}
                          </span>
                          <textarea
                            aria-label={`${op.index + 1}. ${field.label}`}
                            rows={2}
                            maxLength={4000}
                            disabled={busy}
                            value={edits[field.path] ?? field.value}
                            onChange={(e) => {
                              const value = e.target.value;
                              setEdits((old) => {
                                const next = { ...old };
                                if (value === field.value) delete next[field.path];
                                else next[field.path] = value;
                                return next;
                              });
                            }}
                          />
                          {invalid[field.path] && (
                            <small role="alert" className="text-danger">
                              {invalid[field.path]}
                            </small>
                          )}
                        </label>
                      ))}
                      {!op.fields.length && (
                        <p className="muted">
                          {tier === 'L1'
                            ? '此操作没有可编辑的规划或 XPath；等待和断言通常需要实时验证。'
                            : '此操作没有静态定位指令。'}
                        </p>
                      )}
                      <details>
                        <summary>查看缓存内容{tier === 'L2' ? '与校验信息' : ''}</summary>
                        <pre className="cache-json">{op.content}</pre>
                      </details>
                    </section>
                  );
                })}
              </div>
              <div className="cache-save-bar">
                <span>{dirty ? `已修改 ${Object.keys(edits).length} 个字段` : '未修改'}</span>
                <button
                  className="button outline"
                  disabled={busy}
                  onClick={() => {
                    setEdits({});
                    void load();
                  }}
                >
                  重新加载
                </button>
                <button
                  className="button primary"
                  disabled={
                    !dirty ||
                    busy ||
                    Date.parse(data.expiresAt) <= Date.now() ||
                    Object.keys(invalid).length > 0
                  }
                  onClick={save}
                >
                  {busy ? '保存中…' : '保存缓存'}
                </button>
              </div>
            </>
          ) : (
            <div className="cache-revisions">
              <p className="muted">最近 20 次内容更新。仅续期且内容未变的运行不会新增差异记录。</p>
              {!data.revisions.length && <p>此缓存创建于更新追踪功能启用前，后续更新会记录具体差异。</p>}
              {data.revisions.map((r, i) => (
                <details key={r.id} open={i === 0}>
                  <summary>
                    g{r.generation} · {r.source === 'manual' ? '人工校准' : '运行更新'} · {date(r.at)} ·{' '}
                    {r.changes.length} 处
                  </summary>
                  <p className="muted">
                    {r.actor}
                    {r.runId && (
                      <>
                        {' '}
                        · <a href={`#/runs/${r.runId}`}>查看运行</a>
                      </>
                    )}
                  </p>
                  <CacheDiff changes={r.changes} />
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </SideDrawer>
  );
}
