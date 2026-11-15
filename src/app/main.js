// 3D Bones — main thread: UI state, file intake, preview, downloads.
// All heavy work (DICOM parsing, anonymisation, segmentation, meshing, export) runs in the worker.
import workerSource from 'worker-source';
import { Viewer, BED_MM } from './viewer.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
const MIN_PART_STEPS = [0, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const PLATE_LIMIT = BED_MM - 6; // leave a small margin on the 256 mm plate

const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));

const state = {
  scan: null,
  seriesId: null,
  info: null, // from 'loaded'
  auto: null, // automatic parameters for the current working grid
  params: null, // current parameters
  history: [], // undo stack for part removal
  scale: 1,
  jobId: 0,
  version: 0, // bumps on every parameter change
  finalVersion: -1, // version of the final mesh the worker holds for export
  lastChange: 0,
  mesh: null, // {parts, stats, quality, offset}
  firstMesh: true,
  slice: { axis: 2, index: 0, data: null, width: 0, height: 0, reqId: 0 },
  timers: {},
};

let viewer = null;

// ───────────────────────── worker messaging ─────────────────────────
worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': onProgress(m); break;
    case 'scanned': onScanned(m.result); break;
    case 'loaded': onLoaded(m.info, m.keepParams); break;
    case 'mesh': onMesh(m); break;
    case 'cancelled': break;
    case 'slice': onSlice(m); break;
    case 'exported': onExported(m); break;
    case 'error': onError(m); break;
  }
};
worker.onerror = (e) => onError({ scope: 'worker', message: e.message || 'Unexpected error in the processing engine.' });

function onProgress(m) {
  const pct = `${Math.round(Math.max(0, Math.min(1, m.fraction || 0)) * 100)}%`;
  if (m.scope === 'scan') {
    $('scan-status').hidden = false;
    $('scan-bar').style.width = pct;
    $('scan-label').textContent = m.label || 'Reading and anonymising files…';
  } else {
    $('progress').hidden = false;
    $('progress-bar').style.width = pct;
    $('progress-label').textContent = m.label || 'Working…';
  }
}

function onError(m) {
  const text = m.message || 'Something went wrong.';
  $('progress').hidden = true;
  if (m.scope === 'scan' || !state.scan) {
    $('scan-status').hidden = true;
    const el = $('intro-error');
    el.textContent = text;
    el.hidden = false;
  } else if (m.scope === 'export') {
    toast(text);
    setDownloadBusy(false);
  } else {
    const el = $('viewer-error');
    el.textContent = text;
    el.hidden = false;
  }
}

// ───────────────────────── file intake ─────────────────────────
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      try { out.push(await new Promise((res, rej) => entry.file(res, rej))); } catch { /* unreadable: skip */ }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

function startScan(files) {
  files = files.filter((f) => f && f.size > 0);
  $('intro-error').hidden = true;
  if (!files.length) {
    onError({ scope: 'scan', message: 'No files were found in that selection.' });
    return;
  }
  state.scan = null;
  $('scan-status').hidden = false;
  $('scan-bar').style.width = '0%';
  $('scan-label').textContent = `Reading and anonymising ${fmt(files.length)} file${files.length === 1 ? '' : 's'}…`;
  worker.postMessage({ type: 'scan', files });
}

function onScanned(result) {
  $('scan-status').hidden = true;
  if (!result.series || !result.series.length) {
    let msg = 'No usable CT series was found in those files.';
    if (result.rejected && result.rejected.length) {
      msg += ' Found but not usable: ' + result.rejected.slice(0, 4).map((r) => `${r.label} (${r.reason})`).join('; ') + '.';
    } else if (!result.report || !result.report.dicomFiles) {
      msg += ' None of the files looked like DICOM images.';
    }
    onError({ scope: 'scan', message: msg });
    return;
  }
  state.scan = result;
  const sel = $('series');
  sel.textContent = '';
  for (const s of result.series) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = (s.id === result.recommendedId ? '★ ' : '') + s.label;
    o.disabled = s.supported === false;
    sel.appendChild(o);
  }
  renderAnon(result);
  showWorkspace(true);
  const first = result.series.find((s) => s.id === result.recommendedId && s.supported !== false)
    || result.series.find((s) => s.supported !== false) || result.series[0];
  sel.value = first.id;
  loadSeries(first.id);
}

function renderAnon(result) {
  const r = result.report || {};
  const n = r.dicomFiles || 0;
  $('anon-summary').textContent = `${fmt(n)} file${n === 1 ? '' : 's'} anonymised · ${fmt(r.totalElementsDiscarded || 0)} identifying fields discarded`;
  const body = $('anon-body');
  body.textContent = '';
  const p = (text) => { const el = document.createElement('p'); el.textContent = text; body.appendChild(el); return el; };
  p('Identifying information was dropped as each file was read; it was never stored, shown or sent anywhere. What was discarded:');
  const table = document.createElement('table');
  for (const row of r.identifiersFound || []) {
    if (!row.elements) continue;
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = row.category;
    const b = document.createElement('td'); b.textContent = fmt(row.elements);
    tr.append(a, b); table.appendChild(tr);
  }
  body.appendChild(table);
  if (r.kept && r.kept.length) p('Kept (technical only): ' + r.kept.join(', ') + '.');
  if (r.descriptorsCleaned) p(`${fmt(r.descriptorsCleaned)} series description(s) contained name or ID fragments and were blanked.`);
  if (r.burnedInRisk) p(`${fmt(r.burnedInRisk)} image(s) that may contain burned-in text (dose reports, screenshots) were skipped entirely.`);
  if (result.skippedFiles) p(`${fmt(result.skippedFiles)} non-DICOM or unreadable file(s) were ignored.`);
  p('The exported model contains geometry only — no names, dates or identifiers.');
}

// ───────────────────────── series loading ─────────────────────────
function loadSeries(id) {
  state.seriesId = id;
  state.info = null;
  state.mesh = null;
  state.firstMesh = true;
  state.history = [];
  state.finalVersion = -1;
  $('viewer-error').hidden = true;
  setDownloadsEnabled(false);
  if (viewer) viewer.clear();
  $('statsbar').textContent = '';
  onProgress({ scope: 'load', fraction: 0, label: 'Decoding slices…' });
  $('focus').checked = true;
  worker.postMessage({ type: 'load', seriesId: id, detail: $('detail').value, focus: true });
}

const TRACKED = ['threshold', 'smoothing', 'closeGapMm', 'fillCavities', 'separateJoints', 'minPartMm3', 'joinParts', 'pegDiameterMm', 'maxPegGapMm', 'dropVessels'];

function onLoaded(info, keepParams) {
  // Detail or focus was changed while the scan was still loading: re-prepare with the current choices.
  if (info.detail !== $('detail').value || info.focus.on !== $('focus').checked) {
    worker.postMessage({ type: 'prepare', detail: $('detail').value, focus: $('focus').checked });
    return;
  }
  const prevAuto = state.auto;
  const prev = state.params;
  state.info = info;
  state.auto = { ...info.params, removeSeeds: [], keepSeeds: [], crop: null };
  const next = { ...state.auto };
  if (keepParams && prev && prevAuto) {
    // Detail level changed: keep what the user adjusted, adopt new automatic values for the rest.
    for (const k of TRACKED) if (prev[k] !== prevAuto[k]) next[k] = prev[k];
    next.removeSeeds = prev.removeSeeds;
    next.keepSeeds = prev.keepSeeds;
    next.crop = prev.crop;
  } else {
    resetCropSliders();
  }
  state.params = next;
  syncControls();
  renderSeriesNotes();
  drawHistogram();
  const dims = info.dims;
  state.slice.axis = 2;
  setSliceAxis(2, Math.floor(dims[2] / 2));
  const v = info.voxel;
  $('detail-note').textContent = `Working grid ${dims[0]} × ${dims[1]} × ${dims[2]} at ${fmt(v, 2)} mm (scan: ${info.source.spacing.map((s) => fmt(s, 2)).join(' × ')} mm).`;
  changed({ immediate: true });
}

function renderSeriesNotes() {
  const el = $('series-warnings');
  el.textContent = '';
  const s = state.scan.series.find((x) => x.id === state.seriesId);
  const add = (text, cls) => { const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; el.appendChild(d); };
  const seen = new Set();
  for (const w of [...((s && s.warnings) || []), ...((state.info.source.info && state.info.source.info.warnings) || [])]) {
    if (!seen.has(w)) { seen.add(w); add('⚠ ' + w); }
  }
  const f = state.info.focus;
  if (f) {
    const note = $('focus-note');
    if (f.on && f.hiddenGroups > 0) {
      note.textContent = `Showing the main group. ${f.hiddenGroups} other bone group${f.hiddenGroups === 1 ? '' : 's'} (${Math.max(1, Math.round(f.hiddenShare * 100))} % of the bone in the scan) ${f.hiddenGroups === 1 ? 'is' : 'are'} hidden — untick to see everything.`;
    } else if (!f.active) {
      note.textContent = 'Whole scan shown (no soft tissue around the bone to separate regions).';
    } else {
      note.textContent = f.on ? 'Leaves out the CT table and partly-scanned regions such as ribs beside an arm' : 'Showing every bone in the scan' + (f.tableRemoved ? ' (CT table removed).' : '.');
    }
  }
  if (state.info.analysis.hasMetal) add('⚠ Metal detected — expect streak artefacts near the implant; raise the threshold or remove stray pieces if needed.');
}

// ───────────────────────── controls ─────────────────────────
function syncControls() {
  const p = state.params;
  $('threshold').value = p.threshold;
  $('smoothing').value = Math.round(p.smoothing * 100);
  $('fill').checked = !!p.fillCavities;
  $('join').checked = !!p.joinParts;
  $('joints').checked = !!p.separateJoints;
  $('tidy').checked = p.dropVessels !== false;
  $('gap').value = p.closeGapMm;
  let mi = 0;
  for (let i = 0; i < MIN_PART_STEPS.length; i++) if (MIN_PART_STEPS[i] <= p.minPartMm3) mi = i;
  $('minpart').value = mi;
  $('peg').value = p.pegDiameterMm;
  $('peggap').value = p.maxPegGapMm;
  updateOutputs();
}

function updateOutputs() {
  const p = state.params;
  if (!p) return;
  $('threshold-out').textContent = `${p.threshold} HU`;
  $('smoothing-out').textContent = `${Math.round(p.smoothing * 100)} %`;
  $('gap-out').textContent = p.closeGapMm > 0 ? `${fmt(p.closeGapMm * 2, 1)} mm` : 'off';
  $('minpart-out').textContent = p.minPartMm3 > 0 ? `${fmt(p.minPartMm3)} mm³` : 'keep all';
  $('peg-out').textContent = `${fmt(p.pegDiameterMm, 1)} mm`;
  $('peggap-out').textContent = `${fmt(p.maxPegGapMm)} mm`;
  const isAuto = state.auto && TRACKED.every((k) => p[k] === state.auto[k]) && !p.crop && !p.removeSeeds.length && !p.keepSeeds.length;
  const chip = $('btn-auto');
  chip.classList.toggle('on', !!isAuto);
  chip.textContent = isAuto ? 'Auto ✓' : 'Reset to auto';
  const nRemoved = p.removeSeeds.length;
  const row = $('parts-row');
  row.hidden = !nRemoved && !p.keepSeeds.length;
  $('parts-text').textContent = p.keepSeeds.length
    ? `Showing only the ${p.keepSeeds.length === 1 ? 'piece' : `${p.keepSeeds.length} pieces`} you chose${nRemoved ? ` (${nRemoved} removed)` : ''}.`
    : `${nRemoved} piece${nRemoved === 1 ? '' : 's'} removed by you.`;
  $('peg').disabled = $('peggap').disabled = !p.joinParts;
}

function readControls() {
  const p = state.params;
  p.threshold = Number($('threshold').value);
  p.smoothing = Number($('smoothing').value) / 100;
  p.fillCavities = $('fill').checked;
  p.joinParts = $('join').checked;
  p.separateJoints = $('joints').checked;
  p.dropVessels = $('tidy').checked;
  p.dropStrays = $('tidy').checked;
  p.closeGapMm = Number($('gap').value);
  p.minPartMm3 = MIN_PART_STEPS[Number($('minpart').value)] ?? 25;
  p.pegDiameterMm = Number($('peg').value);
  p.maxPegGapMm = Number($('peggap').value);
  p.crop = readCrop();
}

function readCrop() {
  const box = state.info && state.info.worldBox;
  if (!box) return null;
  const ids = [['crop-x0', 'crop-x1'], ['crop-y0', 'crop-y1'], ['crop-z0', 'crop-z1']];
  let any = false;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  ids.forEach(([a, b], axis) => {
    let lo = Number($(a).value);
    let hi = Number($(b).value);
    if (lo > hi - 2) { if (document.activeElement === $(a)) hi = Math.min(100, lo + 2); else lo = Math.max(0, hi - 2); $(a).value = lo; $(b).value = hi; }
    if (lo > 0 || hi < 100) any = true;
    const span = box.max[axis] - box.min[axis];
    min[axis] = lo <= 0 ? -1e9 : box.min[axis] + (span * lo) / 100;
    max[axis] = hi >= 100 ? 1e9 : box.min[axis] + (span * hi) / 100;
  });
  return any ? { min, max } : null;
}

function resetCropSliders() {
  for (const id of ['crop-x0', 'crop-y0', 'crop-z0']) $(id).value = 0;
  for (const id of ['crop-x1', 'crop-y1', 'crop-z1']) $(id).value = 100;
}

// Parameter changed → quick preview on the coarse grid, then the full-quality model.
function changed({ immediate = false } = {}) {
  if (!state.info) return;
  state.version++;
  state.lastChange = performance.now();
  setDownloadsEnabled(false);
  updateOutputs();
  renderSlice();
  drawHistogram();
  clearTimeout(state.timers.draft);
  clearTimeout(state.timers.final);
  if (state.info.draftVoxel) {
    state.timers.draft = setTimeout(() => requestMesh('draft'), immediate ? 0 : 90);
  } else {
    state.timers.final = setTimeout(() => requestMesh('final'), immediate ? 0 : 280);
  }
}

function requestMesh(quality) {
  if (!state.info) return;
  state.jobId++;
  $('viewer-error').hidden = true;
  worker.postMessage({
    type: 'mesh',
    jobId: state.jobId,
    quality,
    version: state.version,
    params: { ...state.params },
  });
  state.pending = { jobId: state.jobId, quality, version: state.version };
  if (quality === 'final') onProgress({ scope: 'mesh', fraction: 0, label: 'Building the model…' });
}

function onMesh(m) {
  if (!state.pending || m.jobId !== state.pending.jobId) return; // superseded
  const { version, quality } = state.pending;
  $('progress').hidden = true;
  const mesh = m.mesh;
  clearSelection(); // piece ids belong to the previous mesh
  state.mesh = { parts: mesh.parts, pegs: mesh.pegs, stats: mesh.stats, quality, offset: mesh.offset };
  if (!mesh.indices.length) {
    viewer.clear();
    const el = $('viewer-error');
    el.textContent = 'Nothing is above the bone threshold with these settings. Lower the threshold, or press “Reset to auto”.';
    el.hidden = false;
  } else {
    viewer.setMesh(mesh, { keepCamera: !state.firstMesh });
    state.firstMesh = false;
  }
  $('quality-badge').hidden = quality === 'final';
  renderStats();
  if (quality === 'draft') {
    if (version === state.version) {
      const wait = Math.max(0, state.lastChange + 420 - performance.now());
      clearTimeout(state.timers.final);
      state.timers.final = setTimeout(() => requestMesh('final'), wait);
    }
  } else if (version === state.version) {
    state.finalVersion = version;
    setDownloadsEnabled(mesh.indices.length > 0);
  }
}

// ───────────────────────── stats & size ─────────────────────────
function renderStats() {
  const bar = $('statsbar');
  bar.textContent = '';
  const m = state.mesh;
  if (!m || !m.stats || !m.stats.triangles) { updateFit(); return; }
  const s = m.stats;
  const k = state.scale;
  const add = (label, value, cls) => {
    const span = document.createElement('span');
    span.append(label + ' ');
    const b = document.createElement('b');
    b.textContent = value;
    if (cls) b.className = cls;
    span.appendChild(b);
    bar.appendChild(span);
  };
  add('Size', s.sizeMm.map((v) => fmt(v * k, 0)).join(' × ') + ' mm');
  add('Volume', fmt((s.volumeMm3 * k * k * k) / 1000, 1) + ' cm³');
  add('Pieces', String(s.parts) + (m.pegs && m.pegs.length ? ` · ${m.pegs.length} peg${m.pegs.length === 1 ? '' : 's'}` : ''));
  add('Triangles', fmt(s.triangles));
  if (m.quality === 'final') add('Mesh', s.watertight ? 'watertight ✓' : 'needs repair in slicer', s.watertight ? 'good' : 'bad');
  const tidied = (s.vesselsDropped || 0) + (s.strayDropped || 0);
  if (tidied) add('Auto-removed', `${tidied} vessel / wire / stray piece${tidied === 1 ? '' : 's'}`);
  if (s.unconnectedParts > 0 && state.params.joinParts) {
    add('', `${s.unconnectedParts} piece${s.unconnectedParts === 1 ? '' : 's'} too far apart to peg — click to remove, or raise “Longest peg”`, 'bad');
  }
  updateFit();
}

function fitScale() {
  const m = state.mesh;
  if (!m || !m.stats || !m.stats.sizeMm) return 1;
  const [x, y, z] = m.stats.sizeMm;
  return Math.min(PLATE_LIMIT / x, PLATE_LIMIT / y, PLATE_LIMIT / z);
}

function updateFit() {
  const note = $('fit-note');
  const btn = $('btn-fit');
  note.textContent = '';
  btn.hidden = true;
  const m = state.mesh;
  if (!m || !m.stats || !m.stats.triangles) return;
  const max = fitScale();
  const div = document.createElement('div');
  if (state.scale > max + 1e-6) {
    div.textContent = `Too large for the A1 plate (256 mm) at ${Math.round(state.scale * 100)} %. Largest that fits as oriented: ${Math.floor(max * 100)} % — or rotate / cut it in the slicer.`;
    btn.hidden = false;
  } else {
    div.className = state.scale === 1 ? 'good' : 'info';
    div.textContent = state.scale === 1 ? 'True size (1 : 1) — fits the A1 plate.' : `Fits the A1 plate at ${Math.round(state.scale * 100)} %.`;
  }
  note.appendChild(div);
}

function setScale(pct) {
  pct = Math.max(10, Math.min(400, Math.round(pct) || 100));
  $('scale').value = pct;
  state.scale = pct / 100;
  if (viewer) viewer.setScale(state.scale);
  renderStats();
}

// ───────────────────────── slice preview & histogram ─────────────────────────
function setSliceAxis(axis, index) {
  const dims = state.info.dims;
  state.slice.axis = axis;
  const n = dims[axis];
  const pos = $('slice-pos');
  pos.max = n - 1;
  pos.value = index == null ? Math.floor(n / 2) : index;
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', Number(b.dataset.axis) === axis);
  requestSlice();
}

function requestSlice() {
  if (!state.info) return;
  state.slice.reqId++;
  worker.postMessage({ type: 'slice', reqId: state.slice.reqId, axis: state.slice.axis, index: Number($('slice-pos').value) });
}

function onSlice(m) {
  if (m.reqId !== state.slice.reqId) return;
  Object.assign(state.slice, { data: m.data, width: m.width, height: m.height });
  renderSlice();
}

const sliceBuffer = document.createElement('canvas');
function renderSlice() {
  const s = state.slice;
  if (!s.data || !state.params) return;
  const { width: w, height: h, data } = s;
  sliceBuffer.width = w; sliceBuffer.height = h;
  const bctx = sliceBuffer.getContext('2d');
  const img = bctx.createImageData(w, h);
  const px = img.data;
  const t = state.params.threshold;
  const lo = -250; const range = 1500; // display window
  // The engine thresholds a lightly smoothed volume; do the same here (3×3 binomial per smoothing step) so the
  // orange overlay shows what will really be picked up instead of raw image noise.
  let field = data;
  const passes = state.params.smoothing >= 0.75 ? 2 : state.params.smoothing >= 0.3 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const src = field; const dst = new Float32Array(w * h); const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) tmp[o + x] = (src[o + (x > 0 ? x - 1 : x)] + 2 * src[o + x] + src[o + (x < w - 1 ? x + 1 : x)]) / 4;
    }
    for (let y = 0; y < h; y++) {
      const o = y * w; const up = (y > 0 ? y - 1 : y) * w; const dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) dst[o + x] = (tmp[up + x] + 2 * tmp[o + x] + tmp[dn + x]) / 4;
    }
    field = dst;
  }
  for (let i = 0, n = w * h; i < n; i++) {
    const v = data[i];
    let g = ((v - lo) / range) * 255;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    const o = i * 4;
    if (field[i] >= t) { px[o] = 150 + g * 0.41; px[o + 1] = 80 + g * 0.42; px[o + 2] = 10 + g * 0.2; } else { px[o] = px[o + 1] = px[o + 2] = g * 0.85; }
    px[o + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);
  const canvas = $('slice');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = Math.min(canvas.width / w, canvas.height / h);
  ctx.imageSmoothingEnabled = k < 2.5;
  ctx.drawImage(sliceBuffer, (canvas.width - w * k) / 2, (canvas.height - h * k) / 2, w * k, h * k);
}

function drawHistogram() {
  const canvas = $('hist');
  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const hist = state.info && state.info.analysis.histogram;
  if (!hist || !state.params) return;
  const slider = $('threshold');
  const lo = Number(slider.min); const hi = Number(slider.max);
  const { min, binWidth, counts } = hist;
  const cols = 150;
  const vals = new Float64Array(cols);
  let peak = 0;
  for (let c = 0; c < cols; c++) {
    const a = lo + ((hi - lo) * c) / cols;
    const b = lo + ((hi - lo) * (c + 1)) / cols;
    let sum = 0;
    for (let bin = Math.max(0, Math.floor((a - min) / binWidth)); bin < counts.length && min + bin * binWidth < b; bin++) sum += counts[bin];
    vals[c] = Math.log1p(sum);
    if (vals[c] > peak) peak = vals[c];
  }
  if (!peak) return;
  const t = state.params.threshold;
  const cw = W / cols;
  for (let c = 0; c < cols; c++) {
    const hu = lo + ((hi - lo) * (c + 0.5)) / cols;
    const h = (vals[c] / peak) * (H - 4);
    ctx.fillStyle = hu >= t ? '#f0a23b' : '#465263';
    ctx.fillRect(c * cw, H - h, Math.ceil(cw) - 1, h);
  }
  const auto = state.auto && state.auto.threshold;
  if (auto != null) {
    const x = ((auto - lo) / (hi - lo)) * W;
    ctx.fillStyle = '#4ecb8f';
    ctx.fillRect(x - 1, 0, 2, H);
  }
}

// ───────────────────────── part picking ─────────────────────────
// Click toggles a piece in the selection; the action bar then removes the selection or keeps only it.
const selected = new Map(); // part id -> part (of the mesh currently shown)
function clearSelection() {
  selected.clear();
  $('part-menu').hidden = true;
  if (viewer) viewer.setHighlight([]);
}
function onPick(hit) {
  if (!hit || !state.mesh) { clearSelection(); return; }
  const part = state.mesh.parts.find((p) => p.id === hit.partId);
  if (!part) return; // a peg, or nothing
  if (selected.has(part.id)) selected.delete(part.id); else selected.set(part.id, part);
  if (!selected.size) { clearSelection(); return; }
  viewer.setHighlight(selected.keys());
  let vol = 0;
  for (const p of selected.values()) vol += p.volumeMm3;
  const n = selected.size;
  $('part-title').textContent = `${n} of ${state.mesh.parts.length} piece${state.mesh.parts.length === 1 ? '' : 's'} selected · ${fmt(vol / 1000, vol < 10000 ? 2 : 1)} cm³`;
  $('part-remove').textContent = n === 1 ? 'Remove it' : `Remove these ${n}`;
  $('part-keep').textContent = n === 1 ? 'Keep only this' : `Keep only these ${n}`;
  $('part-keep').hidden = state.mesh.parts.length <= n;
  $('part-remove').hidden = state.mesh.parts.length <= n;
  $('part-menu').hidden = false;
}

function applyPick(kind) {
  if (!selected.size) return;
  const p = state.params;
  const seeds = [...selected.values()].map((q) => q.seed);
  state.history.push({ removeSeeds: p.removeSeeds, keepSeeds: p.keepSeeds });
  if (kind === 'remove') p.removeSeeds = [...p.removeSeeds, ...seeds];
  else p.keepSeeds = seeds;
  clearSelection();
  changed({ immediate: true });
}

// ───────────────────────── downloads ─────────────────────────
function setDownloadsEnabled(on) {
  $('dl-stl').disabled = !on;
  $('dl-3mf').disabled = !on;
}
function setDownloadBusy(busy, which) {
  for (const id of ['dl-stl', 'dl-3mf']) {
    const b = $(id);
    b.disabled = busy || state.finalVersion !== state.version;
    b.textContent = busy && id === which ? 'Preparing…' : id === 'dl-stl' ? 'Download STL' : 'Download 3MF';
  }
}
function download(format) {
  if (state.finalVersion !== state.version) return;
  setDownloadBusy(true, format === 'stl' ? 'dl-stl' : 'dl-3mf');
  worker.postMessage({ type: 'export', format, scale: state.scale, reqId: Date.now() });
}
function onExported(m) {
  setDownloadBusy(false);
  const scale = state.scale === 1 ? '' : `-${Math.round(state.scale * 100)}pct`;
  const name = `bone-model${scale}.${m.format}`; // deliberately generic: nothing from the scan goes into the name
  const type = m.format === '3mf' ? 'model/3mf' : 'model/stl';
  const url = URL.createObjectURL(new Blob([m.bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${name} (${fmt(m.bytes.byteLength / 1048576, 1)} MB)`);
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ───────────────────────── view switching & wiring ─────────────────────────
function showWorkspace(on) {
  $('intro').hidden = on;
  $('workspace').hidden = !on;
  $('btn-new').hidden = !on;
  document.body.classList.toggle('working', on);
  if (on && !viewer) {
    viewer = new Viewer($('viewer'));
    viewer.onPick = onPick;
    viewer.setScale(state.scale);
  }
  if (on && viewer) viewer.resize();
}

function init() {
  const drop = $('drop');
  const pick = (input) => { input.value = ''; input.click(); };
  $('btn-folder').addEventListener('click', (e) => { e.stopPropagation(); pick($('in-folder')); });
  $('btn-files').addEventListener('click', (e) => { e.stopPropagation(); pick($('in-files')); });
  // Clicking the box itself opens the FOLDER chooser: a CT study is a folder, and a file dialog (macOS in particular)
  // cannot select one. Loose files and zips go through the "Choose files or .zip" button.
  // (The hidden inputs live inside the box, so their own programmatic click bubbles up to it: ignore those, or a
  // second chooser would open on top of the one the buttons asked for.)
  drop.addEventListener('click', (e) => { if (!e.target.closest('input, button')) pick($('in-folder')); });
  drop.addEventListener('keydown', (e) => { if (e.target === drop && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick($('in-folder')); } });
  $('in-folder').addEventListener('change', (e) => startScan([...e.target.files]));
  $('in-files').addEventListener('change', (e) => startScan([...e.target.files]));

  // Drag & drop anywhere on the page.
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('over'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('over'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    if (!e.dataTransfer) return;
    const files = await filesFromDrop(e.dataTransfer);
    if (!$('workspace').hidden) newScan();
    startScan(files);
  });

  $('btn-new').addEventListener('click', newScan);
  $('series').addEventListener('change', (e) => loadSeries(e.target.value));
  $('detail').addEventListener('change', (e) => {
    if (!state.info) return;
    setDownloadsEnabled(false);
    onProgress({ scope: 'load', fraction: 0.3, label: 'Resampling…' });
    worker.postMessage({ type: 'prepare', detail: e.target.value });
  });
  $('focus').addEventListener('change', (e) => {
    if (!state.info) return;
    setDownloadsEnabled(false);
    state.firstMesh = true; // the model changes extent: re-frame the camera
    onProgress({ scope: 'load', fraction: 0.3, label: 'Resampling…' });
    worker.postMessage({ type: 'prepare', focus: e.target.checked });
  });

  for (const id of ['threshold', 'smoothing', 'gap', 'minpart', 'peg', 'peggap', 'crop-x0', 'crop-x1', 'crop-y0', 'crop-y1', 'crop-z0', 'crop-z1']) {
    $(id).addEventListener('input', () => { if (state.params) { readControls(); changed(); } });
  }
  for (const id of ['fill', 'join', 'joints', 'tidy']) {
    $(id).addEventListener('change', () => { if (state.params) { readControls(); changed({ immediate: true }); } });
  }
  $('btn-auto').addEventListener('click', () => {
    if (!state.auto) return;
    state.params = { ...state.auto, removeSeeds: [], keepSeeds: [], crop: null };
    state.history = [];
    resetCropSliders();
    syncControls();
    changed({ immediate: true });
  });
  $('crop-reset').addEventListener('click', (e) => { e.preventDefault(); resetCropSliders(); readControls(); changed({ immediate: true }); });
  $('parts-undo').addEventListener('click', () => {
    const last = state.history.pop();
    if (!last) { state.params.removeSeeds = []; state.params.keepSeeds = []; } else Object.assign(state.params, last);
    changed({ immediate: true });
  });
  $('parts-reset').addEventListener('click', () => {
    state.history = [];
    state.params.removeSeeds = [];
    state.params.keepSeeds = [];
    changed({ immediate: true });
  });
  $('part-remove').addEventListener('click', () => applyPick('remove'));
  $('part-keep').addEventListener('click', () => applyPick('keep'));
  $('part-clear').addEventListener('click', clearSelection);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSelection(); });

  for (const b of document.querySelectorAll('.view-buttons button')) b.addEventListener('click', () => viewer && viewer.setView(b.dataset.view));
  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => state.info && setSliceAxis(Number(b.dataset.axis)));
  $('slice-pos').addEventListener('input', requestSlice);

  $('scale').addEventListener('change', (e) => setScale(Number(e.target.value)));
  $('btn-fit').addEventListener('click', () => setScale(Math.floor(fitScale() * 100)));
  $('dl-stl').addEventListener('click', () => download('stl'));
  $('dl-3mf').addEventListener('click', () => download('3mf'));
}

function newScan() {
  worker.postMessage({ type: 'reset' });
  state.scan = null; state.info = null; state.params = null; state.auto = null; state.mesh = null;
  state.version++;
  clearTimeout(state.timers.draft); clearTimeout(state.timers.final);
  if (viewer) viewer.clear();
  $('progress').hidden = true;
  $('viewer-error').hidden = true;
  $('intro-error').hidden = true;
  $('scan-status').hidden = true;
  setScale(100);
  showWorkspace(false);
}

init();
