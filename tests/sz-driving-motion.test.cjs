const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { footprintPoint, sampleFootprint } = loadModule(
  readFileSync(join(__dirname, '../js/sz-driving-motion.js'), 'utf8'));

test('footprint probes use one local frame: +x to the right, +z forward', () => {
  const point = { x: 0, z: 0 };
  // heading 0 面向 +z（南），局部 +x 即世界 +x。
  assert.deepEqual(footprintPoint(10, 20, 0, 1, 3, 4, point), { x: 13, z: 24 });
  // heading π/2 面向 +x（东），局部右方转到世界 -z。
  assert.deepEqual(footprintPoint(10, 20, 1, 0, 3, 4, point), { x: 14, z: 17 });
  const heading = 0.7, sin = Math.sin(heading), cos = Math.cos(heading);
  const world = footprintPoint(5, -2, sin, cos, -1.5, 2.25, { x: 0, z: 0 });
  assert.ok(Math.abs(world.x - (5 - 1.5 * cos + 2.25 * sin)) < 1e-12);
  assert.ok(Math.abs(world.z - (-2 + 1.5 * sin + 2.25 * cos)) < 1e-12);
});

test('a probe without support rejects the whole footprint before the remaining probes', () => {
  const calls = [];
  const sample = (x, z, px, pz) => {
    calls.push([x, z, px, pz]);
    return px === 2 ? null : 5;
  };
  const probes = [[0, 0], [2, 0], [0, 2]];
  assert.equal(sampleFootprint(1, 1, 0, 1, probes, sample), false);
  assert.deepEqual(calls.map(call => call[2]), [0, 2], 'sampling stops at the unsupported probe');
  // 探针按车身朝向变换后再取样，回调同时拿到局部偏移。
  assert.deepEqual(calls[0], [1, 1, 0, 0]);
  assert.deepEqual(calls[1], [3, 1, 2, 0]);
});

test('sampled heights are written in probe order for wheel and corner readback', () => {
  const heights = [];
  const probes = [[0, 0], [-0.8, 1.4], [0.8, 1.4], [-0.8, -1.4], [0.8, -1.4]];
  const sample = (x, z) => 10 + x;
  assert.equal(sampleFootprint(0, 0, 0, 1, probes, sample, heights), true);
  assert.deepEqual(heights, [10, 9.2, 10.8, 9.2, 10.8]);
  // 非有限高度与 null 一样按缺面处理。
  assert.equal(sampleFootprint(0, 0, 0, 1, probes, () => NaN, heights), false);
});
