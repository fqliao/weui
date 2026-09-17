'use client';
import { useEffect, useRef, useState } from 'react';
import { api, post, ApiError } from './api';

export type DeletionTarget = { id: string; revision: number; title: string; featureName: string };

export function DeleteCasesDialog({
  siteId,
  siteName,
  cases,
  onClose,
  onDeleted,
  onRefresh,
}: {
  siteId: string;
  siteName: string;
  cases: DeletionTarget[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
  onRefresh: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const items = cases.map(({ id, revision }) => ({ id, revision }));
      const result =
        items.length === 1
          ? await api<{ deletedIds: string[] }>(`/web-cases/${items[0].id}`, {
              method: 'DELETE',
              body: JSON.stringify({ revision: items[0].revision }),
            })
          : await post<{ deletedIds: string[] }>(`/websites/${siteId}/cases/delete`, { cases: items });
      onDeleted(result.deletedIds);
    } catch (e) {
      setError((e as Error).message);
      setStale(e instanceof ApiError && [404, 409].includes(e.status));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="case-delete-dialog"
      aria-labelledby="delete-cases-title"
      aria-describedby="delete-cases-description"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="delete-cases-title">删除 {cases.length} 条用例？</h2>
      <p id="delete-cases-description">
        将从「{siteName}」的用例库移除以下用例。历史报告和已创建的测试任务仍保留。
      </p>
      <ul className="case-delete-list">
        {cases.map((c) => (
          <li key={c.id}>
            <strong>{c.title}</strong>
            <small>
              {c.featureName} · v{c.revision}
            </small>
          </li>
        ))}
      </ul>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="button-group">
        <button autoFocus className="button outline" disabled={busy} onClick={onClose}>
          取消
        </button>
        {stale ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRefresh();
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            刷新列表并重新选择
          </button>
        ) : (
          <button className="button danger" disabled={busy} onClick={remove}>
            {busy ? '正在删除…' : `确认删除 ${cases.length} 条`}
          </button>
        )}
      </div>
    </dialog>
  );
}
