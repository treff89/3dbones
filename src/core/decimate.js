// Error-bounded decimation with meshoptimizer, keeping the mesh watertight.
import { MeshoptSimplifier } from 'meshoptimizer';
import { compactMesh, directedCSR, removeFins } from './meshops.js';

const NO_ATTR = new Float32Array(0);

/** Vertices lying on boundary or non-manifold edges of an indexed mesh (ids in the given index space). */
function problemVertices(indices, nv) {
  const { start, adj } = directedCSR(indices, nv);
  const bad = [];
  for (let v = 0; v < nv; v++) {
    const s = start[v], e = start[v + 1];
    for (let k = s; k < e; k++) {
      const w = adj[k];
      let dup = 0;
      for (let k2 = s; k2 < e; k2++) if (adj[k2] === w) dup++;
      let rev = 0;
      for (let k2 = start[w], e2 = start[w + 1]; k2 < e2; k2++) if (adj[k2] === v) rev++;
      if (dup !== 1 || rev !== 1) bad.push(v, w);
    }
  }
  return bad;
}

/**
 * Decimate to at most maxTriangles while staying within maxErrorMm where the budget allows.
 * The result is guaranteed to be a closed, oriented 2-manifold whenever the input is: edge collapses very
 * occasionally pinch the surface (zero-volume flaps, an edge shared by four triangles); flaps are removed, and for
 * anything else the vertices around the defect are locked and the simplification is repeated from the original.
 * @returns { positions, indices, vertexPart, errorMm, attempts, decimated }
 */
export async function decimate(positions, indices, vertexPart, { maxTriangles = 600000, maxErrorMm = 0.06, smallMesh = 100000 } = {}) {
  const nt = indices.length / 3;
  const nv = positions.length / 3;
  if (nt <= maxTriangles && nt <= smallMesh) return { positions, indices, vertexPart, errorMm: 0, attempts: 0, decimated: false };
  await MeshoptSimplifier.ready;
  const target = nt > maxTriangles ? maxTriangles * 3 : 0;
  let lock = null, ring = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    attempts++;
    const run = (tgt, err) => (lock
      ? MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, NO_ATTR, 0, [], lock, tgt, err, ['ErrorAbsolute'])
      : MeshoptSimplifier.simplify(indices, positions, 3, tgt, err, ['ErrorAbsolute']));
    let [out, usedErr] = run(target, maxErrorMm);
    // error cap could not reach the budget: budget wins
    if (out.length / 3 > maxTriangles) [out, usedErr] = run(maxTriangles * 3, 1e9);
    let bad = null;
    for (let pass = 0; pass < 3; pass++) {
      const rf = removeFins(out);
      out = rf.indices;
      bad = problemVertices(out, nv);
      if (!bad.length || !rf.removed) break;
    }
    if (!bad.length) {
      const c = compactMesh(positions, out, vertexPart);
      return { ...c, errorMm: usedErr, attempts, decimated: true };
    }
    // lock the defect's neighbourhood (2 rings in the ORIGINAL mesh) and try again
    if (!lock) { lock = new Uint8Array(nv); ring = directedCSR(indices, nv); }
    let frontier = bad;
    for (let r = 0; r < 3; r++) {
      const next = [];
      for (const v of frontier) {
        if (lock[v]) continue;
        lock[v] = 1;
        for (let k = ring.start[v]; k < ring.start[v + 1]; k++) next.push(ring.adj[k]);
      }
      frontier = next;
    }
  }
  return { positions, indices, vertexPart, errorMm: 0, attempts, decimated: false, failed: true };
}
