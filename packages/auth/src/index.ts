import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/src/index.ts';
import { AppError, config, hash } from '../../config/src/index.ts';
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const b = Buffer.from(key, 'hex');
  const a = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function identity(req: FastifyRequest) {
  const token = req.cookies.uiagent_session;
  if (!token) throw new AppError('UNAUTHENTICATED', '请先登录', 401);
  const row = await db.session.findUnique({ where: { id: hash(token) }, include: { user: true } });
  if (!row || row.expiresAt < new Date() || !row.user.enabled)
    throw new AppError('UNAUTHENTICATED', '登录已失效，请重新登录', 401);
  return { id: row.user.id, name: row.user.name, email: row.user.email, role: row.user.role };
}
export type Identity = Awaited<ReturnType<typeof identity>>;
export async function projectAccess(user: Identity, projectId: string) {
  const m = await db.membership.findUnique({ where: { userId_projectId: { userId: user.id, projectId } } });
  if (!m) throw new AppError('FORBIDDEN', '无权访问此项目', 403);
}
export function admin(user: Identity) {
  if (user.role !== 'ADMIN') throw new AppError('FORBIDDEN', '此操作需要管理员权限', 403);
}
export async function createSession(reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString('hex');
  await db.session.create({
    data: { id: hash(token), userId, expiresAt: new Date(Date.now() + 8 * 3600000) },
  });
  reply.setCookie('uiagent_session', token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 3600,
  });
}
export function sameOrigin(req: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && !new Set([config.WEB_ORIGIN, config.API_ORIGIN]).has(origin))
    throw new AppError('ORIGIN_DENIED', '请求来源不被允许', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new AppError('ORIGIN_DENIED', '拒绝跨站修改请求', 403);
  if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json'))
    throw new AppError('CONTENT_TYPE', '仅接受 JSON 修改请求', 415);
}
