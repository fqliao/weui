import type { Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import { db, event } from '../../db/src/index.ts';
import { AppError, publicError } from '../../config/src/index.ts';
import type { CaseSpec, CaseResult } from '../../contracts/src/index.ts';
import { loginConfigSchema, storageStateSchema, type WebStep } from '../../contracts/src/browser.ts';
import type { ToolGateway } from '../../tools/src/gateway.ts';
import { originsOf, profileForRun } from '../../websites/src/index.ts';
import { decryptSecret } from '../../websites/src/vault.ts';
import { assertAllowedUrl, validateStorage } from '../../websites/src/policy.ts';
import { guardedPage, MidsceneDriver } from './browser.ts';
import { capture } from './index.ts';
import { CaseExecutionCache } from './execution-cache.ts';
import { expandParameters, mapStrings, assertionLabel } from '../../contracts/src/static-ui.ts';
export function expandRun(text: string, runId: string, caseId: string) {
  return text.replaceAll('{{runId}}', runId).replaceAll('{{caseId}}', caseId);
}
export async function performSteps(
  driver: MidsceneDriver,
  steps: WebStep[],
  runId: string,
  caseId: string,
  phase = 'case',
  afterStep?: (index: number) => Promise<void>,
  parameters: Record<string, string> = {},
) {
  for (const [index, source] of steps.entries()) {
    const s = mapStrings(source, (v) => expandParameters(v, runId, caseId, parameters));
    const text = s.text;
    const payload = { caseId, index, phase, label: s.text };
    await event(runId, 'step.started', payload);
    try {
      if (s.kind === 'act') await driver.act(text);
      else if (s.kind === 'wait') {
        if (s.condition)
          await driver.structuredCheck(s.condition, 'wait', s.timeoutMs, JSON.stringify(source));
        else await driver.wait(text);
      } else if (s.kind === 'tap' && !s.target) await driver.tap(text);
      else if (s.kind === 'input' && !s.target) await driver.input(text, s.value);
      else await driver.control(s, JSON.stringify(source));
      await event(runId, 'step.completed', payload);
    } catch (error) {
      await event(runId, 'step.error', { ...payload, message: publicError(error) });
      throw error;
    }
    try {
      await afterStep?.(index);
    } catch (error) {
      await event(runId, 'evidence.error', { ...payload, message: publicError(error) });
    }
  }
}
export async function executeWebCase(
  g: ToolGateway,
  browser: Browser,
  spec: CaseSpec,
): Promise<{ result: CaseResult; cleanupFailed: boolean }> {
  const c = spec.browser!,
    startedAt = new Date().toISOString(),
    ids: string[] = [],
    assertions: CaseResult['assertions'] = [];
  let status: CaseResult['result'] = 'INCONCLUSIVE',
    cause: string | null = null,
    message = '',
    cleanupFailed = false,
    authenticated = false,
    stepsStarted = false,
    checkingAssertions = false,
    businessWriteAttempts = 0;
  let session: Awaited<ReturnType<typeof guardedPage>> | undefined, driver: MidsceneDriver | undefined;
  let cache: CaseExecutionCache | undefined;
  const abort = () => void session?.context.close().catch(() => {});
  g.signal.addEventListener('abort', abort, { once: true });
  try {
    // Validate every slot before authentication or any business action.
    mapStrings(c, (v) => expandParameters(v, g.runId, spec.id, c.parameters));
    const env = await db.environment.findUniqueOrThrow({ where: { id: g.manifest.environmentId } });
    if (env.revision !== g.manifest.plan.environmentRevision)
      throw new AppError('ENVIRONMENT_CHANGED', '网站配置已更新，请重新创建任务');
    const origins = originsOf(g.manifest.environment);
    session = await guardedPage(browser, env.baseUrl, origins);
    cache = await CaseExecutionCache.open(g, spec, browser.version());
    await authenticate(g, spec, session, cache);
    authenticated = true;
    driver = new MidsceneDriver(
      session.page,
      g,
      spec.id,
      session.check,
      `测试前提：${expandParameters(c.preconditions, g.runId, spec.id, c.parameters)}`,
      false,
      cache.channel('case', session.page),
    );
    if (!c.verifySessionOnly)
      await driver.invoke('打开用例入口', async () => {
        await session!.page.goto(
          assertAllowedUrl(
            expandParameters(c.startPath, g.runId, spec.id, c.parameters),
            env.baseUrl,
            origins,
          ),
          {
            waitUntil: 'domcontentloaded',
          },
        );
      });
    stepsStarted = true;
    await performSteps(
      driver,
      c.steps,
      g.runId,
      spec.id,
      'case',
      async (index) => {
        ids.push(...(await capture(g, spec, session!.page, driver!, `step-${index + 1}`, false)));
      },
      c.parameters,
    );
    checkingAssertions = true;
    for (let i = 0; i < c.assertions.length; i++) {
      const source = c.assertions[i];
      const assertion = mapStrings(source, (v) => expandParameters(v, g.runId, spec.id, c.parameters));
      const expected = assertionLabel(assertion);
      await event(g.runId, 'assertion.started', { caseId: spec.id, index: i, label: expected });
      const actual =
        typeof assertion === 'string'
          ? await driver.assert(expected)
          : await driver.structuredCheck(
              assertion.condition,
              'assert',
              assertion.timeoutMs,
              JSON.stringify(source),
            );
      if (!actual || typeof actual.pass !== 'boolean')
        throw new AppError('ASSERTION_UNAVAILABLE', '视觉断言没有返回有效结果');
      assertions.push({
        id: `ui-${i + 1}`,
        ruleId: spec.ruleIds[0],
        expected,
        actual: {
          pass: actual.pass,
          thought: actual.thought ?? actual.message ?? '',
          evidenceType:
            'cacheTier' in actual && actual.cacheTier === 'L2' ? 'PLAYWRIGHT_ASSERTION' : 'MIDSCENE_UI',
          ...('baselineRunId' in actual ? { baselineRunId: actual.baselineRunId } : {}),
        },
        passed: actual.pass,
      });
      ids.push(...(await capture(g, spec, session.page, driver, `assert-${i + 1}`, false)));
      await event(g.runId, 'assertion.completed', {
        caseId: spec.id,
        index: i,
        label: expected,
        passed: actual.pass,
        message: actual.thought ?? actual.message ?? '',
      });
    }
    status = assertions.every((a) => a.passed) ? 'PASS' : 'FAIL';
    cause = status === 'FAIL' ? 'UI_ASSERTION' : null;
    message =
      status === 'PASS' ? '页面验证全部成立，已保存本次截图与验证来源' : '页面验证不成立，请检查截图和报告';
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'EXECUTION_ERROR';
    status = !authenticated
      ? 'BLOCKED'
      : stepsStarted
        ? !checkingAssertions && driver?.writeAttempts === 0
          ? 'BLOCKED'
          : 'INCONCLUSIVE'
        : g.signal.aborted
          ? 'SKIPPED'
          : 'BLOCKED';
    cause =
      status === 'BLOCKED' && authenticated && code === 'EXECUTION_ERROR' ? 'UI_ACTION_NOT_STARTED' : code;
    message = publicError(e);
  } finally {
    businessWriteAttempts = driver?.writeAttempts ?? 0;
    if (authenticated && session && driver && !session.page.isClosed())
      try {
        ids.push(...(await capture(g, spec, session.page, driver, 'final')));
      } catch {}
    if (stepsStarted && businessWriteAttempts > 0 && c.cleanup.length) {
      try {
        if (!driver || g.signal.aborted)
          throw new AppError('CLEANUP_UNAVAILABLE', '会话已取消，未能执行 UI 清理');
        await event(g.runId, 'cleanup.started', { caseId: spec.id, message: '按用例配置执行清理' });
        driver.beginCleanup();
        await performSteps(driver, c.cleanup, g.runId, spec.id, 'cleanup', undefined, c.parameters);
        await event(g.runId, 'cleanup.completed', { caseId: spec.id });
      } catch (e) {
        cleanupFailed = true;
        await event(g.runId, 'cleanup.error', { caseId: spec.id, message: publicError(e) });
      }
    }
    await driver?.destroy();
    await session?.context.close().catch(() => {});
    g.signal.removeEventListener('abort', abort);
  }
  if ((status === 'PASS' || status === 'FAIL') && !ids.length) {
    status = 'INCONCLUSIVE';
    cause = 'EVIDENCE';
    message = '页面断言已返回，但运行证据未能保存';
  }
  if (status === 'PASS' && !cleanupFailed && cache) {
    try {
      await cache.publish();
    } catch {
      await event(g.runId, 'cache.publish.failed', {
        caseId: spec.id,
        message: '本次验证结果已保留，缓存更新失败，后续可重新构建',
      });
    }
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
      businessWriteAttempts,
      ...(cache ? { execution: cache.stats } : {}),
    },
    cleanupFailed,
  };
}

export async function authenticate(
  g: ToolGateway,
  spec: CaseSpec,
  session: Awaited<ReturnType<typeof guardedPage>>,
  cache?: CaseExecutionCache,
) {
  const c = spec.browser!,
    env = await db.environment.findUniqueOrThrow({ where: { id: g.manifest.environmentId } }),
    origins = originsOf(g.manifest.environment);
  if (c.sessionId) {
    const p = await profileForRun(c.sessionId, c.sessionRevision!, env.id),
      cfg = loginConfigSchema.parse(p.config);
    const loginUrl = assertAllowedUrl(cfg.loginPath, env.baseUrl, origins);
    if (p.kind === 'storage') {
      const state = storageStateSchema.parse(decryptSecret(p.encryptedSecret, env.id));
      validateStorage(state, origins);
      if (state.cookies.length) await session.context.addCookies(state.cookies);
      // Restore each origin once. Subsequent navigation must retain tokens rotated by the website.
      await session.page.addInitScript(
        ({ items, marker }) => {
          const item = items.find((o) => o.origin === location.origin);
          if (item && !sessionStorage.getItem(marker)) {
            for (const s of item.localStorage) localStorage.setItem(s.name, s.value);
            sessionStorage.setItem(marker, 'restored');
          }
        },
        { items: state.origins, marker: `__tracelab_restore_${randomUUID()}` },
      );
    }
    const auth = new MidsceneDriver(
      session.page,
      g,
      spec.id,
      session.check,
      '',
      true,
      cache?.channel('authentication', session.page),
    );
    try {
      await auth.invoke('打开登录入口', async () => {
        await session!.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      });
      if (p.kind === 'form') {
        const secret = decryptSecret(p.encryptedSecret, env.id) as { username: string; password: string };
        await auth.input(cfg.usernameField, secret.username);
        await auth.input(cfg.passwordField, secret.password);
        await auth.act(cfg.submitInstruction);
      }
      // Clicking submit can finish before the asynchronous login request or route transition.
      // Wait on the user's visible success condition before making the final assertion.
      // Structured verification already polls until ready. Natural-language
      // waits can teach a reusable definition; the subsequent assertion then
      // rechecks it statically instead of repeating the same AI analysis.
      const check =
        typeof cfg.successAssertion === 'string'
          ? (await auth.wait(cfg.successAssertion), await auth.assert(cfg.successAssertion))
          : await auth.structuredCheck(
              cfg.successAssertion.condition,
              'assert',
              cfg.successAssertion.timeoutMs ?? 20000,
            );
      if (!check?.pass) throw new AppError('LOGIN_FAILED', '登录成功条件不成立，请核对登录配置或刷新会话');
    } finally {
      await auth.destroy();
    }
  }
}
