import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config, AppError } from '../../config/src/index.ts';
const key = () =>
  createHash('sha256')
    .update('tracelab-login-v1:' + config.SESSION_SECRET)
    .digest();
export function encryptSecret(value: unknown, scope: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64url')).join('.');
}
export function decryptSecret(value: string, scope: string): unknown {
  try {
    const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  } catch {
    throw new AppError('SESSION_SECRET', '登录凭证无法解密，请重新保存登录配置');
  }
}
