import fs from 'node:fs/promises';
import path from 'node:path';

// Only include reviewed summaries and test-fixture screenshots in the shareable artifact.
const root = process.cwd();
const verification = JSON.parse(
  await fs.readFile(path.join(root, '.runtime/verification/structured-execution.json'), 'utf8'),
);
const results = verification.results.map((r: any, index: number) => ({
  index,
  label: r.label,
  id: r.id,
  result: r.result,
  seconds: r.metrics.durationMs / 1000,
  calls: r.metrics.modelCalls,
  tokens: r.metrics.inputTokens + r.metrics.outputTokens,
  cny: r.metrics.costCny,
  l2: r.execution.l2Hits,
  l1: r.execution.l1Hits,
  ai: r.execution.aiOperations,
  published: r.execution.published,
}));
if (
  results.length !== 7 ||
  results[1].tokens !== 0 ||
  results[4].tokens !== 0 ||
  results[2].result !== 'FAIL'
)
  throw new Error('Unexpected verification fixture; review the report assumptions before rebuilding');
const esc = (v: unknown) =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const table = results
  .map(
    (r: any) =>
      `<tr data-result="${r.result}"><th scope="row"><span class="row-no">0${r.index + 1}</span>${esc(r.label)}</th><td><span class="status ${r.result === 'FAIL' ? 'expected-fail' : 'pass'}">${r.result}${r.result === 'FAIL' ? ' · 正确识别缺陷' : ''}</span></td><td>${r.seconds.toFixed(3)}</td><td>${r.calls}</td><td>${r.tokens.toLocaleString('en-US')}</td><td>¥${Number(r.cny).toFixed(6)}</td><td class="mono">${r.l2} / ${r.l1} / ${r.ai}</td></tr>`,
  )
  .join('\n');
const sources = results
  .map((r: any) => `<li><span>${esc(r.label)}</span><code>${r.id}</code></li>`)
  .join('\n');
const bars = (indexes: number[]) =>
  indexes
    .map((i) => {
      const r = results[i];
      const name =
        i === 0 ? '首次明确配置' : i === 1 ? '二次静态回放' : i === 3 ? '首次 AI 定位学习' : '学习后静态回放';
      return `<div class="bar-row"><div class="bar-meta"><span>${name}</span><strong>${r.seconds.toFixed(3)}<small> 秒</small></strong></div><div class="bar-track"><div class="bar-fill ${i === 0 || i === 3 ? 'initial' : ''}" style="width:${(r.seconds / 12) * 100}%"></div></div><div class="bar-foot"><span>${r.calls} 次模型调用</span><span>${r.tokens.toLocaleString('en-US')} Token · ¥${Number(r.cny).toFixed(6)}</span></div></div>`;
    })
    .join('');
let html = await fs.readFile(path.join(root, 'scripts/report/weui-report.template.html'), 'utf8');
const replacements: Record<string, string> = {
  __TABLE__: table,
  __RUN_IDS__: sources,
  __BARS_A__: bars([0, 1]),
  __BARS_B__: bars([3, 4]),
  __GAIN_A__: ((1 - results[1].seconds / results[0].seconds) * 100).toFixed(1),
  __GAIN_B__: ((1 - results[4].seconds / results[3].seconds) * 100).toFixed(1),
  __DATA__: JSON.stringify(results).replaceAll('<', '\\u003c'),
};
for (const [marker, file] of Object.entries({
  __EDITOR_IMAGE__: 'structured-editor.png',
  __REPORT_IMAGE__: 'structured-zero-report.png',
}))
  replacements[marker] =
    'data:image/png;base64,' +
    (await fs.readFile(path.join(root, '.runtime/verification', file))).toString('base64');
for (const [marker, value] of Object.entries(replacements)) html = html.replaceAll(marker, value);
if (/__[A-Z][A-Z_]+__/.test(html)) throw new Error('Unresolved report template markers');
const output = path.join(root, 'output/WeUI-方案与实现及实测汇报-20260916.html');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html, 'utf8');
console.log(
  JSON.stringify({ file: output, bytes: Buffer.byteLength(html), runs: results.length, selfContained: true }),
);
