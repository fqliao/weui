'use client';
import { useEffect, useRef, useState } from 'react';
import { api, post } from './api';

type ReviewState = {
  retry: { allowed: boolean; reason: string };
  review: null | {
    fingerprint: string;
    pendingCases: { id: string; title: string }[];
    reviewedCaseIds: string[];
  };
  records: {
    id: string;
    createdAt: string;
    reviewerName: string;
    caseId: string;
    caseTitle?: string;
    note: string;
    resolution: string;
  }[];
};
export function OutcomeReview({
  runId,
  caseId,
  caseTitle,
  onClose,
  onSaved,
}: {
  runId: string;
  caseId: string;
  caseTitle: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(false);
  const [state, setState] = useState<ReviewState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [resolution, setResolution] = useState('NO_BUSINESS_CHANGE'),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    void api<ReviewState>(`/runs/${runId}/outcome-review`)
      .then(setState)
      .catch((e) => setError(e.message));
    return () => {
      dialog.current?.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [runId]);
  const pending = state?.review?.pendingCases.some((c) => c.id === caseId);
  const noteMissing = submitted && !note.trim();
  const confirmationMissing = submitted && !confirmed;
  return (
    <dialog
      ref={dialog}
      className="case-delete-dialog outcome-review-dialog"
      aria-labelledby="outcome-review-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="outcome-review-title">核对上次结果 · {caseTitle}</h2>
      <p>
        请查看上次运行和被测网站，确认这条用例留下的实际状态。记录核对结果后，可重新运行；原始失败结果、截图和操作记录仍保留。
      </p>
      <a href={`#/runs/${runId}`} className="button outline" onClick={onClose}>
        查看上次运行
      </a>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p role="status">正在读取运行记录…</p>}
      {state && !pending && (
        <p className="notice" role="status">
          {state.retry.reason}
        </p>
      )}
      {pending && (
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!state?.review || busy) return;
            setSubmitted(true);
            setError('');
            if (!note.trim()) {
              noteInput.current?.focus();
              return;
            }
            if (!confirmed) {
              confirmationInput.current?.focus();
              return;
            }
            setBusy(true);
            try {
              await post(`/runs/${runId}/outcome-review`, {
                caseId,
                fingerprint: state.review.fingerprint,
                resolution,
                note: note.trim(),
                confirmed,
              });
              onSaved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            核对结论
            <select
              aria-label="核对结论"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              disabled={busy}
            >
              <option value="NO_BUSINESS_CHANGE">未产生需要清理的业务数据</option>
              <option value="DATA_CLEANED">已核对并清理产生的业务数据</option>
            </select>
          </label>
          <label>
            核对说明
            <textarea
              ref={noteInput}
              aria-label="核对说明"
              aria-invalid={noteMissing || undefined}
              aria-describedby={noteMissing ? 'review-note-hint review-note-error' : 'review-note-hint'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder="记录核对了哪些页面或数据，以及实际结果。请勿填写账号密码。"
              maxLength={1000}
              required
            />
            <small id="review-note-hint" className="muted">
              必填，简要记录核对结果即可，最多 1000 字。
            </small>
            {noteMissing && (
              <small id="review-note-error" className="text-danger" role="alert">
                请填写核对说明。
              </small>
            )}
          </label>
          <label className="inline-check">
            <input
              ref={confirmationInput}
              type="checkbox"
              aria-invalid={confirmationMissing || undefined}
              aria-describedby={confirmationMissing ? 'review-confirmation-error' : undefined}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={busy}
            />
            我已核对被测网站，确认此用例可以重新测试
          </label>
          {confirmationMissing && (
            <small id="review-confirmation-error" className="text-danger" role="alert">
              请勾选确认已核对被测网站。
            </small>
          )}
          <div className="button-group">
            <button type="button" className="button outline" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? '正在保存…' : '保存核对结果'}
            </button>
          </div>
        </form>
      )}
      {!pending && (
        <button className="button outline" onClick={onClose}>
          关闭
        </button>
      )}
    </dialog>
  );
}

export function OutcomeReviewHistory({ runId, onUpdated }: { runId: string; onUpdated?: () => void }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    let active = true;
    void api<ReviewState>(`/runs/${runId}/outcome-review`)
      .then((r) => {
        if (active) setState(r);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [runId]);
  if (!state?.records.length && !state?.review?.pendingCases.length) return null;
  return (
    <section className="panel outcome-review-history">
      <h3>人工核对记录</h3>
      <p className="muted">核对用于恢复测试，原始测试结论保持不变。</p>
      {!!state.review?.pendingCases.length && (
        <div className="button-group">
          {state.review.pendingCases.map((c) => (
            <button key={c.id} className="button outline" onClick={() => setSelected(c)}>
              核对 · {c.title}
            </button>
          ))}
        </div>
      )}
      {state.records.map((r) => (
        <div key={r.id} className="outcome-review-record">
          <strong>
            {r.caseTitle ?? r.caseId} · {r.reviewerName} · {new Date(r.createdAt).toLocaleString('zh-CN')}
          </strong>
          <p>
            {r.resolution === 'NO_BUSINESS_CHANGE'
              ? '未产生需要清理的业务数据'
              : '已核对并清理产生的业务数据'}
            ：{r.note}
          </p>
        </div>
      ))}
      {selected && (
        <OutcomeReview
          runId={runId}
          caseId={selected.id}
          caseTitle={selected.title}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            void api<ReviewState>(`/runs/${runId}/outcome-review`).then(setState);
            onUpdated?.();
          }}
        />
      )}
    </section>
  );
}
