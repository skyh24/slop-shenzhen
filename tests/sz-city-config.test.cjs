const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const root = join(__dirname, '..');
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const source = path => readFileSync(join(root, path), 'utf8');
const { fixtureTerrainSurface } = require('./helpers/terrain-surface.cjs');
const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const fixture = {
  bounds: [-100, -100, 100, 100],
  coverage: [{ outer: ring(-100, -100, 100, 90), holes: [] }],
  land: [{ outer: ring(-100, -100, 100, 100), holes: [] }],
  water: [{ outer: ring(20, -10, 30, 10), holes: [] }],
  landmarks: [{ id: 'civic-center', name: 'Civic', x: 0, z: 0, height: 40, phase: 1 },
    { id: 'outside', name: 'Outside', x: 0, z: 95, height: 40, phase: 1 },
    { id: 'later', name: 'Later', x: 50, z: 50, height: 20, phase: 2 }],
  terrain: { x0: -100, z0: -100, step: 100, nx: 3, nz: 3, heightScale: 0.1,
    heights: Array(9).fill(100), processing: { heightSource: 'test-dem' } },
  roadGraph: { nodes: [-90, 0, 90, 0, -90, 5, 90, 5, -90, -30, 90, -30],
    names: ['Ground Road', 'Bridge Road'],
    links: [[0, 1, 0, 7, 2, 0, []], [2, 3, 1, 7, 2, 0, []], [4, 5, 0, 7, 2, 0, []]],
    metadata: [
      { osmId: 'way/1', highway: 'primary', heightSource: 'terrain', widthSource: 'estimate-from-class', layer: 0, bridge: false, tunnel: false },
      { osmId: 'way/2', highway: 'primary', heightSource: 'unresolved', widthSource: 'estimate-from-class', layer: 1, bridge: true, tunnel: false },
      { osmId: 'way/3', highway: 'primary', heightSource: 'terrain', widthSource: 'osm-width', layer: 0, bridge: false, tunnel: false }
    ] }
};
fixture.terrainSurface = fixtureTerrainSurface(fixture.terrain);
const building = { minX: -5, maxX: 5, minZ: -5, maxZ: 5, polygons: [{ outer: ring(-5, -5, 5, 5), holes: [] }] };
globalThis.__cityConfigFixture = { GEO: fixture, REAL_BUILDINGS: [building] };
const terrain = uri(source('js/sz-ground-surface.js'));
const polygon = uri(source('js/sz-polygon.js'));
const spatial = uri(source('js/sz-spatial.js').replace('./sz-ground-surface.js', terrain)
  .replace('./sz-polygon.js', polygon));
const configSource = source('js/sz-city-config.js')
  .replace('./sz-geodata.js', uri('export const {GEO,REAL_BUILDINGS}=globalThis.__cityConfigFixture;'))
  .replace('./sz-spatial.js', spatial)
  .replace('./building-collision.js', uri(source('js/building-collision.js').replace('./sz-polygon.js', polygon)))
  .replace('./sz-polygon.js', polygon)
  .replace('./sz-strings.js', uri(source('js/sz-strings.js')));
const modulePromise = import(uri(configSource));

test('Shenzhen location queries retain road names without inventing districts or coverage', async () => {
  const { createCityConfig } = await modulePromise;
  const city = createCityConfig(fixture, [building]);
  assert.equal(city.districtAt(0, 0), null);
  assert.equal(city.getLocationLabel(0, 0), 'Ground Road');
  assert.equal(city.nearestRoads(0, 0, 80).filter(hit => hit.road.name === 'Ground Road').length, 1);
  assert.equal(city.getLocationInfo(0, 95).kind, 'outside');
  assert.equal(city.terrainHeight(0, 95), null);
  assert.deepEqual(city.getLandIntervalsAtZ(0), [{ westX: -100, eastX: 20 }, { westX: 30, eastX: 100 }]);
  assert.equal(city.isOnLand(25, 0), false);
  assert.equal(city.SZ_LANDMARKS.length, 1);
});

test('derived arrivals exclude unresolved bridges, water and building footprints', async () => {
  const { createCityConfig } = await modulePromise;
  const city = createCityConfig(fixture, [building]);
  const arrival = city.findGroundArrival({ x: 0, z: 5 });
  assert.ok(arrival);
  assert.equal(arrival.sourceRoadId, 'way/1');
  assert.ok(Math.abs(arrival.y - 10) < 1e-12);
  assert.equal(arrival.heightSource, 'test-dem');
  assert.ok(Math.abs(arrival.x) > 5);
  assert.equal(arrival.placement, 'derived-road-arrival');
  assert.equal(city.findGroundArrival({ x: 0, z: 5 }, 'car', { isClear: () => false }), null);
  assert.equal(city.findGroundArrival({ x: 0, z: 95 }), null);
  assert.ok(city.SPAWN_POINT);
  assert.ok(city.TELEPORT_LOCATIONS['civic-center']);
  assert.throws(() => city.findGroundArrival({ x: 0, z: 0 }, 'helicopter'), /Unsupported ground arrival/);
});

test('flight road arrival can start outside coverage and considers the nearer lane', async () => {
  const { createCityConfig } = await modulePromise;
  const city = createCityConfig(fixture, [building]);
  const target = { x: -105, z: -1.75 };
  assert.equal(city.findGroundArrival(target, 'car'), null);
  const arrival = city.findGroundArrival(target, 'car', { forFlight: true, radius: 15 });
  assert.equal(arrival.sourceRoadId, 'way/1');
  assert.equal(arrival.z, -1.75);
  assert.equal(arrival.x, -90);
  assert.equal(arrival.heading, -Math.PI / 2);
  assert.equal(arrival.distance, 15);
});

test('bearing conversion preserves north and east while retaining New York controller headings', async () => {
  const { headingFromBearing, bearingFromHeading } = await modulePromise;
  assert.equal(headingFromBearing(0), Math.PI);
  assert.equal(headingFromBearing(Math.PI), 0);
  assert.equal(headingFromBearing(Math.PI / 2), Math.PI / 2);
  for (const bearing of [0, 0.7, 2.1, 4.5, 6.2]) assert.ok(Math.abs(bearingFromHeading(headingFromBearing(bearing)) - bearing) < 1e-12);
});

test('arrival search cannot restore ground removed from the rendered surface', async () => {
  const { createCityConfig } = await modulePromise;
  const city = createCityConfig({ ...fixture, terrainSurface: { ...fixture.terrainSurface, chunks: [] } }, [building]);
  assert.equal(city.isOnLand(-50, 0), true);
  assert.equal(city.terrainHeight(-50, 0), null);
  assert.equal(city.findGroundArrival({ x: -50, z: 0 }), null);
  assert.equal(city.SPAWN_POINT, null);
});

test('signals keep the original cycle and shortcuts ignore text editors', async () => {
  const { signalPhase, walkSignal, isTypingInField, streetZ } = await modulePromise;
  assert.equal(signalPhase(25, true), 'green');
  assert.equal(signalPhase(26, true), 'amber');
  assert.equal(signalPhase(30, false), 'green');
  assert.equal(signalPhase(-1, false), 'amber');
  assert.equal(walkSignal(36, false), true);
  assert.equal(walkSignal(37, false), false);
  assert.equal(isTypingInField({ target: { tagName: 'TEXTAREA' } }), true);
  assert.equal(isTypingInField({ target: { isContentEditable: true } }), true);
  assert.equal(isTypingInField({ target: { tagName: 'CANVAS' } }), false);
  assert.throws(() => streetZ(37), /unavailable in Shenzhen/);
});

test('expanded city provides source-derived arrivals and rejects Hong Kong ground destinations', async () => {
  const { createCityConfig } = await modulePromise;
  const { decodeCityPayload } = await import(uri(source('js/sz-data-format.js')));
  const raw = JSON.parse(gunzipSync(readFileSync(join(root, 'js/sz-city.json.gz'))));
  const { geo, buildings } = decodeCityPayload(raw);
  const city = createCityConfig(geo, buildings);
  assert.ok(city.SPAWN_POINT, 'current source has a nearby unblocked at-grade road arrival');
  assert.ok(Number.isFinite(city.SPAWN_POINT.y));
  assert.equal(city.SPAWN_POINT.placement, 'derived-road-arrival');
  assert.ok(city.SPAWN_POINT.sourceRoadId.startsWith('way/'));
  assert.ok(city.TELEPORT_LOCATIONS['ping-an']);
  assert.ok(city.TELEPORT_LOCATIONS['tencent-binhai']);
  assert.equal(city.districtAt(0, 0), null);
  assert.equal(city.getLocationInfo(0, -3000).kind, 'land');
  assert.equal(city.getLocationInfo(1491.5, 3798.3).kind, 'outside');
});
