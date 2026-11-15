// End-to-end smoke test in headless Chromium: open the built site, feed it a folder of DICOM files,
// wait for the automatic model, download STL + 3MF and take screenshots.
//   node test/e2e/run.mjs <dicom-dir-or-zip> [out-dir] [--detail=standard] [--no-download]
// (Not part of `npm test`: needs Playwright + a CT series, which are not committed.)
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from './serve.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const input = resolve(args[0] || '.');
const out = resolve(args[1] || 'e2e-out');
mkdirSync(out, { recursive: true });

function walk(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, list);
    else list.push(p);
  }
  return list;
}
const files = statSync(input).isDirectory() ? walk(input) : [input];

const { server, url } = await serve('dist');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(flags.dpr || 1) });
const problems = [];
const requests = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('request', (r) => { if (!r.url().startsWith(url) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) requests.push(r.url()); });

const t0 = Date.now();
await page.goto(url);
await page.screenshot({ path: join(out, '0-intro.png') });
await page.setInputFiles('#in-files', files);
await page.waitForSelector('#workspace:not([hidden])', { timeout: 180000 }).catch(async () => {
  console.log('intro error:', await page.textContent('#intro-error'));
  throw new Error('workspace never appeared');
});
const tScan = Date.now();
if (flags.detail) await page.selectOption('#detail', flags.detail);
await page.waitForSelector('#dl-stl:not([disabled])', { timeout: 600000 });
const tDone = Date.now();
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '1-front.png') });
for (const v of ['iso', 'back', 'top']) {
  await page.click(`.view-buttons button[data-view="${v}"]`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `2-${v}.png`) });
}
const result = {
  files: files.length,
  scanSeconds: (tScan - t0) / 1000,
  modelSeconds: (tDone - tScan) / 1000,
  series: await page.$$eval('#series option', (o) => o.map((x) => x.textContent)),
  seriesNotes: await page.textContent('#series-warnings'),
  anon: await page.textContent('#anon-summary'),
  threshold: await page.textContent('#threshold-out'),
  detail: await page.textContent('#detail-note'),
  stats: await page.textContent('#statsbar'),
  fit: await page.textContent('#fit-note'),
  externalRequests: requests,
  problems,
};
if (!('no-download' in flags)) {
  for (const [id, ext] of [['#dl-stl', 'stl'], ['#dl-3mf', '3mf']]) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click(id)]);
    const path = join(out, `model.${ext}`);
    await dl.saveAs(path);
    result[ext] = { name: dl.suggestedFilename(), bytes: statSync(path).size };
    await page.waitForSelector(`${id}:not([disabled])`, { timeout: 120000 });
  }
}
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
