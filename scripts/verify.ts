import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Use pnpm verify');
await fs.mkdir('.runtime/verification', { recursive: true });
const steps: [string, string[]][] = [
  ['typecheck', ['typecheck']],
  ['unit', ['test']],
  ['integration', ['test:integration']],
  ['web', ['test:e2e']],
];
if (process.argv.includes('--full'))
  steps.push(
    ['regression', ['exec', 'tsx', 'scripts/regression.ts']],
    [
      'evaluation',
      ['exec', 'tsx', 'scripts/evaluate.ts', ...(process.argv.includes('--live-model') ? [] : ['--catalog'])],
    ],
    ['concurrency', ['exec', 'tsx', 'scripts/concurrency.ts']],
  );
const results = [];
for (const [name, args] of steps) {
  const started = Date.now();
  let output = '';
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  await fs.writeFile(`.runtime/verification/${name}.log`, output);
  results.push({ name, command: ['pnpm', ...args].join(' '), code, durationMs: Date.now() - started });
  await fs.writeFile(
    '.runtime/verification/checks.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  if (code) process.exit(code);
}
console.log('Verification completed; .runtime/verification/checks.json');
