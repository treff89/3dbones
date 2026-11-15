// Gaussian blur, exact Euclidean distance transform, and seal/fill ("solidify").

const INF = 1e20;

/** Separable Gaussian blur of an Int16 volume (replicate borders). Returns a new Int16Array. */
export function gaussianBlurInt16(src, dims, sigma) {
  const [nx, ny, nz] = dims;
  const R = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * R + 1);
  let s = 0;
  for (let t = -R; t <= R; t++) { k[t + R] = Math.exp((-t * t) / (2 * sigma * sigma)); s += k[t + R]; }
  for (let t = 0; t < k.length; t++) k[t] /= s;
  const plane = nx * ny;
  const out = new Int16Array(src.length);
  const ringN = 2 * R + 1;
  const ring = Array.from({ length: Math.min(ringN, nz) }, () => new Float32Array(plane));
  const ringTag = new Int32Array(ring.length).fill(-1);
  const line = new Float32Array(Math.max(nx, ny) + 2 * R);
  const rowBuf = new Float32Array(plane);

  const blurSliceXY = (z, dst) => {
    const base = z * plane;
    // x pass -> rowBuf
    for (let y = 0; y < ny; y++) {
      const rb = base + y * nx;
      for (let t = 0; t < R; t++) line[t] = src[rb];
      for (let x = 0; x < nx; x++) line[x + R] = src[rb + x];
      for (let t = 0; t < R; t++) line[nx + R + t] = src[rb + nx - 1];
      const ob = y * nx;
      for (let x = 0; x < nx; x++) {
        let a = 0;
        for (let t = 0; t <= 2 * R; t++) a += k[t] * line[x + t];
        rowBuf[ob + x] = a;
      }
    }
    // y pass -> dst (row-wise accumulation for cache friendliness)
    dst.fill(0);
    for (let y = 0; y < ny; y++) {
      const ob = y * nx;
      for (let t = -R; t <= R; t++) {
        let yy = y + t; yy = yy < 0 ? 0 : yy >= ny ? ny - 1 : yy;
        const w = k[t + R], ib = yy * nx;
        for (let x = 0; x < nx; x++) dst[ob + x] += w * rowBuf[ib + x];
      }
    }
  };
  const getSlice = (z) => {
    const slot = z % ring.length;
    if (ringTag[slot] !== z) { blurSliceXY(z, ring[slot]); ringTag[slot] = z; }
    return ring[slot];
  };
  const acc = new Float32Array(plane);
  if (ring.length < ringN) {
    // few slices: no ring reuse guarantee; compute all slices once
    const all = [];
    for (let z = 0; z < nz; z++) { const b = new Float32Array(plane); blurSliceXY(z, b); all.push(b); }
    for (let z = 0; z < nz; z++) {
      acc.fill(0);
      for (let t = -R; t <= R; t++) {
        let zz = z + t; zz = zz < 0 ? 0 : zz >= nz ? nz - 1 : zz;
        const w = k[t + R], sl = all[zz];
        for (let q = 0; q < plane; q++) acc[q] += w * sl[q];
      }
      const ob = z * plane;
      for (let q = 0; q < plane; q++) out[ob + q] = Math.round(acc[q]);
    }
    return out;
  }
  for (let z = 0; z < nz; z++) {
    acc.fill(0);
    for (let t = -R; t <= R; t++) {
      let zz = z + t; zz = zz < 0 ? 0 : zz >= nz ? nz - 1 : zz;
      const w = k[t + R], sl = getSlice(zz);
      for (let q = 0; q < plane; q++) acc[q] += w * sl[q];
    }
    const ob = z * plane;
    for (let q = 0; q < plane; q++) out[ob + q] = Math.round(acc[q]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Exact squared EDT (Felzenszwalb & Huttenlocher), voxel units.

function edt1d(f, n, d, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq >= INF) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    const a = fq + q * q;
    let s;
    for (;;) {
      const p = v[k];
      s = (a - (f[p] + p * p)) / (2 * (q - p));
      if (s <= z[k]) k--; else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) return false;
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
  return true;
}

const BLK = 16;

/** passes along a strided axis using block gathering (cache friendly). */
function edtPassStrided(a, n, stride, lineStarts, scratch) {
  const { buf, out, f, d, v, z } = scratch;
  const nl = lineStarts.length;
  for (let l0 = 0; l0 < nl; l0 += BLK) {
    const m = Math.min(BLK, nl - l0);
    // lines l0..l0+m-1 are assumed to be consecutive in memory (start, start+1, ...)
    const s0 = lineStarts[l0];
    const contiguous = lineStarts[l0 + m - 1] === s0 + m - 1;
    if (contiguous) {
      for (let q = 0, p = s0; q < n; q++, p += stride) {
        for (let t = 0; t < m; t++) buf[t * n + q] = a[p + t];
      }
    } else {
      for (let t = 0; t < m; t++) for (let q = 0, p = lineStarts[l0 + t]; q < n; q++, p += stride) buf[t * n + q] = a[p];
    }
    for (let t = 0; t < m; t++) {
      const o = t * n;
      let any = false;
      for (let q = 0; q < n; q++) { const x = buf[o + q]; f[q] = x; if (x < INF) any = true; }
      if (!any) { for (let q = 0; q < n; q++) out[o + q] = INF; continue; }
      edt1d(f, n, d, v, z);
      for (let q = 0; q < n; q++) out[o + q] = d[q];
    }
    if (contiguous) {
      for (let q = 0, p = s0; q < n; q++, p += stride) {
        for (let t = 0; t < m; t++) a[p + t] = out[t * n + q];
      }
    } else {
      for (let t = 0; t < m; t++) for (let q = 0, p = lineStarts[l0 + t]; q < n; q++, p += stride) a[p] = out[t * n + q];
    }
  }
}

/**
 * Squared Euclidean distance (voxel units) from each voxel to the nearest voxel where isSource(code) holds.
 * `codes` is a Uint8Array; sources are voxels whose code is in `srcSet` (a 256-entry Uint8Array lookup).
 * Result written to `out` (Float32Array, length N). Sources get 0. Voxels with no source: >= 1e20.
 */
export function edtSquared(codes, srcLUT, dims, out) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  // x pass: two scans per row
  for (let r = 0, nr = ny * nz; r < nr; r++) {
    const b = r * nx;
    let last = -1;
    for (let x = 0; x < nx; x++) {
      if (srcLUT[codes[b + x]]) { last = x; out[b + x] = 0; }
      else out[b + x] = last < 0 ? INF : (x - last);
    }
    last = -1;
    for (let x = nx - 1; x >= 0; x--) {
      if (out[b + x] === 0) last = x;
      else {
        const dl = out[b + x];
        const dr = last < 0 ? INF : last - x;
        const m = dl < dr ? dl : dr;
        out[b + x] = m >= INF ? INF : m * m;
      }
    }
  }
  const maxN = Math.max(ny, nz);
  const scratch = {
    buf: new Float32Array(BLK * maxN), out: new Float32Array(BLK * maxN),
    f: new Float64Array(maxN), d: new Float64Array(maxN), v: new Int32Array(maxN), z: new Float64Array(maxN + 1),
  };
  // y pass: lines start at x + plane*z
  {
    const starts = new Int32Array(nx);
    for (let zz = 0; zz < nz; zz++) {
      for (let x = 0; x < nx; x++) starts[x] = x + plane * zz;
      edtPassStrided(out, ny, nx, starts, scratch);
    }
  }
  if (nz > 1) {
    const starts = new Int32Array(nx);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) starts[x] = x + nx * y;
      edtPassStrided(out, nz, plane, starts, scratch);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Solidify: seal leaks (morphological closing with radius r) + fill enclosed cavities, never fusing parts.

const ST_BG = 0, ST_PART = 1, ST_CORE = 2, ST_REACHED = 3, ST_BLOCKED = 4, ST_CAND = 5;

function lut(...codes) { const l = new Uint8Array(256); for (const c of codes) l[c] = 1; return l; }

/**
 * @param labels Int32Array part labels (0 = background), modified in place (filled voxels get the part id)
 * @returns {filled, joints} counts
 */
export function solidify(labels, dims, rVox, { fillCavities = true, separateJoints = true, nParts = 1, scratchF32 = null } = {}) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const st = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (labels[i] > 0) st[i] = ST_PART;
  const d2 = scratchF32 && scratchF32.length >= N ? scratchF32 : new Float32Array(N);
  const r2 = rVox * rVox;
  if (rVox > 0) {
    edtSquared(st, lut(ST_PART), dims, d2);
    for (let i = 0; i < N; i++) if (st[i] === ST_BG && d2[i] > r2) st[i] = ST_CORE;
  } else {
    for (let i = 0; i < N; i++) if (st[i] === ST_BG) st[i] = ST_CORE;
  }

  let stack = new Int32Array(1 << 16), sp = 0;
  const push = (i) => { if (sp >= stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; } stack[sp++] = i; };

  if (fillCavities) {
    // --- border capping: 2D floods on each boundary face from its perimeter
    const faces = [
      // [fixed axis, fixed value]
      [0, 0], [0, nx - 1], [1, 0], [1, ny - 1], [2, 0], [2, nz - 1],
    ];
    const dimsA = [nx, ny, nz], strideA = [1, nx, plane];
    for (const [ax, val] of faces) {
      if (dimsA[ax] === 1 && val !== 0) continue;
      const u = ax === 0 ? 1 : 0, w = ax === 2 ? 1 : 2;
      const nu = dimsA[u], nw = dimsA[w], su = strideA[u], sw = strideA[w];
      const base = val * strideA[ax];
      sp = 0;
      const seed = (a, b) => { const i = base + a * su + b * sw; if (st[i] === ST_CORE) { st[i] = ST_REACHED; push(a + nu * b); } };
      for (let a = 0; a < nu; a++) { seed(a, 0); seed(a, nw - 1); }
      for (let b = 0; b < nw; b++) { seed(0, b); seed(nu - 1, b); }
      while (sp > 0) {
        const c = stack[--sp];
        const a = c % nu, b = (c / nu) | 0;
        if (a > 0) seed(a - 1, b);
        if (a < nu - 1) seed(a + 1, b);
        if (b > 0) seed(a, b - 1);
        if (b < nw - 1) seed(a, b + 1);
      }
    }
    // remaining face core voxels are enclosed in 2D (exposed canals): block them; collect 3D seeds
    sp = 0;
    const markFace = (i) => { if (st[i] === ST_CORE) st[i] = ST_BLOCKED; else if (st[i] === ST_REACHED) push(i); };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const b = nx * (y + ny * z);
      if (z === 0 || z === nz - 1 || y === 0 || y === ny - 1) { for (let x = 0; x < nx; x++) markFace(b + x); }
      else { markFace(b); if (nx > 1) markFace(b + nx - 1); }
    }
    // 3D 6-connected flood through core
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      if (x > 0 && st[i - 1] === ST_CORE) { st[i - 1] = ST_REACHED; push(i - 1); }
      if (x < nx - 1 && st[i + 1] === ST_CORE) { st[i + 1] = ST_REACHED; push(i + 1); }
      if (y > 0 && st[i - nx] === ST_CORE) { st[i - nx] = ST_REACHED; push(i - nx); }
      if (y < ny - 1 && st[i + nx] === ST_CORE) { st[i + nx] = ST_REACHED; push(i + nx); }
      if (z > 0 && st[i - plane] === ST_CORE) { st[i - plane] = ST_REACHED; push(i - plane); }
      if (z < nz - 1 && st[i + plane] === ST_CORE) { st[i + plane] = ST_REACHED; push(i + plane); }
    }
  } else {
    for (let i = 0; i < N; i++) if (st[i] === ST_CORE) st[i] = ST_REACHED;
  }

  // outside = within r of reached; candidates = background \ outside
  let nCand = 0;
  if (rVox > 0) {
    edtSquared(st, lut(ST_REACHED), dims, d2);
    for (let i = 0; i < N; i++) {
      const s = st[i];
      if (s !== ST_PART && s !== ST_REACHED && d2[i] > r2) { st[i] = ST_CAND; nCand++; }
    }
  } else {
    for (let i = 0; i < N; i++) { const s = st[i]; if (s === ST_CORE || s === ST_BLOCKED || s === ST_BG) { st[i] = ST_CAND; nCand++; } }
  }
  if (nCand === 0) return { filled: 0, jointVoxels: 0, regions: 0 };

  // --- label candidate regions (6-conn), assign to parts
  const list = new Int32Array(nCand);
  const pos = new Int32Array(d2.buffer, d2.byteOffset, N); // reuse distance buffer as Int32 (region position map)
  let filled = 0, jointVoxels = 0, regions = 0;
  let labA = null, distA = null, zoneA = null;
  const D = Math.ceil(rVox * 1.75) + 1;
  const off6 = [-1, 1, -nx, nx, -plane, plane];
  const nbOK = (x, y, z, k) => (k === 0 ? x > 0 : k === 1 ? x < nx - 1 : k === 2 ? y > 0 : k === 3 ? y < ny - 1 : k === 4 ? z > 0 : z < nz - 1);
  // checks whether voxel i has a 26-neighbour belonging to a part other than p
  const otherPartNear = (i, p) => {
    const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      const zz = z + dz; if (zz < 0 || zz >= nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= nx) continue;
          const l = labels[xx + nx * (yy + ny * zz)];
          if (l > 0 && l !== p) return true;
        }
      }
    }
    return false;
  };

  for (let s0 = 0; s0 < N; s0++) {
    if (st[s0] !== ST_CAND) continue;
    regions++;
    // BFS (list doubles as queue)
    let m = 0, head = 0;
    list[m++] = s0; st[s0] = ST_BG;
    let first = 0, multi = false;
    while (head < m) {
      const i = list[head++];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      for (let k = 0; k < 6; k++) {
        if (!nbOK(x, y, z, k)) continue;
        const j = i + off6[k];
        const sj = st[j];
        if (sj === ST_CAND) { st[j] = ST_BG; list[m++] = j; }
        else if (sj === ST_PART) {
          const l = labels[j];
          if (first === 0) first = l; else if (l !== first) multi = true;
        }
      }
    }
    if (first === 0) continue;
    if (!multi || !separateJoints) {
      if (!multi) {
        for (let q = 0; q < m; q++) {
          const i = list[q];
          if (nParts > 1 && otherPartNear(i, first)) continue;
          labels[i] = first; filled++;
        }
        continue;
      }
    }
    // --- region touching several parts: geodesic Voronoi split; keep a gap zone around the meeting surface
    if (!labA || labA.length < m) { labA = new Int32Array(m); distA = new Int32Array(m); zoneA = new Int32Array(m); }
    for (let q = 0; q < m; q++) { pos[list[q]] = -(q + 1); labA[q] = 0; distA[q] = -1; zoneA[q] = -1; }
    // queue in `stack`
    sp = 0; let qh = 0;
    const q2 = [];
    for (let q = 0; q < m; q++) {
      const i = list[q];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      for (let k = 0; k < 6; k++) {
        if (!nbOK(x, y, z, k)) continue;
        const j = i + off6[k];
        if (st[j] === ST_PART) { labA[q] = labels[j]; distA[q] = 0; push(q); break; }
      }
    }
    while (qh < sp) {
      const q = stack[qh++];
      const i = list[q];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      for (let k = 0; k < 6; k++) {
        if (!nbOK(x, y, z, k)) continue;
        const j = i + off6[k];
        if (st[j] === ST_PART) continue;
        const pj = pos[j];
        if (pj >= 0) continue;
        const qq = -pj - 1;
        if (qq >= m || list[qq] !== j) continue;
        if (distA[qq] < 0) { distA[qq] = distA[q] + 1; labA[qq] = labA[q]; push(qq); }
      }
    }
    // conflict seeds: neighbour with another label (in region or part)
    sp = 0; qh = 0;
    for (let q = 0; q < m; q++) {
      const i = list[q], lq = labA[q];
      if (lq === 0) continue;
      let conflict = otherPartNear(i, lq);
      if (!conflict) {
        const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
        for (let k = 0; k < 6 && !conflict; k++) {
          if (!nbOK(x, y, z, k)) continue;
          const j = i + off6[k];
          const pj = pos[j];
          if (pj < 0) { const qq = -pj - 1; if (qq < m && list[qq] === j && labA[qq] !== 0 && labA[qq] !== lq) conflict = true; }
        }
      }
      if (conflict) { zoneA[q] = 0; push(q); }
    }
    while (qh < sp) {
      const q = stack[qh++];
      if (zoneA[q] >= D) continue;
      const i = list[q];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      for (let k = 0; k < 6; k++) {
        if (!nbOK(x, y, z, k)) continue;
        const j = i + off6[k];
        const pj = pos[j];
        if (pj >= 0) continue;
        const qq = -pj - 1;
        if (qq >= m || list[qq] !== j) continue;
        if (zoneA[qq] < 0) { zoneA[qq] = zoneA[q] + 1; push(qq); }
      }
    }
    for (let q = 0; q < m; q++) {
      if (labA[q] === 0) continue;
      if (separateJoints && zoneA[q] >= 0) { jointVoxels++; continue; }
      labels[list[q]] = labA[q]; filled++;
    }
    for (let q = 0; q < m; q++) pos[list[q]] = 0;
    void q2;
  }
  return { filled, jointVoxels, regions };
}
