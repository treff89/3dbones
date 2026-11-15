// Automatic bone threshold + histogram diagnostics.

/** All tunable constants of the threshold heuristic live here. */
export const ANALYZE_PARAMS = {
  minHU: -300,              // voxels considered for statistics
  softWindow: [-20, 130],   // soft-tissue peak search window
  smoothSigmaHU: 4,         // Gaussian smoothing of the 1-HU histogram for peak finding
  minPeakFraction: 0.04,    // fraction of (> minHU) voxels within P±2σ needed to call it a soft-tissue peak
  noiseK: 5, noiseMinOffset: 110,
  otsuMax: 1600,
  clamp: [150, 350],
  noSoftOtsuRange: [-300, 1600], noSoftClamp: [100, 400],
  fallback: 226,
  metalHU: 2500, metalFraction: 0.0002,
  displayMin: -1024, displayBinWidth: 8, displayBins: 512,
};

function otsu(hist, lo, hi, base) {
  // hist index i <-> HU = base + i ; considers HU in [lo, hi]
  const a = Math.max(0, lo - base), b = Math.min(hist.length - 1, hi - base);
  let n = 0, sum = 0;
  for (let i = a; i <= b; i++) { n += hist[i]; sum += i * hist[i]; }
  if (n < 2) return null;
  let w0 = 0, s0 = 0, best = -1, bestT = a;
  for (let i = a; i < b; i++) {
    w0 += hist[i]; s0 += i * hist[i];
    const w1 = n - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = s0 / w0, m1 = (sum - s0) / w1;
    const v = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (v > best) { best = v; bestT = i; }
  }
  return base + bestT + 0.5;
}

const round5 = (v) => Math.round(v / 5) * 5;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function analyze(work, P = ANALYZE_PARAMS) {
  const hu = work.hu;
  const base = -1024, nb = 4096; // 1-HU bins [-1024, 3071]
  const h = new Uint32Array(nb);
  let metal = 0;
  for (let i = 0, n = hu.length; i < n; i++) {
    const v = hu[i];
    if (v >= P.metalHU) metal++;
    let b = v - base;
    if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
    h[b]++;
  }
  const disp = new Uint32Array(P.displayBins);
  for (let i = 0; i < nb; i++) {
    const b = Math.min(P.displayBins - 1, Math.floor((base + i - P.displayMin) / P.displayBinWidth));
    if (b >= 0) disp[b] += h[i];
  }
  const notes = [];
  let total = 0;
  for (let i = P.minHU - base + 1; i < nb; i++) total += h[i];
  const hasMetal = hu.length > 0 && metal / hu.length >= P.metalFraction;
  if (hasMetal) notes.push(`metal detected (${((100 * metal) / hu.length).toFixed(3)} % voxels >= ${P.metalHU} HU)`);
  const result = {
    threshold: P.fallback, softPeak: null, softSigma: null, otsu: null, boneFraction: 0, hasMetal,
    histogram: { min: P.displayMin, binWidth: P.displayBinWidth, counts: disp }, notes,
  };
  if (total < 100) {
    notes.push('almost no voxels above ' + P.minHU + ' HU; using fallback threshold');
    return result;
  }
  // smoothed histogram
  const sg = P.smoothSigmaHU, R = Math.ceil(3 * sg);
  const ker = new Float64Array(2 * R + 1);
  let ks = 0;
  for (let t = -R; t <= R; t++) { ker[t + R] = Math.exp((-t * t) / (2 * sg * sg)); ks += ker[t + R]; }
  const sm = new Float64Array(nb);
  const lo0 = P.minHU - base;
  for (let i = lo0; i < nb; i++) {
    let s = 0;
    for (let t = -R; t <= R; t++) { const j = i + t; if (j > lo0 && j < nb) s += ker[t + R] * h[j]; }
    sm[i] = s / ks;
  }
  const wa = P.softWindow[0] - base, wb = P.softWindow[1] - base;
  let pk = wa;
  for (let i = wa; i <= wb; i++) if (sm[i] > sm[pk]) pk = i;
  let haveSoft = false, sigma = null;
  if (pk > wa && pk < wb && sm[pk] > 0) {
    let j = pk;
    while (j < nb - 1 && sm[j] > sm[pk] / 2) j++;
    const hwhm = Math.max(1, j - pk);
    sigma = Math.sqrt(Math.max(1, (hwhm / 1.1774) ** 2 - sg * sg));
    let near = 0;
    for (let i = Math.max(lo0 + 1, Math.round(pk - 2 * sigma)); i <= Math.min(nb - 1, Math.round(pk + 2 * sigma)); i++) near += h[i];
    haveSoft = near / total >= P.minPeakFraction;
  }
  let thr;
  if (haveSoft) {
    const Pk = base + pk;
    result.softPeak = Pk; result.softSigma = Math.round(sigma * 10) / 10;
    const tNoise = Pk + Math.max(P.noiseMinOffset, P.noiseK * sigma);
    const tOtsu = otsu(h, Pk, P.otsuMax, base);
    result.otsu = tOtsu == null ? null : Math.round(tOtsu);
    const raw = tOtsu == null ? tNoise : Math.min(tNoise, tOtsu);
    thr = round5(clamp(raw, P.clamp[0], P.clamp[1]));
    notes.push(`soft-tissue peak ${Pk} HU (sigma ${result.softSigma}); noise threshold ${Math.round(tNoise)}, Otsu ${result.otsu}`);
    if (raw !== clamp(raw, P.clamp[0], P.clamp[1])) notes.push(`threshold clamped to [${P.clamp}]`);
  } else {
    const tOtsu = otsu(h, P.noSoftOtsuRange[0], P.noSoftOtsuRange[1], base);
    if (tOtsu == null) { thr = P.fallback; notes.push('no soft-tissue peak and Otsu failed; fallback threshold'); }
    else {
      result.otsu = Math.round(tOtsu);
      thr = round5(clamp(tOtsu, P.noSoftClamp[0], P.noSoftClamp[1]));
      notes.push(`no soft-tissue peak (dry bone / phantom?); Otsu ${result.otsu}`);
    }
  }
  result.threshold = thr;
  let above = 0;
  for (let i = Math.max(0, thr - base); i < nb; i++) above += h[i];
  result.boneFraction = above / total;
  return result;
}
