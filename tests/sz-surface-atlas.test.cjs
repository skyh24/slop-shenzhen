const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(__dirname, '../js/sz-surface-atlas.js')).toString('base64')}`);

// 合成三层：地面全域、铺装带、场地平台。高度只由数据决定，不依赖 three 或渲染。
const layers = () => [
  { id: 'terrain', heightSource: 'terrain', sample: () => 0 },
  { id: 'public-walk', heightSource: 'rendered-terrain', sample: (x, z) => (x >= 10 && x <= 20 && z >= 0 && z <= 10 ? 0.15 : null) },
  { id: 'districts', heightSource: 'rendered-terrain', sample: (x, z) => (x >= 15 && x <= 20 && z >= 0 && z <= 5 ? 0.6 : null) }
];

test('the last registered layer wins and keeps its provenance', async () => {
  const { createSurfaceAtlas } = await modulePromise;
  const atlas = createSurfaceAtlas({ layers: layers() });
  assert.deepEqual(atlas.at(2, 2), { y: 0, surfaceId: 'terrain', heightSource: 'terrain' });
  assert.deepEqual(atlas.at(12, 2), { y: 0.15, surfaceId: 'public-walk', heightSource: 'rendered-terrain' });
  assert.deepEqual(atlas.at(17, 2), { y: 0.6, surfaceId: 'districts', heightSource: 'rendered-terrain' });
});

test('an uncovered point returns null instead of borrowing a lower layer', async () => {
  const { createSurfaceAtlas } = await modulePromise;
  const atlas = createSurfaceAtlas({ layers: [{ id: 'walk', sample: () => null }] });
  assert.equal(atlas.at(0, 0), null);
  assert.equal(atlas.heightAt(0, 0), null);
  assert.equal(atlas.heightAt(Number.NaN, 0), null);
  assert.deepEqual(atlas.all(0, 0), []);
});

test('all() reports every covering layer in height order', async () => {
  const { createSurfaceAtlas } = await modulePromise;
  const atlas = createSurfaceAtlas({ layers: layers() });
  assert.deepEqual(atlas.all(17, 2).map(row => [row.surfaceId, row.y]),
    [['terrain', 0], ['public-walk', 0.15], ['districts', 0.6]]);
});

test('a layer must declare identity and a sample function', async () => {
  const { createSurfaceAtlas } = await modulePromise;
  const atlas = createSurfaceAtlas();
  assert.throws(() => atlas.add({ sample: () => 1 }), /identity/);
  assert.throws(() => atlas.add({ id: 'walk' }), /sample function/);
  atlas.add({ id: 'walk', sample: () => 1 });
  assert.throws(() => atlas.add({ id: 'walk', sample: () => 2 }), /Duplicate surface layer/);
});

test('the scene chain keeps the old ?? precedence at every probe', async () => {
  const { createSurfaceAtlas } = await modulePromise;
  const landscape = (x, z) => (x >= 5 && x < 8 && z >= 5 && z < 8 ? 2.5 : null);
  const frontage = (x, z) => (x >= 4 && x < 9 && z >= 4 && z < 9 ? 0.2 : null);
  const walk = (x, z) => (x >= 3 && x < 6 && z >= 3 && z < 6 ? 0.15 : null);
  const ground = () => 0;
  const districts = (x, z) => (x >= 7 && x < 8 && z >= 7 && z < 8 ? 3 : null);
  const station = (x, z) => (x >= 1 && x < 2 && z >= 1 && z < 2 ? 1.5 : null);
  const atlas = createSurfaceAtlas({ groundHeight: ground })
    .add({ id: 'public-walk', sample: walk })
    .add({ id: 'road-frontage', sample: frontage })
    .add({ id: 'road-landscape', sample: landscape })
    .add({ id: 'districts', sample: districts })
    .add({ id: 'north-station', sample: station });
  const chain = (x, z) => station(x, z) ?? districts(x, z) ?? landscape(x, z) ?? frontage(x, z) ?? walk(x, z) ?? ground(x, z);
  for (let x = 0; x <= 12; x += 0.5) {
    for (let z = 0; z <= 12; z += 0.5) assert.equal(atlas.heightAt(x, z), chain(x, z), `${x},${z}`);
  }
});