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
export function edtSquared(codes, srcLUT, dims, out, cap = Infinity) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const bounded = cap <= 12;
  const capI = bounded ? Math.ceil(cap) : Infinity;
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
        out[b + x] = m > capI ? INF : m * m;
      }
    }
  }
  if (bounded) { boundedPasses(out, dims, capI); return out; }
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

/**
 * y and z passes of a distance transform that is exact for distances <= cap (voxels) and INF beyond:
 * d2(q) = min_{|t|<=cap} f(q+t) + t^2 along each axis. Contiguous row/slice operations (cache friendly).
 */
function boundedPasses(out, dims, cap) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const tmp = new Float32Array(plane);
  // y pass, slice by slice
  for (let z = 0; z < nz; z++) {
    const base = z * plane;
    tmp.set(out.subarray(base, base + plane));
    for (let y = 0; y < ny; y++) {
      const ob = base + y * nx;
      for (let t = -cap; t <= cap; t++) {
        if (t === 0) continue;
        const yy = y + t;
        if (yy < 0 || yy >= ny) continue;
        const tb = yy * nx, t2 = t * t;
        for (let x = 0; x < nx; x++) {
          const v = tmp[tb + x] + t2;
          if (v < out[ob + x]) out[ob + x] = v;
        }
      }
    }
  }
  if (nz <= 1) return;
  // z pass with a ring of original slices
  const R = 2 * cap + 1;
  const ring = Array.from({ length: R }, () => new Float32Array(plane));
  const tag = new Int32Array(R).fill(-1);
  const get = (z) => {
    const s = z % R;
    if (tag[s] !== z) { ring[s].set(out.subarray(z * plane, (z + 1) * plane)); tag[s] = z; }
    return ring[s];
  };
  for (let z = 0; z < nz; z++) {
    // make sure every needed slice is cached before slice z is overwritten
    for (let t = -cap; t <= cap; t++) { const zz = z + t; if (zz >= 0 && zz < nz) get(zz); }
    const ob = z * plane;
    for (let t = -cap; t <= cap; t++) {
      if (t === 0) continue;
      const zz = z + t;
      if (zz < 0 || zz >= nz) continue;
      const src = ring[zz % R], t2 = t * t;
      for (let q = 0; q < plane; q++) {
        const v = src[q] + t2;
        if (v < out[ob + q]) out[ob + q] = v;
      }
    }
  }
  // clamp anything beyond the cap to INF (so callers comparing to <= cap^2 stay exact)
  const c2 = cap * cap;
  for (let i = 0, n = out.length; i < n; i++) if (out[i] > c2) out[i] = INF;
}

// ---------------------------------------------------------------------------------------------
// Solidify: seal leaks (morphological closing with radius r) + fill enclosed cavities, never fusing parts.

const ST_BG = 0, ST_PART = 1, ST_CORE = 2, ST_REACHED = 3, ST_BLOCKED = 4, ST_CAND = 5;

function lut(...codes) { const l = new Uint8Array(256); for (const c of codes) l[c] = 1; return l; }

/**
 * @param labels Int32Array part labels (0 = background), modified in place (filled voxels get the part id)
 * @returns {filled, joints} counts
 */
export function solidify(labels, dims, rVox, { fillCavities = true, separateJoints = true, sliceVote = true, nParts = 1, scratchF32 = null } = {}) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const st = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (labels[i] > 0) st[i] = ST_PART;
  const d2 = scratchF32 && scratchF32.length >= N ? scratchF32 : new Float32Array(N);
  const r2 = rVox * rVox;
  if (rVox > 0) {
    edtSquared(st, lut(ST_PART), dims, d2, rVox + 1);
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
      // Perimeter voxels may already be REACHED via a neighbouring face (faces share their edges): those must still
      // start this face's flood, otherwise the last faces processed (the z faces a limb passes through) never flood.
      const start = (a, b) => { const i = base + a * su + b * sw; if (st[i] === ST_REACHED) push(a + nu * b); else seed(a, b); };
      for (let a = 0; a < nu; a++) { start(a, 0); start(a, nw - 1); }
      for (let b = 0; b < nw; b++) { start(0, b); start(nu - 1, b); }
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
    edtSquared(st, lut(ST_REACHED), dims, d2, rVox + 1);
    for (let i = 0; i < N; i++) {
      const s = st[i];
      if (s !== ST_PART && s !== ST_REACHED && d2[i] > r2) { st[i] = ST_CAND; nCand++; }
    }
  } else {
    for (let i = 0; i < N; i++) { const s = st[i]; if (s === ST_CORE || s === ST_BLOCKED || s === ST_BG) { st[i] = ST_CAND; nCand++; } }
  }
  // --- slice-wise enclosure vote. A marrow cavity usually leaks to the outside SOMEWHERE (thin metaphyseal cortex,
  // a fracture line, a nutrient foramen wider than the seal radius), which defeats the 3D flood above and would leave
  // long bones as hollow tubes full of trabecular sponge. But in most 2D slices through it the cavity is still
  // ringed by cortex. A background voxel that is enclosed in 2D in at least two of the three orthogonal slice
  // directions is interior. Surface features stay open: a fossa or a foramen is enclosed in at most one direction,
  // a notch or groove in none. Slice borders that lie on capped volume faces (bone cut by the scan edge) are closed.
  if (fillCavities && sliceVote) {
    const reach = new Uint8Array(N); // bit a = reached from the slice border in slices perpendicular to axis a
    const dimsA = [nx, ny, nz], strideA = [1, nx, plane];
    const wall = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (st[i] === ST_PART || st[i] === ST_CAND || st[i] === ST_BLOCKED) wall[i] = 1;
    const q2d = new Int32Array(Math.max(nx * ny, nx * nz, ny * nz) + 8);
    // Caps: on each boundary face, whatever is ringed by bone within that face (the cut end of a canal, including
    // the thin layer next to the cortex that the clearance test above leaves open) is closed off.
    {
      const seenF = new Uint8Array(Math.max(nx * ny, nx * nz, ny * nz));
      for (let ax = 0; ax < 3; ax++) {
        const u = ax === 0 ? 1 : 0, w = ax === 2 ? 1 : 2;
        const nu = dimsA[u], nw = dimsA[w], su = strideA[u], sw = strideA[w];
        for (const c of dimsA[ax] > 1 ? [0, dimsA[ax] - 1] : [0]) {
          const base = c * strideA[ax];
          seenF.fill(0, 0, nu * nw);
          let top = 0;
          const tryPush = (a, b2) => { const q = a + nu * b2; if (!seenF[q] && !wall[base + a * su + b2 * sw]) { seenF[q] = 1; q2d[top++] = q; } };
          for (let a = 0; a < nu; a++) { tryPush(a, 0); tryPush(a, nw - 1); }
          for (let b2 = 0; b2 < nw; b2++) { tryPush(0, b2); tryPush(nu - 1, b2); }
          while (top > 0) {
            const q = q2d[--top];
            const a = q % nu, b2 = (q / nu) | 0;
            if (a > 0) tryPush(a - 1, b2);
            if (a < nu - 1) tryPush(a + 1, b2);
            if (b2 > 0) tryPush(a, b2 - 1);
            if (b2 < nw - 1) tryPush(a, b2 + 1);
          }
          for (let b2 = 0; b2 < nw; b2++) for (let a = 0; a < nu; a++) {
            const i = base + a * su + b2 * sw;
            if (!wall[i] && !seenF[a + nu * b2]) wall[i] = 2; // cap voxel
          }
        }
      }
    }
    for (let ax = 0; ax < 3; ax++) {
      const u = ax === 0 ? 1 : 0, w = ax === 2 ? 1 : 2;
      const nu = dimsA[u], nw = dimsA[w], su = strideA[u], sw = strideA[w], sa = strideA[ax];
      const bit = 1 << ax;
      for (let c = 0; c < dimsA[ax]; c++) {
        const base = c * sa;
        let top = 0;
        // seeds: the slice's border
        for (let a = 0; a < nu; a++) {
          let i = base + a * su;
          if (!wall[i] && !(reach[i] & bit)) { reach[i] |= bit; q2d[top++] = a; }
          i += (nw - 1) * sw;
          if (!wall[i] && !(reach[i] & bit)) { reach[i] |= bit; q2d[top++] = a + nu * (nw - 1); }
        }
        for (let b2 = 1; b2 < nw - 1; b2++) {
          let i = base + b2 * sw;
          if (!wall[i] && !(reach[i] & bit)) { reach[i] |= bit; q2d[top++] = nu * b2; }
          i += (nu - 1) * su;
          if (!wall[i] && !(reach[i] & bit)) { reach[i] |= bit; q2d[top++] = nu - 1 + nu * b2; }
        }
        while (top > 0) {
          const q = q2d[--top];
          const a = q % nu, b2 = (q / nu) | 0;
          const i = base + a * su + b2 * sw;
          let j;
          if (a > 0 && !wall[(j = i - su)] && !(reach[j] & bit)) { reach[j] |= bit; q2d[top++] = q - 1; }
          if (a < nu - 1 && !wall[(j = i + su)] && !(reach[j] & bit)) { reach[j] |= bit; q2d[top++] = q + 1; }
          if (b2 > 0 && !wall[(j = i - sw)] && !(reach[j] & bit)) { reach[j] |= bit; q2d[top++] = q - nu; }
          if (b2 < nw - 1 && !wall[(j = i + sw)] && !(reach[j] & bit)) { reach[j] |= bit; q2d[top++] = q + nu; }
        }
      }
    }
    // Axis rays: is there wall both behind and ahead of the voxel along each axis? (bits 0-2 = behind, 3-5 = ahead)
    // A canal running along an axis is ringed in the slices across it and blocked at both ends (far cortex, or the
    // cap on the scan boundary) even when it leaks sideways somewhere along its length; a pit or fossa is ringed
    // only in the plane parallel to the surface and its ray out of the bone is free.
    const ray = new Uint8Array(N);
    {
      const seenY = new Uint8Array(nx), seenZ = new Uint8Array(plane);
      for (let z = 0, i = 0; z < nz; z++) {
        seenY.fill(0);
        for (let y = 0; y < ny; y++) {
          let seenX = 0;
          const zo = y * nx;
          for (let x = 0; x < nx; x++, i++) {
            if (wall[i]) { seenX = 1; seenY[x] = 1; seenZ[zo + x] = 1; } else ray[i] = seenX | (seenY[x] << 1) | (seenZ[zo + x] << 2);
          }
        }
      }
      seenZ.fill(0);
      for (let z = nz - 1, i = N - 1; z >= 0; z--) {
        seenY.fill(0);
        for (let y = ny - 1; y >= 0; y--) {
          let seenX = 0;
          const zo = y * nx;
          for (let x = nx - 1; x >= 0; x--, i--) {
            if (wall[i]) { seenX = 1; seenY[x] = 1; seenZ[zo + x] = 1; } else ray[i] |= (seenX << 3) | (seenY[x] << 4) | (seenZ[zo + x] << 5);
          }
        }
      }
    }
    const thin = (nx < 3 ? 1 : 0) + (ny < 3 ? 1 : 0) + (nz < 3 ? 1 : 0);
    if (!thin) {
      for (let i = 0; i < N; i++) {
        if (wall[i]) {
          if (wall[i] === 2 || st[i] === ST_BLOCKED) { st[i] = ST_CAND; nCand++; }
          continue;
        }
        const e = ~reach[i] & 7; // bit a set = enclosed in the slices perpendicular to axis a
        if (!e) continue;
        const rr = ray[i];
        const capped = e & rr & (rr >> 3); // enclosed across axis a AND blocked both ways along a
        if (capped || (e & (e - 1))) { st[i] = ST_CAND; nCand++; } // ... or enclosed in two slice directions
      }
    }
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

/**
 * Final clean-up after sealing/filling: any background still completely enclosed by parts (tiny bubbles left between
 * filled regions) is absorbed into the surrounding part, so the solid has no internal voids. Returns voxels filled.
 */
export function fillEnclosed(labels, dims) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const seen = new Uint8Array(N);
  let stack = new Int32Array(1 << 16), sp = 0;
  const push = (i) => { if (sp >= stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; } stack[sp++] = i; };
  const flood = () => {
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      let j;
      if (x > 0 && !seen[(j = i - 1)] && !labels[j]) { seen[j] = 1; push(j); }
      if (x < nx - 1 && !seen[(j = i + 1)] && !labels[j]) { seen[j] = 1; push(j); }
      if (y > 0 && !seen[(j = i - nx)] && !labels[j]) { seen[j] = 1; push(j); }
      if (y < ny - 1 && !seen[(j = i + nx)] && !labels[j]) { seen[j] = 1; push(j); }
      if (z > 0 && !seen[(j = i - plane)] && !labels[j]) { seen[j] = 1; push(j); }
      if (z < nz - 1 && !seen[(j = i + plane)] && !labels[j]) { seen[j] = 1; push(j); }
    }
  };
  const seed = (i) => { if (!labels[i] && !seen[i]) { seen[i] = 1; push(i); } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const b = nx * (y + ny * z);
    if (z === 0 || z === nz - 1 || y === 0 || y === ny - 1) { for (let x = 0; x < nx; x++) seed(b + x); } else { seed(b); seed(b + nx - 1); }
  }
  flood();
  // whatever background was not reached is enclosed: give it the label of the bone next to it (raster order
  // guarantees the voxel before it in x, y or z is already labelled or was itself just filled)
  let filled = 0;
  for (let i = 0; i < N; i++) {
    if (labels[i] || seen[i]) continue;
    const x = i % nx;
    const l = (x > 0 && labels[i - 1]) || (i >= nx && labels[i - nx]) || (i >= plane && labels[i - plane]) || 0;
    if (l) { labels[i] = l; filled++; }
  }
  return filled;
}
