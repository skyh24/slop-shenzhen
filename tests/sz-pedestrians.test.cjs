const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// 轻量 THREE / PersonCrowd / PersonRig 替身：不访问 DOM 或 WebGPU，只验证轨迹、出生、回收和接地逻辑。
const three = (() => {
  class Group {
    constructor() { this.children = []; this.name = ''; }
    add(object) { this.children.push(object); }
    remove(object) {
      const index = this.children.indexOf(object);
      if (index >= 0) this.children.splice(index, 1);
    }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    computeVertexNormals() { this.normalsComputed = true; }
    computeBoundingSphere() { this.boundingSphere = { radius: 1 }; }
    dispose() { this.disposed = true; }
  }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.isMesh = true; }
  }
  class Material {
    constructor(options = {}) { Object.assign(this, options); }
    dispose() { this.disposed = true; }
  }
  return { Group, BufferGeometry, BufferAttribute, Mesh, MeshStandardNodeMaterial: Material };
})();

function createPedestrianStub() {
  const rigs = [];
  const crowds = [];
  const makeMesh = (name) => ({
    name,
    geometry: { dispose() {} },
    material: { dispose() {} },
    dispose() {}
  });
  class PersonRig {
    constructor(options = {}) {
      this.options = options;
      this.seed = options.seed ?? 0;
      this.placed = false;
      this.pose = new Float32Array(4);
      this.updates = [];
      rigs.push(this);
    }
    update(dt, x, z, heading, ground, owner, air, draw, diveTime) {
      this.placed = true;
      this.updates.push({ dt, x, z, heading, ground, owner, air, draw, diveTime });
    }
  }
  class PersonCrowd {
    constructor(maxCount, options = {}) {
      this.maxCount = maxCount;
      this.options = options;
      this.meshes = [makeMesh('PeopleNear'), makeMesh('PeopleFar')];
      this.added = [];
      this.frames = 0;
      crowds.push(this);
    }
    begin() { this.added = []; this.frames++; }
    add(rig, distance) { this.added.push({ rig, distance }); }
    end() {}
  }
  return { module: { PersonCrowd, PersonRig, PEDESTRIAN_DIVE_DURATION: 2.5 }, rigs, crowds };
}

const read = (name) => readFileSync(join(__dirname, '..', 'js', name), 'utf8');
const roads = loadModule(read('sz-roads.js'), { imports: { 'three/webgpu': {} } });
const collision = loadModule(read('building-collision.js'));
const tracks = loadModule(read('sz-pedestrian-tracks.js'), {
  imports: { './sz-roads.js': roads, './building-collision.js': collision }
});
const pedestrianStub = createPedestrianStub();
const pedestrians = loadModule(read('sz-pedestrians.js'), {
  imports: {
    'three/webgpu': three,
    './pedestrians.js': pedestrianStub.module,
    './sz-pedestrian-tracks.js': tracks
  }
});
const { buildSidewalkTracks, buildWalkTracks, connectTracks, sampleTrack } = tracks;
const { createSzPedestrians } = pedestrians;

function roadGraph(nodes, widths) {
  const links = [];
  for (let i = 1; i < nodes.length / 2; i++) links.push([i - 1, i, 0, widths[i - 1] ?? 7, 2, 1, []]);
  return {
    nodes,
    links,
    names: ['Test Road'],
    nodeIds: Array.from({ length: nodes.length / 2 }, (_, i) => `node/${i + 1}`),
    metadata: links.map((_, i) => ({ osmId: `way/${i + 1}`, heightSource: 'terrain', bridge: false, tunnel: false,
      layer: 0, highway: 'residential' }))
  };
}

function collider(minX, minZ, maxX, maxZ) {
  return {
    type: 'building', name: 'test', sourceId: 'test',
    polygon: { outer: [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }], holes: [] },
    minX, minZ, maxX, maxZ, minY: -5, maxY: 40
  };
}

const flatHeight = () => 0;

function sceneStub() {
  return { objects: [], add(object) { this.objects.push(object); }, remove(object) {
    const index = this.objects.indexOf(object);
    if (index >= 0) this.objects.splice(index, 1);
  } };
}

function straightGraph(lengthM = 200, widthM = 7) {
  return roadGraph([0, 0, lengthM, 0], [widthM]);
}

test('side tracks are offset outside the carriageway and follow heightAt', () => {
  const graph = straightGraph();
  const heightAt = (x) => 0.5 + x * 0.01;
  const built = buildSidewalkTracks(graph, { heightAt });
  assert.equal(built.tracks.length, 2);
  const offsets = built.tracks.map(track => track.points[Math.floor(track.points.length / 2)].z).sort((a, b) => a - b);
  const expected = 7 / 2 + 2.1;
  assert.ok(Math.abs(Math.abs(offsets[0]) - expected) < 1e-6);
  assert.ok(Math.abs(Math.abs(offsets[1]) - expected) < 1e-6);
  for (const track of built.tracks) {
    for (const point of track.points) {
      assert.ok(Math.abs(Math.abs(point.z) - expected) < 1e-6);
      assert.ok(Math.abs(point.y - heightAt(point.x)) < 1e-9);
    }
    assert.ok(track.length > 190 && track.length <= 200 + 1e-6);
  }
  assert.equal(built.statistics.tracks, 2);
});

test('a collider splits a side track, and a fully blocked side is rejected', () => {
  const graph = straightGraph(200);
  const half = 200;
  const split = buildSidewalkTracks(graph, { heightAt: flatHeight, colliders: [collider(40, -9, 60, -3)] });
  // -z 侧被 40–60 m 的建筑切断成两段，+z 侧完整保留。
  assert.equal(split.tracks.length, 3);
  assert.ok(split.statistics.colliderBlockedSamples > 0);
  for (const track of split.tracks) {
    for (const point of track.points) {
      const blocked = point.x > 40 && point.x < 60 && point.z > -9 && point.z < -3;
      assert.equal(blocked, false);
    }
  }
  const blocked = buildSidewalkTracks(graph, { heightAt: flatHeight, colliders: [collider(0, -9, half, -3)] });
  assert.equal(blocked.tracks.length, 1);
  assert.ok(blocked.tracks[0].points.every(point => point.z > 0));
});

test('corner connectors join same-side tracks around a junction and never cross the carriageway', () => {
  const graph = roadGraph([0, 0, 100, 0, 100, 100], [7, 7]);
  const built = buildWalkTracks(graph, { heightAt: flatHeight, pavement: false });
  assert.ok(built.tracks.length >= 3);
  assert.ok(built.connectors.length >= 1);
  for (const track of built.tracks) {
    for (const end of [0, 1]) {
      for (const link of track.ends[end]) assert.equal(link.leg.ends[link.end].some(back => back.leg === track), true);
    }
  }
  // 连接线每个采样点都不在任何一条车行道内（含自身道路）。
  for (const connector of built.connectors) {
    for (const point of connector.points) {
      const onA = point.z > -3.5 && point.z < 3.5 && point.x > -0.15 && point.x < 100.15;
      const onB = point.x > 96.5 && point.x < 103.5 && point.z > -0.15 && point.z < 100.15;
      assert.equal(onA || onB, false, `connector point ${point.x},${point.z} is on a carriageway`);
    }
  }
});

test('the two sides of a straight road never connect through the roadway', () => {
  const graph = straightGraph(200);
  const built = buildWalkTracks(graph, { heightAt: flatHeight, pavement: false });
  assert.equal(built.connectors.length, 0);
  assert.ok(built.tracks.every(track => track.ends[0].length === 0 && track.ends[1].length === 0));
});

test('pavement ribbons are 2.2 m light grey bands that narrow against buildings', () => {
  const graph = straightGraph(200);
  const built = buildWalkTracks(graph, { heightAt: flatHeight, colliders: [collider(80, 6.3, 120, 10)], pavement: true });
  assert.ok(built.pavement.statistics.triangles > 0);
  const positions = built.pavement.positions;
  const colors = built.pavement.colors;
  assert.equal(positions.length, colors.length);
  assert.equal(positions.length % 18, 0);
  let openMaxZ = 0;
  let blockedMaxZ = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const z = positions[i + 2];
    if (x < 70 && z > openMaxZ) openMaxZ = z;
    if (x > 85 && x < 115 && z > blockedMaxZ) blockedMaxZ = z;
  }
  // 轨道在 z=+5.6，铺装向两侧各 1.1 m；压到建筑的一侧收窄到一半宽度。
  assert.ok(Math.abs(openMaxZ - 6.7) < 1e-6);
  assert.ok(blockedMaxZ < 6.5 && blockedMaxZ > 6.1);
  // 顶点色是浅暖灰（线性空间），明显比路面的 0x363a3c 亮。
  for (let i = 0; i < colors.length; i += 3) {
    assert.ok(colors[i] > 0.2 && colors[i] < 0.4);
    assert.ok(colors[i + 1] > 0.2 && colors[i + 1] < 0.4);
    assert.ok(colors[i + 2] > 0.17 && colors[i + 2] < 0.36);
    assert.ok(colors[i] > colors[i + 2], 'pavement tint should stay warm grey');
  }
  assert.ok(built.statistics.pavementClampedSamples > 0);
  assert.ok(built.statistics.pavementAreaM2 > 0);
});

test('walk tracks clip to the focus region instead of building whole roads', () => {
  const graph = straightGraph(2000);
  const built = buildWalkTracks(graph, { heightAt: flatHeight, pavement: false,
    bounds: { minX: 900, minZ: -300, maxX: 1100, maxZ: 300 } });
  assert.ok(built.tracks.length > 0);
  for (const track of built.tracks) {
    for (const point of track.points) assert.ok(point.x >= 900 - 1e-6 && point.x <= 1100 + 1e-6);
  }
});

test('sampleTrack interpolates position and direction along a track', () => {
  const built = buildWalkTracks(straightGraph(100), { heightAt: flatHeight, pavement: false });
  const track = built.tracks[0];
  const middle = sampleTrack(track, track.length / 2);
  assert.ok(Math.abs(middle.x - 50) < 1.5);
  assert.ok(Math.abs(middle.dz) < 1e-9);
  assert.ok(Math.abs(middle.dx) > 0.99);
  const start = sampleTrack(track, -10);
  assert.equal(start.x, track.points[0].x);
});

function makeFactory(graph, options = {}) {
  const stub = pedestrianStub;
  const rigStart = stub.rigs.length;
  const crowdStart = stub.crowds.length;
  const scene = sceneStub();
  const peds = createSzPedestrians(scene, graph, {
    heightAt: options.heightAt ?? (() => 0),
    colliders: [],
    maxPeds: 16,
    seed: 7,
    ...options
  });
  return { peds, scene, rigs: stub.rigs.slice(rigStart), crowd: stub.crowds[crowdStart], sceneStub: scene };
}

test('dead-end tracks make peds turn around instead of walking off the end or into the road', () => {
  const graph = straightGraph(60);
  const focus = { x: 30, y: 0, z: 0 };
  const scene = sceneStub();
  const peds = createSzPedestrians(scene, graph, {
    heightAt: flatHeight, colliders: [], maxPeds: 6, seed: 11,
    spawnMinM: 2, spawnMaxM: 25, regionRadiusM: 60, regionShiftM: 200
  });
  let flips = 0;
  const direction = new Map();
  for (let frame = 0; frame < 1500; frame++) {
    peds.update(0.05, focus, frame * 0.05);
    for (const ped of peds.peds) {
      if (!ped.placed) continue;
      if (direction.has(ped.id) && direction.get(ped.id) !== ped.dir) flips++;
      direction.set(ped.id, ped.dir);
      assert.ok(ped.x >= -0.05 && ped.x <= 60.05, 'peds stay on the dead-end track');
      assert.ok(Math.abs(ped.z) > 4.5 && Math.abs(ped.z) < 6.7);
    }
  }
  assert.ok(flips > 0, 'peds reverse at unconnected track ends');
  assert.equal(peds.statistics.tracks, 2);
  assert.equal(peds.statistics.connectors, 0);
});

test('factory keeps the crowd inside the spawn ring and recycles it past the recycle radius', () => {
  const graph = straightGraph(2000);
  const focus = { x: 1000, y: 0, z: 0 };
  const { peds, crowd } = makeFactory(graph);
  peds.update(0.016, focus, 0);
  assert.ok(peds.statistics.placed > 0);
  for (const ped of peds.peds) {
    if (!ped.placed) continue;
    const distance = Math.hypot(ped.x - focus.x, ped.z - focus.z);
    assert.ok(distance >= 20 - 1e-6 && distance <= 160 + 1e-6);
  }
  assert.ok(crowd.frames === 1);
  // 再向前跳 600 m：旧位置全部超回收半径，下一步应在新位置附近重新布置。
  peds.update(0.016, { x: 1600, y: 0, z: 0 }, 0.016);
  for (const ped of peds.peds) {
    if (!ped.placed) continue;
    assert.ok(Math.abs(ped.x - 1600) <= 160 + 2);
  }
  assert.ok(peds.statistics.recycled > 0);
  assert.ok(peds.statistics.regionBuilds >= 2);
});

test('walking rigs use heightAt for ground contact and only solve near the focus', () => {
  const graph = straightGraph(2000);
  const heightAt = (x, z) => 2 + x * 0.002 + z * 0.001;
  const focus = { x: 1000, y: 0, z: 0 };
  const { peds, rigs } = makeFactory(graph, { heightAt, maxPeds: 24 });
  for (let frame = 0; frame < 40; frame++) peds.update(0.016, focus, frame * 0.016);
  assert.ok(peds.statistics.near > 0);
  const nearSq = 130 ** 2;
  let checked = 0;
  for (const rig of rigs) {
    for (const call of rig.updates) {
      assert.equal(call.diveTime, -1);
      assert.equal(call.air, 0);
      const distanceSq = (call.x - focus.x) ** 2 + (call.z - focus.z) ** 2;
      assert.ok(distanceSq <= nearSq + 2, 'rigs are only solved inside the near radius');
      const ground = call.ground(call.owner, call.x, call.z);
      assert.ok(Math.abs(ground - (heightAt(call.x, call.z) + 0.03)) < 1e-9);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('visible gating drives the drawn count without dropping simulation', () => {
  const graph = straightGraph(2000);
  const focus = { x: 1000, y: 0, z: 0 };
  const { peds, crowd } = makeFactory(graph, { maxPeds: 24 });
  for (let frame = 0; frame < 20; frame++) peds.update(0.016, focus, frame * 0.016, () => false);
  assert.ok(peds.statistics.near > 0);
  assert.equal(peds.statistics.drawn, 0);
  assert.equal(crowd.added.length, 0);
  peds.update(0.016, focus, 1, () => true);
  assert.ok(peds.statistics.drawn > 0);
  assert.ok(crowd.added.length > 0);
  for (const { distance } of crowd.added) assert.ok(distance <= 130 + 1e-6);
});

test('same seed produces the same crowd and a different seed does not', () => {
  const graph = straightGraph(2000);
  const focus = { x: 1000, y: 0, z: 0 };
  const a = makeFactory(graph, { maxPeds: 12, seed: 42 });
  const b = makeFactory(graph, { maxPeds: 12, seed: 42 });
  const c = makeFactory(graph, { maxPeds: 12, seed: 43 });
  for (let frame = 0; frame < 25; frame++) {
    for (const factory of [a, b, c]) factory.peds.update(0.016, focus, frame * 0.016);
  }
  const position = (factory) => factory.peds.peds.map(ped => `${ped.x.toFixed(6)},${ped.z.toFixed(6)}`).join('|');
  assert.equal(position(a), position(b));
  assert.notEqual(position(a), position(c));
});

test('peds spawn away from the player and stop when the player is close', () => {
  const graph = straightGraph(2000);
  const focus = { x: 1000, y: 0, z: 0 };
  const player = { type: 'person', position: { x: 1000, y: 0, z: 0 } };
  const { peds } = makeFactory(graph, { maxPeds: 16 });
  for (let frame = 0; frame < 20; frame++) peds.update(0.016, focus, frame * 0.016, null, [player]);
  for (const ped of peds.peds) {
    if (!ped.placed) continue;
    assert.ok(Math.hypot(ped.x - player.position.x, ped.z - player.position.z) > 1.5);
  }
});

test('peds never stand inside building colliders and dispose releases the scene', () => {
  const graph = straightGraph(800);
  const building = collider(350, -9, 450, -3);
  const focus = { x: 400, y: 0, z: 0 };
  const scene = sceneStub();
  const peds = createSzPedestrians(scene, graph, { heightAt: flatHeight, colliders: [building], maxPeds: 20, seed: 5 });
  for (let frame = 0; frame < 80; frame++) peds.update(0.05, focus, frame * 0.05);
  assert.ok(peds.statistics.placed > 0);
  for (const ped of peds.peds) {
    if (!ped.placed) continue;
    assert.equal(ped.x > 350 + 0.2 && ped.x < 450 - 0.2 && ped.z > -9 && ped.z < -3, false);
  }
  peds.dispose();
  assert.equal(scene.objects.includes(peds.group), false);
});

test('factory validates its injected dependencies', () => {
  assert.throws(() => createSzPedestrians(null, straightGraph(), { heightAt: flatHeight, colliders: [] }));
  assert.throws(() => createSzPedestrians(sceneStub(), straightGraph(), { heightAt: flatHeight }));
  assert.throws(() => createSzPedestrians(sceneStub(), straightGraph(), { colliders: [] }));
  assert.throws(() => createSzPedestrians(sceneStub(), null, { heightAt: flatHeight, colliders: [] }));
  assert.throws(() => buildWalkTracks(straightGraph(), { heightAt: undefined }));
});
