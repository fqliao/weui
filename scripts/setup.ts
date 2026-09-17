import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = process.cwd();
await fs.mkdir(path.join(root, '.runtime'), { recursive: true });
try {
  await fs.access('.env');
} catch {
  const example = await fs.readFile('.env.example', 'utf8');
  const dbPass = randomBytes(18).toString('hex'),
    adminPass = randomBytes(12).toString('base64url'),
    testerPass = randomBytes(12).toString('base64url');
  const text = example
    .replace('uiagent:CHANGE_ME', 'uiagent:' + dbPass)
    .replace('REPLACE_WITH_RANDOM_32_BYTES', randomBytes(32).toString('hex'))
    .replace('REPLACE_WITH_RANDOM_32_BYTES', randomBytes(32).toString('hex'))
    .replace('REPLACE_WITH_STRONG_PASSWORD', adminPass)
    .replace('REPLACE_WITH_STRONG_PASSWORD', testerPass)
    .replace('AGENT_MODE=catalog', `AGENT_MODE=${process.env.DEEPSEEK_API_KEY ? 'deepagents' : 'catalog'}`);
  await fs.writeFile('.env', text, { mode: 0o600 });
  await fs.writeFile(
    '.runtime/access.local.md',
    `# 本机体验账号（勿提交）\n\n地址：http://localhost:3100\n\n管理员：admin@uiagent.local\n密码：${adminPass}\n\n测试人员：tester@uiagent.local\n密码：${testerPass}\n`,
    { mode: 0o600 },
  );
  console.log('已生成 .env 与 .runtime/access.local.md；未在日志输出凭证。');
}
const { config } = await import('../packages/config/src/index.ts');
function command(exe: string, args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(exe, args, {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} exit ${code}`)),
    );
  });
}
if (process.platform === 'win32') {
  const bin = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/17/bin';
  const data = path.join(root, '.runtime/postgres');
  const url = new URL(config.DATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '55432')
    throw new Error('本地 setup 只管理 127.0.0.1:55432。外部数据库请用 db:migrate/db:seed。');
  try {
    await fs.access(path.join(data, 'PG_VERSION'));
  } catch {
    const pw = path.join(root, '.runtime/pg-init-password');
    await fs.writeFile(pw, decodeURIComponent(url.password), { mode: 0o600 });
    try {
      await command(path.join(bin, 'initdb.exe'), [
        '-D',
        data,
        '-U',
        url.username,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
        `--pwfile=${pw}`,
      ]);
    } finally {
      await fs.unlink(pw);
    }
  }
  const { Client } = await import('pg');
  const { portOpen } = await import('./windows-redis.ts');
  let alive = await portOpen(55432);
  const check = new Client({
    connectionString: config.DATABASE_URL.replace(/\/uiagent$/, '/postgres'),
    connectionTimeoutMillis: 15000,
  });
  if (alive)
    try {
      await check.connect();
    } finally {
      await check.end().catch(() => {});
    }
  if (!alive)
    await command(path.join(bin, 'pg_ctl.exe'), [
      '-D',
      data,
      '-l',
      path.join(root, '.runtime/postgres.log'),
      '-o',
      '-p 55432 -h 127.0.0.1',
      'start',
    ]);
  const client = new Client({ connectionString: config.DATABASE_URL.replace(/\/uiagent$/, '/postgres') });
  await client.connect();
  if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='uiagent'")).rowCount)
    await client.query('CREATE DATABASE uiagent');
  await client.end();
  const { startRedis } = await import('./windows-redis.ts');
  await startRedis();
} else {
  console.log('请先启动 PostgreSQL 和 Redis（deploy/compose.yaml）。');
}
console.log('基础服务准备完成。下一步：pnpm db:generate && pnpm db:migrate && pnpm db:seed');
