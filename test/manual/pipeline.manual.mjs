// Manual end-to-end run of the engine in Node on a real series (data not committed):
//   node test/manual/pipeline.manual.mjs /path/to/series [out.stl] [--maxVoxels=14e6] [--threshold=N] [--nofocus]
import fs from 'node:fs';
import { StudyLoader } from '../../src/dicom/index.js';
import { dirSources, injectWasm } from '../dicom/helpers.js';
import { prepareVolume, analyze, defaultParams, buildMesh, exportSTL } from '../../src/core/index.js';

injectWasm();
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const loader = new StudyLoader();
const scan = await loader.scan(dirSources(args[0]));
const vol = await loader.buildVolume(scan.recommendedId || scan.series[0].id);
let t = performance.now();
const work = prepareVolume(vol, { maxVoxels: Number(flags.maxVoxels || 14e6), focus: !('nofocus' in flags) });
const tPrep = performance.now() - t;
const a = analyze(work);
const p = defaultParams(work, a);
if ('keepVessels' in flags) p.dropVessels = false;
if ('nopegs' in flags) p.joinParts = false;
if (flags.threshold) p.threshold = Number(flags.threshold);
console.log(`${args[0].split('/').pop()}: grid ${work.dims} @${work.voxel} mm, prepare ${tPrep.toFixed(0)} ms, focus ${JSON.stringify(work.focus)}`);
console.log(`  analysis: threshold ${a.threshold}  softPeak ${a.softPeak} sigma ${a.softSigma} otsu ${a.otsu} metal ${a.hasMetal} | ${a.notes.join(' | ')}`);
if (!('noMesh' in flags)) {
  const m = await buildMesh(work, p);
  const s = m.stats;
  console.log(`  mesh: ${s.triangles} tris (from ${s.trianglesBeforeDecimation}), ${s.parts} parts, ${m.pegs.length} pegs, unconnected ${s.unconnectedParts}, dropped ${s.droppedIslands}, watertight ${s.watertight}, size ${s.sizeMm.map((v) => v.toFixed(0)).join('x')} mm, vol ${(s.volumeMm3 / 1000).toFixed(1)} cm3`);
  if ('parts' in flags) for (const q of m.parts.slice(0, 30)) console.log(`     part ${q.id}: ${(q.volumeMm3 / 1000).toFixed(2)} cm3, p95 ${q.denseHU.toFixed(0)} HU, elongation ${q.elongation.toFixed(1)}`);
  console.log(`  vessels dropped ${s.vesselsDropped}`);
  console.log(`  timings ${JSON.stringify(s.timingsMs)}  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  if (args[1]) fs.writeFileSync(args[1], exportSTL(m));
}
