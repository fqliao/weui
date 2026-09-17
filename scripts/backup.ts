import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { config } from '../packages/config/src/index.ts';
import { db } from '../packages/db/src/index.ts';
const running = await db.run.count({ where: { status: { in: ['RUNNING', 'CANCEL_REQUESTED'] } } });
const planning = await db.task.count({ where: { status: 'PLANNING' } });
if (running || planning) throw new Error('备份前请暂停新执行并等待正在运行或规划的任务结束。');
const root = path.resolve('.runtime/backups'),
  target = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(target, { recursive: true });
const binary = (name: string) =>
  process.platform === 'win32'
    ? path.join(process.env.PG_BIN || 'C:/Program Files/PostgreSQL/17/bin', name + '.exe')
    : name;
const url = new URL(config.DATABASE_URL),
  env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
const connectionArgs = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
async function command(name: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(binary(name), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (c) => (output += c));
    p.stderr.on('data', (c) => (output += c));
    p.once('error', reject);
    p.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed: ${output.slice(0, 500)}`)),
    );
  });
}
const snapshotClient = new PgClient({ connectionString: config.DATABASE_URL });
await snapshotClient.connect();
let counts: { tasks: number; runs: number }, evidenceRows: { path: string }[];
try {
  await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await snapshotClient.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  counts = (
    await snapshotClient.query(
      'SELECT (SELECT count(*) FROM "Task")::int AS tasks,(SELECT count(*) FROM "Run")::int AS runs',
    )
  ).rows[0];
  evidenceRows = (await snapshotClient.query('SELECT path FROM "Evidence"')).rows;
  await command('pg_dump', [
    ...connectionArgs,
    '--snapshot',
    snapshot,
    '-Fc',
    '-f',
    path.join(target, 'database.dump'),
    url.pathname.slice(1),
  ]);
} finally {
  await snapshotClient.query('ROLLBACK').catch(() => {});
  await snapshotClient.end();
}
const files = [];
for (const row of evidenceRows!) {
  const file = row.path,
    source = path.resolve(config.evidenceDir, file),
    full = path.resolve(target, 'evidence', file);
  if (
    !source.startsWith(config.evidenceDir + path.sep) ||
    !full.startsWith(path.resolve(target, 'evidence') + path.sep)
  )
    throw new Error('Unsafe evidence path');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.copyFile(source, full);
  const bytes = await fs.readFile(full);
  files.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = {
  createdAt: new Date().toISOString(),
  codeVersion: process.env.BUILD_REVISION || 'mvp-0.1.0',
  tasks: counts!.tasks,
  runs: counts!.runs,
  evidence: files,
};
await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (process.argv.includes('--verify')) {
  const name = 'uiagent_restore_' + Date.now();
  if (!/^uiagent_restore_\d+$/.test(name)) throw new Error('Invalid restore database');
  const admin = new PgClient({ connectionString: config.DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  let successful = false;
  try {
    await command('pg_restore', [
      ...connectionArgs,
      '--no-owner',
      '--no-privileges',
      '-d',
      name,
      path.join(target, 'database.dump'),
    ]);
    const restoreUrl = new URL(config.DATABASE_URL);
    restoreUrl.pathname = '/' + name;
    const restored = new PgClient({ connectionString: restoreUrl.toString() });
    await restored.connect();
    try {
      const counts = (
        await restored.query(
          'SELECT (SELECT count(*) FROM "Task")::int AS tasks,(SELECT count(*) FROM "Run")::int AS runs',
        )
      ).rows[0];
      if (counts.tasks !== manifest.tasks || counts.runs !== manifest.runs)
        throw new Error('Restore counts differ from snapshot');
      const rows = (await restored.query('SELECT path FROM "Evidence" LIMIT 30')).rows;
      let checked = 0;
      for (const row of rows) {
        const normalized = path.resolve(target, 'evidence', row.path);
        if (!normalized.startsWith(path.resolve(target, 'evidence') + path.sep))
          throw new Error('Unsafe restored evidence path');
        await fs.access(normalized);
        checked++;
      }
      await fs.mkdir('.runtime/verification', { recursive: true });
      await fs.writeFile(
        '.runtime/verification/backup-restore.json',
        JSON.stringify(
          {
            ok: true,
            backupPath: target,
            counts,
            evidenceChecked: checked,
            files: files.length,
            verifiedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      successful = true;
    } finally {
      await restored.end();
    }
  } finally {
    if (successful) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
}
console.log(`Backup saved: ${target}${process.argv.includes('--verify') ? ' · restore verified' : ''}`);
await db.$disconnect();
