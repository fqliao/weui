import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheChannel, type CaseExecutionCache } from '../../packages/executor/src/execution-cache.ts';
import { browserEngine, midsceneModelConfig } from '../../packages/executor/src/browser.ts';
import { MidsceneBrowserAgent } from '../../packages/executor/src/midscene-agent.ts';
import { config } from '../../packages/config/src/index.ts';
import { recordCommand } from '../../packages/executor/src/static-replay.ts';

test(
  'identical prompts keep separate native SDK cursors when earlier steps use L2',
  { skip: !config.visionReady },
  async () => {
    const browser = await browserEngine();
    try {
      const page = await browser.newPage();
      const agent = new MidsceneBrowserAgent(page, {
        modelConfig: midsceneModelConfig(),
        cache: {
          id: 'cache-isolation-test',
          strategy: 'read-only',
          cacheDir: '.runtime/cache-isolation-bootstrap',
        },
        generateReport: false,
        persistExecutionDump: false,
      });
      try {
        const native = (xpath: string) => ({
          midsceneVersion: '1.12.6' as const,
          cacheId: 'isolation',
          caches: [{ type: 'locate', prompt: '提交按钮', cache: { xpaths: [xpath] } }],
        });
        const owner = { stats: { mode: 'l2' }, bypassReason: undefined } as CaseExecutionCache;
        const channel = new CacheChannel(owner, 'case', page, {
          operations: [],
          nativeByOperation: { first: native('//*[@id="first"]'), second: native('//*[@id="second"]') },
        });
        channel.bind(agent);
        const ref = agent.taskCache!;
        channel.beginOperation('second'); // first operation was handled entirely by L2
        assert.deepEqual(ref.matchLocateCache('提交按钮')?.cacheContent.cache?.xpaths, ['//*[@id="second"]']);
        assert.equal(
          ref.matchLocateCache('提交按钮'),
          undefined,
          'SDK still consumes a native entry once within its operation',
        );
        channel.finishOperation('second');
        channel.beginOperation('first');
        assert.equal(agent.taskCache, ref, 'Executor keeps the original cache object reference');
        assert.deepEqual(ref.matchLocateCache('提交按钮')?.cacheContent.cache?.xpaths, ['//*[@id="first"]']);
        channel.clearNative();
        assert.equal(ref.matchLocateCache('提交按钮'), undefined);
        channel.beginOperation('second');
        assert.deepEqual(ref.matchLocateCache('提交按钮')?.cacheContent.cache?.xpaths, ['//*[@id="second"]']);
        assert.equal(agent.metrics.calls, 0);
        await page.setContent(
          '<div id="host" style="display:block;width:300px;height:150px"></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML="<input placeholder=shadow-input>"</script>',
        );
        const center = await page.locator('#host').evaluate((el) => {
          const r = el.shadowRoot!.querySelector('input')!.getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2];
        });
        assert.equal(
          await recordCommand(page, 'Input', { value: 'test', locate: { center } }, true),
          null,
          'An open Shadow DOM host cannot be used as a static input target',
        );
      } finally {
        await agent.destroy();
      }
    } finally {
      await browser.close();
    }
  },
);
