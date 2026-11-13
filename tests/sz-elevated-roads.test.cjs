const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
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

const AREA = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
const FLAT_TERRAIN = 10;
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

function fixture() {
  return {
    nodes: [100, 100, 500, 100, 100, 300, 500, 300, 100, 700, 500, 700, 2000, 2000, 2100, 2100, 100, 900, 400, 900],
    names: ['Ground', 'Branch', 'Ramp', 'Bridge', 'Outside', 'Layer only'],
    links: [
      [0, 1, 0, 8, 2, 0, []],
      [0, 2, 1, 6, 1, 0, []],
      [0, 1, 2, 8, 2, 0, []],
      [2, 3, 2, 8, 2, 0, []],
      [4, 5, 3, 10, 2, 0, []],
      [6, 7, 4, 8, 2, 0, []],
      [8, 9, 5, 6, 1, 0, []]
    ],
    metadata: [
      { osmId: 'way/1', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/2', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/3', heightSource: 'terrain', bridge: true, tunnel: false, layer: 2 },
      { osmId: 'way/4', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 },
      { osmId: 'way/5', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 },
      { osmId: 'way/6', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 },
      { osmId: 'way/7', heightSource: 'unresolved', bridge: false, tunnel: false, layer: 1 }
    ]
  };
}

function plan(graph = fixture()) {
  return elevated.planElevatedRoads(graph, surface, AREA);
}

test('elevated road planning is deterministic and ordered by source link index', () => {
  const first = plan();
  const second = plan();
  assert.deepEqual(first, second);
  assert.deepEqual(Array.from(first.links, link => link.index), [3, 4, 6]);
  assert.deepEqual(Array.from(first.surfaces, item => item.id), ['sz-elevated-road:3', 'sz-elevated-road:4', 'sz-elevated-road:6']);
  assert.equal(new Set(first.surfaces.map(item => item.id)).size, first.surfaces.length);
});

test('deck heights interpolate from a ground ramp abutment to the layer estimate', () => {
  const result = plan();
  const ramp = result.links.find(link => link.index === 3);
  assert.equal(ramp.sharedStart, true);
  assert.equal(ramp.sharedEnd, false);
  assert.ok(Math.abs(ramp.startDeckY - FLAT_TERRAIN) <= 0.6);
  assert.ok(ramp.endDeckY > ramp.startDeckY + 4);
  assert.ok(Math.abs(ramp.startDeckY - ramp.startGroundHeight) <= 0.6);
  for (let i = 1; i < ramp.frames.length; i++) {
    const rise = ramp.frames[i].y - ramp.frames[i - 1].y;
    assert.ok(rise >= -1e-6, 'ramp uses no descending steps');
  }
});

test('fully elevated decks stay above terrain and girder tops use walkable upward faces', () => {
  const result = plan();
  const bridge = result.links.find(link => link.index === 4);
  assert.equal(bridge.sharedStart, false);
  assert.equal(bridge.sharedEnd, false);
  assert.ok(Math.min(...bridge.topTriangles.flat(2).filter((_, index) => index % 3 === 1).map(point => point.y)) > FLAT_TERRAIN + 4.8 - 1e-6);
  for (const item of result.surfaces) {
    assert.equal(item.heightSource, 'estimate');
    assert.ok(item.triangles.length > 0);
    for (const triangle of item.triangles) {
      assert.equal(triangle.length, 3);
      const [a, b, c] = triangle;
      assert.ok([a, b, c].every(point => [point.x, point.y, point.z].every(Number.isFinite)));
      assert.ok(a.y >= FLAT_TERRAIN - 1e-6 && b.y >= FLAT_TERRAIN - 1e-6 && c.y >= FLAT_TERRAIN - 1e-6);
      const upward = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      assert.ok(upward > 0, 'top face normal points up');
    }
  }
});

test('elevated top triangles load into the controller surface resolver', () => {
  const controller = loadModule(read('sz-controller-surfaces.js'));
  const result = plan();
  const bridge = result.links.find(link => link.index === 4);
  const frame = bridge.frames[Math.floor(bridge.frames.length / 2)];
  const resolver = controller.createSurfaceResolver({ groundHeight: () => FLAT_TERRAIN, surfaces: result.surfaces });
  const deck = resolver.at(frame.x, frame.z).find(candidate => candidate.surfaceId === bridge.surfaceId);
  assert.ok(deck);
  assert.equal(deck.heightSource, 'estimate');
  assert.ok(Math.abs(deck.height - frame.y) < 1e-6);
});

test('plan statistics expose estimated provenance, deck area, piers and limitations', () => {
  const result = plan();
  const statistics = result.statistics;
  assert.equal(statistics.links, 3);
  assert.equal(statistics.surfaces, result.surfaces.length);
  assert.equal(statistics.surfaces, 3);
  assert.equal(statistics.links, statistics.surfaces);
  assert.equal(statistics.deckLengthM, 1100);
  // 端部 4 m 重叠平段让桥面面积略大于纯长度×宽度；这里只锁数量级与 compose 关系。
  assert.ok(statistics.areaM2 > 9000 && statistics.areaM2 < 11000, `deck area ${statistics.areaM2}`);
  assert.equal(statistics.heightSource, 'estimate');
  assert.ok(statistics.triangles > 0);
  assert.equal(statistics.triangles, result.links.reduce((sum, link) => sum + link.geometry.length / 9, 0));
  assert.equal(statistics.piers, result.links.reduce((sum, link) => sum + link.piers.length, 0));
  assert.ok(statistics.piers > 0);
  assert.ok(statistics.maxDeckHeightM >= 4.8);
  assert.equal(statistics.groundDuplicates, 1);
  assert.equal(statistics.skippedLinks, 0);
  assert.ok(statistics.limitations.some(text => /估算/.test(text)));
  assert.ok(statistics.limitations.some(text => /纵断面/.test(text)));
  assert.equal(result.links.some(link => link.index === 5), false, 'links outside the area are not planned');
});

test('real THREE build creates at most twelve chunk meshes and a walkable deck top',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const realRoads = loadModule(read('sz-roads.js'), { imports: {
      'three/webgpu': THREE, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
    } });
    const module = loadModule(read('sz-elevated-roads.js'), { imports: {
      'three/webgpu': THREE,
      'three/tsl': await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.tsl.js'))),
      './sz-roads.js': realRoads,
      './sz-ground-surface.js': groundSurface,
      './sz-polygon.js': loadModule(read('sz-polygon.js')),
      './sz-controller-surfaces.js': controllerSurfaces
    } });
    const scene = new THREE.Scene();
    const built = module.buildSzElevatedRoads(scene, { graph: fixture(), terrainSurface: surface, area: AREA });
    assert.equal(built.group.parent, scene);
    assert.ok(built.group.children.length > 0 && built.group.children.length <= 12);
    assert.equal(built.surfaces.length, 3);
    assert.equal(built.links.length, 3);
    for (const mesh of built.group.children) {
      assert.equal(mesh.material.type, 'MeshStandardNodeMaterial');
      assert.equal(mesh.material.polygonOffset, true);
      assert.equal(mesh.geometry.attributes.position.array.length % 9, 0);
      assert.ok(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite));
    }
    scene.updateMatrixWorld(true);
    const bridge = built.links.find(link => link.index === 4);
    const frame = bridge.frames[Math.floor(bridge.frames.length / 2)];
    const raycaster = new THREE.Raycaster(new THREE.Vector3(frame.x, 100, frame.z), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(built.group.children)[0];
    assert.ok(hit, 'deck is visible from above');
    assert.ok(Math.abs(hit.point.y - frame.y) < 1e-3);
    assert.ok(hit.face.normal.y > 0.99);
    assert.equal(built.statistics.links, 3);
    built.update();
    built.dispose();
    assert.equal(built.group.parent, null);
    assert.equal(scene.children.length, 0);
  });

function connectorFixture() {
  const graph = fixture();
  graph.nodes.push(700, 300);
  graph.links.push([3, 10, 2, 8, 2, 0, []]);
  graph.metadata.push({ osmId: 'way/8', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 });
  return graph;
}

test('links with different layer estimates get a connector ramp at the shared node', () => {
  const result = plan(connectorFixture());
  assert.ok(result.statistics.connectors >= 1, 'connector ramp exists');
  const ramp = result.surfaces.find(surface => surface.id.startsWith('sz-elevated-ramp:'));
  assert.ok(ramp, 'ramp has a walkable surface');
  const ys = ramp.triangles.flat().map(point => point.y);
  assert.ok(ys.every(Number.isFinite));
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.6, 'ramp actually bridges the layer height difference');
  const resolver = loadModule(read('sz-controller-surfaces.js')).createSurfaceResolver({
    groundHeight: () => FLAT_TERRAIN, surfaces: result.surfaces
  });
  const heights = resolver.at(700 - 1, 300);
  assert.ok(heights.length >= 1);
});

// 车行链路夹具：在基础夹具上补一条陡坡、一条隧道和一条 layer 0 桥，用来验证 driveLinks 的筛选条件。
// 陡坡从共享地面节点起步（起点落地），60 m 内升到 layer2 的 9.6 m，派生纵坡约 16% 超过 12% 上限。
function driveFixture() {
  const graph = fixture();
  graph.nodes.push(160, 100, 700, 500, 760, 500, 800, 700, 860, 700);
  graph.links.push(
    [0, 10, 0, 8, 2, 0, []],
    [11, 12, 0, 8, 2, 0, []],
    [13, 14, 0, 8, 2, 0, []]
  );
  graph.metadata.push(
    { osmId: 'way/9', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 2 },
    { osmId: 'way/10', heightSource: 'unresolved', bridge: true, tunnel: true, layer: 2 },
    { osmId: 'way/11', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 0 }
  );
  return graph;
}

test('elevated planning exposes only drivable drive links with a derived max grade', () => {
  assert.equal(elevated.ELEVATED_DRIVE_MAX_GRADE, 0.12);
  const result = elevated.planElevatedRoads(driveFixture(), surface, AREA);
  assert.deepEqual(Array.from(result.links, link => link.index), [3, 4, 6, 7, 9]);
  // 隧道链路不摊成桥面，由隧道模块建洞身；这里只记数量。
  assert.equal(result.statistics.tunnelLinks, 1);
  assert.ok(result.links.every(link => link.tunnel === false));
  assert.deepEqual(Array.from(result.driveLinks, link => link.index), [3, 4, 6]);
  assert.ok(result.driveLinks.every(link => result.links.includes(link)), 'drive links reuse the planned record objects');
  for (const link of result.links) {
    assert.ok(Number.isFinite(link.maxGrade));
    assert.ok(Math.abs(link.maxGrade - Math.abs(link.endDeckY - link.startDeckY) / link.lengthM) < 1e-12);
  }
  const steep = result.links.find(link => link.index === 7);
  assert.ok(steep.maxGrade > elevated.ELEVATED_DRIVE_MAX_GRADE, `steep grade ${steep.maxGrade}`);
  assert.equal(result.driveLinks.includes(steep), false, 'grades above the cap stay out of the drive network');
  const layerZero = result.links.find(link => link.index === 9);
  assert.equal(layerZero.layer, 0);
  assert.equal(result.driveLinks.includes(layerZero), false, 'layer 0 bridges are not drivable decks');
  for (const link of result.driveLinks) {
    assert.equal(link.tunnel, false);
    assert.ok(link.layer > 0);
    assert.ok(link.maxGrade <= elevated.ELEVATED_DRIVE_MAX_GRADE);
  }
});

test('drive statistics count the filtered links and their planned deck length', () => {
  const result = elevated.planElevatedRoads(driveFixture(), surface, AREA);
  const statistics = result.statistics;
  assert.equal(statistics.driveLinks, result.driveLinks.length);
  assert.equal(statistics.driveLinks, 3);
  assert.equal(statistics.driveDeckLengthM, result.driveLinks.reduce((sum, link) => sum + link.lengthM, 0));
  assert.equal(statistics.driveDeckLengthM, 1100);
  assert.ok(statistics.limitations.some(text => /12%/.test(text)), 'limitations record the drive grade cap');
});

// 假 THREE 只负责让 buildSzElevatedRoads 走完建场景的流程；真实渲染几何由下面 skip 门的真 THREE 测试覆盖。
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

test('built elevated roads expose drive surfaces and a deck height sampler on the same triangles', () => {
  const fake = fakeElevatedThree();
  const module = loadModule(read('sz-elevated-roads.js'), { imports: {
    'three/webgpu': fake, 'three/tsl': tslStub,
    './sz-roads.js': roads,
    './sz-ground-surface.js': groundSurface,
    './sz-polygon.js': loadModule(read('sz-polygon.js')),
    './sz-controller-surfaces.js': controllerSurfaces
  } });
  const built = module.buildSzElevatedRoads(new fake.Group(), { graph: driveFixture(), terrainSurface: surface, area: AREA });
  const drive = built.drive;
  assert.ok(drive, 'build result carries a drive network');
  assert.deepEqual(Array.from(drive.links, link => link.index), [3, 4, 6]);
  assert.equal(drive.statistics.links, drive.links.length);
  assert.equal(drive.statistics.surfaces, drive.links.length);
  assert.equal(drive.statistics.deckLengthM, drive.links.reduce((sum, link) => sum + link.lengthM, 0));
  assert.equal(drive.statistics.heightSource, 'rendered-top-triangles');
  assert.deepEqual(Array.from(drive.surfaces, item => item.id), Array.from(drive.links, link => link.surfaceId));
  const rendered = new Map(built.surfaces.map(item => [item.id, item]));
  for (const item of drive.surfaces) {
    assert.equal(item, rendered.get(item.id), 'drive surfaces are the rendered deck surfaces');
    assert.ok(item.triangles.length > 0);
  }
  // layer 0 桥和陡坡的渲染表面存在，但不进入车行采样器；隧道交给隧道模块，不在这里出现。
  const excluded = built.surfaces.filter(item => ['sz-elevated-road:7', 'sz-elevated-road:9']
    .includes(item.id));
  assert.equal(excluded.length, 2);
  for (const item of excluded) {
    const [point] = item.triangles[0];
    assert.equal(drive.heightAt(point.x, point.z, item.id), null, `${item.id} is not drivable`);
  }
  for (const link of drive.links) {
    const middle = link.frames[Math.floor(link.frames.length / 2)];
    for (const frame of [link.frames[1], middle]) {
      const height = drive.heightAt(frame.x, frame.z, link.surfaceId);
      assert.ok(Number.isFinite(height), `deck height at ${link.surfaceId}`);
      assert.ok(Math.abs(height - frame.y) < 1e-6, `${link.surfaceId} deck height matches the planned frame`);
    }
    assert.equal(drive.heightAt(middle.x, middle.z + 20, link.surfaceId), null, 'off-deck points have no deck height');
    assert.equal(drive.heightAt(middle.x, middle.z, 'sz-elevated-road:9999'), null, 'unknown surfaces have no deck height');
  }
});

const FIXTURE_INTERCHANGES = [{
  id: 'fixture', name: '夹具立交', source: 'test fixture graph',
  area: AREA, heightSource: 'estimate'
}];
const planOver = (graph, interchanges = FIXTURE_INTERCHANGES) =>
  elevated.planElevatedRoads(graph, surface, { interchanges });

test('interchange partitions label every planned deck with its OSM source and keep heights estimated', () => {
  const result = planOver(driveFixture());
  assert.equal(result.heightSource, 'estimate');
  assert.equal(result.interchanges.length, 1);
  const [partition] = result.interchanges;
  assert.equal(partition.id, 'fixture');
  assert.equal(partition.name, '夹具立交');
  assert.equal(partition.source, 'test fixture graph');
  assert.equal(partition.heightSource, 'estimate');
  assert.equal(partition.links, result.links.length);
  assert.deepEqual(Array.from(result.interchanges[0].linkIndices), Array.from(result.links, link => link.index));
  for (const link of result.links) {
    assert.equal(link.interchangeId, 'fixture');
    assert.ok(Number.isFinite(link.barrierLengthM));
  }
  assert.deepEqual({ minX: result.area.minX, maxX: result.area.maxX, minZ: result.area.minZ, maxZ: result.area.maxZ }, AREA);
  assert.equal(result.statistics.interchanges.length, 1);
  assert.equal(result.statistics.heightSource, 'estimate');
  assert.ok(elevated.SHENZHEN_INTERCHANGES.every(entry => entry.heightSource === 'estimate'));
  assert.throws(() => elevated.planElevatedRoads(fixture(), surface, { interchanges: [] }), /interchange/i);
  assert.throws(() => elevated.planElevatedRoads(fixture(), surface, { interchanges: [
    { id: 'a', name: 'A', source: 's', area: AREA, heightSource: 'measured' }
  ] }), /estimate/);
  assert.throws(() => elevated.planElevatedRoads(fixture(), surface, { interchanges: [
    { id: 'a', name: 'A', source: 's', area: AREA, heightSource: 'estimate' },
    { id: 'a', name: 'B', source: 's', area: AREA, heightSource: 'estimate' }
  ] }), /Duplicate interchange id/);
});

test('overlapping interchange areas plan a shared deck once and attribute it to the first area', () => {
  const overlapping = [
    { id: 'first', name: '第一分区', source: 'fixture', area: AREA, heightSource: 'estimate' },
    { id: 'second', name: '第二分区', source: 'fixture', area: { minX: 0, maxX: 900, minZ: 0, maxZ: 900 }, heightSource: 'estimate' }
  ];
  const result = planOver(driveFixture(), overlapping);
  const indices = result.links.map(link => link.index);
  assert.equal(new Set(indices).size, indices.length, 'no deck is planned twice');
  assert.equal(result.links.some(link => link.interchangeId === 'second'), false);
  assert.equal(result.interchanges[1].links, 0);
  assert.equal(result.statistics.links, result.links.length);
});

test('guardrails appear where the deck leaves the ground and the contact wall shares its vertices', () => {
  const result = planOver(driveFixture());
  const bridge = result.links.find(link => link.index === 4);
  assert.ok(bridge.barriers.length > 0, 'a fully elevated deck carries guardrails');
  assert.equal(bridge.barrierColliders.length, bridge.barriers.length);
  const hasVertex = (geometry, point, y) => {
    for (let i = 0; i < geometry.length; i += 3) {
      if (geometry[i] === point.x && geometry[i + 1] === y && geometry[i + 2] === point.z) return true;
    }
    return false;
  };
  for (let i = 0; i < bridge.barriers.length; i++) {
    const barrier = bridge.barriers[i];
    const collider = bridge.barrierColliders[i];
    assert.equal(collider.type, 'elevated-barrier');
    assert.equal(collider.polygon.outer.length, 4);
    assert.ok(Number.isFinite(collider.minY) && Number.isFinite(collider.maxY));
    assert.ok(Math.abs(collider.minY - Math.min(barrier.startY, barrier.endY)) < 1e-9);
    assert.ok(Math.abs(collider.maxY - Math.max(barrier.startY, barrier.endY)
      - elevated.ELEVATED_BARRIER_HEIGHT_M) < 1e-9);
    const start = collider.polygon.outer[0];
    assert.ok(hasVertex(bridge.geometry, start, collider.minY), 'wall bottom is the rendered deck edge');
    assert.ok(hasVertex(bridge.geometry, start, collider.maxY), 'wall top is the rendered guardrail top');
    assert.ok(collider.maxX - collider.minX <= 9 && collider.maxZ - collider.minZ <= 9,
      'each contact wall is a short segment, not a link-wide box');
  }
  for (const link of result.links) {
    for (const collider of link.barrierColliders) {
      assert.ok(collider.minY >= FLAT_TERRAIN + 0.75 - 1e-6,
        'guardrail contact starts above the street, so the road under the deck stays open');
      assert.ok(collider.maxY <= FLAT_TERRAIN + 9.6 + 0.95 + 1e-6);
    }
  }
  const offender = result.colliders.filter(collider => collider.type === 'elevated-barrier'
    && collider.minY < FLAT_TERRAIN + 0.75 - 1e-6);
  assert.equal(offender.length, 0, 'ramp feet keep both sides open');
});

test('piers expose a contact body from the ground to the deck underside', () => {
  const result = planOver(driveFixture());
  const bridge = result.links.find(link => link.index === 4);
  assert.ok(bridge.piers.length > 0);
  assert.equal(bridge.pierColliders.length, bridge.piers.length);
  for (let i = 0; i < bridge.piers.length; i++) {
    const pier = bridge.piers[i];
    const collider = bridge.pierColliders[i];
    assert.equal(collider.type, 'elevated-pier');
    assert.ok(Math.abs(collider.minY - pier.baseY) < 1e-9);
    assert.ok(Math.abs(collider.maxY - pier.topY) < 1e-9);
    assert.ok(Math.abs(collider.minX - (pier.x - pier.half)) < 1e-9);
    assert.ok(Math.abs(collider.maxZ - (pier.z + pier.half)) < 1e-9);
  }
  const barriers = result.colliders.filter(collider => collider.type === 'elevated-barrier');
  const piers = result.colliders.filter(collider => collider.type === 'elevated-pier');
  assert.equal(result.statistics.barrierColliders, barriers.length);
  assert.equal(result.statistics.pierColliders, piers.length);
  assert.equal(result.statistics.colliders, result.colliders.length);
  assert.equal(result.statistics.colliders, barriers.length + piers.length);
});

test('built elevated roads expose the guardrail and pier contact bodies', () => {
  const fake = fakeElevatedThree();
  const module = loadModule(read('sz-elevated-roads.js'), { imports: {
    'three/webgpu': fake, 'three/tsl': tslStub,
    './sz-roads.js': roads,
    './sz-ground-surface.js': groundSurface,
    './sz-polygon.js': loadModule(read('sz-polygon.js')),
    './sz-controller-surfaces.js': controllerSurfaces
  } });
  const built = module.buildSzElevatedRoads(new fake.Group(), {
    graph: driveFixture(), terrainSurface: surface, interchanges: FIXTURE_INTERCHANGES
  });
  assert.ok(built.colliders.length > 0);
  assert.equal(built.interchanges.length, 1);
  assert.equal(built.colliders.length, built.statistics.colliders);
  assert.equal(built.meshes.length, built.group.children.length);
  for (const mesh of built.group.children) {
    assert.equal(mesh.material.side, 2, 'guardrail faces render from both sides');
  }
  for (const collider of built.colliders) {
    assert.equal(collider.polygon.outer.length, 4);
    assert.equal(collider.polygon.holes.length, 0);
    for (const point of collider.polygon.outer) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z));
    }
  }
});

test('the real Shenzhen snapshot exposes drivable elevated chains with rendered deck contact', () => {
  const { gunzipSync } = require('node:zlib');
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const plan = elevated.planElevatedRoads(geo.roadGraph, geo.terrainSurface);
  assert.ok(plan.links.length >= 33, `plan links ${plan.links.length}`);
  assert.ok(plan.driveLinks.length >= 30, `drive links ${plan.driveLinks.length}`);
  assert.equal(plan.interchanges.length, 3);
  const chegongmiao = plan.interchanges.find(item => item.id === 'chegongmiao');
  assert.ok(chegongmiao, 'the existing Chegongmiao partition stays first');
  assert.equal(plan.interchanges[0].id, 'chegongmiao');
  assert.ok(chegongmiao.links >= 33, `Chegongmiao links ${chegongmiao.links}`);
  assert.equal(chegongmiao.links, plan.links.filter(link => link.interchangeId === 'chegongmiao').length);
  assert.ok(plan.interchanges.every(item => item.heightSource === 'estimate'));
  assert.equal(plan.statistics.interchanges.reduce((sum, item) => sum + item.links, 0), plan.links.length);
  assert.ok(plan.statistics.barriers > 0, 'decks carry guardrails');
  assert.ok(plan.statistics.barrierLengthM > 1000, 'guardrails run along the decks');
  assert.ok(plan.statistics.pierColliders > 0, 'piers have contact bodies');
  assert.equal(plan.colliders.length, plan.statistics.colliders);
  assert.equal(plan.colliders.length, plan.statistics.barrierColliders + plan.statistics.pierColliders);
  assert.ok(plan.colliders.every(collider => collider.minY >= 0), 'no contact body dips below the datum');
  const deckLength = plan.driveLinks.reduce((sum, link) => sum + link.lengthM, 0);
  assert.ok(deckLength > 5000, `drivable deck length ${deckLength}`);
  assert.ok(plan.driveLinks.every(link => link.maxGrade <= elevated.ELEVATED_DRIVE_MAX_GRADE), 'steep links stay out of the drive graph');
  assert.ok(plan.driveLinks.some(link => link.sharedStart), 'a deck end meets ground on the start side');
  assert.ok(plan.driveLinks.some(link => link.sharedEnd), 'a deck end meets ground on the end side');

  // 深南广深立交：OSM 来源是深南广深立交桥匝道与京港澳高速（广深段）桥面，layer 1 只表示上下关系。
  assert.equal(plan.interchanges.length, 3);
  const guangshen = plan.interchanges.find(item => item.id === 'shennan-guangshen');
  assert.ok(guangshen, 'the Shennan-GuangShen interchange is planned as its own partition');
  assert.equal(guangshen.name, '深南广深立交');
  assert.ok(guangshen.heightSource === 'estimate');
  assert.ok(guangshen.links >= 10, `Shennan-GuangShen links ${guangshen.links}`);
  assert.ok(guangshen.driveLinks >= 8, `Shennan-GuangShen drive links ${guangshen.driveLinks}`);
  assert.ok(guangshen.deckLengthM > 2500, `Shennan-GuangShen deck length ${guangshen.deckLengthM}`);
  const interchangeIds = new Set(plan.interchanges.map(item => item.id));
  const guangshenLinks = plan.links.filter(link => link.interchangeId === 'shennan-guangshen');
  assert.equal(guangshenLinks.length, guangshen.links);
  const guangshenOsm = new Set(guangshenLinks.map(link => link.osmId));
  for (const osmId of ['way/40933268', 'way/40933281', 'way/40933456', 'way/40933273']) {
    assert.ok(guangshenOsm.has(osmId), `${osmId} is planned in the Shennan-GuangShen partition`);
  }
  // 京港澳高速（广深段）主线也是 bridge layer 1，匝道要靠它接到地面才成闭环。
  assert.ok(guangshenOsm.has('way/40933472') && guangshenOsm.has('way/40933474'),
    'the Guangshen mainline decks share the same plan');
  const guangshenDrive = plan.driveLinks.filter(link => link.interchangeId === 'shennan-guangshen');
  assert.ok(guangshenDrive.some(link => link.sharedStart), 'a ramp foot meets the ground on the start side');
  assert.ok(guangshenDrive.some(link => link.sharedEnd), 'a ramp foot meets the ground on the end side');
  assert.ok(guangshenDrive.every(link => link.maxGrade <= elevated.ELEVATED_DRIVE_MAX_GRADE));
  // 隧道链路不摊成贴地桥面：深南广深分区里有紫众道 tunnel（layer -1），只记数量留给隧道模块。
  assert.ok(plan.statistics.tunnelLinks >= 1, `tunnel links ${plan.statistics.tunnelLinks}`);
  assert.ok(plan.links.every(link => link.tunnel === false));
  assert.equal(guangshenLinks.every(link => interchangeIds.has(link.interchangeId)), true);

  // 竹子林立交：滨河大道与京港澳高速（广深段）的喇叭形匝道；OSM 名字是竹子林立交桥。
  const zhuzilin = plan.interchanges.find(item => item.id === 'zhuzilin');
  assert.ok(zhuzilin, 'the Zhuzilin interchange is planned as its own partition');
  assert.equal(zhuzilin.name, '竹子林立交');
  assert.equal(zhuzilin.heightSource, 'estimate');
  assert.ok(zhuzilin.links >= 6, `Zhuzilin links ${zhuzilin.links}`);
  assert.ok(zhuzilin.driveLinks >= 6, `Zhuzilin drive links ${zhuzilin.driveLinks}`);
  assert.ok(zhuzilin.deckLengthM > 500, `Zhuzilin deck length ${zhuzilin.deckLengthM}`);
  const zhuzilinLinks = plan.links.filter(link => link.interchangeId === 'zhuzilin');
  const zhuzilinOsm = new Set(zhuzilinLinks.map(link => link.osmId));
  for (const osmId of ['way/40932649', 'way/40932651', 'way/40933270', 'way/40933271']) {
    assert.ok(zhuzilinOsm.has(osmId), `${osmId} is planned in the Zhuzilin partition`);
  }
  const zhuzilinDrive = plan.driveLinks.filter(link => link.interchangeId === 'zhuzilin');
  assert.ok(zhuzilinDrive.some(link => link.sharedStart), 'a Zhuzilin ramp foot meets the ground');
  assert.ok(zhuzilinDrive.some(link => link.sharedEnd), 'a Zhuzilin exit ramp meets the ground');
  assert.ok(zhuzilinDrive.every(link => link.maxGrade <= elevated.ELEVATED_DRIVE_MAX_GRADE));
  assert.ok(zhuzilinLinks.every(link => link.tunnel === false));

  // 车公庙目标链路：地面 → 403 上匝道 → 6595 桥面 → 11114 下匝道 → 地面。
  const byOsm = new Map(plan.links.map(link => [link.osmId, link]));
  const chain = ['way/40955020', 'way/854919717', 'way/1524817657'].map(osmId => {
    const link = byOsm.get(osmId);
    assert.ok(link, `${osmId} is planned`);
    return link;
  });
  assert.equal(chain[0].endNode, chain[1].startNode);
  assert.equal(chain[1].endNode, chain[2].startNode);
  assert.ok(chain[0].sharedStart, 'the ramp foot meets the ground link');
  assert.ok(chain[2].sharedEnd, 'the exit ramp meets the ground link');
  const driveSurfaceIds = new Set(plan.driveLinks.map(link => link.surfaceId));
  const deckHeight = controllerSurfaces.createSurfaceHeightAt(plan.surfaces.filter(item => driveSurfaceIds.has(item.id)));
  for (const link of chain) {
    assert.ok(driveSurfaceIds.has(link.surfaceId));
    for (const frame of [link.frames[1], link.frames[Math.floor(link.frames.length / 2)], link.frames.at(-2)]) {
      const height = deckHeight(frame.x, frame.z, link.surfaceId);
      assert.ok(Number.isFinite(height), `deck height at ${link.surfaceId}`);
      assert.ok(Math.abs(height - frame.y) < 1e-6, `${link.surfaceId} height comes from the rendered deck top`);
    }
  }
  const successorOf = id => plan.surfaces.find(item => item.id === id)?.driveSuccessors ?? [];
  assert.ok(successorOf(chain[0].surfaceId).includes(chain[1].surfaceId), '403 hands over to 6595');
  // 桥面上 6595 与并行 6592 的缎带重叠，按走向顺滑度优先 11114，避免吸附到相邻层。
  assert.equal(successorOf(chain[1].surfaceId)[0], chain[2].surfaceId);
});
