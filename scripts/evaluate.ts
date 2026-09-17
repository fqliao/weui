import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Client, budget } from '../tests/helpers.ts';
const client = new Client();
await client.login();
await fs.mkdir('.runtime/verification', { recursive: true });
const mode = process.argv.includes('--catalog') ? 'catalog' : 'deepagents';
const cases = JSON.parse(await fs.readFile('evals/mvp-cases.json', 'utf8')) as {
  id: string;
  caseId: string;
  group: string;
  fault: string;
  expected: string;
  maxActions?: number;
}[];
let results: any[] = [];
if (process.argv.includes('--resume'))
  try {
    results = JSON.parse(
      await fs.readFile('.runtime/verification/agent-evaluation.json', 'utf8'),
    ).results.filter((r: any) => r.matched);
  } catch {}
for (const c of cases) {
  if (results.some((r) => r.id === c.id)) continue;
  const started = Date.now();
  let run: any, error: string | undefined;
  try {
    const env = c.fault === 'none' ? { id: 'sample-environment' } : await client.environment(c.fault);
    run = await client.run(`请只验证 ${c.caseId} 这个注册场景，依据固定知识规则生成计划，不扩展其他用例。`, {
      environmentId: env.id,
      mode,
      title: `评测 ${c.id} · ${c.group} · ${c.caseId}`,
      budget: { ...budget, maxActions: c.maxActions ?? 100 },
    });
  } catch (e) {
    error = (e as Error).message;
  }
  const actual = run?.summary?.[0]?.result ?? 'ERROR';
  const row = {
    ...c,
    mode,
    runId: run?.id,
    actual,
    matched: actual === c.expected && run?.manifest.plan.cases.length === 1 && run?.cleanupStatus === 'CLEAN',
    status: run?.status,
    cleanup: run?.cleanupStatus,
    durationMs: Date.now() - started,
    usage: run?.usage,
    assertions: run?.summary?.[0]?.assertions,
    error: error || run?.error,
  };
  results.push(row);
  await fs.writeFile(
    '.runtime/verification/agent-evaluation.json',
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        mode,
        results,
        passed: results.filter((r) => r.matched).length,
        total: cases.length,
      },
      null,
      2,
    ),
  );
  console.log(
    `${c.id} ${c.caseId} ${c.fault}: expected=${c.expected} actual=${actual} matched=${row.matched} (${row.durationMs}ms)`,
  );
  if (run && c.fault !== 'none')
    await client.call(`/admin/environments/${run.manifest.environmentId}`, 'PATCH', { enabled: false });
}
assert.equal(results.filter((r) => r.matched).length, cases.length, 'Agent evaluation contains mismatches');
