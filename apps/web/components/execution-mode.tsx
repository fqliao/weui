'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { executionModeLabels, type ExecutionMode } from '../../../packages/contracts/src/execution-cache';
import type { CacheStatus } from '../../../packages/contracts/src/execution-cache';
import { CacheInspector } from './cache-inspector';
export function ExecutionModeSelect({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: ExecutionMode;
  onChange: (value: ExecutionMode) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id}>执行方式</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ExecutionMode)}
      >
        <option value="l2">二级缓存优先（自动回退）</option>
        <option value="l1">一级缓存优先</option>
        <option value="realtime">实时推理（重建缓存）</option>
      </select>
    </div>
  );
}
export function useCacheStatuses(site: string, browser: string, revisionKey = '') {
  const [statuses, setStatuses] = useState<Record<string, CacheStatus>>({});
  useEffect(() => {
    let alive = true;
    setStatuses({});
    const read = () =>
      api<Record<string, CacheStatus>>(`/websites/${site}/cache-status?browserName=${browser}`)
        .then((v) => {
          if (alive) setStatuses(v);
        })
        .catch(() => {});
    if (site) void read();
    const focus = () => {
      if (site) void read();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('cache-updated', focus);
    return () => {
      alive = false;
      window.removeEventListener('focus', focus);
      window.removeEventListener('cache-updated', focus);
    };
  }, [site, browser, revisionKey]);
  return statuses;
}
export function CacheBadges({ status, realtime }: { status?: CacheStatus; realtime?: boolean }) {
  const [inspecting, setInspecting] = useState<'L1' | 'L2' | null>(null);
  if (realtime || status?.reason === '始终实时推理')
    return (
      <small className="cache-badges">
        <span>始终实时推理 · 不使用缓存</span>
      </small>
    );
  if (!status) return <small className="cache-badges">正在读取缓存状态…</small>;
  return (
    <>
      <small
        className="cache-badges"
        title={status.reason ?? '缓存按当前用例版本和所选浏览器显示，运行时还会校验页面及浏览器版本'}
      >
        <button
          type="button"
          disabled={!status.id}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setInspecting('L1');
          }}
          className={status.l1 ? 'cache-ready' : ''}
          title="查看和编辑一级缓存"
        >
          一级{status.l1 ? '已缓存' : '未缓存'}
        </button>
        <button
          type="button"
          disabled={!status.id}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setInspecting('L2');
          }}
          className={status.l2 ? 'cache-ready' : ''}
          title={`查看和编辑二级缓存 · ${status.l2Ready ?? 0}/${status.operationCount ?? 0} 个操作可静态执行，其余逐级回退`}
        >
          二级{status.l2 ? (status.partial ? '部分缓存' : '已缓存') : '未缓存'}
        </button>
        {status.edited ? (
          <span className="cache-update-mark">已校准 · 待验证</span>
        ) : status.changeCount ? (
          <span
            title={`更新于 ${status.changedAt ? new Date(status.changedAt).toLocaleString('zh-CN') : ''}`}
            className="cache-update-mark"
          >
            g{status.generation} · 更新 {status.changeCount} 处
          </span>
        ) : null}
      </small>
      {inspecting && status.id && (
        <CacheInspector id={status.id} initialTier={inspecting} onClose={() => setInspecting(null)} />
      )}
    </>
  );
}
export { executionModeLabels };
