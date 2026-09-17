import { z } from 'zod';
import type { BrowserCase } from './browser.ts';
import { browserNameSchema, type BrowserName } from './browser-choice.ts';
import { executionModeSchema } from './execution-cache.ts';
export const resultStatus = z.enum(['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'SKIPPED']);
export type ResultStatus = z.infer<typeof resultStatus>;
export const terminalStatuses = new Set(['COMPLETED', 'ERROR', 'CANCELLED']);
export const budgetSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(600000).default(600000),
  maxActions: z.number().int().min(1).max(500).default(100),
  maxModelCalls: z.number().int().min(1).max(150).default(60),
  maxTokens: z.number().int().min(1000).max(500000).default(150000),
  maxCostUsd: z.number().positive().max(10).default(1),
  maxCostCny: z.number().positive().max(100).optional(),
});
export const taskSchema = z.object({
  executionMode: executionModeSchema.optional(),
  browserName: browserNameSchema.optional(),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  goal: z.string().trim().min(4).max(4000),
  title: z.string().trim().min(2).max(120).optional(),
  mode: z.enum(['catalog', 'deepagents']).default('catalog'),
  knowledgeReleaseId: z.string().min(1).optional(),
  caseIds: z.array(z.string()).min(1).max(12).optional(),
  skillReleaseId: z.string().optional(),
  budget: budgetSchema.default({
    timeoutMs: 600000,
    maxActions: 40,
    maxModelCalls: 60,
    maxTokens: 150000,
    maxCostUsd: 1,
    maxCostCny: 10,
  }),
});
export const skillDraftSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(4).max(300),
  instructions: z.string().trim().min(20).max(8000),
  toolIds: z.array(z.string()).min(1).max(10),
  ruleIds: z.array(z.string()).min(1).max(20),
  caseIds: z.array(z.string()).min(1).max(12),
  inputSchema: z.object({ goal: z.literal('string') }),
  outputSchema: z.object({ cases: z.literal('CaseResult[]') }),
});
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export const planSelectionSchema = z.object({
  summary: z.string().min(1).max(1500),
  cases: z
    .array(z.object({ caseId: z.string(), reason: z.string().min(1).max(500) }))
    .min(1)
    .max(12),
  missingRequirements: z.array(z.string().max(300)).max(10).default([]),
});
export type PlanSelection = z.infer<typeof planSelectionSchema>;
export type CaseSpec = {
  browser?: BrowserCase;
  id: string;
  title: string;
  category: string;
  ruleIds: string[];
  steps: string[];
  assertionIds: string[];
  expected: string;
};
export type Plan = {
  environmentRevision?: number;
  summary: string;
  cases: (CaseSpec & { reason: string })[];
  missingRequirements: string[];
  mode: 'catalog' | 'deepagents';
  vision: boolean;
};
export type Usage = {
  charges?: import('./pricing.ts').ModelCharge[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costCny?: number;
  priced: boolean;
  actions: number;
  visionCalls: number;
};
export const emptyUsage = (): Usage => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  costCny: 0,
  priced: false,
  actions: 0,
  visionCalls: 0,
});
export type AssertionResult = {
  id: string;
  ruleId: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
};
export type CaseResult = {
  metrics?: import('./case-metrics.ts').CaseMetrics;
  caseId: string;
  title: string;
  result: ResultStatus;
  cause: string | null;
  message: string;
  assertions: AssertionResult[];
  evidenceIds: string[];
  startedAt: string;
  finishedAt: string;
  attempt: number;
  businessWriteAttempts?: number;
  execution?: import('./execution-cache.ts').ExecutionStats;
};
export type RunManifest = {
  executionMode?: import('./execution-cache.ts').ExecutionMode;
  browser?: { name: BrowserName; engine: 'playwright' };
  discovery?: import('./discovery.ts').DiscoverySnapshot;
  version: '1';
  projectId: string;
  environmentId: string;
  environment: { baseUrl: string; adapter: string; credentialRef: string; config: Record<string, unknown> };
  plan: Plan;
  planHash: string;
  revision: number;
  knowledgeReleaseId: string;
  knowledgeHash: string;
  skillReleaseId: string | null;
  skillHash: string | null;
  skillContent: SkillDraft | null;
  toolVersions: Record<string, string>;
  assertionsVersion: string;
  codeVersion: string;
  model: string;
  models?: { planner: import('./pricing.ts').ModelTarget; vision: import('./pricing.ts').ModelTarget };
  pricing?: import('./pricing.ts').PriceBook;
  promptVersion: string;
  budget: z.infer<typeof budgetSchema>;
  sample: boolean;
  debug: boolean;
};
export function summarize(results: CaseResult[]) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0, SKIPPED: 0 };
  for (const row of results) counts[row.result]++;
  return counts;
}
