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
    : specifier === 'three' || specifier === 'three/webgpu' ? 'build/three.webgpu.js'
    : specifier.startsWith('three/addons/') ? 'examples/jsm/' + specifier.slice(13) : null;
  return file ? { url: pathToFileURL(resolve(root, file)).href, shortCircuit: true } : next(specifier, context);
} });

let fixture;
async function load() {
  if (fixture) return fixture;
  const { Scene } = await import('three/webgpu');
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { createGroundSurfaceSampler } = await import('../js/sz-ground-surface.js');
  const { polygonContainsInclusive } = await import('../js/sz-polygon.js');
  const { buildTalentWaterfront } = await import('../js/sz-talent-waterfront.js');
  const { createRoadHeightSampler, createRoadSurfaceLayout } = await import('../js/sz-roads.js');
  const raw = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz'))));
  const { geo, buildings } = decodeCityPayload(raw);
  const scene = new Scene();
  const source = geo.talentPark, lake = geo.water[source.lakeWaterIndex];
  const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);
  const isWater = (x, z) => polygonContainsInclusive(lake, x, z);
  const { chunks } = createRoadSurfaceLayout(geo.roadGraph, geo.terrainSurface);
  const roadHeight = createRoadHeightSampler(chunks, geo.terrainSurface.grid);
  const colliders = buildings.flatMap(b => b.polygons.flatMap(p => {
    if (!p.outer.some(p => p.x > -11700 && p.x < -11175 && p.z > 3600 && p.z < 4120)) return [];
    const xs = p.outer.map(p => p.x), zs = p.outer.map(p => p.z);
    const base = groundHeight(xs[0], zs[0]) ?? 0;
    return [{ minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs),
      minY: base + b.minHeight, maxY: base + b.height, polygon: p }];
  }));
  const walk = buildTalentWaterfront(scene, source, lake,
    { terrainSurface: geo.terrainSurface, groundHeight, isWater, roadHeight, colliders });
  fixture = { scene, walk, source, lake, groundHeight, isWater, colliders: [...colliders, ...walk.colliders] };
  return fixture;
}

test('waterfront landing, greenway, stairs and water boundary use one continuous supported route', async () => {
  const { createSurfaceResolver } = await import('../js/sz-controller-surfaces.js');
  const { walk, source, groundHeight, isWater } = await load();
  const resolver = createSurfaceResolver({ groundHeight, surfaces: walk.surfaces });
  const { x, y, z, surfaceId } = walk.arrival;
  assert.ok(resolver.at(x, z).some(s => s.surfaceId === surfaceId && s.height === y));
  assert.equal(isWater(x, z), false);
  assert.ok(source.lengthM > 450 && source.lengthM < 500);
  for (let s = 1; s < walk.route.length - 1; s += 0.6) {
    for (const offset of [-0.9, 0, 0.9]) {
      const p = walk.route.at(s, offset);
      assert.ok(Number.isFinite(walk.pathHeightAt(p.x, p.z)), `Missing walk surface at station ${s} offset ${offset}`);
      assert.equal(isWater(p.x, p.z), false);
    }
  }
  const steps = walk.surfaces.filter(s => s.id.includes(':tread:'));
  assert.ok(steps.length >= 3);
  for (const [i, step] of steps.entries()) {
    const [a, b, c] = step.triangles[0];
    const [x, z] = [(a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3];
    assert.ok(resolver.at(x, z).some(s => s.surfaceId === step.id && Math.abs(s.height - a.y) < 1e-6));
    if (i) assert.ok(Math.abs(a.y - steps[i - 1].triangles[0][0].y) < 0.18);
  }
  const rails = walk.colliders.filter(c => c.name.includes(':rail:'));
  assert.ok(rails.length >= 18);
  assert.ok(rails.every(c => c.maxY - c.minY > 1.12));
});

test('both Shenzhen characters and all four APEC letters survive the fleet budget', async () => {
  const { createDroneFormations, FLEET_SIZE } = await import('../js/sz-drone-formations.js');
  const rows = createDroneFormations();
  assert.ok(rows.every(row => row.points.length === FLEET_SIZE));
  const letters = name => rows.find(row => row.id === name).points.filter(p => p.essential);
  const city = letters('city');
  assert.ok(city.filter(p => p.u < 0).length > 35);
  assert.ok(city.filter(p => p.u > 0).length > 25);
  const apec = letters('apec');
  const letterSizes = [-16, -7, 2, 11].map(left =>
    apec.filter(p => p.u >= left * 4 && p.u <= (left + 4) * 4).length);
  assert.deepEqual(letterSizes, [18, 15, 18, 13]);
});

test('every flight and replay phase maintains 3D separation and motion limits through the loop', async () => {
  const { planDroneChoreography, DRONE_CLEARANCE_M, DRONE_SPEED_MPS, DRONE_ACCEL_MPS2 } =
    await import('../js/sz-drone-choreography.js');
  const plan = planDroneChoreography();
  assert.ok(plan.duration >= 120 && plan.duration <= 180);
  assert.ok(plan.minSpacing >= DRONE_CLEARANCE_M);
  assert.ok(plan.peakSpeed <= DRONE_SPEED_MPS);
  assert.ok(plan.peakAcceleration <= DRONE_ACCEL_MPS2);
  assert.deepEqual(plan.stages.at(-1).to, plan.stages[0].from);
  for (const stages of [plan.stages, ...[...plan.replays.values()].map(replay => replay.stages)]) {
    for (const [index, row] of stages.entries()) {
      if (index) assert.deepEqual(row.from, stages[index - 1].to);
      for (let i = 0; i < row.from.length; i++) {
        const a = row.from[i], b = row.to[i];
        const distance = Math.hypot(a.u - b.u, a.v - b.v, a.d - b.d);
        const dt = row.end - row.start;
        assert.ok(distance * 1.875 / dt <= DRONE_SPEED_MPS + 1e-9);
        assert.ok(distance * (10 / Math.sqrt(3)) / dt ** 2 <= DRONE_ACCEL_MPS2 + 1e-9);
        for (let j = 0; j < i; j++) {
          const c = row.from[j], d = row.to[j];
          const x = a.u - c.u, y = a.v - c.v, z = a.d - c.d;
          const dx = b.u - d.u - x, dy = b.v - d.v - y, dz = b.d - d.d - z;
          const denominator = dx * dx + dy * dy + dz * dz;
          const f = denominator ? Math.min(1, Math.max(0, -(x * dx + y * dy + z * dz) / denominator)) : 0;
          assert.ok(Math.hypot(x + dx * f, y + dy * f, z + dz * f) >= DRONE_CLEARANCE_M);
        }
      }
    }
  }
});

test('show resources are allocated on entry and disposed across pause, replay, loop and reentry', async () => {
  const { createTalentDroneShow } = await import('../js/sz-talent-drone-show.js');
  const { scene, walk, source, lake, colliders } = await load();
  global.document = { hidden: false };
  const show = createTalentDroneShow(scene, { airspace: walk.airspace, lake, colliders, lakeHeight: source.simulation.lakeHeightM });
  assert.ok(show.available);
  const camera = walk.arrival;
  const frame = seconds => {
    for (let i = 0; i < Math.ceil(seconds / 0.24); i++) show.update(0.24, camera);
  };
  for (let run = 0; run < 2; run++) {
    assert.ok(show.start());
    const group = scene.getObjectByName('talent-park:drone-show');
    let disposals = 0;
    for (const mesh of group.children) for (const object of [mesh, mesh.geometry, mesh.material]) {
      object.addEventListener('dispose', () => { disposals++; });
    }
    frame(20);
    assert.ok(show.statistics.lit > 0);
    show.togglePause();
    const previous = show.time;
    frame(2);
    assert.equal(show.time, previous);
    show.replay();
    assert.ok(show.replayPending);
    frame(25);
    assert.ok(show.time < previous && !show.replayPending);
    frame(show.statistics.duration);
    assert.equal(show.statistics.loops, 1);
    show.stop();
    assert.equal(disposals, 6);
    assert.equal(scene.getObjectByName('talent-park:drone-show'), undefined);
  }
});

test('waterfront walkers move on the built surface and spectators rejoin after the show', async () => {
  const { createTalentPedestrians } = await import('../js/sz-talent-pedestrians.js');
  const { scene, walk, isWater, colliders } = await load();
  const people = createTalentPedestrians(scene, walk, colliders);
  assert.ok(people.actors.length >= 10);
  const positions = new Map(people.actors.map(p => [p.id, p.s]));
  function advance(watching, seconds) {
    for (let i = 0; i < 20 * seconds; i++) people.update(0.05, walk.arrival, walk.arrival, () => false, watching);
  }
  advance(true, 26);
  assert.ok(people.actors.some(p => p.mode === 'watch'));
  assert.ok(people.actors.filter(p => Math.abs(positions.get(p.id) - p.s) > 10).length >= 6);
  for (const p of people.actors) {
    assert.equal(p.y, walk.pathHeightAt(p.x, p.z));
    assert.equal(isWater(p.x, p.z), false);
  }
  advance(false, 10);
  assert.ok(people.actors.every(p => p.mode === 'walk'));
  for (let window = 0; window < 6; window++) {
    advance(true, 40);
    assert.ok(people.actors.filter(p => Math.hypot(p.x - walk.arrival.x, p.z - walk.arrival.z) < 9).length <= 5);
  }
  people.dispose();
  people.dispose();
  assert.equal(people.group.parent, null);
  assert.equal(people.nearColliders(walk.arrival.x, walk.arrival.z, 20).length, 0);
});


test('waterfront fixture variants share box geometry across site unloads', async () => {
  const { walk } = await load();
  walk.dispose();
  const { Scene, Group } = await import('three/webgpu');
  const { createFixtureBatches, planLantern } = await import('../js/sz-site-fixtures.js');
  const scene = new Scene();
  const bay = new Group(), park = new Group(), otherBay = new Group();
  scene.add(bay, park, otherBay);
  const a = createFixtureBatches(bay, 'bay'), b = createFixtureBatches(park, 'park', 'z');
  const c = createFixtureBatches(otherBay, 'bay');
  const rows = [planLantern({ x: 0, y: 0, z: 0 }, { poleBottomM: 0, poleTopM: 3,
    headBottomM: 3, headTopM: 3.2, headWidthM: 0.25 }).lamp];
  const am = a.build(rows, 'lamp', 'bay'), bm = b.build(rows, 'lamp', 'park'), cm = c.build(rows, 'lamp', 'other-bay');
  assert.equal(am.geometry, bm.geometry);
  assert.equal(am.material, cm.material);
  assert.notEqual(am.material, bm.material);
  const ar = a.build(rows, 'steel', 'bay-rail'), br = b.build(rows, 'steel', 'park-rail');
  assert.equal(ar.material, br.material);
  let geometryDisposed = 0, bayMaterialDisposed = 0;
  am.geometry.addEventListener('dispose', () => geometryDisposed++);
  am.material.addEventListener('dispose', () => bayMaterialDisposed++);
  a.dispose();
  a.dispose();
  assert.deepEqual([geometryDisposed, bayMaterialDisposed, park.children.length, otherBay.children.length], [0, 0, 2, 1]);
  c.dispose();
  assert.deepEqual([geometryDisposed, bayMaterialDisposed], [0, 1]);
  b.dispose();
  assert.deepEqual([geometryDisposed, bayMaterialDisposed], [1, 1]);
});
