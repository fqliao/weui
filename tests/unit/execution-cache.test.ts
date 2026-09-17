import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { RunManifest, CaseSpec } from '../../packages/contracts/src/index.ts';
import { cacheKey } from '../../packages/executor/src/execution-cache.ts';
import { fingerprint, replayCommands } from '../../packages/executor/src/static-replay.ts';
test('cache identity isolates website, case, credentials, engine and model; execution mode does not invalidate artifacts', () => {
  const manifest = {
    projectId: 'p',
    environmentId: 'e',
    environment: {
      baseUrl: 'https://test.example',
      adapter: 'midscene-web-v1',
      credentialRef: '',
      config: {},
    },
    plan: { environmentRevision: 1 },
    browser: { name: 'chrome', engine: 'playwright' },
    models: { vision: { model: 'vision-v1' } },
    executionMode: 'l2',
  } as unknown as RunManifest;
  const spec = {
    id: 'c',
    browser: { revision: 1, sessionId: 's', sessionRevision: 1, assertions: ['保存成功'] },
  } as unknown as CaseSpec;
  const key = cacheKey({ manifest }, spec, '1');
  assert.equal(cacheKey({ manifest: { ...manifest, executionMode: 'realtime' } }, spec, '1'), key);
  assert.notEqual(cacheKey({ manifest: { ...manifest, projectId: 'other' } }, spec, '1'), key);
  assert.notEqual(cacheKey({ manifest: { ...manifest, environmentId: 'other' } }, spec, '1'), key);
  assert.notEqual(
    cacheKey({ manifest }, { ...spec, browser: { ...spec.browser!, sessionRevision: 2 } }, '1'),
    key,
  );
  assert.notEqual(cacheKey({ manifest }, { ...spec, browser: { ...spec.browser!, revision: 2 } }, '1'), key);
  assert.notEqual(
    cacheKey({ manifest: { ...manifest, browser: { name: 'firefox', engine: 'playwright' } } }, spec, '1'),
    key,
  );
  assert.notEqual(cacheKey({ manifest }, spec, '2'), key);
});
test('legacy fingerprint-only commands cannot dispatch writes under the new policy', async () => {
  let state = 'initial',
    writes = 0;
  const target = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      writes++;
      state = 'changed';
    },
  };
  const page = {
    url: () => 'https://test.example',
    evaluate: async () => state,
    screenshot: async () => Buffer.from(state),
    locator: () => target,
  } as unknown as Page;
  const before = await fingerprint(page);
  assert.equal(
    await replayCommands(
      page,
      [
        { kind: 'Tap', selector: '#a', before },
        { kind: 'Tap', selector: '#b', before },
      ],
      undefined,
      async () => {},
    ),
    false,
  );
  assert.equal(writes, 0);
});
