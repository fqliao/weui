import type { FastifyInstance } from 'fastify';
import { caseCacheStatuses } from './cache-status.ts';
import { registerCacheRoutes } from './cache-routes.ts';
import { z } from 'zod';
import { db, json, audit } from '../../db/src/index.ts';
import { identity, projectAccess, type Identity } from '../../auth/src/index.ts';
import { AppError, hash } from '../../config/src/index.ts';
import {
  loginConfigSchema,
  storageStateSchema,
  webCaseSchema,
  type BrowserCase,
} from '../../contracts/src/browser.ts';
import type { CaseSpec } from '../../contracts/src/index.ts';
import { WEB_ADAPTER, normalizeOrigins, assertAllowedUrl, validateStorage, webUrl } from './policy.ts';
import { encryptSecret, decryptSecret } from './vault.ts';
import { browserNameSchema, configuredBrowser } from '../../contracts/src/browser-choice.ts';
import { assertionLabel, expandParameters } from '../../contracts/src/static-ui.ts';

export async function websiteAccess(user: Identity, id: string) {
  const env = await db.environment.findUnique({ where: { id } });
  if (!env || env.adapter !== WEB_ADAPTER) throw new AppError('NOT_FOUND', '网站不存在', 404);
  await projectAccess(user, env.projectId);
  return env;
}
export function originsOf(env: { baseUrl: string; config: unknown }) {
  return normalizeOrigins(env.baseUrl, (env.config as { allowedOrigins?: string[] }).allowedOrigins ?? []);
}
const publicProfile = ({
  encryptedSecret,
  ...row
}: Awaited<ReturnType<typeof db.loginProfile.findUniqueOrThrow>>) => ({
  ...row,
  hasSecret: Boolean(encryptedSecret),
});
export async function profileForRun(id: string, revision: number, environmentId: string) {
  const profile = await db.loginProfile.findUnique({ where: { id } });
  if (
    !profile ||
    profile.environmentId !== environmentId ||
    !profile.enabled ||
    profile.revision !== revision
  )
    throw new AppError('SESSION_CHANGED', '登录配置已更新或停用，请重新创建任务');
  if (profile.expiresAt && profile.expiresAt.getTime() <= Date.now())
    throw new AppError('SESSION_EXPIRED', '登录会话已过期，请更新会话后创建任务');
  return profile;
}
export async function snapshotCases(environmentId: string, caseIds: string[]): Promise<CaseSpec[]> {
  if (new Set(caseIds).size !== caseIds.length) throw new AppError('CASES', '用例不能重复');
  const env = await db.environment.findUniqueOrThrow({ where: { id: environmentId } });
  const rows = await db.webCase.findMany({
    where: { id: { in: caseIds }, deletedAt: null, enabled: true, feature: { environmentId, enabled: true } },
    include: { feature: true },
  });
  if (rows.length !== caseIds.length) throw new AppError('CASES', '请选择此网站下已启用的用例');
  return Promise.all(
    caseIds.map(async (id) => {
      const row = rows.find((r) => r.id === id)!,
        input = webCaseSchema.parse(row.content);
      assertAllowedUrl(
        expandParameters(input.startPath, 'run', id, input.parameters),
        env.baseUrl,
        originsOf(env),
      );
      const profile = input.sessionId
        ? await db.loginProfile.findUnique({ where: { id: input.sessionId } })
        : null;
      if (input.sessionId) await profileForRun(input.sessionId, profile?.revision ?? -1, environmentId);
      const browser: BrowserCase = {
        ...input,
        preconditions: [row.feature.description, input.preconditions].filter(Boolean).join('\n'),
        revision: row.revision,
        featureId: row.featureId,
        featureRevision: row.feature.revision,
        sessionRevision: profile?.revision ?? null,
      };
      return {
        id: row.id,
        title: row.title,
        category: row.feature.name,
        ruleIds: [`web-rule-${row.id}`],
        steps: [
          `打开 ${input.startPath}`,
          ...(profile ? [`使用登录配置：${profile.name}`] : []),
          ...input.steps.map((s) => `${s.kind}: ${s.text}${s.kind === 'input' ? ` = ${s.value}` : ''}`),
          ...input.cleanup.map((s) => `清理：${s.text}`),
        ],
        expected: input.assertions.map(assertionLabel).join('\n'),
        assertionIds: input.assertions.map((_, i) => `ui-${i + 1}`),
        browser,
      };
    }),
  );
}
export async function caseKnowledge(projectId: string, cases: CaseSpec[]) {
  const content = {
    rules: cases.map((c) => ({
      id: c.ruleIds[0],
      title: c.title,
      text: c.expected,
      source: `web-case:${c.id}@${c.browser!.revision}`,
      owner: '测试人员',
    })),
    pages: cases.map((c) => ({
      id: c.id,
      title: c.category,
      body: c.browser!.preconditions,
      source: `web-feature:${c.browser!.featureId}`,
    })),
    ontology: {
      entities: ['Website', 'Feature', 'Case', 'Session', 'UIAssertion', 'Evidence'],
      relations: cases.map((c) => ({ from: c.id, type: 'verifies', to: c.ruleIds[0] })),
    },
  };
  const digest = hash(content),
    id = `web-knowledge-${hash(projectId).slice(0, 8)}-${digest.slice(0, 24)}`;
  await db.knowledgeRelease.createMany({
    skipDuplicates: true,
    data: {
      id,
      projectId,
      name: '网站用例规则快照',
      version: digest.slice(0, 8),
      hash: digest,
      content: json(content),
    },
  });
  return db.knowledgeRelease.findUniqueOrThrow({ where: { id } });
}
export function registerWebsiteRoutes(app: FastifyInstance) {
  registerCacheRoutes(app);
  const idOf = (q: { params: unknown }) => (q.params as { id: string }).id;
  const siteSchema = z.object({
    browserName: browserNameSchema.optional(),
    projectId: z.string(),
    name: z.string().trim().min(2).max(100),
    baseUrl: z.string().max(2000),
    allowedOrigins: z.array(z.string().max(2000)).max(20).default([]),
    enabled: z.boolean().default(true),
    revision: z.number().int().positive().optional(),
  });
  app.get('/api/websites', async (q) => {
    const u = await identity(q),
      { projectId } = z.object({ projectId: z.string() }).parse(q.query);
    await projectAccess(u, projectId);
    return db.environment.findMany({
      where: { projectId, adapter: WEB_ADAPTER },
      orderBy: { createdAt: 'asc' },
    });
  });
  app.post('/api/websites', async (q) => {
    const u = await identity(q),
      b = siteSchema.parse(q.body);
    await projectAccess(u, b.projectId);
    const row = await db.environment.create({
      data: {
        projectId: b.projectId,
        name: b.name,
        baseUrl: webUrl(b.baseUrl).toString(),
        adapter: WEB_ADAPTER,
        credentialRef: 'login-profile',
        config: {
          allowedOrigins: normalizeOrigins(b.baseUrl, b.allowedOrigins),
          browser: b.browserName ?? 'chrome',
        },
        enabled: b.enabled,
      },
    });
    await audit(u.id, 'website.create', row.id, {}, row.projectId);
    return row;
  });
  app.patch('/api/websites/:id', async (q) => {
    const u = await identity(q),
      old = await websiteAccess(u, idOf(q)),
      b = siteSchema.parse(q.body);
    if (b.projectId !== old.projectId) throw new AppError('SCOPE', '不能移动网站到其他空间');
    const updated = await db.environment.updateMany({
      where: { id: old.id, revision: b.revision ?? -1 },
      data: {
        name: b.name,
        baseUrl: webUrl(b.baseUrl).toString(),
        config: {
          allowedOrigins: normalizeOrigins(b.baseUrl, b.allowedOrigins),
          browser: b.browserName ?? configuredBrowser(old.config),
        },
        enabled: b.enabled,
        revision: { increment: 1 },
      },
    });
    if (!updated.count) throw new AppError('REVISION_CONFLICT', '网站已更新，请刷新', 409);
    await audit(u.id, 'website.update', old.id, {}, old.projectId);
    return db.environment.findUniqueOrThrow({ where: { id: old.id } });
  });
  app.get('/api/websites/:id/sessions', async (q) => {
    await websiteAccess(await identity(q), idOf(q));
    return (
      await db.loginProfile.findMany({ where: { environmentId: idOf(q) }, orderBy: { createdAt: 'asc' } })
    ).map(publicProfile);
  });
  const profileSchema = z.object({
    name: z.string().trim().min(2).max(100),
    kind: z.enum(['form', 'storage']),
    config: loginConfigSchema,
    username: z.string().max(500).optional(),
    password: z.string().max(2000).optional(),
    storageState: storageStateSchema.optional(),
    enabled: z.boolean().default(true),
    expiresAt: z.string().datetime().nullable().default(null),
    revision: z.number().int().optional(),
  });
  async function saveProfile(q: { params: unknown; body: unknown }, user: Identity, existingId?: string) {
    const old = existingId ? await db.loginProfile.findUnique({ where: { id: existingId } }) : null;
    if (existingId && !old) throw new AppError('NOT_FOUND', '登录配置不存在', 404);
    const env = await websiteAccess(user, old?.environmentId ?? idOf(q)),
      b = profileSchema.parse(q.body);
    assertAllowedUrl(b.config.loginPath, env.baseUrl, originsOf(env));
    if (b.expiresAt && Date.parse(b.expiresAt) <= Date.now())
      throw new AppError('SESSION_EXPIRED', '有效期必须晚于当前时间');
    const previous =
      old && old.kind === b.kind
        ? (decryptSecret(old.encryptedSecret, env.id) as Record<string, unknown>)
        : {};
    let secret: unknown;
    if (b.kind === 'form') {
      const username = b.username || previous.username,
        password = b.password || previous.password;
      if (typeof username !== 'string' || !username || typeof password !== 'string' || !password)
        throw new AppError('CREDENTIALS', '请输入登录账号和密码');
      if (!b.config.usernameField || !b.config.passwordField || !b.config.submitInstruction)
        throw new AppError('LOGIN_CONFIG', '请填写登录输入框和提交操作');
      secret = { username, password };
    } else {
      const state = storageStateSchema.parse(b.storageState ?? previous);
      validateStorage(state, originsOf(env));
      if (!state.cookies.length && !state.origins.length)
        throw new AppError('SESSION_EMPTY', '请导入 Cookie 或 localStorage');
      secret = state;
    }
    const data = {
      name: b.name,
      kind: b.kind,
      config: json(b.config),
      encryptedSecret: encryptSecret(secret, env.id),
      enabled: b.enabled,
      expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
    };
    let row;
    if (old) {
      const n = await db.loginProfile.updateMany({
        where: { id: old.id, revision: b.revision ?? -1 },
        data: { ...data, revision: { increment: 1 } },
      });
      if (!n.count) throw new AppError('REVISION_CONFLICT', '登录配置已更新，请刷新', 409);
      row = await db.loginProfile.findUniqueOrThrow({ where: { id: old.id } });
    } else row = await db.loginProfile.create({ data: { ...data, environmentId: env.id } });
    await audit(user.id, old ? 'login.update' : 'login.create', row.id, { kind: row.kind }, env.projectId);
    return publicProfile(row);
  }
  app.post('/api/websites/:id/sessions', async (q) => saveProfile(q, await identity(q)));
  app.patch('/api/login-profiles/:id', async (q) => saveProfile(q, await identity(q), idOf(q)));
  app.get('/api/websites/:id/features', async (q) => {
    await websiteAccess(await identity(q), idOf(q));
    return db.webFeature.findMany({
      where: { environmentId: idOf(q) },
      include: { cases: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  });
  app.get('/api/websites/:id/cache-status', async (q) => {
    const env = await websiteAccess(await identity(q), idOf(q));
    const { browserName } = z.object({ browserName: browserNameSchema.optional() }).parse(q.query);
    return caseCacheStatuses(env.id, browserName ?? configuredBrowser(env.config));
  });
  const featureSchema = z.object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(8000).default(''),
    enabled: z.boolean().default(true),
    revision: z.number().int().optional(),
  });
  app.post('/api/websites/:id/features', async (q) => {
    const u = await identity(q),
      env = await websiteAccess(u, idOf(q)),
      { revision, ...b } = featureSchema.parse(q.body);
    const row = await db.webFeature.create({ data: { ...b, environmentId: env.id } });
    await audit(u.id, 'feature.create', row.id, {}, env.projectId);
    return row;
  });
  app.patch('/api/web-features/:id', async (q) => {
    const u = await identity(q),
      old = await db.webFeature.findUnique({ where: { id: idOf(q) } });
    if (!old) throw new AppError('NOT_FOUND', '功能不存在', 404);
    const env = await websiteAccess(u, old.environmentId),
      { revision, ...b } = featureSchema.parse(q.body);
    const n = await db.webFeature.updateMany({
      where: { id: old.id, revision: revision ?? -1 },
      data: { ...b, revision: { increment: 1 } },
    });
    if (!n.count) throw new AppError('REVISION_CONFLICT', '功能已更新，请刷新', 409);
    await audit(u.id, 'feature.update', old.id, {}, env.projectId);
    return db.webFeature.findUniqueOrThrow({ where: { id: old.id } });
  });
  async function saveCase(q: { params: unknown; body: unknown }, u: Identity, existingId?: string) {
    const old = existingId ? await db.webCase.findUnique({ where: { id: existingId } }) : null;
    if (existingId && (!old || old.deletedAt)) throw new AppError('NOT_FOUND', '用例不存在或已删除', 404);
    const feature = await db.webFeature.findUnique({ where: { id: old?.featureId ?? idOf(q) } });
    if (!feature) throw new AppError('NOT_FOUND', '功能不存在', 404);
    const env = await websiteAccess(u, feature.environmentId),
      b = webCaseSchema.parse(q.body);
    assertAllowedUrl(expandParameters(b.startPath, 'run', 'case', b.parameters), env.baseUrl, originsOf(env));
    if (b.verifySessionOnly && !b.sessionId)
      throw new AppError('SESSION_REQUIRED', '使用登录后页面需要选择登录身份');
    if (b.sessionId) {
      const p = await db.loginProfile.findUnique({ where: { id: b.sessionId } });
      await profileForRun(b.sessionId, p?.revision ?? -1, env.id);
    }
    let row;
    if (old) {
      const { revision } = z.object({ revision: z.number().int() }).parse(q.body);
      const n = await db.webCase.updateMany({
        where: { id: old.id, revision, deletedAt: null },
        data: { title: b.title, content: json(b), enabled: b.enabled, revision: { increment: 1 } },
      });
      if (!n.count) throw new AppError('REVISION_CONFLICT', '用例已更新，请刷新', 409);
      row = await db.webCase.findUniqueOrThrow({ where: { id: old.id } });
    } else
      row = await db.webCase.create({
        data: { featureId: feature.id, title: b.title, content: json(b), enabled: b.enabled },
      });
    await audit(
      u.id,
      old ? 'web-case.update' : 'web-case.create',
      row.id,
      { revision: row.revision },
      env.projectId,
    );
    return row;
  }
  app.post('/api/web-features/:id/cases', async (q) => saveCase(q, await identity(q)));
  app.patch('/api/web-cases/:id', async (q) => saveCase(q, await identity(q), idOf(q)));

  const deletionItem = z.object({ id: z.string().min(1).max(100), revision: z.number().int().positive() });
  async function deleteCases(u: Identity, environmentId: string, items: z.infer<typeof deletionItem>[]) {
    const env = await websiteAccess(u, environmentId);
    if (new Set(items.map((c) => c.id)).size !== items.length)
      throw new AppError('CASES', '删除列表中不能包含重复用例');
    // Revision checks and audit commit together. Sorting gives concurrent batches
    // a consistent row-lock order; any stale/missing case rolls back the batch.
    await db.$transaction(async (tx) => {
      const deletedAt = new Date();
      for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
        const changed = await tx.webCase.updateMany({
          where: { ...item, deletedAt: null, feature: { environmentId: env.id } },
          data: { deletedAt, revision: { increment: 1 } },
        });
        if (!changed.count)
          throw new AppError(
            'REVISION_CONFLICT',
            '用例已修改、已删除或不属于此网站。请刷新列表后重新选择，本次未删除任何用例。',
            409,
          );
      }
      await tx.auditEvent.createMany({
        data: items.map((item) => ({
          actorId: u.id,
          projectId: env.projectId,
          action: 'web-case.delete',
          targetId: item.id,
          detail: json({ revision: item.revision, deletedAt, batchSize: items.length }),
        })),
      });
    });
    return { deletedIds: items.map((c) => c.id), count: items.length };
  }
  app.post('/api/websites/:id/cases/delete', async (q) => {
    const u = await identity(q);
    const { cases } = z.object({ cases: z.array(deletionItem).min(1) }).parse(q.body);
    return deleteCases(u, idOf(q), cases);
  });
  app.delete('/api/web-cases/:id', async (q) => {
    const u = await identity(q);
    const item = deletionItem.parse({ ...(q.body as object), id: idOf(q) });
    const row = await db.webCase.findUnique({ where: { id: item.id }, include: { feature: true } });
    if (!row) throw new AppError('NOT_FOUND', '用例不存在或已删除', 404);
    return deleteCases(u, row.feature.environmentId, [item]);
  });
}
