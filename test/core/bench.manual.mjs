// Manual benchmark (not part of `node --test`): node test/core/bench.manual.mjs [n=256] [voxel=0.35]
import { analyze, defaultParams, buildMesh } from '../../src/core/index.js';
import { multiBoneWork } from './helpers.js';

const sizes = process.argv[2] ? [parseInt(process.argv[2], 10)] : [256, 320];
const voxel = process.argv[3] ? parseFloat(process.argv[3]) : 0.35;
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
for (const n of sizes) {
  let t = performance.now();
  const work = multiBoneWork(n, voxel);
  console.log(`\n=== ${n}^3 = ${(n ** 3 / 1e6).toFixed(1)} M voxels @ ${voxel} mm (generated in ${(performance.now() - t).toFixed(0)} ms)`);
  t = performance.now();
  const an = analyze(work);
  console.log(`analyze: ${(performance.now() - t).toFixed(0)} ms threshold ${an.threshold} softPeak ${an.softPeak} sigma ${an.softSigma} otsu ${an.otsu}`);
  const p = defaultParams(work, an);
  peakRss = 0;
  t = performance.now();
  const mesh = await buildMesh(work, p, (f, l) => { peakRss = Math.max(peakRss, process.memoryUsage().rss); });
  const total = performance.now() - t;
  const s = mesh.stats;
  console.log(`buildMesh total ${total.toFixed(0)} ms; parts ${s.parts} pegs ${mesh.pegs.length} unconnected ${s.unconnectedParts} dropped ${s.droppedIslands}`);
  console.log(`triangles ${s.triangles} (before decimation ${s.trianglesBeforeDecimation}), watertight ${s.watertight}, volume ${s.volumeMm3.toFixed(0)} mm3, size ${s.sizeMm.map((v) => v.toFixed(1))}`);
  console.table(s.timingsMs);
  console.log(`peak RSS ${(peakRss / 1048576).toFixed(0)} MB, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
}
clearInterval(sampler);
