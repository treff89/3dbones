// Web Worker: everything heavy happens here, on the user's own machine.
// Protocol (main → worker):
//   {type:'scan', files: File[]}                    → {type:'scanned', result}
//   {type:'load', seriesId, detail}                 → {type:'loaded', info}
//   {type:'prepare', detail?, focus?}               → {type:'loaded', info}   (re-prepare: other resolution / focus on-off)
//   {type:'mesh', jobId, params, quality}           → {type:'mesh', jobId, quality, mesh} | {type:'cancelled', jobId}
//   {type:'slice', reqId, axis, index}              → {type:'slice', reqId, axis, index, width, height, data}
//   {type:'export', format, scale, reqId}           → {type:'exported', reqId, format, bytes}
//   {type:'reset'}
// Worker → main also: {type:'progress', scope, fraction, label}, {type:'error', scope, message}
import { StudyLoader } from '../dicom/index.js';
import { setWasmBinaries } from '../dicom/codecs.js';
import { prepareVolume, focusVolume, analyze, defaultParams, buildMesh, exportSTL, export3MF } from '../core/index.js';
import charlsWasm from '@cornerstonejs/codec-charls/decodewasm';
import openjpegWasm from '@cornerstonejs/codec-openjpeg/decodewasm';

setWasmBinaries({ charls: charlsWasm, openjpeg: openjpegWasm });

// Detail presets: voxel budget for the working grid and triangle budget for the exported mesh.
const DETAIL = {
  draft: { maxVoxels: 3e6, maxTriangles: 200000 },
  standard: { maxVoxels: 14e6, maxTriangles: 500000 },
  fine: { maxVoxels: 30e6, maxTriangles: 1000000 },
};

class Cancelled extends Error {}

const loader = new StudyLoader();
let volume = null; // native-resolution HU volume of the chosen series
let work = null; // working grid for final meshes
let draft = null; // coarse working grid for interactive previews
let analysis = null;
let lastFinal = null; // last final-quality mesh (kept for export)
let detail = 'standard';
let focusOn = true; // keep only the main bone group (see core/focus.js)
let latestJob = 0;
let running = false;
let queued = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (scope, fraction, label) => post({ type: 'progress', scope, fraction, label });
const tick = () => new Promise((r) => setTimeout(r));

function fail(scope, err) {
  // Error messages come from our own modules and never contain file names or header values.
  post({ type: 'error', scope, message: (err && err.message) || String(err) });
}

async function scan(files) {
  const sources = files.map((f) => ({
    name: f.webkitRelativePath || f.name,
    size: f.size,
    read: () => f.arrayBuffer(),
  }));
  loader.reset();
  volume = work = draft = analysis = lastFinal = null;
  const result = await loader.scan(sources, (p) => progress('scan', p.total ? p.done / p.total : 0, p.message || 'Reading files…'));
  post({ type: 'scanned', result });
}

function prepare() {
  const preset = DETAIL[detail] || DETAIL.standard;
  const focusResult = focusVolume(volume, { focus: focusOn });
  work = prepareVolume(volume, { maxVoxels: preset.maxVoxels, focusResult });
  // Draft grid: twice the voxel size (≈ 8× fewer voxels) for near-instant slider feedback.
  const dv = Math.min(1.5, Math.max(work.voxel * 2, 0.5));
  draft = dv > work.voxel * 1.3 ? prepareVolume(volume, { voxelSize: dv, focusResult }) : null;
  analysis = analyze(work);
  const params = defaultParams(work, analysis);
  params.maxTriangles = preset.maxTriangles;
  lastFinal = null;
  return {
    detail,
    focus: { on: focusOn, ...work.focus },
    dims: work.dims,
    voxel: work.voxel,
    draftVoxel: draft ? draft.voxel : null,
    source: { dims: volume.dims, spacing: volume.spacing, info: volume.info },
    extentMm: work.dims.map((d) => d * work.voxel),
    // World-space (patient LPS) bounding box of the working grid, for the crop sliders.
    worldBox: worldBox(work),
    analysis: {
      threshold: analysis.threshold,
      softPeak: analysis.softPeak,
      softSigma: analysis.softSigma,
      otsu: analysis.otsu,
      hasMetal: analysis.hasMetal,
      notes: analysis.notes || [],
      histogram: analysis.histogram,
    },
    params,
  };
}

function worldBox(w) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const [nx, ny, nz] = w.dims;
  for (let c = 0; c < 8; c++) {
    const i = c & 1 ? nx - 1 : 0;
    const j = c & 2 ? ny - 1 : 0;
    const k = c & 4 ? nz - 1 : 0;
    for (let a = 0; a < 3; a++) {
      const v = w.origin[a] + i * w.stepX[a] + j * w.stepY[a] + k * w.stepZ[a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

async function load(seriesId, det, focus) {
  if (det) detail = det;
  if (typeof focus === 'boolean') focusOn = focus;
  volume = work = draft = analysis = lastFinal = null;
  progress('load', 0, 'Decoding slices…');
  volume = await loader.buildVolume(seriesId, (p) => progress('load', 0.9 * (p.total ? p.done / p.total : 0), 'Decoding slices…'));
  progress('load', 0.92, 'Finding the bones…');
  await tick();
  const info = prepare();
  progress('load', 1, 'Ready');
  post({ type: 'loaded', info });
}

async function runMesh(job) {
  const { jobId, params, quality } = job;
  const grid = quality === 'draft' && draft ? draft : work;
  if (!grid) return;
  const p = { ...params };
  if (quality === 'draft') {
    p.maxTriangles = Math.min(p.maxTriangles || 3e5, 250000);
  }
  try {
    const mesh = await buildMesh(grid, p, (fraction, label) => {
      if (jobId !== latestJob) throw new Cancelled();
      progress('mesh', fraction, label);
    });
    if (jobId !== latestJob) throw new Cancelled();
    if (quality === 'final') {
      lastFinal = {
        positions: mesh.positions.slice(),
        indices: mesh.indices.slice(),
      };
    }
    post(
      {
        type: 'mesh',
        jobId,
        quality,
        voxel: grid.voxel,
        mesh: {
          positions: mesh.positions,
          indices: mesh.indices,
          vertexPart: mesh.vertexPart,
          offset: mesh.offset,
          parts: mesh.parts,
          pegs: mesh.pegs,
          stats: mesh.stats,
        },
      },
      [mesh.positions.buffer, mesh.indices.buffer, mesh.vertexPart.buffer],
    );
  } catch (err) {
    if (err instanceof Cancelled) post({ type: 'cancelled', jobId });
    else fail('mesh', err);
  }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queued) {
      const job = queued;
      queued = null;
      await runMesh(job);
      await tick();
    }
  } finally {
    running = false;
  }
}

function slice(reqId, axis, index) {
  const g = work;
  if (!g) return;
  const [nx, ny, nz] = g.dims;
  const hu = g.hu;
  let width, height, data;
  if (axis === 2) {
    const k = Math.max(0, Math.min(nz - 1, index));
    width = nx; height = ny;
    data = hu.slice(k * nx * ny, (k + 1) * nx * ny);
  } else if (axis === 1) {
    const j = Math.max(0, Math.min(ny - 1, index));
    width = nx; height = nz;
    data = new Int16Array(width * height);
    for (let k = 0; k < nz; k++) {
      const src = nx * (j + ny * k);
      data.set(hu.subarray(src, src + nx), (nz - 1 - k) * nx);
    }
  } else {
    const i = Math.max(0, Math.min(nx - 1, index));
    width = ny; height = nz;
    data = new Int16Array(width * height);
    for (let k = 0; k < nz; k++) {
      const row = (nz - 1 - k) * ny;
      for (let j = 0; j < ny; j++) data[row + j] = hu[i + nx * (j + ny * k)];
    }
  }
  post({ type: 'slice', reqId, axis, index, width, height, data }, [data.buffer]);
}

function doExport(reqId, format, scale) {
  if (!lastFinal) throw new Error('The model is still being prepared — try again in a moment.');
  const bytes = format === '3mf' ? export3MF(lastFinal, { scale, name: 'bone' }) : exportSTL(lastFinal, { scale });
  post({ type: 'exported', reqId, format, bytes }, [bytes.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'scan':
        await scan(m.files);
        break;
      case 'load':
        latestJob = -1;
        await load(m.seriesId, m.detail, m.focus);
        break;
      case 'prepare':
        if (!volume) break;
        latestJob = -1;
        if (m.detail) detail = m.detail;
        if (typeof m.focus === 'boolean') focusOn = m.focus;
        progress('load', 0.5, 'Resampling…');
        await tick();
        post({ type: 'loaded', info: prepare(), keepParams: true });
        break;
      case 'mesh':
        latestJob = m.jobId;
        queued = m;
        pump();
        break;
      case 'slice':
        slice(m.reqId, m.axis, m.index);
        break;
      case 'export':
        doExport(m.reqId, m.format, m.scale || 1);
        break;
      case 'reset':
        latestJob = -1;
        loader.reset();
        volume = work = draft = analysis = lastFinal = null;
        break;
    }
  } catch (err) {
    fail(m.type, err);
  }
};
