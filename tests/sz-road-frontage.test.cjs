const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const intersectionControl = loadModule(read('sz-intersection-control.js'));

test('road frontage resolves its four source approach nodes on ground-only directed links', () => {
  const source = raw.roadFrontage;
  const graph = raw.roadGraph;
  const control = intersectionControl.createIntersectionControl(source, graph);
  const [junction] = control.intersections;
  assert.equal(junction.timingSource, 'user-defined-game-simulation');
  assert.deepEqual(Array.from(junction.approaches, a => [a.osmNodeId, a.group]), [
    [8894987731, 0], [8894945794, 0], [8894945796, 1], [2460132754, 1]
  ]);
  assert.ok(junction.approaches.every(a => graph.metadata[a.sourceIndex].heightSource === 'terrain'
    && graph.nodeIds[a.to] === a.toNodeId));
  assert.equal(source.corridors.find(row => row.id === 'shennan-chegongmiao').medianSource.boundarySource, 'derived-estimate');
  assert.equal(source.entrances[0].status, 'source-entrance-ground-connection-unresolved');
});

test('Civic Square has stone on the main axis and keeps planted ground to the east', () => {
  const chunk = raw.terrainSurface.chunks.find(row => row.id === '0,0');
  const { positions, kinds, origin } = chunk;
  const stoneVertices = kinds.flatMap((kind, i) => kind === 3
    ? [[positions[i * 3] + origin[0], positions[i * 3 + 2] + origin[1]]]
    : []);
  assert.ok(stoneVertices.some(([x, z]) => x > 15 && x < 65 && z > 165 && z < 260));
  assert.ok(!stoneVertices.some(([x, z]) => x > 100 && x < 200 && z > 165 && z < 260));
  assert.ok(kinds.some((kind, i) => kind === 1
    && positions[i * 3] + origin[0] > 100 && positions[i * 3] + origin[0] < 200
    && positions[i * 3 + 2] + origin[1] > 165 && positions[i * 3 + 2] + origin[1] < 260));
  const trees = raw.trees;
  assert.ok(!trees.x.some((x, i) => Math.abs(x) < 650 && trees.z[i] > 1560 && trees.z[i] < 2750
    && trees.sources[trees.source[i]].startsWith('simulated-')));
});

test('Beihuan markings and the median use only the reviewed directed source links', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../data/source/beihuan-profile.json'), 'utf8'));
  const { links, metadata, nodeIds } = raw.roadGraph;
  const selected = [];
  for (const [i, { osmId, crossSection }] of metadata.entries()) {
    if (!crossSection) continue;
    const [a, b, , width, lanes, direction] = links[i];
    assert.equal(crossSection.id, manifest.id);
    assert.equal(direction, 1);
    assert.equal(lanes, manifest.section.lanesPerDirection);
    assert.equal(width, lanes * crossSection.laneWidthM + crossSection.outerShoulderM);
    selected.push([osmId, nodeIds[a], nodeIds[b]].join(':'));
  }
  const expected = manifest.directions.flatMap(({ links }) => links.map(keys => keys.join(':')));
  assert.deepEqual(selected.sort(), expected.sort());
  const features = raw.roadFrontage.features.filter(feature => feature.id.startsWith(`${manifest.id}:`));
  assert.deepEqual(features.map(feature => feature.kind).sort(), ['median', 'paint']);
  assert.ok(features.every(feature => feature.trianglesXZ.length > 0));
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('pilot paint and raised surfaces stay on their own geometry and signal fixtures share instance bounds', { skip: !threeDir }, async () => {
  const loadThree = p => import(pathToFileURL(join(threeDir, 'build', p)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const roads = loadModule(read('sz-roads.js'), { imports: { ...imports,
    './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) } } });
  const ground = loadModule(read('sz-ground-surface.js'));
  const { buildSzRoadFrontage } = loadModule(read('sz-road-frontage.js'), {
    imports: { ...imports, './sz-roads.js': roads, './sz-intersection-control.js': intersectionControl }
  });
  const terrain = raw.terrainSurface;
  const groundHeight = ground.createGroundSurfaceSampler(terrain);
  const { chunks } = roads.createRoadSurfaceLayout(raw.roadGraph, terrain);
  const roadHeight = roads.createRoadHeightSampler(chunks, terrain.grid);
  const scene = new THREE.Scene();
  const model = buildSzRoadFrontage(scene, raw.roadFrontage, raw.roadGraph, terrain, { groundHeight, roadHeight });
  assert.equal(model.statistics.signals, 4);
  for (const [id, x, z] of [['shennan-civic-center', 0, 410], ['shennan-civic-east', 795, 391]]) {
    const median = model.group.children.find(mesh => mesh.name.startsWith(`${id}:median:`) && mesh.userData.planting);
    assert.equal(median?.userData.planting.form, 'open-lawn');
    assert.equal(roadHeight(x, z), null);
    assert.ok(Math.abs(model.shennanMedianHeight(x, z) - groundHeight(x, z) - 0.25) < 0.0001);
  }
  assert.ok(['globfp/36321', 'globfp/36322', 'globfp/36726', 'globfp/38139']
    .every(id => !raw.buildings.id.includes(id)), 'reviewed Shennan median footprints cannot become buildings');
  assert.ok(model.statistics.curbSegments > 0);
  assert.equal(model.statistics.curbSegments * 2, model.statistics.curbTriangles);
  assert.ok(model.statistics.shennanFlowerBeds > 8);
  const flowerBeds = model.group.getObjectByName('shennan-median:flower-beds');
  const flowers = flowerBeds.geometry.attributes.position;
  for (let i = 0; i < flowers.count; i++) {
    const x = flowers.getX(i) + flowerBeds.position.x;
    const z = flowers.getZ(i) + flowerBeds.position.z;
    assert.equal(roadHeight(x, z), null);
    assert.ok(Math.abs(flowers.getY(i) - model.shennanMedianHeight(x, z) - 0.07) < 0.0002);
  }
  assert.ok(model.signalOrigins.every(p => p.minClearanceM >= 5.5));
  const arm = model.group.children.find(mesh => mesh.name === 'signals:arms');
  const matrix = new THREE.Matrix4();
  arm.getMatrixAt(0, matrix);
  const armCollider = model.colliders.find(c => c.part === 'arms');
  const vertex = new THREE.Vector3();
  const positions = arm.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i).applyMatrix4(matrix);
    assert.ok(vertex.y >= armCollider.minY && vertex.y <= armCollider.maxY);
  }
  const greenA = model.group.children.find(mesh => mesh.name === 'signals:0:green').material;
  const greenB = model.group.children.find(mesh => mesh.name === 'signals:1:green').material;
  assert.ok(greenA.emissiveIntensity > 0 && greenB.emissiveIntensity === 0);
  model.update(4.5);
  assert.ok(greenB.emissiveIntensity > 0 && greenA.emissiveIntensity === 0);
  let checkedPaint = 0, checkedRaised = 0;
  for (const mesh of model.group.children) {
    const raised = mesh.userData.heightSource === 'terrain-relative-design-estimate';
    const paint = mesh.name.includes(':paint:') || mesh.name.startsWith('source-signal-stop-lines:');
    if (!raised && !paint) continue;
    const p = mesh.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      const x = (p[i] + p[i + 3] + p[i + 6]) / 3 + mesh.position.x;
      const y = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
      const z = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 + mesh.position.z;
      if (paint) {
        assert.ok(Number.isFinite(roadHeight(x, z)));
        checkedPaint++;
      }
      if (raised) {
        assert.equal(roadHeight(x, z), null);
        assert.ok(Math.abs(model.contactHeight(x, z) - y) < 0.00001);
        checkedRaised++;
      }
    }
  }
  assert.ok(checkedPaint > 1000 && checkedRaised > 1000);
  model.dispose();
  assert.equal(scene.children.length, 0);
  const median = raw.roadFrontage.features.find(feature => feature.id === 'shennan-chegongmiao:median');
  const withoutSources = { ...raw.roadFrontage, features: [{ ...median, sourceIds: [] }] };
  const unverified = buildSzRoadFrontage(scene, withoutSources, raw.roadGraph, terrain, { groundHeight, roadHeight });
  assert.equal(unverified.statistics.shennanFlowerBeds, 0);
  assert.equal(unverified.group.getObjectByName('shennan-median:flower-beds'), undefined);
  unverified.dispose();
});
