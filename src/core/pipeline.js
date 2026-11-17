// buildMesh: CT work grid -> watertight printable bone mesh.
import { det3, worldToIndex } from './affine.js';
import { gaussianBlurInt16, solidify, fillEnclosed } from './morph.js';
import { labelComponents, componentAtSeed } from './components.js';
import { planPegs, rasterPegs } from './pegs.js';
import { splitBones } from './split.js';
import { removeMetal } from './metal.js';
import { marchingCubes } from './mcubes.js';
import { taubinSmooth, meshStats, compactMesh } from './meshops.js';
import { decimate } from './decimate.js';

const PLATEAU = 150;

export function defaultParams(work, analysis) {
  return {
    threshold: analysis && Number.isFinite(analysis.threshold) ? analysis.threshold : 226,
    smoothing: analysis && Number.isFinite(analysis.smoothing) ? analysis.smoothing : 0.4,
    closeGapMm: Math.round(Math.max(0.6, 1.2 * work.voxel) * 100) / 100,
    fillCavities: true,
    separateJoints: true,
    minPartMm3: 25,
    strongMarginHU: 100,
    dropVessels: true, vesselDensityRatio: 0.35, vesselElongation: 8, wireDiameterMm: 3.2, wireElongation: 12,
    separateBones: true, // split bones that are fused across narrow joints (see split.js)
    removeMetal: false, metalHU: 2500, metalMarginMm: 0.7, // cut implants (plates, screws) out of the model
    dropStrays: true, strayGroupRatio: 0.08, // with joinParts: small groups that no peg can reach are left out,
    strayGapMm: 6, strayMaxMm3: 1500, //        as are small bits that would hang on a peg longer than strayGapMm
    joinParts: true, pegDiameterMm: 3, maxPegGapMm: 20,
    removeSeeds: [], keepSeeds: [],
    crop: null,
    maxTriangles: 600000, maxErrorMm: 0.06,
  };
}

const yieldTask = () => new Promise((r) => setTimeout(r, 0));

function emptyResult(stats, timings) {
  return {
    positions: new Float32Array(0), indices: new Uint32Array(0), vertexPart: new Uint16Array(0), offset: [0, 0, 0],
    parts: [], pegs: [],
    stats: {
      triangles: 0, vertices: 0, trianglesBeforeDecimation: 0, volumeMm3: 0, areaMm2: 0, sizeMm: [0, 0, 0], watertight: false,
      nonManifoldEdges: 0, boundaryEdges: 0, parts: 0, droppedIslands: stats.droppedIslands || 0, unconnectedParts: 0, timingsMs: timings,
    },
  };
}

export async function buildMesh(work, params = {}, onProgress = () => {}) {
  const p = { ...defaultParams(work, null), ...params };
  const dims = work.dims;
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz, plane = nx * ny;
  const timings = {};
  let tPrev = performance.now();
  const T0 = tPrev;
  const lap = (name) => { const t = performance.now(); timings[name] = Math.round(t - tPrev); tPrev = t; };
  const progress = async (f, label) => { try { onProgress(f, label); } catch (e) { /* ignore UI errors */ } await yieldTask(); tPrev = performance.now(); };
  const thr = Math.round(p.threshold);
  const voxVol = Math.abs(det3(work.stepX, work.stepY, work.stepZ));

  // 1. smoothing
  await progress(0.0, 'Smoothing volume');
  const sigma = Math.max(0, Math.min(1, p.smoothing)) * 1.0;
  let source = work.hu, metalVoxels = 0;
  if (p.removeMetal) {
    const mr = removeMetal(work.hu, dims, work.voxel, { metalHU: p.metalHU, marginMm: p.metalMarginMm });
    source = mr.hu; metalVoxels = mr.voxels;
    lap('metal');
  }
  const S = sigma >= 0.05 ? gaussianBlurInt16(source, dims, sigma) : source;
  lap('blur');

  // 2. mask (+ crop)
  await progress(0.08, 'Thresholding');
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = S[i] >= thr ? 1 : 0;
  if (p.crop) applyCrop(mask, work, p.crop);
  lap('mask');

  // 3. components
  await progress(0.12, 'Finding bones');
  const cc = labelComponents(mask, dims, S, thr + p.strongMarginHU);
  const labels = cc.labels;
  const nComp = cc.count;
  const eligible = new Uint8Array(nComp + 1);
  const minVox = p.minPartMm3 / voxVol;
  for (let c = 1; c <= nComp; c++) eligible[c] = cc.size[c] >= minVox && cc.strong[c] >= 8 ? 1 : 0;
  // 3b. contrast-filled vessels: long, thin AND much fainter than the bone in this scan. (Thin alone would catch a
  // fibula or a rib, faint alone a child's ossification centre; a vessel is both.)
  const dense = new Float32Array(nComp + 1), elong = new Float32Array(nComp + 1), thick = new Float32Array(nComp + 1);
  let vesselsDropped = 0;
  {
    const cand = [];
    for (let c = 1; c <= nComp; c++) if (eligible[c]) cand.push(c);
    if (cand.length) {
      const BINS = 128, BW = 16;
      const slot = new Int32Array(nComp + 1).fill(-1);
      cand.forEach((c, k) => { slot[c] = k; });
      const hist = new Uint32Array(cand.length * BINS);
      for (let i = 0; i < N; i++) {
        const l = labels[i];
        if (!l) continue;
        const k = slot[l];
        if (k < 0) continue;
        let b = ((S[i] - thr) / BW) | 0;
        if (b >= BINS) b = BINS - 1;
        hist[k * BINS + b]++;
      }
      let ref = 0, refSize = 0;
      for (const c of cand) {
        const k = slot[c], want = 0.95 * cc.size[c];
        let acc = 0, b = 0;
        for (; b < BINS; b++) { acc += hist[k * BINS + b]; if (acc >= want) break; }
        dense[c] = thr + (b + 0.5) * BW; // 95th percentile of HU inside the piece
        const L = Math.hypot(cc.bbox[6 * c + 3] - cc.bbox[6 * c] + 1, cc.bbox[6 * c + 4] - cc.bbox[6 * c + 1] + 1, cc.bbox[6 * c + 5] - cc.bbox[6 * c + 2] + 1) * work.voxel;
        const dEff = Math.sqrt((4 * cc.size[c] * voxVol) / (Math.PI * L));
        elong[c] = L / Math.max(dEff, 1e-3);
        thick[c] = dEff;
        if (cc.size[c] > refSize) { refSize = cc.size[c]; ref = dense[c]; }
      }
      if (p.dropVessels !== false && cand.length > 1) {
        const cut = thr + p.vesselDensityRatio * (ref - thr);
        for (const c of cand) {
          if (cc.size[c] === refSize) continue;
          const faintAndLong = dense[c] < cut && elong[c] >= p.vesselElongation;
          // wires, skin-marker lines, catheters, ECG leads: thinner than any bone and very long, whatever their density
          const wire = elong[c] >= p.wireElongation && thick[c] < p.wireDiameterMm;
          if (faintAndLong || wire) { eligible[c] = 0; vesselsDropped++; }
        }
      }
    }
  }
  const toIdx = (w) => worldToIndex(work, w);
  // Pieces the user removed / chose to keep are identified by a seed point. When bones are separated the seeds refer
  // to the separated pieces, so they are applied after the split instead of here.
  if (!p.separateBones) {
    for (const s of p.removeSeeds || []) {
      const c = componentAtSeed(labels, dims, toIdx(s), eligible);
      if (c) eligible[c] = 0;
    }
    if (p.keepSeeds && p.keepSeeds.length) {
      const keep = new Uint8Array(nComp + 1);
      for (const s of p.keepSeeds) { const c = componentAtSeed(labels, dims, toIdx(s), eligible); if (c) keep[c] = 1; }
      for (let c = 1; c <= nComp; c++) if (!keep[c]) eligible[c] = 0;
    }
  }
  const surv = [];
  for (let c = 1; c <= nComp; c++) if (eligible[c]) surv.push(c);
  surv.sort((a, b) => cc.size[b] - cc.size[a] || a - b);
  let nParts = Math.min(surv.length, 65535);
  const remap = new Int32Array(nComp + 1);
  for (let k = 0; k < nParts; k++) remap[surv[k]] = k + 1;
  for (let i = 0; i < N; i++) { const l = labels[i]; if (l) labels[i] = remap[l]; }
  const droppedIslands = nComp - nParts;
  let seedIdx = new Int32Array(nParts + 1);
  let partDense = new Float32Array(nParts + 1), partElong = new Float32Array(nParts + 1);
  for (let k = 0; k < nParts; k++) { seedIdx[k + 1] = cc.maxIdx[surv[k]]; partDense[k + 1] = dense[surv[k]]; partElong[k + 1] = elong[surv[k]]; }
  lap('components');
  if (nParts === 0) { timings.total = Math.round(performance.now() - T0); return emptyResult({ droppedIslands }, timings); }

  // 4. seal + fill
  await progress(0.25, 'Sealing and filling');
  const rVox = Math.max(0, p.closeGapMm) / work.voxel;
  let scratch = new Float32Array(N);
  const sol = solidify(labels, dims, rVox, { fillCavities: p.fillCavities, separateJoints: p.separateJoints, nParts, scratchF32: scratch });
  scratch = null;
  if (p.fillCavities) sol.filled += fillEnclosed(labels, dims);
  lap('solidify');

  // 4b. separate bones fused across joints, then apply the user's removed / kept pieces and renumber by size
  let splitInfo = { split: 0, joints: 0 };
  if (p.separateBones) {
    await progress(0.38, 'Separating bones');
    splitInfo = splitBones(labels, dims, S, thr, work.voxel);
    const cnt = splitInfo.count;
    const size = new Int32Array(cnt + 1), best = new Int32Array(cnt + 1).fill(-1), bestV = new Int16Array(cnt + 1).fill(-32768);
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (!l) continue;
      size[l]++;
      if (S[i] > bestV[l]) { bestV[l] = S[i]; best[l] = i; }
    }
    const ok = new Uint8Array(cnt + 1);
    for (let l = 1; l <= cnt; l++) ok[l] = size[l] >= minVox ? 1 : 0;
    for (const sd of p.removeSeeds || []) { const c = componentAtSeed(labels, dims, toIdx(sd), ok); if (c) ok[c] = 0; }
    if (p.keepSeeds && p.keepSeeds.length) {
      const keep = new Uint8Array(cnt + 1);
      for (const sd of p.keepSeeds) { const c = componentAtSeed(labels, dims, toIdx(sd), ok); if (c) keep[c] = 1; }
      for (let l = 1; l <= cnt; l++) if (!keep[l]) ok[l] = 0;
    }
    const order = [];
    for (let l = 1; l <= cnt; l++) if (ok[l]) order.push(l);
    order.sort((a, b) => size[b] - size[a] || a - b);
    nParts = Math.min(order.length, 65535);
    const map = new Int32Array(cnt + 1);
    seedIdx = new Int32Array(nParts + 1); partDense = new Float32Array(nParts + 1); partElong = new Float32Array(nParts + 1);
    for (let k = 0; k < nParts; k++) { map[order[k]] = k + 1; seedIdx[k + 1] = best[order[k]]; }
    for (let i = 0; i < N; i++) { const l = labels[i]; if (l) labels[i] = map[l]; }
    lap('split');
    if (nParts === 0) { timings.total = Math.round(performance.now() - T0); return emptyResult({ droppedIslands }, timings); }
  }

  // part statistics
  const pv = new Float64Array(nParts + 1), psx = new Float64Array(nParts + 1), psy = new Float64Array(nParts + 1), psz = new Float64Array(nParts + 1);
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    const l = labels[i];
    if (l) { pv[l]++; psx[l] += x; psy[l] += y; psz[l] += z; }
  }

  // 5. pegs
  let pegs = [], unconnected = 0, strayDropped = 0;
  const stray = new Uint8Array(nParts + 1);
  if (p.joinParts && nParts >= 2) {
    await progress(0.45, 'Planning connectors');
    const pl = planPegs(labels, dims, work, nParts, pv, { pegDiameterMm: p.pegDiameterMm, maxPegGapMm: p.maxPegGapMm });
    pegs = pl.pegs; unconnected = pl.unconnected;
    // Groups of parts held together by pegs. Small groups that could not be reached (stray fragments, marker pads,
    // a sliver of another bone at the edge of the scan) would print as loose crumbs: leave them out.
    if (p.dropStrays !== false && unconnected > 0) {
      const par = new Int32Array(nParts + 1);
      for (let l = 0; l <= nParts; l++) par[l] = l;
      const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      for (const g of pegs) { const a = find(g.a), b = find(g.b); if (a !== b) par[b] = a; }
      const gv = new Float64Array(nParts + 1);
      for (let l = 1; l <= nParts; l++) gv[find(l)] += pv[l];
      let main = 0;
      for (let l = 1; l <= nParts; l++) if (gv[l] > main) main = gv[l];
      unconnected = 0;
      for (let l = 1; l <= nParts; l++) {
        const v = gv[find(l)];
        if (v < p.strayGroupRatio * main) { stray[l] = 1; strayDropped++; } else if (v < main) unconnected++;
      }
      if (strayDropped) pegs = pegs.filter((g) => !stray[g.a] && !stray[g.b]);
    }
    // Small bits hanging on a long peg (vessel-wall calcifications, loose specks well away from any bone): cut the
    // peg and leave the small side out. Sesamoids and fracture fragments sit within a few millimetres and stay.
    if (p.dropStrays !== false && pegs.length) {
      for (;;) {
        let cutIdx = -1, cutSide = null;
        for (let k = 0; k < pegs.length && cutIdx < 0; k++) {
          if (pegs[k].gapMm <= p.strayGapMm) continue;
          const par = new Int32Array(nParts + 1);
          for (let l = 0; l <= nParts; l++) par[l] = l;
          const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
          for (let j = 0; j < pegs.length; j++) if (j !== k) { const a = find(pegs[j].a), b = find(pegs[j].b); if (a !== b) par[b] = a; }
          const ra = find(pegs[k].a), rb = find(pegs[k].b);
          let va = 0, vb = 0;
          for (let l = 1; l <= nParts; l++) { if (stray[l]) continue; const r = find(l); if (r === ra) va += pv[l]; else if (r === rb) vb += pv[l]; }
          const small = Math.min(va, vb) * voxVol, big = Math.max(va, vb) * voxVol;
          if (small < p.strayMaxMm3 && small < 0.05 * big) {
            cutIdx = k;
            const rs = va < vb ? ra : rb;
            cutSide = [];
            for (let l = 1; l <= nParts; l++) if (!stray[l] && find(l) === rs) cutSide.push(l);
          }
        }
        if (cutIdx < 0) break;
        for (const l of cutSide) { stray[l] = 1; strayDropped++; }
        pegs = pegs.filter((g, j) => j !== cutIdx && !stray[g.a] && !stray[g.b]);
      }
    }
    lap('pegs');
  } else if (nParts >= 2) unconnected = nParts - 1;

  // 6. scalar field
  await progress(0.5, 'Building surface field');
  const F = S === work.hu ? new Int16Array(N) : S; // reuse blurred buffer
  for (let i = 0; i < N; i++) {
    let f = S[i] - thr;
    const l = labels[i];
    if (l > 0 && !stray[l]) { if (f <= 0) f = PLATEAU; }
    else if (f >= 0) f = -PLATEAU;
    F[i] = f > 32767 ? 32767 : f < -32767 ? -32767 : f;
  }
  if (pegs.length) rasterPegs(F, dims, work, pegs);
  lap('field');

  // 7. marching cubes
  await progress(0.55, 'Marching cubes');
  const mc = marchingCubes(F, dims, labels);
  lap('marchingCubes');
  const sX = work.stepX, sY = work.stepY, sZ = work.stepZ;
  let positions = new Float32Array(mc.positions.length);
  {
    const src = mc.positions;
    for (let v = 0; v < src.length; v += 3) {
      const i = src[v], j = src[v + 1], k = src[v + 2];
      positions[v] = i * sX[0] + j * sY[0] + k * sZ[0];
      positions[v + 1] = i * sX[1] + j * sY[1] + k * sZ[1];
      positions[v + 2] = i * sX[2] + j * sY[2] + k * sZ[2];
    }
  }
  let indices = mc.indices;
  if (work.handedness < 0) {
    // the index->world map flips orientation: swap winding (geometry itself is NOT mirrored)
    indices = indices.slice();
    for (let t = 0; t < indices.length; t += 3) { const b = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = b; }
  }
  let vertexPart = mc.vertexPart;
  const trianglesBeforeDecimation = indices.length / 3;
  lap('transform');

  // 8. Taubin smoothing
  const iters = Math.round(Math.max(0, Math.min(1, p.smoothing)) * 30);
  if (iters > 0) {
    await progress(0.7, 'Smoothing surface');
    taubinSmooth(positions, indices, iters);
    lap('taubin');
  }

  // 9. decimation
  await progress(0.8, 'Decimating');
  const dec = await decimate(positions, indices, vertexPart, { maxTriangles: p.maxTriangles, maxErrorMm: p.maxErrorMm });
  if (dec.decimated) { positions = dec.positions; indices = dec.indices; vertexPart = dec.vertexPart; }
  else {
    const c = compactMesh(positions, indices, vertexPart);
    positions = c.positions; indices = c.indices; vertexPart = c.vertexPart;
  }
  lap('decimate');

  // 10. offset + stats
  await progress(0.95, 'Statistics');
  const min = [Infinity, Infinity, Infinity];
  for (let v = 0; v < positions.length; v += 3) for (let q = 0; q < 3; q++) if (positions[v + q] < min[q]) min[q] = positions[v + q];
  for (let v = 0; v < positions.length; v += 3) { positions[v] -= min[0]; positions[v + 1] -= min[1]; positions[v + 2] -= min[2]; }
  const offset = [0, 1, 2].map((q) => work.origin[q] + min[q]);
  const st = meshStats(positions, indices);

  const nP1 = nParts + 1;
  const bmin = new Float64Array(nP1 * 3).fill(Infinity), bmax = new Float64Array(nP1 * 3).fill(-Infinity);
  for (let v = 0; v < vertexPart.length; v++) {
    const l = vertexPart[v];
    if (!l || l > nParts) continue;
    for (let q = 0; q < 3; q++) {
      const c = positions[3 * v + q];
      if (c < bmin[3 * l + q]) bmin[3 * l + q] = c;
      if (c > bmax[3 * l + q]) bmax[3 * l + q] = c;
    }
  }
  const parts = [];
  for (let l = 1; l <= nParts; l++) {
    if (stray[l]) continue;
    const n = pv[l] || 1;
    const ci = psx[l] / n, cj = psy[l] / n, ck = psz[l] / n;
    const cw = [0, 1, 2].map((q) => work.origin[q] + ci * sX[q] + cj * sY[q] + ck * sZ[q] - offset[q]);
    const si = seedIdx[l];
    const x = si % nx, t = (si / nx) | 0, y = t % ny, z = (t / ny) | 0;
    const seed = [0, 1, 2].map((q) => work.origin[q] + x * sX[q] + y * sY[q] + z * sZ[q]);
    const hasB = bmin[3 * l] <= bmax[3 * l];
    parts.push({
      id: l, voxels: pv[l], volumeMm3: pv[l] * voxVol,
      bboxMin: hasB ? [bmin[3 * l], bmin[3 * l + 1], bmin[3 * l + 2]] : cw, bboxMax: hasB ? [bmax[3 * l], bmax[3 * l + 1], bmax[3 * l + 2]] : cw,
      centroid: cw, seed, denseHU: partDense[l], elongation: partElong[l],
    });
  }
  lap('stats');
  timings.total = Math.round(performance.now() - T0);
  await progress(1, 'Done');
  return {
    positions, indices, vertexPart, offset, parts,
    pegs: pegs.map((g) => ({ a: g.a, b: g.b, lengthMm: g.lengthMm, gapMm: g.gapMm, radiusMm: g.radius })),
    stats: {
      triangles: st.triangles, vertices: st.vertices, trianglesBeforeDecimation,
      volumeMm3: st.volumeMm3, areaMm2: st.areaMm2, sizeMm: st.sizeMm, watertight: st.watertight,
      nonManifoldEdges: st.nonManifoldEdges, boundaryEdges: st.boundaryEdges,
      parts: nParts - strayDropped, droppedIslands, vesselsDropped, strayDropped, unconnectedParts: unconnected,
      bonesSeparated: splitInfo.joints, metalRemovedMm3: metalVoxels * voxVol,
      filledVoxels: sol.filled, jointGapVoxels: sol.jointVoxels,
      decimationErrorMm: dec.errorMm, decimationFailed: !!dec.failed,
      timingsMs: timings,
    },
  };
}

function applyCrop(mask, work, crop) {
  const [nx, ny, nz] = work.dims;
  const o = work.origin, a = work.stepX, b = work.stepY, c = work.stepZ;
  const lo = crop.min, hi = crop.max;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    let px = o[0] + y * b[0] + z * c[0], py = o[1] + y * b[1] + z * c[1], pz = o[2] + y * b[2] + z * c[2];
    let i = nx * (y + ny * z);
    for (let x = 0; x < nx; x++, i++, px += a[0], py += a[1], pz += a[2]) {
      if (px < lo[0] || px > hi[0] || py < lo[1] || py > hi[1] || pz < lo[2] || pz > hi[2]) mask[i] = 0;
    }
  }
}
