// Metal implant removal: plates, screws, nails and wires are far denser than any bone. They are cut out of the volume
// before anything else happens, so the model shows the bone with the screw holes and without the plate.

/**
 * @param hu Int16Array raw (unsmoothed) HU of the working grid
 * @returns {{ hu: Int16Array (a copy with metal replaced by soft-tissue density), voxels: number }}
 */
export function removeMetal(hu, dims, voxel, { metalHU = 2500, growHU = Math.min(2100, metalHU), marginMm = 0.7, fillHU = 30 } = {}) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny, N = plane * nz;
  const metal = new Uint8Array(N);
  let stack = new Int32Array(1 << 14), sp = 0, count = 0;
  const push = (i) => { if (sp === stack.length) { const b = new Int32Array(sp * 2); b.set(stack); stack = b; } stack[sp++] = i; };
  // certain metal, then everything bright that is connected to it (partial-volume rim of thin screws)
  for (let i = 0; i < N; i++) if (hu[i] >= metalHU) { metal[i] = 1; push(i); count++; }
  if (!count) return { hu, voxels: 0 };
  while (sp) {
    const v = stack[--sp];
    const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
    for (let dz = z > 0 ? -1 : 0; dz <= (z < nz - 1 ? 1 : 0); dz++) for (let dy = y > 0 ? -1 : 0; dy <= (y < ny - 1 ? 1 : 0); dy++) for (let dx = x > 0 ? -1 : 0; dx <= (x < nx - 1 ? 1 : 0); dx++) {
      const u = v + dx + dy * nx + dz * plane;
      if (!metal[u] && hu[u] >= growHU) { metal[u] = 1; push(u); count++; }
    }
  }
  // margin: metal blooms in CT (it looks bigger than it is) and is ringed by a partial-volume shell that would
  // otherwise survive as a thin crust of "bone"
  const steps = Math.max(1, Math.round(marginMm / voxel));
  let frontier = [];
  for (let i = 0; i < N; i++) if (metal[i]) frontier.push(i);
  for (let s = 0; s < steps; s++) {
    const next = [];
    const full = s % 2 === 1; // alternate 6- and 26-neighbourhoods for a rounder margin
    for (const v of frontier) {
      const x = v % nx, t = (v / nx) | 0, y = t % ny, z = (t / ny) | 0;
      for (let dz = z > 0 ? -1 : 0; dz <= (z < nz - 1 ? 1 : 0); dz++) for (let dy = y > 0 ? -1 : 0; dy <= (y < ny - 1 ? 1 : 0); dy++) for (let dx = x > 0 ? -1 : 0; dx <= (x < nx - 1 ? 1 : 0); dx++) {
        if (!full && (dx !== 0) + (dy !== 0) + (dz !== 0) !== 1) continue;
        const u = v + dx + dy * nx + dz * plane;
        if (!metal[u]) { metal[u] = 1; next.push(u); count++; }
      }
    }
    frontier = next;
  }
  const out = hu.slice();
  for (let i = 0; i < N; i++) if (metal[i]) out[i] = fillHU;
  return { hu: out, voxels: count };
}
