const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const { loadFacadeNodes } = require('./helpers/facade-nodes.cjs');
const { dayPhaseStub } = require('./helpers/day-phase.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const readLandmark = file => readFileSync(join(__dirname, '../js/sz-landmarks', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const nightStub = { value: 0 };
const dayPhase = dayPhaseStub(() => nightStub.value, () => 1.25);
const lightShow = loadModule(read('sz-light-show.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, './sz-materials.js': { sceneUniforms: { night: nightStub } },
  './sz-building-layout.js': placement, './sz-polygon.js': polygonModule, './sz-day-phase.js': dayPhase
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

test('landmark loft bands hug the tapered ring vertices of the tallest segments', () => {
  const cx = 5, cz = 7;
  const diamond = radius => [{ x: cx + radius, z: cz }, { x: cx, z: cz + radius },
    { x: cx - radius, z: cz }, { x: cx, z: cz - radius }];
  const radii = [12, 10.8, 9.6, 8.4, 7.2, 6, 4.8];
  const colliders = [];
  for (let i = 0; i < 6; i++) {
    colliders.push({ name: `tower:${i}`, landmarkId: 'test/tower', minY: i * 25, maxY: (i + 1) * 25,
      loft: { lower: diamond(radii[i]), upper: diamond(radii[i + 1]) } });
  }
  const bands = lightShow.planLandmarkBands(colliders);
  // 6 段只取 maxY 最高的 4 段，每段 4 个正交方向各 1 条；每专模上限 8 条，所以实际落在最高的 2 段上。
  assert.equal(bands.rows.length, lightShow.LANDMARK_EDGE_BANDS_PER_LANDMARK);
  assert.equal(bands.rows.length, 8);
  assert.equal(bands.bottom, 100);
  assert.equal(bands.top, 150);
  // 行序是确定性的：先按段高降序，段内按 +x、-x、+z、-z；菱形环四方向各命中一个顶点。
  bands.rows.forEach((row, index) => {
    const [lowerRadius, upperRadius] = index < 4 ? [6, 4.8] : [7.2, 6];
    assert.equal(row.kind, 'loft-edge');
    assert.equal(row.landmarkId, 'test/tower');
    assert.ok(row.width > 0);
    assert.equal(row.y1 - row.y0, 25);
    const lower = Math.abs(row.x0 - cx) + Math.abs(row.z0 - cz);
    const upper = Math.abs(row.x1 - cx) + Math.abs(row.z1 - cz);
    // 端点在环顶点上再外移 0.28 m：菱形上 L1 半径等于环半径，不是包围盒角点（那会是 2×(r+0.28)）。
    assert.ok(Math.abs(lower - (lowerRadius + 0.28)) < 1e-9, `lower reach ${lower}`);
    assert.ok(Math.abs(upper - (upperRadius + 0.28)) < 1e-9, `upper reach ${upper}`);
    assert.ok(lower > lowerRadius, 'lower end sits outside the tower body');
    assert.ok(upper > upperRadius, 'upper end sits outside the tapered body');
    assert.ok(upper < lower, 'bands follow the inward taper');
    assert.ok(Math.hypot(row.x1 - row.x0, row.z1 - row.z0) > 0, 'every band has length');
  });
  assert.equal(Math.min(...bands.rows.map(row => row.y0)), 100, 'only the top segments are banded');
  assert.deepEqual(lightShow.planLandmarkBands(colliders), bands);
});

test('landmark loft bands skip colliders without loft, short towers and towers outside the show area', () => {
  const diamond = (x, z, radius) => [{ x: x + radius, z }, { x, z: z + radius },
    { x: x - radius, z }, { x, z: z - radius }];
  const flat = { name: 'flat', landmarkId: 'test/flat', minX: -10, maxX: 10, minZ: -10, maxZ: 10, minY: 0, maxY: 200 };
  const short = { name: 'short', landmarkId: 'test/short', minY: 0, maxY: 90,
    loft: { lower: diamond(0, 0, 10), upper: diamond(0, 0, 8) } };
  const outside = { name: 'far', landmarkId: 'test/far', minY: 0, maxY: 200,
    loft: { lower: diamond(5000, 0, 10), upper: diamond(5000, 0, 8) } };
  const sliver = { name: 'sliver', landmarkId: 'test/sliver', minY: 0, maxY: 200,
    loft: { lower: [{ x: 0, z: 0 }, { x: 2, z: 0 }], upper: [{ x: 0, z: 0 }, { x: 2, z: 0 }] } };
  assert.equal(lightShow.planLandmarkBands([flat]), null, 'no loft means no invented bands');
  assert.equal(lightShow.planLandmarkBands([short]), null, 'below the 120 m landmark threshold');
  assert.equal(lightShow.planLandmarkBands([outside]), null, 'outside SHOW_AREA');
  assert.equal(lightShow.planLandmarkBands([sliver]), null, 'degenerate rings are skipped');
  // 同组里混入不合格专模时，只保留合格的那一栋。
  const good = { name: 'good', landmarkId: 'test/good', minY: 0, maxY: 150,
    loft: { lower: diamond(0, 0, 10), upper: diamond(0, 0, 8) } };
  const mixed = lightShow.planLandmarkBands([flat, short, outside, good]);
  assert.equal(mixed.rows.length, 4);
  assert.ok(mixed.rows.every(row => row.landmarkId === 'test/good'));
});

test('landmark loft bands ignore mega column colliders that share the landmark id', () => {
  const ring = (x, z, radius) => [{ x: x + radius, z }, { x, z: z + radius },
    { x: x - radius, z }, { x, z: z - radius }];
  const colliders = [
    // 巨柱比普通 loft 更高：若未排除，最高的分段会被它抢占并生成柱面内的边带。
    { name: 'ping-an:mega-column:0:1', landmarkId: 'test/mixed', minY: 0, maxY: 300,
      loft: { lower: ring(60, 100, 1), upper: ring(59, 100, 0.9) } },
    { name: 'test/mixed:shaft', landmarkId: 'test/mixed', minY: 0, maxY: 150,
      loft: { lower: ring(0, 0, 10), upper: ring(0, 0, 5) } }
  ];
  const bands = lightShow.planLandmarkBands(colliders);
  const megaRows = bands.rows.filter(row => row.kind === 'mega-column');
  const edgeRows = bands.rows.filter(row => row.kind === 'loft-edge');
  // 巨柱仍走原路径（柱面外 0.8 m），loft 边灯带只来自普通 loft 分段。
  assert.equal(megaRows.length, 1);
  assert.equal(edgeRows.length, 4);
  assert.ok(edgeRows.every(row => row.landmarkId === 'test/mixed'));
  assert.ok(edgeRows.every(row => row.y1 === 150 && row.y0 === 0), 'only the ordinary loft segment is banded');
  // 巨柱截面在 z≈100，普通 loft 在原点半径 ≤10.28：边带端点不应落在巨柱顶点附近。
  assert.ok(edgeRows.every(row => Math.abs(row.z0) <= 10.28 + 1e-9 && Math.abs(row.z1) <= 5.28 + 1e-9));
  assert.ok(edgeRows.every(row => Math.hypot(row.x0 - 60, row.z0 - 100) > 30), 'mega column vertices never appear');
});
test('landmark loft bands cap each landmark at eight bands and the city at 480', () => {
  const ring = (cx, cz, radius) => [{ x: cx + radius, z: cz }, { x: cx, z: cz + radius },
    { x: cx - radius, z: cz }, { x: cx, z: cz - radius }];
  const colliders = [];
  for (let i = 0; i < 100; i++) {
    const cx = (i % 20) * 280 - 2660;
    const cz = Math.floor(i / 20) * 900 - 1350;
    const id = `city/${String(i).padStart(3, '0')}`;
    for (let j = 0; j < 6; j++) {
      colliders.push({ name: `${id}:${j}`, landmarkId: id, minY: j * 25, maxY: (j + 1) * 25,
        loft: { lower: ring(cx, cz, 12 - j * 1.2), upper: ring(cx, cz, 10.8 - j * 1.2) } });
    }
  }
  const bands = lightShow.planLandmarkBands(colliders);
  assert.equal(bands.rows.length, lightShow.LANDMARK_EDGE_BANDS_CITY_LIMIT);
  assert.equal(bands.rows.length, 480);
  const perLandmark = new Map();
  for (const row of bands.rows) perLandmark.set(row.landmarkId, (perLandmark.get(row.landmarkId) ?? 0) + 1);
  assert.ok([...perLandmark.values()].every(count => count <= lightShow.LANDMARK_EDGE_BANDS_PER_LANDMARK));
  assert.equal([...perLandmark.values()].reduce((sum, count) => sum + count, 0), 480);
  // 全城上限按 landmarkId 顺序截断：前 60 栋各 8 条刚好用满，后面的专模不再生成。
  assert.equal(perLandmark.size, 60);
  assert.deepEqual(lightShow.planLandmarkBands(colliders), bands);
});

test('real Three builds instanced light-show meshes without touching building colliders', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const packageUrl = pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const nightUniform = tsl.uniform(0);
  const showModule = loadModule(read('sz-light-show.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': tsl, './sz-materials.js': { sceneUniforms: { night: nightUniform } },
    './sz-building-layout.js': placement, './sz-polygon.js': polygonModule,
    './sz-day-phase.js': dayPhaseStub(() => nightUniform.value, () => 1.25)
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

test('landmark materials keep a night emissive channel on every lit surface', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const packageUrl = pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const night = tsl.uniform(1);
  const stub = () => new THREE.MeshBasicMaterial();
  const materials = loadModule(readLandmark('materials.js'), { imports: {
    '../sz-rail/geometry.js': { NORTH_FRAME: { center: [0, 0], axis: [1, 0] } },
    'three/webgpu': THREE,
    'three/tsl': tsl,
    '../sz-facade-nodes.js': loadFacadeNodes(tsl),
    '../sz-materials.js': { sceneUniforms: { night, show: night, spec: night } },
    './shenzhen-bay-culture-square.js': { createCulturePavingMask: () => ({}) },
    './upperhills.js': { createUpperhillsMaterial: stub },
    './nonferrous-tower.js': { createNonferrousMaterial: stub },
    './iec-xiangmihu.js': { createIecMaterial: stub },
    './super-hq.js': { createSuperHqMaterial: stub }
  } });
  // 夜景统一后的自发光覆盖面：立面 wash、珍珠立面、冠灯、屋面与场馆材质都必须挂上夜间通道。
  const lit = ['shoppingParkBase', 'shoppingParkGlass', 'stockExchangeTower', 'operaPearl', 'landmarkEdge',
    'pressTowerSteel', 'civicStone', 'civicTowerRed', 'civicTowerYellow', 'stadiumRoof',
    'conventionRoof', 'conventionSkylight', 'djiWing', 'djiEdgeLight', 'djiBrace'];
  for (const name of lit) {
    const material = materials.createLandmarkMaterial(name);
    assert.ok(material.emissiveNode, `${name} keeps an emissive node for the night channel`);
  }
  // 冠灯呼吸只压夜间通道：白天由 night uniform 归零，颜色常量不变。
  const crown = materials.createLandmarkMaterial('landmarkEdge');
  assert.equal(crown.color.getHex(), 0xc0c6c7);
  assert.throws(() => materials.createLandmarkMaterial('no-such-material'), /Unknown landmark material/);
});
