const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const sectionFrame = require('./helpers/section-frame.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }, './sz-section-frame.js': sectionFrame
} });
const groundSurface = loadModule(read('sz-ground-surface.js'));
const controllerSurfaces = loadModule(read('sz-controller-surfaces.js'));
const tslStub = { normalWorld: { mul: () => ({}) }, positionWorld: { add: () => ({}) } };
const roadSection = loadModule(read('sz-road-section.js'));
const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
  './sz-road-profile.js': loadModule(read('sz-road-profile.js')),
  './sz-interchange-levels.js': loadModule(read('sz-interchange-levels.js')),
  'three/webgpu': {}, 'three/tsl': tslStub,
  './sz-roads.js': roads,
  './sz-road-section.js': roadSection,
  './sz-ground-surface.js': groundSurface,
  './sz-polygon.js': loadModule(read('sz-polygon.js')),
  './sz-controller-surfaces.js': controllerSurfaces
} });

const FLAT_TERRAIN = 10;
const MAX_GRADE = elevated.ELEVATED_DRIVE_MAX_GRADE;
// 1 km 见方的平地；所有夹具边都落在这块地形内。
const surface = {
  version: 1,
  chunkSize: 1000,
  diagonal: 'ne-sw',
  grid: { x0: 0, z0: 0, step: 1000, nx: 2, nz: 2 },
  chunks: [{
    id: '0,0',
    origin: [0, 0],
    positions: [0, FLAT_TERRAIN, 0, 1000, FLAT_TERRAIN, 0, 0, FLAT_TERRAIN, 1000, 1000, FLAT_TERRAIN, 1000],
    indices: [0, 1, 2, 1, 3, 2],
    cellRanges: [0, 0, 6],
    kinds: [0, 0, 0, 0]
  }]
};

// 夹具覆盖：地面主干、两条 layer=1 匝道、layer=0 跨路桥、layer=0 跨水桥、
// layer=-1 下沉边和一条隧道。地面边和隧道都不生成结构面。
function fixtureGraph() {
  return {
    nodes: [
      100, 100, 900, 100, 900, 300, 700, 300, 300, 500, 500, 500, 400, 400, 400, 600,
      100, 700, 300, 700, 600, 700, 800, 700, 100, 900, 300, 900
    ],
    names: ['trunk', 'ramp-a', 'ramp-b', 'cross-road', 'branch', 'cross-water', 'sunk', 'tunnel'],
    links: [
      [0, 1, 0, 8, 2, 0, []],
      [1, 2, 0, 7, 1, 0, []],
      [2, 3, 0, 7, 1, 0, []],
      [4, 5, 0, 8, 2, 0, []],
      [6, 7, 0, 6, 1, 0, []],
      [8, 9, 0, 8, 2, 0, []],
      [10, 11, 0, 8, 2, 0, []],
      [12, 13, 0, 8, 2, 0, []]
    ],
    metadata: [
      { osmId: 'way/trunk', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/ramp-a', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 },
      { osmId: 'way/ramp-b', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 },
      { osmId: 'way/cross-road', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 0 },
      { osmId: 'way/branch', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/cross-water', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 0 },
      { osmId: 'way/sunk', heightSource: 'unresolved', bridge: false, tunnel: false, layer: -1 },
      { osmId: 'way/tunnel', heightSource: 'unresolved', bridge: true, tunnel: true, layer: 2 }
    ]
  };
}

const planFixture = options => elevated.planElevatedRoads(fixtureGraph(), surface, options);
const byOsm = plan => new Map(plan.links.map(link => [link.osmId, link]));

test('every non-ground non-tunnel structure link gets a deck, with or without interchange rectangles', () => {
  const plan = planFixture({ interchanges: [] });
  assert.deepEqual(Array.from(plan.links, link => link.index), [1, 2, 3, 5, 6]);
  assert.equal(plan.statistics.links, 5);
  assert.equal(plan.statistics.generic, 5);
  assert.equal(plan.statistics.skippedLinks, 0);
  // 隧道只记数量，留给隧道模块；地面主干不摊桥面。
  assert.equal(plan.statistics.tunnelLinks, 1);
  assert.ok(plan.links.every(link => link.tunnel === false));
  assert.equal(plan.interchanges.length, 0);
  // 旧调用（不传 options）仍按配置立交统计归属，但选区不再由矩形决定。
  const unfiltered = elevated.planElevatedRoads(fixtureGraph(), surface);
  assert.equal(unfiltered.links.length, 5);
  assert.equal(unfiltered.interchanges.length, 4);
  assert.ok(unfiltered.links.every(link => link.interchangeId === 'generic'));
  assert.equal(unfiltered.statistics.generic, 5);
});

test('layer-zero bridges rise one layer only when they cross a ground road', () => {
  const plan = planFixture({ interchanges: [] });
  const links = byOsm(plan);
  const crossRoad = links.get('way/cross-road');
  const crossWater = links.get('way/cross-water');
  assert.equal(crossRoad.raisedForCrossing, true);
  // 4.8 m 按桥面顶计，梁厚从桥面向下。
  assert.ok(Math.abs(crossRoad.effectiveLiftM - 4.8) < 1e-9);
  assert.ok(Math.abs(crossRoad.startDeckY - (FLAT_TERRAIN + 4.8)) < 1e-9);
  assert.ok(Math.abs(crossRoad.endDeckY - (FLAT_TERRAIN + 4.8)) < 1e-9);
  // 跨水/涵洞桥没有地面道路相交，保持贴地。
  assert.equal(crossWater.raisedForCrossing, false);
  assert.equal(crossWater.effectiveLiftM, 0);
  assert.ok(Math.abs(crossWater.startDeckY - FLAT_TERRAIN) < 1e-9);
  assert.equal(crossWater.barriers.length, 0);
  assert.equal(crossWater.piers.length, 0);
  assert.equal(plan.driveLinks.includes(crossWater), false);
  assert.equal(plan.statistics.layerZero, 2);
  assert.equal(plan.statistics.layerZeroCrossings, 1);
});

test('unequal source layers share a 4.8 m deck seam on ordinary roads', () => {
  const graph = fixtureGraph();
  graph.metadata[1].layer = 3;
  const links = byOsm(elevated.planElevatedRoads(graph, surface, { interchanges: [] }));
  const a = links.get('way/ramp-a');
  const b = links.get('way/ramp-b');
  assert.equal(a.effectiveLiftM, 4.8);
  assert.equal(a.endDeckY, FLAT_TERRAIN + 4.8);
  assert.equal(a.endDeckY, b.startDeckY);
  assert.equal(a.connectedEnd && b.connectedStart, true);
});

test('sunk links stay at grade, keep a contact surface and follow the drive rules', () => {
  const plan = planFixture({ interchanges: [] });
  const sunk = byOsm(plan).get('way/sunk');
  assert.equal(sunk.layer, -1);
  assert.equal(sunk.effectiveLiftM, 0);
  assert.ok(Math.abs(sunk.startDeckY - FLAT_TERRAIN) < 1e-9);
  assert.ok(Math.abs(sunk.endDeckY - FLAT_TERRAIN) < 1e-9);
  assert.equal(sunk.contactSurface, true);
  assert.equal(sunk.barriers.length, 0);
  assert.equal(plan.statistics.sunkLinks, 1);
  assert.ok(plan.surfaces.some(item => item.id === sunk.surfaceId));
  // 纵坡为 0 且两端贴地，按规则可以车行，但不设护栏。
  assert.ok(plan.driveLinks.includes(sunk));
});

test('hanging ends get an adaptive apron, or are marked dangling without throwing', () => {
  const plan = planFixture({ interchanges: [] });
  const links = byOsm(plan);
  const ramp = links.get('way/ramp-b');
  assert.deepEqual(Array.from(ramp.aprons, apron => apron.side), ['end']);
  const rampLength = 4.8 / MAX_GRADE;
  assert.ok(Math.abs(ramp.aprons[0].lengthM - rampLength) < 1e-6);
  assert.ok(ramp.aprons[0].grade <= MAX_GRADE + 1e-9);
  assert.ok(Math.abs(ramp.aprons[0].endY - FLAT_TERRAIN) < 1e-9);
  const crossing = links.get('way/cross-road');
  assert.deepEqual(Array.from(crossing.aprons, apron => apron.side), ['start', 'end']);
  for (const apron of crossing.aprons) {
    assert.ok(Math.abs(apron.lengthM - rampLength) < 1e-6);
    assert.ok(Math.abs(apron.endY - FLAT_TERRAIN) < 1e-9);
  }
  assert.equal(plan.statistics.aprons, 3);
  assert.ok(Math.abs(plan.statistics.apronLengthM - 3 * rampLength) < 1e-6);
  assert.equal(plan.statistics.dangling, 0);
  // contactSurface=false 的贴地结构边没有接触面，但必须有独立的顶面标线三角面。
  for (const link of plan.links) assert.ok((link.topPaintTriangles?.length ?? 0) > 0);

  // 高层主线的 10.3 m 落差在 48 m 限长内接不回地面。
  const steep = {
    nodes: [0, 0, 30, 0],
    names: ['南坪快速'],
    links: [[0, 1, 0, 8, 2, 0, []]],
    metadata: [{ osmId: 'way/dangle', highway: 'trunk', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 }]
  };
  const dangling = elevated.planElevatedRoads(steep, surface, { interchanges: [] });
  assert.equal(dangling.links.length, 1);
  const [record] = dangling.links;
  assert.equal(record.dangling, true);
  assert.deepEqual(Array.from(record.danglingEnds), ['start', 'end']);
  assert.equal(record.aprons.length, 0);
  assert.equal(dangling.statistics.dangling, 1);
  assert.equal(dangling.driveLinks.length, 0);
  assert.ok(record.topTriangles.length > 0);
});

test('guardrails start only where the deck clears the street by more than 0.75 m', () => {
  const plan = planFixture({ interchanges: [] });
  const links = byOsm(plan);
  assert.ok(links.get('way/ramp-a').barriers.length > 0);
  assert.equal(links.get('way/cross-water').barriers.length, 0);
  assert.equal(links.get('way/sunk').barriers.length, 0);
  for (const link of plan.links) {
    assert.equal(link.barrierColliders.length, link.barriers.length);
    for (const collider of link.barrierColliders) {
      assert.equal(collider.type, 'elevated-barrier');
      assert.ok(collider.minY >= FLAT_TERRAIN + 0.75 - 1e-6,
        `${link.osmId} barrier starts at ${collider.minY}`);
      assert.ok(collider.maxY - collider.minY >= elevated.ELEVATED_BARRIER_HEIGHT_M - 1e-6);
      assert.equal(collider.polygon.outer.length, 4);
    }
  }
});

test('drive links are connected, non-tunnel, layered or raised and inside the grade cap', () => {
  const plan = planFixture({ interchanges: [] });
  assert.deepEqual(Array.from(plan.driveLinks, link => link.osmId).sort(),
    ['way/cross-road', 'way/ramp-a', 'way/ramp-b', 'way/sunk']);
  assert.equal(plan.statistics.driveLinks, 4);
  assert.equal(plan.statistics.nonDrivable, 1);
  assert.deepEqual(Array.from(plan.statistics.gradeConflicts), []);
  for (const link of plan.driveLinks) {
    assert.equal(link.tunnel, false);
    // layer=0 但跨路抬了一层的桥同样有真实层高，按抬升量而不是原始 layer 判定。
    assert.ok(link.layer !== 0 || link.effectiveLiftM > 0.05, `${link.osmId} has no layer and no lift`);
    assert.equal(link.dangling, false);
    assert.equal(link.connectedStart, true);
    assert.equal(link.connectedEnd, true);
    assert.notEqual(link.contactSurface, false);
    assert.ok(link.maxGrade <= MAX_GRADE + 1e-9, `${link.osmId} grade ${link.maxGrade}`);
    assert.ok(plan.links.includes(link));
  }
  // layer=0 的跨水桥贴地且与地面道路重复，不进车行网络，只保留接触面。
  assert.equal(plan.driveLinks.includes(byOsm(plan).get('way/cross-water')), false);
});

test('planned decks sample back to their own top triangles', () => {
  const plan = planFixture({ interchanges: [] });
  const heightAt = controllerSurfaces.createSurfaceHeightAt(plan.surfaces);
  assert.equal(plan.statistics.surfaces, plan.surfaces.length);
  for (const link of plan.links) {
    const item = plan.surfaces.find(surfaceItem => surfaceItem.id === link.surfaceId);
    assert.ok(item, `${link.osmId} has a contact surface`);
    assert.ok(item.triangles.length > 0);
    if (!plan.driveLinks.includes(link)) continue;
    for (const frame of [link.frames[1], link.frames[Math.floor(link.frames.length / 2)]]) {
      const height = heightAt(frame.x, frame.z, link.surfaceId);
      assert.ok(Number.isFinite(height), `${link.surfaceId} deck height`);
      assert.ok(Math.abs(height - frame.y) < 1e-6);
    }
    const middle = link.frames[Math.floor(link.frames.length / 2)];
    assert.equal(heightAt(middle.x + middle.nx * 20, middle.z + middle.nz * 20, link.surfaceId), null);
    assert.equal(heightAt(middle.x, middle.z, 'sz-elevated-road:9999'), null);
  }
});

test('G4 bridge uses a 4.8 m lift, with a flat deck and at-grade ramps', () => {
  const graph = fixtureGraph();
  graph.names[0] = '京港澳高速';
  for (const i of [0, 1, 2]) graph.metadata[i].highway = 'motorway';
  const plan = elevated.planElevatedRoads(graph, surface, { interchanges: [] });
  const [first, next] = [byOsm(plan).get('way/ramp-a'), byOsm(plan).get('way/ramp-b')];
  assert.equal(first.effectiveLiftM, 4.8);
  assert.equal(first.startDeckY, FLAT_TERRAIN);
  assert.equal(first.endDeckY, FLAT_TERRAIN + 4.8);
  assert.equal(next.startDeckY, first.endDeckY);
  assert.ok(first.frames.filter(f => f.d >= 40).every(f => f.y === FLAT_TERRAIN + 4.8));
  assert.ok(first.maxGrade <= MAX_GRADE + 1e-9);
  assert.ok(plan.driveLinks.includes(first));
  assert.equal(plan.links.some(link => link.index === 0), false);
});

test('chunks bucket every planned link into at most 64 two-kilometre grids', () => {
  const plan = planFixture({ interchanges: [] });
  assert.ok(plan.chunks.length >= 1 && plan.chunks.length <= 64);
  const covered = Array.from(plan.chunks.flatMap(chunk => chunk.linkIndices)).sort((a, b) => a - b);
  assert.deepEqual(covered, [1, 2, 3, 5, 6]);
  assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.triangles, 0), plan.statistics.triangles);
  for (const chunk of plan.chunks) {
    assert.match(chunk.id, /^shenzhen-elevated-roads:\d+$/);
    assert.equal(chunk.origin.length, 2);
    assert.equal(chunk.positions.length, chunk.triangles * 9);
    assert.ok(chunk.bounds.minX <= chunk.bounds.maxX);
    assert.ok(chunk.bounds.minZ <= chunk.bounds.maxZ);
  }
});

test('interchange rectangles only label decks and keep the first matching partition', () => {
  const area = { minX: 850, maxX: 950, minZ: 80, maxZ: 320 };
  const fixture = { id: 'fixture', name: '夹具立交', source: 'test fixture', area, heightSource: 'estimate' };
  const plan = planFixture({ interchanges: [fixture] });
  assert.equal(plan.interchanges.length, 1);
  assert.equal(plan.interchanges[0].links, 2);
  assert.deepEqual(Array.from(plan.interchanges[0].linkIndices), [1, 2]);
  assert.equal(plan.interchanges[0].driveLinks, 2);
  assert.equal(plan.statistics.generic, 3);
  for (const link of plan.links) {
    assert.equal(link.interchangeId, link.index === 1 || link.index === 2 ? 'fixture' : 'generic');
  }
  assert.deepEqual({ minX: plan.area.minX, maxX: plan.area.maxX, minZ: plan.area.minZ, maxZ: plan.area.maxZ }, area);

  // 两个分区完全覆盖同一段匝道时，按声明顺序归属第一个，绝不重复登记。
  const second = { ...fixture, id: 'second', name: '第二分区' };
  const overlapping = planFixture({ interchanges: [fixture, second] });
  const indices = overlapping.links.map(link => link.index);
  assert.equal(new Set(indices).size, indices.length, 'no deck is planned twice');
  assert.equal(overlapping.links.some(link => link.interchangeId === 'second'), false);
  assert.equal(overlapping.interchanges[1].links, 0);
});

test('interchange validation still requires estimates, unique ids and an array', () => {
  const area = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  const entry = { id: 'a', name: 'A', source: 'fixture', area, heightSource: 'estimate' };
  assert.equal(planFixture({ interchanges: [] }).interchanges.length, 0);
  assert.throws(() => planFixture({ interchanges: [{ ...entry, heightSource: 'measured' }] }), /estimate/);
  assert.throws(() => planFixture({ interchanges: [entry, { ...entry, name: 'B' }] }), /Duplicate interchange id/);
  assert.throws(() => planFixture({ interchanges: 'fixture' }), /array/i);
  assert.throws(() => planFixture({ interchanges: [{ ...entry, area: { minX: 1, maxX: 0, minZ: 0, maxZ: 1 } }] }),
    /Invalid elevated road area/);
});

// 假 THREE 只让 buildSzElevatedRoads 走完建场景流程；真实渲染几何由下面的真 THREE 测试覆盖。
function fakeElevatedThree() {
  class FakeBufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class FakeBufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    computeVertexNormals() {}
    computeBoundingBox() {}
    computeBoundingSphere() {}
    dispose() {}
  }
  class FakeGroup {
    constructor() { this.children = []; this.parent = null; }
    add(...objects) { for (const object of objects) { object.parent = this; this.children.push(object); } }
    remove(object) { this.children = this.children.filter(child => child !== object); object.parent = null; }
  }
  class FakeMaterial {
    constructor(options) { Object.assign(this, options); }
    dispose() {}
  }
  class FakeMesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.position = { set: () => {} };
      this.userData = {};
    }
  }
  class FakeColor {
    setHex(value) {
      this.r = (value >> 16) / 255;
      this.g = (value >> 8 & 255) / 255;
      this.b = (value & 255) / 255;
    }
  }
  return { Group: FakeGroup, Mesh: FakeMesh, BufferGeometry: FakeBufferGeometry,
    BufferAttribute: FakeBufferAttribute, MeshStandardNodeMaterial: FakeMaterial, Color: FakeColor, DoubleSide: 2 };
}

test('built elevated roads expose meshes, contact surfaces and the same drivable decks', () => {
  const fake = fakeElevatedThree();
  const module = loadModule(read('sz-elevated-roads.js'), { imports: {
    './sz-road-profile.js': loadModule(read('sz-road-profile.js')),
    './sz-interchange-levels.js': loadModule(read('sz-interchange-levels.js')),
    'three/webgpu': fake, 'three/tsl': tslStub,
    './sz-roads.js': roads,
    './sz-road-section.js': roadSection,
    './sz-ground-surface.js': groundSurface,
    './sz-polygon.js': loadModule(read('sz-polygon.js')),
    './sz-controller-surfaces.js': controllerSurfaces
  } });
  const scene = new fake.Group();
  const built = module.buildSzElevatedRoads(scene, {
    graph: fixtureGraph(), terrainSurface: surface, interchanges: []
  });
  assert.equal(built.group.children.length, built.meshes.length);
  assert.equal(built.meshes.length, 1);
  assert.equal(scene.children.includes(built.group), true);
  assert.equal(built.statistics.links, 5);
  assert.equal(built.surfaces.length, 5);
  assert.equal(built.colliders.length, built.statistics.colliders);
  assert.equal(built.interchanges.length, 0);
  assert.equal(built.drive.links.length, 4);
  assert.equal(built.drive.surfaces.length, 4);
  assert.equal(built.drive.statistics.links, 4);
  assert.equal(built.drive.statistics.surfaces, 4);
  assert.equal(built.drive.statistics.heightSource, 'rendered-top-triangles');
  const driveIds = new Set(built.drive.surfaces.map(item => item.id));
  for (const link of built.drive.links) assert.ok(driveIds.has(link.surfaceId));
  for (const link of built.drive.links) {
    const middle = link.frames[Math.floor(link.frames.length / 2)];
    const height = built.drive.heightAt(middle.x, middle.z, link.surfaceId);
    assert.ok(Number.isFinite(height));
    assert.ok(Math.abs(height - middle.y) < 1e-6);
  }
  assert.equal(built.drive.heightAt(500, 500, 'sz-elevated-road:9999'), null);
  assert.equal(typeof built.update, 'function');
  assert.equal(typeof built.dispose, 'function');
  for (const mesh of built.meshes) {
    assert.equal(mesh.material.side, 2);
    const { position, color } = mesh.geometry.attributes;
    assert.ok(position.array.length > 0);
    assert.equal(color.array.length, position.array.length);
    assert.ok(color.array.includes(165), 'concrete guardrail vertices are present');
    assert.ok(color.array.includes(59), 'asphalt deck vertices are present');
  }
});

test('the real Shenzhen snapshot derives the whole-city deck network without any reviewed structures', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const { applyCorridorRoadProfiles } = loadModule(read('sz-interchange-levels.js'));
  const graph = applyCorridorRoadProfiles(geo.roadGraph, geo.terrainSurface);
  const plan = elevated.planElevatedRoads(graph, geo.terrainSurface, { interchanges: [] });
  assert.equal(plan.statistics.skippedLinks, 0);
  assert.equal(plan.statistics.generic, plan.links.length);
  const g4 = plan.links.filter(deck => deck.highwayMainline);
  assert.equal(g4.length, 106);
  for (const deck of g4) {
    assert.equal(deck.effectiveLiftM, 4.8, deck.osmId);
    assert.ok(plan.driveLinks.includes(deck), deck.osmId);
    assert.equal(deck.aprons.length, 0, deck.osmId);
    assert.ok(deck.maxGrade <= 0.046, deck.osmId);
  }
  const high = plan.links.filter(deck => deck.effectiveLiftM > 4.8);
  assert.ok(high.some(deck => deck.name === '南坪快速'));
  assert.ok(high.some(deck => deck.name === '南光高速'));
  for (const deck of high) {
    assert.ok(deck.name === '南坪快速' || deck.name === '南光高速' || deck.osmId === 'way/1081087778', deck.osmId);
    assert.equal(deck.effectiveLiftM, deck.nanpingMainline ? 10 : 10.3, deck.osmId);
  }
  const nanping = high.filter(deck => deck.nanpingMainline);
  assert.equal(nanping.length, 85);
  const tanglang = new Map([
    ['way/221018208', [18, 42.3]], ['way/581971317', [42.3, 18]],
    ['way/227775714', [18, 39.5]], ['way/581971316', [39.5, 18]]
  ]);
  for (const deck of nanping) {
    const ends = tanglang.get(deck.osmId) ?? [18, 18];
    assert.deepEqual([deck.startDeckY, deck.endDeckY], ends, deck.osmId);
    if (!tanglang.has(deck.osmId)) assert.ok(deck.frames.every(frame => frame.y === 18), deck.osmId);
    assert.ok(plan.driveLinks.includes(deck), deck.osmId);
  }
  const rises = nanping.filter(deck => tanglang.has(deck.osmId));
  assert.equal(rises.length, 4);
  assert.ok(Math.max(...rises.flatMap(deck => deck.frames.map(frame => frame.y))) > 58.9);
  assert.ok(rises.every(deck => deck.maxGrade < 0.08));
  const nanpingOverG4 = nanping.filter(deck => ['way/963575158', 'way/963575161'].includes(deck.osmId));
  const g4UnderNanping = g4.filter(deck => ['way/227852267', 'way/687529427'].includes(deck.osmId));
  assert.equal(new Set(nanpingOverG4.map(deck => deck.osmId)).size, 2);
  assert.equal(new Set(g4UnderNanping.map(deck => deck.osmId)).size, 2);
  assert.ok(Math.min(...nanpingOverG4.flatMap(deck => deck.frames.map(frame => frame.y)))
    - Math.max(...g4UnderNanping.flatMap(deck => deck.frames.map(frame => frame.y))) >= 5);
  const splitLinks = plan.links.filter(link => link.splitStart || link.splitEnd);
  assert.ok(splitLinks.length > 0);
  const byIndex = new Map(plan.links.map(link => [link.index, link]));
  for (const link of splitLinks) {
    assert.ok(link.maxGrade <= MAX_GRADE + 1e-9, `${link.osmId} split grade ${link.maxGrade}`);
    for (const side of ['splitStart', 'splitEnd']) {
      const split = link[side];
      if (!split) continue;
      const peer = byIndex.get(split.joinIndex);
      assert.ok(peer, `${link.osmId} split peer ${split.joinIndex}`);
      const deck = link.frames[side === 'splitStart' ? 0 : link.frames.length - 1];
      const peerDeck = peer.frames[split.joinSide === 'start' ? 0 : peer.frames.length - 1];
      assert.ok(Math.hypot(deck.x - peerDeck.x, deck.z - peerDeck.z) <= 0.05, `${link.osmId} split xz`);
      assert.ok(Math.abs(deck.y - peerDeck.y) <= 0.05, `${link.osmId} split y`);
      assert.equal(split.joinSide === 'start' ? peer.connectedStart : peer.connectedEnd, true);
      assert.equal(split.joinSide === 'start' ? peer.noStartExtension : peer.noEndExtension, true);
    }
  }
  assert.ok(plan.chunks.length > 1 && plan.chunks.length <= 64);
  assert.equal(plan.statistics.surfaces, plan.surfaces.length);
  assert.ok(plan.surfaces.length >= 800 && plan.surfaces.length < plan.links.length);
  assert.ok(plan.driveLinks.length >= 600, `drive links ${plan.driveLinks.length}`);
  assert.equal(new Set(plan.surfaces.map(item => item.id)).size, plan.surfaces.length);
  assert.ok(plan.surfaces.every(item => item.triangles.length > 0));
  assert.ok(plan.driveLinks.every(link => link.maxGrade <= MAX_GRADE + 1e-9));
  // 两端都接地面的 layer>0 链路只保留显示几何，不登记独立接触面；
  // 其余链路必须有可采样的顶面三角面。
  assert.ok(plan.links.every(link => link.contactSurface === false || link.topTriangles.length > 0));
  assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.triangles, 0), plan.statistics.triangles);
  assert.ok(plan.statistics.deckLengthM > 250000);
  assert.ok(plan.statistics.triangles > 1000000);
});

test('piers stay off the carriageway of the ground road below', () => {
  const graph = {
    nodes: [0, 500, 1000, 500, 500, 300, 500, 700],
    names: ['ground', 'over'],
    links: [[0, 1, 0, 20, 2, 0, []], [2, 3, 0, 8, 1, 0, []]],
    metadata: [
      { osmId: 'way/ground', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/over', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 }
    ]
  };
  const plan = elevated.planElevatedRoads(graph, surface, { interchanges: [] });
  const bridge = plan.links.find(link => link.osmId === 'way/over');
  assert.ok(bridge.piers.length > 0, 'the overpass still gets piers away from the carriageway');
  const roadHalf = 20 / 2;
  for (const pier of bridge.piers) {
    assert.ok(Math.abs(pier.z - 500) > roadHalf + pier.half + 0.5 - 1e-6,
      `pier at z=${pier.z} sits on the ground carriageway`);
  }
});

test('a wide bridge with a blocked centerline keeps piers where its footprint clears the road and path', () => {
  const graph = {
    nodes: [100, 500, 900, 500],
    names: ['Bridge'],
    links: [[0, 1, 0, 13, 4, 1, []]],
    metadata: [{ osmId: 'way/wide', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 }]
  };
  const carriagewayOccupied = (_, z, radius) => Math.abs(z - 500) < 2.5 + radius;
  const pedestrianKeepout = (_, z, radius) => Math.abs(z - 506) < 0.8 + radius;
  const sidePierBlocked = (x, z, half) => x + half > 120 && x - half < 165 && z < 500;
  const plan = elevated.planElevatedRoads(graph, surface, { carriagewayOccupied, pedestrianKeepout, sidePierBlocked });
  const [bridge] = plan.links;
  const top = controllerSurfaces.createSurfaceHeightAt(plan.surfaces);
  assert.ok(bridge.piers.length > 20);
  for (const pier of bridge.piers) {
    const radius = pier.half * Math.SQRT2 + 0.5;
    assert.equal(carriagewayOccupied(pier.x, pier.z, radius), false);
    assert.equal(pedestrianKeepout(pier.x, pier.z, radius), false);
    assert.equal(sidePierBlocked(pier.x, pier.z, pier.half), false);
    for (const dx of [-pier.half, pier.half]) for (const dz of [-pier.half, pier.half]) {
      assert.ok(Number.isFinite(top(pier.x + dx, pier.z + dz, bridge.surfaceId)));
    }
  }
});


test('a named same-level continuation keeps a shared corner and tapers four lanes to one', () => {
  const graph = {
    nodes: [100, 100, 300, 100, 300, 300], names: ['Binhai Avenue'],
    links: [[0, 1, 0, 13, 4, 1, []], [1, 2, 0, 3.25, 1, 1, []]],
    metadata: ['way/wide', 'way/narrow'].map(osmId => ({ osmId, heightSource: 'unresolved', bridge: true,
      tunnel: false, layer: 1, highway: 'primary' }))
  };
  const plan = elevated.planElevatedRoads(graph, surface, { interchanges: [] });
  const [wide, narrow] = plan.links;
  const a = wide.frames.at(-1), b = narrow.frames[0];
  assert.deepEqual(a.left, b.left);
  assert.deepEqual(a.right, b.right);
  assert.equal(a.widthM, narrow.width);
  assert.equal(b.widthM, narrow.width);
  assert.equal(a.y, b.y);
  assert.ok(wide.noEndExtension && narrow.noStartExtension);
  assert.ok(wide.frames.at(-5).left.z < wide.frames.at(-1).left.z);
  assert.ok(wide.barriers.some(rail => rail.side === 'left' && rail.endD === wide.lengthM));
  assert.ok(narrow.barriers.some(rail => rail.side === 'left' && rail.startD === 0));
  const heightAt = controllerSurfaces.createSurfaceHeightAt(plan.surfaces);
  for (const point of [a, a.left, a.right]) {
    assert.equal(heightAt(point.x, point.z, wide.surfaceId), a.y);
    assert.equal(heightAt(point.x, point.z, narrow.surfaceId), b.y);
  }
});

test('urban interchange decks share one level across short source edges and restore the ground crossing', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { applyInterchangeLevels } = loadModule(read('sz-interchange-levels.js'));
  const terrain = raw.terrainSurface;
  const graph = applyInterchangeLevels(raw.roadGraph, terrain.interchangeLevels);
  const plan = elevated.planElevatedRoads(graph, terrain);
  const targetWays = new Set(['way/996625934', 'way/996625935', 'way/245389549', 'way/1050511757', 'way/40955120']);
  const deckRows = plan.links.filter(deck => targetWays.has(deck.osmId));
  assert.equal(deckRows.length, 12);
  for (const deck of deckRows) {
    assert.equal(deck.layer, 1);
    assert.equal(deck.effectiveLiftM, 4.8);
    assert.ok(plan.driveLinks.includes(deck), deck.osmId);
    assert.ok(deck.gradeProfile.maxGrade <= MAX_GRADE, deck.osmId);
    for (const seam of deck.gradeProfile.seams) {
      assert.equal(seam.status, 'aligned', deck.osmId);
      assert.ok(Math.abs(seam.deltaM) < 0.01, deck.osmId);
    }
  }
  const heightAt = controllerSurfaces.createSurfaceHeightAt(plan.surfaces);
  const eastApproach = plan.links.find(deck => deck.osmId === 'way/996625933');
  const eastSeam = deckRows.find(deck => deck.startNode === eastApproach.endNode);
  const [a, b] = eastSeam.frames;
  const t = 3 / Math.hypot(b.x - a.x, b.z - a.z);
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  assert.ok(Math.abs(heightAt(x, z, eastApproach.surfaceId) - heightAt(x, z, eastSeam.surfaceId)) < 0.02);
  const main = plan.links.find(deck => deck.osmId === 'way/96334028');
  assert.ok(main.frames.every(frame => Math.abs(frame.y - 12.8) < 0.01));

  const index = graph.metadata.findIndex(meta => meta.osmId === 'way/853206474');
  const crossing = graph.links[index];
  assert.ok(roads.isGroundRoad(graph.metadata[index]));
  assert.equal(raw.roadGraph.metadata[index].tunnel, true);
  assert.ok(!plan.links.some(deck => deck.index === index));
  const layout = roads.createRoadSurfaceLayout({ ...graph, links: [crossing], metadata: [graph.metadata[index]] }, terrain);
  const pavement = roads.createRoadHeightSampler(layout.chunks, terrain.grid);
  const [start, end] = roads.roadLinkPoints(graph, crossing);
  for (let i = 1; i < 20; i++) {
    const x = start.x + (end.x - start.x) * i / 20;
    const z = start.z + (end.z - start.z) * i / 20;
    assert.ok(Math.abs(pavement(x, z) - 8) < 0.01, `ground crossing at ${x},${z}`);
  }
});
