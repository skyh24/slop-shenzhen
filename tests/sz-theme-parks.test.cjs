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
    : specifier === 'three/webgpu' ? 'build/three.webgpu.js' : null;
  return file ? { url: pathToFileURL(resolve(root, file)).href, shortCircuit: true } : next(specifier, context);
} });

test('the production pack fits all three parks and preserves ground access', async () => {
  const { Scene } = await import('three/webgpu');
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { createGroundSurfaceSampler } = await import('../js/sz-ground-surface.js');
  const { polygonContainsInclusive } = await import('../js/sz-polygon.js');
  const { buildThemeParks } = await import('../js/sz-theme-parks/index.js');
  const raw = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz'))));
  const { geo, buildings } = decodeCityPayload(raw);
  const scene = new Scene();
  const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);
  const isWater = (x, z) => geo.water.some(p => polygonContainsInclusive(p, x, z));
  const parks = buildThemeParks(scene, { ...geo, buildings, groundHeight, isWater });
  const summary = parks.snapshot();
  assert.deepEqual(summary.rejected, []);
  assert.deepEqual(summary.parks.map(p => p.models.length), [5, 3, 2]);
  assert.deepEqual(summary.parks.map(p => p.walks), [3, 2, 2]);
  assert.equal(parks.skipIds.size, 4);
  assert.equal(parks.pathAt(-8750, 1025).length, 1);
  assert.equal(parks.pathAt(0, 0).length, 0);
  for (const mesh of parks.group.children.filter(o => o.name.includes('-walk:'))) {
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 7) {
      assert.ok(Math.abs(p.getY(i) - groundHeight(p.getX(i) + mesh.position.x, p.getZ(i) + mesh.position.z)) < 0.002);
    }
  }
  assert.ok(parks.colliders.every(p => p.heightSource && p.minY < p.maxY));
  assert.ok(!parks.colliders.some(p => p.minY < 9.9 && p.maxY > 8
    && polygonContainsInclusive(p.polygon, -8750, 1025)));
  assert.ok(parks.reserved(-8660, 1045, 0));
  assert.equal(parks.pathAt(-8660, 1045).length, 0);
  parks.dispose();
  assert.equal(scene.children.length, 0);
});

test('the coaster center and both rails are closed and keep clearance above the terrain', async () => {
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { createGroundSurfaceSampler } = await import('../js/sz-ground-surface.js');
  const { rollerCoaster } = await import('../js/sz-theme-parks/rides.js');
  const raw = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz'))));
  const { geo } = decodeCityPayload(raw);
  const ground = createGroundSurfaceSampler(geo.terrainSurface);
  const { track, rings, parts } = rollerCoaster(ground, () => true);
  assert.ok(track.getPointAt(0).distanceTo(track.getPointAt(1)) < 1e-6);
  for (let i = 0; i < rings.length; i++) for (let r = 0; r < 3; r++) {
    const a = rings[i][r], b = rings[(i + 1) % rings.length][r];
    assert.ok(a.y - ground(a.x, a.z) > 3.5);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 6);
  }
  assert.ok(parts.some(p => p.style === 'basalt' && p.maxY < 12));
});

test('fireworks complete each cycle, skip distant launches and stop at daylight', async () => {
  const { Scene, Vector3 } = await import('three/webgpu');
  const { buildParkFireworks } = await import('../js/sz-park-fireworks.js');
  const scene = new Scene();
  const show = buildParkFireworks(scene, { x: 0, y: 8, z: 0 });
  const near = new Vector3(0, 12, 450);
  const reduced = new Vector3(0, 15, 1100);
  const far = new Vector3(0, 12, 2500);
  for (let i = 0; i < 6; i++) {
    const t = i * 5;
    show.update(t, true, near);
    assert.equal(show.snapshot().phase, 'ascent');
    assert.equal(show.snapshot().launched, i + 1);
    show.update(t + 2, true, near);
    assert.equal(show.snapshot().phase, 'burst');
    assert.equal(show.snapshot().particles, 96);
    show.update(t + 2.1, true, reduced);
    assert.equal(show.snapshot().particles, 48);
    show.update(t + 4.7, true, near);
    assert.equal(show.snapshot().particles, 0);
  }
  show.update(30, true, far);
  show.update(32, true, near);
  assert.equal(show.snapshot().phase, 'idle');
  show.update(35, true, near);
  assert.equal(show.snapshot().launched, 7);
  show.update(37, false, near);
  assert.equal(show.snapshot().particles, 0);
  show.update(46, false, near);
  assert.equal(show.snapshot().launched, 7);
  show.dispose();
  assert.equal(scene.children.length, 0);
});
