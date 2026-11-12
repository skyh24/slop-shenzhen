const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { registerHooks } = require('node:module');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');

const root = process.env.SZ_THREE_PACKAGE_DIR ?? resolve(__dirname, '../.agents/three-0.187.0');
const three = { 'three/webgpu': 'three.webgpu.js', 'three/tsl': 'three.tsl.js' };
registerHooks({ resolve(specifier, context, next) {
  return three[specifier]
    ? { url: pathToFileURL(resolve(root, 'build', three[specifier])).href, shortCircuit: true }
    : next(specifier, context);
} });

const source = require('../data/source/lianhuashan-summit.json');
const noOp = () => {};
const context = new Proxy({}, {
  get: (target, key) => target[key] ?? (key === 'createLinearGradient' ? () => ({ addColorStop: noOp }) : noOp)
});
global.document = { hidden: false, addEventListener: noOp, createElement: () => ({ getContext: () => context }) };

let data;
async function loadData() {
  if (!data) {
    const { decodeCityPayload } = await import('../js/sz-data-format.js');
    const raw = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz'))));
    data = decodeCityPayload(raw);
  }
  return data;
}

test('summit presentation omissions are bound to the mapped park and keep adjacent city geometry', async () => {
  const { reviewedParkOmissions } = await import('../js/sz-lianhuashan.js');
  const { buildings, geo } = await loadData();
  const park = geo.parks.find(row => row.osmId === source.parkId);
  const omitted = reviewedParkOmissions(park, buildings);
  assert.deepEqual([...omitted].sort(), [...source.displayReview.omit].sort());
  for (const id of Object.keys(source.displayReview.keep)) {
    assert.ok(buildings.some(building => building.id === id));
    assert.ok(!omitted.has(id));
  }
  assert.equal(reviewedParkOmissions(null, buildings).size, 0);
});

test('summit arrival and treads share rendered contact and stay over the source terrain', async () => {
  const { Scene } = await import('three/webgpu');
  const { createGroundSurfaceSampler } = await import('../js/sz-ground-surface.js');
  const { createSurfaceResolver } = await import('../js/sz-controller-surfaces.js');
  const { buildLianhuashanSummit, SUMMIT_ARRIVAL } = await import('../js/sz-lianhuashan.js');
  const { geo } = await loadData();
  const ground = createGroundSurfaceSampler(geo.terrainSurface);
  const park = geo.parks.find(row => row.osmId === source.parkId);
  const summit = buildLianhuashanSummit(new Scene(), ground, park);
  const surface = createSurfaceResolver({ groundHeight: ground, surfaces: summit.surfaces });
  const { x, y, z, surfaceId } = SUMMIT_ARRIVAL;
  assert.equal(surface.below(x, z, y + 0.01).surfaceId, surfaceId);
  assert.equal(surface.below(x, z, y + 0.01).height, y);
  const colliders = new Map(summit.colliders.map(row => [row.name, row]));
  assert.ok(summit.colliders.some(row => row.sourceId === source.statue.id && row.name.includes(':plinth:')));
  for (const trunk of summit.colliders.filter(row => row.name.includes(':cypress:'))) {
    const support = surface.below((trunk.minX + trunk.maxX) / 2, (trunk.minZ + trunk.maxZ) / 2, trunk.minY + 0.01);
    assert.equal(support?.surfaceId, surfaceId);
    assert.equal(support.height, trunk.minY);
  }
  for (const piece of summit.surfaces) {
    const body = colliders.get(piece.id);
    assert.ok(body);
    for (const triangle of piece.triangles) {
      for (const p of triangle) {
        assert.equal(p.y, body.maxY);
        assert.ok(p.y > ground(p.x, p.z), `${piece.id} clears the original ground`);
      }
    }
  }
  for (const id of source.lookout.stepWayIds) {
    const stairs = summit.surfaces.filter(piece => piece.id.includes(id));
    assert.ok(stairs.length > 25);
    for (let i = 1; i < stairs.length; i++) {
      const previous = stairs[i - 1], current = stairs[i];
      assert.ok(Math.abs(current.triangles[0][0].y - previous.triangles[0][0].y) <= 0.18002);
      const cornerKeys = piece => new Set(piece.triangles.flat().map(p => `${p.x},${p.z}`));
      assert.equal([...cornerKeys(current)].filter(key => cornerKeys(previous).has(key)).length, 2);
    }
  }
});

test('the program clock loops continuously and honors pause, hidden tabs, replay and stop', async () => {
  const { createCbdProgram, cbdCue, CBD_PROGRAM_DURATION } = await import('../js/sz-cbd-program.js');
  const { uniform } = await import('three/tsl');
  const program = createCbdProgram({ x: 0, y: 113, z: -1030 }, uniform(0.86));
  assert.equal(program.active, false);
  program.start();
  for (const [advance, cue] of [[10, 0], [28, 1], [34, 2], [29, 3], [8, 0]]) {
    program.update(advance);
    assert.equal(program.cue, cue);
  }
  assert.equal(CBD_PROGRAM_DURATION, 108);
  assert.equal(cbdCue(program.time).time, 1);
  program.togglePause();
  program.update(10);
  assert.equal(program.time, 109);
  program.togglePause();
  document.hidden = true;
  program.update(10);
  document.hidden = false;
  assert.equal(program.time, 109);
  program.replay();
  assert.equal(program.time, 0);
  program.stop();
  program.update(10);
  assert.equal(program.time, 0);
});
