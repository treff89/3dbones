// Synthetic CT volume builders for tests.

/** Deterministic PRNG (mulberry32) + Box-Muller normal. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  const u = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  u.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r;
    do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
    const m = Math.sqrt((-2 * Math.log(r)) / r);
    spare = y * m; return x * m;
  };
  return u;
}

/**
 * Build a Volume. `hu(x,y,z)` returns HU at a WORLD point (LPS mm).
 * geometry: { dims, origin, stepX, stepY, stepZ } ; noise: sigma HU.
 */
export function makeVolume({ dims, origin = [0, 0, 0], stepX, stepY, stepZ, spacing }, hu, { noise = 0, seed = 7 } = {}) {
  const [nx, ny, nz] = dims;
  const data = new Int16Array(nx * ny * nz);
  const r = rng(seed);
  let i = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let ii = 0; ii < nx; ii++, i++) {
    const x = origin[0] + ii * stepX[0] + j * stepY[0] + k * stepZ[0];
    const y = origin[1] + ii * stepX[1] + j * stepY[1] + k * stepZ[1];
    const z = origin[2] + ii * stepX[2] + j * stepY[2] + k * stepZ[2];
    let v = hu(x, y, z);
    if (noise) v += noise * r.normal();
    data[i] = Math.max(-1024, Math.min(32767, Math.round(v)));
  }
  const len = (a) => Math.hypot(...a);
  return { dims, data, origin, stepX, stepY, stepZ, spacing: spacing || [len(stepX), len(stepY), len(stepZ)] };
}

/** Axis-aligned geometry covering world box [lo, hi] with spacing sp. */
export function axisGeometry(lo, hi, sp) {
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.round((hi[a] - lo[a]) / sp[a]) + 1));
  return { dims, origin: lo.slice(), stepX: [sp[0], 0, 0], stepY: [0, sp[1], 0], stepZ: [0, 0, sp[2]] };
}

/** Partial-volume blend: signed distance d (mm, negative inside) -> fraction inside with ~0.5 mm ramp. */
export function inside(d, w = 0.5) {
  const t = 0.5 - d / w;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function sdSphere(x, y, z, c, R) { return Math.hypot(x - c[0], y - c[1], z - c[2]) - R; }
export function sdBox(x, y, z, lo, hi) {
  const qx = Math.max(lo[0] - x, x - hi[0]), qy = Math.max(lo[1] - y, y - hi[1]), qz = Math.max(lo[2] - z, z - hi[2]);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0);
}

/** Union-find connectivity of the mesh. */
export function countMeshComponents(indices, nv) {
  const par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let t = 0; t < indices.length; t += 3) {
    const a = f(indices[t]), b = f(indices[t + 1]); if (a !== b) par[a] = b;
    const c = f(indices[t + 2]), d = f(indices[t]); if (c !== d) par[c] = d;
  }
  const roots = new Set();
  for (let i = 0; i < indices.length; i++) roots.add(f(indices[i]));
  return roots.size;
}

function sdCapsule(x, y, z, a, b, r) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const px = x - a[0], py = y - a[1], pz = z - a[2];
  let t = (px * abx + py * aby + pz * abz) / (abx * abx + aby * aby + abz * abz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - t * abx, py - t * aby, pz - t * abz) - r;
}

/**
 * Synthetic "hand-like" multi-bone CT as a Work grid (already isotropic, identity orientation):
 * 5 long hollow bones (cortex 1.2 mm + fatty marrow), a row of small solid "carpals" with ~1.5 mm joint gaps,
 * soft-tissue envelope, air outside, Gaussian noise, a few noise specks.
 */
export function multiBoneWork(n, voxel = 0.35, { noise = 20, seed = 11 } = {}) {
  const L = n * voxel;
  const c = L / 2;
  const bones = [];
  for (let b = 0; b < 5; b++) {
    const x = c + (b - 2) * 0.17 * L;
    const r = 0.045 * L * (b === 0 ? 1.15 : 1);
    bones.push({ a: [x, c - 0.05 * L, 0.30 * L], b: [x + (b - 2) * 0.02 * L, c + 0.05 * L, 1.2 * L], r });
  }
  const carpals = [];
  for (let b = 0; b < 4; b++) carpals.push({ c: [c + (b - 1.5) * 0.17 * L, c, 0.18 * L], r: 0.07 * L });
  const data = new Int16Array(n * n * n);
  const r = rng(seed);
  const cortex = 1.2;
  let i = 0;
  for (let k = 0; k < n; k++) {
    const z = k * voxel;
    for (let j = 0; j < n; j++) {
      const y = j * voxel;
      for (let ii = 0; ii < n; ii++, i++) {
        const x = ii * voxel;
        // soft tissue envelope: ellipse cylinder along z
        const ex = (x - c) / (0.47 * L), ey = (y - c) / (0.3 * L);
        let v = ex * ex + ey * ey < 1 ? 40 : -1000;
        let best = Infinity, isLong = false;
        for (const bn of bones) { const d = sdCapsule(x, y, z, bn.a, bn.b, bn.r); if (d < best) { best = d; isLong = true; } }
        for (const cp of carpals) { const d = sdSphere(x, y, z, cp.c, cp.r); if (d < best) { best = d; isLong = false; } }
        if (best < 0.6) {
          const f = inside(best, 0.6);
          const bone = isLong ? (best < -cortex ? -80 : 1300) : (best < -cortex ? 350 : 1100);
          v = v + (bone - v) * f;
        }
        data[i] = Math.round(v + noise * r.normal());
      }
    }
  }
  // specks
  for (let s = 0; s < 30; s++) {
    const p = Math.floor(r() * (n - 2)) + n * (Math.floor(r() * (n - 2)) + n * Math.floor(r() * (n - 2)));
    data[p] = 900;
  }
  return { dims: [n, n, n], hu: data, voxel, origin: [-c, -c, 0], stepX: [voxel, 0, 0], stepY: [0, voxel, 0], stepZ: [0, 0, voxel], handedness: 1, roi: null, source: null };
}
