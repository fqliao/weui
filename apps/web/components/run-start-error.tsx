'use client';
import { ApiError } from './api';
import { useEffect, useRef, useState } from 'react';
import { OutcomeReview } from './outcome-review';
export function RunStartError({
  error,
  onClose,
  onEdit,
  onExclude,
}: {
  error: Error;
  onClose: () => void;
  onEdit?: () => void;
  onExclude?: () => void;
}) {
  const details = error instanceof ApiError ? error.details : undefined;
  const notice = useRef<HTMLDivElement>(null);
  const [reviewing, setReviewing] = useState(false),
    [resolved, setResolved] = useState(false);
  useEffect(() => {
    setResolved(false);
    setReviewing(false);
    notice.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);
  return (
    <div ref={notice} className="run-start-error" role="alert">
      <div className="case-toolbar">
        <strong>本次测试尚未开始</strong>
        <button className="icon-button" aria-label="关闭执行提示" onClick={onClose}>
          ×
        </button>
      </div>
      <p>{resolved ? '核对结果已保存。请确认用例步骤已修正，然后点击“运行所选”重新测试。' : error.message}</p>
      {!resolved && details?.executionMessage && (
        <details>
          <summary>上次执行的具体原因</summary>
          <p>{details.executionMessage}</p>
        </details>
      )}
      <div className="button-group">
        {!resolved && details?.reviewable && (
          <button className="button primary" onClick={() => setReviewing(true)}>
            核对上次结果
          </button>
        )}
        {!resolved && onExclude && (
          <button className="button outline" onClick={onExclude}>
            取消选择此用例
          </button>
        )}
        {details?.runId && (
          <a className="button outline" href={`#/runs/${details.runId}`}>
            查看上次运行
          </a>
        )}
        {onEdit && (
          <button className="button outline" onClick={onEdit}>
            编辑此用例
          </button>
        )}
      </div>
      {reviewing && details && (
        <OutcomeReview
          runId={details.runId}
          caseId={details.caseId}
          caseTitle={details.caseTitle}
          onClose={() => setReviewing(false)}
          onSaved={() => {
            setReviewing(false);
            setResolved(true);
          }}
        />
      )}
    </div>
  );
}
