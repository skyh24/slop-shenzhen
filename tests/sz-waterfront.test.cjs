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
const plan = elevated.planElevatedRoads(roadGraph, terrainSurface, { waterfront, water });
const resolve = contact.createSurfaceResolver({ groundHeight: heightAt, surfaces: plan.surfaces });
const bayModule = loadModule(read('sz-bay-waterfront.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, './building-collision.js': {}, './sz-materials.js': {},
  './sz-site-fixtures.js': {}, './sz-strings.js': {}
} });
const { createWaterfrontPaths, createWaterfrontAccess, findWaterfrontWalkPoint } = loadModule(read('sz-waterfront.js'), { imports: {
  'three/webgpu': {}, './building-collision.js': {}, './sz-bay-waterfront.js': bayModule,
  './sz-controller-surfaces.js': contact, './sz-site-fixtures.js': {}, './sz-spatial.js': {}, './sz-sea.js': {}
} });

test('reviewed bridge profiles are owned by a single elevated plan and connect to both land portals', () => {
  const indices = waterfront.roadBridges.flatMap(b => b.edges);
  assert.equal(new Set(indices).size, indices.length);
  for (const index of indices) {
    const deck = plan.driveLinks.find(d => d.index === index);
    assert.ok(deck);
    assert.equal(plan.links.filter(d => d.index === index).length, 1);
    assert.ok(deck.piers.length);
    for (const p of [deck.frames[0], deck.frames.at(-1)]) {
      assert.ok(Math.abs(p.y - heightAt(p.x, p.z)) < 0.025);
    }
    assert.ok(deck.barrierLengthM > 40);
    assert.ok(deck.slabColliders.length > 0);
    assert.ok(deck.maxGrade <= 0.05001);
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
  for (const route of waterfront.extensions) {
    for (const [i, path] of route.paths.entries()) {
      if (i > 0) assert.equal(route.paths[i - 1].nodes.at(-1), path.nodes[0]);
      const paved = ground.createGroundSurfaceSampler(terrainSurface, kind => kind === material[path.material]);
      for (let j = 1; j < path.points.length; j++) {
        const [x, z] = path.points[j - 1], [nx, nz] = path.points[j];
        const length = Math.hypot(nx - x, nz - z);
        if (!length) continue;
        for (const side of [-0.36, 0, 0.36]) {
          const px = (x + nx) / 2 + (nz - z) * path.widthM * side / length;
          const pz = (z + nz) / 2 - (nx - x) * path.widthM * side / length;
          assert.ok(network.reserves(px, pz));
          assert.ok(Number.isFinite(paved(px, pz)), `${path.osmId} ${px} ${pz}`);
          assert.equal(paved(px, pz), heightAt(px, pz));
        }
      }
    }
  }
});

test('waterfront access distinguishes holidays, banks, route modes and overlapping decks', () => {
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
  assert.equal(access('cyclist', ...lake), false);
  assert.equal(access('person', ...lake), true);
  assert.equal(access('cyclist', ...shore), true);
  assert.equal(access('person', ...shore), false);
  assert.equal(access('car', ...west), false);
  assert.equal(access('car', ...west, { surfaceId: 'sz-elevated-road:1', heightSource: 'estimate' }), true);
  now = Date.parse('2026-11-13T15:00:00Z');
  assert.equal(access('person', ...lake), false);
  assert.equal(access('person', ...east), false);
  now = Date.parse('2026-10-06T03:00:00Z');
  assert.equal(access('cyclist', ...west), false);
  assert.equal(access('cyclist', ...east), true);
  now = Date.parse('2026-11-14T03:00:00Z');
  assert.equal(access('cyclist', ...west), false);
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
