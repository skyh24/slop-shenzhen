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
const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
  'three/webgpu': {},
  './sz-roads.js': roads,
  './sz-ground-surface.js': groundSurface,
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
      './sz-roads.js': realRoads,
      './sz-ground-surface.js': groundSurface,
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
  assert.deepEqual(Array.from(result.links, link => link.index), [3, 4, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(result.driveLinks, link => link.index), [3, 4, 6]);
  assert.ok(result.driveLinks.every(link => result.links.includes(link)), 'drive links reuse the planned record objects');
  for (const link of result.links) {
    assert.ok(Number.isFinite(link.maxGrade));
    assert.ok(Math.abs(link.maxGrade - Math.abs(link.endDeckY - link.startDeckY) / link.lengthM) < 1e-12);
  }
  const steep = result.links.find(link => link.index === 7);
  assert.ok(steep.maxGrade > elevated.ELEVATED_DRIVE_MAX_GRADE, `steep grade ${steep.maxGrade}`);
  assert.equal(result.driveLinks.includes(steep), false, 'grades above the cap stay out of the drive network');
  const tunnel = result.links.find(link => link.index === 8);
  assert.equal(tunnel.tunnel, true);
  assert.ok(tunnel.layer > 0);
  assert.equal(result.driveLinks.includes(tunnel), false, 'tunnels stay out of the drive network');
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
    BufferAttribute: FakeBufferAttribute, MeshStandardNodeMaterial: FakeMaterial };
}

test('built elevated roads expose drive surfaces and a deck height sampler on the same triangles', () => {
  const fake = fakeElevatedThree();
  const module = loadModule(read('sz-elevated-roads.js'), { imports: {
    'three/webgpu': fake,
    './sz-roads.js': roads,
    './sz-ground-surface.js': groundSurface,
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
  // 隧道、layer 0 桥和陡坡的渲染表面存在，但不进入车行采样器。
  const excluded = built.surfaces.filter(item => ['sz-elevated-road:7', 'sz-elevated-road:8', 'sz-elevated-road:9']
    .includes(item.id));
  assert.equal(excluded.length, 3);
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

test('the real Shenzhen snapshot exposes drivable elevated chains with rendered deck contact', () => {
  const { gunzipSync } = require('node:zlib');
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const plan = elevated.planElevatedRoads(geo.roadGraph, geo.terrainSurface);
  assert.ok(plan.links.length >= 33, `plan links ${plan.links.length}`);
  assert.ok(plan.driveLinks.length >= 30, `drive links ${plan.driveLinks.length}`);
  const deckLength = plan.driveLinks.reduce((sum, link) => sum + link.lengthM, 0);
  assert.ok(deckLength > 5000, `drivable deck length ${deckLength}`);
  assert.ok(plan.driveLinks.every(link => link.maxGrade <= elevated.ELEVATED_DRIVE_MAX_GRADE), 'steep links stay out of the drive graph');
  assert.ok(plan.driveLinks.some(link => link.sharedStart), 'a deck end meets ground on the start side');
  assert.ok(plan.driveLinks.some(link => link.sharedEnd), 'a deck end meets ground on the end side');

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
