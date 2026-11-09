const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const load = (name, imports = {}) => loadModule(read(name), { imports });
const terrain = load('sz-terrain.js');
const collision = load('building-collision.js');
const placement = load('sz-building-layout.js', { './sz-terrain.js': terrain });
const partsApi = load('sz-landmarks/parts.js', { '../building-collision.js': collision, '../sz-building-layout.js': placement });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { geo, buildings } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const source = new Map(buildings.map(row => [row.id, row]));
const model = (three = {}, tsl = {}) => load('sz-landmarks/nonferrous-tower.js', {
  'three/webgpu': three, 'three/tsl': tsl, './parts.js': partsApi,
  '../sz-materials.js': { sceneUniforms: tsl.uniform ? { night: tsl.uniform(0) } : {} }
});
const height = (b) => placement.buildingPlacement(b, geo.terrain).baseY;
const close = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const center = ring => ({ x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
  z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length });

function onOrIn(polygon, x, z) {
  if (collision.polygonContains(polygon, x, z)) return true;
  return polygon.outer.some((a, i) => {
    const b = polygon.outer[(i + 1) % polygon.outer.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) < 0.001;
  });
}

test('the Nonferrous candidate uses only the three locked parts and keeps their source envelopes', () => {
  const { build, sourceIds, optionalSkipIds } = model();
  assert.deepEqual(Array.from(sourceIds), ['way/1163682856', 'way/1163682857', 'way/1163682858']);
  assert.deepEqual(Array.from(optionalSkipIds), ['way/135907001', 'overture/decad456-eee1-4bc4-8917-76bb0aab35e8']);
  const missing = new Map(source);
  missing.delete(sourceIds[2]);
  assert.equal(build(missing, geo.terrain).length, 0);
  const built = build(source, geo.terrain);
  assert.ok(built.length > 25);
  assert.equal(new Set(built.map(p => p.id)).size, built.length);
  for (const id of sourceIds) {
    const b = source.get(id), owned = built.filter(p => p.sourceId === id);
    const original = b.polygons[0];
    close(Math.min(...owned.map(p => p.minY)), height(b) + b.minHeight);
    close(Math.max(...owned.map(p => p.maxY)), height(b) + b.height);
    assert.ok(owned.every(p => p.sourceHeight === b.height && p.sourceHeightSource === 'osm-levels'
      && p.shapeSource === 'visual-estimate' && p.baseSourceId === b.id && !p.roofContact));
    for (const part of owned) {
      assert.ok(part.minY < part.maxY);
      for (const [i, a] of part.polygon.outer.entries()) {
        const q = part.polygon.outer[(i + 1) % part.polygon.outer.length];
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          assert.ok(onOrIn(original, a.x + (q.x - a.x) * t, a.z + (q.z - a.z) * t), part.id);
        }
      }
    }
  }
});

const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;

test('real Three draws and collides with the same curved recess, slabs and supported corner arcade',
  { skip: !threePackageDir }, async () => {
    const url = pathToFileURL(join(threePackageDir, '/'));
    const THREE = await import(new URL('build/three.webgpu.js', url));
    const tsl = await import(new URL('build/three.tsl.js', url));
    const nonferrous = model(THREE, tsl);
    const { build } = nonferrous;
    const parts = build(source, geo.terrain);
    const { renderLandmark } = load('sz-landmarks/render.js', {
      'three/webgpu': THREE, '../sz-geometry.js': load('sz-geometry.js', { 'three/webgpu': THREE })
    });
    const { createLandmarkMaterial } = load('sz-landmarks/materials.js', {
      'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': { sceneUniforms: { night: tsl.uniform(0) } },
      './shenzhen-bay-culture-square.js': {}, './upperhills.js': {}, './nonferrous-tower.js': nonferrous,
      './iec-xiangmihu.js': {}, './super-hq.js': {}
    });
    const { group, surfaces } = renderLandmark({ id: 'nonferrous-tower', parts }, createLandmarkMaterial);
    group.updateMatrixWorld(true);
    const named = name => parts.find(p => p.id === `nonferrous:${name}:0`);
    const colliders = parts.map(partsApi.partCollider);
    const contains = (x, y, z) => colliders.some(c => y > c.minY && y < c.maxY && collision.polygonContains(c.polygon, x, z));
    const ray = (x, y, z, dx, dy, dz) => new THREE.Raycaster(new THREE.Vector3(x, y, z),
      new THREE.Vector3(dx, dy, dz).normalize()).intersectObjects(group.children)[0];

    try {
      assert.equal(surfaces.length, 0);
      assert.equal(group.children.length, 5);
      assert.equal(parts.filter(p => /^nonferrous:upper-balcony:/.test(p.id)).length, 11);
      assert.equal(parts.filter(p => /^nonferrous:middle-balcony:/.test(p.id)).length, 4);
      assert.equal(parts.filter(p => /^nonferrous:south-gallery-pier:/.test(p.id)).length, 7);

      const balcony = named('upper-balcony:4');
      const outer = balcony.polygon.outer;
      const rail = named('upper-rail:4').polygon.outer;
      const samples = rail.length / 2, mid = Math.floor(samples / 2);
      const a = outer[mid], b = rail[rail.length - 1 - mid];
      const chord = (outer[0].z + outer[samples - 1].z) / 2;
      assert.ok(a.z - chord > 1.5, 'the high balcony is curved in plan');
      const dx = (b.x - a.x) / 0.24, dz = (b.z - a.z) / 0.24;
      const x = a.x + dx * 3, z = a.z + dz * 3;
      const spaceY = balcony.maxY + 1.5;
      assert.equal(contains(x, spaceY, z), false);
      assert.equal(contains(x, (balcony.minY + balcony.maxY) / 2, z), true);
      const back = ray(a.x - dx * 8, spaceY, a.z - dz * 8, dx, 0, dz);
      assert.ok(back && back.distance > 13 && back.distance < 16);
      assert.equal(contains(back.point.x - dx * 0.002, spaceY, back.point.z - dz * 0.002), false);
      assert.equal(contains(back.point.x + dx * 0.002, spaceY, back.point.z + dz * 0.002), true);

      const pier = named('south-gallery-pier:0:1'), other = named('south-gallery-pier:0:2');
      const p = center(pier.polygon.outer), q = center(other.polygon.outer);
      const aisle = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      const base = pier.minY, soffit = named('south-gallery-soffit');
      assert.equal(contains(p.x, base + 1.4, p.z), true);
      assert.equal(contains(aisle.x, base + 1.4, aisle.z), false);
      close(ray(aisle.x, base + 1.4, aisle.z, 0, 1, 0).point.y, soffit.minY);
      const lobby = center(named('south-gallery-lobby').polygon.outer);
      assert.equal(contains(lobby.x, base + 1.4, lobby.z), true);

      let triangles = 0;
      const v = new THREE.Vector3(), w = new THREE.Vector3(), origin = new THREE.Vector3();
      for (const mesh of group.children) {
        assert.ok(mesh.material.isMeshStandardNodeMaterial);
        const { index, attributes: { position } } = mesh.geometry;
        for (let i = 0; i < index.count; i += 3) {
          origin.fromBufferAttribute(position, index.getX(i));
          v.fromBufferAttribute(position, index.getX(i + 1)).sub(origin);
          w.fromBufferAttribute(position, index.getX(i + 2)).sub(origin);
          assert.ok(v.cross(w).lengthSq() > 1e-12, `Degenerate triangle in ${mesh.name}`);
          triangles++;
        }
      }
      assert.ok(triangles > 1000 && triangles < 8000, `Unexpected triangle budget: ${triangles}`);
    } finally {
      for (const mesh of group.children) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
  });
