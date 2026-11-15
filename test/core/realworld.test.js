// Behaviours added after running real extremity CTs through the engine: automatic focus (couch, chest wall next to an
// arm), contrast vessels and marker wires, marrow cavities that leak, bones cut by the end of the scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareVolume, focusVolume, analyze, defaultParams, buildMesh, meshStats } from '../../src/core/index.js';
import { decimate } from '../../src/core/decimate.js';
import { makeVolume, axisGeometry, inside, sdSphere, sdBox, countMeshComponents } from './helpers.js';

const AIR = -1000, SOFT = 40, BONE = 1100;
const sdCyl = (x, y, c, R) => Math.hypot(x - c[0], y - c[1]) - R; // infinite cylinder along z
const mix = (a, b, t) => a + (b - a) * t;

/**
 * An "arm at the patient's side": limb (soft tissue + one tubular bone) near the centre of the field of view, a slab
 * of chest wall cut off by the edge of the field of view containing dense "ribs", and a thin dense couch shell below.
 */
function armBesideChest() {
  const g = axisGeometry([-100, -100, 0], [100, 100, 80], [1, 1, 2]);
  return makeVolume(g, (x, y, z) => {
    let v = AIR;
    // couch: 2 mm shell, as dense as thin bone, wide and spanning every slice
    v = mix(v, 350, inside(Math.abs(y - 80) - 1));
    // chest wall: big block leaving the field of view on the -x side; three ribs inside it
    const chest = sdBox(x, y, z, [-140, -70, -10], [-45, 60, 90]);
    v = mix(v, SOFT, inside(chest));
    for (const zc of [15, 40, 65]) v = mix(v, BONE, inside(sdBox(x, y, z, [-140, -30, zc - 5], [-60, -18, zc + 5])));
    // arm: soft-tissue cylinder with a cortical tube and fatty marrow
    const arm = sdCyl(x, y, [20, 10], 38);
    v = mix(v, SOFT, inside(arm));
    v = mix(v, BONE, inside(sdCyl(x, y, [20, 10], 11)));
    v = mix(v, -60, inside(sdCyl(x, y, [20, 10], 7)));
    return v;
  }, { noise: 12 });
}

test('focus keeps the limb, hides the cut-off chest wall and removes the couch', async () => {
  const vol = armBesideChest();
  const f = focusVolume(vol);
  assert.ok(f.active, 'focus active');
  assert.ok(f.hiddenGroups >= 1, 'ribs hidden');
  const work = prepareVolume(vol);
  // the working grid is cropped to the arm bone (22 mm tube + margins), not the whole 200 mm field of view
  assert.ok(work.dims[0] * work.voxel < 60 && work.dims[1] * work.voxel < 60, 'cropped to the limb: ' + work.dims.map((d) => (d * work.voxel).toFixed(0)));
  const mesh = await buildMesh(work, defaultParams(work, analyze(work)));
  assert.equal(mesh.stats.parts, 1, 'one bone');
  assert.ok(mesh.stats.watertight);
  const [dx, dy] = mesh.stats.sizeMm;
  assert.ok(Math.abs(dx - 22) < 2.5 && Math.abs(dy - 22) < 2.5, `tube diameter ${dx.toFixed(1)} x ${dy.toFixed(1)}`);

  // focus off: everything in the body is shown, but the couch is still gone
  const all = focusVolume(vol, { focus: false });
  assert.equal(all.hiddenGroups, 0);
  const workAll = prepareVolume(vol, { focus: false });
  const meshAll = await buildMesh(workAll, { ...defaultParams(workAll, analyze(workAll)), joinParts: false });
  assert.equal(meshAll.stats.parts, 4, 'arm bone + three ribs, no couch');
});

test('dry bone / phantom without soft tissue: nothing is masked away', async () => {
  const g = axisGeometry([-20, -20, -20], [20, 20, 20], [1, 1, 1]);
  const vol = makeVolume(g, (x, y, z) => mix(AIR, BONE, inside(sdSphere(x, y, z, [0, 0, 0], 10))));
  const f = focusVolume(vol);
  assert.equal(f.hiddenGroups, 0);
  assert.equal(f.tableRemoved, false);
  const work = prepareVolume(vol);
  const mesh = await buildMesh(work, { ...defaultParams(work, analyze(work)), threshold: 50 });
  assert.equal(mesh.stats.parts, 1);
  const V = (4 / 3) * Math.PI * 1000;
  assert.ok(Math.abs(mesh.stats.volumeMm3 - V) / V < 0.06, 'sphere volume ' + mesh.stats.volumeMm3.toFixed(0));
});

test('hollow bone crossing the scan with a side leak prints solid with capped ends', async () => {
  // cortical tube along z through the whole volume; a 5 mm window in its wall lets the outside into the canal
  const g = axisGeometry([-20, -20, 0], [20, 20, 60], [0.6, 0.6, 0.6]);
  const vol = makeVolume(g, (x, y, z) => {
    let v = SOFT;
    v = mix(v, BONE, inside(sdCyl(x, y, [0, 0], 10)));
    v = mix(v, -60, inside(sdCyl(x, y, [0, 0], 6.5)));
    v = mix(v, SOFT, inside(sdBox(x, y, z, [5, -2.5, 28], [14, 2.5, 33]))); // the leak
    return v;
  }, { noise: 10 });
  const work = prepareVolume(vol, { voxelSize: 0.6 });
  const base = { ...defaultParams(work, analyze(work)), threshold: 400, closeGapMm: 0.6 };
  const solid = await buildMesh(work, base);
  const s = meshStats(solid.positions, solid.indices);
  assert.ok(s.watertight);
  const full = Math.PI * 100 * 60;
  assert.ok(s.volumeMm3 > 0.93 * full, `solid cylinder expected, got ${(s.volumeMm3 / full * 100).toFixed(0)} % of it`);
  assert.equal(countMeshComponents(solid.indices, solid.positions.length / 3), 1, 'no internal shells left');
  const hollow = await buildMesh(work, { ...base, fillCavities: false });
  const h = meshStats(hollow.positions, hollow.indices);
  assert.ok(h.volumeMm3 < 0.75 * full, 'without filling it stays a tube');
});

test('a pit in the surface is not filled in', async () => {
  // solid block with a 6 mm wide, 6 mm deep pit: ringed by bone in one slice direction only
  const g = axisGeometry([-16, -16, -12], [16, 16, 12], [0.5, 0.5, 0.5]);
  const build = async (withPit) => {
    const vol = makeVolume(g, (x, y, z) => {
      let v = SOFT;
      v = mix(v, BONE, inside(sdBox(x, y, z, [-10, -10, -6], [10, 10, 6])));
      if (withPit) v = mix(v, SOFT, inside(sdBox(x, y, z, [-3, -3, 0], [3, 3, 8])));
      return v;
    }, { noise: 8 });
    const work = prepareVolume(vol, { voxelSize: 0.5 });
    const mesh = await buildMesh(work, { ...defaultParams(work, analyze(work)), threshold: 500 });
    return meshStats(mesh.positions, mesh.indices).volumeMm3;
  };
  const block = await build(false), pitted = await build(true);
  const pit = 6 * 6 * 6;
  assert.ok(block - pitted > 0.8 * pit, `pit must stay open: lost ${(block - pitted).toFixed(0)} of ${pit} mm3`);
});

test('contrast-filled vessels and marker wires are dropped, real bone is kept', async () => {
  const g = axisGeometry([-30, -20, 0], [30, 20, 80], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => {
    let v = SOFT;
    v = mix(v, 1300, inside(sdCyl(x, y, [-10, 0], 8))); // bone
    v = mix(v, 330, inside(sdCyl(x, y, [12, 0], 2.2))); // faint long tube = vessel with contrast
    v = mix(v, 2500, inside(sdCyl(x, y, [22, 8], 0.9))); // thin dense line = wire
    v = mix(v, 1200, inside(sdSphere(x, y, z, [12, -12, 40], 4))); // small dense round ossicle: must stay
    return v;
  }, { noise: 8 });
  const work = prepareVolume(vol, { voxelSize: 0.5, focus: false });
  const params = { ...defaultParams(work, analyze(work)), threshold: 220, joinParts: false };
  const mesh = await buildMesh(work, params);
  assert.equal(mesh.stats.parts, 2, 'bone + ossicle');
  assert.equal(mesh.stats.vesselsDropped, 2, 'vessel + wire dropped');
  const keepAll = await buildMesh(work, { ...params, dropVessels: false });
  assert.equal(keepAll.stats.parts, 4);
});

test('small bits that would hang on a long peg, or that no peg can reach, are left out', async () => {
  const g = axisGeometry([-30, -15, -15], [40, 15, 15], [0.5, 0.5, 0.5]);
  const vol = makeVolume(g, (x, y, z) => {
    let v = SOFT;
    v = mix(v, BONE, inside(sdBox(x, y, z, [-25, -8, -8], [-5, 8, 8]))); // main bone
    v = mix(v, BONE, inside(sdBox(x, y, z, [-3.5, -6, -6], [6, 6, 6]))); // second bone 1.5 mm away: pegged
    v = mix(v, BONE, inside(sdSphere(x, y, z, [18, 0, 0], 3))); // speck 9 mm away: would hang on a long peg
    v = mix(v, BONE, inside(sdSphere(x, y, z, [36, 0, 0], 2.5))); // far speck
    return v;
  }, { noise: 8 });
  const work = prepareVolume(vol, { voxelSize: 0.5, focus: false });
  const params = { ...defaultParams(work, analyze(work)), threshold: 500, maxPegGapMm: 12 };
  const mesh = await buildMesh(work, params);
  assert.equal(mesh.stats.parts, 2);
  assert.equal(mesh.pegs.length, 1);
  assert.equal(mesh.stats.strayDropped, 2);
  assert.equal(countMeshComponents(mesh.indices, mesh.positions.length / 3), 1, 'one printable piece');
  const all = await buildMesh(work, { ...params, dropStrays: false });
  assert.equal(all.stats.parts, 4);
});

test('decimation always returns a closed manifold', async () => {
  const g = axisGeometry([-20, -20, -20], [20, 20, 20], [0.4, 0.4, 0.4]);
  // lumpy shape with thin necks: the kind of surface where edge collapses can pinch
  const vol = makeVolume(g, (x, y, z) => {
    let d = sdSphere(x, y, z, [0, 0, 0], 9);
    for (const c of [[11, 0, 0], [-11, 0, 0], [0, 11, 0], [0, -11, 0], [0, 0, 11], [0, 0, -11]]) d = Math.min(d, sdSphere(x, y, z, c, 4.2));
    return mix(SOFT, BONE, inside(d));
  }, { noise: 25 });
  const work = prepareVolume(vol, { voxelSize: 0.4 });
  const raw = await buildMesh(work, { ...defaultParams(work, analyze(work)), threshold: 500, maxTriangles: 1e9, maxErrorMm: 0 });
  for (const budget of [20000, 6000, 1500]) {
    const d = await decimate(raw.positions, raw.indices, raw.vertexPart, { maxTriangles: budget, maxErrorMm: 0.05, smallMesh: 0 });
    assert.ok(d.decimated, 'decimated');
    assert.ok(d.indices.length / 3 <= budget, `within budget ${budget}`);
    const s = meshStats(d.positions, d.indices);
    assert.equal(s.boundaryEdges, 0);
    assert.equal(s.nonManifoldEdges, 0);
    assert.ok(Math.abs(s.volumeMm3 - raw.stats.volumeMm3) / raw.stats.volumeMm3 < 0.03, 'volume preserved');
  }
});
