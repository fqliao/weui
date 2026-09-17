'use client';
import type { WebCaseInput } from '../../../packages/contracts/src/browser';
import type { CacheStatus } from '../../../packages/contracts/src/execution-cache';
import { caseCapabilities } from '../../../packages/contracts/src/static-capability';
export function CaseCapabilities({ content, status }: { content: WebCaseInput; status?: CacheStatus }) {
  const items = caseCapabilities(content);
  const ready = items.filter(
    (c) =>
      c.level === 'static' ||
      status?.operations?.find((o) => o.phase === 'case' && o.index === c.index)?.complete,
  ).length;
  return (
    <details className="case-capabilities">
      <summary>
        执行能力 · {ready}/{items.length} 项具备静态条件 · 查看需要 AI 的步骤
      </summary>
      {content.sessionId && <p className="muted">登录准备也会自动沉淀静态条件；下方列出当前缓存覆盖。</p>}
      {content.sessionId && status?.operations?.some((o) => o.phase === 'authentication') && (
        <ul>
          {status.operations
            .filter((o) => o.phase === 'authentication')
            .map((o) => (
              <li key={o.index}>
                <span>登录 · {o.label ?? `${o.kind} ${o.index + 1}`}</span>
                <small className={`execution-capability ${o.complete ? 'static' : 'ai'}`} title={o.reason}>
                  {o.complete ? '已有二级静态记录' : (o.reason ?? '尚需 AI 验证或定位')}
                </small>
              </li>
            ))}
        </ul>
      )}
      {content.cachePolicy === 'realtime' && (
        <p className="notice warning">此用例设置为始终实时推理，以下静态能力本次不会启用。</p>
      )}
      <ol>
        {items.map((c) => {
          const saved = status?.operations?.find((o) => o.phase === 'case' && o.index === c.index);
          return (
            <li key={c.index}>
              <span>{c.title}</span>
              <small
                className={`execution-capability ${saved?.complete ? 'static' : c.level}`}
                title={saved?.reason ?? c.reason}
              >
                {saved?.complete ? '已有二级记录，运行时重新校验' : c.label}
              </small>
              {!saved?.complete && saved?.reason && <small className="muted">{saved.reason}</small>}
            </li>
          );
        })}
      </ol>
      <p className="muted">
        具备条件不保证命中。控件或页面变化时按二级 → 一级 → 实时推理处理；真实验证失败不会放宽预期。
      </p>
    </details>
  );
}
