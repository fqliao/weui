import { z } from 'zod';
import { commandSchema, fingerprintSchema } from './static-replay.ts';
import { checkSchema } from './static-checks.ts';
export const CACHE_VERSION = 'weui-execution-cache-3';
export const operationSchema = z.object({
  key: z.string(),
  kind: z.string(),
  label: z.string().optional(),
  commands: z.array(commandSchema).max(100),
  before: fingerprintSchema,
  after: fingerprintSchema,
  complete: z.boolean(),
  passed: z.boolean().optional(),
  check: checkSchema.optional(),
  learning: z
    .object({
      version: z.number(),
      status: z.enum(['learned', 'unsupported']),
      reason: z.string().max(1000),
      retryable: z.boolean().optional(),
      attempts: z.number().int().min(1).max(2).optional(),
    })
    .optional(),
});
export const nativeSchema = z.object({
  midsceneVersion: z.literal('1.12.6'),
  cacheId: z.string(),
  caches: z.array(z.unknown()).max(500),
});
export const channelSchema = z.object({
  operations: z.array(operationSchema).max(100),
  nativeByOperation: z.record(z.string(), nativeSchema).default({}),
});
export const artifactSchema = z.object({
  version: z.enum([CACHE_VERSION, 'weui-execution-cache-2']),
  channels: z.record(z.string(), channelSchema),
  edited: z.boolean().optional(),
});
export type CacheArtifact = z.infer<typeof artifactSchema>;
export type CachedOperation = z.infer<typeof operationSchema>;
export type ChannelData = z.infer<typeof channelSchema>;
