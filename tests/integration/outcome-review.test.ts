import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { db, json } from '../../packages/db/src/index.ts';
import { passwordHash } from '../../packages/auth/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { emptyUsage, type RunManifest } from '../../packages/contracts/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { Client, poll } from '../helpers.ts';
import { fixtureWebsite, fixtureAccount } from '../fixtures/website.ts';

test(
  '人工核对恢复：权限、证据绑定、按用例留痕，Chrome 校准后真实执行',
  { skip: !config.visionReady, timeout: 600000 },
  async () => {
    const client = new Client();
    await client.login();
    const { user } = await client.call('/auth/me');
    const fixture = await fixtureWebsite();
    const site = await client.call('/websites', 'POST', {
      projectId: 'sample-project',
      name: '恢复流程独立验收',
      baseUrl: fixture.origin,
    });
    const outsider = await db.user.create({
      data: {
        email: `outcome-${randomUUID()}@example.test`,
        name: '隔离用户',
        passwordHash: passwordHash('Test-only-8653'),
        role: 'TESTER',
      },
    });
    const browser = await browserEngine();
    let agent: PlaywrightAgent | undefined;
    const runIds: string[] = [];
    try {
      const login = await client.call(`/websites/${site.id}/sessions`, 'POST', {
        name: '保存的验收身份',
        kind: 'form',
        config: {
          loginPath: '/login',
          usernameField: '邮箱输入框',
          passwordField: '密码输入框',
          successAssertion: '页面显示欢迎，测试用户',
        },
        ...fixtureAccount,
      });
      const feature = await client.call(`/websites/${site.id}/features`, 'POST', { name: '登录恢复验收' });
      const c1 = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '登录恢复用例',
        startPath: '/login',
        sessionId: login.id,
        steps: [{ kind: 'act', text: '输入普通用户的用户名和密码，点击 Login 按钮' }],
        assertions: ['页面显示欢迎，测试用户'],
      });
      const c2 = await client.call(`/web-features/${feature.id}/cases`, 'POST', {
        title: '独立首页验证',
        startPath: '/',
        steps: [],
        assertions: ['页面显示测试商店'],
      });
      const task = await client.plan('恢复流程历史夹具', { environmentId: site.id, caseIds: [c1.id, c2.id] });
      const originalSummary = [c1, c2].map((c) => ({
        caseId: c.id,
        title: c.title,
        result: 'INCONCLUSIVE',
        cause: 'EXECUTION_ERROR',
        message: '历史夹具：占位账号登录失败，待核对实际结果',
        businessWriteAttempts: 1,
        assertions: [],
        evidenceIds: [],
        attempt: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }));
      const run = await db.run.create({
        data: {
          taskId: task.id,
          projectId: site.projectId,
          creatorId: user.id,
          status: 'ERROR',
          manifest: json({
            version: '1',
            projectId: site.projectId,
            environment: site,
            environmentId: site.id,
            budget: task.budget,
            plan: task.plans[0].content,
            planHash: task.plans[0].hash,
            revision: task.revision,
            knowledgeReleaseId: task.knowledgeReleaseId,
            knowledgeHash: (
              await db.knowledgeRelease.findUniqueOrThrow({ where: { id: task.knowledgeReleaseId } })
            ).hash,
            skillReleaseId: null,
            skillHash: null,
            skillContent: null,
            assertionsVersion: 'midscene-ui-assertions-1.0.0',
            model: 'catalog',
            promptVersion: 'outcome-review-test',
            sample: false,
            debug: false,
            browser: { name: 'chrome', engine: 'playwright' },
            codeVersion: 'mvp-0.2.0',
            toolVersions: { 'midscene.ui': '1.0.0' },
          } satisfies RunManifest),
          summary: json(originalSummary),
          usage: json(emptyUsage()),
          idempotencyKey: randomUUID(),
          cleanupStatus: 'NOT_CONFIGURED',
          finishedAt: new Date(),
        },
      });
      runIds.push(run.id);
      for (const c of [c1, c2]) {
        const action = await db.action.create({
          data: {
            id: randomUUID(),
            runId: run.id,
            caseId: c.id,
            tool: 'midscene.ui',
            leaseEpoch: 1,
            status: 'UNKNOWN_OUTCOME',
            input: { phase: 'case', write: true },
            output: { writeAttempted: true },
            finishedAt: new Date(),
          },
        });
        for (const kind of ['action.started', 'midscene.action', 'action.error', 'case.completed'])
          await db.runEvent.create({
            data: {
              runId: run.id,
              kind,
              payload: { caseId: c.id, actionId: action.id, phase: 'case', write: true },
            },
          });
      }
      for (const kind of ['browser.closed', 'finished'])
        await db.runEvent.create({ data: { runId: run.id, kind, payload: {} } });
      const route = `/runs/${run.id}/outcome-review`;
      const state = await client.call(route);
      assert.equal(state.retry.allowed, false);
      assert.equal(state.review.pendingCases.length, 2);
      const body = {
        caseId: c2.id,
        fingerprint: state.review.fingerprint,
        resolution: 'NO_BUSINESS_CHANGE',
        note: '独立测试夹具未对业务网站执行写入',
        confirmed: true,
      };
      const isolated = new Client();
      await isolated.call('/auth/login', 'POST', { email: outsider.email, password: 'Test-only-8653' });
      await isolated.call(route, 'GET', undefined, 403);
      await isolated.call(route, 'POST', body, 403);
      await client.call(route, 'POST', { ...body, confirmed: false }, 400);
      await client.call(route, 'POST', { ...body, note: '' }, 400);
      await client.call(route, 'POST', { ...body, note: '   ' }, 400);
      await client.call(route, 'POST', { ...body, caseId: 'not-in-this-run' }, 409);
      await client.call(route, 'POST', { ...body, fingerprint: 'forged' }, 409);
      // Evidence added after the form was opened invalidates its check token.
      await db.runEvent.create({
        data: { runId: run.id, kind: 'case.completed', payload: { caseId: c2.id, note: '新增回执' } },
      });
      await client.call(route, 'POST', body, 409);
      const fresh = await client.call(route);
      const valid = { ...body, fingerprint: fresh.review.fingerprint };
      await db.run.update({ where: { id: run.id }, data: { cleanupStatus: 'FAILED' } });
      await client.call(route, 'POST', valid, 409);
      await db.run.update({
        where: { id: run.id },
        data: { cleanupStatus: 'NOT_CONFIGURED', status: 'RUNNING', heartbeatAt: new Date() },
      });
      await client.call(route, 'POST', valid, 409);
      await db.run.update({ where: { id: run.id }, data: { status: 'ERROR' } });
      await Promise.all([client.call(route, 'POST', valid), client.call(route, 'POST', valid)]);
      const afterFirst = await client.call(route);
      assert.equal(afterFirst.records.length, 1, '重复核对不重复记账');
      assert.deepEqual(
        afterFirst.review.pendingCases.map((c: any) => c.id),
        [c1.id],
        '核对另一条不能释放当前用例',
      );

      const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
      await context.addCookies([
        {
          name: 'uiagent_session',
          value: client.cookie.split('=')[1],
          domain: new URL(config.WEB_ORIGIN).hostname,
          path: '/',
          httpOnly: true,
        },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${site.id}&cases=${c1.id},${c2.id}`);
      await page.waitForSelector('.library-case');
      agent = new PlaywrightAgent(page, {
        modelConfig: midsceneModelConfig(),
        generateReport: false,
        persistExecutionDump: false,
        autoPrintReportMsg: false,
      });
      await agent.aiTap('运行所选 2 条按钮');
      await page.waitForSelector('.run-start-error');
      assert.match(await page.locator('.run-start-error').innerText(), /核对上次结果/);
      await agent.aiTap('取消选择此用例按钮');
      assert.match(await page.locator('.library-execution').innerText(), /已选 1 条/);
      await agent.aiTap('登录恢复用例 左边的复选框');
      await agent.aiTap('运行所选 2 条按钮');
      await agent.aiTap('核对上次结果按钮');
      await page.waitForSelector('.outcome-review-dialog textarea');
      assert.equal(
        await page
          .locator('.outcome-review-dialog button[type=submit], .outcome-review-dialog button')
          .filter({ hasText: '保存核对结果' })
          .isDisabled(),
        false,
      );
      await agent.aiTap('保存核对结果按钮');
      assert.match(await page.locator('#review-note-error').innerText(), /请填写核对说明/);
      assert.equal(
        await page.locator('.outcome-review-dialog textarea').evaluate((e) => e === document.activeElement),
        true,
      );
      await agent.aiInput('核对说明输入框', { value: 'xx' });
      await agent.aiTap('保存核对结果按钮');
      assert.match(await page.locator('#review-confirmation-error').innerText(), /请勾选确认/);
      assert.equal((await client.call(route)).records.length, 1, '未勾选时不会提交短说明');
      await agent.aiTap('核对对话框中的取消按钮');
      assert.equal((await client.call(route)).records.length, 1);
      await agent.aiTap('编辑此用例按钮');
      await agent.aiAct('在右侧编辑抽屉中找到并点击“改为仅验证已保存身份”按钮', { deepThink: true });
      await agent.aiAct('在右侧编辑抽屉向下滚动，点击保存用例', { deepThink: true });
      await poll(async () => !(await page.$('dialog[open]')));
      const saved = (await client.call(`/websites/${site.id}/features`))[0].cases.find(
        (c: any) => c.id === c1.id,
      );
      assert.equal(saved.revision, 2);
      assert.equal(saved.content.verifySessionOnly, true);
      assert.equal(saved.content.steps.length, 0);
      assert.equal((await client.call(route)).retry.allowed, false, '编辑用例不会隐式核对旧运行');
      await agent.aiAct('滚动到执行提示，点击核对上次结果', { deepThink: true });
      await agent.aiInput('核对说明输入框', {
        value: 'xx',
      });
      await agent.aiTap('我已核对被测网站，确认此用例可以重新测试 复选框');
      await fs.mkdir('.runtime/screenshots', { recursive: true });
      await page.screenshot({ path: '.runtime/screenshots/outcome-review-confirm.png', fullPage: true });
      await agent.aiTap('保存核对结果按钮');
      await poll(async () => !(await page.$('dialog[open]')));
      const reviewed = await client.call(route);
      assert.equal(reviewed.retry.allowed, true);
      assert.equal(reviewed.records.length, 2);
      assert.equal(reviewed.records.find((r: any) => r.caseId === c1.id).note, 'xx', '两字符说明可保存');
      assert.deepEqual((await client.call(`/runs/${run.id}`)).summary, originalSummary);
      await agent.aiTap('运行所选 2 条按钮');
      await poll(async () => page.url().includes('#/runs/'));
      const newId = page.url().split('#/runs/')[1].split('?')[0];
      runIds.push(newId);
      const done = await client.finished(newId);
      assert.deepEqual(
        done.summary.map((s: any) => s.result),
        ['PASS', 'PASS'],
      );
      assert.equal(done.manifest.plan.cases.find((c: any) => c.id === c1.id).browser.revision, 2);
      assert.ok(done.usage.visionCalls > 0);
      assert.deepEqual(errors, []);
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${run.id}`);
      await poll(async () =>
        (await page.locator('.outcome-review-record').allTextContents()).some((t) => t.includes('xx')),
      );
      assert.match(await page.locator('body').innerText(), /人工核对记录/);
      await page.screenshot({ path: '.runtime/screenshots/outcome-review-history.png', fullPage: true });
      // An old approval must never unlock a later uncertain execution.
      await db.run.update({
        where: { id: newId },
        data: {
          summary: json(
            done.summary.map((s: any) => (s.caseId === c1.id ? { ...s, result: 'INCONCLUSIVE' } : s)),
          ),
        },
      });
      await db.action.create({
        data: {
          id: randomUUID(),
          runId: newId,
          caseId: c1.id,
          tool: 'midscene.ui',
          leaseEpoch: 1,
          status: 'UNKNOWN_OUTCOME',
          input: { phase: 'case', write: true },
          output: { writeAttempted: true },
          finishedAt: new Date(),
        },
      });
      assert.equal((await client.call(`/runs/${newId}`)).retry.allowed, false);
      // Restore only this fixture's synthetic fault; the real PASS run is retained.
      await db.action.deleteMany({ where: { runId: newId, status: 'UNKNOWN_OUTCOME' } });
      await db.run.update({ where: { id: newId }, data: { summary: json(done.summary) } });
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/outcome-review.json',
        JSON.stringify(
          {
            at: new Date().toISOString(),
            siteId: site.id,
            historicalRunId: run.id,
            newRunId: newId,
            results: done.summary.map((s: any) => s.result),
            auditRecords: 2,
            caseRevision: 2,
            cancelledReviewSavedNothing: true,
            shortNoteAccepted: true,
            emptyNoteBlocked: true,
            uncheckedConfirmationBlocked: true,
            caseScoped: true,
            changedTraceRejected: true,
            laterRunStillProtected: true,
            originalSummaryPreserved: true,
            pageErrors: errors,
            modelCalls: agent.metrics.calls,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const id of runIds) {
        const run = await client.call(`/runs/${id}`);
        if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status)) {
          await client.call(`/runs/${id}/cancel`, 'POST');
          await client.finished(id);
        }
      }
      await agent?.destroy();
      await browser.close();
      await client.call(`/websites/${site.id}`, 'PATCH', { ...site, enabled: false });
      await db.session.deleteMany({ where: { userId: outsider.id } });
      await db.user.delete({ where: { id: outsider.id } });
      await fixture.close();
    }
  },
);
test.after(async () => {
  await db.$disconnect();
});
