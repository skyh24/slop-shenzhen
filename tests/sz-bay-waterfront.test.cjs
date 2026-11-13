const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = name => readFileSync(join(root, 'js', name), 'utf8');
const dir = process.env.SZ_THREE_PACKAGE_DIR;
const payload = JSON.parse(gunzipSync(readFileSync(join(root, 'js/sz-city.json.gz'))));
const { decodeCityPayload } = loadModule(read('sz-data-format.js'));
const { geo } = decodeCityPayload(payload);
const bay = geo.shenzhenBay;
const ground = loadModule(read('sz-ground-surface.js'));
const { createCitySpatial } = loadModule(read('sz-spatial.js'), { imports: {
  './sz-ground-surface.js': ground, './sz-polygon.js': loadModule(read('sz-polygon.js'))
} });
const spatial = createCitySpatial(geo);

test('the city package retains source waterfront paving across the usable width', () => {
  const expected = { 'way/246781716': ['sett', 4], 'way/255653770': ['paving_stones', 7],
    'way/357765495': ['asphalt', 5], 'way/883827047': ['unknown', 8] };
  const support = ground.createGroundSurfaceSampler(payload.terrainSurface);
  const dark = ground.createGroundSurfaceSampler(payload.terrainSurface, kind => kind === 9);
  const cycle = geo.waterfront.parkNetwork.bayPaths.filter(row => row.appearanceMaterial === 'dark-asphalt' && !row.bridge);
  const onCycle = (x, z) => cycle.some(row => row.points.slice(1).some(([bx, bz], i) => {
    const [ax, az] = row.points[i], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - ax - t * dx, z - az - t * dz) <= row.widthM / 2;
  }));
  for (const path of bay.paths.filter(row => expected[row.osmId])) {
    const [material, kind] = expected[path.osmId];
    assert.equal(path.material, material);
    if (cycle.some(row => row.osmId === path.osmId && row.sourcePoints)) continue;
    const sample = ground.createGroundSurfaceSampler(payload.terrainSurface, value => value === kind);
    for (let i = 1; i < path.points.length; i++) {
      const [ax, az] = path.points[i - 1], [bx, bz] = path.points[i];
      const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
      for (const offset of [-0.35, 0, 0.35]) {
        const x = (ax + bx) / 2 + offset * path.widthM * dz / length;
        const z = (az + bz) / 2 - offset * path.widthM * dx / length;
        const active = onCycle(x, z) && dark(x, z) !== null ? dark : sample;
        assert.ok(Number.isFinite(active(x, z)), `${path.osmId} ${material} at ${x},${z}`);
        assert.equal(active(x, z), support(x, z));
      }
    }
  }
});

test('waterfront approaches, walking route and cycling axes share the actual rendered ground', () => {
  const route = bay.walkRoute;
  assert.ok(route.length > 250);
  const view = bay.paths.find(path => path.nodes.includes(bay.viewNode));
  assert.ok(route.some(([x, , z]) => view.points[view.nodes.indexOf(bay.viewNode)].join(',') === [x, z].join(',')));
  let distance = 0;
  for (let i = 0; i < route.length; i++) {
    const [x, y, z] = route[i];
    assert.equal(spatial.isWater(x, z), false);
    assert.ok(Math.abs(spatial.groundHeight(x, z) - y) < 0.001);
    if (!i) continue;
    const [px, py, pz] = route[i - 1];
    const span = Math.hypot(x - px, z - pz);
    assert.ok(span > 0 && span <= 2.001);
    assert.ok(Math.abs(y - py) / span < 0.08);
    distance += span;
  }
  assert.ok(distance >= 500 && distance <= 650);
  for (const path of bay.paths.filter(path => path.mode === 'cycle')) {
    for (const [x, z] of path.points) {
      assert.equal(spatial.isWater(x, z), false);
      assert.ok(Number.isFinite(spatial.groundHeight(x, z)));
    }
  }
  assert.equal(spatial.groundHeight(-7050, 2725), null);
  assert.equal(spatial.isWater(-7050, 2725), true);
  assert.throws(() => decodeCityPayload({ ...payload, shenzhenBay: { ...bay, seaHeightM: 4 } }), /Shenzhen Bay source/);
});

test('waterfront keeps mode permissions local and releases riprap detail after leaving', { skip: !dir }, async () => {
  const load = file => import(pathToFileURL(join(dir, 'build', file)));
  const [THREE, TSL] = await Promise.all([load('three.webgpu.js'), load('three.tsl.js')]);
  const materials = { sceneUniforms: { night: TSL.uniform(0) } };
  const fixtures = loadModule(read('sz-site-fixtures.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': TSL, './sz-materials.js': materials
  } });
  const { buildSzBayWaterfront, createBayPathLookup } = loadModule(read('sz-bay-waterfront.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': TSL, './building-collision.js': { polygonBoxOverlaps: () => false },
    './sz-materials.js': materials, './sz-site-fixtures.js': fixtures,
    './sz-strings.js': loadModule(read('sz-strings.js'))
  } });
  const scene = new THREE.Scene();
  const pathsNear = createBayPathLookup(bay.paths);
  const layer = buildSzBayWaterfront(scene, bay,
    { heightAt: spatial.groundHeight, isWater: spatial.isWater, colliders: [], pathsNear });
  const [x, , z] = bay.walkRoute[0];
  assert.equal(layer.allowsGroundMode('person', x, z), true);
  assert.equal(layer.allowsGroundMode('cyclist', x, z), false);
  assert.equal(layer.allowsGroundMode('car', x, z), false);
  const [cx, cz] = bay.paths.find(path => path.mode === 'cycle').points[5];
  assert.equal(layer.allowsGroundMode('cyclist', cx, cz), true);
  assert.equal(layer.allowsGroundMode('car', cx, cz), false);
  assert.equal(layer.allowsGroundMode('cyclist', 0, 0), true);
  assert.ok(layer.publicRoutes[0].allows(x, z, 0.445));
  assert.equal(layer.publicRoutes[0].allows(cx, cz, 0.445), false);
  assert.ok(layer.statistics.shoreTriangles > 200 && layer.statistics.lamps > 0 && layer.statistics.benches > 0);
  assert.ok(layer.colliders.every(c => c.minX < c.maxX && c.minY < c.maxY && c.minZ < c.maxZ));
  const staticMeshes = layer.group.children.length;
  const [rx, , rz] = bay.shore[0].stations[22];
  layer.update({ x: rx, z: rz });
  const details = layer.group.children.filter(mesh => mesh.name.startsWith('shenzhen-bay-riprap'));
  assert.ok(details.length > 0);
  let disposed = 0;
  for (const mesh of details) mesh.addEventListener('dispose', () => disposed++);
  layer.update({ x: rx + 900, z: rz });
  assert.equal(layer.group.children.length, staticMeshes);
  assert.equal(disposed, details.length);
  layer.update({ x: rx, z: rz });
  assert.equal(layer.group.children.length, staticMeshes + details.length);
  layer.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(layer.group.children.length, 0);
});
