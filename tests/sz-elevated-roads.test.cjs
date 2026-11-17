const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
} });
const groundSurface = loadModule(read('sz-ground-surface.js'));
const controllerSurfaces = loadModule(read('sz-controller-surfaces.js'));
const tslStub = { normalWorld: { mul: () => ({}) }, positionWorld: { add: () => ({}) } };
const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': tslStub,
  './sz-roads.js': roads,
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
  // 旧调用（不传 options）仍按三块立交统计归属，但选区不再由矩形决定。
  const unfiltered = elevated.planElevatedRoads(fixtureGraph(), surface);
  assert.equal(unfiltered.links.length, 5);
  assert.equal(unfiltered.interchanges.length, 3);
  assert.ok(unfiltered.links.every(link => link.interchangeId === 'generic'));
  assert.equal(unfiltered.statistics.generic, 5);
});

test('layer-zero bridges rise one layer only when they cross a ground road', () => {
  const plan = planFixture({ interchanges: [] });
  const links = byOsm(plan);
  const crossRoad = links.get('way/cross-road');
  const crossWater = links.get('way/cross-water');
  assert.equal(crossRoad.raisedForCrossing, true);
  assert.equal(crossRoad.effectiveLiftM, 4.8);
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
  assert.equal(ramp.aprons[0].lengthM, 40);
  assert.ok(ramp.aprons[0].grade <= MAX_GRADE + 1e-9);
  assert.ok(Math.abs(ramp.aprons[0].endY - FLAT_TERRAIN) < 1e-9);
  const crossing = links.get('way/cross-road');
  assert.deepEqual(Array.from(crossing.aprons, apron => apron.side), ['start', 'end']);
  for (const apron of crossing.aprons) {
    assert.equal(apron.lengthM, 40);
    assert.ok(Math.abs(apron.endY - FLAT_TERRAIN) < 1e-9);
  }
  assert.equal(plan.statistics.aprons, 3);
  assert.ok(Math.abs(plan.statistics.apronLengthM - 120) < 1e-9);
  assert.equal(plan.statistics.dangling, 0);
  for (const link of plan.links) assert.ok(link.topTriangles.length > 0);

  // 9.6 m 的落差在 40 m 限长内接不回地面：两端保持悬空，但不抛错、不接入车行。
  const steep = {
    nodes: [0, 0, 30, 0],
    names: ['dangle'],
    links: [[0, 1, 0, 8, 2, 0, []]],
    metadata: [{ osmId: 'way/dangle', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 }]
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
  return { Group: FakeGroup, Mesh: FakeMesh, BufferGeometry: FakeBufferGeometry,
    BufferAttribute: FakeBufferAttribute, MeshStandardNodeMaterial: FakeMaterial, DoubleSide: 2 };
}

test('built elevated roads expose meshes, contact surfaces and the same drivable decks', () => {
  const fake = fakeElevatedThree();
  const module = loadModule(read('sz-elevated-roads.js'), { imports: {
    'three/webgpu': fake, 'three/tsl': tslStub,
    './sz-roads.js': roads,
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
    assert.ok(mesh.geometry.attributes.position.array.length > 0);
  }
});

test('the real Shenzhen snapshot derives the whole-city deck network without any reviewed structures', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const plan = elevated.planElevatedRoads(geo.roadGraph, geo.terrainSurface, { interchanges: [] });
  assert.equal(plan.links.length, 1342);
  assert.equal(plan.statistics.skippedLinks, 0);
  assert.equal(plan.statistics.tunnelLinks, 202);
  assert.equal(plan.statistics.generic, 1342);
  assert.equal(plan.statistics.layerZero, 20);
  assert.equal(plan.statistics.layerZeroCrossings, 8);
  assert.equal(plan.statistics.sunkLinks, 28);
  assert.ok(plan.statistics.aprons >= 90, `aprons ${plan.statistics.aprons}`);
  assert.ok(plan.statistics.dangling >= 80, `dangling ${plan.statistics.dangling}`);
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
