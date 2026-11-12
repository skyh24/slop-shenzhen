const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const lightShow = loadModule(read('sz-light-show.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, './sz-materials.js': { sceneUniforms: { night: { value: 0 } } },
  './sz-building-layout.js': placement, './sz-polygon.js': polygonModule
} });
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { geo, buildings } = decodeCityPayload(raw);
const towers = buildings.filter(building => building.height >= 160
  && Math.abs(building.cx) < 2600 && building.cz > -1200 && building.cz < 2200);

test('light show plan is deterministic and keeps LED strips on real tower footprints', () => {
  const plan = lightShow.planLightShow(towers, geo.terrain);
  assert.ok(plan.totals.towers >= 50, `large CBD tower set: ${plan.totals.towers}`);
  assert.ok(plan.totals.towers <= towers.length);
  assert.ok(plan.totals.strips >= plan.totals.towers * 3
    && plan.totals.strips <= plan.totals.towers * lightShow.SHOW_STRIPS_PER_TOWER);
  assert.equal(plan.totals.crownSegments, plan.totals.towers * 4);
  const again = lightShow.planLightShow(towers, geo.terrain);
  assert.deepEqual(plan.totals, again.totals);
  for (const tower of plan.towers) {
    assert.ok(tower.height >= lightShow.SHOW_MIN_HEIGHT_M);
    assert.ok(tower.bucket >= 0 && tower.bucket < lightShow.SHOW_BUCKETS);
    for (const strip of tower.strips) {
      assert.ok(Number.isFinite(strip.x) && Number.isFinite(strip.z));
      assert.ok(strip.top - strip.bottom > 20);
      const dx = Math.abs(strip.x - tower.center.x), dz = Math.abs(strip.z - tower.center.z);
      assert.ok(dx > 1 || dz > 1, 'strips sit on the footprint edge, not at the centre');
    }
    for (const segment of tower.crown) assert.ok(segment.widthX > 0 && segment.widthZ > 0);
  }
});

test('light show ignores short towers and towers outside the CBD plan area', () => {
  const fake = { id: 'way/1', height: 160, minHeight: 0, cx: 0, cz: 0, minX: -20, maxX: 20, minZ: -20, maxZ: 20,
    polygons: [{ outer: [{ x: -20, z: -20 }, { x: 20, z: -20 }, { x: 20, z: 20 }, { x: -20, z: 20 }], holes: [] }] };
  const low = { ...fake, height: 90 };
  const farRing = fake.polygons[0].outer.map(point => ({ x: point.x + 20000, z: point.z }));
  const far = { ...fake, id: 'way/2', cx: 20000, cz: 0, polygons: [{ outer: farRing, holes: [] }] };
  const plan = lightShow.planLightShow([fake, low, far], geo.terrain);
  assert.equal(plan.towers.map(tower => tower.id).join(','), 'way/1');
  assert.equal(plan.totals.towers, 1);
});

test('light show skips landmark sources so LED strips stay inside tapered towers', () => {
  const landmarkId = 'overture/825c9559-0144-4342-a025-a1e4b93d49a0';
  const all = lightShow.planLightShow(towers, geo.terrain);
  assert.ok(all.towers.some(tower => tower.id === landmarkId), 'Ping An source tower is planned by default');
  const filtered = lightShow.planLightShow(towers, geo.terrain, { excludeIds: new Set([landmarkId]) });
  assert.equal(filtered.towers.some(tower => tower.id === landmarkId), false);
  assert.equal(filtered.totals.towers, all.totals.towers - 1);
  assert.ok(filtered.totals.strips < all.totals.strips);
  // 把全部在册塔楼都排除（地标接管时 main.js 传入 skipIds）时不应再生成任何灯带。
  const none = lightShow.planLightShow(towers, geo.terrain, { excludeIds: new Set(all.towers.map(tower => tower.id)) });
  assert.equal(none.totals.towers, 0);
  assert.equal(none.totals.strips, 0);
  assert.equal(none.totals.crownSegments, 0);
});

test('landmark steel bands follow the mega column axes and offset outward', () => {
  const ring = (x, z) => [{ x: x - 1, z: z - 1 }, { x: x + 1, z: z - 1 }, { x: x + 1, z: z + 1 }, { x: x - 1, z: z + 1 }];
  const colliders = [
    { name: 'src:mega-column:0:1', loft: { lower: ring(-10, 0), upper: ring(-9, 0) }, minY: 0, maxY: 10 },
    { name: 'src:mega-column:0:2', loft: { lower: ring(-9, 0), upper: ring(-8, 0) }, minY: 10, maxY: 20 },
    { name: 'src:mega-column:1:1', loft: { lower: ring(10, 0), upper: ring(9, 0) }, minY: 0, maxY: 10 },
    { name: 'src:mega-column:1:2', loft: { lower: ring(9, 0), upper: ring(8, 0) }, minY: 10, maxY: 20 },
    { name: 'src:fin:0:0', loft: { lower: ring(0, 10), upper: ring(0, 9) }, minY: 0, maxY: 20 }
  ];
  const bands = lightShow.planLandmarkBands(colliders);
  // 每根柱按源分段出灯带：两根柱各两段，共 4 段。
  assert.equal(bands.rows.length, 4);
  assert.equal(bands.bottom, 0);
  assert.equal(bands.top, 20);
  assert.ok(bands.rows.every(row => row.width > 0 && row.y1 - row.y0 === 10));
  // 灯带落在柱截面外：柱心 -10→-9→-8，截面半宽 1，灯带宽 1.2、离面 0.2。
  const gap = 1.2 / 2 + 0.2;
  const westRows = bands.rows.filter(row => row.x0 < 0);
  const eastRows = bands.rows.filter(row => row.x0 > 0);
  assert.equal(westRows.length, 2);
  assert.equal(eastRows.length, 2);
  assert.ok(Math.abs(westRows[0].x0 - (-10 - 1 - gap)) < 1e-6);
  assert.ok(Math.abs(westRows[0].x1 - (-9 - 1 - gap)) < 1e-6);
  assert.ok(Math.abs(westRows[1].x0 - (-9 - 1 - gap)) < 1e-6);
  assert.ok(Math.abs(westRows[1].x1 - (-8 - 1 - gap)) < 1e-6);
  assert.ok(Math.abs(eastRows[0].x0 - (10 + 1 + gap)) < 1e-6);
  assert.ok(Math.abs(eastRows[1].x1 - (8 + 1 + gap)) < 1e-6);
  assert.equal(lightShow.planLandmarkBands([]), null);
});

test('real Three builds instanced light-show meshes without touching building colliders', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const packageUrl = pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const nightUniform = tsl.uniform(0);
  const showModule = loadModule(read('sz-light-show.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': tsl, './sz-materials.js': { sceneUniforms: { night: nightUniform } },
    './sz-building-layout.js': placement, './sz-polygon.js': polygonModule
  } });
  const scene = new THREE.Scene();
  const ring = (x, z) => [{ x: x - 1, z: z - 1 }, { x: x + 1, z: z - 1 }, { x: x + 1, z: z + 1 }, { x: x - 1, z: z + 1 }];
  const landmarkBands = showModule.planLandmarkBands([
    { name: 'src:mega-column:0:1', loft: { lower: ring(-10, 0), upper: ring(-9, 0) }, minY: 0, maxY: 300 },
    { name: 'src:mega-column:1:1', loft: { lower: ring(10, 0), upper: ring(9, 0) }, minY: 0, maxY: 300 }
  ]);
  const show = showModule.buildSzLightShow(scene, { buildings: towers, terrain: geo.terrain, landmarkBands });
  assert.ok(show.statistics.towers >= 50);
  assert.ok(show.statistics.meshes >= 2);
  assert.equal(show.statistics.landmarkBands, 2);
  assert.equal(show.group.children.length, show.statistics.meshes);
  assert.ok(show.group.children.every(mesh => mesh.isInstancedMesh && mesh.count > 0));
  assert.ok(show.group.children.some(mesh => mesh.name === 'shenzhen-light-show:steel-bands' && mesh.count === 2));
  assert.equal(show.statistics.instances, show.statistics.strips + show.statistics.crownSegments + show.statistics.landmarkBands);
  // 显隐由模块按全局日夜 uniform 自己判断，入口只调用 update()。
  nightUniform.value = 0;
  show.update();
  assert.equal(show.group.visible, false, 'daylight hides the light show');
  nightUniform.value = 0.5;
  show.update();
  assert.equal(show.group.visible, true, 'the show fades in past night 0.25');
  show.dispose();
  assert.equal(show.group.parent, null);
});

test('CBD programme loops through four cues and fades to dark at each transition', () => {
  const { CBD_PROGRAM_SECONDS, cbdProgramPhase, isCbdProgramTower } = loadModule(read('sz-cbd-program.js'), {
    imports: { 'three/webgpu': {}, 'three/tsl': {}, './sz-strings.js': {} }
  });
  assert.equal(CBD_PROGRAM_SECONDS, 96);
  for (const [cue, seconds] of [[0, 0], [1, 24], [2, 48], [3, 72]]) {
    assert.deepEqual({ ...cbdProgramPhase(seconds) }, { cue, phase: 0, fade: 0 });
    assert.equal(cbdProgramPhase(seconds + 12).fade, 1);
    assert.equal(cbdProgramPhase(seconds + CBD_PROGRAM_SECONDS).cue, cue);
  }
  assert.equal(cbdProgramPhase(96).cue, 0);
  const participants = buildings.filter(isCbdProgramTower);
  assert.ok(participants.some(tower => tower.name === '太平金融大厦'));
  assert.ok(participants.some(tower => tower.name === '大百汇广场'));
  assert.ok(participants.every(tower => tower.facade !== 'residential_tower'));
});

test('summit override hides the verified park interiors and keeps the nearby civic centre', () => {
  const { summitBuildingOverrides } = loadModule(read('sz-lianhuashan.js'), {
    imports: { 'three/webgpu': {}, 'three/tsl': {}, 'three/addons/utils/BufferGeometryUtils.js': {},
      './sz-geometry.js': {}, './sz-polygon.js': polygonModule, './sz-controller-surfaces.js': {} }
  });
  const hidden = summitBuildingOverrides(buildings, geo.parks);
  assert.equal(hidden.size, 16);
  assert.ok(hidden.has('way/386491513'));
  assert.ok(hidden.has('way/170144292'));
  assert.ok(!hidden.has('way/41281446'));
  assert.ok(buildings.some(building => building.landmark === 'civic-center' && !hidden.has(building.id)));
  assert.equal(summitBuildingOverrides(buildings, []).size, 0);
});

test('summit spawn and approach use the same above-ground triangles as the model', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const packageUrl = pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const utils = await import(new URL('examples/jsm/utils/BufferGeometryUtils.js', packageUrl));
  const surface = loadModule(read('sz-controller-surfaces.js'));
  const geom = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  const ground = loadModule(read('sz-ground-surface.js'), { globals: { atob } }).createGroundSurfaceSampler(geo.terrainSurface);
  const { buildLianhuashanSummit } = loadModule(read('sz-lianhuashan.js'), {
    imports: { 'three/webgpu': THREE, 'three/tsl': tsl, 'three/addons/utils/BufferGeometryUtils.js': utils,
      './sz-geometry.js': geom, './sz-polygon.js': polygonModule, './sz-controller-surfaces.js': surface }
  });
  const { arrival, surfaces } = buildLianhuashanSummit(new THREE.Scene(), ground);
  const support = surface.createSurfaceResolver({ groundHeight: ground, surfaces });
  const hit = support.at(arrival.x, arrival.z).find(row => row.surfaceId === arrival.surfaceId);
  assert.equal(hit.height, arrival.y);
  assert.ok(hit.height > ground(arrival.x, arrival.z));
  const stairs = surfaces.slice(1);
  assert.ok(stairs.length > 5);
  for (const step of stairs) for (const triangle of step.triangles) {
    const x = triangle.reduce((sum, p) => sum + p.x / 3, 0);
    const z = triangle.reduce((sum, p) => sum + p.z / 3, 0);
    const y = surface.triangleHeight(triangle, x, z);
    assert.ok(y > ground(x, z), step.id);
    assert.equal(support.at(x, z).find(row => row.surfaceId === step.id).height, y);
  }
});
