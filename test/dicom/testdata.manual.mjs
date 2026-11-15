#!/usr/bin/env node
// Manual integration run over the shared (uncommitted) test data in /home/user/testdata.
//   node test/dicom/testdata.manual.mjs [root] [--only=name,name]
// Loads every dataset through StudyLoader, prints a table and verifies synthetic variants against ground truth.
// Not part of the default test run (the data is not committed).
import fs from 'node:fs';
import path from 'node:path';
import { StudyLoader } from '../../src/dicom/index.js';
import { injectWasm, walk } from './helpers.js';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);   // picked up by a `node --test` glob: do nothing

const args = process.argv.slice(2);
const ROOT = args.find((a) => !a.startsWith('--')) || '/home/user/testdata';
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
if (!fs.existsSync(path.join(ROOT, 'MANIFEST.md'))) {
  console.log(`no test data at ${ROOT} (MANIFEST.md missing)`);
  process.exit(0);
}
injectWasm();

function readNpyInt16(p) {
  const b = fs.readFileSync(p);
  const hlen = b[6] === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hoff = b[6] === 1 ? 10 : 12;
  const header = b.subarray(hoff, hoff + hlen).toString('latin1');
  if (!/'descr': '<i2'/.test(header) || /'fortran_order': True/.test(header)) throw new Error('unexpected npy header');
  const shape = header.match(/'shape': \(([^)]*)\)/)[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const data = new Int16Array(b.buffer.slice(b.byteOffset + hoff + hlen, b.byteOffset + b.length));
  return { shape, data };
}

const synthDir = path.join(ROOT, 'synthetic');
const gt = fs.existsSync(path.join(synthDir, 'ground_truth.json')) ? JSON.parse(fs.readFileSync(path.join(synthDir, 'ground_truth.json'), 'utf8')) : null;
const gtHU = fs.existsSync(path.join(synthDir, 'ground_truth_hu.npy')) ? readNpyInt16(path.join(synthDir, 'ground_truth_hu.npy')) : null;
const PHI = ['DOE', 'JANE', 'MRN1234567', '19700101', 'ACC998877', 'SMITH', 'Test General', 'TESTMED', '20240315'];

function sourcesFor(p) {
  const st = fs.statSync(p);
  const files = st.isDirectory() ? walk(p) : [p];
  return files.map((f) => ({
    name: path.relative(path.dirname(p), f), size: fs.statSync(f).size,
    read: async () => new Uint8Array(fs.readFileSync(f)),
  }));
}

function stats(d) {
  let mn = Infinity, mx = -Infinity, s = 0;
  for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; s += v; }
  return { min: mn, max: mx, mean: s / d.length };
}

function barCentroid(vol) {
  const bars = gt.base_phantom.chiral_bars;
  const [lo, hi] = bars.union_bbox;
  const [nx, ny, nz] = vol.dims;
  let n = 0;
  const c = [0, 0, 0];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = vol.data[i + nx * (j + ny * k)];
    if (v < 600 || v > 800) continue;
    const w = [0, 1, 2].map((a) => vol.origin[a] + i * vol.stepX[a] + j * vol.stepY[a] + k * vol.stepZ[a]);
    if (w.some((x, a) => x < lo[a] - 2 || x > hi[a] + 2)) continue;
    n++; c[0] += w[0]; c[1] += w[1]; c[2] += w[2];
  }
  return n ? { n, c: c.map((x) => x / n), err: Math.hypot(...c.map((x, a) => x / n - bars.analytic_centroid[a])) } : { n: 0, err: Infinity };
}

function collectStrings(root) {
  const out = [];
  const seen = new Set();
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
    if (typeof v !== 'object' || seen.has(v) || ArrayBuffer.isView(v)) return;
    seen.add(v);
    if (v instanceof Map) { for (const [k, x] of v) { visit(k); visit(x); } return; }
    for (const k of Object.keys(v)) { out.push(k); visit(v[k]); }
  };
  visit(root);
  return out.join('\n');
}

function compareGT(vol, name) {
  if (!gtHU) return 'no GT';
  const [gz, gy, gx] = gtHU.shape;
  const [nx, ny, nz] = vol.dims;
  if (nx !== gx || ny !== gy || nz !== gz) return `dims ≠ GT (${gx}x${gy}x${gz})`;
  let bad = 0, maxErr = 0, padded = 0, interpBad = 0;
  for (let i = 0; i < vol.data.length; i++) {
    const a = vol.data[i], b = gtHU.data[i];
    if (a === b) continue;
    if (name === 'signed_int16' && a === -1024) { padded++; continue; }
    const k = Math.floor(i / (nx * ny));
    if (name === 'missing_slices' && (k === 20 || k === 21)) { interpBad++; maxErr = Math.max(maxErr, Math.abs(a - b)); continue; }
    bad++;
  }
  let s = bad === 0 ? 'EXACT' : `${bad} voxels differ`;
  if (padded) s += ` (${padded} padding→-1024)`;
  if (interpBad) s += ` (interp. slices: ${interpBad} vox differ, max ${maxErr} HU — noise)`;
  return s;
}

const datasets = [];
if (fs.existsSync(synthDir)) {
  for (const d of fs.readdirSync(synthDir).sort()) {
    const p = path.join(synthDir, d);
    if (d.startsWith('_')) continue;
    if (fs.statSync(p).isDirectory() || d.endsWith('.zip')) datasets.push({ name: d, p, synthetic: true });
  }
}
const realDir = path.join(ROOT, 'real');
if (fs.existsSync(realDir)) for (const d of fs.readdirSync(realDir).sort()) datasets.push({ name: d, p: path.join(realDir, d), synthetic: false });

const rows = [];
let failures = 0;
for (const ds of datasets) {
  if (only.length && !only.includes(ds.name)) continue;
  const sources = sourcesFor(ds.p);
  const L = new StudyLoader();
  const row = { dataset: (ds.synthetic ? 'syn/' : 'real/') + ds.name, files: sources.length };
  let peakRss = process.memoryUsage().rss;
  const memTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  try {
    if (global.gc) global.gc();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const scan = await L.scan(sources);
    const t1 = performance.now();
    const vol = await L.buildVolume(scan.recommendedId);
    const t2 = performance.now();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const s = scan.series[0];
    const st = stats(vol.data);
    Object.assign(row, {
      series: scan.series.length, rej: scan.rejected.length, skip: scan.skippedFiles,
      pick: s.label.slice(0, 60), ts: s.transferSyntax.replace('Explicit VR ', 'Expl ').replace('Implicit VR ', 'Impl '),
      dims: vol.dims.join('x'), spacing: vol.spacing.map((v) => v.toFixed(3)).join('/'),
      hu: `${st.min}/${st.max}/${st.mean.toFixed(0)}`, scanMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1),
      peakMB: Math.round((peakRss - rss0) / 1e6), volMB: Math.round(vol.data.byteLength / 1e6),
      warn: s.warnings.join('; ').slice(0, 90),
    });
    // PHI checks (synthetic have planted fake PHI; real data is already de-identified but check UIDs anyway)
    const text = collectStrings({ scan, info: vol.info, dbg: L._debugState() });
    const leaks = (ds.synthetic ? PHI : []).filter((x) => text.includes(x));
    const uidLeak = (text.match(/\b\d+(\.\d+){5,}\b/g) || []).filter((u) => !u.startsWith('1.2.840.10008.'));
    for (const src of sources) for (const part of src.name.split('/')) if (part.length >= 8 && text.includes(part) && !/^\d+$/.test(part)) leaks.push('name:' + part);
    if (leaks.length || uidLeak.length) { row.check = `PHI LEAK ${[...leaks, ...uidLeak.slice(0, 2)].join(',')}`; failures++; }
    else row.check = 'anon ok';
    if (ds.synthetic && gt) {
      const g = ds.name === 'tiny_fast' ? null : barCentroid(vol);
      const parts = [];
      if (['coronal_oblique', 'gantry_tilt', 'thick_slices', 'tiny_fast'].includes(ds.name)) {
        parts.push('GT n/a (different grid)');
      } else {
        const c = compareGT(vol, ds.name);
        parts.push(c);
        if (!c.startsWith('EXACT') && !c.startsWith('0 ')) failures++;
      }
      if (g) {
        parts.push(`bars centroid err ${g.err.toFixed(3)} mm (n=${g.n})`);
        if (!(g.err < 0.5)) failures++;
      }
      if (ds.name.startsWith('study_mixed') && s.seriesNumber !== 3) { parts.push('WRONG PICK'); failures++; }
      row.check += ' | ' + parts.join(' | ');
    }
    if (ds.synthetic) row.report = `ids ${scan.report.identifiersFound.reduce((a, x) => a + x.elements, 0)} desc-cleaned ${scan.report.descriptorsCleaned} burned ${scan.report.burnedInRisk}`;
  } catch (e) {
    row.error = e.message;
    failures++;
  } finally {
    clearInterval(memTimer);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

console.log('\n' + ['dataset', 'files', 'series', 'rej', 'skip', 'ts', 'dims', 'spacing', 'hu', 'scanMs', 'buildMs', 'peakMB'].join('\t'));
for (const r of rows) {
  console.log([r.dataset, r.files, r.series, r.rej, r.skip, r.ts, r.dims, r.spacing, r.hu, r.scanMs, r.buildMs, r.peakMB].join('\t'));
}
console.log(`\n${failures ? failures + ' FAILURE(S)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
