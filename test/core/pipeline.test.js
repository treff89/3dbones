import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareVolume, analyze, defaultParams, buildMesh, meshStats } from '../../src/core/index.js';
import { makeVolume, axisGeometry, inside, sdSphere, sdBox, countMeshComponents } from './helpers.js';

const SOFT = 40, BONE = 1000;

async function run(vol, over = {}, prepOpts = {}) {
  const work = prepareVolume(vol, prepOpts);
  const an = analyze(work);
  const params = { ...defaultParams(work, an), ...over };
  const mesh = await buildMesh(work, params);
  return { work, an, params, mesh };
}

function checkClosed(mesh) {
  const s = meshStats(mesh.positions, mesh.indices);
  assert.equal(s.boundaryEdges, 0, 'no boundary edges');
  assert.equal(s.nonManifoldEdges, 0, 'no non-manifold edges');
  assert.ok(s.watertight, 'watertight');
  assert.ok(s.volumeMm3 > 0, 'positive signed volume (outward normals)');
  assert.ok(mesh.stats.watertight);
  return s;
}

test('sphere R=10 mm, anisotropic 0.4/0.4/1.0, noisy', async () => {
  const g = axisGeometry([-20, -20, -20], [20, 20, 20], [0.4, 0.4, 1.0]);
  const vol = makeVolume(g, (x, y, z) => SOFT + (BONE - SOFT) * inside(sdSphere(x, y, z, [0, 0, 0], 10)), { noise: 15 });
  // geometric accuracy is checked at the half-way iso level (a low threshold legitimately inflates a blurred edge)
  const { mesh, an } = await run(vol, { threshold: 520 });
  assert.ok(an.threshold >= 150 && an.threshold <= 350, 'auto threshold ' + an.threshold);
  const s = checkClosed(mesh);
  assert.equal(mesh.stats.parts, 1);
  assert.equal(mesh.parts.length, 1);
  const V = (4 / 3) * Math.PI * 1000;
  assert.ok(Math.abs(s.volumeMm3 - V) / V < 0.03, `volume ${s.volumeMm3.toFixed(0)} vs ${V.toFixed(0)}`);
  for (const d of s.sizeMm) assert.ok(Math.abs(d - 20) < 0.8, 'bbox ' + s.sizeMm);
  for (const d of s.bboxMin) assert.ok(Math.abs(d) < 1e-4, 'print bbox min at 0');
  // world = print + offset -> centre near origin
  for (let q = 0; q < 3; q++) assert.ok(Math.abs(mesh.offset[q] + s.sizeMm[q] / 2) < 0.5, 'offset ' + mesh.offset);
  // with the automatic threshold the sphere is still a single closed part, slightly larger
  const auto = await run(vol);
  const s2 = checkClosed(auto.mesh);
  assert.ok(s2.volumeMm3 > V * 0.97 && s2.volumeMm3 < V * 1.2, 'auto volume ' + s2.volumeMm3);
});

function tubeVolume() {
  const g = axisGeometry([-10, -10, 0], [10, 10, 30], [0.5, 0.5, 0.5]);
  return makeVolume(g, (x, y, z) => {
    const r = Math.hypot(x, y);
    const cortex = inside(r - 6) * (1 - inside(r - 4));
    const marrow = inside(r - 4);
    return SOFT + (BONE - SOFT) * cortex + (-60 - SOFT) * marrow;
  }, { noise: 10 });
}

test('hollow tube crossing the volume: fillCavities -> solid with capped ends', async () => {
  const vol = tubeVolume();
  const { mesh } = await run(vol, { threshold: 520 });
  const s = checkClosed(mesh);
  const L = s.sizeMm[2];
  assert.ok(L > 29, 'tube spans the volume ' + L);
  const solid = Math.PI * 36 * L;
  assert.ok(Math.abs(s.volumeMm3 - solid) / solid < 0.05, `solid volume ${s.volumeMm3.toFixed(0)} vs ${solid.toFixed(0)}`);
  assert.equal(mesh.stats.parts, 1);
});

test('hollow tube: fillCavities=false stays hollow', async () => {
  const vol = tubeVolume();
  const { mesh } = await run(vol, { threshold: 520, fillCavities: false });
  const s = checkClosed(mesh);
  const L = s.sizeMm[2];
  const hollow = Math.PI * (36 - 16) * L;
  assert.ok(Math.abs(s.volumeMm3 - hollow) / hollow < 0.08, `hollow volume ${s.volumeMm3.toFixed(0)} vs ${hollow.toFixed(0)}`);
});

test('closed marrow cavity is filled even with closeGapMm = 0', async () => {
  const g = axisGeometry([-12, -12, -12], [12, 12, 12], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => {
    const d = sdSphere(x, y, z, [0, 0, 0], 8);
    return SOFT + (BONE - SOFT) * inside(d) * (1 - inside(d + 2)) + (-60 - SOFT) * inside(d + 2);
  }, { noise: 10 });
  const { mesh } = await run(vol, { threshold: 520, closeGapMm: 0 });
  const s = checkClosed(mesh);
  const V = (4 / 3) * Math.PI * 512;
  assert.ok(Math.abs(s.volumeMm3 - V) / V < 0.04, 'filled ' + s.volumeMm3);
});

function leakyShell(holeR) {
  const g = axisGeometry([-13, -13, -13], [13, 13, 13], [0.4, 0.4, 0.4]);
  return makeVolume(g, (x, y, z) => {
    const d = sdSphere(x, y, z, [0, 0, 0], 10);
    let shell = inside(d) * (1 - inside(d + 2));
    const dh = Math.hypot(y, z) - holeR; // hole drilled along +x
    if (x > 0) shell *= 1 - inside(dh, 0.3);
    return SOFT + (BONE - SOFT) * shell + (-60 - SOFT) * inside(d + 2);
  }, { noise: 10 });
}

test('shell with a small leak hole is sealed and filled', async () => {
  const vol = leakyShell(0.6);
  const V = (4 / 3) * Math.PI * 1000;
  const sealed = await run(vol, { threshold: 400, closeGapMm: 1.0 });
  const s = checkClosed(sealed.mesh);
  assert.ok(Math.abs(s.volumeMm3 - V) / V < 0.05, 'sealed+filled ' + s.volumeMm3.toFixed(0));
  // Without gap sealing the leak defeats the 3D flood, but the slice-wise enclosure vote still fills the cavity.
  const voted = await run(vol, { threshold: 400, closeGapMm: 0 });
  const s2 = checkClosed(voted.mesh);
  assert.ok(Math.abs(s2.volumeMm3 - V) / V < 0.08, 'leaky shell filled by slice vote ' + s2.volumeMm3.toFixed(0));
  // With filling switched off it stays a hollow shell.
  const hollow = await run(vol, { threshold: 400, closeGapMm: 0, fillCavities: false });
  const s3 = checkClosed(hollow.mesh);
  const shellV = V - (4 / 3) * Math.PI * 512;
  assert.ok(s3.volumeMm3 < shellV * 1.15, 'unfilled stays hollow ' + s3.volumeMm3.toFixed(0) + ' vs ' + shellV.toFixed(0));
});

function twoBlocks(gap = 1) {
  const g = axisGeometry([-14, -8, -8], [14, 8, 8], [0.3, 0.3, 0.3]);
  const h = gap / 2;
  return makeVolume(g, (x, y, z) => {
    const a = inside(sdBox(x, y, z, [-10 - h, -5, -5], [-h, 5, 5]), 0.3);
    const b = inside(sdBox(x, y, z, [h, -5, -5], [10 + h, 5, 5]), 0.3);
    return SOFT + (BONE - SOFT) * Math.max(a, b);
  }, { noise: 10 });
}

test('two blocks 1 mm apart stay separate; joinParts adds one peg -> one connected watertight mesh', async () => {
  const vol = twoBlocks(1);
  const joined = await run(vol);
  assert.equal(joined.mesh.stats.parts, 2, 'two parts');
  assert.equal(joined.mesh.pegs.length, 1, 'one peg');
  assert.equal(joined.mesh.stats.unconnectedParts, 0);
  checkClosed(joined.mesh);
  assert.equal(countMeshComponents(joined.mesh.indices, joined.mesh.positions.length / 3), 1, 'single mesh component');
  const sep = await run(vol, { joinParts: false });
  assert.equal(sep.mesh.stats.parts, 2);
  assert.equal(sep.mesh.pegs.length, 0);
  assert.equal(sep.mesh.stats.unconnectedParts, 1);
  checkClosed(sep.mesh);
  assert.equal(countMeshComponents(sep.mesh.indices, sep.mesh.positions.length / 3), 2, 'two mesh components');
  // each block keeps its volume (gap not filled)
  for (const p of sep.mesh.parts) assert.ok(Math.abs(p.volumeMm3 - 1000) < 150, 'block volume ' + p.volumeMm3);
});

test('islands: tiny specks dropped; removeSeeds / keepSeeds stable across parameter changes', async () => {
  const g = axisGeometry([-20, -12, -12], [20, 12, 12], [0.5, 0.5, 0.5]);
  const specks = [[0, 9, 9], [0, -9, 9], [3, 9, -9]];
  const vol = makeVolume(g, (x, y, z) => {
    let v = Math.max(inside(sdSphere(x, y, z, [-9, 0, 0], 8)), inside(sdSphere(x, y, z, [11, 0, 0], 5)));
    for (const c of specks) v = Math.max(v, inside(sdBox(x, y, z, [c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5]), 0.3));
    return SOFT + (BONE - SOFT) * v;
  }, { noise: 10 });
  const base = await run(vol, { joinParts: false });
  assert.equal(base.mesh.stats.parts, 2, 'two spheres kept');
  assert.ok(base.mesh.stats.droppedIslands >= 3, 'specks dropped: ' + base.mesh.stats.droppedIslands);
  const [big, small] = base.mesh.parts;
  assert.ok(big.volumeMm3 > small.volumeMm3);
  assert.ok(big.seed[0] < 0 && small.seed[0] > 0, 'seeds in world coords');

  const variants = [{}, { threshold: base.params.threshold + 120, smoothing: 0.8 }, { smoothing: 0 }];
  for (const v of variants) {
    const rm = await run(vol, { joinParts: false, removeSeeds: [small.seed], ...v });
    assert.equal(rm.mesh.stats.parts, 1);
    assert.ok(rm.mesh.parts[0].volumeMm3 > 1500, 'big sphere left');
    const kp = await run(vol, { joinParts: false, keepSeeds: [small.seed], ...v });
    assert.equal(kp.mesh.stats.parts, 1);
    assert.ok(kp.mesh.parts[0].volumeMm3 < 1000, 'small sphere isolated');
    checkClosed(kp.mesh);
  }
});

test('crop box (world) removes content outside', async () => {
  const g = axisGeometry([-20, -12, -12], [20, 12, 12], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => SOFT + (BONE - SOFT) * Math.max(inside(sdSphere(x, y, z, [-9, 0, 0], 8)), inside(sdSphere(x, y, z, [11, 0, 0], 5))), { noise: 10 });
  const { mesh } = await run(vol, { joinParts: false, crop: { min: [-30, -30, -30], max: [3, 30, 30] } });
  assert.equal(mesh.stats.parts, 1);
  checkClosed(mesh);
  assert.ok(mesh.offset[0] + mesh.stats.sizeMm[0] < 1.5);
});
