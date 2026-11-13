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
  const style = loadModule(read('sz-scene-style.js'), { imports: { './sz-polygon.js': {} } });
  const paving = loadModule(read('sz-paving.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL,
    './sz-materials.js': { sceneUniforms: { night: TSL.uniform(0) } }, './sz-scene-style.js': style } });
  const roads = loadModule(read('sz-roads.js'), { imports: { ...imports,
    './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) } } });
  const ground = loadModule(read('sz-ground-surface.js'));
  const { buildSzRoadFrontage } = loadModule(read('sz-road-frontage.js'), {
    imports: { ...imports, './sz-roads.js': roads, './sz-intersection-control.js': intersectionControl, './sz-paving.js': paving }
  });
  const terrain = raw.terrainSurface;
  const groundHeight = ground.createGroundSurfaceSampler(terrain);
  const { chunks } = roads.createRoadSurfaceLayout(raw.roadGraph, terrain);
  const roadHeight = roads.createRoadHeightSampler(chunks, terrain.grid);
  const scene = new THREE.Scene();
  const model = buildSzRoadFrontage(scene, raw.roadFrontage, raw.roadGraph, terrain, { groundHeight, roadHeight });
  assert.equal(model.statistics.signals, 4);
  const pilot = raw.roadFrontage.features.filter(f => f.id.startsWith('shennan-hongshulin:') && f.clipToRoadComplement);
  assert.deepEqual(pilot.map(f => f.id.split(':').at(-1)), ['sidewalk', 'ramp', 'paving']);
  assert.ok(pilot.every(f => f.clipToRoadComplement));
  assert.ok(pilot[2].sourceIds.includes('way/1241802790'));
  const sourceCrossing = [
    [-5256.596, 1167.253], [-5259.939, 1151.661], [-5260.824, 1147.453], [-5268.138, 1134.176],
    [-5272.283, 1118.196], [-5275.297, 1106.547], [-5279.113, 1104.564], [-5282.24, 1102.948],
    [-5289.399, 1104.199], [-5296.517, 1105.439], [-5305.476, 1106.901]
  ];
  let previousY = null, asphaltPoints = 0, pavingPoints = 0;
  for (let i = 1; i < sourceCrossing.length; i++) {
    const [ax, az] = sourceCrossing[i - 1], [bx, bz] = sourceCrossing[i];
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1);
    for (let j = 0; j <= steps; j++) {
      const x = ax + (bx - ax) * j / steps, z = az + (bz - az) * j / steps;
      const asphalt = roadHeight(x, z), paving = model.contactHeight(x, z);
      const y = asphalt ?? paving;
      assert.ok(Number.isFinite(y), `Missing crossing support at ${x}, ${z}`);
      if (asphalt !== null) asphaltPoints++;
      if (paving !== null) pavingPoints++;
      if (previousY !== null) assert.ok(Math.abs(previousY - y) <= 0.001);
      previousY = y;
    }
  }
  assert.ok(asphaltPoints > 300 && pavingPoints > 500);
  let previousRise = null;
  for (let i = 0; i <= 250; i++) {
    const t = i / 250;
    const x = -5244.407 + (-5256.596 + 5244.407) * t;
    const z = 1165.326 + (1167.253 - 1165.326) * t;
    const top = model.contactHeight(x, z);
    assert.ok(Number.isFinite(top), `Missing sidewalk approach at ${x}, ${z}`);
    const rise = top - groundHeight(x, z);
    if (i === 0) assert.ok(Math.abs(rise - 0.12) <= 0.001);
    if (previousRise !== null) assert.ok(Math.abs(previousRise - rise) <= 0.006);
    if (i === 250) assert.ok(Math.abs(rise) <= 0.001);
    previousRise = rise;
  }
  for (const [id, x, z] of [['shennan-civic-center', 0, 410], ['shennan-civic-east', 795, 391]]) {
    const median = model.group.children.find(mesh => mesh.name.startsWith(`${id}:median:`) && mesh.userData.planting);
    assert.equal(median?.userData.planting.form, 'open-lawn');
    assert.equal(roadHeight(x, z), null);
    assert.ok(Math.abs(model.shennanMedianHeight(x, z) - groundHeight(x, z) - 0.25) < 0.0001);
  }
  const civic = raw.roadFrontage.corridors.find(row => row.id === 'shennan-civic-center');
  assert.equal(civic.medianSource.imageryReview.captureDate, '2026-01-25');
  const band = raw.roadFrontage.features.filter(feature => feature.id === 'shennan-civic-center:flower-band');
  assert.equal(band.length, 1);
  assert.equal(band[0].id, 'shennan-civic-center:flower-band');
  assert.equal(band[0].riseM, 0);
  assert.deepEqual(band[0].outlines, []);
  const bandMeshes = model.group.children.filter(mesh => mesh.name.startsWith(`${band[0].id}:`));
  assert.ok(bandMeshes.length > 0 && bandMeshes.every(mesh => mesh.material.polygonOffset));
  for (const mesh of bandMeshes) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) + mesh.position.x;
      const z = positions.getZ(i) + mesh.position.z;
      assert.equal(roadHeight(x, z), null);
      assert.ok(Math.abs(model.shennanMedianHeight(x, z) - positions.getY(i)) < 0.00001);
    }
  }
  const { links, metadata, nodes } = raw.roadGraph;
  const openings = civic.medianSource.imageryReview.openingWayIds;
  for (const id of openings) {
    const indices = metadata.flatMap(({ osmId }, index) => osmId === id ? [index] : []);
    assert.ok(indices.length > 0);
    for (const index of indices) {
      const [start, end, , , , direction, inner] = links[index];
      assert.equal(direction, 1);
      const points = [...nodes.slice(start * 2, start * 2 + 2), ...inner, ...nodes.slice(end * 2, end * 2 + 2)];
      for (let i = 2; i < points.length; i += 2) {
        const x = (points[i - 2] + points[i]) / 2;
        const z = (points[i - 1] + points[i + 1]) / 2;
        assert.ok(Number.isFinite(roadHeight(x, z)));
        assert.equal(model.shennanMedianHeight(x, z), null);
      }
    }
  }
  assert.ok(['globfp/36321', 'globfp/36322', 'globfp/36726', 'globfp/38139']
    .every(id => !raw.buildings.id.includes(id)), 'reviewed Shennan median footprints cannot become buildings');
  assert.ok(model.statistics.curbSegments > 0);
  assert.ok(Number.isInteger(model.statistics.curbSegments));
  assert.ok(model.statistics.curbTriangles >= model.statistics.curbSegments
    && model.statistics.curbTriangles <= model.statistics.curbSegments * 2);
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
  const greenA = model.group.getObjectByName('signals:shennan-hongshulin:0:green').material;
  const greenB = model.group.getObjectByName('signals:shennan-hongshulin:1:green').material;
  assert.ok(greenA.emissiveIntensity > 0 && greenB.emissiveIntensity === 0);
  model.update(4.5);
  assert.ok(greenB.emissiveIntensity > 0 && greenA.emissiveIntensity === 0);
  const crossing = { id: 'shennan-hongshulin', group: 1 };
  assert.equal(model.control.enterCrossing(crossing, 4.6, 'walker'), true);
  model.update(8.1);
  assert.equal(greenA.emissiveIntensity + greenB.emissiveIntensity, 0);
  model.control.leaveCrossing(crossing, 'walker');
  model.update(8.2);
  assert.ok(greenA.emissiveIntensity > 0);
  assert.equal(model.walkLegs.filter(row => row.crossing).length, 9);
  assert.equal(model.walkLegs.filter(row => row.crossing && !row.signal).length, 2);
  for (const leg of model.walkLegs.filter(row => row.crossing)) {
    for (const { x, z } of [leg.points[0], leg.points.at(-1)]) {
      assert.equal(roadHeight(x, z), null, `Waiting inside the carriageway: ${leg.id}`);
      assert.ok(Number.isFinite(model.contactHeight(x, z)), `Missing landing: ${leg.id}`);
    }
  }
  assert.equal(model.colliders.filter(row => row.type === 'planted-island').length, 3);
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
        assert.ok(Number.isFinite(roadHeight(x, z)), `Off-road paint: ${mesh.name} at ${x}, ${z} (${Array.from(p.slice(i, i + 9))})`);
        checkedPaint++;
      }
      if (raised) {
        assert.equal(roadHeight(x, z), null);
        if (!mesh.name.includes(':flower-band:') || !mesh.name.startsWith('shennan-hongshulin:')) {
          assert.ok(Math.abs(model.contactHeight(x, z) - y) < 0.00001);
        }
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
