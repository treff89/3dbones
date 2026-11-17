// Bone separation: split parts in which several bones are fused across narrow joints.
//
// At a bone threshold, neighbouring bones whose joint space is a millimetre or less (carpals, finger joints, elbow)
// touch and come out as one connected piece. Geometry alone cannot split them - a finger joint is as wide as the
// bone itself - but the CT can: each bone is a shell of dense cortex, and a joint is a thin darker sheet between two
// such shells.
//
//   1. Seeds.   Raise the threshold step by step. A component that falls apart into two or more sizeable pieces has
//               been split; follow each piece upward. The pieces that never split again are the seeds (one or more
//               patches of cortex per bone).
//   2. Regions. Grow the seeds back over the whole (solid, marrow-filled) part, brightest voxels first, so that
//               fronts from different seeds meet along the darkest sheet between them.
//   3. Verify.  A meeting surface is a JOINT only if, averaged over the surface, the CT profile across it is a valley
//               between two bright plates (subchondral bone on either side). Two cortex patches of the SAME bone meet
//               mostly through its marrow, where the profile is flat - those regions are merged again.
//   4. Carve.   A one-voxel gap (and whatever gap sealing had filled in next to it) is opened along each verified
//               joint, so every bone gets its own closed surface and can be selected, removed or kept on its own.
// Works on labels in place. Parts without a verified joint are left exactly as they were.

export const SPLIT_DEFAULTS = {
  stepHU: 60, levels: 18, // thresholds thr + stepHU * 1..levels
  minSeedMm3: 40, // a piece must be at least this big (at its threshold level) to count as a seed
  profileMm: 2.5, // how far to look on each side of a meeting surface for the bright plates
  behindMm: 6, // ... and how far behind each plate to look for the marrow that backs it
  minValleyHU: 110, valleyRatio: 0.2, // valley depth needed: max(minValleyHU, valleyRatio * (plate HU - threshold))
  minPlateHU: 100, // the plates must stand at least this far above the bone threshold
  jointShare: 0.5, // two groups stay separate only if at least this share of their common surface is joint
  backedRatio: 0.3, // behind each plate the profile must fall again by this share of the valley depth. A joint is two
  // plates of subchondral bone, each with marrow behind it; a weak line across ONE thin plate (iliac wing, scapular
  // blade) has solid cortex running on for centimetres on both sides, and is not a joint.
  minContactVoxels: 6,
  minPieceMm3: 60, // regions smaller than this are absorbed by their biggest neighbour
  reopenVoxels: 2, // how far (voxels) to re-open sealed joint space next to a carved joint line
};

class Grow {
  constructor(n = 1024) { this.a = new Int32Array(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
}

/**
 * @param labels Int32Array part labels (1..nParts, 0 = background); parts are solid (marrow filled). Modified in place:
 *        on return labels are 1..count, with carved joint voxels set to 0.
 * @param S Int16Array smoothed HU; thr bone threshold; voxel size in mm
 * @returns {{count:number, split:number, joints:number, merged:number}}
 */
export function splitBones(labels, dims, S, thr, voxel, opts = {}) {
  const o = { ...SPLIT_DEFAULTS, ...opts };
  const [nx, ny, nz] = dims;
  const plane = nx * ny, N = plane * nz;
  const voxVol = voxel * voxel * voxel;
  let nParts = 0, M = 0;
  for (let i = 0; i < N; i++) { const l = labels[i]; if (l > 0) { M++; if (l > nParts) nParts = l; } }
  const unchanged = { count: nParts, split: 0, joints: 0, merged: 0 };
  if (!M) return unchanged;
  const idx = new Int32Array(M);
  for (let i = 0, m = 0; i < N; i++) if (labels[i] > 0) idx[m++] = i;

  // ── 1. seeds: component tree over rising thresholds, built from the top level down ───────────────────────
  const node = new Int32Array(N); // id of the node (component at the most recent level) containing the voxel
  const nLevel = new Grow(), nSize = new Grow(), nRep = new Grow(), nParent = new Grow(), nFlag = new Grow(); // flag: 1 = sizeable, 2 = splits below
  for (const g of [nLevel, nSize, nRep, nParent, nFlag]) g.push(0); // node 0 = none
  const minSeedVox = Math.max(8, o.minSeedMm3 / voxVol);
  const stack = new Grow(1 << 16);
  for (let k = o.levels; k >= 0; k--) {
    const T = thr + k * o.stepHU;
    const first = nLevel.n;
    for (let m = 0; m < M; m++) {
      const s = idx[m];
      if (node[s] >= first || (k > 0 && S[s] < T)) continue;
      const id = nLevel.n;
      let size = 0, kids = 0, branch = 0;
      stack.n = 0; stack.push(s);
      const prev0 = node[s];
      node[s] = id;
      if (prev0) { nParent.a[prev0] = id; if (nFlag.a[prev0]) kids++; if (nFlag.a[prev0] & 2) branch = 1; }
      const part = labels[s];
      while (stack.n) {
        const v = stack.a[--stack.n];
        size++;
        const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
        const x0 = x > 0 ? -1 : 0, x1 = x < nx - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < ny - 1 ? 1 : 0, z0 = z > 0 ? -1 : 0, z1 = z < nz - 1 ? 1 : 0;
        for (let dz = z0; dz <= z1; dz++) for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) {
          const u = v + dx + dy * nx + dz * plane;
          const pu = node[u];
          if (pu >= first || labels[u] !== part || (k > 0 && S[u] < T)) continue;
          if (pu && !nParent.a[pu]) { nParent.a[pu] = id; if (nFlag.a[pu]) kids++; if (nFlag.a[pu] & 2) branch = 1; }
          node[u] = id;
          stack.push(u);
        }
      }
      nLevel.push(k); nSize.push(size); nRep.push(s); nParent.push(0);
      nFlag.push((size >= minSeedVox ? 1 : 0) | (branch || kids >= 2 ? 2 : 0));
    }
  }
  // seeds = sizeable nodes that never split, hanging off a node that does
  const seeds = [];
  for (let id = 1; id < nLevel.n; id++) {
    const f = nFlag.a[id];
    if ((f & 1) && !(f & 2)) { const p = nParent.a[id]; if (p && (nFlag.a[p] & 2)) seeds.push(id); }
  }
  if (seeds.length < 2) return unchanged;

  // ── 2. regions: mark the seeds, then flood the rest brightest-first ───────────────────────────────────────
  const region = node; // reuse the buffer
  for (let m = 0; m < M; m++) region[idx[m]] = 0;
  const R = seeds.length;
  const partSeeded = new Uint8Array(nParts + 1);
  const firstRegion = new Int32Array(nParts + 1);
  const binHU = 16, NB = Math.ceil((o.levels * o.stepHU) / binHU) + 3;
  const bucket = Array.from({ length: NB }, () => new Grow(256));
  const bOf = (v) => { const s = S[v]; if (s < thr) return 0; const b = 1 + (((s - thr) / binHU) | 0); return b >= NB ? NB - 1 : b; };
  for (let r = 1; r <= R; r++) {
    const id = seeds[r - 1];
    const T = thr + nLevel.a[id] * o.stepHU;
    const s = nRep.a[id];
    const part = labels[s];
    partSeeded[part] = 1;
    if (!firstRegion[part]) firstRegion[part] = r;
    stack.n = 0; stack.push(s); region[s] = r;
    while (stack.n) {
      const v = stack.a[--stack.n];
      bucket[bOf(v)].push(v);
      const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
      const x0 = x > 0 ? -1 : 0, x1 = x < nx - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < ny - 1 ? 1 : 0, z0 = z > 0 ? -1 : 0, z1 = z < nz - 1 ? 1 : 0;
      for (let dz = z0; dz <= z1; dz++) for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) {
        const u = v + dx + dy * nx + dz * plane;
        if (region[u] || labels[u] !== part || S[u] < T) continue;
        region[u] = r;
        stack.push(u);
      }
    }
  }
  for (let b = NB - 1; b >= 0; b--) {
    const q = bucket[b];
    for (let h = 0; h < q.n; h++) { // q may grow while we walk it (first in, first out)
      const v = q.a[h];
      const r = region[v], part = labels[v];
      const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
      let u;
      if (x > 0 && !region[(u = v - 1)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
      if (x < nx - 1 && !region[(u = v + 1)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
      if (y > 0 && !region[(u = v - nx)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
      if (y < ny - 1 && !region[(u = v + nx)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
      if (z > 0 && !region[(u = v - plane)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
      if (z < nz - 1 && !region[(u = v + plane)] && labels[u] === part) { region[u] = r; const bu = bOf(u); bucket[bu < b ? bu : b].push(u); }
    }
    bucket[b] = null;
  }
  // voxels of seeded parts that are only diagonally attached: take any neighbour's region, else the part's first
  for (let pass = 0; pass < 2; pass++) {
    for (let m = 0; m < M; m++) {
      const v = idx[m];
      if (region[v] || !partSeeded[labels[v]]) continue;
      const part = labels[v];
      const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
      let r = 0;
      for (let dz = z > 0 ? -1 : 0; dz <= (z < nz - 1 ? 1 : 0) && !r; dz++) for (let dy = y > 0 ? -1 : 0; dy <= (y < ny - 1 ? 1 : 0) && !r; dy++) for (let dx = x > 0 ? -1 : 0; dx <= (x < nx - 1 ? 1 : 0); dx++) {
        const u = v + dx + dy * nx + dz * plane;
        if (region[u] && labels[u] === part) { r = region[u]; break; }
      }
      if (r) region[v] = r; else if (pass) region[v] = firstRegion[part];
    }
  }

  // ── 3. verify: mean CT profile across every meeting surface ───────────────────────────────────────────────
  const Kr = Math.max(2, Math.min(8, Math.round(o.profileMm / voxel))); // where the plates are looked for
  const K = Math.max(Kr + 2, Math.min(18, Math.round(o.behindMm / voxel))); // full half-length of the profile
  const W = 2 * K + 2;
  const faces = new Map(); // key lo*(R+1)+hi -> { n:[3], sum, cnt }
  const rSize = new Int32Array(R + 1);
  const offs = [1, nx, plane], lens = [nx, ny, nz];
  for (let m = 0; m < M; m++) {
    const a = idx[m];
    const ra = region[a];
    if (!ra) continue;
    rSize[ra]++;
    const x = a % nx, t = (a / nx) | 0, y = t % ny, z = (t / ny) | 0;
    const c3 = [x, y, z];
    for (let ax = 0; ax < 3; ax++) {
      const c = c3[ax], len = lens[ax], off = offs[ax];
      if (c >= len - 1) continue;
      const b = a + off;
      const rb = region[b];
      if (!rb || rb === ra || labels[b] !== labels[a]) continue;
      const lo = ra < rb ? ra : rb, hi = ra < rb ? rb : ra;
      const key = lo * (R + 1) + hi;
      let f = faces.get(key);
      if (!f) { f = { lo, hi, n: [0, 0, 0], sum: new Float64Array(3 * W), cnt: new Int32Array(3 * W) }; faces.set(key, f); }
      f.n[ax]++;
      const base = ax * W;
      // profile index j: 0..K on the `lo` side (K = the voxel at the surface), K+1..2K+1 on the `hi` side
      for (let j = 0; j < W; j++) {
        const mOff = ra === lo ? j - K : K + 1 - j; // offset from a along the axis
        const cc = c + mOff;
        if (cc < 0 || cc >= len) continue;
        let v = S[a + mOff * off];
        if (v < thr - 200) v = thr - 200;
        f.sum[base + j] += v;
        f.cnt[base + j]++;
      }
    }
  }
  const parent = new Int32Array(R + 1);
  for (let r = 0; r <= R; r++) parent[r] = r;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const faceList = [...faces.values()];
  for (const f of faceList) {
    const total = f.n[0] + f.n[1] + f.n[2];
    let depth = 0, plate = 0, backed = 0, wsum = 0;
    for (let ax = 0; ax < 3; ax++) {
      if (f.n[ax] < 3) continue;
      const base = ax * W;
      const minCnt = Math.max(2, f.n[ax] * 0.3); // ignore offsets most profiles could not reach (volume edge)
      const mean = (j) => (f.cnt[base + j] >= minCnt ? f.sum[base + j] / f.cnt[base + j] : NaN);
      const v0 = Math.min(mean(K), mean(K + 1));
      // lo side: surface voxel at j = K, plate within Kr, marrow further out (smaller j); hi side mirrored
      let rl = -Infinity, jl = -1, rh = -Infinity, jh = -1;
      for (let j = K - 1; j >= K - Kr; j--) { const v = mean(j); if (v > rl) { rl = v; jl = j; } }
      for (let j = K + 2; j <= K + 1 + Kr; j++) { const v = mean(j); if (v > rh) { rh = v; jh = j; } }
      if (jl < 0 || jh < 0 || Number.isNaN(v0)) continue;
      let bl = rl, bh = rh; // lowest mean behind each plate
      for (let j = jl - 1; j >= 0; j--) { const v = mean(j); if (v < bl) bl = v; }
      for (let j = jh + 1; j < W; j++) { const v = mean(j); if (v < bh) bh = v; }
      depth += f.n[ax] * (Math.min(rl, rh) - v0);
      plate += f.n[ax] * Math.min(rl, rh);
      backed += f.n[ax] * Math.min(rl - bl, rh - bh);
      wsum += f.n[ax];
    }
    f.total = total;
    if (wsum) { f.depth = depth / wsum; f.plate = plate / wsum; f.backed = backed / wsum; } else { f.depth = 0; f.plate = thr; f.backed = 0; }
    f.joint = total >= o.minContactVoxels && wsum > 0
      && f.plate - thr >= o.minPlateHU
      && f.depth >= Math.max(o.minValleyHU, o.valleyRatio * (f.plate - thr))
      && f.backed >= o.backedRatio * f.depth;
  }
  // Agglomerate: two groups of regions are the same bone when most of the surface they share is NOT a joint
  // (they meet through marrow, or along a weak line in one plate). Weigh all their shared surfaces together, so a
  // single patch that happens to look like a joint cannot keep two halves of one bone apart - and vice versa.
  let merged = 0;
  for (;;) {
    const acc = new Map();
    for (const f of faceList) {
      const a = find(f.lo), b = find(f.hi);
      if (a === b) continue;
      const key = a < b ? a * (R + 1) + b : b * (R + 1) + a;
      let e = acc.get(key);
      if (!e) { e = { a, b, joint: 0, flat: 0 }; acc.set(key, e); }
      if (f.joint) e.joint += f.total; else e.flat += f.total;
    }
    let pick = null;
    for (const e of acc.values()) {
      if (e.joint >= o.jointShare * (e.joint + e.flat)) continue;
      if (!pick || e.flat > pick.flat) pick = e;
    }
    if (!pick) break;
    parent[pick.b] = pick.a; rSize[pick.a] += rSize[pick.b]; merged++;
  }
  // absorb leftovers that are too small to be a bone into their biggest neighbour
  const minPieceVox = o.minPieceMm3 / voxVol;
  const byContact = [...faces.values()].sort((a, b) => b.total - a.total);
  for (let pass = 0; pass < 2; pass++) {
    for (const f of byContact) {
      const a = find(f.lo), b = find(f.hi);
      if (a === b) continue;
      if (rSize[a] < minPieceVox || rSize[b] < minPieceVox) {
        const big = rSize[a] >= rSize[b] ? a : b, small = big === a ? b : a;
        parent[small] = big; rSize[big] += rSize[small]; merged++;
      }
    }
  }
  let joints = 0;
  {
    const seen = new Set();
    for (const f of faceList) {
      const a = find(f.lo), b = find(f.hi);
      if (a !== b) seen.add(a < b ? a * (R + 1) + b : b * (R + 1) + a);
    }
    joints = seen.size; // pairs of bones that stay separate
  }
  if (o.debug) o.debug.faces = faceList.map((f) => ({ lo: find(f.lo), hi: find(f.hi), total: f.total, depth: Math.round(f.depth), plate: Math.round(f.plate), backed: Math.round(f.backed), joint: f.joint, n: f.n.slice(), sizeLo: rSize[find(f.lo)], sizeHi: rSize[find(f.hi)] }));
  if (!joints) return unchanged;

  // ── 4. carve the joint lines, re-open sealed joint space beside them, relabel ─────────────────────────────
  const root = new Int32Array(R + 1);
  for (let r = 1; r <= R; r++) root[r] = find(r);
  const carved = new Grow(4096);
  for (let m = 0; m < M; m++) {
    const a = idx[m];
    const ra = root[region[a]];
    if (!ra) continue;
    const part = labels[a], sa = S[a];
    const x = a % nx, t = (a / nx) | 0, y = t % ny, z = (t / ny) | 0;
    let cut = false, b;
    const test = (bb) => { const rb = root[region[bb]]; return rb && rb !== ra && labels[bb] === part && (sa < S[bb] || (sa === S[bb] && a < bb)); };
    if (x > 0 && test((b = a - 1))) cut = true;
    else if (x < nx - 1 && test((b = a + 1))) cut = true;
    else if (y > 0 && test((b = a - nx))) cut = true;
    else if (y < ny - 1 && test((b = a + nx))) cut = true;
    else if (z > 0 && test((b = a - plane))) cut = true;
    else if (z < nz - 1 && test((b = a + plane))) cut = true;
    if (cut) carved.push(a);
  }
  // relabel pieces
  const pieceOf = new Int32Array(R + 1);
  const wholePart = new Int32Array(nParts + 1);
  let count = 0;
  const splitParts = new Set();
  for (let m = 0; m < M; m++) {
    const v = idx[m];
    const part = labels[v];
    if (!partSeeded[part]) { if (!wholePart[part]) wholePart[part] = ++count; continue; }
    const r = root[region[v]];
    if (!pieceOf[r]) { pieceOf[r] = ++count; splitParts.add(part); }
  }
  for (let m = 0; m < M; m++) {
    const v = idx[m];
    const part = labels[v];
    labels[v] = partSeeded[part] ? pieceOf[root[region[v]]] : wholePart[part];
  }
  // carve, then grow the cut through voxels that only gap sealing had filled (below threshold) for a few steps
  let frontier = carved;
  for (let i = 0; i < carved.n; i++) labels[carved.a[i]] = 0;
  for (let step = 0; step < o.reopenVoxels; step++) {
    const next = new Grow(Math.max(1024, frontier.n));
    for (let i = 0; i < frontier.n; i++) {
      const v = frontier.a[i];
      const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
      let u;
      if (x > 0 && labels[(u = v - 1)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
      if (x < nx - 1 && labels[(u = v + 1)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
      if (y > 0 && labels[(u = v - nx)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
      if (y < ny - 1 && labels[(u = v + nx)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
      if (z > 0 && labels[(u = v - plane)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
      if (z < nz - 1 && labels[(u = v + plane)] > 0 && S[u] < thr) { labels[u] = 0; next.push(u); }
    }
    frontier = next;
  }
  return { count, split: splitParts.size, joints, merged, seeds: R };
}
