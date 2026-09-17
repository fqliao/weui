import 'dotenv/config';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const env = z
  .object({
    DATABASE_URL: z.string().default('postgresql://uiagent:uiagent@127.0.0.1:55432/uiagent'),
    REDIS_URL: z.string().default('redis://127.0.0.1:56379'),
    API_PORT: z.coerce.number().default(3101),
    WEB_PORT: z.coerce.number().default(3100),
    SAMPLE_PORT: z.coerce.number().default(3102),
    API_ORIGIN: z.string().default('http://127.0.0.1:3101'),
    WEB_ORIGIN: z.string().default('http://localhost:3100'),
    SAMPLE_ORIGIN: z.string().default('http://127.0.0.1:3102'),
    SESSION_SECRET: z.string().min(32),
    SAMPLE_SERVICE_KEY: z.string().min(24),
    AGENT_MODE: z.enum(['catalog', 'deepagents']).default('catalog'),
    LLM_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    LLM_MODEL: z.string().default('deepseek-chat'),
    LLM_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0),
    LLM_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0),
    LLM_MAX_TOKENS: z.coerce.number().positive().default(4096),
    MODEL_TIMEOUT_MS: z.coerce.number().default(90000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    RUN_TIMEOUT_MS: z.coerce.number().default(600000),
    RUN_MAX_ACTIONS: z.coerce.number().default(40),
    RUN_MAX_MODEL_CALLS: z.coerce.number().default(6),
    RUN_MAX_TOKENS: z.coerce.number().default(20000),
    RUN_MAX_COST_USD: z.coerce.number().default(1),
    RUN_MAX_COST_CNY: z.coerce.number().positive().default(10),
    EVIDENCE_DIR: z.string().default('.runtime/evidence'),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    ALLOW_SAMPLE_ENVIRONMENT: z.enum(['true', 'false']).default('true'),
    EXECUTION_ENABLED: z.enum(['true', 'false']).default('true'),
  })
  .parse(process.env);
export const config = {
  ...env,
  root: process.cwd(),
  evidenceDir: path.resolve(env.EVIDENCE_DIR),
  llmKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  visionKey:
    process.env.MIDSCENE_MODEL_API_KEY ||
    (process.env.MIDSCENE_MODEL_BASE_URL === 'https://api.deepseek.com'
      ? process.env.DEEPSEEK_API_KEY
      : '') ||
    '',
  visionReady: Boolean(
    process.env.MIDSCENE_MODEL_NAME &&
      process.env.MIDSCENE_MODEL_FAMILY &&
      (process.env.MIDSCENE_MODEL_API_KEY ||
        (process.env.MIDSCENE_MODEL_BASE_URL === 'https://api.deepseek.com' && process.env.DEEPSEEK_API_KEY)),
  ),
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export function publicError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 1500);
}
export function redactText(text: string): string {
  let message = text;
  for (const value of [
    config.llmKey,
    config.SAMPLE_SERVICE_KEY,
    config.SESSION_SECRET,
    process.env.MIDSCENE_MODEL_API_KEY,
  ])
    if (value) message = message.replaceAll(value, '[REDACTED]');
  return message
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DATABASE_URL]');
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: {
      runId: string;
      caseId: string;
      caseTitle: string;
      executionMessage?: string;
      reviewable?: boolean;
    },
  ) {
    super(message);
  }
}
