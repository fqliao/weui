import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { db, event } from '../../db/src/index.ts';
import { config, AppError, publicError, redactText } from '../../config/src/index.ts';
import { observationSchema, verifyCase } from '../../assertions/src/index.ts';
import type { ToolGateway } from '../../tools/src/gateway.ts';
import type { CaseSpec, CaseResult } from '../../contracts/src/index.ts';
import { guardedPage, MidsceneDriver } from './browser.ts';
import { executeWebCase } from './web-case.ts';
export { browserEngine } from './browser.ts';
export function redactTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceValue);
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.name === 'string' && /authorization|cookie|api.key|service.key|password/i.test(v.name))
      return { ...v, value: '[REDACTED]' };
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [
        k,
        /password|authorization|cookie|api.?key|service.?key/i.test(k) ? '[REDACTED]' : redactTraceValue(val),
      ]),
    );
  }
  return typeof value === 'string' ? redactText(value) : value;
}
export async function evidence(
  g: ToolGateway,
  caseId: string,
  file: string,
  kind: string,
  contentType: string,
) {
  const stat = await fs.stat(file),
    row = await db.evidence.create({
      data: {
        runId: g.runId,
        caseId,
        kind,
        fileName: path.basename(file),
        path: path.relative(config.evidenceDir, file),
        contentType,
        bytes: stat.size,
      },
    });
  await event(g.runId, 'evidence', { id: row.id, caseId, kind, fileName: row.fileName });
  return row.id;
}
export async function capture(
  g: ToolGateway,
  spec: CaseSpec,
  page: Page,
  driver: MidsceneDriver,
  tag = 'result',
  includeReport = true,
) {
  const dir = path.join(config.evidenceDir, g.runId);
  await fs.mkdir(dir, { recursive: true });
  const ids: string[] = [];
  const png = path.join(dir, `${spec.id}-${tag}.png`);
  await page.screenshot({ path: png, fullPage: true });
  ids.push(await evidence(g, spec.id, png, 'screenshot', 'image/png'));
  if (includeReport) {
    const report = path.join(dir, `${spec.id}-${tag}.midscene.html`);
    await fs.writeFile(report, redactText(driver.agent.reportHTMLString({ inlineScreenshots: true })));
    ids.push(await evidence(g, spec.id, report, 'midscene-report', 'text/html'));
  }
  return ids;
}
export async function executeCase(
  g: ToolGateway,
  browser: Browser,
  spec: CaseSpec,
): Promise<{ result: CaseResult; cleanupFailed: boolean }> {
  if (spec.browser) return executeWebCase(g, browser, spec);
  const startedAt = new Date().toISOString(),
    namespace = `${g.runId}-${spec.id}`,
    contexts: BrowserContext[] = [],
    drivers: MidsceneDriver[] = [],
    ids: string[] = [];
  let prepared = false,
    cleanupFailed = false,
    page: Page | undefined,
    driver: MidsceneDriver | undefined;
  let status: CaseResult['result'] = 'INCONCLUSIVE',
    cause: string | null = null,
    message = '',
    assertions: CaseResult['assertions'] = [];
  const abort = () => {
    for (const c of contexts) void c.close().catch(() => {});
  };
  g.signal.addEventListener('abort', abort, { once: true });
  async function open(role: 'applicant' | 'reviewer', recordId?: string, tenant = 'A') {
    const base = g.manifest.environment.baseUrl;
    if (new URL(base).origin !== new URL(config.SAMPLE_ORIGIN).origin)
      throw new AppError('TARGET_DENIED', '样例环境地址不匹配');
    const s = await guardedPage(browser, base, [new URL(base).origin]);
    contexts.push(s.context);
    const login = await fetch(new URL('/internal/login', base), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-service-key': config.SAMPLE_SERVICE_KEY },
      body: JSON.stringify({ namespace, role, tenant }),
      signal: AbortSignal.any([g.signal, AbortSignal.timeout(10000)]),
    });
    const cookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('sample_session='))
      ?.split(';')[0]
      .slice('sample_session='.length);
    if (!login.ok || !cookie) throw new AppError('ACCESS', '样例会话创建失败');
    await s.context.addCookies([
      {
        name: 'sample_session',
        value: cookie,
        domain: new URL(base).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    page = s.page;
    driver = new MidsceneDriver(page, g, spec.id, s.check);
    drivers.push(driver);
    await g.call(spec.id, 'browser.run_case', '打开样例页面', { role, tenant }, async () => {
      await page!.goto(new URL(recordId ? `/?id=${recordId}` : '/', base).toString(), {
        waitUntil: 'domcontentloaded',
      });
    });
    await driver.wait('当前用户身份已显示，页面加载完成');
  }
  try {
    const fixture = await g.call(
      spec.id,
      'fixture.prepare',
      '准备隔离数据',
      { namespace },
      () => {
        prepared = true;
        return g.http(namespace, '/internal/fixtures', 'POST', {
          namespace,
          caseId: spec.id,
          fault: g.manifest.environment.config.fault || 'none',
          delayMs: g.manifest.environment.config.delayMs || 0,
        });
      },
      { write: true },
    );
    if (['C09', 'C10', 'C12'].includes(spec.id)) {
      await open(
        spec.id === 'C10' ? 'reviewer' : 'applicant',
        fixture.record.id,
        spec.id === 'C12' ? 'B' : 'A',
      );
      if (spec.id !== 'C12') await driver!.tap('审批通过按钮');
    } else {
      await open('applicant');
      await driver!.input(
        '申请标题输入框',
        spec.id === 'C04' ? '' : spec.id === 'C05' ? '长'.repeat(201) : `测试申请 ${spec.id}`,
      );
      await driver!.input(
        '申请金额输入框',
        ({ C06: '0', C07: '-1', C08: '1000001' } as Record<string, string>)[spec.id] || '100',
      );
      await driver!.tap('保存申请按钮');
      if (['C02', 'C03', 'C11'].includes(spec.id)) {
        await driver!.tap('提交申请按钮');
        if (spec.id === 'C11') await driver!.tap('提交申请按钮');
        else {
          const data = await g.call(spec.id, 'business.query', '读取新申请编号', { namespace }, () =>
            g.http(namespace, `/internal/observations?namespace=${namespace}`),
          );
          await open('reviewer', observationSchema.parse(data).records[0]?.id);
          await driver!.tap(spec.id === 'C02' ? '审批通过按钮' : '驳回申请按钮');
        }
      }
    }
    const ui = await driver!.query<{ message: string; visibleRecords: number }>(
      '{message:string,visibleRecords:number}，读取页面反馈提示原文以及可见申请记录数量，不统计创建表单',
    );
    let observed: unknown;
    try {
      observed = await g.call(spec.id, 'business.query', '查询独立业务状态', { namespace }, () =>
        g.http(namespace, `/internal/observations?namespace=${namespace}`),
      );
    } catch {
      throw new AppError('EVIDENCE_UNAVAILABLE', 'UI 已执行，但独立业务查询不可用');
    }
    const observation = observationSchema.parse(observed);
    if (
      observation.records.some((r) => r.namespace !== namespace) ||
      observation.audit.some((r) => r.namespace !== namespace)
    )
      throw new AppError('EVIDENCE_SCOPE', '业务证据范围不匹配');
    assertions = await g.call(
      spec.id,
      'assertions.verify',
      '执行独立业务断言',
      { assertionIds: spec.assertionIds },
      async () => verifyCase(spec.id, observation, ui),
    );
    status = assertions.length && assertions.every((a) => a.passed) ? 'PASS' : 'FAIL';
    cause = status === 'FAIL' ? 'PRODUCT' : null;
    message = status === 'PASS' ? 'Midscene UI 操作完成，独立业务断言全部成立' : '业务预期不成立';
  } catch (e) {
    const writes = await db.action.count({
      where: {
        runId: g.runId,
        caseId: spec.id,
        tool: 'midscene.ui',
        input: { path: ['write'], equals: true },
      },
    });
    status = writes ? 'INCONCLUSIVE' : g.signal.aborted ? 'SKIPPED' : 'BLOCKED';
    cause = e instanceof AppError ? e.code : 'ENVIRONMENT';
    message = publicError(e);
  } finally {
    if (page && driver && !page.isClosed())
      try {
        ids.push(...(await capture(g, spec, page, driver)));
      } catch {}
    for (const d of drivers) await d.destroy();
    for (const c of contexts) await c.close().catch(() => {});
    if (prepared)
      try {
        await g.call(
          spec.id,
          'fixture.cleanup',
          '清理隔离数据',
          { namespace },
          () => g.http(namespace, `/internal/fixtures/${namespace}`, 'DELETE', undefined, true),
          { cleanup: true, write: true },
        );
      } catch (e) {
        cleanupFailed = true;
        await event(g.runId, 'cleanup.error', { caseId: spec.id, message: publicError(e) });
      }
    g.signal.removeEventListener('abort', abort);
  }
  if (status === 'PASS' && !ids.length) {
    status = 'INCONCLUSIVE';
    cause = 'EVIDENCE';
    message = '断言成立，但证据保存失败';
  }
  return {
    result: {
      caseId: spec.id,
      title: spec.title,
      result: status,
      cause,
      message,
      assertions,
      evidenceIds: ids,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt: 1,
    },
    cleanupFailed,
  };
}
