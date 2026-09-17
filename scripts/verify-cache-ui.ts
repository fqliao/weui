import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client, poll } from '../tests/helpers.ts';
import { config } from '../packages/config/src/index.ts';
import { browserEngine, midsceneModelConfig } from '../packages/executor/src/browser.ts';
import { MidsceneBrowserAgent } from '../packages/executor/src/midscene-agent.ts';
import { db } from '../packages/db/src/index.ts';
import { artifactSchema } from '../packages/executor/src/execution-cache.ts';
import { decryptSecret } from '../packages/websites/src/vault.ts';

// Explicit existing case to exercise through the product UI. Never edits its assertions or login data.
const [siteId, caseId] = process.argv.slice(2);
assert.ok(siteId && caseId, 'Usage: pnpm exec tsx scripts/verify-cache-ui.ts <websiteId> <caseId>');
const client = new Client();
await client.login();
const browser = await browserEngine({ browserName: 'chrome' });
const output: any = { siteId, caseId, results: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
  await context.addCookies([
    {
      name: 'uiagent_session',
      value: client.cookie.slice(client.cookie.indexOf('=') + 1),
      domain: new URL(config.WEB_ORIGIN).hostname,
      path: '/',
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${siteId}&cases=${caseId}`);
  await page.locator('#cases-execution-mode').waitFor();
  const agent = new MidsceneBrowserAgent(page, {
    modelConfig: midsceneModelConfig(),
    generateReport: false,
    persistExecutionDump: false,
    replanningCycleLimit: 4,
  });
  const jsErrors: string[] = [];
  page.on('pageerror', (error) => jsErrors.push(error.message));
  await fs.mkdir('.runtime/verification', { recursive: true });
  try {
    await page.screenshot({ path: '.runtime/verification/cache-before-ui.png', fullPage: true });
    await agent.aiTap('执行方式下拉框（当前二级缓存优先）');
    await agent.aiKeyboardPress(undefined, { keyName: 'ArrowDown' });
    await agent.aiKeyboardPress(undefined, { keyName: 'Enter' });
    assert.equal(await page.locator('#cases-execution-mode').inputValue(), 'l1');
    await agent.aiTap('执行方式下拉框（当前一级缓存优先）');
    await agent.aiKeyboardPress(undefined, { keyName: 'ArrowDown' });
    await agent.aiKeyboardPress(undefined, { keyName: 'Enter' });
    assert.equal(await page.locator('#cases-execution-mode').inputValue(), 'realtime');
    await page.screenshot({ path: '.runtime/verification/cache-mode-ui.png', fullPage: true });
    const started = page.waitForResponse(
      (r) => r.url().endsWith('/api/case-runs') && r.request().method() === 'POST',
    );
    await agent.aiTap('运行所选 1 条按钮');
    const response = await started;
    assert.equal(response.status(), 200);
    assert.equal(response.request().postDataJSON().executionMode, 'realtime');
    const first = await response.json();
    for (let i = 0; i < 2; i++) {
      const run = await client.finished(i === 0 ? first.id : output.nextRunId);
      assert.equal(run.summary[0].result, 'PASS', run.summary[0].message);
      const stats = run.summary[0].execution;
      assert.equal(run.manifest.executionMode, i === 0 ? 'realtime' : 'l2');
      assert.equal(stats.published, true);
      if (i === 0) {
        assert.equal(stats.l2Hits, 0);
        assert.equal(stats.l1Hits, 0);
      } else assert.ok(stats.l2Hits > 0, 'Regression should reuse static operations');
      const result = {
        id: run.id,
        result: run.summary[0].result,
        mode: run.manifest.executionMode,
        execution: stats,
        calls: run.usage.visionCalls,
        tokens: run.usage.inputTokens + run.usage.outputTokens,
      };
      output.results.push(result);
      console.log(JSON.stringify(result));
      await page.goto(`${config.WEB_ORIGIN}/#/runs/${run.id}`);
      await page.locator('#regression-execution-mode').waitFor();
      await page.screenshot({ path: `.runtime/verification/cache-report-${i}.png`, fullPage: true });
      if (i === 0) {
        assert.equal(await page.locator('#regression-execution-mode').inputValue(), 'l2');
        const retried = page.waitForResponse(
          (r) => /\/api\/tasks\/[^/]+\/runs$/.test(r.url()) && r.request().method() === 'POST',
        );
        await agent.aiTap('一键回归按钮');
        const response = await retried;
        assert.equal(response.status(), 200);
        assert.equal(response.request().postDataJSON().executionMode, 'l2');
        output.nextRunId = (await response.json()).id;
      }
      const row = await db.executionCache.findUniqueOrThrow({ where: { id: stats.key } });
      const artifact = artifactSchema.parse(
        decryptSecret(row.encryptedArtifact, `execution-cache:${row.id}`),
      );
      const commands = artifact.channels.authentication?.operations.flatMap((op) => op.commands) ?? [];
      const inputs = commands.filter((c) => c.kind === 'Input');
      assert.ok(inputs.length >= 2, 'Both login fields should be learned');
      assert.ok(
        inputs.every((c) => c.runtimeInput && c.value === undefined),
        'Credentials must remain runtime inputs',
      );
      output.loginInputsUseRuntimeValues = true;
    }
    await page.goto(`${config.WEB_ORIGIN}/#/cases?website=${siteId}&cases=${caseId}`);
    await poll(async () => (await page.locator('.cache-ready').count()) >= 2, 30000);
    await page.screenshot({ path: '.runtime/verification/cache-badges-ui.png', fullPage: true });
    assert.deepEqual(jsErrors, []);
    output.passed = true;
    delete output.nextRunId;
    await fs.writeFile('.runtime/verification/execution-cache-ui.json', JSON.stringify(output, null, 2));
  } catch (error) {
    await page
      .screenshot({ path: '.runtime/verification/cache-error-ui.png', fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await agent.destroy();
  }
} finally {
  await browser.close();
  await db.$disconnect();
}
