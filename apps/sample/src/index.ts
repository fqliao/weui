import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, json } from '../../../packages/db/src/index.ts';
import { config, AppError, publicError } from '../../../packages/config/src/index.ts';
import { samplePage } from './page.ts';
const app = Fastify({ logger: false });
await app.register(cookie);
const namespaceSchema = z.string().regex(/^[a-zA-Z0-9-]{8,100}$/);
type Claims = { namespace: string; role: string; tenant: string; actor: string; exp: number };
function sign(claims: Claims) {
  const raw = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${raw}.${createHmac('sha256', config.SAMPLE_SERVICE_KEY).update(raw).digest('base64url')}`;
}
function read(token?: string): Claims {
  if (!token) throw new AppError('AUTH', '未登录样例系统', 401);
  const [raw, mac] = token.split('.');
  const expected = createHmac('sha256', config.SAMPLE_SERVICE_KEY)
    .update(raw ?? '')
    .digest('base64url');
  if (!mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
    throw new AppError('AUTH', '会话无效', 401);
  const claims = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Claims;
  if (claims.exp < Date.now()) throw new AppError('AUTH', '会话已过期', 401);
  return claims;
}
function service(key: unknown) {
  if (
    typeof key !== 'string' ||
    key.length !== config.SAMPLE_SERVICE_KEY.length ||
    !timingSafeEqual(Buffer.from(key), Buffer.from(config.SAMPLE_SERVICE_KEY))
  )
    throw new AppError('AUTH', '需要测试服务凭证', 401);
}
async function fixture(namespace: string) {
  return (await db.setting.findUnique({ where: { key: `fixture:${namespace}` } }))?.value as
    | { fault?: string; delayMs?: number }
    | undefined;
}
app.setErrorHandler((e, _q, r) => {
  const error = e as Error;
  if (e instanceof AppError) return r.code(e.status).send({ error: e.code, message: e.message });
  if (e instanceof z.ZodError) return r.code(400).send({ message: '输入格式不正确' });
  console.error('sample', publicError(error));
  return r.code(500).send({ message: '样例系统内部错误' });
});
app.get('/health', async () => {
  await db.$queryRaw`SELECT 1`;
  return { ok: true, service: 'independent-sample-approval', sample: true };
});
app.get('/', async (_q, r) => r.type('text/html').send(samplePage));
app.post('/internal/login', async (q, r) => {
  service(q.headers['x-service-key']);
  const body = z
    .object({
      namespace: namespaceSchema,
      role: z.enum(['applicant', 'reviewer']),
      tenant: z.enum(['A', 'B']).default('A'),
      actor: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
    })
    .parse(q.body);
  r.setCookie(
    'sample_session',
    sign({ ...body, actor: body.actor ?? body.role, exp: Date.now() + 3600000 }),
    { httpOnly: true, sameSite: 'lax', path: '/' },
  );
  return { ok: true };
});
app.post('/internal/fixtures', async (q) => {
  service(q.headers['x-service-key']);
  const b = z
    .object({
      namespace: namespaceSchema,
      caseId: z.string(),
      fault: z.string().default('none'),
      delayMs: z.number().min(0).max(15000).default(0),
    })
    .parse(q.body);
  if (await db.setting.findUnique({ where: { key: `fixture:${b.namespace}` } }))
    throw new AppError('DUPLICATE', '此命名空间已被使用', 409);
  await db.setting.create({
    data: { key: `fixture:${b.namespace}`, value: json({ fault: b.fault, delayMs: b.delayMs }) },
  });
  let record = null;
  if (['C09', 'C10', 'C12'].includes(b.caseId))
    record = await db.sampleRecord.create({
      data: {
        namespace: b.namespace,
        tenant: 'A',
        title: '受控前置申请',
        amount: 100,
        applicant: b.caseId === 'C10' ? 'reviewer' : 'someone-else',
        status: 'PENDING',
        submitCount: 1,
      },
    });
  return { record };
});
app.get('/internal/observations', async (q) => {
  service(q.headers['x-service-key']);
  const namespace = namespaceSchema.parse((q.query as { namespace: string }).namespace);
  if ((await fixture(namespace))?.fault === 'query-unavailable')
    throw new AppError('DEPENDENCY', '结果查询依赖不可用', 503);
  return {
    records: await db.sampleRecord.findMany({ where: { namespace }, orderBy: { createdAt: 'asc' } }),
    audit: await db.sampleAudit.findMany({ where: { namespace }, orderBy: { createdAt: 'asc' } }),
  };
});
app.delete('/internal/fixtures/:namespace', async (q) => {
  service(q.headers['x-service-key']);
  const namespace = namespaceSchema.parse((q.params as { namespace: string }).namespace);
  if ((await fixture(namespace))?.fault === 'cleanup-failure')
    throw new AppError('DEPENDENCY', '模拟清理失败', 503);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT key FROM "Setting" WHERE key=${`fixture:${namespace}`} FOR UPDATE`;
    await tx.sampleAudit.deleteMany({ where: { namespace } });
    await tx.sampleRecord.deleteMany({ where: { namespace } });
    await tx.setting.deleteMany({ where: { key: `fixture:${namespace}` } });
  });
  return { ok: true };
});
app.get('/business/me', async (q) => read(q.cookies.sample_session));
app.get('/business/records', async (q) => {
  const u = read(q.cookies.sample_session);
  return db.sampleRecord.findMany({ where: { namespace: u.namespace, tenant: u.tenant } });
});
app.get('/business/records/:id', async (q) => {
  const u = read(q.cookies.sample_session);
  const record = await db.sampleRecord.findFirst({
    where: { id: (q.params as { id: string }).id, namespace: u.namespace },
  });
  if (!record) throw new AppError('NOT_FOUND', '申请不存在', 404);
  if (record.tenant !== u.tenant && (await fixture(u.namespace))?.fault !== 'permission-bypass')
    throw new AppError('DENIED', '无权访问此租户的申请', 403);
  return record;
});
app.post('/business/records', async (q) => {
  const u = read(q.cookies.sample_session);
  const f = await fixture(u.namespace);
  if (f?.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
  const body = z.object({ title: z.string(), amount: z.number() }).parse(q.body),
    title = body.title.trim();
  if ((!title || title.length > 200) && f?.fault !== 'validation-bypass')
    throw new AppError('VALIDATION', '标题长度必须为 1-200 字符');
  if (
    (!Number.isInteger(body.amount) || body.amount < 1 || body.amount > 1000000) &&
    f?.fault !== 'validation-bypass'
  )
    throw new AppError('VALIDATION', '金额必须为 1-1000000 的整数');
  if (f?.fault === 'fake-success')
    return {
      id: randomUUID(),
      namespace: u.namespace,
      tenant: u.tenant,
      title,
      amount: body.amount,
      applicant: u.actor,
      status: 'DRAFT',
      submitCount: 0,
    };
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT key FROM "Setting" WHERE key=${`fixture:${u.namespace}`} FOR UPDATE`;
    if (!(await tx.setting.findUnique({ where: { key: `fixture:${u.namespace}` } })))
      throw new AppError('SCOPE_CLOSED', '运行命名空间已清理，拒绝迟到写入', 409);
    return tx.sampleRecord.create({
      data: { namespace: u.namespace, tenant: u.tenant, title, amount: body.amount, applicant: u.actor },
    });
  });
});
app.post('/business/records/:id/:action', async (q) => {
  const u = read(q.cookies.sample_session);
  const { id, action } = q.params as { id: string; action: string };
  if (!['submit', 'approve', 'reject'].includes(action)) throw new AppError('ACTION', '未知动作');
  const f = await fixture(u.namespace);
  if (f?.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
  const key = z.string().min(8).max(150).parse(q.headers['idempotency-key']);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT key FROM "Setting" WHERE key=${`fixture:${u.namespace}`} FOR UPDATE`;
    if (!(await tx.setting.findUnique({ where: { key: `fixture:${u.namespace}` } })))
      throw new AppError('SCOPE_CLOSED', '运行命名空间已清理', 409);
    await tx.$queryRaw`SELECT id FROM "SampleRecord" WHERE id=${id} FOR UPDATE`;
    const rec = await tx.sampleRecord.findFirst({ where: { id, namespace: u.namespace } });
    if (!rec) throw new AppError('NOT_FOUND', '申请不存在', 404);
    if (rec.tenant !== u.tenant && f?.fault !== 'permission-bypass')
      throw new AppError('DENIED', '无权访问此租户的申请', 403);
    const previous = await tx.sampleAudit.findUnique({ where: { idempotencyKey: key } });
    if (previous) {
      if (previous.recordId !== id || previous.namespace !== u.namespace)
        throw new AppError('IDEMPOTENCY', '幂等键冲突', 409);
      return rec;
    }
    let status = rec.status;
    if (action === 'submit') {
      if (rec.applicant !== u.actor && f?.fault !== 'permission-bypass')
        throw new AppError('DENIED', '只能提交自己的申请', 403);
      if (rec.status === 'PENDING' && f?.fault !== 'duplicate-submit') return rec;
      if (!['DRAFT', 'PENDING'].includes(rec.status)) throw new AppError('STATE', '当前状态不可提交', 409);
      status = 'PENDING';
    } else {
      if ((u.role !== 'reviewer' || rec.applicant === u.actor) && f?.fault !== 'permission-bypass')
        throw new AppError('DENIED', rec.applicant === u.actor ? '不能审批自己的申请' : '无审批权限', 403);
      if (rec.status !== 'PENDING') throw new AppError('STATE', '只有待审批申请可以审批', 409);
      status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    }
    if (f?.fault === 'fake-success') return { ...rec, status };
    const updated = await tx.sampleRecord.update({
      where: { id },
      data: {
        status: f?.fault === 'wrong-state' ? 'DRAFT' : status,
        ...(action === 'submit' ? { submitCount: { increment: 1 } } : { reviewer: u.actor }),
      },
    });
    await tx.sampleAudit.create({
      data: { namespace: u.namespace, recordId: id, action, actor: u.actor, idempotencyKey: key },
    });
    return updated;
  });
});
await app.listen({ host: '127.0.0.1', port: config.SAMPLE_PORT });
console.log(`Sample business http://127.0.0.1:${config.SAMPLE_PORT}`);
async function close() {
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
