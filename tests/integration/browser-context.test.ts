import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { browserEngine } from '../../packages/executor/src/launch.ts';
import { guardedPage } from '../../packages/executor/src/browser.ts';

test('Playwright 三浏览器：会话隔离、只读探索、跨域请求与重定向阻断', { timeout: 120000 }, async () => {
  let escaped = 0,
    writes = 0;
  const other = createServer((_q, r) => {
    escaped++;
    r.end('outside');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const outside = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  const server = createServer((q, r) => {
    if (q.method === 'POST') writes++;
    if (q.url === '/redirect') {
      r.writeHead(302, { location: outside });
      r.end();
      return;
    }
    r.setHeader('content-type', 'text/html');
    r.end('<html><title>Browser guard fixture</title><h1>Ready</h1></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const browserName of ['chrome', 'edge', 'firefox'] as const) {
      const browser = await browserEngine({ browserName });
      try {
        const first = await guardedPage(browser, origin, [origin]);
        const second = await guardedPage(browser, origin, [origin]);
        await first.context.addCookies([
          { name: 'test_session', value: 'isolated', domain: '127.0.0.1', path: '/' },
        ]);
        assert.equal((await second.context.cookies()).length, 0);
        await first.page.goto(origin);
        first.readOnly.enabled = true;
        assert.equal(
          await first.page.evaluate(() =>
            fetch('/write', { method: 'POST' }).then(
              () => false,
              () => true,
            ),
          ),
          true,
        );
        assert.equal(first.readOnly.blocked, 1);
        assert.equal(writes, 0);
        assert.equal(
          await first.page.evaluate(
            (url) =>
              fetch(url).then(
                () => false,
                () => true,
              ),
            outside,
          ),
          true,
        );
        await first.page.goto(origin + '/redirect').catch(() => {});
        assert.throws(first.check);
        assert.equal(escaped, 0, `${browserName}: out-of-scope server must receive zero requests`);
        assert.ok((await second.page.screenshot()).byteLength > 0);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await Promise.all([server, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
});
