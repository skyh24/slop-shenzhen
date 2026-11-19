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
  const retired = source.displayReview.omit.filter(id => id.startsWith('globfp/'));
  assert.ok(retired.length > 0 && retired.every(id => !buildings.some(building => building.id === id)));
  assert.deepEqual([...omitted].sort(), source.displayReview.omit.filter(id => !retired.includes(id)).sort());
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
  program.toggleSpeed();
  program.update(2);
  assert.equal(program.time, 4);
  program.togglePause();
  for (const cue of [1, 2, 3, 0]) {
    program.next();
    assert.equal(program.cue, cue);
    assert.equal(program.paused, true);
  }
  program.stop();
  program.start();
  assert.equal(program.playbackRate, 1);
  program.stop();
  program.update(10);
  assert.equal(program.time, 0);
});

test('five roof beams sweep repeatably and the Ping An crown bursts only in the final three APEC seconds', async () => {
  const THREE = await import('three/webgpu');
  const { uniform } = await import('three/tsl');
  const { createCbdProgram } = await import('../js/sz-cbd-program.js');
  const { dayPhase } = await import('../js/sz-day-phase.js');
  const { partCollider } = await import('../js/sz-landmarks/parts.js');
  const { buildings, geo } = await loadData();
  const sources = new Map(buildings.map(b => [b.id, b]));
  const colliders = [];
  for (const id of ['civic-center', 'ping-an']) {
    const model = await import('../js/sz-landmarks/' + id + '.js');
    const result = model.build(sources, geo.terrain);
    for (const p of result.parts ?? result) colliders.push({ ...partCollider(p), landmarkId: id });
  }
  dayPhase.wire({ night: () => 0.86 });
  const scene = new THREE.Scene(), program = createCbdProgram({ x: 0, y: 113, z: -1030 }, uniform(0.86));
  program.mountSearchlights(scene, colliders);
  const group = scene.getObjectByName('cbd-searchlights');
  const wash = group.getObjectByName('civic-roof-sweep'), burst = group.getObjectByName('ping-an-crown-burst');
  const matrix = new THREE.Matrix4();
  const pose = (mesh, i) => { mesh.getMatrixAt(i, matrix); return matrix.clone(); };
  assert.equal(group.visible, false);
  program.start();
  assert.equal(wash.count, 5);
  const starts = Array.from({ length: wash.count }, (_, i) => pose(wash, i));
  assert.equal(new Set(starts.map(m => m.elements[12])).size, 5);
  program.update(96.99);
  assert.equal(burst.visible, false);
  for (const [i, start] of starts.entries()) {
    const next = pose(wash, i);
    assert.notDeepEqual(next.elements.slice(4, 7), start.elements.slice(4, 7));
    assert.deepEqual(next.elements.slice(12, 15), start.elements.slice(12, 15));
    assert.ok(Math.abs(Math.atan2(next.elements[4], next.elements[5])) < 43 * Math.PI / 180);
  }
  program.update(0.01);
  assert.equal(burst.visible, true);
  assert.equal(burst.count, 24);
  const crown = colliders.find(part => part.name.endsWith(':diamond-crown'));
  for (let i = 0; i < burst.count; i++) assert.equal(pose(burst, i).elements[13], crown.maxY);
  program.toggleSpeed();
  program.update(1);
  program.togglePause();
  const paused = pose(wash, 0);
  program.update(20);
  assert.deepEqual(pose(wash, 0), paused);
  assert.equal(burst.visible, true);
  program.togglePause();
  program.update(0.5);
  assert.equal(program.time, 100);
  assert.equal(burst.visible, false);
  program.replay();
  assert.deepEqual(pose(wash, 0), starts[0]);
  program.stop();
  assert.equal(group.visible, false);
  program.dispose();
  assert.equal(group.parent, null);
});
