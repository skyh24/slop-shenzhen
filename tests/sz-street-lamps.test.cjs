const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const roads = loadModule(read('sz-roads.js'), { imports: {
  'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
} });
const nightUniform = { value: 0 };
const materialsStub = { sceneUniforms: { night: nightUniform } };
const lamps = loadModule(read('sz-street-lamps.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': { color: () => ({}), uniform: () => ({ value: 0 }) },
  './sz-roads.js': roads, './sz-polygon.js': polygonModule, './sz-materials.js': materialsStub,
  './building-collision.js': collision
} });

function graph(links, metadata) {
  return { nodes: [0, 0, 300, 0, 300, 300], nodeIds: ['node/1', 'node/2', 'node/3'],
    names: [''], links, metadata };
}

const ground = () => ({ heightSource: 'terrain', bridge: false, tunnel: false, layer: 0, highway: 'primary' });

test('street lamps are spaced along both sides of ground primary roads', () => {
  const link = [0, 1, 0, 12, 3, 0, []];
  const plan = lamps.planLampSites(graph([link], [ground()]));
  assert.ok(plan.sites.length >= 22 && plan.sites.length <= 28, `sites=${plan.sites.length}`);
  const sides = new Set(plan.sites.map(site => site.side));
  assert.deepEqual([...sides].sort(), [-1, 1]);
  for (const site of plan.sites) {
    assert.ok(Number.isFinite(site.x) && Number.isFinite(site.z) && Number.isFinite(site.yaw));
    assert.equal(site.class, 'primary');
    assert.equal(site.style, 'T');
  }
  const north = plan.sites.filter(site => site.side === 1).map(site => site.x).sort((a, b) => a - b);
  for (let i = 1; i < north.length; i++) assert.ok(Math.abs(north[i] - north[i - 1] - 22) < 1.5);
  // 灯臂必须朝路中心：灯头比灯杆更靠近中心线。
  const site = plan.sites[0];
  const headX = site.x + Math.cos(site.yaw) * 2.2;
  const headZ = site.z - Math.sin(site.yaw) * 2.2;
  assert.ok(Math.abs(headZ) < Math.abs(site.z), 'arm points back towards the centre line');
  assert.ok(Math.abs(headX - site.x) < 1e-9, 'arm is perpendicular to an east-west link');
});

test('street lamps skip bridges, tunnels, layered roads and motorways', () => {
  const links = [[0, 1, 0, 12, 3, 0, []], [1, 2, 0, 12, 3, 0, []], [0, 1, 0, 12, 3, 0, []], [1, 2, 0, 12, 3, 0, []]];
  const metadata = [
    { ...ground(), bridge: true },
    { ...ground(), tunnel: true },
    { ...ground(), layer: 1 },
    { ...ground(), highway: 'motorway' }
  ];
  const plan = lamps.planLampSites(graph(links, metadata));
  assert.equal(plan.sites.length, 0);
  assert.ok(plan.rejected.bridgeOrTunnelOrLayer >= 3);
  assert.ok(plan.rejected.unsupportedClass >= 1);
});

test('small roads use inward-facing L lamps on both asymmetric curbs', () => {
  const m = { ...ground(), highway: 'residential', crossSection: { points: [0, 0, 2, 300, 0, 3] } };
  const { sites } = lamps.planLampSites(graph([[0, 1, 0, 7, 2, 0, []]], [m]));
  assert.ok(sites.length > 0);
  assert.ok(sites.every(site => site.style === 'L'));
  for (const side of [1, -1]) {
    const curb = sites.filter(site => site.side === side);
    assert.ok(curb.length > 2);
    assert.equal(curb[1].stationM - curb[0].stationM, 50);
    assert.ok(curb.every(site => side === 1 ? site.z > -3.9 && site.z < -2.9 : site.z > 4.9 && site.z < 5.9));
    assert.ok(curb.every(site => Math.sign(Math.sin(site.yaw)) === -side));
  }
});

test('opposing carriageways share one centered T lamp row in a narrow median', () => {
  const divided = {
    nodes: [0, 0, 300, 0, 300, 18, 0, 18], names: ['Test Road'],
    links: [[0, 1, 0, 12, 3, 1, []], [2, 3, 0, 12, 3, 1, []]], metadata: [ground(), ground()]
  };
  const sites = lamps.planLampSites(divided, { medianHeight: (x, z) => z === 9 ? 0.2 : null }).sites;
  const median = sites.filter(site => site.median);
  assert.ok(median.length > 5);
  assert.ok(median.every(site => site.z === 9 && site.style === 'T' && site.linkIndex === 0));
  assert.ok(median.every(site => site.median === 'documented' && site.armLengthM > 3));
  assert.ok(sites.filter(site => !site.median).every(site => site.z < 0 || site.z > 18));
});

test('street lamp planning is deterministic and chunk grouping keeps every site', () => {
  const links = [[0, 1, 0, 16, 4, 0, []], [1, 2, 0, 12, 3, 0, []]];
  const metadata = [ground(), { ...ground(), highway: 'trunk' }];
  const first = lamps.planLampSites(graph(links, metadata));
  const second = lamps.planLampSites(graph(links, metadata));
  assert.deepEqual(first, second);
  assert.ok(first.sites.length > 0);
  const chunks = lamps.groupLampSites(first.sites, 500);
  const total = [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
  assert.equal(total, first.sites.length);
  for (const key of chunks.keys()) assert.match(key, /^-?\d+,-?\d+$/);
});

test('street lamp planner rejects malformed road graphs', () => {
  assert.throws(() => lamps.planLampSites(null), /Road graph/);
  assert.throws(() => lamps.planLampSites({ links: [], metadata: [], nodes: [] }), /Road graph/);
});

test('real Three street lamps cull halo points per chunk and dispose their group', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const packageUrl = pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, '/'));
  const [THREE, tsl] = await Promise.all([
    import(new URL('build/three.webgpu.js', packageUrl)),
    import(new URL('build/three.tsl.js', packageUrl))
  ]);
  const runtime = loadModule(read('sz-street-lamps.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': tsl, './sz-roads.js': roads, './sz-materials.js': materialsStub,
    './building-collision.js': collision
  } });
  const scene = new THREE.Scene();
  const model = runtime.buildSzStreetLamps(scene, graph([[0, 1, 0, 12, 3, 0, []]], [ground()]), {
    groundHeight: () => 0,
    roadHeight: () => null,
    createGlowTexture: () => ({ isTexture: true, dispose() {} })
  });
  assert.ok(model.sites.length > 0);
  assert.equal(model.colliders.length, model.sites.length);
  const chunked = runtime.groupLampSites(model.sites);
  assert.ok(chunked.size >= 2, `chunks=${chunked.size}`);
  assert.equal(model.group.children.length, chunked.size);
  assert.equal(model.statistics.chunks, chunked.size);
  let haloCount = 0;
  for (const [key, sites] of chunked) {
    const chunkGroup = model.group.children.find(child => child.name === `lamps:${key}`);
    assert.ok(chunkGroup, `missing chunk group lamps:${key}`);
    const haloPoints = chunkGroup.children.filter(child => child.isPoints);
    assert.equal(haloPoints.length, 1);
    const halo = haloPoints[0];
    haloCount++;
    assert.equal(halo.name, `lamps:${key}:halos`);
    assert.equal(halo.frustumCulled, true);
    assert.equal(halo.geometry.attributes.position.count, sites.length * 2);
    const sphere = halo.geometry.boundingSphere;
    assert.ok(sphere, 'halo geometry keeps a bounding sphere for frustum culling');
    assert.ok(Number.isFinite(sphere.radius) && sphere.radius > 0);
    assert.ok(Number.isFinite(sphere.center.x) && Number.isFinite(sphere.center.y) && Number.isFinite(sphere.center.z));
    // 包围球要落在本块灯位附近，不能退化成整个城市范围。
    const meanX = sites.reduce((sum, site) => sum + site.x, 0) / sites.length;
    const meanZ = sites.reduce((sum, site) => sum + site.z, 0) / sites.length;
    assert.ok(Math.hypot(sphere.center.x - meanX, sphere.center.z - meanZ) < 1200);
    for (const kind of ['poles', 'arms', 'heads']) {
      const mesh = chunkGroup.children.find(child => child.name === `lamps:${key}:${kind}`);
      assert.ok(mesh?.isInstancedMesh, `lamps:${key}:${kind} stays instanced`);
      assert.equal(mesh.frustumCulled, true);
      assert.equal(mesh.count, kind === 'heads' ? sites.length * 2 : sites.length);
    }
  }
  assert.equal(haloCount, chunked.size);
  assert.equal(model.group.children.reduce((sum, child) => sum + child.children.filter(part => part.isPoints).length, 0),
    chunked.size);
  // 日夜系数直接读全局 uniform：0 时灯光全灭，1 时达到原来的透明度。
  const opacities = () => {
    const result = { pool: null, halo: null };
    model.group.traverse((object) => {
      if (object.material?.isMeshBasicMaterial) result.pool = object.material.opacity;
      if (object.material?.isPointsMaterial) result.halo = object.material.opacity;
    });
    return result;
  };
  nightUniform.value = 0;
  model.update(new THREE.Vector3(0, 0, 0));
  assert.deepEqual(opacities(), { pool: 0, halo: 0 });
  nightUniform.value = 1;
  model.update(new THREE.Vector3(0, 0, 0));
  assert.deepEqual(opacities(), { pool: 0.72, halo: 0.9 });
  model.dispose();
  assert.equal(model.group.parent, null);
  assert.ok(!scene.children.includes(model.group));
});
