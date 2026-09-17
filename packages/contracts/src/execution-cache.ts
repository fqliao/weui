import { z } from 'zod';
export const executionModeSchema = z.enum(['realtime', 'l1', 'l2']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type CacheStatus = {
  operations?: {
    phase: string;
    index: number;
    kind: string;
    complete: boolean;
    label?: string;
    reason?: string;
    learned?: boolean;
  }[];
  id?: string;
  generation?: number;
  l2Ready?: number;
  operationCount?: number;
  changedAt?: string;
  changeCount?: number;
  edited?: boolean;
  l1: boolean;
  l2: boolean;
  partial: boolean;
  reason?: string;
  sourceRunId?: string;
  updatedAt?: string;
};
export type ExecutionStats = {
  aiReasons?: { phase: string; operation: number; label: string; reason: string; learned: boolean }[];
  l2Direct?: number;
  validationVersion?: 'semantic-v1';
  l2Replayed?: number;
  changes?: CacheChange[];
  generation?: number;
  l2Hits: number;
  l1Hits: number;
  aiOperations: number;
  fallbacks: number;
  published: boolean;
  key: string;
  sourceRunId?: string;
  mode: ExecutionMode;
  bypassReason?: string;
};
export type CacheChange = { tier: 'L1' | 'L2'; path: string; before: string; after: string };
export type CacheField = { path: string; label: string; value: string; multiline?: boolean };
export type CacheOperationView = {
  phase: string;
  index: number;
  key: string;
  kind: string;
  label: string;
  complete: boolean;
  content: string;
  fields: CacheField[];
};
export type CacheRevision = {
  id: string;
  at: string;
  generation: number;
  source: 'manual' | 'run';
  runId?: string;
  actor: string;
  changes: CacheChange[];
};
export type CacheDetail = {
  id: string;
  caseId: string;
  title: string;
  browser: string;
  generation: number;
  caseRevision: number;
  sourceRunId: string;
  updatedAt: string;
  expiresAt: string;
  edited: boolean;
  l1: CacheOperationView[];
  l2: CacheOperationView[];
  revisions: CacheRevision[];
};
export const executionModeLabels: Record<ExecutionMode, string> = {
  realtime: '实时推理',
  l1: '一级缓存优先',
  l2: '二级缓存优先',
};
