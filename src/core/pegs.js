// Connector pegs between separate parts: closest-point search (coarse feature transform + full-res refine),
// Kruskal spanning forest, capsule rasterisation into the scalar field.
import { invertSteps } from './affine.js';

const INF = 1e30;

/** Exact squared EDT with feature (nearest source index) on a small grid. src: Int32 labels (>0 = source). */
function featureEDT(src, dims) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const d2 = new Float64Array(N);
  const ft = new Int32Array(N).fill(-1);
  for (let r = 0, nr = ny * nz; r < nr; r++) {
    const b = r * nx;
    let last = -1;
    for (let x = 0; x < nx; x++) {
      if (src[b + x] > 0) last = x;
      ft[b + x] = last < 0 ? -1 : b + last;
      d2[b + x] = last < 0 ? INF : (x - last) * (x - last);
    }
    last = -1;
    for (let x = nx - 1; x >= 0; x--) {
      if (src[b + x] > 0) last = x;
      if (last >= 0) {
        const dd = (last - x) * (last - x);
        if (dd < d2[b + x]) { d2[b + x] = dd; ft[b + x] = b + last; }
      }
    }
  }
  const maxN = Math.max(ny, nz, 1);
  const f = new Float64Array(maxN), fi = new Int32Array(maxN), v = new Int32Array(maxN), z = new Float64Array(maxN + 1);
  const pass = (n, stride, starts) => {
    for (const s0 of starts) {
      let any = false;
      for (let q = 0, p = s0; q < n; q++, p += stride) { f[q] = d2[p]; fi[q] = ft[p]; if (f[q] < INF) any = true; }
      if (!any) continue;
      let k = -1;
      for (let q = 0; q < n; q++) {
        if (f[q] >= INF) continue;
        if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
        const a = f[q] + q * q;
        let s;
        for (;;) { const pp = v[k]; s = (a - (f[pp] + pp * pp)) / (2 * (q - pp)); if (s <= z[k]) k--; else break; }
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0, p = s0; q < n; q++, p += stride) {
        while (z[k + 1] < q) k++;
        const dq = q - v[k];
        d2[p] = dq * dq + f[v[k]];
        ft[p] = fi[v[k]];
      }
    }
  };
  const sy = [], sz = [];
  for (let zz = 0; zz < nz; zz++) for (let x = 0; x < nx; x++) sy.push(x + plane * zz);
  pass(ny, nx, sy);
  if (nz > 1) { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) sz.push(x + nx * y); pass(nz, plane, sz); }
  return { d2, ft };
}

/**
 * @param labels Int32 part labels (1..nParts) on the work grid
 * @param partSize voxel counts per part (index = part id)
 * @returns { pegs:[{a,b,gapMm,A,B,radius}], unconnected }
 */
export function planPegs(labels, dims, grid, nParts, partSize, { pegDiameterMm = 3, maxPegGapMm = 20 } = {}) {
  const [nx, ny, nz] = dims;
  const voxel = grid.voxel;
  const f = nx * ny * nz > 1.5e6 ? 2 : 1;
  const cx = Math.ceil(nx / f), cy = Math.ceil(ny / f), cz = Math.ceil(nz / f);
  const cl = new Int32Array(cx * cy * cz);
  for (let z = 0; z < nz; z++) {
    const cz0 = ((z / f) | 0) * cx * cy;
    for (let y = 0; y < ny; y++) {
      const c0 = cz0 + ((y / f) | 0) * cx;
      let i = nx * (y + ny * z);
      for (let x = 0; x < nx; x++, i++) {
        const l = labels[i];
        if (l > 0) { const c = c0 + ((x / f) | 0); if (!cl[c]) cl[c] = l; }
      }
    }
  }
  const { d2, ft } = featureEDT(cl, [cx, cy, cz]);
  const P = nParts + 1;
  const dense = P * P <= 4e6;
  const best = dense ? new Float64Array(P * P).fill(Infinity) : null;
  const bestA = dense ? new Int32Array(P * P) : null, bestB = dense ? new Int32Array(P * P) : null;
  const sparse = dense ? null : new Map();
  const maxHalf = (maxPegGapMm / 2) / (voxel * f) + 2;
  const maxHalf2 = maxHalf * maxHalf;
  const cplane = cx * cy;
  const consider = (c, c2) => {
    const fa = ft[c], fb = ft[c2];
    if (fa < 0 || fb < 0) return;
    const la = cl[fa], lb = cl[fb];
    if (la === lb) return;
    const ax = fa % cx, at = (fa / cx) | 0, ay = at % cy, az = (at / cy) | 0;
    const bx = fb % cx, bt = (fb / cx) | 0, by = bt % cy, bz = (bt / cy) | 0;
    const dd = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
    const lo = la < lb ? la : lb, hi = la < lb ? lb : la;
    const ca = la < lb ? fa : fb, cb = la < lb ? fb : fa;
    if (dense) {
      const key = lo * P + hi;
      if (dd < best[key]) { best[key] = dd; bestA[key] = ca; bestB[key] = cb; }
    } else {
      const key = lo * P + hi;
      const e = sparse.get(key);
      if (!e || dd < e[0]) sparse.set(key, [dd, ca, cb]);
    }
  };
  for (let z = 0; z < cz; z++) for (let y = 0; y < cy; y++) {
    let c = cx * (y + cy * z);
    for (let x = 0; x < cx; x++, c++) {
      if (d2[c] > maxHalf2) continue;
      if (x < cx - 1) consider(c, c + 1);
      if (y < cy - 1) consider(c, c + cx);
      if (z < cz - 1) consider(c, c + cplane);
    }
  }
  const cands = [];
  if (dense) {
    for (let a = 1; a < P; a++) for (let b = a + 1; b < P; b++) {
      const key = a * P + b;
      if (best[key] < Infinity) cands.push([a, b, bestA[key], bestB[key]]);
    }
  } else for (const [key, e] of sparse) cands.push([(key / P) | 0, key % P, e[1], e[2]]);

  // refine at full resolution in world mm
  const sX = grid.stepX, sY = grid.stepY, sZ = grid.stepZ;
  const world = (i, j, k) => [i * sX[0] + j * sY[0] + k * sZ[0], i * sX[1] + j * sY[1] + k * sZ[1], i * sX[2] + j * sY[2] + k * sZ[2]];
  const gather = (c, lab) => {
    const x = c % cx, t = (c / cx) | 0, y = t % cy, z = (t / cy) | 0;
    const pts = [];
    for (let k = Math.max(0, (z - 1) * f); k < Math.min(nz, (z + 2) * f); k++)
      for (let j = Math.max(0, (y - 1) * f); j < Math.min(ny, (y + 2) * f); j++)
        for (let i = Math.max(0, (x - 1) * f); i < Math.min(nx, (x + 2) * f); i++)
          if (labels[i + nx * (j + ny * k)] === lab) pts.push(i, j, k);
    return pts;
  };
  const links = [];
  for (const [a, b, ca, cb] of cands) {
    const pa = gather(ca, a), pb = gather(cb, b);
    if (!pa.length || !pb.length) continue;
    let bd = Infinity, bi = 0, bj = 0;
    for (let s = 0; s < pa.length; s += 3) {
      const wa = world(pa[s], pa[s + 1], pa[s + 2]);
      for (let t = 0; t < pb.length; t += 3) {
        const wb = world(pb[t], pb[t + 1], pb[t + 2]);
        const d = (wa[0] - wb[0]) ** 2 + (wa[1] - wb[1]) ** 2 + (wa[2] - wb[2]) ** 2;
        if (d < bd) { bd = d; bi = s; bj = t; }
      }
    }
    const gap = Math.max(0, Math.sqrt(bd) - voxel);
    if (gap > maxPegGapMm) continue;
    links.push({ a, b, gap, ia: [pa[bi], pa[bi + 1], pa[bi + 2]], ib: [pb[bj], pb[bj + 1], pb[bj + 2]] });
  }
  links.sort((u, v) => u.gap - v.gap);
  // Kruskal
  const par = new Int32Array(P);
  for (let i = 0; i < P; i++) par[i] = i;
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const radius = pegDiameterMm / 2;
  const ext = 1.5 + radius;
  const pegs = [];
  for (const L of links) {
    const ra = find(L.a), rb = find(L.b);
    if (ra === rb) continue;
    par[ra] = rb;
    const A = world(...L.ia), B = world(...L.ib);
    let d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const len = Math.hypot(...d) || 1;
    d = d.map((c) => c / len);
    const o = grid.origin;
    const A2 = [0, 1, 2].map((q) => o[q] + A[q] - d[q] * ext);
    const B2 = [0, 1, 2].map((q) => o[q] + B[q] + d[q] * ext);
    pegs.push({ a: L.a, b: L.b, gapMm: L.gap, lengthMm: len + 2 * ext, A: A2, B: B2, radius });
  }
  // groups: unconnected = parts not in the group with the largest total volume
  const gsize = new Float64Array(P);
  for (let p = 1; p < P; p++) gsize[find(p)] += partSize[p];
  let bestG = -1;
  for (let p = 1; p < P; p++) if (bestG < 0 || gsize[find(p)] > gsize[bestG]) bestG = find(p);
  let unconnected = 0;
  for (let p = 1; p < P; p++) if (find(p) !== bestG) unconnected++;
  return { pegs, unconnected, candidates: links.length };
}

/** Rasterise capsules into the Int16 field F: F = max(F, (radius - dist_mm) * slope). */
export function rasterPegs(F, dims, grid, pegs, slope = 300) {
  const [nx, ny, nz] = dims;
  const inv = invertSteps(grid.stepX, grid.stepY, grid.stepZ);
  const o = grid.origin, sX = grid.stepX, sY = grid.stepY, sZ = grid.stepZ;
  const toIdx = (p) => {
    const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
    return [inv[0] * dx + inv[1] * dy + inv[2] * dz, inv[3] * dx + inv[4] * dy + inv[5] * dz, inv[6] * dx + inv[7] * dy + inv[8] * dz];
  };
  const minStep = Math.min(Math.hypot(...sX), Math.hypot(...sY), Math.hypot(...sZ));
  for (const pg of pegs) {
    const a = toIdx(pg.A), b = toIdx(pg.B);
    const reach = (pg.radius + 2 * grid.voxel) / minStep * 1.8 + 1;
    const lo = [0, 1, 2].map((q) => Math.max(0, Math.floor(Math.min(a[q], b[q]) - reach)));
    const hi = [0, 1, 2].map((q, _, __) => Math.min(dims[q] - 1, Math.ceil(Math.max(a[q], b[q]) + reach)));
    const ab = [pg.B[0] - pg.A[0], pg.B[1] - pg.A[1], pg.B[2] - pg.A[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    const cutoff = pg.radius + 2 * grid.voxel;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) {
      // world of (0,j,k) relative to A
      let px = o[0] + j * sY[0] + k * sZ[0] - pg.A[0];
      let py = o[1] + j * sY[1] + k * sZ[1] - pg.A[1];
      let pz = o[2] + j * sY[2] + k * sZ[2] - pg.A[2];
      px += lo[0] * sX[0]; py += lo[0] * sX[1]; pz += lo[0] * sX[2];
      let idx = lo[0] + nx * (j + ny * k);
      for (let i = lo[0]; i <= hi[0]; i++, idx++, px += sX[0], py += sX[1], pz += sX[2]) {
        let t = (px * ab[0] + py * ab[1] + pz * ab[2]) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * ab[0], ey = py - t * ab[1], ez = pz - t * ab[2];
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (dist > cutoff) continue;
        let v = Math.round((pg.radius - dist) * slope);
        if (v === 0) v = -1;
        if (v > 32767) v = 32767;
        if (v > F[idx]) F[idx] = v;
      }
    }
    void nz;
  }
}
