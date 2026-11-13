const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const polygon = loadModule(read('sz-polygon.js'));
const ground = loadModule(read('sz-ground-surface.js'));
const contact = loadModule(read('sz-controller-surfaces.js'));
const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
} });
const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, './sz-roads.js': roads, './sz-ground-surface.js': ground,
  './sz-controller-surfaces.js': contact, './sz-polygon.js': polygon
} });
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const { geo } = loadModule(read('sz-data-format.js')).decodeCityPayload(raw);
const { waterfront, terrainSurface, roadGraph, water } = geo;
const heightAt = ground.createGroundSurfaceSampler(terrainSurface);
const spatial = loadModule(read('sz-spatial.js'), { imports: {
  './sz-ground-surface.js': ground, './sz-polygon.js': polygon
} }).createCitySpatial(geo);
const plan = elevated.planElevatedRoads(roadGraph, terrainSurface, { waterfront, water, isWater: spatial.isWater });
const resolve = contact.createSurfaceResolver({ groundHeight: heightAt, surfaces: plan.surfaces });
const bayModule = loadModule(read('sz-bay-waterfront.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, './building-collision.js': {}, './sz-materials.js': {},
  './sz-site-fixtures.js': { GREENWAY_RAIL: [[0.55, 0.068, 0.068], [1.07, 0.077, 0.077]], planRail: (a, b, heights) => heights.map(([y, width, height]) =>
    ({ a: { ...a, y: a.y + y }, b: { ...b, y: b.y + y }, width, height })) }, './sz-strings.js': {}
} });
const { createParkGroundAccess, createWaterfrontPaths, createWaterfrontAccess, findWaterfrontWalkPoint, planLakeLamps } = loadModule(read('sz-waterfront.js'), { imports: {
  'three/webgpu': {}, './building-collision.js': {}, './sz-bay-waterfront.js': bayModule,
  './sz-controller-surfaces.js': contact, './sz-site-fixtures.js': {}, './sz-sea.js': {}, './sz-spatial.js': {}, './sz-materials.js': {}
} });

test('reviewed bridge profiles are owned by a single elevated plan and connect to both land portals', () => {
  const indices = waterfront.roadBridges.flatMap(b => b.edges);
  const baishi = new Set(waterfront.roadBridges.slice(0, 4).flatMap(b => b.edges));
  assert.equal(new Set(indices).size, indices.length);
  for (const index of indices) {
    const deck = plan.links.find(d => d.index === index);
    assert.ok(deck, `missing reviewed bridge ${index}`);
    assert.equal(plan.links.filter(d => d.index === index).length, 1);
    if (baishi.has(index)) assert.ok(deck.piers.length);
    for (const p of [deck.frames[0], deck.frames.at(-1)]) {
      assert.ok(Math.abs(p.y - heightAt(p.x, p.z)) < 0.025);
    }
    if (baishi.has(index)) assert.ok(deck.barrierLengthM > 40);
    assert.ok(deck.slabColliders.length > 0);
    if (baishi.has(index)) assert.ok(deck.maxGrade <= 0.05001);
  }
});

test('loop and access branches stay on ground or on their own reviewed footbridges', () => {
  const loop = waterfront.routes.find(r => r.id === 'lychee-loop');
  assert.ok(loop.closed && loop.lengthM > 1400);
  assert.deepEqual(loop.points[0], loop.points.at(-1));
  const lake = waterfront.waters[0];
  assert.ok(loop.paths.filter(p => p.bridge).length >= 3);
  for (const route of waterfront.routes.filter(r => r.id.startsWith('lychee-'))) {
    let previous = null;
    for (const [x, y, z] of route.points) {
      assert.ok(y >= lake.heightM + 0.4);
      const candidates = resolve.at(x, z);
      assert.ok(candidates.some(p => Math.abs(p.height - y) < 0.015), `Unsupported ${route.id} ${x} ${z}`);
      if (previous) assert.ok(Math.abs(y - previous[1]) <= Math.hypot(x - previous[0], z - previous[2]) * 0.16 + 0.015);
      previous = [x, y, z];
    }
  }
});

test('both banks remain on the lower surface under the Baishi Road deck and outside piers', () => {
  for (const route of waterfront.routes.filter(r => r.id.endsWith('-bank'))) {
    assert.ok(route.lengthM >= 400 && route.lengthM <= 500);
    let bridgeSamples = 0;
    for (const [x, y, z] of route.points) {
      assert.ok(Math.abs(heightAt(x, z) - y) < 0.005);
      const surfaces = resolve.at(x, z);
      if (surfaces.some(s => s.surfaceId.startsWith('sz-elevated-road:'))) {
        bridgeSamples++;
        const upper = surfaces.find(s => s.surfaceId.startsWith('sz-elevated-road:'));
        assert.ok(upper.height - 0.65 - y >= 2.60, `${route.id} ${x} ${z}: ${upper.height - 0.65 - y} m under ${upper.surfaceId}`);
        assert.equal(resolve.resolve(x, z, { previousY: y, previousSurfaceId: 'terrain' }).surfaceId, 'terrain');
        assert.equal(resolve.resolve(x, z, { previousY: upper.height, previousSurfaceId: upper.surfaceId }).surfaceId, upper.surfaceId);
      }
      assert.ok(!plan.colliders.some(c => c.type === 'elevated-pier' && c.minX < x + 1.4 && c.maxX > x - 1.4
        && c.minZ < z + 1.4 && c.maxZ > z - 1.4));
    }
    assert.ok(bridgeSamples > 8);
  }
});

test('coastal terrace is supported, slopes into and out of existing route, and preserves sea datum', () => {
  const { bayLower } = waterfront;
  assert.ok(bayLower.maxDropM > 1.4 && bayLower.maxDropM <= 1.5);
  assert.equal(geo.shenzhenBay.seaHeightM, 0);
  const minY = Math.min(...bayLower.points.map(p => p[1]));
  assert.ok(minY > 2 && minY < 3.5);
  for (const [x, y, z] of bayLower.points) assert.ok(Math.abs(heightAt(x, z) - y) < 0.002);
});

test('reviewed waterfront extensions keep source joins and a supported paved width', () => {
  assert.equal(waterfront.extensions.length, 4);
  const material = { unknown: 8, paving_stones: 7, sett: 4, asphalt: 5 };
  const network = createWaterfrontPaths(waterfront);
  const overlay = bayModule.createBayPathLookup([...waterfront.parkNetwork.bayPaths, ...waterfront.dasha.routes.flatMap(r => r.paths)]
    .filter(p => !p.bridge && p.appearanceMaterial === 'dark-asphalt'));
  const dark = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 9);
  for (const route of waterfront.extensions) {
    for (const [i, path] of route.paths.entries()) {
      if (i > 0) assert.equal(route.paths[i - 1].nodes.at(-1), path.nodes[0]);
      if (waterfront.parkNetwork.bayPaths.some(p => p.osmId === path.osmId && p.sourcePoints)) continue;
      const paved = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === material[path.material]);
      for (let j = 1; j < path.points.length; j++) {
        const [x, z] = path.points[j - 1], [nx, nz] = path.points[j];
        const length = Math.hypot(nx - x, nz - z);
        if (!length) continue;
        for (const side of [-0.36, 0, 0.36]) {
          const px = (x + nx) / 2 + (nz - z) * path.widthM * side / length;
          const pz = (z + nz) / 2 - (nx - x) * path.widthM * side / length;
          assert.ok(network.reserves(px, pz));
          const active = overlay(px, pz).length && dark(px, pz) !== null ? dark : paved;
          assert.ok(Number.isFinite(active(px, pz)), `${path.osmId} ${px} ${pz}`);
          assert.equal(active(px, pz), heightAt(px, pz));
        }
      }
    }
  }
});

test('waterfront walking keeps its opening hours while cycling uses all supported paths', () => {
  const network = createWaterfrontPaths(waterfront);
  let now = Date.parse('2026-11-13T14:59:00Z');
  const access = createWaterfrontAccess(waterfront, network, () => now).allowsGroundMode;
  const xz = route => { const [x, , z] = route.points[Math.floor(route.points.length / 2)]; return [x, z]; };
  const west = xz(waterfront.routes.find(route => route.id === 'west-bank'));
  const east = xz(waterfront.routes.find(route => route.id === 'east-bank'));
  const lake = xz(waterfront.extensions.find(route => route.id === 'honghu-southeast'));
  const shore = xz(waterfront.extensions.find(route => route.id === 'central-bay-cycleway'));
  assert.equal(access('cyclist', ...west), true);
  assert.equal(access('cyclist', ...east), true);
  assert.equal(access('cyclist', ...lake), true);
  assert.equal(access('person', ...lake), true);
  assert.equal(access('cyclist', ...shore), true);
  assert.equal(access('person', ...shore), true);
  assert.equal(access('car', ...west), false);
  assert.equal(access('car', ...west, { surfaceId: 'sz-elevated-road:1', heightSource: 'estimate' }), true);
  now = Date.parse('2026-11-13T15:00:00Z');
  assert.equal(access('person', ...lake), false);
  assert.equal(access('person', ...east), false);
  assert.equal(access('cyclist', ...lake), true);
  assert.equal(access('cyclist', ...west), true);

  now = Date.parse('2026-10-06T03:00:00Z');
  assert.equal(access('cyclist', ...west), true);
  assert.equal(access('cyclist', ...east), true);
  now = Date.parse('2026-11-14T03:00:00Z');
  assert.equal(access('cyclist', ...west), true);
});

test('the park route spans the bay with continuous ground or bridge support', () => {
  const { bayPaths, bayLamps, bayTrees, bayPlants, lakePaths } = waterfront.parkNetwork;
  const shoreline = geo.shenzhenBay.shore.filter(row => row.profile === 'seawall');
  assert.ok(shoreline.reduce((sum, row) => sum + row.lengthM, 0) > 11000);
  assert.ok(bayLamps.length > 250 && bayPlants.length > 1200);
  assert.ok(bayTrees.length > 1464);
  assert.ok(new Set(lakePaths.map(path => path.osmId)).size >= 5);
  const network = createWaterfrontPaths(waterfront);
  const access = createWaterfrontAccess(waterfront, network, () => Date.parse('2026-11-13T04:00:00Z')).allowsGroundMode;
  const all = bayPaths.filter(path => path.mode !== 'walk');
  const paved = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 9);
  let darkSamples = 0, samples = 0;
  for (const path of all) {
    assert.equal(path.appearanceMaterial, 'dark-asphalt');
    const [x, z] = path.points[Math.floor(path.points.length / 2)];
    if (path.bridge) {
      const id = `waterfront-bridge:${path.osmId}`;
      const deck = resolve.at(x, z).find(row => row.surfaceId === id);
      assert.ok(deck && access('cyclist', x, z, deck));
      assert.equal(access('car', x, z, deck), false);
    } else {
      assert.ok(Number.isFinite(heightAt(x, z)));
      assert.equal(access('cyclist', x, z), true);
      for (let i = 1; i < path.points.length; i++) {
        const [a, b] = path.points.slice(i - 1, i + 1);
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        samples++;
        if (paved(mx, mz) !== null) {
          darkSamples++;
          assert.equal(paved(mx, mz), heightAt(mx, mz));
        }
      }
    }
  }
  assert.ok(darkSamples / samples > 0.95, `${darkSamples} / ${samples}`);
  for (const [west, east] of [[-15100, -12500], [-12500, -11000], [-11000, -10000], [-10000, -8500], [-8500, -6800], [-6800, -5500]]) {
    assert.ok(all.some(path => path.points.some(([x, z]) => x >= west && x < east && Number.isFinite(paved(x, z)))));
  }
});

test('a bicycle rides the coastal bridge from either bank on the rendered deck', () => {
  const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygon } });
  const { ThirdPersonControllerManager } = loadModule(read('controllers.js'), { imports: {
    'three/webgpu': {}, './sz-city-config.js': {
      ISLAND_BOUNDS: { minX: -30000, maxX: 30000, minZ: -30000, maxZ: 30000 }
    }, './sz-controller-surfaces.js': contact, './sz-park-arrivals.js': {}, './sz-strings.js': {},
    './city-lighting-materials.js': {}, './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } },
    './pedestrians.js': {}, './vehicle-lights.js': {}, './building-collision.js': collision,
    ...require('./helpers/driving.cjs')
  } });
  const bridge = waterfront.footbridges.find(row => row.id === 'way/357765497');
  const access = createWaterfrontAccess(waterfront, createWaterfrontPaths(waterfront),
    () => Date.parse('2026-11-13T16:00:00Z'));
  const bayAccess = bayModule.createBayWaterfrontAccess(bayModule.createBayPathLookup(geo.shenzhenBay.paths),
    waterfront.parkNetwork.bayPaths);
  for (const points of [bridge.points, [...bridge.points].reverse()]) {
    const [a, b] = points;
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const dx = (b[0] - a[0]) / length, dz = (b[2] - a[2]) / length;
    const position = { x: a[0] - dx * 3, y: a[1], z: a[2] - dz * 3 };
    const bike = { type: 'cyclist', position, heading: Math.atan2(dx, dz), speed: 4,
      collisionBounds: { min: { x: -0.4, y: 0, z: -1.1 }, max: { x: 0.4, y: 2, z: 1.1 } },
      leanAngle: 0, leanPivot: { rotation: {} }, frontWheel: { rotation: { x: 0 } },
      rearWheel: { rotation: { x: 0 } }, crankPivot: { rotation: {} }, pedals: [], pedalPhase: 0,
      _safePosition: { ...position }, _support: { height: a[1], surfaceId: 'terrain' } };
    const controller = Object.assign(Object.create(ThirdPersonControllerManager.prototype), {
      activeMode: 'cyclist', entities: { cyclist: bike }, keys: { forward: 0.25 }, surfaceResolver: resolve,
      groundHeight: heightAt, colliders: plan.colliders.filter(row => row.sourceId === bridge.id),
      groundAccess: (mode, x, z, surface) => access.allowsGroundMode(mode, x, z, surface)
        && (surface.heightSource !== 'terrain' || bayAccess.allowsGroundMode(mode, x, z))
    });
    const total = Math.hypot(points.at(-1)[0] - a[0], points.at(-1)[2] - a[2]) + 5;
    let travelled = -3, onDeck = 0;
    for (let frame = 0; travelled < total && frame < 1200; frame++) {
      controller.updateCyclist(0.025);
      travelled = (position.x - a[0]) * dx + (position.z - a[2]) * dz;
      assert.ok(bike.speed > 1, JSON.stringify({ frame, travelled, position, support: bike._support }));
      if (bike._support.surfaceId === `waterfront-bridge:${bridge.id}`) {
        onDeck++;
        assert.ok(Math.abs(position.y - 8) < 1e-6);
      }
    }
    assert.ok(travelled >= total && onDeck > 10, 'both bridge portals and the span remain rideable');
  }
});

test('the relocated central bay route follows dry seawall ground and leaves the old center unpaved', () => {
  const path = waterfront.parkNetwork.bayPaths.find(p => p.geometrySource === 'seawall-alignment-design');
  assert.equal(path.osmId, 'way/255653770');
  assert.deepEqual(path.points[0], path.sourcePoints[0]);
  assert.deepEqual(path.points.at(-1), path.sourcePoints.at(-1));
  const dark = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 9);
  const lawn = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 1);
  const shore = bayModule.createBayPathLookup(geo.shenzhenBay.shore.filter(r => r.profile === 'retaining-edge')
    .map(r => ({ points: r.stations.map(([x, , z]) => [x, z]), widthM: 1, mode: 'edge' })));
  const near = path.points.filter(([x, z]) => x > -7120 && x < -6970);
  assert.ok(near.length > 30);
  for (const [x, z] of near) {
    assert.ok(Number.isFinite(dark(x, z)));
    assert.equal(dark(x, z), heightAt(x, z));
    assert.ok(shore(x, z, 4.8).length);
    assert.equal(shore(x, z, 1.7).length, 0);
  }
  assert.ok(Number.isFinite(lawn(-7061.98, 2687.07)));
  assert.equal(dark(-7061.98, 2687.07), null);
});

test('Dasha extends the waterfront from the estuary through both banks and into the university corridor', () => {
  const dasha = waterfront.dasha;
  const paths = dasha.routes.flatMap(route => route.paths);
  const byId = new Map(paths.map(path => [path.osmId, path]));
  const network = createWaterfrontPaths(waterfront);
  const asphalt = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 9);
  const stone = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === 7);
  for (const [id, bank, sample] of [
    ['way/232406027', 'west', asphalt], ['way/925416610', 'west', stone],
    ['way/925798981', 'east', asphalt], ['way/897081647', 'east', asphalt],
    ['way/1213988782', 'east', asphalt]
  ]) {
    const path = byId.get(id);
    assert.equal(path.bank, bank);
    const segment = Math.floor(path.points.length / 2);
    const [ax, az] = path.points[segment - 1], [bx, bz] = path.points[segment];
    const x = (ax + bx) / 2, z = (az + bz) / 2;
    assert.ok(network.reserves(x, z));
    assert.ok(Number.isFinite(sample(x, z)), id);
    assert.equal(sample(x, z), heightAt(x, z));
  }
  assert.ok(dasha.routes.filter(r => r.bank === 'west').reduce((m, r) => m + r.lengthM, 0) > 12000);
  assert.ok(dasha.lamps.length > 700 && dasha.rails.some(r => r.stations.some(Boolean)));
  assert.ok(new Set(dasha.banks.map(r => r.waterId)).size >= 8);
  assert.ok(byId.get('way/1213988777').points.some(([x, z]) => x > -5100 && z < -6000));
  const bay = waterfront.parkNetwork.bayPaths.find(p => p.osmId === 'way/1328802434');
  assert.ok(byId.get('way/325371423').points.some(a => bay.points.some(b => a.join(',') === b.join(','))));

  const path = byId.get('way/897081648');
  const [x, z] = path.points[Math.floor(path.points.length / 2)];
  const weekend = () => Date.parse('2026-11-14T03:00:00Z');
  assert.equal(createWaterfrontAccess(waterfront, network, weekend).allowsGroundMode('cyclist', x, z), true);
  const bridge = byId.get('way/1213988788');
  const [px, pz] = bridge.points[Math.floor(bridge.points.length / 2)];
  const deck = resolve.at(px, pz).find(s => s.surfaceId === 'waterfront-bridge:way/1213988788');
  assert.ok(deck);
  assert.equal(createWaterfrontAccess(waterfront, network, weekend).allowsGroundMode('cyclist', px, pz, deck), true);
});

test('park lawns support bicycles, cars use road surfaces, and wetlands stay closed to vehicles', () => {
  const access = createParkGroundAccess({ inPark: x => x >= 0, inWetland: x => x === 5,
    onRoad: x => x === 10, roadDecks: new Set(['road-deck']) });
  const terrain = { surfaceId: 'terrain', heightSource: 'terrain' };
  assert.equal(access('cyclist', 1, 0, terrain), true);
  assert.equal(access('car', 1, 0, terrain), false);
  assert.equal(access('car', 10, 0, terrain), true);
  assert.equal(access('car', 10, 0, { surfaceId: 'park-deck' }), false);
  assert.equal(access('cyclist', 5, 0, terrain), false);
  assert.equal(access('car', 5, 0, { surfaceId: 'road-deck' }), true);
});

test('coastal guardrails use dry supports and leave the access opening clear', () => {
  const sections = [0, 3, 6, 9, 12].map(x => ({ crest: { x, y: 4, z: 0 }, normal: { x: 0, z: 1 } }));
  const { bars, posts } = bayModule.planCoastalGuardrail(sections, {
    isWater: (x, z) => z > 0, heightAt: (x, z) => z <= 0 ? 4 : null,
    nearCycle: () => true, blocked: (x, z) => x > 4 && x < 5.5
  });
  assert.equal(bars.length, 6);
  for (const bar of bars) {
    assert.equal(bar.a.z, -0.48);
    assert.ok(bar.b.x <= 4 || bar.a.x >= 5.5);
  }
  assert.ok(posts.every(p => p.z === -0.48 && p.y === 4));
  assert.deepEqual(Array.from(posts, p => p.x), [0, 3, 6, 9, 12]);
});

test('lake lamps alternate sides at equal distances across source vertices', () => {
  const lamps = planLakeLamps({ points: [[0, 8, 0], [7, 8, 0], [7, 8, 35]], spacingM: 10 });
  assert.deepEqual(Array.from(lamps, p => [p.x, p.z, p.side]), [[5, 0, 1], [7, 8, -1], [7, 18, 1], [7, 28, -1]]);
});

test('map arrival snaps only to nearby walkable ground axes', () => {
  const paths = [
    { points: [[0, 1], [10, 1]], mode: 'walk', kind: 'steps' },
    { points: [[0, 2], [10, 2]], mode: 'walk', bridge: true },
    { points: [[0, 3], [10, 3]], mode: 'cycle' },
    { points: [[0, 4], [10, 4]], mode: 'shared' }
  ];
  const result = findWaterfrontWalkPoint(paths, 5, 1, Math.PI / 2);
  assert.deepEqual([result.x, result.z, result.heading], [5, 4, Math.PI / 2]);
  assert.equal(findWaterfrontWalkPoint(paths, 15, 4, 0), null);
});
