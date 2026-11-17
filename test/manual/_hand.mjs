import { prepareVolume, analyze, defaultParams, buildMesh } from '../../src/core/index.js';
import { makeVolume, axisGeometry, handPhantom, scannerBlur } from '../core/helpers.js';
for (const [gap, vox, cortexHU, psf] of [[1.0, 0.35, 1250, 0.45], [0.7, 0.35, 1250, 0.45], [1.0, 0.5, 1250, 0.55], [1.2, 0.3, 900, 0.5], [0.8, 0.4, 800, 0.4], [0.5, 0.3, 1250, 0.35]]) {
  const ph = handPhantom({ gap, cortexHU, blur: vox });
  const vol = await scannerBlur(makeVolume(axisGeometry(ph.lo, ph.hi, [vox, vox, vox]), ph.hu), psf, 25);
  const work = prepareVolume(vol, { voxelSize: vox });
  const an = analyze(work);
  const base = defaultParams(work, an);
  const fused = await buildMesh(work, { ...base, separateBones: false, joinParts: false });
  const t = performance.now();
  const sep = await buildMesh(work, { ...base, joinParts: false });
  console.log(`gap ${gap} voxel ${vox} cortex ${cortexHU} psf ${psf}: thr ${base.threshold} smoothing ${base.smoothing} | fused parts ${fused.stats.parts} -> separated ${sep.stats.parts} (expect ${ph.bones.length}), joints ${sep.stats.bonesSeparated}, split ${sep.stats.timingsMs.split} ms, volumes ${sep.parts.map((p) => (p.volumeMm3 / 1000).toFixed(2)).join(' ')}`);
}
