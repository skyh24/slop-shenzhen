const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { test } = require('node:test');

const rect = (x1, z1, x2, z2) => [{ x: x1, z: z1 }, { x: x2, z: z1 }, { x: x2, z: z2 }, { x: x1, z: z2 }];
const geo = {
  mapRegions: { regions: [
    { id: 'outer', type: 'park', polygons: [{ outer: rect(0, 0, 10, 10), holes: [rect(2, 2, 4, 4)] }] },
    { id: 'inner', type: 'park', polygons: [{ outer: rect(5, 5, 15, 15), holes: [] }] }
  ] },
  roadGraph: { metadata: [{ osmId: 'way/1' }] },
  roadFrontage: { features: [{ kind: 'paving', id: 'existing' }] }
};
const binding = (kind, id, params) => ({ target: { kind, id }, params });
const config = (...bindings) => ({ schemaVersion: 1, bindings });

test('area precedence respects holes and verified ownership, reports ties once, and applies explicit overrides', async () => {
  const { createSceneStyle } = await import('../js/sz-scene-style.js');
  const conflicts = [];
  const bindings = [
    binding('region', 'outer', { surfaceStyle: 'light-stone' }),
    binding('region', 'inner', { surfaceStyle: 'warm-stone' }),
    binding('park', 'inner', { fixtureSetbackM: 3 }),
    binding('mountain', 'outer', { fixtureSetbackM: 0, maxSlopeRatio: null }),
    binding('surface', 'existing', { surfaceStyle: 'park-gravel' }),
    binding('road', 'way/1', { lampsEnabled: false })
  ];
  const resolver = createSceneStyle(geo, config(...bindings), entry => conflicts.push(entry));
  const defaults = { surfaceStyle: 'concrete', fixtureSetbackM: 5, maxSlopeRatio: 0.4 };
  assert.deepEqual(resolver.resolve(defaults, { x: 3, z: 3 }), defaults);
  const at = { x: 8, z: 8 };
  const overlap = { surfaceStyle: 'concrete', fixtureSetbackM: 0, maxSlopeRatio: null };
  assert.deepEqual(resolver.resolve(defaults, at), overlap);
  assert.deepEqual(resolver.resolve(defaults, at), overlap);
  assert.deepEqual(createSceneStyle(geo, config(...bindings.reverse()), () => {}).resolve(defaults, at), overlap);
  assert.deepEqual(conflicts, [{ field: 'surfaceStyle', kind: 'region', ids: ['inner', 'outer'] }]);
  assert.equal(resolver.resolve(defaults, { ...at, regionId: 'outer' }).surfaceStyle, 'light-stone');
  assert.equal(resolver.resolve(defaults, { ...at, regionId: 'inner', kind: 'surface', id: 'existing' }).surfaceStyle, 'park-gravel');
  assert.equal(resolver.road('way/1').lampsEnabled, false);
});

test('style loader rejects invalid versions, dangling references, duplicates, and source fact overrides', async () => {
  const { createSceneStyle } = await import('../js/sz-scene-style.js');
  assert.throws(() => createSceneStyle(geo, { ...config(), schemaVersion: 2 }), /schemaVersion: 2/);
  for (const row of [
    binding('road', 'way/1', { lanes: 4 }),
    binding('road', 'way/1', { lampSpacingM: 0 }),
    binding('road', 'way/1', { lampsEnabled: null }),
    binding('region', 'outer', { surfaceStyle: 'missing' }),
    binding('mountain', 'outer', { maxSlopeRatio: -1 }),
    binding('road', 'way/2', { lampsEnabled: false }),
    binding('region', 'missing', { surfaceStyle: 'concrete' })
  ]) assert.throws(() => createSceneStyle(geo, config(row)), /scene style/);
  const row = binding('road', 'way/1', { lampsEnabled: false });
  assert.throws(() => createSceneStyle(geo, config(row, row)), /Duplicate scene style binding/);
  const legacy = createSceneStyle({ ...geo, mapRegions: null }, config(binding('region', 'outer', { surfaceStyle: 'light-stone' })));
  assert.equal(legacy.resolve({ surfaceStyle: 'concrete' }, { regionId: 'outer' }).surfaceStyle, 'concrete');
});

test('production style bindings reuse decoded source boundaries without modifying city facts', async () => {
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { SCENE_STYLE, createSceneStyle } = await import('../js/sz-scene-style.js');
  const raw = JSON.parse(gunzipSync(readFileSync(require.resolve('../js/sz-city.json.gz'))));
  const { geo, buildings } = decodeCityPayload(raw);
  const style = createSceneStyle(geo);
  const defaults = { surfaceStyle: 'concrete' };
  assert.equal(style.resolve(defaults, { x: -500, z: 1166 }).surfaceStyle, 'light-stone');
  assert.equal(style.resolve(defaults, { x: 628, z: 847 }).surfaceStyle, 'concrete');
  const extra = binding('region', 'osm:way/776141699', { surfaceStyle: 'warm-stone' });
  assert.equal(createSceneStyle(geo, config(...SCENE_STYLE.bindings, extra))
    .resolve(defaults, { x: 628, z: 847 }).surfaceStyle, 'warm-stone');
  assert.equal(geo.roadGraph, raw.roadGraph);
  assert.equal(buildings[0].sourceId, raw.buildings.id[0]);
  assert.equal(geo.mapRegions.regions[0].kind, 'region');
  assert.equal(geo.frame.angleUnits, 'rad');
});
