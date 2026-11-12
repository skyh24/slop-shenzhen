const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const zlib = require('node:zlib');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

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
const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
} });
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const tracks = loadModule(read('sz-pedestrian-tracks.js'), {
  imports: { './sz-roads.js': roads, './building-collision.js': collision }
});
const pedestrianStub = createPedestrianStub();
const pedestrians = loadModule(read('sz-pedestrians.js'), {
  imports: {
    'three/webgpu': three,
    './pedestrians.js': pedestrianStub.module,
    './sz-pedestrian-tracks.js': tracks,
    './sz-polygon.js': polygonModule
  }
});
const { buildSidewalkTracks, buildWalkTracks, connectTracks, createCarriagewayBarrier,
  createColliderGrid, sampleTrack } = tracks;
const { createSzPedestrians, createSzDensityModel } = pedestrians;

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

const groundSurface = loadModule(read('sz-ground-surface.js'));
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

// 一条东西向主路 + 一条南北向支路在 (150,0) 共点；支路可选架空（不作为车行道排斥面）。
function tJunctionGraph({ crossBridge = false, crossWidth = 30 } = {}) {
  const metadata = (width, bridge) => ({ osmId: `way/${width}/${bridge}`, heightSource: 'terrain',
    bridge, tunnel: false, layer: 0, highway: 'residential' });
  return {
    nodes: [0, 0, 150, 0, 300, 0, 150, 120, 150, -120],
    links: [[0, 1, 0, 8, 2, 1, []], [1, 2, 0, 8, 2, 1, []],
      [1, 4, 0, crossWidth, 2, 1, []], [1, 3, 0, crossWidth, 2, 1, []]],
    names: ['Main', 'Cross'],
    nodeIds: ['node/1', 'node/2', 'node/3', 'node/4', 'node/5'],
    metadata: [metadata(8, false), metadata(8, false), metadata(crossWidth, crossBridge),
      metadata(crossWidth, crossBridge)]
  };
}

function assertLegsOutsideBarrier(legs, barrier, { margin = 0.05, step = 0.5 } = {}) {
  const scratch = {};
  let samples = 0;
  for (const leg of legs) {
    for (let s = 0; s <= leg.length; s += step) {
      sampleTrack(leg, s, scratch);
      assert.equal(barrier.contains(scratch.x, scratch.z, margin), false,
        `${leg.id} sample ${scratch.x.toFixed(2)},${scratch.z.toFixed(2)} is on the carriageway`);
      samples++;
    }
  }
  return samples;
}

function assertPavementOutsideBarrier(pavement, barrier, margin = 0) {
  const positions = pavement.positions;
  let vertices = 0;
  for (let i = 0; i < positions.length; i += 3) {
    assert.equal(barrier.contains(positions[i], positions[i + 2], margin), false,
      `pavement vertex ${positions[i].toFixed(2)},${positions[i + 2].toFixed(2)} is on the carriageway`);
    vertices++;
  }
  return vertices;
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

test('a raised source sidewalk carries the walk track without drawing a second pavement', () => {
  const graph = straightGraph(100, 10);
  graph.metadata[0].highway = 'trunk';
  const heightAt = (_, z) => z <= -6.5 && z >= -6.9 ? 0.12 : 0;
  const result = buildWalkTracks(graph, { heightAt, groundHeight: () => 0 });
  assert.equal(result.tracks.length, 1);
  assert.ok(result.tracks[0].points.every(point => point.y === 0.12));
  assert.equal(result.pavement.statistics.triangles, 0);
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

test('carriageway barrier is the rendered road geometry plus a positive margin', () => {
  const graph = straightGraph(300, 8);
  const barrier = createCarriagewayBarrier(graph, { bounds: null });
  assert.equal(barrier.polygons, 1);
  assert.equal(barrier.contains(150, 0, 0), true);
  assert.equal(barrier.contains(150, 4.1, 0), false);
  assert.equal(barrier.contains(150, 4.1, 0.3), true);
  const junction = createCarriagewayBarrier(tJunctionGraph(), { bounds: null });
  // 共用 OSM 节点的路口补面与两条路的断面都来自和路面网格相同的几何。
  assert.equal(junction.contains(150, 0, 0), true);
  assert.equal(junction.contains(150.8, 0.8, 0), true);
  assert.equal(junction.contains(150, 40, 0), true);
  assert.equal(junction.contains(150, -40, 0), true);
  assert.equal(junction.contains(115, 0, 0), true);
  assert.equal(junction.contains(120, 12, 0), false);
});

test('walk tracks are split mid-line where a junction reaches the walking band', () => {
  const graph = tJunctionGraph();
  const ground = buildWalkTracks(graph, { heightAt: flatHeight, pavement: false });
  const bridge = buildWalkTracks(tJunctionGraph({ crossBridge: true }), { heightAt: flatHeight, pavement: false });
  const barrier = createCarriagewayBarrier(graph, { bounds: null });
  assertLegsOutsideBarrier(ground.legs, barrier);
  // 架空支路不算地面车行道：主路轨道完整，数量更少。
  assert.ok(ground.tracks.length > bridge.tracks.length);
  assert.equal(bridge.tracks.length, 4);
  const mainTracks = ground.tracks.filter(track => track.widthM === 8 && track.side === 1);
  assert.ok(mainTracks.length >= 2);
  const intervals = mainTracks.map(track => [Math.min(track.points[0].x, track.points.at(-1).x),
    Math.max(track.points[0].x, track.points.at(-1).x)]);
  assert.ok(intervals.some(([, end]) => end < 140), 'main track stops before the cross carriageway');
  assert.ok(intervals.some(([start]) => start > 160), 'main track resumes after the cross carriageway');
});

test('pavement ribbons stay outside the carriageway at a junction', () => {
  const graph = tJunctionGraph();
  const built = buildWalkTracks(graph, { heightAt: flatHeight, pavement: true });
  const barrier = createCarriagewayBarrier(graph, { bounds: null });
  assert.ok(built.pavement.statistics.triangles > 0);
  assertPavementOutsideBarrier(built.pavement, barrier);
});

test('real city invariant: tracks and pavement never enter the rendered carriageway', () => {
  const raw = JSON.parse(zlib.gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const graph = raw.roadGraph;
  const heightAt = groundSurface.createGroundSurfaceSampler(raw.terrainSurface);
  const centers = [[1180, -560], [-700, 800], [0, 1400]];
  let trackSamples = 0;
  let pavementVertices = 0;
  let asphaltSamples = 0;
  let pavementSkipped = 0;
  for (const [centerX, centerZ] of centers) {
    const bounds = { minX: centerX - 260, minZ: centerZ - 260, maxX: centerX + 260, maxZ: centerZ + 260 };
    const built = buildWalkTracks(graph, { heightAt, colliders: [], bounds, pavement: true });
    assert.ok(built.tracks.length > 20, 'real region should keep enough walkable tracks');
    const barrier = createCarriagewayBarrier(graph, { bounds });
    // 1) 轨道（含转角连接）每个 0.5 m 采样点都在沥青外，且留 5 cm 正余量。
    trackSamples += assertLegsOutsideBarrier(built.legs, barrier, { margin: 0.05, step: 0.5 });
    // 2) 铺装顶点不得落在沥青上。
    pavementVertices += assertPavementOutsideBarrier(built.pavement, barrier);
    // 3) 反向检查：所有地面道路中心线和共用节点必须在排斥面内，证明排斥面没有漏洞。
    for (let index = 0; index < graph.links.length; index++) {
      const metadata = graph.metadata[index];
      if (!(metadata.heightSource === 'terrain' && !metadata.bridge && !metadata.tunnel && !metadata.layer)) continue;
      const link = graph.links[index];
      const points = roads.roadLinkPoints(graph, link);
      let near = false;
      for (const point of points) {
        if (point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ) near = true;
      }
      if (!near) continue;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(length / 5));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
          assert.equal(barrier.contains(x, z, 0), true, `asphalt sample ${x.toFixed(2)},${z.toFixed(2)} missing from barrier`);
          asphaltSamples++;
        }
      }
    }
    const groundNodes = new Set();
    for (let index = 0; index < graph.links.length; index++) {
      const metadata = graph.metadata[index];
      if (!(metadata.heightSource === 'terrain' && !metadata.bridge && !metadata.tunnel && !metadata.layer)) continue;
      const link = graph.links[index];
      groundNodes.add(link[0]);
      groundNodes.add(link[1]);
    }
    for (const node of groundNodes) {
      const x = graph.nodes[node * 2];
      const z = graph.nodes[node * 2 + 1];
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
      assert.equal(barrier.contains(x, z, 0.05), true, `shared ground node ${x},${z} missing from barrier`);
      asphaltSamples++;
    }
    pavementSkipped += built.statistics.pavementCarriagewaySkipped;
  }
  assert.ok(trackSamples > 15000);
  assert.ok(pavementVertices > 5000);
  assert.ok(asphaltSamples > 2000);
  assert.ok(pavementSkipped > 0, 'real junctions must skip some pavement quads that reach the asphalt');
});

test('density proxy rises with building coverage and drops inside green areas', () => {
  const packed = [];
  for (let x = 0; x < 100; x += 20) for (let z = 0; z < 100; z += 20) packed.push(collider(x, z, x + 18, z + 18));
  const model = createSzDensityModel({ colliders: packed, greenAreas: [] });
  const empty = createSzDensityModel({ colliders: [] });
  assert.ok(model.coverageAt(50, 50) > 0.5);
  assert.equal(empty.coverageAt(50, 50), 0);
  assert.ok(model.densityAt(50, 50) > empty.densityAt(50, 50));
  assert.ok(empty.densityAt(500, 500) > 0.1, 'valid sidewalk never has zero density');
  assert.equal(model.greenAt(500, 500), 'none');
  const green = createSzDensityModel({ colliders: packed,
    greenAreas: [{ outer: [{ x: -50, z: -50 }, { x: 150, z: -50 }, { x: 150, z: 150 }, { x: -50, z: 150 }], holes: [] }] });
  assert.equal(green.greenAt(50, 50), 'green');
  assert.ok(green.densityAt(50, 50) < model.densityAt(50, 50));
});

test('factory target crowd size follows local density: dense blocks vs park green', () => {
  const graph = straightGraph(2000);
  const blocks = [];
  for (let x = 760; x < 1240; x += 40) {
    for (const z of [-45, -20, 20, 45]) blocks.push(collider(x, z, x + 34, z + 20));
  }
  const greenAreas = [{ outer: [{ x: 1440, z: -160 }, { x: 1760, z: -160 }, { x: 1760, z: 160 }, { x: 1440, z: 160 }],
    holes: [] }];
  const peds = createSzPedestrians(sceneStub(), graph, {
    heightAt: flatHeight, colliders: blocks, greenAreas, maxPeds: 140, seed: 3
  });
  const denseFocus = { x: 1000, y: 0, z: 0 };
  for (let frame = 0; frame < 80; frame++) peds.update(0.05, denseFocus, frame * 0.05);
  const denseTarget = peds.statistics.targetPeds;
  const densePlaced = peds.statistics.placed;
  assert.ok(denseTarget > 80, `dense target ${denseTarget} should be high`);
  assert.ok(densePlaced > 60, `dense region should fill a crowd (${densePlaced})`);
  const parkFocus = { x: 1600, y: 0, z: 0 };
  for (let frame = 0; frame < 80; frame++) peds.update(0.05, parkFocus, (80 + frame) * 0.05);
  const parkTarget = peds.statistics.targetPeds;
  assert.ok(parkTarget >= 40, 'valid sidewalk in a park still keeps the minimum crowd');
  assert.ok(parkTarget < denseTarget - 20, `park target ${parkTarget} should be clearly sparser than ${denseTarget}`);
  assert.ok(peds.statistics.placed <= parkTarget + 10);
  assert.ok(peds.statistics.placed > 0);
});
