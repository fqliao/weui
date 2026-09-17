import { z } from 'zod';
import type { Page } from 'playwright';
import type { CaseSpec } from '../../contracts/src/index.ts';
import type { ToolGateway } from '../../tools/src/gateway.ts';
import { db, event, json } from '../../db/src/index.ts';
import { hash } from '../../config/src/index.ts';
import { encryptSecret, decryptSecret } from '../../websites/src/vault.ts';
import { uncacheablePageReason, type StaticCommand } from './static-replay.ts';
import type { MidsceneBrowserAgent } from './midscene-agent.ts';
import {
  CACHE_VERSION,
  artifactSchema,
  nativeSchema,
  channelSchema,
  type CachedOperation,
  type ChannelData,
} from './cache-artifact.ts';
import { cacheChanges } from './cache-review.ts';
import { toTemplate } from './static-target.ts';
export { CACHE_VERSION, artifactSchema } from './cache-artifact.ts';
export type { CachedOperation } from './cache-artifact.ts';
import type { ExecutionStats } from '../../contracts/src/execution-cache.ts';
import type { StaticCheck } from './static-checks.ts';
import type { CheckLearning, LearningEvidence } from './learned-check.ts';
export function cacheContext(g: Pick<ToolGateway, 'manifest'>, spec: CaseSpec) {
  const m = g.manifest;
  return {
    version: CACHE_VERSION,
    project: m.projectId,
    environment: m.environmentId,
    environmentConfig: m.environment,
    environmentRevision: m.plan.environmentRevision,
    caseId: spec.id,
    case: spec.browser,
    ruleIds: spec.ruleIds,
    skill: m.skillHash,
    browser: m.browser ?? { name: 'chrome', engine: 'playwright' },
    model: m.models?.vision ?? m.model,
  };
}
export function cacheKey(g: Pick<ToolGateway, 'manifest'>, spec: CaseSpec, browserVersion: string) {
  const m = g.manifest;
  return hash({
    ...cacheContext(g, spec),
    tools: m.toolVersions,
    assertions: m.assertionsVersion,
    prompt: m.promptVersion,
    code: m.codeVersion,
    browser: m.browser ?? { name: 'chrome', engine: 'playwright' },
    browserVersion,
    viewport: [1280, 800, 1, 'zh-CN'],
    model: m.models?.vision ?? m.model,
    sdk: 'midscene-1.12.6/playwright-1.63.0',
  });
}
export class CaseExecutionCache {
  readonly channels = new Map<string, CacheChannel>();
  readonly stats: ExecutionStats;
  // Reuse a compiled definition within this run, never a previous PASS result.
  readonly learnedChecks = new Map<string, StaticCheck>();
  readonly learningSkipped = new Map<string, CheckLearning>();
  bypassReason?: string;
  private constructor(
    readonly g: ToolGateway,
    readonly spec: CaseSpec,
    readonly key: string,
    private prior: z.infer<typeof artifactSchema>,
    private generation: number | null,
    sourceRunId?: string,
  ) {
    this.stats = {
      validationVersion: 'semantic-v1',
      l2Hits: 0,
      l1Hits: 0,
      aiOperations: 0,
      fallbacks: 0,
      aiReasons: [],
      published: false,
      key,
      sourceRunId,
      mode: g.manifest.executionMode ?? 'l2',
    };
    if (spec.browser?.cachePolicy === 'realtime') this.bypassReason = '此用例设置为始终实时推理';
  }
  static async open(g: ToolGateway, spec: CaseSpec, browserVersion: string) {
    const key = cacheKey(g, spec, browserVersion);
    let prior: z.infer<typeof artifactSchema> = { version: CACHE_VERSION, channels: {} },
      generation: number | null = null,
      sourceRunId: string | undefined;
    try {
      const row = await db.executionCache.findUnique({ where: { id: key } });
      generation = row?.generation ?? null;
      if (
        row &&
        row.projectId === g.manifest.projectId &&
        row.environmentId === g.manifest.environmentId &&
        row.caseId === spec.id &&
        row.expiresAt > new Date()
      ) {
        prior = artifactSchema.parse(decryptSecret(row.encryptedArtifact, `execution-cache:${key}`));
        sourceRunId = row.sourceRunId;
      }
    } catch {
      await event(g.runId, 'cache.unavailable', {
        caseId: spec.id,
        message: '缓存不可读取，本次使用实时执行',
      });
    }
    return new CaseExecutionCache(g, spec, key, prior, generation, sourceRunId);
  }
  channel(name: string, page: Page) {
    const channel = new CacheChannel(
      this,
      name,
      page,
      this.prior.channels[name] ?? { operations: [], nativeByOperation: {} },
    );
    this.channels.set(name, channel);
    return channel;
  }
  completedEvidence(): LearningEvidence[] {
    return [...this.channels].flatMap(([phase, channel]) =>
      channel.operations
        .filter((op) => op.passed !== false)
        .map((op) => ({
          phase,
          key: op.key,
          kind: op.kind,
          label:
            phase === 'authentication'
              ? `登录配置 · ${op.kind}`
              : toTemplate(op.label ?? op.kind, { runId: this.g.runId }),
        })),
    );
  }
  async publish() {
    if (this.bypassReason) return;
    const channels = Object.fromEntries([...this.channels].map(([name, c]) => [name, c.data()]));
    const artifact = artifactSchema.parse({ version: CACHE_VERSION, channels });
    const changes = cacheChanges(this.prior, artifact);
    const encryptedArtifact = encryptSecret(artifact, `execution-cache:${this.key}`);
    const data = {
      encryptedArtifact,
      sourceRunId: this.g.runId,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    };
    // Publish only while this worker still owns the run. Concurrent generations never overwrite one another.
    await this.g.active();
    const generation = (this.generation ?? 0) + 1;
    const published = await db.$transaction(async (tx) => {
      if (this.generation === null)
        await tx.executionCache.create({
          data: {
            id: this.key,
            projectId: this.g.manifest.projectId,
            environmentId: this.g.manifest.environmentId,
            caseId: this.spec.id,
            caseRevision: this.spec.browser!.revision,
            ...data,
          },
        });
      else {
        const result = await tx.executionCache.updateMany({
          where: { id: this.key, generation: this.generation },
          data: { ...data, generation: { increment: 1 } },
        });
        if (!result.count) return false;
      }
      if (changes.length)
        await tx.auditEvent.create({
          data: {
            actorId: this.g.owner,
            projectId: this.g.manifest.projectId,
            action: 'execution-cache.publish',
            targetId: this.key,
            detail: json({ generation, source: 'run', runId: this.g.runId, caseId: this.spec.id, changes }),
          },
        });
      return true;
    });
    if (!published) {
      await event(this.g.runId, 'cache.publish.conflict', {
        caseId: this.spec.id,
        message: '缓存已被其他运行或人工修改，本次未覆盖新版本',
      });
      return;
    }
    this.stats.published = true;
    this.stats.changes = changes;
    this.stats.generation = generation;
    await event(this.g.runId, 'cache.published', {
      caseId: this.spec.id,
      message: changes.length
        ? `验证通过，缓存更新 ${changes.length} 处`
        : '验证通过，缓存内容未变化，已续期',
      key: this.key,
      generation,
      changes,
    });
  }
}
export class CacheChannel {
  operations: CachedOperation[] = [];
  private nativeByOperation: ChannelData['nativeByOperation'];
  agent?: MidsceneBrowserAgent;
  recording: StaticCommand[] | null = null;
  recordingComplete = true;
  index = 0;
  disableL2 = false;
  disableReason?: string;
  currentLabel?: string;
  constructor(
    readonly owner: CaseExecutionCache,
    readonly phase: string,
    readonly page: Page,
    readonly prior: ChannelData,
  ) {
    this.nativeByOperation =
      owner.stats.mode === 'realtime' || owner.bypassReason ? {} : structuredClone(prior.nativeByOperation);
    this.disableL2 = owner.stats.mode !== 'l2';
  }
  bind(agent: MidsceneBrowserAgent) {
    this.agent = agent;
    this.clearNative();
  }
  beginOperation(key: string) {
    this.clearNative();
    const cache = this.agent?.taskCache;
    const prior = this.nativeByOperation[key];
    if (cache && prior && !this.owner.bypassReason && this.owner.stats.mode !== 'realtime') {
      cache.cache = structuredClone(prior) as typeof cache.cache;
      cache.cacheOriginalLength = prior.caches.length;
    }
  }
  finishOperation(key: string) {
    if (this.agent?.taskCache && !this.owner.bypassReason)
      this.nativeByOperation[key] = nativeSchema.parse(this.agent.taskCache.cache);
  }
  async eligibility() {
    const reason = this.owner.bypassReason ?? (await uncacheablePageReason(this.page));
    if (reason) {
      if (!this.owner.stats.bypassReason) await this.route('AI', 'fallback', reason);
      this.owner.bypassReason = reason;
      this.owner.stats.bypassReason = reason;
      this.disableL2 = true;
      this.clearNative();
      if (this.agent?.taskCache) this.agent.taskCache.isCacheResultUsed = false;
    }
  }
  next(kind: string, text: string) {
    const index = this.index++;
    this.currentLabel = this.phase === 'authentication' ? `登录准备 · ${kind}` : text;
    const key = hash([index, kind, toTemplate(text, { runId: this.owner.g?.runId })]);
    return { key, old: this.prior.operations[index]?.key === key ? this.prior.operations[index] : undefined };
  }
  async route(tier: 'L2' | 'L1' | 'AI', outcome: 'hit' | 'miss' | 'fallback', message: string) {
    if (outcome === 'hit') {
      if (tier === 'L2') this.owner.stats.l2Hits++;
      else if (tier === 'L1') this.owner.stats.l1Hits++;
      else this.owner.stats.aiOperations++;
    }
    if (outcome === 'fallback') this.owner.stats.fallbacks++;
    await event(this.owner.g.runId, 'cache.route', {
      caseId: this.owner.spec.id,
      phase: this.phase,
      tier,
      outcome,
      message,
      operation: this.index,
      label: this.currentLabel,
    });
  }
  clearNative() {
    const cache = this.agent?.taskCache;
    if (cache) {
      // Midscene's executor keeps the same TaskCache reference. Reset it in place
      // with a fresh SDK instance so consumed/stale indices cannot leak between
      // operations that share identical prompts, including mixed L2/L1 runs.
      const Factory = cache.constructor as new (
        id: string,
        enabled: boolean,
        file?: string,
        options?: { readOnly?: boolean; writeOnly?: boolean },
      ) => NonNullable<typeof cache>;
      const fresh = new Factory(cache.cacheId, false, undefined, { writeOnly: true });
      fresh.readOnlyMode = true;
      fresh.writeOnlyMode = false;
      fresh.isCacheResultUsed = this.owner.stats.mode !== 'realtime' && !this.owner.bypassReason;
      Object.assign(cache, fresh);
    }
  }
  data(): ChannelData {
    return channelSchema.parse({
      operations: this.operations,
      nativeByOperation: this.nativeByOperation,
    });
  }
}
