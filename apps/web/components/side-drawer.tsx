'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function SideDrawer({
  title,
  description = '校准步骤和预期，保存后用于新的测试。',
  notice,
  dirty,
  busy,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  notice?: { message: string; error?: boolean } | null;
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
  function close() {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="side-drawer"
      aria-labelledby="case-drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
        }
      }}
    >
      <header className="drawer-header">
        <div>
          <h2 id="case-drawer-title">{title}</h2>
          <p>{description}</p>
        </div>
        <button
          type="button"
          aria-label="关闭用例编辑"
          className="icon-button"
          disabled={busy}
          onClick={close}
        >
          <X size={21} />
        </button>
      </header>
      {notice && (
        <div className={'drawer-notice notice ' + (notice.error ? 'error' : '')} role="status">
          {notice.message}
        </div>
      )}
      {confirmDiscard && (
        <div className="discard-confirm" role="alert">
          <strong>有未保存的修改，是否放弃？</strong>
          <div className="button-group">
            <button className="button outline" onClick={() => setConfirmDiscard(false)}>
              继续编辑
            </button>
            <button className="button danger" onClick={onClose}>
              放弃修改并关闭
            </button>
          </div>
        </div>
      )}
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
