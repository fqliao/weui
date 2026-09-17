'use client';
import { useRef, useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { go, post, ApiError, type Run } from './api';
import type { Notify } from './workbench';
import type { BrowserName } from '../../../packages/contracts/src/browser-choice';
import type { ExecutionMode } from '../../../packages/contracts/src/execution-cache';
export function RunCasesButton({
  projectId,
  siteId,
  caseIds,
  browserName,
  executionMode = 'l2',
  notify,
  label = '立即测试',
  onError,
}: {
  projectId: string;
  siteId: string;
  caseIds: string[];
  browserName?: BrowserName;
  executionMode?: ExecutionMode;
  notify: Notify;
  label?: string;
  onError?: (error: Error) => void;
}) {
  const [busy, setBusy] = useState(false);
  const request = useRef({ selection: '', key: '' });
  return (
    <button
      className="button primary"
      disabled={busy || !caseIds.length || caseIds.length > 12}
      onClick={async () => {
        setBusy(true);
        const selection = JSON.stringify([projectId, siteId, caseIds, browserName, executionMode]);
        if (request.current.selection !== selection)
          request.current = { selection, key: crypto.randomUUID() };
        try {
          const run = await post<Run>('/case-runs', {
            projectId,
            environmentId: siteId,
            caseIds,
            browserName,
            executionMode,
            idempotencyKey: request.current.key,
          });
          go(`runs/${run.id}`);
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) request.current = { selection: '', key: '' };
          if (onError) onError(e as Error);
          else notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
      {busy ? '正在开始' : label}
    </button>
  );
}
