const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');
const { fixtureTerrainSurface } = require('./helpers/terrain-surface.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const auditSource = readFileSync(join(__dirname, '../tools/qa/sz-tunnels.js'), 'utf8');

const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
} });
const groundSurface = loadModule(read('sz-ground-surface.js'));
const polygonModule = loadModule(read('sz-polygon.js'));

// 默认立交替身故意选在没有隧道的范围，用来验证「空范围返回 0 条、不抛错」。
const DEFAULT_INTERCHANGES = [{
  id: 'default-fixture',
  name: '默认立交替身',
  source: 'tests/sz-tunnels.test.cjs',
  area: { minX: 2000, maxX: 2500, minZ: 2000, maxZ: 2500 },
  heightSource: 'estimate'
}];
const INTERCHANGES = [{
  id: 'fixture-interchange',
  name: '测试立交',
  source: 'tests/sz-tunnels.test.cjs',
  area: { minX: -50, maxX: 450, minZ: 50, maxZ: 350 },
  heightSource: 'estimate'
}];
const DEEP_INTERCHANGES = [{
  id: 'deep-fixture',
  name: '测试深层隧道',
  source: 'tests/sz-tunnels.test.cjs',
  area: { minX: 100, maxX: 400, minZ: 500, maxZ: 650 },
  heightSource: 'estimate'
}];

function loadTunnels(three = {}) {
  return loadModule(auditSource, { imports: {
    'three/webgpu': three,
    '../../js/sz-roads.js': roads,
    '../../js/sz-ground-surface.js': groundSurface,
    '../../js/sz-polygon.js': polygonModule,
    '../../js/sz-elevated-roads.js': { SHENZHEN_INTERCHANGES: DEFAULT_INTERCHANGES }
  } });
}

const tunnels = loadTunnels();

const TERRAIN_Y = 10;
const SURFACE = fixtureTerrainSurface({
  x0: -1000, z0: -1000, step: 500, nx: 5, nz: 5, heightScale: 0.1,
  heights: new Array(25).fill(100)
});

// 节点平铺 x,z 对。link 顺序决定来源序号；隧道 A layer -1、layer 0 隧道、区外 layer -2 隧道各一条。
function fixture() {
  return {
    nodes: [
      0, 100, 400, 100, -100, 100, 500, 100,
      -100, 300, 300, 300, 200, 600, 300, 600,
      100, 250, 300, 250, 100, 200, 300, 200,
      200, 700, 300, 700, 150, 150, 350, 150
    ],
    names: ['Ground A', 'Ground B', 'Tunnel A', 'Layer zero', 'Outside deep',
      'Ground Crossing', 'Ground Clear', 'Ground Outside', 'Bridge Crossing'],
    links: [
      [2, 0, 0, 8, 2, 0, []],
      [1, 3, 0, 8, 2, 0, []],
      [0, 1, 2, 8, 2, 0, []],
      [4, 5, 3, 7, 1, 0, []],
      [6, 7, 4, 8, 2, 0, []],
      [8, 9, 5, 6, 1, 0, []],
      [10, 11, 6, 6, 1, 0, []],
      [12, 13, 7, 6, 1, 0, []],
      [14, 15, 8, 8, 2, 0, []]
    ],
    metadata: [
      { osmId: 'way/1', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/2', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/3', heightSource: 'unresolved', bridge: false, tunnel: true, layer: -1 },
      { osmId: 'way/4', heightSource: 'unresolved', bridge: false, tunnel: true, layer: 0 },
      { osmId: 'way/5', heightSource: 'unresolved', bridge: false, tunnel: true, layer: -2 },
      { osmId: 'way/6', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/7', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/8', heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 },
      { osmId: 'way/9', heightSource: 'unresolved', bridge: true, tunnel: false, layer: 1 }
    ]
  };
}

// 建筑轮廓：隧道上方的楼不算穿楼评审；桥面穿楼有来源也不算；只有地面道路穿楼才进评审清单。
function buildings() {
  return [
    { id: 'building-crossing', cx: 209, cz: 250, minX: 118, maxX: 300, minZ: 230, maxZ: 270,
      polygons: [{ outer: [{ x: 118, z: 230 }, { x: 300, z: 230 }, { x: 300, z: 270 }, { x: 118, z: 270 }], holes: [] }] },
    { id: 'building-bridge', cx: 250, cz: 150, minX: 140, maxX: 360, minZ: 140, maxZ: 160,
      polygons: [{ outer: [{ x: 140, z: 140 }, { x: 360, z: 140 }, { x: 360, z: 160 }, { x: 140, z: 160 }], holes: [] }] },
    { id: 'building-outside', cx: 250, cz: 700, minX: 160, maxX: 340, minZ: 680, maxZ: 720,
      polygons: [{ outer: [{ x: 160, z: 680 }, { x: 340, z: 680 }, { x: 340, z: 720 }, { x: 160, z: 720 }], holes: [] }] },
    { id: 'building-over-tunnel', cx: 200, cz: 100, minX: 150, maxX: 250, minZ: 90, maxZ: 110,
      polygons: [{ outer: [{ x: 150, z: 90 }, { x: 250, z: 90 }, { x: 250, z: 110 }, { x: 150, z: 110 }], holes: [] }] }
  ];
}

function plan(overrides = {}) {
  return tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: INTERCHANGES, buildings: buildings(), ...overrides });
}

function triangleUpward(triangle) {
  const [a, b, c] = triangle;
  return (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
}

function polygonArea2D(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

test('tunnel planning is deterministic and selects only OSM tunnel links inside the interchange areas', () => {
  const first = plan();
  const second = plan();
  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(first.heightSource, 'estimate');
  assert.equal(tunnels.TUNNEL_LAYER_DEPTH_M, 6);
  assert.deepEqual(Array.from(first.tunnels, record => record.index), [2, 3]);
  assert.deepEqual(Array.from(first.tunnels, record => record.osmId), ['way/3', 'way/4']);
  assert.deepEqual(Array.from(first.tunnels[0].interchangeIds), ['fixture-interchange']);
  assert.equal(first.surfaces.length, 1);
  assert.equal(first.surfaces[0].id, 'sz-tunnel:2');
  assert.equal(first.surfaces[0].heightSource, 'estimate');
  assert.equal(first.surfaces[0].climbableFromGround, false);
  const outside = first.tunnels.find(record => record.osmId === 'way/5');
  assert.equal(outside, undefined, 'tunnels outside the interchange areas are not planned');
});

test('tunnel floor descends from ground portals to the layer estimate over a short transition', () => {
  const record = plan().tunnels.find(item => item.osmId === 'way/3');
  assert.equal(record.layer, -1);
  assert.equal(record.depthM, 6);
  assert.equal(record.lengthM, 400);
  assert.equal(record.drivable, true);
  assert.equal(record.portalStart, true);
  assert.equal(record.portalEnd, true);
  assert.equal(record.portalCount, 2);
  assert.ok(Math.abs(record.frames[0].floorY - TERRAIN_Y) < 1e-9, 'start portal meets terrain');
  assert.ok(Math.abs(record.frames.at(-1).floorY - TERRAIN_Y) < 1e-9, 'end portal meets terrain');
  assert.ok(Math.abs(record.frames[3].floorY - (TERRAIN_Y - 6)) < 1e-9, '12 m in reaches the estimate');
  assert.ok(Math.abs(record.frames[50].floorY - (TERRAIN_Y - 6)) < 1e-9, 'interior floor holds the estimate');
  assert.ok(Math.abs(record.frames[97].floorY - (TERRAIN_Y - 6)) < 1e-9, 'exit transition starts 12 m before the end');
  assert.ok(Math.abs(record.frames[99].floorY - (TERRAIN_Y - 2)) < 1e-9, 'last steps climb back towards terrain');
  assert.ok(Math.abs(record.startFloorY - TERRAIN_Y) < 1e-9);
  assert.ok(Math.abs(record.endFloorY - TERRAIN_Y) < 1e-9);
  for (let i = 1; i < record.frames.length; i++) {
    assert.ok(record.frames[i].ceilingY - record.frames[i].floorY > 4.9, 'bore clearance stays estimated 5 m');
  }
});

test('layer zero tunnels stay source records without bore geometry', () => {
  const record = plan().tunnels.find(item => item.osmId === 'way/4');
  assert.equal(record.layer, 0);
  assert.equal(record.depthM, 0);
  assert.equal(record.drivable, false);
  assert.equal(record.portalCount, 0);
  assert.equal(record.frames.length, 0);
  assert.equal(record.floorTriangles.length, 0);
  assert.equal(record.wallTriangles.length, 0);
  assert.equal(record.geometry.length, 0);
  assert.equal(record.floorTriangles.length, 0, 'no zero-depth bore is invented');
});

test('layer -2 tunnels use the doubled estimated depth and keep a buried bore without portals', () => {
  const result = tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: DEEP_INTERCHANGES });
  assert.equal(result.tunnels.length, 1);
  const record = result.tunnels[0];
  assert.equal(record.osmId, 'way/5');
  assert.equal(record.layer, -2);
  assert.equal(record.depthM, 12);
  assert.equal(record.drivable, false);
  assert.equal(record.portalCount, 0);
  assert.equal(record.portalTriangles.length, 0);
  assert.ok(record.floorTriangles.length > 0, 'a buried bore still has floor contact triangles');
  const ys = record.floorTriangles.flat().map(point => point.y);
  assert.ok(Math.abs(Math.min(...ys) - (TERRAIN_Y - 12)) < 1e-9);
  assert.equal(result.surfaces.length, 1);
  assert.equal(result.surfaces[0].id, 'sz-tunnel:4');
});

test('floor triangles are the only contact surface; walls and ceiling come from the same pass but stay out', () => {
  const result = plan();
  const record = result.tunnels.find(item => item.osmId === 'way/3');
  assert.ok(record.floorTriangles.length > 0);
  assert.ok(record.wallTriangles.length > 0);
  assert.ok(record.ceilingTriangles.length > 0);
  assert.ok(record.portalTriangles.length > 0);
  assert.equal(record.geometry.length, (record.floorTriangles.length + record.wallTriangles.length
    + record.ceilingTriangles.length + record.portalTriangles.length) * 9);
  assert.equal(record.geometry.length, record.colors.length);
  assert.equal(result.surfaces.length, 1);
  assert.equal(result.surfaces[0].triangles, record.floorTriangles, 'contact surface reuses the floor triangles');
  for (const triangle of result.surfaces[0].triangles) {
    assert.equal(triangle.length, 3);
    assert.ok(triangle.every(point => [point.x, point.y, point.z].every(Number.isFinite)));
    assert.ok(triangle.every(point => point.y <= TERRAIN_Y + 1e-9), 'no ceiling triangle enters contact');
    assert.ok(triangleUpward(triangle) > 0, 'floor contact normal points up');
  }
  const floorYs = record.floorTriangles.flat().map(point => point.y);
  assert.ok(Math.abs(Math.min(...floorYs) - (TERRAIN_Y - 6)) < 1e-9);
  const ceilingYs = record.ceilingTriangles.flat().map(point => point.y);
  assert.ok(Math.min(...ceilingYs) >= TERRAIN_Y - 6 + 5 - 1e-9, 'ceiling stays above the floor');
  assert.ok(Math.max(...ceilingYs) > TERRAIN_Y, 'ceiling is real display geometry');
});

test('wall colliders are thin per-segment strips derived from the wall vertices', () => {
  const record = plan().tunnels.find(item => item.osmId === 'way/3');
  assert.equal(record.colliders.length, (record.frames.length - 1) * 2);
  for (const collider of record.colliders) {
    assert.equal(collider.type, 'tunnel-wall');
    assert.equal(collider.polygon.holes.length, 0);
    assert.equal(collider.polygon.outer.length, 4);
    assert.ok(collider.polygon.outer.every(point => Number.isFinite(point.x) && Number.isFinite(point.z)));
    assert.ok(collider.minY < collider.maxY);
    assert.ok(collider.minY >= TERRAIN_Y - 6 - 1e-9);
    assert.ok(collider.maxY <= TERRAIN_Y + 5 + 1e-9);
    assert.ok(collider.maxY - collider.minY <= 8, 'a segment never becomes a full-height box');
    const area = polygonArea2D(collider.polygon.outer);
    assert.ok(area > 0.5 && area < 2, `thin wall strip area ${area}`);
    assert.equal(polygonModule.polygonContains(collider.polygon, 200, 100), false,
      'the road centre above ground is never sealed by a collider');
  }
});

test('portal frames exist only at ground-shared mouth ends', () => {
  const result = plan();
  const record = result.tunnels.find(item => item.osmId === 'way/3');
  assert.equal(record.portalTriangles.length, 12, 'two portals, each three quads');
  assert.equal(record.portalTriangles.length, record.portalCount * 6);
  const portalYs = record.portalTriangles.flat().map(point => point.y);
  assert.ok(Math.max(...portalYs) > TERRAIN_Y + 5, 'portal headwall rises above the bore mouth');
  const buried = tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: DEEP_INTERCHANGES }).tunnels[0];
  assert.equal(buried.portalCount, 0);
  assert.equal(buried.portalTriangles.length, 0);
});

test('centreline crossing a building without a tunnel source is reviewed, not carved', () => {
  const result = plan();
  assert.equal(result.reviewList.length, 1);
  const [item] = result.reviewList;
  assert.deepEqual(Object.keys(item).sort(), ['name', 'osmId', 'reason', 'x', 'z']);
  assert.equal(item.osmId, 'way/6');
  assert.equal(item.name, 'Ground Crossing');
  assert.equal(item.reason, 'centreline crosses building without tunnel source');
  assert.ok(Math.abs(item.x - 120) < 1e-9);
  assert.ok(Math.abs(item.z - 250) < 1e-9);
  assert.equal(result.tunnels.some(record => record.osmId === 'way/6'), false, 'no tunnel is carved for review items');
  assert.equal(result.tunnels.some(record => record.osmId === 'way/9'), false, 'bridge and tunnel sources never enter review');
  assert.equal(result.reviewList.some(item => item.osmId === 'way/9'), false);
  assert.equal(result.reviewList.some(item => item.osmId === 'way/8'), false, 'crossings outside the areas stay unreported');
});

test('the default interchange list is only a smoke path and empty selection returns an empty plan', () => {
  const defaults = tunnels.planSzTunnels(fixture(), SURFACE);
  assert.equal(defaults.tunnels.length, 0);
  assert.equal(defaults.surfaces.length, 0);
  assert.equal(defaults.colliders.length, 0);
  assert.equal(defaults.reviewList.length, 0);
  assert.equal(defaults.statistics.tunnels, 0);
  assert.equal(defaults.statistics.boreLengthM, 0);
  assert.deepEqual(Array.from(defaults.interchanges, entry => entry.id), ['default-fixture']);
  const empty = tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: [], buildings: buildings() });
  assert.equal(empty.tunnels.length, 0);
  assert.equal(empty.reviewList.length, 0);
  assert.equal(empty.statistics.heightSource, 'estimate');
});

test('statistics report estimate provenance, bore length, walls and review items', () => {
  const result = plan();
  const statistics = result.statistics;
  assert.equal(statistics.tunnels, result.tunnels.length);
  assert.equal(statistics.tunnels, 2);
  assert.equal(statistics.drivableTunnels, 1);
  assert.equal(statistics.boreLengthM, 400);
  assert.equal(statistics.portalCount, 2);
  assert.equal(statistics.walls, 2 * (result.tunnels[0].frames.length - 1));
  assert.equal(statistics.triangles, result.tunnels.reduce((sum, record) => sum + record.geometry.length / 9, 0));
  assert.equal(statistics.triangles, result.tunnels[0].geometry.length / 9);
  assert.equal(statistics.reviewItems, result.reviewList.length);
  assert.equal(statistics.heightSource, 'estimate');
  assert.ok(statistics.limitations.length > 0);
  assert.ok(statistics.limitations.every(text => typeof text === 'string' && /[\u4e00-\u9fff]/.test(text)));
  assert.ok(statistics.limitations.some(text => /估算/.test(text)));
  assert.ok(statistics.limitations.some(text => /6 m/.test(text)));
  assert.ok(statistics.limitations.some(text => /净空/.test(text)));
});

// 假 THREE 只让 buildSzTunnels 走完建场景流程；真实渲染几何由下面 skip 门的真 THREE 测试覆盖。
function fakeTunnelsThree() {
  class FakeBufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  class FakeBufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
    computeVertexNormals() {}
    computeBoundingBox() {}
    computeBoundingSphere() {}
    dispose() { this.disposed = true; }
  }
  class FakeGroup {
    constructor() { this.children = []; this.parent = null; }
    add(...objects) { for (const object of objects) { object.parent = this; this.children.push(object); } }
    remove(object) { this.children = this.children.filter(child => child !== object); object.parent = null; }
  }
  class FakeMaterial {
    constructor(options) { Object.assign(this, options); }
    dispose() { this.disposed = true; }
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
    BufferAttribute: FakeBufferAttribute, MeshStandardNodeMaterial: FakeMaterial };
}

test('fake THREE build creates chunk meshes, surfaces and disposes cleanly', () => {
  const fake = fakeTunnelsThree();
  const module = loadTunnels(fake);
  const scene = new fake.Group();
  const built = module.buildSzTunnels(scene, { graph: fixture(), terrainSurface: SURFACE, interchanges: INTERCHANGES, buildings: buildings() });
  assert.equal(built.group.parent, scene);
  assert.equal(built.group.name, 'shenzhen-tunnels');
  assert.ok(built.meshes.length >= 1 && built.meshes.length <= 8);
  assert.equal(built.surfaces.length, 1);
  assert.equal(built.colliders.length, 200);
  assert.equal(built.reviewList.length, 1);
  assert.equal(built.statistics.tunnels, 2);
  assert.deepEqual(Array.from(built.tunnels, record => record.index), [2, 3]);
  for (const mesh of built.meshes) {
    assert.equal(mesh.material.vertexColors, true);
    assert.equal(mesh.geometry.attributes.position.array.length % 9, 0);
    assert.equal(mesh.geometry.attributes.position.array.length, mesh.geometry.attributes.color.array.length);
    assert.equal(mesh.userData.tunnels.length >= 1, true);
  }
  built.update();
  built.dispose();
  assert.equal(built.group.parent, null);
  assert.equal(scene.children.length, 0);
});

test('plan and build reject invalid inputs with readable errors', () => {
  assert.throws(() => tunnels.planSzTunnels(null, SURFACE), /A source road graph with link metadata is required/);
  assert.throws(() => tunnels.planSzTunnels(fixture(), null, { interchanges: INTERCHANGES }), /Invalid terrain surface payload/);
  assert.throws(() => tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: 'nope' }), /At least one interchange area is required/);
  assert.throws(() => tunnels.planSzTunnels(fixture(), SURFACE, {
    interchanges: [{ id: 'x', name: 'X', source: 's', area: { minX: 1, maxX: 0, minZ: 0, maxZ: 1 }, heightSource: 'estimate' }]
  }), /Invalid interchange area/);
  assert.throws(() => tunnels.planSzTunnels(fixture(), SURFACE, { interchanges: INTERCHANGES, buildings: 'nope' }),
    /Buildings must be an array/);
  assert.throws(() => tunnels.buildSzTunnels({}, { graph: fixture(), terrainSurface: SURFACE }),
    /A THREE scene is required/);
  assert.throws(() => tunnels.buildSzTunnels(null), /A THREE scene is required/);
});

test('real THREE build raycasts the tunnel floor from inside the bore',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const realRoads = loadModule(read('sz-roads.js'), { imports: {
      'three/webgpu': THREE, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
    } });
    const module = loadModule(auditSource, { imports: {
      'three/webgpu': THREE,
      '../../js/sz-roads.js': realRoads,
      '../../js/sz-ground-surface.js': groundSurface,
      '../../js/sz-polygon.js': polygonModule,
      '../../js/sz-elevated-roads.js': { SHENZHEN_INTERCHANGES: DEFAULT_INTERCHANGES }
    } });
    const scene = new THREE.Scene();
    const built = module.buildSzTunnels(scene, { graph: fixture(), terrainSurface: SURFACE, interchanges: INTERCHANGES, buildings: buildings() });
    assert.equal(built.group.parent, scene);
    assert.ok(built.meshes.length >= 1 && built.meshes.length <= 8);
    for (const mesh of built.meshes) {
      assert.equal(mesh.material.type, 'MeshStandardNodeMaterial');
      assert.equal(mesh.material.vertexColors, true);
      assert.equal(mesh.geometry.attributes.position.array.length % 9, 0);
      assert.equal(mesh.geometry.attributes.color.itemSize, 3);
      assert.ok(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite));
      assert.ok(Array.from(mesh.geometry.attributes.color.array).every(value => value >= 0 && value <= 1));
    }
    scene.updateMatrixWorld(true);
    // 洞内一点：埋深 6 m → 洞底 y=4、洞顶 y=9；从上往下打射线应命中洞底。
    const raycaster = new THREE.Raycaster(new THREE.Vector3(200, 8, 100), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(built.group.children)[0];
    assert.ok(hit, 'tunnel floor is visible from inside the bore');
    assert.ok(Math.abs(hit.point.y - 4) < 1e-3, `floor hit at ${hit.point.y}`);
    assert.ok(hit.face.normal.y > 0.99, 'floor face normal points up');
    built.update();
    built.dispose();
    assert.equal(built.group.parent, null);
    assert.equal(scene.children.length, 0);
  });

test('real Shenzhen snapshot exposes sourced tunnels and the review list', () => {
  const { gunzipSync } = require('node:zlib');
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { buildings: snapshotBuildings, geo } = decodeCityPayload(raw);
  // 真实快照断言显式传选区，不依赖 SHENZHEN_INTERCHANGES 的最终内容；
  // 选点依据：香蜜湖路隧道 way/535064405、way/535064406 与莲科路隧道 way/852010061。
  const snapshotInterchanges = [
    { id: 'xiangmihu-road-tunnel', name: '香蜜湖路隧道', source: 'tests/sz-tunnels.test.cjs 快照选点',
      area: { minX: -3700, maxX: -3100, minZ: -200, maxZ: 400 }, heightSource: 'estimate' },
    { id: 'lianke-road-tunnel', name: '莲科路隧道', source: 'tests/sz-tunnels.test.cjs 快照选点',
      area: { minX: 800, maxX: 1450, minZ: -1750, maxZ: -1250 }, heightSource: 'estimate' }
  ];
  const result = tunnels.planSzTunnels(geo.roadGraph, geo.terrainSurface,
    { interchanges: snapshotInterchanges, buildings: snapshotBuildings });
  assert.ok(result.tunnels.length >= 3, `sourced tunnels ${result.tunnels.length}`);
  const osmIds = new Set(result.tunnels.map(record => record.osmId));
  assert.ok(osmIds.has('way/535064405'), 'xiangmihu tunnel bore is planned');
  assert.ok(osmIds.has('way/535064406'), 'the opposite xiangmihu bore is planned');
  assert.ok(osmIds.has('way/852010061'), 'lianke tunnel bore is planned');
  assert.ok(result.tunnels.every(record => typeof record.osmId === 'string' && /^way\//.test(record.osmId)));
  assert.ok(result.tunnels.every(record => Number.isFinite(record.lengthM) && record.lengthM > 0));
  assert.ok(result.tunnels.every(record => Number.isFinite(record.layer)));
  assert.ok(result.tunnels.some(record => record.drivable), 'at least one bore reaches the ground');
  assert.ok(result.surfaces.length >= 1);
  assert.ok(result.surfaces.every(surface => surface.heightSource === 'estimate'
    && surface.climbableFromGround === false && surface.id.startsWith('sz-tunnel:')));
  assert.ok(result.colliders.length > 0);
  assert.ok(result.colliders.every(collider => collider.type === 'tunnel-wall'));
  // 待核清单取决于当时的建筑轮廓：这两块选区的穿楼条数会随建筑数据变化，
  // 这里只锁结构和口径，检出行为由上面的夹具测试覆盖，不把条数写死。
  assert.ok(Array.isArray(result.reviewList));
  assert.ok(result.reviewList.every(item => item.reason === 'centreline crosses building without tunnel source'
    && typeof item.osmId === 'string' && Number.isFinite(item.x) && Number.isFinite(item.z)));
  assert.equal(result.statistics.tunnels, result.tunnels.length);
  assert.equal(result.statistics.reviewItems, result.reviewList.length);
  assert.equal(result.statistics.heightSource, 'estimate');
  assert.ok(result.statistics.limitations.some(text => /估算/.test(text)));
});
