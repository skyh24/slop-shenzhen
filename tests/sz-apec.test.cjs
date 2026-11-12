// APEC 主题模块回归：布点是纯函数、日期窗口本地时间、贴图不依赖外部素材。
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
// loadModule 在 vm 沙箱里求值，数组原型和宿主 realm 不同，深比较前先过一遍 JSON
const plain = value => JSON.parse(JSON.stringify(value));
const strings = loadModule(read('sz-strings.js'));
const terrain = loadModule(read('sz-terrain.js'));
// 纯函数测试不需要 THREE；空对象证明模块顶层没有解引用 three
const nightUniform = { value: 1 };
const materialsStub = { sceneUniforms: { night: nightUniform } };
const apec = loadModule(read('sz-apec.js'), {
  imports: { 'three/webgpu': {}, './sz-strings.js': strings, './sz-terrain.js': terrain, './sz-polygon.js': polygonModule,
    './sz-materials.js': materialsStub }
});

function lampSite(roadName, x, z = 0, y = 8.4, yaw = Math.PI / 2) {
  return { roadName, x, z, y, yaw, stationM: x + 20 };
}

function planFor(overrides = {}) {
  const landmarks = [
    { id: 'convention-center', name: '会展中心', x: 100, z: 100 },
    { id: 'iec-xiangmihu', name: '国际交流中心', x: -500, z: 200 },
    { id: 'upperhills', name: '深业上城', x: 300, z: -400 },
    { id: 'lianhuashan', name: '莲花山', x: 40, z: -90 }
  ];
  const buildings = [
    { landmark: 'convention-center', minX: 60, maxX: 140, minZ: 70, maxZ: 130, cx: 100, cz: 100 },
    { landmark: 'convention-center', minX: 0, maxX: 10, minZ: 0, maxZ: 10, cx: 5, cz: 5 }
  ];
  return apec.planApecTheme({ landmarks, buildings, ...overrides });
}

test('APEC default window uses the local calendar date', () => {
  assert.equal(apec.APEC_PERIOD.firstDay, '2026-11-11');
  assert.equal(apec.APEC_PERIOD.lastDay, '2026-11-21');
  assert.equal(apec.isApecEnabledAt(new Date(2026, 10, 10)), false);
  assert.equal(apec.isApecEnabledAt(new Date(2026, 10, 11)), true);
  assert.equal(apec.isApecEnabledAt(new Date(2026, 10, 21, 23, 59)), true);
  assert.equal(apec.isApecEnabledAt(new Date(2026, 10, 22, 0, 1)), false);
  assert.equal(apec.isApecEnabledAt(new Date(2025, 10, 18)), false);
  assert.equal(apec.localDayString(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(apec.isApecEnabledAt(new Date(2026, 10, 12), { firstDay: '2026-11-01', lastDay: '2026-11-05' }), false);
  assert.throws(() => apec.isApecEnabledAt(new Date('not a date')), /valid Date/);
});

test('APEC strings live under a new apecTheme key and existing keys are untouched', () => {
  assert.equal(strings.STR.apec, 'APEC 主题');
  assert.equal(strings.STR.apecBanner, 'APEC CHINA 2026 · 深圳 · 11月18—19日');
  const keys = ['label', 'hint', 'bannerLine1', 'bannerLine2', 'newsCenter', 'venueGate', 'venueGateSub',
    'flowerSea', 'flowerBed', 'giftExpo', 'broadcastTruck', 'illustrativeNote'];
  assert.deepEqual(Object.keys(strings.STR.apecTheme).sort(), [...keys].sort());
  for (const key of keys) {
    assert.equal(typeof strings.STR.apecTheme[key], 'string', `STR.apecTheme.${key}`);
    assert.ok(strings.STR.apecTheme[key].length > 0, `STR.apecTheme.${key}`);
  }
});

test('APEC avenue banners use only installed lamp positions and preserve their mounting height', () => {
  const lampSites = [lampSite('深南大道', 20), lampSite('滨河大道辅道', 40, 30),
    lampSite('滨海大道', 60, 50), lampSite('福华路', 80)];
  const sites = apec.bannerSites(lampSites);
  assert.equal(sites.length, 3);
  sites.forEach((site, index) => assert.equal(site, lampSites[index]));
  assert.equal(apec.isApecBannerRoad(''), false);
});

test('sign plan uses real convention-centre bounds and labels illustrative offsets', () => {
  const plan = planFor();
  assert.equal(plan.signs.length, 3);
  const news = plan.signs.find(sign => sign.kind === 'news-center');
  assert.equal(news.x, 100);
  assert.equal(news.z, 138);
  assert.equal(news.source, 'landmark-building-bounds');
  assert.equal(news.text, strings.STR.apecTheme.newsCenter);
  const venue = plan.signs.find(sign => sign.kind === 'venue-gate');
  assert.deepEqual(plain([venue.x, venue.z, venue.source]), [-500, 270, 'landmark-center+illustrative-offset']);
  assert.equal(venue.text, strings.STR.apecTheme.venueGate);
  const gift = plan.signs.find(sign => sign.kind === 'gift-expo');
  assert.deepEqual(plain([gift.x, gift.z]), [300, -355]);
  assert.equal(gift.text, strings.STR.apecTheme.giftExpo);
  assert.equal(plan.trucks.length, 2);
  assert.deepEqual(plain(plan.trucks.map(truck => truck.x)), [89, 111]);
  assert.ok(plan.trucks.every(truck => truck.source === 'illustrative'));
});

test('flower beds sit on verified landmark centres with illustrative layout', () => {
  const plan = planFor();
  assert.deepEqual(plain(plan.flowerBeds.map(bed => bed.id)),
    ['iec-xiangmihu-flower-sea', 'iec-xiangmihu-lake-bed', 'lianhuashan-flower-bed']);
  assert.deepEqual(plain(plan.flowerBeds.map(bed => bed.count)), [220, 160, 300]);
  assert.ok(plan.flowerBeds.every(bed => bed.source.includes('illustrative')));
  assert.equal(apec.summarizeApecPlan(plan).flowers.count, 680);
  const room = apec.planApecTheme({ landmarks: [{ id: 'lianhuashan', x: 5, z: 5 }] });
  assert.equal(room.signs.length, 0);
  assert.equal(room.banners.length, 0);
  assert.equal(room.flowerBeds.length, 1);
});

test('the area argument drops placements outside the playable box', () => {
  const plan = apec.planApecTheme({
    landmarks: [{ id: 'convention-center', x: 1000, z: 1000 }, { id: 'upperhills', x: 100, z: 100 }],
    area: [0, 0, 400, 400]
  });
  assert.deepEqual(plain(plan.signs.map(sign => sign.landmark)), ['upperhills']);
  assert.deepEqual(plain(apec.apecFlowerBeds({ landmarks: [{ id: 'lianhuashan', x: 900, z: 900 }], area: [0, 0, 400, 400] })), []);
});

test('flower layout is deterministic, even and inside the declared ellipse', () => {
  const options = { radiusXM: 10, radiusZM: 5, count: 120, seed: 3 };
  const sites = apec.flowerSites({ x: 20, z: -10 }, options);
  assert.equal(sites.length, 120);
  assert.deepEqual(apec.flowerSites({ x: 20, z: -10 }, options), sites);
  assert.ok(sites.every(site => {
    const nx = (site.x - 20) / options.radiusXM;
    const nz = (site.z + 10) / options.radiusZM;
    return nx * nx + nz * nz <= 1.07 * 1.07;
  }));
  assert.ok(sites.every(site => site.scale >= 0.75 && site.scale <= 1.25));
  assert.deepEqual(plain([...new Set(sites.map(site => site.colorIndex))].sort()), [0, 1, 2, 3]);
  assert.throws(() => apec.flowerSites({ x: 0, z: 0 }, { count: 0 }), /must be positive/);
});

test('full plan placement is deterministic', () => {
  const lampSites = [lampSite('深南大道', 20), lampSite('深南大道', 80)];
  const first = planFor({ lampSites });
  const second = planFor({ lampSites });
  assert.deepEqual(first, second);
  const statistics = apec.summarizeApecPlan(first);
  assert.equal(statistics.banners.count, first.banners.length);
  assert.deepEqual(plain(statistics.banners.roads), ['深南大道']);
  assert.equal(statistics.trucks, 2);
  assert.equal(statistics.approach, 'text-and-colors-only-china-red-apec-purple-no-official-emblem');
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('the runtime builds instanced banners signs and flower beds under the theme switch', { skip: !threeDir }, async () => {
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  // canvas 只在浏览器里真实存在；这里用记录调用的假 canvas 验证贴图路径，不上传 GPU。
  // loadModule 的沙箱有自己的全局对象，所以 document 要通过 globals 注入。
  const drawCalls = [];
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { drawCalls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  const fakeDocument = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  const module = loadModule(read('sz-apec.js'), {
    imports: { 'three/webgpu': THREE, './sz-strings.js': strings, './sz-terrain.js': terrain, './sz-polygon.js': polygonModule,
      './sz-materials.js': materialsStub },
    globals: { document: fakeDocument }
  });
  const scene = new THREE.Scene();
  const lampSites = [lampSite('深南大道', 20, 2), lampSite('滨河大道', 55, 58), lampSite('福华路', 80)];
  {
    const model = module.buildApecTheme(scene, {
      lampSites,
      terrain: null,
      landmarks: [
        { id: 'convention-center', x: 100, z: 100 },
        { id: 'iec-xiangmihu', x: -500, z: 200 },
        { id: 'upperhills', x: 300, z: -400 },
        { id: 'lianhuashan', x: 40, z: -90 }
      ],
      buildings: [{ landmark: 'convention-center', minX: 60, maxX: 140, minZ: 70, maxZ: 130 }],
      now: new Date(2026, 10, 15)
    });
    assert.equal(model.enabled, true);
    assert.equal(model.group.visible, true);
    assert.equal(model.group.name, 'shenzhen-apec-theme');
    assert.equal(model.statistics.banners.count, 2);
    assert.equal(model.statistics.flowers.built, 680);
    assert.equal(model.statistics.signs.length, 3);
    assert.equal(model.statistics.meshes, model.group.children.length);
    const banners = model.group.getObjectByName('apec-banners');
    assert.ok(banners.isInstancedMesh);
    assert.equal(banners.count, 2);
    assert.equal(model.group.getObjectByName('apec-banner-poles'), undefined);
    const matrix = new THREE.Matrix4();
    banners.getMatrixAt(0, matrix);
    assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix)
      .distanceTo(new THREE.Vector3(lampSites[0].x, lampSites[0].y, lampSites[0].z)) < 1e-5);
    assert.equal(model.group.getObjectByName('apec-flowers:lianhuashan-flower-bed').count, 300);
    assert.ok(drawCalls.some(([name]) => name === 'fillText'));
    // 日夜系数直接读全局 uniform：夜间招牌和道旗的自发光变强。
    const emissiveSum = () => {
      let sum = 0;
      model.group.traverse((object) => {
        const value = object.material?.emissiveIntensity;
        if (Number.isFinite(value) && value > 0) sum += value;
      });
      return sum;
    };
    nightUniform.value = 0;
    model.update(0.016);
    const dayEmissive = emissiveSum();
    nightUniform.value = 1;
    model.update(0.016);
    assert.ok(emissiveSum() > dayEmissive, 'APEC signs brighten with sceneUniforms.night');
    // 几何尺寸对得上 APEC 道旗：底边 3.25 米、高 1.6 米，正反两片旗面各一条法线
    const geometries = module.createApecGeometry();
    assert.equal(geometries.banner.attributes.position.count, 8);
    assert.equal(geometries.banner.index.count, 12);
    assert.ok(Math.abs(geometries.banner.boundingBox.min.y - 3.25) < 1e-5);
    assert.ok(Math.abs(geometries.banner.boundingBox.max.y - 4.85) < 1e-5);
    assert.ok(Math.abs(geometries.banner.boundingBox.max.x - geometries.banner.boundingBox.min.x - 0.9) < 1e-5);
    assert.equal(geometries.banner.attributes.normal.getZ(0), 1);
    assert.equal(geometries.banner.attributes.normal.getZ(4), -1);
    assert.equal(geometries.signBoard.attributes.position.count, 4);
    assert.ok(geometries.flower.attributes.position.count <= 30);
    assert.equal(geometries.bed.attributes.normal.getY(0), 1);
    for (const geometry of Object.values(geometries)) geometry.dispose();
    model.update(0.016);
    model.setEnabled(false);
    assert.equal(model.group.visible, false);
    assert.equal(model.enabled, false);
    model.update(0.016);
    model.setEnabled(true);
    assert.equal(model.group.visible, true);
    model.dispose();
    assert.equal(scene.children.includes(model.group), false);
  }
});

test('a non-APEC date starts with the theme hidden', { skip: !threeDir }, async () => {
  const { pathToFileURL: toUrl } = require('node:url');
  const THREE = await import(toUrl(join(threeDir, 'build', 'three.webgpu.js')));
  const module = loadModule(read('sz-apec.js'), {
    imports: { 'three/webgpu': THREE, './sz-strings.js': strings, './sz-terrain.js': terrain, './sz-polygon.js': polygonModule,
      './sz-materials.js': materialsStub }
  });
  const scene = new THREE.Scene();
  const model = module.buildApecTheme(scene, { now: new Date(2026, 10, 9) });
  assert.equal(model.enabled, false);
  assert.equal(model.group.visible, false);
  model.dispose();
});
