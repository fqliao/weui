import { z } from 'zod';
import { webCaseSchema } from './browser.ts';
export const discoveryInputSchema = z.object({
  phase: z.enum(['MAIN', 'BOUNDARY', 'DIVERGENT']).default('MAIN'),
  baselineDiscoveryId: z.string().nullable().default(null),
  baselineRunId: z.string().nullable().default(null),
  knowledgeReleaseId: z.string().nullable().default(null),
  environmentId: z.string().min(1),
  title: z.string().trim().min(2).max(120),
  requirements: z.string().trim().min(5).max(40000),
  startPath: z.string().trim().min(1).max(2000),
  sessionId: z.string().nullable().default(null),
  maxPages: z.number().int().min(1).max(8).default(4),
});
export const candidateSchema = z.object({
  featureName: z.string().trim().min(2).max(100),
  description: z.string().max(2000),
  basis: z.enum(['requirement', 'observed', 'hypothesis']),
  requirementRefs: z.array(z.number().int().positive()).max(20),
  knowledgeRuleRefs: z.array(z.string().max(200)).max(20).default([]),
  observationIds: z.array(z.string()).min(1).max(8),
  reviewQuestions: z.array(z.string().max(1000)).max(10),
  test: webCaseSchema,
});
export const discoveryOutputSchema = z.object({
  summary: z.string().min(1).max(3000),
  gaps: z.array(z.string().max(1000)).max(30),
  candidates: z.array(candidateSchema).max(12),
});
export type DiscoveryCandidate = z.infer<typeof candidateSchema>;
export type DiscoverySnapshot = {
  id: string;
  requirements: string;
  maxPages: number;
  phase?: 'MAIN' | 'BOUNDARY' | 'DIVERGENT';
  baseline?: { discoveryId: string; runId: string; cases: unknown[] };
  domainRules?: { id: string; title: string; text: string }[];
};
export type Observation = {
  id: string;
  url: string;
  title: string;
  description: string;
  controls: string[];
  evidenceIds: string[];
};
export function requirementLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: i + 1, text }));
}
