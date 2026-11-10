const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const format = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { geo, buildings } = format.decodeCityPayload(raw);

test('the Sunrise Theater pilot preserves tree identities, shared path nodes and width provenance', () => {
  const pilot = geo.streetscape;
  assert.equal(pilot.source.parkOsmId, 'relation/8133384');
  assert.equal(pilot.source.areaOsmId, 'way/571629065');
  assert.equal(pilot.trees.length, 17);
  assert.equal(new Set(pilot.trees.map(tree => tree.osmId)).size, 17);
  assert.ok(pilot.trees.every(tree => tree.tags.natural === 'tree' && tree.appearanceSource === 'visual-estimate'));
  const footway = pilot.paths.find(path => path.osmId === 'way/1436698491');
  const cycleway = pilot.paths.find(path => path.osmId === 'way/1436698490');
  assert.equal(footway.widthSource, 'visual-estimate');
  assert.equal(cycleway.tags.foot, 'designated');
  assert.equal(footway.segments[0].nodeIds.at(-1), cycleway.segments[0].nodeIds.at(-1));
  assert.equal(pilot.paths.find(path => path.osmId === 'way/534815196').segments[0].nodeIds.at(-1), null);
  assert.ok(pilot.paths.every(path => !geo.roadGraph.metadata.some(road => road.osmId === path.osmId)));
  assert.throws(() => format.validateCityPayload({ ...raw, streetscape: { ...pilot,
    trees: [{ ...pilot.trees[0], areaOsmId: 'way/0' }] } }), /streetscape tree source/);
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('the selected promenade is coplanar and walkable and the modeled tree trunk blocks the same footprint', { skip: !threeDir }, async () => {
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const cityLighting = loadModule(read('city-lighting-materials.js'), { imports });
  const roadMaterial = loadModule(read('sz-road-material.js'), { imports: { ...imports,
    './city-lighting-materials.js': cityLighting } });
  const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
  const terrain = loadModule(read('sz-terrain.js'));
  const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
  const roads = loadModule(read('sz-roads.js'), { imports: { ...imports, './sz-road-material.js': roadMaterial } });
  const { buildSzStreetscape } = loadModule(read('sz-streetscape.js'), { imports: { ...imports,
    './building-collision.js': collision, './sz-building-layout.js': layout, './sz-roads.js': roads } });
  const ground = loadModule(read('sz-ground-surface.js'));
  const groundHeight = ground.createGroundSurfaceSampler(geo.terrainSurface);
  const scene = new THREE.Scene();
  const pavedRoads = roads.buildSzRoads(scene, geo.roadGraph, geo.terrainSurface);
  const model = buildSzStreetscape(scene, geo.streetscape, geo.terrainSurface, {
    groundHeight, roadHeight: pavedRoads.roadHeight, colliders: buildings.flatMap(building => layout.buildingPlacement(building, geo.terrain).colliders)
  });
  scene.updateMatrixWorld(true);
  assert.equal(model.statistics.trees, 17);
  assert.equal(model.statistics.excludedTrees.length, 0);
  assert.equal(model.arrival.sourcePathId, 'way/1436698491');
  const { x, z, heading } = model.arrival;
  const walk = model.group.getObjectByName('shenzhen-pilot-footway');
  for (let distance = 0; distance <= 12; distance += 2) {
    const px = x + Math.sin(heading) * distance;
    const pz = z + Math.cos(heading) * distance;
    const ray = new THREE.Raycaster(new THREE.Vector3(px, 100, pz), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(walk)[0];
    assert.ok(Math.abs(hit.point.y - groundHeight(px, pz)) < 1e-5);
    assert.equal(pavedRoads.roadHeight(px, pz), null);
    assert.deepEqual(Array.from(model.pathAt(px, pz)), ['footway']);
  }

  const tree = geo.streetscape.trees.find(tree => tree.osmId === 'node/5360434527');
  const trunk = model.group.getObjectByName(`tree-trunks:${tree.areaOsmId}`);
  const box = model.colliders.find(collider => collider.sourceId === tree.osmId);
  const ray = new THREE.Raycaster(new THREE.Vector3(tree.x + 2, (box.minY + box.maxY) / 2, tree.z), new THREE.Vector3(-1, 0, 0));
  assert.ok(Math.abs(ray.intersectObject(trunk)[0].point.x - box.maxX) < 0.001);
  assert.ok(collision.polygonContains(box.polygon, tree.x, tree.z));
  model.dispose();
  pavedRoads.dispose();
  assert.equal(scene.children.length, 0);
});
