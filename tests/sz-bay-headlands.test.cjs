const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { registerHooks } = require('node:module');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');

const root = process.env.SZ_THREE_PACKAGE_DIR ?? resolve(__dirname, '../.agents/three-0.187.0');
registerHooks({ resolve(specifier, context, next) {
  const file = specifier === 'three/tsl' ? 'build/three.tsl.js'
    : specifier === 'three' || specifier === 'three/webgpu' ? 'build/three.webgpu.js'
    : specifier.startsWith('three/addons/') ? 'examples/jsm/' + specifier.slice(13) : null;
  return file ? { url: pathToFileURL(resolve(root, file)).href, shortCircuit: true } : next(specifier, context);
} });

test('both bay headlands stay in their own park and join the coast walk on dry terrain', async () => {
  const { Scene, Raycaster, Vector3 } = await import('three/webgpu');
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { createCitySpatial } = await import('../js/sz-spatial.js');
  const { polygonContainsInclusive } = await import('../js/sz-polygon.js');
  const { buildBayHeadlands, planBayHeadlands } = await import('../js/sz-bay-headlands.js');
  const { createBayPathLookup } = await import('../js/sz-bay-waterfront.js');
  const { geo, buildings } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz')))));
  const site = createCitySpatial(geo);
  const park = geo.parks.find(p => p.id === 'shenzhen-bay-park');
  const coast = createBayPathLookup(geo.waterfront.parkNetwork.bayPaths.filter(p => p.mode === 'walk'));
  const gardens = planBayHeadlands(geo);
  assert.deepEqual(gardens.map(g => g.osmId), ['way/571629092', 'way/571629093']);
  assert.deepEqual(planBayHeadlands({ parks: [] }), []);
  const scene = new Scene();
  const built = buildBayHeadlands(scene, geo, { terrainSurface: geo.terrainSurface, heightAt: site.groundHeight });
  scene.updateMatrixWorld(true);
  const ray = new Raycaster();
  for (const garden of gardens) {
    const boundary = park.areas.find(a => a.osmId === garden.osmId).polygon;
    for (const { ring } of garden.patches) {
      for (const p of ring) assert.ok(polygonContainsInclusive(boundary, p.x, p.z) && site.isOnLand(p.x, p.z));
    }
    const nearBuildings = buildings.filter(b => b.maxX > -9150 && b.minX < -7820 && b.maxZ > 2630 && b.minZ < 2860);
    for (const route of garden.paths) {
      assert.ok([route.points[0], route.points.at(-1)].some(([x, z]) => coast(x, z).length));
      for (const [x, z] of route.points) {
        assert.ok(garden.reserves(x, z, 0));
        assert.ok(nearBuildings.every(b => b.polygons.every(p => !polygonContainsInclusive(p, x, z))), `path inside building at ${x},${z}`);
      }
    }
    assert.ok(garden.trees.length > 20);
    assert.ok(garden.trees.every(t => !garden.reserves(t.x, t.z, t.crown / 2)));
    const visible = scene.getObjectByName(garden.osmId);
    for (const style of ['lawn', 'gravel', 'court']) assert.ok(visible.getObjectByName(style).geometry.index.count > 0);
    for (const seat of garden.seats) {
      ray.set(new Vector3(seat.x, 100, seat.z), new Vector3(0, -1, 0));
      const hit = ray.intersectObject(visible.getObjectByName('court'))[0];
      assert.ok(hit && Math.abs(hit.point.y - site.groundHeight(seat.x, seat.z)) < 0.02);
      assert.ok(!coast(seat.x, seat.z, 1).length);
    }
  }
  assert.equal(built.colliders.length, 5 * 4);
  built.dispose();
  assert.equal(scene.children.length, 0);
});
