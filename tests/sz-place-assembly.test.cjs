const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const assembly = loadModule(read('sz-place-assembly.js'));
const atlasModule = loadModule(read('sz-surface-atlas.js'));

const sampleAt = value => () => value;

test('ground layers keep registration order and are applied to the atlas once', () => {
  const places = assembly.createPlaceAssembly();
  const walk = (x) => (x >= 0 ? 1 : null);
  const yard = (x) => (x >= 5 ? 2 : null);
  places.register({ id: 'walk', ground: { heightSource: 'rendered-terrain', sample: walk } });
  places.register({ id: 'yard', ground: { heightSource: 'rendered-terrain', sample: yard } });
  const atlas = atlasModule.createSurfaceAtlas({ groundHeight: () => 0 });
  places.applyGrounds(atlas);
  assert.equal(atlas.at(-1, 0).y, 0);
  assert.equal(atlas.at(-1, 0).surfaceId, 'terrain');
  assert.equal(atlas.at(2, 0).surfaceId, 'walk');
  assert.equal(atlas.at(2, 0).heightSource, 'rendered-terrain');
  assert.equal(atlas.at(6, 0).surfaceId, 'yard');
  assert.equal(atlas.heightAt(6, 0), 2, 'a later place covers an earlier one');
  // 再次落图只追加尚未加入的层，不重复注册。
  places.applyGrounds(atlas);
  places.register({ id: 'roof', ground: { heightSource: 'estimate', sample: (x) => (x >= 7 ? 3 : null) } });
  places.applyGrounds(atlas);
  assert.equal(atlas.heightAt(8, 0), 3);
  assert.equal(atlas.heightAt(6, 0), 2);
});

test('a place can provide a ground layer without owning anything else', () => {
  const places = assembly.createPlaceAssembly();
  places.register({ id: 'paving', ground: { heightSource: 'rendered-terrain', sample: sampleAt(0.15) } });
  assert.equal(places.standable.length, 0, 'no standable surface is implied');
  assert.equal(places.reservesWalk(0, 0, 1), false, 'no walk reservation is implied');
  assert.equal(places.reservesLampSites(0, 0, 1), false, 'no lamp reservation is implied');
  assert.equal(places.excludesWalker(0, 0, 1), false, 'no walker exclusion is implied');
  assert.equal(places.allowsGroundMode('car', 0, 0, { surfaceId: 'terrain', heightSource: 'terrain' }), true,
    'decoration never grants or removes access by itself');
});

test('standable surfaces keep identity and registration order', () => {
  const places = assembly.createPlaceAssembly();
  const first = { id: 'north:walk:southOverpass:1', triangles: [] };
  const second = { id: 'north:walk:northConcourse:1', triangles: [] };
  places.register({ id: 'north-station', standable: [first, second] });
  places.register({ id: 'later', standable: [{ id: 'later:deck:1', triangles: [] }] });
  assert.equal(places.standable[0], first);
  assert.equal(places.standable[1], second);
  assert.equal(places.standable.map(surface => surface.id).join(','),
    'north:walk:southOverpass:1,north:walk:northConcourse:1,later:deck:1');
  assert.throws(() => places.register({ id: 'bad', standable: [{ triangles: [] }] }), /identified surfaces/);
});

test('walk reservation and lamp reservation stay separate and grant nothing', () => {
  const places = assembly.createPlaceAssembly();
  places.register({ id: 'walk', walkReserve: (x) => x > 0 });
  assert.equal(places.reservesWalk(1, 0, 1), true);
  assert.equal(places.reservesWalk(-1, 0, 1), false);
  assert.equal(places.reservesLampSites(1, 0, 1), false, 'lamps are not implied by a walk reservation');
  assert.equal(places.excludesWalker(1, 0, 1), false, 'a walk reservation does not exclude walkers');
  assert.equal(places.allowsGroundMode('car', 1, 0, { surfaceId: 'terrain', heightSource: 'terrain' }), true);
  places.register({ id: 'lamp-walk', lampReserve: (x) => x > 0 });
  assert.equal(places.reservesLampSites(1, 0, 1), true);
  assert.equal(places.reservesWalk(1, 0, 1), true);
});

test('walker exclusion is its own facet', () => {
  const places = assembly.createPlaceAssembly();
  const stations = [];
  places.register({ id: 'station', walkerExclusion: (x, z, radius) => { stations.push(radius); return x < 0; } });
  assert.equal(places.excludesWalker(-1, 0, 2), true);
  assert.equal(places.excludesWalker(1, 0, 2), false);
  assert.equal(stations.join(','), '2,2', 'the consumer decides the clearance');
  assert.equal(places.reservesWalk(-1, 0, 2), false);
});

test('a restricted place blocks ground modes except on its own non-terrain surface', () => {
  const places = assembly.createPlaceAssembly();
  const margins = [];
  places.register({ id: 'station', access: { restricted: (x, z, margin) => { margins.push(margin); return x < 0; } } });
  const terrain = { surfaceId: 'terrain', heightSource: 'terrain' };
  const own = { surfaceId: 'north:walk:southOverpass:1', heightSource: 'estimate' };
  assert.equal(assembly.GROUND_MODE_CLEARANCE_M, 0.58);
  assert.equal(places.allowsGroundMode('car', -1, 0, terrain), false);
  assert.equal(places.allowsGroundMode('person', -1, 0, terrain), false);
  assert.equal(places.allowsGroundMode('car', -1, 0, own), true);
  assert.equal(places.allowsGroundMode('car', 1, 0, terrain), true);
  assert.ok(margins.every(margin => margin === assembly.GROUND_MODE_CLEARANCE_M));
  // 地图落点与地面模式共用同一份围合事实，但余量由调用方给（teleport 传 0.7）。
  assert.equal(places.restricted(-1, 0, 0.7), true);
  assert.equal(margins.at(-1), 0.7);
  assert.equal(places.restricted(1, 0), false);
});

test('public routes are composed in registration order with the caller context', () => {
  const places = assembly.createPlaceAssembly();
  const context = { colliders: [], carriageway: () => false };
  places.register({ id: 'first', publicRoutes: ctx => [{ id: 'first:route', ctx }] });
  places.register({ id: 'second', publicRoutes: ctx => [{ id: 'second:route', ctx }] });
  const routes = places.publicRoutes(context);
  assert.equal(routes.map(route => route.id).join(','), 'first:route,second:route');
  assert.equal(routes[0].ctx, context);
  assert.equal(places.publicRoutes(context).length, routes.length, 'queries do not consume the builders');
  places.register({ id: 'broken', publicRoutes: () => null });
  assert.throws(() => places.publicRoutes(context), /must return an array/);
});

test('groundLayer reuses the registered declaration for secondary atlases', () => {
  const places = assembly.createPlaceAssembly();
  const sample = (x, z) => (x >= 0 ? 1 : null);
  places.register({ id: 'walk', ground: { heightSource: 'rendered-terrain', sample } });
  const layer = places.groundLayer('walk');
  assert.equal(layer.id, 'walk');
  assert.equal(layer.surfaceId, 'walk');
  assert.equal(layer.heightSource, 'rendered-terrain');
  assert.equal(layer.sample, sample);
  places.register({ id: 'paved', ground: { surfaceId: 'paved-walk', heightSource: 'rendered-terrain', sample } });
  assert.equal(places.groundLayer('paved').surfaceId, 'paved-walk');
  assert.throws(() => places.groundLayer('missing'), /No ground layer registered/);
  const paved = atlasModule.createSurfaceAtlas({ groundHeight: () => 0, layers: [places.groundLayer('paved')] });
  assert.equal(paved.at(1, 0).y, 1);
  assert.equal(paved.at(1, 0).surfaceId, 'paved-walk');
  assert.equal(paved.at(1, 0).heightSource, 'rendered-terrain');
});

test('registration rejects missing identity, duplicates and malformed facets', () => {
  const places = assembly.createPlaceAssembly();
  assert.throws(() => places.register({}), /requires identity/);
  assert.throws(() => places.register(), /requires an object/);
  places.register({ id: 'walk' });
  assert.throws(() => places.register({ id: 'walk' }), /Duplicate place/);
  assert.throws(() => places.register({ id: 'bad-ground', ground: { sample: () => 1 } }), /height provenance/);
  assert.throws(() => places.register({ id: 'bad-sample', ground: { heightSource: 'estimate' } }), /sample/);
  assert.throws(() => places.register({ id: 'bad-walk', walkReserve: true }), /requires a function/);
  assert.throws(() => places.register({ id: 'bad-access', access: {} }), /restricted/);
  assert.throws(() => places.applyGrounds(null), /surface atlas/);
  assert.equal(places.has('walk'), true);
  assert.equal(places.size, 1);
});
