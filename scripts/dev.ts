import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd(),
  production = process.argv.includes('--production');
fs.mkdirSync('.runtime/logs', { recursive: true });
const children: ChildProcess[] = [];
let stopping = false;
function start(name: string, args: string[]) {
  const log = fs.openSync(path.join(root, `.runtime/logs/${name}.log`), 'a');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  children.push(child);
  fs.writeFileSync(`.runtime/${name}.pid`, String(child.pid));
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${name} exited (${code}); see .runtime/logs/${name}.log`);
      void close(1);
    }
  });
  console.log(`${name} started; logs: .runtime/logs/${name}.log`);
}
async function close(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const app of ['sample', 'api', 'worker']) start(app, ['--import', 'tsx', `apps/${app}/src/index.ts`]);
start('web', [
  'node_modules/next/dist/bin/next',
  production ? 'start' : 'dev',
  'apps/web',
  '--hostname',
  process.env.WEB_HOST || '127.0.0.1',
  '--port',
  process.env.WEB_PORT || '3100',
]);
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
console.log(`Web: ${process.env.WEB_ORIGIN || 'http://localhost:3100'} · account: .runtime/access.local.md`);
