import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserEngine } from '../packages/executor/src/launch.ts';

const output = path.resolve('output/WeUI-方案与实现及实测汇报-20260916.html');
const artifacts = path.resolve('.runtime/verification/share-report');
await fs.mkdir(artifacts, { recursive: true });
const browser = await browserEngine({ browserName: 'chrome' });
const errors: string[] = [];
const network: string[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route(/^https?:/, async (route) => {
  network.push(route.request().url());
  await route.abort();
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(pathToFileURL(output).href);
  assert.equal(await page.locator('main section.section').count(), 11);
  assert.equal(await page.locator('.result-table tbody tr').count(), 7);
  assert.equal(await page.locator('.result-table [data-result="FAIL"]').count(), 1);
  assert.equal(await page.locator('h1').count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'desktop-hero.png') });
  for (const id of ['architecture', 'cache', 'evidence']) {
    const section = page.locator(`#${id}`);
    if (!(await section.count())) continue;
    await section.screenshot({
      path: path.join(artifacts, `${id}.png`),
      style: '.topbar { visibility: hidden !important; }',
    });
  }
  for (const [scenario, token] of [
    ['static', '0 Token'],
    ['l1', '0 Token'],
    ['ai', '1,409 Token'],
    ['fail', '0 Token'],
  ]) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    assert.ok((await page.locator('#demo-result').innerText()).includes(token));
    assert.equal(await page.locator(`[data-scenario="${scenario}"]`).getAttribute('aria-pressed'), 'true');
  }
  await page.locator('[data-scenario="static"]').click();
  await page.locator('[data-image="editor"]').click();
  assert.equal(await page.locator('#lightbox').evaluate((el) => (el as HTMLDialogElement).open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#lightbox').evaluate((el) => (el as HTMLDialogElement).open), false);
  const images = await page.locator('.proof img').evaluateAll((els) =>
    els.map((el) => ({
      loaded: (el as HTMLImageElement).complete,
      width: (el as HTMLImageElement).naturalWidth,
    })),
  );
  assert.ok(images.every((i) => i.loaded && i.width > 0));
  const responsive: { width: number; content: number }[] = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const content = await page.evaluate(() => document.documentElement.scrollWidth);
    responsive.push({ width, content });
    assert.ok(content <= width, `Page overflow at ${width}px: ${content}`);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: path.join(artifacts, 'mobile-hero.png') });
  await page.locator('#evidence').screenshot({ path: path.join(artifacts, 'mobile-evidence.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: path.join(artifacts, 'print-preview.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  });
  assert.deepEqual(network, [], 'The shareable report must not request external assets');
  assert.deepEqual(errors, []);
  const result = {
    success: true,
    browser: await browser.version(),
    sections: 11,
    recordedRuns: 7,
    scenarios: 4,
    images: images.length,
    responsive,
    externalRequests: network.length,
    pageErrors: errors,
    artifacts,
  };
  await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
