// Manual check of the automatic focus on real series (data not committed):
//   node test/manual/focus.manual.mjs /path/to/series [...more]
import { StudyLoader } from '../../src/dicom/index.js';
import { dirSources, injectWasm } from '../dicom/helpers.js';
import { focusVolume } from '../../src/core/focus.js';

injectWasm();
for (const dir of process.argv.slice(2)) {
  const loader = new StudyLoader();
  const scan = await loader.scan(dirSources(dir));
  if (!scan.series.length) { console.log(dir, 'no series'); continue; }
  const vol = await loader.buildVolume(scan.recommendedId || scan.series[0].id);
  const t = performance.now();
  const f = focusVolume(vol, { debug: true });
  const ms = performance.now() - t;
  const ext = f.roi ? f.roi.max.map((m, a) => ((m - f.roi.min[a] + 1) * vol.spacing[a]).toFixed(0)).join('x') : 'full';
  console.log(`${dir.split('/').pop()}: dims ${vol.dims} active=${f.active} (${f.reason}) table=${f.tableRemoved} groups=${f.groups} hidden=${f.hiddenGroups} (${(100 * f.hiddenShare).toFixed(0)}% of bone) roi=${ext}mm ${ms.toFixed(0)}ms`);
  if (f.debug) for (const g of f.debug.list.slice(0, 6)) console.log(`     group cells=${g.cells} central=${g.central.toFixed(2)} rim=${g.rim} soft/bone=${(g.soft / g.cells).toFixed(2)} score=${g.score.toFixed(0)}`);
}
