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
  const geometry = loadModule(read('sz-geometry.js'), { imports });
  const style = loadModule(read('sz-scene-style.js'), { imports: { './sz-polygon.js': polygonModule } });
  const paving = loadModule(read('sz-paving.js'), { imports: { ...imports,
    './sz-materials.js': { sceneUniforms: { night: TSL.uniform(0) } }, './sz-scene-style.js': style } });
  const golf = loadModule(read('sz-golf-course.js'), { imports: { ...imports,
    './sz-geometry.js': geometry, './sz-roads.js': roads, './sz-paving.js': paving } });
  const { buildSzStreetscape } = loadModule(read('sz-streetscape.js'), { imports: { ...imports,
    './building-collision.js': collision, './sz-roads.js': roads,
    './sz-golf-course.js': golf, './sz-paving.js': paving } });
  const ground = loadModule(read('sz-ground-surface.js'));
  const groundHeight = ground.createGroundSurfaceSampler(geo.terrainSurface);
  const scene = new THREE.Scene();
  const pavedRoads = roads.buildSzRoads(scene, geo.roadGraph, geo.terrainSurface);
  const colliders = buildings.flatMap(building => layout.buildingPlacement(building, geo.terrain).colliders);
  const model = buildSzStreetscape(scene, geo.streetscape, geo.terrainSurface, { colliders });
  const crown = loadModule(read('sz-tree-crown.js'), { imports });
  const { buildSzTrees } = loadModule(read('sz-trees.js'), { imports: { ...imports,
    './sz-polygon.js': polygonModule, './sz-tree-crown.js': crown } });
  const trees = buildSzTrees(scene, geo.trees, { groundHeight, roadHeight: pavedRoads.roadHeight,
    colliders, pathAt: model.pathAt, observedTrees: model.observedTrees });
  scene.updateMatrixWorld(true);
  assert.equal(model.statistics.observedTrees, 17);
  for (const { id, x, z } of model.observedTrees) {
    const matches = trees.colliders.filter(collider => collider.sourceId === id);
    assert.equal(matches.length, 1, `expected one placed tree: ${id}`);
    const [trunk] = matches;
    assert.equal(trunk.positionSource, 'osm-node');
    assert.ok(collision.polygonContains(trunk.polygon, x, z));
    assert.ok(Math.abs((trunk.minX + trunk.maxX) / 2 - x) < 1e-8);
    assert.ok(Math.abs((trunk.minZ + trunk.maxZ) / 2 - z) < 1e-8);
  }
  const arrival = model.findArrival(trees.colliders);
  assert.equal(arrival.sourcePathId, 'way/1436698491');
  const { x, z, heading } = arrival;
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
  const trunk = trees.group.children.find(object => object.userData.sources?.includes(tree.osmId));
  const box = trees.colliders.find(collider => collider.sourceId === tree.osmId);
  assert.ok(trunk);
  const y = (box.minY + box.maxY) / 2;
  const ray = new THREE.Raycaster(new THREE.Vector3(tree.x + 2, y, tree.z), new THREE.Vector3(-1, 0, 0));
  const contact = collision.loftContactPolygon(box.loft, y, y + 0.00001);
  const edgeX = Math.max(...contact.outer.map(point => point.x));
  assert.ok(Math.abs(ray.intersectObject(trunk)[0].point.x - edgeX) < 0.001);
  assert.ok(collision.polygonContains(box.polygon, tree.x, tree.z));
  const sharedMaterial = trunk.material;
  let disposed = false;
  sharedMaterial.addEventListener('dispose', () => { disposed = true; });
  model.dispose();
  assert.equal(disposed, false);
  assert.equal(trees.group.parent, scene);
  trees.dispose();
  assert.equal(disposed, true);
  pavedRoads.dispose();
  assert.equal(scene.children.length, 0);
});
