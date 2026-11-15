import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareVolume, analyze, defaultParams, buildMesh, meshStats } from '../../src/core/index.js';
import { makeVolume, inside, sdBox } from './helpers.js';

// Three perpendicular bars from one corner C (world coords): +x 20 mm, +y 12 mm, +z 6 mm, 3x3 mm section.
const C = [5, -7, 12];
const H = 1.5;
function bars(x, y, z) {
  const a = sdBox(x, y, z, [C[0] - H, C[1] - H, C[2] - H], [C[0] + 20, C[1] + H, C[2] + H]);
  const b = sdBox(x, y, z, [C[0] - H, C[1] - H, C[2] - H], [C[0] + H, C[1] + 12, C[2] + H]);
  const c = sdBox(x, y, z, [C[0] - H, C[1] - H, C[2] - H], [C[0] + H, C[1] + H, C[2] + 6]);
  return 40 + 960 * inside(Math.min(a, b, c), 1.0); // ~1 mm PSF ramp (>= slice spacing)
}

const CENTER = [C[0] + 8, C[1] + 5, C[2] + 2];
const HALF = 17; // half-extent of the sampled region (mm)

function rot(ax, ay, az) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r, i) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return mul(Rz, mul(Ry, Rx));
}

/** grid with step vectors u,v,w (mm per index) centred on CENTER covering +-HALF mm. */
function geometry(u, v, w) {
  const n = [u, v, w].map((s) => Math.ceil((2 * HALF) / Math.hypot(...s)) + 1);
  const origin = [0, 1, 2].map((q) => CENTER[q] - ((n[0] - 1) / 2) * u[q] - ((n[1] - 1) / 2) * v[q] - ((n[2] - 1) / 2) * w[q]);
  return { dims: n, origin, stepX: u, stepY: v, stepZ: w };
}

const cases = {
  identity: geometry([0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.8]),
  reversedSlices: geometry([0.5, 0, 0], [0, 0.5, 0], [0, 0, -0.8]),
  flippedRows: geometry([0.5, 0, 0], [0, -0.5, 0], [0, 0, 0.8]),
  oblique: (() => { const R = rot(0.4, -0.7, 1.1); const col = (j, s) => [R[0][j] * s, R[1][j] * s, R[2][j] * s]; return geometry(col(0, 0.5), col(1, 0.5), col(2, 0.8)); })(),
  sheared: geometry([0.5, 0, 0], [0, 0.5, 0], [0, 0.25, 0.8]),
  obliqueLeftHanded: (() => { const R = rot(-0.3, 0.5, 2.0); const col = (j, s) => [R[0][j] * s, R[1][j] * s, R[2][j] * s]; return geometry(col(1, 0.5), col(0, 0.5), col(2, 0.8)); })(),
};

for (const [name, g] of Object.entries(cases)) {
  test(`chirality preserved: ${name}`, async () => {
    const vol = makeVolume(g, bars, { noise: 8 });
    const work = prepareVolume(vol);
    const p = { ...defaultParams(work, analyze(work)), threshold: 520 };
    const mesh = await buildMesh(work, p);
    const s = meshStats(mesh.positions, mesh.indices);
    assert.ok(s.watertight, 'watertight');
    assert.ok(s.volumeMm3 > 0, 'outward normals');
    const V = 3 * 3 * (21.5 + 10.5 + 4.5);
    assert.ok(Math.abs(s.volumeMm3 - V) / V < 0.12, `volume ${s.volumeMm3.toFixed(0)} vs ${V.toFixed(0)}`);
    // world-space bbox
    const P = mesh.positions, o = mesh.offset;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const tip = [null, null, null];
    for (let v = 0; v < P.length; v += 3) {
      const w = [P[v] + o[0], P[v + 1] + o[1], P[v + 2] + o[2]];
      for (let q = 0; q < 3; q++) {
        if (w[q] < lo[q]) lo[q] = w[q];
        if (w[q] > hi[q]) { hi[q] = w[q]; tip[q] = w; }
      }
    }
    const expLo = [C[0] - H, C[1] - H, C[2] - H], expHi = [C[0] + 20, C[1] + 12, C[2] + 6];
    for (let q = 0; q < 3; q++) {
      assert.ok(Math.abs(lo[q] - expLo[q]) < 0.8, `bbox min[${q}] ${lo[q].toFixed(2)} vs ${expLo[q]}`);
      assert.ok(Math.abs(hi[q] - expHi[q]) < 0.8, `bbox max[${q}] ${hi[q].toFixed(2)} vs ${expHi[q]}`);
    }
    const d = tip.map((t) => [t[0] - C[0], t[1] - C[1], t[2] - C[2]]);
    const triple = d[0][0] * (d[1][1] * d[2][2] - d[1][2] * d[2][1]) - d[0][1] * (d[1][0] * d[2][2] - d[1][2] * d[2][0]) + d[0][2] * (d[1][0] * d[2][1] - d[1][1] * d[2][0]);
    assert.ok(triple > 0, 'right-handed bar triple ' + triple);
    assert.equal(work.handedness, Math.sign(
      g.stepX[0] * (g.stepY[1] * g.stepZ[2] - g.stepY[2] * g.stepZ[1]) - g.stepX[1] * (g.stepY[0] * g.stepZ[2] - g.stepY[2] * g.stepZ[0]) + g.stepX[2] * (g.stepY[0] * g.stepZ[1] - g.stepY[1] * g.stepZ[0])));
  });
}
