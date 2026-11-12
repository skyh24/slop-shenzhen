const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const { fixtureTerrainSurface } = require('./helpers/terrain-surface.cjs');
const polygon = require('./helpers/polygon.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygon } });
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
const setup = async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build', 'three.webgpu.js')));
  const roads = loadModule(read('sz-roads.js'), { imports: {
    'three/webgpu': THREE, './sz-road-material.js': {}
  } });
  const tracks = loadModule(read('sz-pedestrian-tracks.js'), { imports: {
    './sz-roads.js': roads, './building-collision.js': collision
  } });
  const walk = loadModule(read('sz-public-walk.js'), { imports: {
    'three/webgpu': THREE, './sz-roads.js': roads, './sz-polygon.js': polygon, './building-collision.js': collision
  } });
  const pilot = loadModule(read('sz-zhongxin-walk.js'), { imports: {
    'three/webgpu': THREE, './building-collision.js': collision,
    './sz-public-walk.js': walk, './sz-pedestrian-tracks.js': tracks
  } });
  return { THREE, tracks, ...walk, ...pilot };
};

const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];

test('public walk clips paving to terrain, honours holes and joins only its attributed seam', { skip: !threeDir }, async () => {
  const { THREE, buildPublicWalk } = await setup();
  const terrain = fixtureTerrainSurface({ x0: 0, z0: 0, nx: 4, nz: 3, step: 10, heightScale: 1,
    heights: [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4] });
  const scene = new THREE.Scene();
  const areas = [
    { id: 'sidewalk', kind: 'sidewalk', access: 'public', network: 'west', sourceIds: ['way/1'],
      polygon: { outer: rect(1, 2, 10, 14), holes: [rect(5, 6, 7, 8)] } },
    { id: 'frontage', kind: 'frontage', access: 'public', network: 'west', sourceIds: ['way/2'],
      polygon: { outer: rect(10, 2, 20, 14), holes: [] } },
    { id: 'driveway', kind: 'driveway', access: 'service', sourceIds: ['way/3'],
      polygon: { outer: rect(20, 2, 29, 14), holes: [] } }
  ];
  const walk = buildPublicWalk(scene, terrain, areas);
  assert.ok(walk.allows(10, 10, 0.6, 'west'));
  assert.ok(!walk.allows(6, 7, 0.1, 'west'));
  assert.ok(!walk.allows(19.8, 10, 0.6, 'west'));
  assert.ok(!walk.allows(25, 10, 0.1, 'west'));
  assert.equal(walk.heightAt(6, 7), null);
  assert.equal(walk.areaAt(1, 18), null);
  for (const mesh of walk.group.children) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 3) {
      const x = mesh.position.x + (positions.getX(i) + positions.getX(i + 1) + positions.getX(i + 2)) / 3;
      const z = mesh.position.z + (positions.getZ(i) + positions.getZ(i + 1) + positions.getZ(i + 2)) / 3;
      const y = (positions.getY(i) + positions.getY(i + 1) + positions.getY(i + 2)) / 3;
      assert.ok(Math.abs(walk.heightAt(x, z) - y) < 0.00001);
    }
  }
});

test('bounded detour sweeps the body and never borrows a service driveway', { skip: !threeDir }, async () => {
  const { createWalkSweep, routeAroundObstacles } = await setup();
  const bounds = { minX: 0, maxX: 20, minZ: -2, maxZ: 2 };
  const walk = { allows: (x, z, r) => x - r >= 0 && x + r <= 20 && Math.abs(z) + r <= 2,
    heightAt: () => 8 };
  const post = { minX: 9.97, maxX: 10.03, minZ: -0.03, maxZ: 0.03, minY: 8, maxY: 9,
    polygon: { outer: rect(9.97, -0.03, 10.03, 0.03), holes: [] } };
  const a = { x: 1, z: 0 }, b = { x: 19, z: 0 };
  const clear = createWalkSweep(walk, 'public', [post], null, bounds);
  assert.ok(!clear(a, b, 0.86));
  const route = routeAroundObstacles([a, b], clear, 0.86);
  assert.ok(route.length > 2);
  assert.ok(route.slice(1).every((p, i) => clear(route[i], p, 0.86)));
  const barrier = { contains: (x, z, r) => Math.abs(x - 10) < r + 0.4 };
  assert.equal(routeAroundObstacles([a, b], createWalkSweep(walk, 'public', [post], barrier, bounds), 0.86), null);
});

test('Zhongxin 2 retains an exterior route longer than 200 m with no road crossing', { skip: !threeDir }, async () => {
  const { THREE, buildZhongxinWalk, createWalkSweep, tracks } = await setup();
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const scene = new THREE.Scene();
  const pilot = buildZhongxinWalk(scene, raw.roadGraph, raw.terrainSurface);
  const barrier = tracks.createCarriagewayBarrier(raw.roadGraph, { bounds: pilot.bounds });
  const planter = pilot.placePlanter([], () => 8);
  assert.equal(planter.type, 'planter');
  const mesh = pilot.group.getObjectByName(planter.sourceId);
  assert.ok(Math.abs(mesh.position.y + mesh.geometry.parameters.height / 2 - planter.maxY) < 0.00001);
  assert.equal(pilot.placePlanter([planter], () => 8), null);
  const route = pilot.route([planter]);
  assert.ok(pilot.statistics.lengthM >= 200 && pilot.statistics.lengthM <= 400);
  assert.ok(pilot.statistics.minimumWidthM >= 1.72);
  assert.ok(pilot.reserves(route[2].x, route[2].z, 0.34));
  assert.ok(pilot.trees.every(tree => !pilot.reserves(tree.x, tree.z, 0.7)));
  assert.equal(pilot.entrance.id, 'node/5219780653');
  assert.equal(pilot.areaAt(route.at(-1).x, route.at(-1).z).kind, 'frontage');
  const clear = createWalkSweep(pilot, 'zhongxin-2-west', [planter], barrier, pilot.bounds);
  assert.ok(route.slice(1).every((point, i) => clear(route[i], point, 0.86)));
  assert.ok(route.every(point => Number.isFinite(point.y)));
  assert.equal(scene.children.includes(pilot.group), true);
});
