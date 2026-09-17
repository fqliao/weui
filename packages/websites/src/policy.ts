import { AppError, config } from '../../config/src/index.ts';
import type { StorageState } from '../../contracts/src/browser.ts';
export const WEB_ADAPTER = 'midscene-web-v1';
export function webUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AppError('URL', '请输入有效的网站 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new AppError('URL', '只支持不包含账号密码的 HTTP(S) 地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['169.254.169.254', 'metadata.google.internal'].includes(host))
    throw new AppError('URL', '不支持此目标地址');
  // The browser must never expose the platform's own control plane to the tested page.
  if (
    ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) &&
    [String(config.API_PORT), String(config.WEB_PORT), '55432', '56379'].includes(url.port)
  )
    throw new AppError('URL', '被测网站不能使用工作台、API 或基础服务地址');
  return url;
}
export function normalizeOrigins(baseUrl: string, extra: string[]): string[] {
  return [...new Set([webUrl(baseUrl).origin, ...extra.map((v) => webUrl(v).origin)])];
}
export function assertAllowedUrl(value: string, baseUrl: string, origins: string[]): string {
  const u = webUrl(value, baseUrl);
  if (!origins.includes(u.origin)) throw new AppError('TARGET_DENIED', '目标不在此网站允许的域名范围内');
  return u.toString();
}
export function validateStorage(state: StorageState, origins: string[]) {
  const hosts = origins.map((o) => new URL(o).hostname);
  for (const c of state.cookies) {
    const domain = c.domain.replace(/^\./, '');
    // Broad parent-domain cookies are deliberately not accepted. Add exact-host cookies instead.
    if (!hosts.includes(domain))
      throw new AppError('SESSION_SCOPE', 'Cookie 域名必须与网站允许的主机完全匹配');
    if (c.expires > 0 && c.expires * 1000 <= Date.now())
      throw new AppError('SESSION_EXPIRED', '导入的 Cookie 已过期');
  }
  for (const o of state.origins)
    if (!origins.includes(webUrl(o.origin).origin))
      throw new AppError('SESSION_SCOPE', '登录状态包含其他网站的数据');
}
