// 26-connected component labelling of the bone mask with per-component statistics.

function growI32(a, n) { const b = new Int32Array(Math.max(n, a.length * 2)); b.set(a); return b; }
function growF64(a, n) { const b = new Float64Array(Math.max(n, a.length * 2)); b.set(a); return b; }

/**
 * Label 26-connected components of mask (Uint8, nonzero = foreground).
 * S: Int16 field used for strong counts / seeds. Returns labels (Int32, 1..count) and per-component stats.
 */
export function labelComponents(mask, dims, S, strongLevel) {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const labels = new Int32Array(N);
  let cap = 1024;
  let size = new Int32Array(cap), strong = new Int32Array(cap), maxIdx = new Int32Array(cap);
  let sumX = new Float64Array(cap), sumY = new Float64Array(cap), sumZ = new Float64Array(cap);
  let bbox = new Int32Array(cap * 6);
  let stack = new Int32Array(1 << 20);
  const offs = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx || dy || dz) offs.push(dx + nx * dy + plane * dz);
  }
  const O = Int32Array.from(offs);
  let count = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = ++count;
    if (id >= cap) {
      cap *= 2;
      size = growI32(size, cap); strong = growI32(strong, cap); maxIdx = growI32(maxIdx, cap);
      sumX = growF64(sumX, cap); sumY = growF64(sumY, cap); sumZ = growF64(sumZ, cap);
      bbox = growI32(bbox, cap * 6);
    }
    let sp = 0;
    stack[sp++] = s; labels[s] = id;
    let n = 0, ns = 0, mi = s, mv = S[s];
    let sx = 0, sy = 0, sz = 0;
    let x0 = nx, y0 = ny, z0 = nz, x1 = -1, y1 = -1, z1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const v = S[i];
      n++;
      if (v >= strongLevel) ns++;
      if (v > mv) { mv = v; mi = i; }
      const x = i % nx, t = (i / nx) | 0, y = t % ny, z = (t / ny) | 0;
      sx += x; sy += y; sz += z;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      if (sp + 26 >= stack.length) stack = growI32(stack, stack.length * 2);
      if (x > 0 && x < nx - 1 && y > 0 && y < ny - 1 && z > 0 && z < nz - 1) {
        for (let k = 0; k < 26; k++) {
          const j = i + O[k];
          if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
        }
      } else {
        for (let dz = -1; dz <= 1; dz++) {
          const zz = z + dz; if (zz < 0 || zz >= nz) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= nx) continue;
              const j = xx + nx * (yy + ny * zz);
              if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
            }
          }
        }
      }
    }
    size[id] = n; strong[id] = ns; maxIdx[id] = mi;
    sumX[id] = sx; sumY[id] = sy; sumZ[id] = sz;
    bbox.set([x0, y0, z0, x1, y1, z1], id * 6);
  }
  return { labels, count, size, strong, maxIdx, sumX, sumY, sumZ, bbox };
}

/**
 * Find the component hit by a seed index point (continuous index coords). If the voxel is not in an
 * eligible component, search radius `rad` voxels for the nearest voxel of an eligible component.
 */
export function componentAtSeed(labels, dims, ijk, eligible, rad = 3) {
  const [nx, ny, nz] = dims;
  const ci = Math.round(ijk[0]), cj = Math.round(ijk[1]), ck = Math.round(ijk[2]);
  let best = 0, bestD = Infinity;
  for (let dz = -rad; dz <= rad; dz++) {
    const z = ck + dz; if (z < 0 || z >= nz) continue;
    for (let dy = -rad; dy <= rad; dy++) {
      const y = cj + dy; if (y < 0 || y >= ny) continue;
      for (let dx = -rad; dx <= rad; dx++) {
        const x = ci + dx; if (x < 0 || x >= nx) continue;
        const d = (x - ijk[0]) ** 2 + (y - ijk[1]) ** 2 + (z - ijk[2]) ** 2;
        if (d >= bestD || d > (rad + 0.5) ** 2) continue;
        const l = labels[x + nx * (y + ny * z)];
        if (l > 0 && eligible[l]) { best = l; bestD = d; }
      }
    }
  }
  return best;
}
