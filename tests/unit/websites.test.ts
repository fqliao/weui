import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../../packages/websites/src/vault.ts';
import {
  webUrl,
  normalizeOrigins,
  assertAllowedUrl,
  validateStorage,
} from '../../packages/websites/src/policy.ts';
import { webCaseSchema, storageStateSchema } from '../../packages/contracts/src/browser.ts';
import { expandRun } from '../../packages/executor/src/web-case.ts';
test('凭证按网站加密，篡改密文和跨网站解密均失败', () => {
  const secret = { password: 'never-return-this' },
    v = encryptSecret(secret, 'site-a');
  assert.ok(!v.includes(secret.password));
  assert.deepEqual(decryptSecret(v, 'site-a'), secret);
  assert.throws(() => decryptSecret(v, 'site-b'));
  assert.throws(() => decryptSecret('x' + v, 'site-a'));
});
test('限制 HTTP 网站、账号 URL、控制面和跳转范围', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'http://127.0.0.1:3101/health',
    'http://169.254.169.254/',
  ])
    assert.throws(() => webUrl(url));
  assert.equal(webUrl('http://192.168.0.2:8080').origin, 'http://192.168.0.2:8080');
  const origins = normalizeOrigins('https://test.example.com', ['https://sso.example.com/login']);
  assert.equal(assertAllowedUrl('/app', 'https://test.example.com', origins), 'https://test.example.com/app');
  assert.throws(() => assertAllowedUrl('https://evil.test', 'https://test.example.com', origins));
});
test('会话拒绝宽泛 Cookie、过期 Cookie 和其他网站 localStorage', () => {
  const mk = (domain: string, expires = -1) =>
    storageStateSchema.parse({ cookies: [{ name: 's', value: 't', domain, expires }] });
  validateStorage(mk('test.example.com'), ['https://test.example.com']);
  assert.throws(() => validateStorage(mk('.example.com'), ['https://test.example.com']));
  assert.throws(() => validateStorage(mk('test.example.com', 1), ['https://test.example.com']));
  assert.throws(() =>
    validateStorage({ cookies: [], origins: [{ origin: 'https://elsewhere.test', localStorage: [] }] }, [
      'https://test.example.com',
    ]),
  );
});
test('用例必须有预期，不接受脚本操作，运行变量只替换固定占位符', () => {
  assert.throws(() => webCaseSchema.parse({ title: '没有预期', steps: [], assertions: [] }));
  assert.throws(() =>
    webCaseSchema.parse({
      title: '脚本执行',
      steps: [{ kind: 'javascript', text: 'x' }],
      assertions: ['正常'],
    }),
  );
  assert.equal(expandRun('{{runId}}/{{caseId}}/{{password}}', 'r', 'c'), 'r/c/{{password}}');
});
