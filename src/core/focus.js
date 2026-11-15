// Automatic focus: decide WHICH part of the scan is the anatomy to print.
//
// Real extremity CTs are rarely just the limb. The patient lies on a couch (whose shell is as dense as thin bone),
// and an arm scanned at the patient's side shares the field of view with a slab of chest wall and ribs.
// Working on a coarse (~2 mm) grid this module returns a "keep" mask:
//   1. body mask - cells that are mostly tissue, opened so thin sheets (couch shell, clothing, tubing) vanish.
//                  Bone-like material outside the body is ignored.
//   2. bone groups - coarse bone components closer than `linkMm` to each other are grouped (a hand's 27 bones, or
//                  humerus + radius + ulna, form ONE group; ribs 4 cm away form another).
//   3. main group - groups are scored by amount of bone and by how central they are in the field of view (the scan
//                  was planned around the anatomy of interest); the best group, and any group nearly as good
//                  (e.g. the other hand), is kept. Everything nearer to another group is masked out.
// With `focus: false` only step 1 applies (whole scan, minus couch). Scans without soft tissue (dry bone, phantoms)
// are passed through untouched.
import { len3 } from './affine.js';

export const FOCUS_DEFAULTS = {
  cellMm: 2,
  tissueHU: -350, // mean HU of a cell above this = "mostly tissue"
  denseHU: 250, // mean HU above this = solid dense cell (bone core); always part of the body
  boneMeanHU: 150, // a cell is a bone cell if its MEAN HU exceeds this. Means, not maxima or voxel counts: thin-slice
  // sharp-kernel scans can be so noisy that a fifth of all soft-tissue voxels exceed 200 HU, while the mean of a
  // 2 mm cell is stable. Cortex only partly filling a cell still lifts its mean well above soft tissue.
  minBodyMm3: 3000, // smaller tissue blobs are clutter (markers, tubes)
  linkMm: 16, // bone components closer than this belong to the same group
  keepMm: 16, // the kept region reaches this far around the chosen groups
  minGroupMm3: 400, // ignore tiny groups when choosing
  alsoKeepScore: 0.5, // other groups scoring at least this fraction of the best are kept too
  minSoftPerBone: 1.0, // real anatomy is wrapped in soft tissue: soft cells per bone cell around a group (couch rails: ~0.6)
  rimFraction: 0.01, rimMinCells: 40, // a group with this much bone on the in-plane edge of the field of view is "cut off" ...
  rimPenalty: 0.15, // ... and its score is multiplied by this: the scan was planned around anatomy that fits the field of view
};

function pool(volume, cs) {
  const [nx, ny, nz] = volume.dims;
  const data = volume.data;
  const cx = Math.ceil(nx / cs[0]), cy = Math.ceil(ny / cs[1]), cz = Math.ceil(nz / cs[2]);
  const n = cx * cy * cz;
  const sum = new Float32Array(n);
  const cnt = new Uint16Array(n);
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
        sum[c] += v;
        cnt[c]++;
      }
    }
  }
  return { cx, cy, cz, sum, cnt };
}

/**
 * @returns {{
 *   active: boolean,                 // false = nothing masked (keep is all ones, roi null)
 *   cs: number[], cdims: number[], keep: Uint8Array,   // coarse grid (source index / cs -> cell); 1 = keep
 *   roi: {min:number[], max:number[]}|null,            // source-index bounding box of the kept bone
 *   groups: number, hiddenGroups: number, hiddenShare: number,  // bone groups found / masked out / their share of bone
 *   tableRemoved: boolean, reason: string
 * }}
 */
export function focusVolume(volume, opts = {}) {
  const o = { ...FOCUS_DEFAULTS, ...opts };
  const [nx, ny, nz] = volume.dims;
  const sp = [len3(volume.stepX), len3(volume.stepY), len3(volume.stepZ)];
  const cs = sp.map((s) => Math.max(1, Math.round(o.cellMm / s)));
  const cell = [cs[0] * sp[0], cs[1] * sp[1], cs[2] * sp[2]];
  const cellMm = Math.cbrt(cell[0] * cell[1] * cell[2]);
  const cellVol = cell[0] * cell[1] * cell[2];
  const { cx, cy, cz, sum, cnt } = pool(volume, cs);
  const n = cx * cy * cz;
  const sxy = cx * cy;
  const passthrough = (reason) => ({
    active: false, cs, cdims: [cx, cy, cz], keep: new Uint8Array(n).fill(1), roi: null,
    groups: 0, hiddenGroups: 0, hiddenShare: 0, tableRemoved: false, reason,
  });

  // ── tissue and bone cells ────────────────────────────────────────────────────────────────────────────────
  const tissue = new Uint8Array(n);
  const bone = new Uint8Array(n);
  let nTissue = 0, nSoft = 0, nBoneAll = 0;
  for (let i = 0; i < n; i++) {
    const c = cnt[i];
    if (!c) continue;
    const m = sum[i] / c;
    if (m > o.tissueHU) {
      tissue[i] = m > o.denseHU ? 2 : 1;
      nTissue++;
      if (m > -200 && m < 160) nSoft++;
    }
    if (m >= o.boneMeanHU) { bone[i] = 1; nBoneAll++; }
  }
  if (!nBoneAll) return passthrough('no bone-like content');
  // Dry bone / phantom in air: there is no soft-tissue envelope to reason about.
  const haveBody = nSoft >= 0.3 * nTissue && nTissue * cellVol >= 2 * o.minBodyMm3;

  // ── body mask: opening of the tissue mask (drops couch shell, sheets, cables), small blobs removed ────────
  let nBone = nBoneAll;
  if (haveBody) {
    const core = new Uint8Array(n);
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        let i = cx * (y + cy * z);
        for (let x = 0; x < cx; x++, i++) {
          if (!tissue[i]) continue;
          if (tissue[i] === 2) { core[i] = 1; continue; }
          if ((x > 0 && !tissue[i - 1]) || (x < cx - 1 && !tissue[i + 1])) continue;
          if ((y > 0 && !tissue[i - cx]) || (y < cy - 1 && !tissue[i + cx])) continue;
          if ((z > 0 && !tissue[i - sxy]) || (z < cz - 1 && !tissue[i + sxy])) continue;
          core[i] = 1;
        }
      }
    }
    // remove small blobs of core
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const minCells = o.minBodyMm3 / cellVol;
    for (let s = 0; s < n; s++) {
      if (!core[s] || seen[s]) continue;
      let top = 0, m = 0;
      stack[top++] = s; seen[s] = 1;
      const members = [];
      while (top) {
        const i = stack[--top];
        m++;
        if (m <= minCells) members.push(i);
        const x = i % cx, t = (i / cx) | 0, y = t % cy, z = (t / cy) | 0;
        if (x > 0 && core[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < cx - 1 && core[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && core[i - cx] && !seen[i - cx]) { seen[i - cx] = 1; stack[top++] = i - cx; }
        if (y < cy - 1 && core[i + cx] && !seen[i + cx]) { seen[i + cx] = 1; stack[top++] = i + cx; }
        if (z > 0 && core[i - sxy] && !seen[i - sxy]) { seen[i - sxy] = 1; stack[top++] = i - sxy; }
        if (z < cz - 1 && core[i + sxy] && !seen[i + sxy]) { seen[i + sxy] = 1; stack[top++] = i + sxy; }
      }
      if (m < minCells) for (const i of members) core[i] = 0;
    }
    // body = core dilated by one cell (restores the skin layer the opening removed)
    const body = new Uint8Array(n);
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        let i = cx * (y + cy * z);
        for (let x = 0; x < cx; x++, i++) {
          if (!core[i]) continue;
          const x0 = x > 0 ? x - 1 : x, x1 = x < cx - 1 ? x + 1 : x;
          const y0 = y > 0 ? y - 1 : y, y1 = y < cy - 1 ? y + 1 : y;
          const z0 = z > 0 ? z - 1 : z, z1 = z < cz - 1 ? z + 1 : z;
          for (let zz = z0; zz <= z1; zz++) for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) body[xx + cx * (yy + cy * zz)] = 1;
        }
      }
    }
    nBone = 0;
    for (let i = 0; i < n; i++) {
      if (bone[i] && !body[i]) bone[i] = 0;
      nBone += bone[i];
      tissue[i] = body[i]; // reuse as the body mask from here on
    }
    if (!nBone) return passthrough('no bone inside a tissue region');
  } else {
    tissue.fill(1);
  }
  const body = tissue;
  const tableRemoved = haveBody && nBoneAll - nBone > Math.max(50, 0.03 * nBoneAll);

  // ── in-plane rim of the field of view: the square border, or the inscribed circle when the corners are padding ──
  const rimMap = new Uint8Array(sxy);
  {
    let cornersAir = true;
    const span = Math.max(1, Math.floor(Math.min(cx, cy) * 0.05));
    for (let z = 0; z < cz && cornersAir; z++) {
      for (let y = 0; y < span && cornersAir; y++) {
        for (let x = 0; x < span; x++) {
          for (const i of [x + cx * (y + cy * z), cx - 1 - x + cx * (y + cy * z), x + cx * (cy - 1 - y + cy * z), cx - 1 - x + cx * (cy - 1 - y + cy * z)]) {
            if (cnt[i] && sum[i] / cnt[i] > -900) cornersAir = false;
          }
        }
      }
    }
    const mx = (cx - 1) / 2, my = (cy - 1) / 2;
    const Rc = Math.min(cx * cell[0], cy * cell[1]) / 2 - 1.5 * Math.max(cell[0], cell[1]);
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        let r = x === 0 || y === 0 || x === cx - 1 || y === cy - 1;
        if (!r && cornersAir) r = Math.hypot((x - mx) * cell[0], (y - my) * cell[1]) >= Rc;
        rimMap[x + cx * y] = r ? 1 : 0;
      }
    }
  }

  // ── coarse bone components (26-connected) ─────────────────────────────────────────────────────────────────
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  const comps = [null];
  for (let s = 0; s < n; s++) {
    if (!bone[s] || label[s]) continue;
    const id = comps.length;
    let head = 0, tail = 0, cells = 0, sx = 0, sy = 0, rim = 0;
    queue[tail++] = s; label[s] = id;
    while (head < tail) {
      const i = queue[head++];
      cells++;
      const x = i % cx, t = (i / cx) | 0, y = t % cy, z = (t / cy) | 0;
      sx += x; sy += y;
      if (rimMap[x + cx * y]) rim++;
      const x0 = x > 0 ? x - 1 : x, x1 = x < cx - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y, y1 = y < cy - 1 ? y + 1 : y;
      const z0 = z > 0 ? z - 1 : z, z1 = z < cz - 1 ? z + 1 : z;
      for (let zz = z0; zz <= z1; zz++) for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const q = xx + cx * (yy + cy * zz);
        if (bone[q] && !label[q]) { label[q] = id; queue[tail++] = q; }
      }
    }
    comps.push({ cells, sx, sy, rim, soft: 0 });
  }
  const nComp = comps.length - 1;

  // ── grow all components outward together; fronts that meet within linkMm are the same group ──────────────
  const parent = new Int32Array(nComp + 1);
  for (let i = 0; i <= nComp; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b < a ? a : b] = b < a ? b : a; };

  const linkSteps = Math.max(1, Math.round(o.linkMm / 2 / cellMm));
  const keepSteps = Math.max(linkSteps, Math.round(o.keepMm / cellMm));
  const near = label.slice(); // nearest component id per cell (0 = none within keepSteps)
  let frontier = new Int32Array(n);
  let fn = 0;
  for (let i = 0; i < n; i++) if (label[i]) frontier[fn++] = i;
  let next = new Int32Array(n);
  for (let step = 1; step <= keepSteps && fn; step++) {
    let nn = 0;
    const full = step % 2 === 0; // alternate 6- and 26-neighbourhoods: octagonal distance, close to Euclidean
    for (let f = 0; f < fn; f++) {
      const i = frontier[f];
      const id = near[i];
      const x = i % cx, t = (i / cx) | 0, y = t % cy, z = (t / cy) | 0;
      const x0 = x > 0 ? x - 1 : x, x1 = x < cx - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y, y1 = y < cy - 1 ? y + 1 : y;
      const z0 = z > 0 ? z - 1 : z, z1 = z < cz - 1 ? z + 1 : z;
      for (let zz = z0; zz <= z1; zz++) for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        if (!full && (xx !== x) + (yy !== y) + (zz !== z) !== 1) continue;
        const q = xx + cx * (yy + cy * zz);
        const other = near[q];
        if (!other) { near[q] = id; next[nn++] = q; } else if (other !== id && step <= linkSteps) union(id, other);
      }
    }
    const tmp = frontier; frontier = next; next = tmp; fn = nn;
  }

  // soft-tissue cells in each component's neighbourhood (real anatomy is wrapped in soft tissue; couch parts are not)
  if (haveBody) {
    for (let i = 0; i < n; i++) {
      const c = near[i];
      if (!c || bone[i] || !body[i] || !cnt[i]) continue;
      const m = sum[i] / cnt[i];
      if (m > -200 && m < 150) comps[c].soft++;
    }
  }

  // ── score groups ──────────────────────────────────────────────────────────────────────────────────────────
  const groups = new Map();
  for (let c = 1; c <= nComp; c++) {
    const g = find(c);
    let e = groups.get(g);
    if (!e) { e = { id: g, cells: 0, sx: 0, sy: 0, rim: 0, soft: 0 }; groups.set(g, e); }
    e.cells += comps[c].cells; e.sx += comps[c].sx; e.sy += comps[c].sy; e.rim += comps[c].rim; e.soft += comps[c].soft;
  }
  const halfX = (cx - 1) / 2, halfY = (cy - 1) / 2;
  const R = Math.min(cx * cell[0], cy * cell[1]) / 2;
  let list = [...groups.values()].filter((g) => g.cells * cellVol >= o.minGroupMm3);
  if (!list.length) return passthrough('only specks of bone');
  if (haveBody) {
    const wrapped = list.filter((g) => g.soft >= o.minSoftPerBone * g.cells);
    if (wrapped.length) list = wrapped;
  }
  for (const g of list) {
    const d = Math.hypot((g.sx / g.cells - halfX) * cell[0], (g.sy / g.cells - halfY) * cell[1]) / R;
    g.central = 1 - 0.75 * Math.min(1, d) ** 2;
    g.cutOff = g.rim >= Math.max(o.rimMinCells, o.rimFraction * g.cells);
    g.score = g.cells * g.central * (g.cutOff ? o.rimPenalty : 1);
  }
  list.sort((a, b) => b.score - a.score);
  const total = list.reduce((s, g) => s + g.cells, 0);
  // Safeguard: if the winner only won through the cut-off penalty and is a minor part of the bone, do not trust it.
  if (list[0].cells < 0.12 * total) {
    for (const g of list) g.score = g.cells * g.central;
    list.sort((a, b) => b.score - a.score);
  }
  const chosen = new Set();
  if (o.focus === false) for (const g of groups.values()) chosen.add(g.id);
  else for (const g of list) if (g.score >= o.alsoKeepScore * list[0].score) chosen.add(g.id);
  const hidden = o.focus === false ? [] : list.filter((g) => !chosen.has(g.id));

  // ── keep mask + bone bounding box ─────────────────────────────────────────────────────────────────────────
  const keep = new Uint8Array(n);
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      let i = cx * (y + cy * z);
      for (let x = 0; x < cx; x++, i++) {
        const c = near[i];
        if (!c || !body[i] || !chosen.has(find(c))) continue;
        keep[i] = 1;
        if (bone[i]) {
          any = true;
          if (x < bmin[0]) bmin[0] = x; if (x > bmax[0]) bmax[0] = x;
          if (y < bmin[1]) bmin[1] = y; if (y > bmax[1]) bmax[1] = y;
          if (z < bmin[2]) bmin[2] = z; if (z > bmax[2]) bmax[2] = z;
        }
      }
    }
  }
  if (!any) return passthrough('focus found no bone');
  const dims = [nx, ny, nz];
  const roi = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let a = 0; a < 3; a++) {
    roi.min[a] = Math.max(0, bmin[a] * cs[a]);
    roi.max[a] = Math.min(dims[a] - 1, (bmax[a] + 1) * cs[a] - 1);
  }
  return {
    active: true, cs, cdims: [cx, cy, cz], keep, roi,
    groups: list.length, hiddenGroups: hidden.length,
    hiddenShare: hidden.reduce((s, g) => s + g.cells, 0) / total,
    tableRemoved,
    reason: hidden.length ? 'focused on the main bone group' : 'whole scan',
    ...(o.debug ? { debug: { list, label, bone, body, groupOf: Int32Array.from(parent, (_, i) => find(i)) } } : {}),
  };
}
