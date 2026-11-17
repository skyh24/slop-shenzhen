const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const batchModule = loadModule(read('sz-street-batch.js'));
const { chunkKey, createStreetBatch } = batchModule;

const box = (minX, maxX, minZ, maxZ) => ({ minX, maxX, minZ, maxZ });

test('chunk keys floor into the same grid for every caller', () => {
  assert.equal(chunkKey(0, 0, 1000), '0,0');
  assert.equal(chunkKey(-0.5, -0.5, 1000), '-1,-1');
  assert.equal(chunkKey(999.9, 1000, 1000), '0,1');
  assert.equal(chunkKey(114054.5, 225463, 250), '456,901');
  assert.throws(() => chunkKey(Number.NaN, 0, 1000), /finite position/);
  assert.throws(() => chunkKey(0, 0, 0), /positive chunk size/);
});

test('a hard threshold has no hysteresis and keeps the boundary inclusive', () => {
  const seen = [];
  const batch = createStreetBatch({ enterM: 1600 });
  batch.add({ key: 'a', center: { x: 0, z: 0 }, apply: state => seen.push(state) });
  const first = batch.update(0, 1600);
  assert.deepEqual([first.hidden, first.visible, Object.keys(first.levels).length], [0, 1, 0]);
  assert.deepEqual(seen, ['base']);
  batch.update(0, 1600.001);
  assert.equal(batch.state('a'), 'hidden');
  batch.update(0, 1600);
  assert.equal(batch.state('a'), 'base');
});

test('hysteresis enters at 828 and only leaves past 900', () => {
  const batch = createStreetBatch({ enterM: 828, exitM: 900,
    levels: [{ id: 'near', enterM: 180, exitM: 198 }] });
  batch.add({ key: 'cell', center: { x: 0, z: 0 }, apply() {} });
  batch.update(0, 850);
  assert.equal(batch.state('cell'), 'hidden');
  batch.update(0, 828);
  assert.equal(batch.state('cell'), 'base');
  batch.update(0, 890);
  assert.equal(batch.state('cell'), 'base');
  batch.update(0, 901);
  assert.equal(batch.state('cell'), 'hidden');
});

test('the near band uses its own exit distance so the edge does not flicker', () => {
  const batch = createStreetBatch({ enterM: 900, exitM: 1000,
    levels: [{ id: 'near', enterM: 180, exitM: 198 }] });
  batch.add({ key: 'cell', center: { x: 0, z: 0 }, apply() {} });
  batch.update(0, 179);
  assert.equal(batch.state('cell'), 'near');
  batch.update(0, 190);
  assert.equal(batch.state('cell'), 'near', 'still inside the 198 m exit band');
  batch.update(0, 200);
  assert.equal(batch.state('cell'), 'base');
  batch.update(0, 185);
  assert.equal(batch.state('cell'), 'base', 're-entering the near band costs a full 180 m');
  batch.update(0, 179.9);
  assert.equal(batch.state('cell'), 'near');
});

test('a box measures distance to its nearest edge, a centre measures point distance', () => {
  const batch = createStreetBatch({ enterM: 50 });
  batch.add({ key: 'boxed', box: box(0, 100, 0, 100), apply() {} });
  batch.add({ key: 'centred', center: { x: 10, z: 10 }, apply() {} });
  batch.update(0, 0);
  assert.equal(batch.state('boxed'), 'base', 'inside the box');
  assert.equal(batch.state('centred'), 'base', '14 m from the centre');
  batch.update(-40, 50);
  assert.equal(batch.state('boxed'), 'base', '40 m west of the west edge');
  assert.equal(batch.state('centred'), 'hidden', '64 m from the centre');
  batch.update(-60, 50);
  assert.equal(batch.state('boxed'), 'hidden', '60 m west of the west edge');
  assert.equal(batch.state('centred'), 'hidden');
});

test('apply runs only when the state changes and always once before the first frame', () => {
  const seen = [];
  const batch = createStreetBatch({ enterM: 100, exitM: 120 });
  batch.add({ key: 'a', center: { x: 0, z: 0 }, apply: state => seen.push(state) });
  batch.update(0, 0);
  batch.update(0, 50);
  batch.update(0, 119);
  batch.update(0, 121);
  assert.deepEqual(seen, ['base', 'hidden']);
  assert.equal(batch.size(), 1);
});

test('a batch reports per-level counts and refuses unknown keys', () => {
  const batch = createStreetBatch({ enterM: 900, exitM: 1000,
    levels: [{ id: 'near', enterM: 180, exitM: 198 }] });
  batch.add({ key: 'near', center: { x: 0, z: 0 }, apply() {} });
  batch.add({ key: 'base', center: { x: 400, z: 0 }, apply() {} });
  batch.add({ key: 'hidden', center: { x: 1500, z: 0 }, apply() {} });
  const summary = batch.update(0, 0);
  assert.deepEqual({ hidden: summary.hidden, visible: summary.visible, near: summary.levels.near },
    { hidden: 1, visible: 2, near: 1 });
  assert.equal(batch.state('nope'), null);
});

test('malformed units and bands fail at registration, not at frame time', () => {
  assert.throws(() => createStreetBatch({}), /finite enter distance/);
  assert.throws(() => createStreetBatch({ enterM: 100, exitM: 50 }), /shorter than its enter distance/);
  assert.throws(() => createStreetBatch({ enterM: 100, levels: [{ id: 'near', enterM: 50, exitM: 40 }] }),
    /level exit distance cannot be shorter/);
  assert.throws(() => createStreetBatch({ enterM: 100, levels: [{ id: 'near', enterM: 10 }, { id: 'near', enterM: 20 }] }),
    /Duplicate street batch level/);
  const batch = createStreetBatch({ enterM: 100 });
  assert.throws(() => batch.add({ key: '', center: { x: 0, z: 0 }, apply() {} }), /requires a key/);
  assert.throws(() => batch.add({ key: 'a', center: { x: 0, z: 0 } }), /apply function/);
  assert.throws(() => batch.add({ key: 'a', apply() {} }), /requires a box or a centre/);
  assert.throws(() => batch.add({ key: 'a', box: box(10, 0, 0, 10), apply() {} }), /ordered box/);
  batch.add({ key: 'a', center: { x: 0, z: 0 }, apply() {} });
  assert.throws(() => batch.add({ key: 'a', center: { x: 0, z: 0 }, apply() {} }), /Duplicate street batch unit/);
  assert.throws(() => batch.update(Number.NaN, 0), /finite camera position/);
});

test('copied boxes are not affected by later mutation', () => {
  const source = box(0, 10, 0, 10);
  const batch = createStreetBatch({ enterM: 5 });
  batch.add({ key: 'a', box: source, apply() {} });
  source.maxX = 1000;
  batch.update(100, 5);
  assert.equal(batch.state('a'), 'hidden');
});
