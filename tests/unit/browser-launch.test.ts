import test from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { browserEngine, type BrowserLaunchEvent } from '../../packages/executor/src/launch.ts';
import { AppError } from '../../packages/config/src/index.ts';
const base = { executablePath: '/test/browser', exists: () => true, wait: async () => {} };

test('默认选择 Chrome，Edge 和 Firefox 保留明确的浏览器身份', async () => {
  for (const name of [undefined, 'edge', 'firefox'] as const) {
    const events: BrowserLaunchEvent[] = [];
    await browserEngine(
      {
        browserName: name,
        onEvent: async (e) => {
          events.push(e);
        },
      },
      {
        ...base,
        launch: async (options) => {
          assert.equal(options.executablePath, '/test/browser');
          assert.equal(options.headless, true);
          return { version: () => '155.0', close: async () => {} } as unknown as Browser;
        },
      },
    );
    assert.ok(events.every((e) => e.browserName === (name ?? 'chrome') && e.engine === 'playwright'));
  }
});

test('Edge 缺失不能回退到已有 Chrome；拒绝未支持的浏览器名称', async () => {
  const checked: string[] = [];
  await assert.rejects(
    () =>
      browserEngine(
        { browserName: 'edge' },
        {
          exists: (path) => {
            checked.push(path);
            return /chrome\.exe$/.test(path);
          },
        },
      ),
    (error: unknown) => error instanceof AppError && error.code === 'BROWSER_MISSING',
  );
  assert.ok(checked.every((path) => !/Google\/Chrome/.test(path)));
  await assert.rejects(() => browserEngine({ browserName: 'safari' as never }));
});
test('启动瞬时失败后只重试浏览器，保存失败和就绪事件', async () => {
  let attempts = 0;
  const events: BrowserLaunchEvent[] = [];
  const b = { version: () => 'Test/1', close: async () => {} } as unknown as Browser;
  const result = await browserEngine(
    {
      onEvent: async (e) => {
        events.push(e);
      },
    },
    {
      ...base,
      launch: async () => {
        if (++attempts === 1) throw new Error('process exited');
        return b;
      },
    },
  );
  assert.equal(result, b);
  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ['browser.launching', 'browser.launch.failed', 'browser.launching', 'browser.ready'],
  );
  assert.equal(events[1].retrying, true);
  assert.equal(events[3].version, 'Test/1');
});
test('连续启动失败有明确错误码，最多两次且不进入 UI 执行', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      browserEngine(
        {},
        {
          ...base,
          launch: async () => {
            attempts++;
            throw new Error('process exited');
          },
        },
      ),
    (e: unknown) => e instanceof AppError && e.code === 'BROWSER_LAUNCH_FAILED',
  );
  assert.equal(attempts, 2);
});
test('指定浏览器路径无效时拒绝执行，不静默换浏览器', async () => {
  const checked: string[] = [];
  await assert.rejects(
    () =>
      browserEngine(
        {},
        {
          ...base,
          exists: (p) => {
            checked.push(p);
            return p !== '/test/browser';
          },
          launch: async () => {
            throw new Error('must not launch');
          },
        },
      ),
    (e: unknown) => e instanceof AppError && e.code === 'BROWSER_MISSING',
  );
  assert.deepEqual(checked, ['/test/browser']);
});
test('启动期间取消会关闭刚创建的浏览器，不发出就绪事件', async () => {
  const controller = new AbortController();
  let closed = 0;
  const events: BrowserLaunchEvent[] = [];
  const reason = new AppError('CANCELLED', 'cancel');
  await assert.rejects(
    () =>
      browserEngine(
        {
          signal: controller.signal,
          onEvent: async (e) => {
            events.push(e);
          },
        },
        {
          ...base,
          launch: async () => {
            controller.abort(reason);
            return {
              version: () => 'Test/1',
              close: async () => {
                closed++;
              },
            } as unknown as Browser;
          },
        },
      ),
    (e) => e === reason,
  );
  assert.equal(closed, 1);
  assert.ok(!events.some((e) => e.type === 'browser.ready'));
});
