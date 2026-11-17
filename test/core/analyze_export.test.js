import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { prepareVolume, analyze, defaultParams, buildMesh, exportSTL, export3MF, meshStats } from '../../src/core/index.js';
import { makeVolume, axisGeometry, inside, sdSphere, rng } from './helpers.js';

test('analyze: soft tissue (40±15) + bone (300-1200) -> sane threshold', () => {
  const g = axisGeometry([-20, -20, -20], [20, 20, 20], [0.5, 0.5, 0.5]);
  const r = rng(3);
  const vol = makeVolume(g, (x, y, z) => {
    const d = sdSphere(x, y, z, [0, 0, 0], 12);
    const rr = Math.hypot(x, y, z);
    if (Math.hypot(x, y) > 19) return -1000; // air around the limb
    if (d < 0) return rr > 10 ? 1200 : 300 + 200 * r(); // cortex + cancellous
    return 40;
  }, { noise: 15 });
  const work = prepareVolume(vol);
  const a = analyze(work);
  assert.ok(a.threshold >= 150 && a.threshold <= 350, 'threshold ' + a.threshold);
  assert.ok(Math.abs(a.softPeak - 40) <= 6, 'soft peak ' + a.softPeak);
  assert.ok(a.softSigma > 8 && a.softSigma < 25, 'sigma ' + a.softSigma);
  assert.equal(a.hasMetal, false);
  assert.equal(a.histogram.min, -1024);
  assert.equal(a.histogram.binWidth, 8);
  assert.ok(a.histogram.counts instanceof Uint32Array);
  assert.ok(a.boneFraction > 0 && a.boneFraction < 1);
  assert.equal(a.threshold % 5, 0);
});

test('analyze: phantom in air (no soft-tissue peak) and metal flag', () => {
  const g = axisGeometry([-15, -15, -15], [15, 15, 15], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => -1000 + 2000 * inside(sdSphere(x, y, z, [0, 0, 0], 8), 1) + (Math.hypot(x - 3, y, z) < 1.5 ? 3000 : 0), { noise: 20 });
  const work = prepareVolume(vol);
  const a = analyze(work);
  assert.equal(a.softPeak, null);
  assert.ok(a.threshold >= 100 && a.threshold <= 400, 'threshold ' + a.threshold);
  assert.equal(a.hasMetal, true);
});

test('analyze: empty (all air) falls back to 226', () => {
  const g = axisGeometry([0, 0, 0], [10, 10, 10], [1, 1, 1]);
  const work = prepareVolume(makeVolume(g, () => -1000, { noise: 5 }));
  assert.equal(analyze(work).threshold, 226);
});

test('prepareVolume: ROI, isotropic voxel, affine', () => {
  const g = axisGeometry([-30, -30, -30], [30, 30, 30], [0.4, 0.4, 1.25]);
  const vol = makeVolume(g, (x, y, z) => 40 + 960 * inside(sdSphere(x, y, z, [10, -5, 3], 6)), { noise: 10 });
  const w = prepareVolume(vol, { maxVoxels: 2e5 });
  assert.ok(w.dims[0] * w.dims[1] * w.dims[2] <= 2e5 * 1.05);
  assert.ok(Math.abs(Math.hypot(...w.stepZ) - w.voxel) < 1e-9);
  // ROI is roughly the sphere bbox + 3 mm margin (+ 2 mm cells)
  const ext = [0, 1, 2].map((a) => (w.roi.max[a] - w.roi.min[a] + 1) * vol.spacing[a]);
  for (const e of ext) assert.ok(e > 12 && e < 26, 'roi extent ' + ext);
  // maximum HU voxel near sphere centre in world coords
  let mi = 0;
  for (let i = 0; i < w.hu.length; i++) if (w.hu[i] > w.hu[mi]) mi = i;
  const [nx, ny] = w.dims;
  const x = mi % nx, y = ((mi / nx) | 0) % ny, z = (mi / (nx * ny)) | 0;
  const p = [0, 1, 2].map((q) => w.origin[q] + x * w.stepX[q] + y * w.stepY[q] + z * w.stepZ[q]);
  assert.ok(Math.hypot(p[0] - 10, p[1] + 5, p[2] - 3) < 6);
  const w2 = prepareVolume(vol, { voxelSize: 0.5 });
  assert.equal(w2.voxel, 0.5);
  assert.equal(w2.handedness, 1);
});

async function sphereMesh() {
  const g = axisGeometry([-12, -12, -12], [12, 12, 12], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => 40 + 960 * inside(sdSphere(x, y, z, [0, 0, 0], 8)), { noise: 10 });
  const w = prepareVolume(vol);
  return buildMesh(w, defaultParams(w, analyze(w)));
}

test('exportSTL: size, re-parse, volume', async () => {
  const mesh = await sphereMesh();
  const nt = mesh.indices.length / 3;
  const stl = exportSTL(mesh);
  assert.equal(stl.length, 84 + 50 * nt);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(dv.getUint32(80, true), nt);
  assert.ok(strFromU8(stl.subarray(0, 20)).startsWith('3dbones'));
  const pos = new Float32Array(nt * 9), idx = new Uint32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 9; k++) pos[t * 9 + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    idx[3 * t] = 3 * t; idx[3 * t + 1] = 3 * t + 1; idx[3 * t + 2] = 3 * t + 2;
  }
  const v1 = meshStats(pos, idx).volumeMm3, v0 = meshStats(mesh.positions, mesh.indices).volumeMm3;
  assert.ok(Math.abs(v1 - v0) / v0 < 1e-5);
  // normal of first facet points along the triangle's right-hand normal
  const n = [0, 1, 2].map((k) => dv.getFloat32(84 + 4 * k, true));
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-4);
  const stl2 = exportSTL(mesh, { scale: 2 });
  const dv2 = new DataView(stl2.buffer);
  assert.ok(Math.abs(dv2.getFloat32(84 + 12, true) - 2 * dv.getFloat32(84 + 12, true)) < 1e-4);
});

test('export3MF: zip entries, counts, millimetre unit', async () => {
  const mesh = await sphereMesh();
  const data = export3MF(mesh, { name: 'radius <L>' });
  assert.equal(data[0], 0x50); assert.equal(data[1], 0x4b); // PK
  const files = unzipSync(data);
  assert.ok(files['[Content_Types].xml']);
  assert.ok(files['_rels/.rels']);
  assert.ok(files['3D/3dmodel.model']);
  const xml = strFromU8(files['3D/3dmodel.model']);
  assert.match(xml, /<model unit="millimeter"/);
  assert.match(xml, /name="radius &lt;L&gt;"/);
  const nv = (xml.match(/<vertex /g) || []).length, nt = (xml.match(/<triangle /g) || []).length;
  assert.equal(nv, mesh.positions.length / 3);
  assert.equal(nt, mesh.indices.length / 3);
  assert.match(strFromU8(files['_rels/.rels']), /Target="\/3D\/3dmodel.model"/);
  assert.match(strFromU8(files['[Content_Types].xml']), /3dmanufacturing-3dmodel\+xml/);
  // parse back vertices and check volume
  const P = new Float32Array(nv * 3), I = new Uint32Array(nt * 3);
  let k = 0;
  for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)) { P[k++] = +m[1]; P[k++] = +m[2]; P[k++] = +m[3]; }
  k = 0;
  for (const m of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)) { I[k++] = +m[1]; I[k++] = +m[2]; I[k++] = +m[3]; }
  const v1 = meshStats(P, I).volumeMm3, v0 = mesh.stats.volumeMm3;
  assert.ok(Math.abs(v1 - v0) / v0 < 1e-3);
});

test('exportNRRD / importNRRD round-trip keeps voxels and geometry, and carries no header text beyond geometry', async () => {
  const { exportNRRD, importNRRD } = await import('../../src/core/index.js');
  const dims = [7, 5, 3];
  const hu = new Int16Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < hu.length; i++) hu[i] = ((i * 37) % 3000) - 1024;
  const grid = { dims, hu, origin: [-12.5, 30.25, 100], stepX: [0.4, 0, 0], stepY: [0, 0.38, 0.12], stepZ: [0, -0.12, 0.38] };
  const bytes = exportNRRD(grid);
  const back = importNRRD(bytes);
  assert.deepEqual(back.dims, dims);
  assert.deepEqual(Array.from(back.data), Array.from(hu));
  assert.deepEqual(back.origin, grid.origin);
  assert.deepEqual(back.stepY, grid.stepY);
  const head = new TextDecoder().decode(bytes.subarray(0, 400)).split('\n\n')[0];
  const keys = head.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('NRRD')).map((l) => l.split(':')[0]);
  assert.deepEqual(keys, ['type', 'dimension', 'space', 'sizes', 'space directions', 'kinds', 'endian', 'encoding', 'space origin']);
});
