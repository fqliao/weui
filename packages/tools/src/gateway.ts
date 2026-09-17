import { db, json, event } from '../../db/src/index.ts';
import { config, AppError, publicError } from '../../config/src/index.ts';
import { toolCatalog } from '../../knowledge/src/catalog.ts';
import type { RunManifest, Usage } from '../../contracts/src/index.ts';
export class ToolGateway {
  constructor(
    public runId: string,
    public owner: string,
    public epoch: number,
    public manifest: RunManifest,
    public usage: Usage,
    public signal: AbortSignal,
  ) {}
  async active(cleanup = false) {
    const run = await db.run.findUniqueOrThrow({ where: { id: this.runId } });
    if (
      run.leaseOwner !== this.owner ||
      run.leaseEpoch !== this.epoch ||
      !['RUNNING', 'CANCEL_REQUESTED'].includes(run.status)
    )
      throw new AppError('LEASE_LOST', '执行租约已失效');
    if (!cleanup && this.signal.aborted && this.signal.reason instanceof AppError) throw this.signal.reason;
    if (!cleanup && (this.signal.aborted || run.cancelRequestedAt || run.status === 'CANCEL_REQUESTED'))
      throw new AppError('CANCELLED', '用户已请求取消');
    if (!cleanup && Date.now() - (run.startedAt?.getTime() ?? Date.now()) > this.manifest.budget.timeoutMs)
      throw new AppError('BUDGET', '任务超过时间预算');
    if (!cleanup && (await db.setting.findUnique({ where: { key: 'execution_enabled' } }))?.value === false)
      throw new AppError('POLICY_DENIED', '执行已被管理员暂停');
    const env = await db.environment.findUnique({ where: { id: this.manifest.environmentId } });
    if (!cleanup && !env?.enabled) throw new AppError('POLICY_DENIED', '环境已停用');
    if (
      !cleanup &&
      this.manifest.plan.environmentRevision &&
      env?.revision !== this.manifest.plan.environmentRevision
    )
      throw new AppError('ENVIRONMENT_CHANGED', '网站配置已变化，停止后续操作');
    if (!cleanup)
      for (const c of this.manifest.plan.cases) {
        if (!c.browser?.sessionId) continue;
        const profile = await db.loginProfile.findUnique({ where: { id: c.browser.sessionId } });
        if (
          !profile?.enabled ||
          profile.revision !== c.browser.sessionRevision ||
          (profile.expiresAt && profile.expiresAt.getTime() <= Date.now())
        )
          throw new AppError('SESSION_CHANGED', '登录配置已改变、过期或停用，停止后续操作');
      }
    if (
      !cleanup &&
      this.manifest.skillReleaseId &&
      (await db.skillRelease.findUnique({ where: { id: this.manifest.skillReleaseId } }))?.disabled
    )
      throw new AppError('POLICY_DENIED', 'Skill 已撤销');
  }
  async call<T>(
    caseId: string,
    tool: string,
    label: string,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
    options: {
      write?: boolean;
      cleanup?: boolean;
      phase?: 'authentication' | 'case' | 'cleanup';
      writeStarted?: () => boolean;
    } = {},
  ) {
    await this.active(options.cleanup);
    const registration = toolCatalog.find((t) => t.id === tool);
    if (!registration || this.manifest.toolVersions[tool] !== registration.version)
      throw new AppError('TOOL_VERSION', '工具版本不匹配');
    const legacyBrowserPermission =
      tool === 'midscene.ui' &&
      this.manifest.environment.adapter === 'sample-approval-v1' &&
      this.manifest.skillContent?.toolIds.includes('browser.run_case');
    if (
      this.manifest.skillContent &&
      !this.manifest.skillContent.toolIds.includes(tool) &&
      !legacyBrowserPermission
    )
      throw new AppError('POLICY_DENIED', 'Skill 未声明此工具');
    if (!options.cleanup && this.usage.actions >= this.manifest.budget.maxActions)
      throw new AppError('BUDGET', '工具动作数量达到预算，请缩小范围或提高预算');
    if (!options.cleanup) this.usage.actions++;
    const id = `${this.runId}-${caseId}-${options.cleanup ? 'cleanup' : this.usage.actions}`;
    await db.action.create({
      data: {
        id,
        runId: this.runId,
        caseId,
        tool,
        status: 'STARTED',
        leaseEpoch: this.epoch,
        input: json({
          ...input,
          label,
          write: Boolean(options.write),
          ...(options.phase ? { phase: options.phase } : {}),
        }),
      },
    });
    await event(this.runId, 'action.started', {
      actionId: id,
      caseId,
      tool,
      label,
      actions: this.usage.actions,
    });
    try {
      const output = await fn();
      await db.action.update({
        where: { id },
        data: {
          status: 'OK',
          output: json({
            completed: true,
            writeAttempted: Boolean(options.write) && (options.writeStarted?.() ?? true),
          }),
          finishedAt: new Date(),
        },
      });
      await event(this.runId, 'action.completed', { actionId: id, caseId, tool, label });
      await db.run.updateMany({
        where: {
          id: this.runId,
          leaseOwner: this.owner,
          leaseEpoch: this.epoch,
          status: { in: ['RUNNING', 'CANCEL_REQUESTED'] },
        },
        data: { usage: json(this.usage) },
      });
      return output;
    } catch (error) {
      const unknownOutcome = Boolean(options.write) && (options.writeStarted?.() ?? true);
      await db.action.update({
        where: { id },
        data: {
          status: unknownOutcome ? 'UNKNOWN_OUTCOME' : 'ERROR',
          output: json({ completed: false, writeAttempted: unknownOutcome }),
          error: publicError(error),
          finishedAt: new Date(),
        },
      });
      await event(this.runId, 'action.error', {
        actionId: id,
        caseId,
        tool,
        label,
        message: publicError(error),
        unknownOutcome,
      });
      throw error;
    }
  }
  async http(namespace: string, route: string, method = 'GET', body?: unknown, cleanup = false) {
    if (!namespace.startsWith(`${this.runId}-`)) throw new AppError('SCOPE', '业务对象不属于当前运行');
    const base = new URL(this.manifest.environment.baseUrl);
    if (
      this.manifest.environment.adapter !== 'sample-approval-v1' ||
      base.origin !== new URL(config.SAMPLE_ORIGIN).origin ||
      base.username ||
      base.password
    )
      throw new AppError('TARGET_DENIED', '业务适配器的目标地址不匹配');
    if (this.manifest.environment.credentialRef !== 'SAMPLE_SERVICE_KEY')
      throw new AppError('CREDENTIAL_REF', '不支持的凭证引用');
    const url = new URL(route, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/internal/'))
      throw new AppError('TARGET_DENIED', '禁止越过注册的业务端点');
    const scopeOk =
      (method === 'GET' &&
        url.pathname === '/internal/observations' &&
        url.searchParams.get('namespace') === namespace) ||
      (method === 'POST' &&
        url.pathname === '/internal/fixtures' &&
        (body as { namespace?: string })?.namespace === namespace) ||
      (method === 'DELETE' && url.pathname === `/internal/fixtures/${namespace}`);
    if (!scopeOk) throw new AppError('SCOPE', '工具端点、方法与数据命名空间不匹配');
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-service-key': config.SAMPLE_SERVICE_KEY,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: cleanup
        ? AbortSignal.timeout(7000)
        : AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok)
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        `业务工具返回 ${response.status}，需核对依赖或副作用`,
        502,
      );
    return response.json();
  }
}
