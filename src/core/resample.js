// prepareVolume: ROI detection + isotropic resampling (axes stay parallel to the source index axes).
import { det3, len3, worldToIndex } from './affine.js';

const DEFAULTS = { voxelSize: null, maxVoxels: 20e6, roiThresholdHU: 200, marginMm: 3, crop: null };

/**
 * Find the bounding box (source index space) of bone-like content.
 * Coarse max-pool to ~2 mm cells, keep cells >= thr, drop coarse 26-components < 3 cells.
 */
export function findROI(volume, thr = 200, marginMm = 3, cellMm = 2) {
  const [nx, ny, nz] = volume.dims;
  const data = volume.data;
  const sp = [len3(volume.stepX), len3(volume.stepY), len3(volume.stepZ)];
  const cs = sp.map((s) => Math.max(1, Math.round(cellMm / s)));
  const cx = Math.ceil(nx / cs[0]), cy = Math.ceil(ny / cs[1]), cz = Math.ceil(nz / cs[2]);
  const cells = new Int16Array(cx * cy * cz).fill(-32768);
  const cxOf = new Int32Array(nx);
  for (let x = 0; x < nx; x++) cxOf[x] = (x / cs[0]) | 0;
  for (let z = 0; z < nz; z++) {
    const czo = ((z / cs[2]) | 0) * cx * cy;
    for (let y = 0; y < ny; y++) {
      const co = czo + ((y / cs[1]) | 0) * cx;
      let p = nx * (y + ny * z);
      for (let x = 0; x < nx; x++, p++) {
        const v = data[p];
        const c = co + cxOf[x];
        if (v > cells[c]) cells[c] = v;
      }
    }
  }
  // coarse components (26-conn)
  const nc = cells.length;
  const lab = new Int32Array(nc); // 0 = unvisited, -1 = below thr
  for (let i = 0; i < nc; i++) if (cells[i] < thr) lab[i] = -1;
  const stack = new Int32Array(nc);
  const members = new Int32Array(nc);
  let bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (let s = 0; s < nc; s++) {
    if (lab[s] !== 0) continue;
    let sp0 = 0, nm = 0;
    stack[sp0++] = s; lab[s] = 1;
    while (sp0 > 0) {
      const c = stack[--sp0];
      members[nm++] = c;
      const x = c % cx, t = (c / cx) | 0, y = t % cy, z = (t / cy) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz; if (zz < 0 || zz >= cz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= cy) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= cx) continue;
            const q = xx + cx * (yy + cy * zz);
            if (lab[q] === 0) { lab[q] = 1; stack[sp0++] = q; }
          }
        }
      }
    }
    if (nm < 3) continue;
    found = true;
    for (let m = 0; m < nm; m++) {
      const c = members[m];
      const x = c % cx, t = (c / cx) | 0, y = t % cy, z = (t / cy) | 0;
      if (x < bmin[0]) bmin[0] = x; if (x > bmax[0]) bmax[0] = x;
      if (y < bmin[1]) bmin[1] = y; if (y > bmax[1]) bmax[1] = y;
      if (z < bmin[2]) bmin[2] = z; if (z > bmax[2]) bmax[2] = z;
    }
  }
  const dims = [nx, ny, nz];
  if (!found) return { min: [0, 0, 0], max: [nx - 1, ny - 1, nz - 1], found: false };
  const min = [0, 0, 0], max = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const pad = Math.ceil(marginMm / sp[a]);
    min[a] = Math.max(0, bmin[a] * cs[a] - pad);
    max[a] = Math.min(dims[a] - 1, (bmax[a] + 1) * cs[a] - 1 + pad);
  }
  return { min, max, found: true };
}

/** Per-axis resampling weights in CSR form. */
function axisWeights(nSrc, lo, hi, s, voxel) {
  const L = (hi - lo + 1) * s;
  const n = Math.max(1, Math.round(L / voxel));
  const r = voxel / s;
  const center = (lo + hi) / 2;
  const c0 = center - ((n - 1) / 2) * r;
  const start = new Int32Array(n + 1);
  const idx = [], w = [];
  const clampI = (i) => (i < 0 ? 0 : i >= nSrc ? nSrc - 1 : i);
  for (let k = 0; k < n; k++) {
    const t = c0 + k * r;
    start[k] = idx.length;
    if (r <= 1 + 1e-6) {
      const i0 = Math.floor(t), f = t - i0;
      if (f < 1e-6) { idx.push(clampI(i0)); w.push(1); }
      else { idx.push(clampI(i0), clampI(i0 + 1)); w.push(1 - f, f); }
    } else {
      const a = t - r / 2, b = t + r / 2;
      const ia = Math.round(a), ib = Math.round(b);
      for (let i = ia; i <= ib; i++) {
        const ov = Math.min(b, i + 0.5) - Math.max(a, i - 0.5);
        if (ov > 1e-6) { idx.push(clampI(i)); w.push(ov / r); }
      }
    }
  }
  start[n] = idx.length;
  let maxTaps = 0;
  for (let k = 0; k < n; k++) maxTaps = Math.max(maxTaps, start[k + 1] - start[k]);
  return { n, c0, r, start, idx: Int32Array.from(idx), w: Float32Array.from(w), maxTaps };
}

function cropToIndexBox(volume, crop) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? crop.max[0] : crop.min[0], c & 2 ? crop.max[1] : crop.min[1], c & 4 ? crop.max[2] : crop.min[2]];
    const q = worldToIndex(volume, p);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
  }
  return { min: lo.map((v) => Math.floor(v)), max: hi.map((v) => Math.ceil(v)) };
}

export function prepareVolume(volume, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const [nx, ny, nz] = volume.dims;
  const sp = [len3(volume.stepX), len3(volume.stepY), len3(volume.stepZ)];
  const roi = findROI(volume, o.roiThresholdHU, o.marginMm);
  if (o.crop) {
    const cb = cropToIndexBox(volume, o.crop);
    for (let a = 0; a < 3; a++) {
      roi.min[a] = Math.max(roi.min[a], cb.min[a]);
      roi.max[a] = Math.min(roi.max[a], cb.max[a]);
      if (roi.max[a] < roi.min[a]) throw new Error('crop box does not intersect the volume');
    }
  }
  const ext = [0, 1, 2].map((a) => (roi.max[a] - roi.min[a] + 1) * sp[a]);
  const roiVol = ext[0] * ext[1] * ext[2];
  let voxel;
  if (o.voxelSize) voxel = o.voxelSize;
  else {
    const lo = Math.max(0.25, Math.min(sp[0], sp[1]));
    voxel = Math.min(1.5, Math.max(lo, Math.cbrt(roiVol / o.maxVoxels)));
    voxel = Math.max(0.05, Math.round(voxel * 20) / 20);
    while (ext.reduce((m, e) => m * Math.max(1, Math.round(e / voxel)), 1) > o.maxVoxels * 1.02) voxel += 0.05;
    voxel = Math.round(voxel * 100) / 100;
  }
  const W = [0, 1, 2].map((a) => axisWeights(volume.dims[a], roi.min[a], roi.max[a], sp[a], voxel));
  const [wx, wy, wz] = W;
  const mx = wx.n, my = wy.n, mz = wz.n;
  const hu = new Int16Array(mx * my * mz);
  const data = volume.data;

  // y rows needed by the y-pass
  const ringN = wz.maxTaps + 1;
  const ring = Array.from({ length: ringN }, () => new Float32Array(mx * my));
  const ringTag = new Int32Array(ringN).fill(-1);
  const rowsY = new Uint8Array(ny);
  for (let t = 0; t < wy.idx.length; t++) rowsY[wy.idx[t]] = 1;
  const tmp = new Float32Array(mx * ny); // x-resampled rows of a source slice
  const acc = new Float32Array(mx * my);

  const xySlice = (zi, out) => {
    const base = zi * nx * ny;
    for (let y = 0; y < ny; y++) {
      if (!rowsY[y]) continue;
      const rb = base + y * nx, tb = y * mx;
      for (let k = 0; k < mx; k++) {
        let s = 0;
        for (let t = wx.start[k], e = wx.start[k + 1]; t < e; t++) s += wx.w[t] * data[rb + wx.idx[t]];
        tmp[tb + k] = s;
      }
    }
    out.fill(0);
    for (let j = 0; j < my; j++) {
      const ob = j * mx;
      for (let t = wy.start[j], e = wy.start[j + 1]; t < e; t++) {
        const w = wy.w[t], tb = wy.idx[t] * mx;
        for (let k = 0; k < mx; k++) out[ob + k] += w * tmp[tb + k];
      }
    }
  };

  for (let kz = 0; kz < mz; kz++) {
    acc.fill(0);
    for (let t = wz.start[kz], e = wz.start[kz + 1]; t < e; t++) {
      const zi = wz.idx[t];
      const slot = zi % ringN;
      if (ringTag[slot] !== zi) { xySlice(zi, ring[slot]); ringTag[slot] = zi; }
      const sl = ring[slot], w = wz.w[t];
      for (let q = 0; q < acc.length; q++) acc[q] += w * sl[q];
    }
    const ob = kz * mx * my;
    for (let q = 0; q < acc.length; q++) {
      let v = Math.round(acc[q]);
      hu[ob + q] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    }
  }

  const sc = (v, a) => v.map((c) => (c * voxel) / sp[a]);
  const stepX = sc(volume.stepX, 0), stepY = sc(volume.stepY, 1), stepZ = sc(volume.stepZ, 2);
  const c0 = [wx.c0, wy.c0, wz.c0];
  const origin = [0, 1, 2].map((d) => volume.origin[d] + c0[0] * volume.stepX[d] + c0[1] * volume.stepY[d] + c0[2] * volume.stepZ[d]);
  return {
    dims: [mx, my, mz], hu, voxel, origin, stepX, stepY, stepZ,
    handedness: det3(stepX, stepY, stepZ) < 0 ? -1 : 1,
    roi: { min: roi.min.slice(), max: roi.max.slice() },
    roiFound: roi.found,
    source: { dims: [nx, ny, nz], spacing: volume.spacing ? volume.spacing.slice() : sp },
  };
}
