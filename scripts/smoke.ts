import fs from 'node:fs/promises';
import { Client } from '../tests/helpers.ts';
const client = new Client();
await client.login();
const model = process.argv.includes('--model');
try {
  const task = await client.plan('请验证 C01 合法申请保存为草稿，不要增加其他场景', {
    mode: model ? 'deepagents' : 'catalog',
    title: model ? '真实 Deep Agents 接入验证' : '首条真实浏览器验证',
  });
  console.log(
    JSON.stringify({
      taskId: task.id,
      mode: task.mode,
      plan: task.plans[0].content,
      usage: task.plans[0].usage,
    }),
  );
  const run = await client.finished((await client.submit(task)).id);
  await fs.mkdir('.runtime/verification', { recursive: true });
  await fs.writeFile(
    `.runtime/verification/${model ? 'model' : 'browser'}-smoke.json`,
    JSON.stringify(run, null, 2),
  );
  console.log(
    JSON.stringify({
      runId: run.id,
      status: run.status,
      cleanup: run.cleanupStatus,
      summary: run.summary,
      usage: run.usage,
      error: run.error,
    }),
  );
  if (
    run.status !== 'COMPLETED' ||
    run.cleanupStatus !== 'CLEAN' ||
    run.summary.some((c: any) => c.result !== 'PASS')
  )
    process.exitCode = 1;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
