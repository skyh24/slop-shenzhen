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
const chunjian = loadModule(read('sz-landmarks/chunjian.js'), { imports: {
  './parts.js': parts, '../building-collision.js': collision
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const sources = new Map(buildings.map(row => [row.id, row]));
const model = chunjian.build(sources, geo.terrain);
const stadium = sources.get('relation/9244350');
const concourse = sources.get('relation/9244351');
const base = terrain.terrainHeight(geo.terrain, stadium.cx, stadium.cz);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });

function occupies(part, x, z, lo, hi) {
  if (hi <= part.minY || lo >= part.maxY) return false;
  const collider = parts.partCollider(part);
  let polygon = collider.polygon;
  if (collider.loft) polygon = collision.loftContactPolygon(collider.loft, lo, hi);
  else if (collider.roofPanel) polygon = collision.roofPanelContactPolygon(collider.roofPanel, lo, hi);
  else if (collider.verticalSpan) polygon = collision.spanContactPolygon(polygon, collider.verticalSpan, lo, hi);
  return polygon !== null && collision.polygonContains(polygon, x, z);
}

test('Chunjian ties the four sourced shell pieces to the open field datum', () => {
  assert.ok(chunjian.sourceIds.every(id => model.some(part => part.sourceId === id)));
  assert.ok(model.every(row => row.baseSourceId === stadium.id
    && row.sourceHeight === sources.get(row.sourceId).height && row.heightSource === 'estimate'));
  const crest = Math.max(...model.map(part => part.maxY));
  assert.ok(Math.abs(crest - base - 42.3) < 0.05);
  for (const hall of ['way/665408866', 'way/665408865']) {
    const source = sources.get(hall);
    const hull = model.find(part => part.style === 'stadiumGlazing' && part.sourceId === hall);
    const dome = model.filter(part => part.id.startsWith(`chunjian:dome:${hall}:`));
    assert.ok(hull.polygon.outer.every(p => collision.polygonContains(source.polygons[0], p.x, p.z)));
    assert.equal(hull.minY, Math.fround(base));
    assert.ok(Math.max(...dome.map(part => part.maxY)) - Math.min(...dome.map(part => part.maxY)) > 4);
  }
});

test('Chunjian leaves both apertures clear and crosses real diagonal ribs', () => {
  for (const hole of [stadium, concourse].map(source => source.polygons[0].holes[0])) {
    const center = hole.reduce((p, q) => ({ x: p.x + q.x / hole.length, z: p.z + q.z / hole.length }), { x: 0, z: 0 });
    assert.ok(model.every(part => !occupies(part, center.x, center.z, base + 0.25, base + 43)));
  }
  const ribs = model.filter(part => part.id.startsWith('chunjian:rib:'));
  const directions = new Set(ribs.map(part => {
    const ring = part.polygon.outer;
    const a = midpoint(ring[0], ring[3]), b = midpoint(ring[1], ring[2]);
    return Math.round((b.z - a.z) / (b.x - a.x));
  }));
  assert.ok(ribs.length > 1000);
  assert.deepEqual([...directions].sort(), [-1, 1]);
  const rib = ribs.find(part => Math.abs(part.top[0] - part.top[1]) > 1);
  const ring = rib.polygon.outer;
  const center = midpoint(ring[0], ring[2]);
  const top = (rib.top[0] + rib.top[1]) / 2;
  assert.ok(occupies(rib, center.x, center.z, top - 0.3, top - 0.1));
  assert.ok(!occupies(rib, center.x, center.z, top - 2, top - 1));
});

test('Chunjian retains a climb-free span over the Sea Gate and the visible bridge deck collider', () => {
  const deck = model.filter(part => part.id.startsWith('chunjian:sea-gate-deck:'));
  assert.equal(deck.length, 14);
  assert.ok(deck.every(part => part.roofContact));
  const piers = model.filter(part => part.id.startsWith('chunjian:sea-gate-pier:'));
  assert.ok(Math.abs(piers[1].minZ - piers[0].maxZ - 103) < 0.001);
  const bridge = deck[6];
  const center = midpoint(bridge.polygon.outer[0], bridge.polygon.outer[2]);
  const height = (bridge.top[0] + bridge.top[1]) / 2;
  assert.ok(height > base + 29.5);
  assert.ok(occupies(bridge, center.x, center.z, height - 0.7, height - 0.2));
  const ground = terrain.terrainHeight(geo.terrain, center.x, center.z);
  assert.ok(model.every(part => !occupies(part, center.x, center.z, ground, ground + 2)));
});

test('Chunjian can decline replacement when a source opening is missing', () => {
  const partial = new Map(sources);
  partial.set(stadium.id, { ...stadium, polygons: [{ outer: stadium.polygons[0].outer, holes: [] }] });
  assert.equal(chunjian.build(partial, geo.terrain).length, 0);
});
