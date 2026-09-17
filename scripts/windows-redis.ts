import fs from 'node:fs/promises';
import { openSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import net from 'node:net';
export async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}
export async function startRedis() {
  if (await portOpen(56379)) {
    console.log('Redis 本地端口已就绪');
    return;
  }
  const runtime = path.resolve('.runtime'),
    target = path.join(runtime, 'tools/redis'),
    archive = path.join(runtime, 'redis-windows.zip');
  await fs.mkdir(target, { recursive: true });
  let found = (await fs.readdir(target, { recursive: true })).find((p) => p.endsWith('redis-server.exe'));
  if (!found) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(archive);
    } catch {
      const r = await fetch(
        'https://github.com/redis-windows/redis-windows/releases/download/8.10.1/Redis-8.10.1-Windows-x64-msys2.zip',
      );
      if (!r.ok) throw new Error(`Redis download ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(archive, buffer);
    }
    if (
      createHash('sha256').update(buffer).digest('hex') !==
      '4e8f2f956ed92feadf3f64b4e137ed34026438821e692e7ae22c9bba5976607a'
    )
      throw new Error('Redis archive SHA256 mismatch');
    for (const [name, data] of Object.entries(unzipSync(buffer))) {
      const dest = path.resolve(target, name);
      if (!dest.startsWith(target + path.sep)) throw new Error('Archive contains unsafe path');
      if (name.endsWith('/')) await fs.mkdir(dest, { recursive: true });
      else {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data);
      }
    }
    found = (await fs.readdir(target, { recursive: true })).find((p) => p.endsWith('redis-server.exe'));
  }
  if (!found) throw new Error('Redis binary missing');
  const exe = path.join(target, found),
    data = path.join(runtime, 'redis-data'),
    cfg = path.join(runtime, 'redis.conf');
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(
    cfg,
    `bind 127.0.0.1\nport 56379\nprotected-mode yes\nappendonly yes\nsave 60 1\nmaxmemory-policy noeviction\ndir "${data.replaceAll('\\', '/')}"\n`,
  );
  const p = spawn(exe, ['redis.conf'], {
    cwd: runtime,
    windowsHide: true,
    detached: true,
    stdio: [
      'ignore',
      openSync(path.join(runtime, 'redis.log'), 'a'),
      openSync(path.join(runtime, 'redis-error.log'), 'a'),
    ],
  });
  p.unref();
  await fs.writeFile(path.join(runtime, 'redis.pid'), String(p.pid));
  for (let i = 0; i < 30; i++) {
    if (await portOpen(56379)) {
      console.log('Redis 已启动，绑定 127.0.0.1:56379');
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Redis 启动失败，请查看 .runtime/redis-error.log');
}
