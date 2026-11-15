import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, defaultParams, buildMesh, meshStats } from '../../src/core/index.js';
import { multiBoneWork, countMeshComponents } from './helpers.js';

test('performance smoke: 200^3 multi-bone buildMesh', async () => {
  const work = multiBoneWork(200, 0.4);
  const an = analyze(work);
  const p = defaultParams(work, an);
  const t0 = performance.now();
  const mesh = await buildMesh(work, p);
  const dt = performance.now() - t0;
  console.log(`# 200^3 threshold ${an.threshold} parts ${mesh.stats.parts} pegs ${mesh.pegs.length} tris ${mesh.stats.triangles} (before ${mesh.stats.trianglesBeforeDecimation}) total ${dt.toFixed(0)} ms`);
  console.log('# timings ' + JSON.stringify(mesh.stats.timingsMs));
  assert.ok(an.threshold >= 150 && an.threshold <= 350);
  assert.equal(mesh.stats.parts, 9, 'five long bones + four carpals');
  assert.equal(mesh.stats.unconnectedParts, 0);
  assert.equal(mesh.pegs.length, 8);
  assert.ok(mesh.stats.droppedIslands >= 1);
  const s = meshStats(mesh.positions, mesh.indices);
  assert.ok(s.watertight && s.volumeMm3 > 0);
  assert.ok(mesh.stats.triangles <= p.maxTriangles);
  assert.equal(countMeshComponents(mesh.indices, mesh.positions.length / 3), 1);
  assert.ok(dt < 60000, 'not absurdly slow');
});
