const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const roads = loadModule(read('sz-roads.js'), { imports: { 'three/webgpu': {} } });
const groundSurface = loadModule(read('sz-ground-surface.js'));
const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
  'three/webgpu': {},
  './sz-roads.js': roads,
  './sz-ground-surface.js': groundSurface
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
  assert.equal(statistics.areaM2, 9000);
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
    const realRoads = loadModule(read('sz-roads.js'), { imports: { 'three/webgpu': THREE } });
    const module = loadModule(read('sz-elevated-roads.js'), { imports: {
      'three/webgpu': THREE,
      './sz-roads.js': realRoads,
      './sz-ground-surface.js': groundSurface
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
