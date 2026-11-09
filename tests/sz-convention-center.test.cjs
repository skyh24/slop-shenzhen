const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const collision = loadModule(read('building-collision.js'));
const terrain = loadModule(read('sz-terrain.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const parts = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
const convention = loadModule(read('sz-landmarks/convention-center.js'), { imports: {
  './parts.js': parts, '../sz-terrain.js': terrain
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const sources = new Map(buildings.map(row => [row.id, row]));
const model = convention.build(sources, geo.terrain);
const sample = model[0].baseSample;
const base = terrain.terrainHeight(geo.terrain, sample.x, sample.z);

test('Futian Exhibition Center retains the nine halls with Hall 2 at the southwest', () => {
  const halls = model.filter(part => part.style === 'conventionHall');
  assert.equal(halls.length, 9);
  const order = list => list.sort((a, b) => a.minX - b.minX).map(part => Number(part.id.split(':')[2]));
  assert.deepEqual(order(Array.from(halls.filter(part => part.minZ > 1415))), [2, 1, 9]);
  assert.deepEqual(order(Array.from(halls.filter(part => part.minZ < 1415))), [3, 4, 5, 6, 7, 8]);
  assert.ok(convention.sourceIds.every(id => model.some(part => part.sourceId === id)));
  assert.ok(model.every(part => part.baseSource === 'dem-north-plaza-sample' && part.baseSample === sample));
  const outer = sources.get('way/146862823').polygons[0];
  assert.ok(!collision.polygonContains(outer, sample.x, sample.z));
});

test('Futian Exhibition Center separates the curved hall roofs and the raised congress building', () => {
  const cover = model.filter(part => part.id.includes(':cover:'));
  assert.ok(cover.some(part => part.style === 'conventionSkylight'));
  assert.ok(cover.some(part => part.style === 'conventionRoof'));
  assert.ok(Math.abs(Math.max(...cover.map(part => part.maxY)) - base - 35) < 0.1);
  assert.ok(Math.min(...cover.flatMap(part => part.roofPanel.top)) < base + 15);
  const hall = cover.filter(part => part.id.startsWith('convention-center:hall:1:'));
  const firstGlazed = hall.find(part => part.style === 'conventionSkylight');
  const bandId = firstGlazed.id.split(':').slice(0, 6).join(':') + ':';
  const band = hall.filter(part => part.id.startsWith(bandId));
  assert.ok(band.length > 16 && band.every(part => part.style === 'conventionSkylight'));
  assert.ok(Math.max(...band.map(part => part.maxZ)) - Math.min(...band.map(part => part.minZ)) > 90);
  assert.ok(Math.max(...band.map(part => part.maxX)) - Math.min(...band.map(part => part.minX)) < 11);
  const high = model.filter(part => part.id.includes(':congress-roof:'));
  assert.ok(Math.abs(Math.max(...high.map(part => part.maxY)) - base - 60) < 0.15);
  const deck = model.find(part => part.id === 'convention-center:congress-deck');
  assert.ok(Math.abs(deck.minY - base - 42.8) < 1e-4);
  assert.ok(Math.abs(deck.maxY - base - 45) < 1e-4);
});

test('Futian Exhibition Center preserves the north entry approach and fire lane clearances', () => {
  const approach = model.filter(part => part.id.startsWith('convention-center:north-step:'));
  assert.equal(approach.length, 42);
  assert.ok(approach.every((part, i) => part.roofContact && (i === 0 || part.maxY > approach[i - 1].maxY)));
  assert.ok(Math.abs(approach.at(-1).maxY - base - 7.5) < 1e-5);
  const bridges = model.filter(part => part.id.startsWith('convention-center:lane-bridge:'));
  assert.equal(bridges.length, 2);
  for (const bridge of bridges) {
    const x = (bridge.minX + bridge.maxX) / 2, z = (bridge.minZ + bridge.maxZ) / 2;
    assert.ok(bridge.minY > base + 6.6 && bridge.maxY > base + 12);
    assert.ok(model.every(part => part.minY >= base + 2 || part.maxY <= base
      || !collision.polygonContains(part.polygon, x, z)));
  }
});
