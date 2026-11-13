const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const { validateCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const bridge = raw.bridges.find(b => b.id === 'shenzhen-bay-bridge');
const nearestStation = s => bridge.stations.reduce((a, b) => Math.abs(a.stationM - s) < Math.abs(b.stationM - s) ? a : b);

test('Shenzhen Bay bridge retains the reviewed OSM towers, directions and engineering spans', () => {
  assert.equal(validateCityPayload(raw), raw);
  assert.equal(bridge.source.osmRelationId, 9184867);
  assert.equal(bridge.source.designLengthM, 5545);
  assert.equal(bridge.source.verticalDatum, 'nominal-waterline-visual-reference');
  const [north, south] = bridge.spans;
  assert.deepEqual(bridge.spans.map(span => span.tower.osmNodeId), [6048306333, 6048306332]);
  assert.deepEqual(bridge.spans.map(span => span.stayPairs), [12, 13]);
  assert.deepEqual(bridge.spans.map(span => span.stayLayout.stayMainSpacingM), [12, 12]);
  assert.deepEqual(bridge.spans.map(span => span.stayLayout.stayBackSpacingM), [3, 3]);
  assert.ok(north.tower.lean > 0 && south.tower.lean < 0);
  assert.ok(Math.abs(north.tower.stationM - north.startM - 180) < 0.002);
  assert.ok(Math.abs(south.endM - south.tower.stationM - 210) < 0.002);
  assert.equal(nearestStation(-1786.25).oppositeX, undefined);
  assert.ok(Number.isFinite(nearestStation(-1730).oppositeX));
  assert.deepEqual([...new Set(bridge.stations.map(p => p.lanes))].sort(), [2, 3]);
  assert.deepEqual([...new Set(bridge.stations.flatMap(p => p.oppositeLanes ?? []))].sort(), [3, 4]);
  const [, b, ...rest] = bridge.stations;
  const malformed = { ...raw, bridges: [{ ...bridge, stations: [b, ...bridge.stations.slice(0, 1), ...rest] }] };
  assert.throws(() => validateCityPayload(malformed), /bridge station/);
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('bridge surfaces use the actual render buffers and both navigation spans stay clear', { skip: !threeDir }, async () => {
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const cityLighting = loadModule(read('city-lighting-materials.js'), { imports });
  const geometry = loadModule(read('sz-geometry.js'), { imports });
  const materials = loadModule(read('sz-materials.js'), { imports: { ...imports, './city-lighting-materials.js': cityLighting,
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')) } });
  const { buildShenzhenBayBridge } = loadModule(read('sz-landmarks/shenzhen-bay-bridge.js'), {
    imports: { ...imports, '../sz-geometry.js': geometry, '../sz-materials.js': materials }
  });
  const scene = new THREE.Scene();
  const model = buildShenzhenBayBridge(scene, bridge);
  scene.updateMatrixWorld(true);
  assert.equal(model.group.parent, scene);
  assert.equal(model.statistics.stays, 50);
  assert.equal(model.statistics.meshes, 7);
  assert.ok(model.statistics.triangles < 100000);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  for (const [meshIndex, mesh] of model.meshes.entries()) {
    assert.equal(model.collisionGeometry[meshIndex], mesh.geometry);
    const { position, normal: normals } = mesh.geometry.attributes;
    const indices = mesh.geometry.index.array;
    assert.ok(position.array.every(Number.isFinite));
    for (let i = 0; i < indices.length; i += 3) {
      a.fromBufferAttribute(position, indices[i]);
      b.fromBufferAttribute(position, indices[i + 1]).sub(a);
      c.fromBufferAttribute(position, indices[i + 2]).sub(a);
      normal.fromBufferAttribute(normals, indices[i]);
      assert.ok(b.cross(c).lengthSq() > 1e-12 && b.normalize().dot(normal) > 0.95);
    }
  }
  const hit = (x, y, z, vertical) => new THREE.Raycaster(
    new THREE.Vector3(x, y, z), new THREE.Vector3(0, vertical, 0)).intersectObjects(model.meshes)[0];
  for (const span of bridge.spans) {
    const mid = nearestStation(span.tower.stationM + span.mainDirection * span.mainSpanM / 2);
    for (const [x, z] of [[mid.x, mid.z], [mid.oppositeX, mid.oppositeZ]]) {
      const underside = hit(x, 1, z, 1);
      const surface = hit(x, mid.y + 0.5, z, -1);
      assert.ok(underside.object.name.endsWith(':steel'));
      assert.ok(surface.object.name.endsWith(':asphalt'));
      assert.ok(Math.abs(surface.point.y - mid.y) < 0.003);
      assert.ok(Math.abs(surface.point.y - underside.point.y - span.girderDepthM) < 0.12);
    }
    for (const s of [span.startM, span.endM]) {
      const joint = nearestStation(s);
      const surface = hit(joint.x, joint.y + 0.5, joint.z, -1);
      assert.ok(surface.object.name.endsWith(':asphalt') && Math.abs(surface.point.y - joint.y) < 0.003);
    }
  }
  model.dispose();
  assert.equal(scene.children.length, 0);
});
