// Mesh utilities: directed-edge CSR, Taubin smoothing, statistics/manifold check, compaction, components.

/** CSR of directed edges a->b taken from triangle winding (a,b),(b,c),(c,a). */
export function directedCSR(indices, nv) {
  const nt = indices.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const adj = new Uint32Array(indices.length);
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    adj[fill[a]++] = b; adj[fill[b]++] = c; adj[fill[c]++] = a;
  }
  return { start, adj };
}

/** Taubin lambda/mu smoothing with uniform umbrella weights (in place). */
export function taubinSmooth(positions, indices, iterations, lambda = 0.5, mu = -0.53, csr = null) {
  if (iterations <= 0) return positions;
  const nv = positions.length / 3;
  const { start, adj } = csr || directedCSR(indices, nv);
  // undirected neighbour lists: in a closed oriented manifold outgoing edges cover every neighbour exactly once.
  const tmp = new Float32Array(positions.length);
  const step = (src, dst, f) => {
    for (let v = 0; v < nv; v++) {
      const s = start[v], e = start[v + 1];
      const x = src[3 * v], y = src[3 * v + 1], z = src[3 * v + 2];
      if (e === s) { dst[3 * v] = x; dst[3 * v + 1] = y; dst[3 * v + 2] = z; continue; }
      let ax = 0, ay = 0, az = 0;
      for (let k = s; k < e; k++) { const w = adj[k] * 3; ax += src[w]; ay += src[w + 1]; az += src[w + 2]; }
      const inv = 1 / (e - s);
      dst[3 * v] = x + f * (ax * inv - x);
      dst[3 * v + 1] = y + f * (ay * inv - y);
      dst[3 * v + 2] = z + f * (az * inv - z);
    }
  };
  for (let it = 0; it < iterations; it++) {
    step(positions, tmp, lambda);
    step(tmp, positions, mu);
  }
  return positions;
}

/**
 * Mesh statistics: signed volume (divergence theorem), area, bbox, manifold/watertight check.
 * watertight: every directed edge a->b occurs exactly once and its reverse b->a occurs exactly once.
 */
export function meshStats(positions, indices) {
  const nv = positions.length / 3, nt = indices.length / 3;
  let vol = 0, area = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2];
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let q = 0; q < 3; q++) {
    const p = positions[3 * v + q];
    if (p < min[q]) min[q] = p; if (p > max[q]) max[q] = p;
  }
  const { boundaryEdges, nonManifoldEdges, degenerate } = edgeCheck(indices, nv);
  return {
    volumeMm3: vol / 6, areaMm2: area / 2,
    bboxMin: nv ? min : [0, 0, 0], bboxMax: nv ? max : [0, 0, 0],
    sizeMm: nv ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0],
    triangles: nt, vertices: nv,
    boundaryEdges, nonManifoldEdges, degenerateTriangles: degenerate,
    watertight: nt > 0 && boundaryEdges === 0 && nonManifoldEdges === 0,
  };
}

export function edgeCheck(indices, nv, csr = null) {
  const { start, adj } = csr || directedCSR(indices, nv);
  let boundary = 0, nonManifold = 0, degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) degenerate++;
  }
  for (let v = 0; v < nv; v++) {
    const s = start[v], e = start[v + 1];
    for (let k = s; k < e; k++) {
      const w = adj[k];
      // duplicates of v->w (same direction): non-manifold / inconsistent orientation
      let dup = 0;
      for (let k2 = s; k2 < e; k2++) if (adj[k2] === w) dup++;
      if (dup > 1) { nonManifold++; continue; }
      // reverse w->v
      let rev = 0;
      for (let k2 = start[w], e2 = start[w + 1]; k2 < e2; k2++) if (adj[k2] === v) rev++;
      if (rev === 0) boundary++;
      else if (rev > 1) nonManifold++;
    }
  }
  return { boundaryEdges: boundary, nonManifoldEdges: nonManifold, degenerate };
}

/** Remove unused vertices (and index-degenerate triangles); carries per-vertex Uint16 attribute. */
export function compactMesh(positions, indices, vertexPart) {
  const nv = positions.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  let nt = 0;
  const out = new Uint32Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) continue;
    out[nt * 3] = a; out[nt * 3 + 1] = b; out[nt * 3 + 2] = c; nt++;
  }
  let m = 0;
  for (let i = 0; i < nt * 3; i++) { const v = out[i]; if (remap[v] < 0) remap[v] = m++; out[i] = remap[v]; }
  const p2 = new Float32Array(m * 3), vp2 = new Uint16Array(m);
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    p2[3 * r] = positions[3 * v]; p2[3 * r + 1] = positions[3 * v + 1]; p2[3 * r + 2] = positions[3 * v + 2];
    if (vertexPart) vp2[r] = vertexPart[v];
  }
  return { positions: p2, indices: nt * 3 === out.length ? out : out.slice(0, nt * 3), vertexPart: vp2 };
}

/** Connected components of the mesh (vertex union-find over triangles). Returns { count, comp: Int32Array per vertex }. */
export function meshComponents(indices, nv) {
  const par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]), b = find(indices[t + 1]), c = find(indices[t + 2]);
    if (a !== b) par[a] = b;
    const b2 = find(b);
    if (c !== b2) par[c] = b2;
  }
  const used = new Uint8Array(nv);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;
  const comp = new Int32Array(nv).fill(-1), id = new Int32Array(nv).fill(-1);
  let count = 0;
  for (let v = 0; v < nv; v++) {
    if (!used[v]) continue;
    const r = find(v);
    if (id[r] < 0) id[r] = count++;
    comp[v] = id[r];
  }
  return { count, comp };
}

/**
 * Remove "fins": pairs of triangles that use the same three vertices (a zero-volume flap, which edge-collapse
 * simplification occasionally leaves behind). Both triangles of a pair are dropped. Returns { indices, removed }.
 */
export function removeFins(indices) {
  const nt = indices.length / 3;
  let cap = 1;
  while (cap < nt * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const dead = new Uint8Array(nt);
  let removed = 0;
  for (let t = 0; t < nt; t++) {
    let a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    if (a > b) { const x = a; a = b; b = x; }
    if (b > c) { const x = b; b = c; c = x; }
    if (a > b) { const x = a; a = b; b = x; }
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (cap - 1);
    for (;;) {
      const u = table[h];
      if (u < 0) { table[h] = t; break; }
      if (!dead[u]) {
        let d = indices[3 * u], e = indices[3 * u + 1], f = indices[3 * u + 2];
        if (d > e) { const x = d; d = e; e = x; }
        if (e > f) { const x = e; e = f; f = x; }
        if (d > e) { const x = d; d = e; e = x; }
        if (a === d && b === e && c === f) { dead[u] = 1; dead[t] = 1; removed += 2; break; }
      }
      h = (h + 1) & (cap - 1);
    }
  }
  if (!removed) return { indices, removed: 0 };
  const out = new Uint32Array((nt - removed) * 3);
  let o = 0;
  for (let t = 0; t < nt; t++) {
    if (dead[t]) continue;
    out[o++] = indices[3 * t]; out[o++] = indices[3 * t + 1]; out[o++] = indices[3 * t + 2];
  }
  return { indices: out, removed };
}
