// APEC 城市元素回归：布点计划确定性、机器人椭圆路径有限、西丽站广告面板贴围挡外环线、
// 真实 THREE 构建/夜景/销毁。THREE 依赖用 SZ_THREE_PACKAGE_DIR 指定，未设置时干净 skip。
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (file) => readFileSync(join(__dirname, '../js', file), 'utf8');
// loadModule 在 vm 沙箱里求值，跨 realm 的数组原型深比较前先过一遍 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const terrain = loadModule(read('sz-terrain.js'));
// 纯函数测试不需要 THREE：空对象证明模块顶层没有解引用 three。
const pure = loadModule(read('sz-apec-city.js'), {
  imports: { 'three/webgpu': {}, './sz-terrain.js': terrain }
});

const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const format = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = format.decodeCityPayload(raw);
const collision = loadModule(read('building-collision.js'));

// main.js 从 iec 模型传入的真实门廊/花海锚点（见 js/sz-landmarks/iec-xiangmihu.js 的导出）。
const ANCHORS = {
  iecGate: { x: -2942.59, z: -190.66, yaw: 2.3646, baseY: 16.9 },
  iecFlowerSea: { x: -2930.34, z: -71.95, baseY: 16.6 }
};
const PLAN_INPUT = { landmarks: geo.landmarks, sites: geo.sites, anchors: ANCHORS };
const REAL_PLAN = pure.planApecCityElements(PLAN_INPUT);
const LANDMARKS = new Map(geo.landmarks.map((landmark) => [landmark.id, landmark]));

function xiliRing() {
  return geo.sites['xili-station'].site.polygons[0].outer;
}

function ringCentroid(ring) {
  let x = 0, z = 0, weight = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cross = a.x * b.z - b.x * a.z;
    weight += cross;
    x += (a.x + b.x) * cross;
    z += (a.z + b.z) * cross;
  }
  return { x: x / (3 * weight), z: z / (3 * weight) };
}

function ringPerimeter(ring) {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
}

function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-12 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

// 与 js/sz-station-sites.js 一致：最长边中点就是西丽站大门。
function xiliGate(ring) {
  let best = { index: -1, length: -1 };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length > best.length) best = { index: i, length };
  }
  const a = ring[best.index], b = ring[(best.index + 1) % ring.length];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, widthM: 9 };
}

test('plan places exactly three roadside screens from landmark centres plus illustrative offsets', () => {
  assert.equal(REAL_PLAN.screens.length, 3);
  assert.deepEqual(plain(REAL_PLAN.screens.map((screen) => screen.id)), [
    'apec-led-screen-civic-south', 'apec-led-screen-convention', 'apec-led-screen-super-hq'
  ]);
  assert.deepEqual(plain(REAL_PLAN.screens.map((screen) => screen.landmarkId)),
    ['civic-center', 'convention-center', 'super-hq']);
  for (const screen of REAL_PLAN.screens) {
    const centre = LANDMARKS.get(screen.landmarkId);
    const offset = Math.hypot(screen.x - centre.x, screen.z - centre.z);
    assert.ok(offset > 100 && offset < 520, `${screen.id} offset=${offset}`);
    assert.equal(screen.source, 'landmark-center+illustrative-offset');
    assert.equal(screen.facingSource, 'fixed-yaw-from-osm-road-inspection-2026-11-09');
    assert.equal(screen.heightSource, 'estimate');
  }
  // 两块大屏主标语交替，但两块标语和页脚都在计划里，贴图两张都会画出来。
  assert.deepEqual(plain(REAL_PLAN.screens.map((screen) => screen.primaryLine)),
    [pure.APEC_CITY_SLOGANS.line1, pure.APEC_CITY_SLOGANS.line2, pure.APEC_CITY_SLOGANS.line1]);
  for (const screen of REAL_PLAN.screens) {
    assert.ok(screen.lines.includes(pure.APEC_CITY_SLOGANS.line1));
    assert.ok(screen.lines.includes(pure.APEC_CITY_SLOGANS.line2));
    assert.equal(screen.footer, pure.APEC_CITY_SLOGANS.footer);
    assert.ok(Number.isFinite(screen.yaw) && Number.isFinite(screen.widthM) && Number.isFinite(screen.heightM));
  }
  assert.equal(pure.APEC_CITY_SLOGANS.line1, '相约深圳 见证奇迹');
  assert.equal(pure.APEC_CITY_SLOGANS.line2, '共赴深圳之约 共创美好亚太');
  assert.equal(pure.APEC_CITY_SLOGANS.footer, 'APEC CHINA 2026 · SHENZHEN');
  assert.deepEqual(plain(pure.planApecCityElements(PLAN_INPUT)), plain(REAL_PLAN));
});

test('screen yaw faces the documented roadside and never uses a random angle', () => {
  const civic = REAL_PLAN.screens.find((screen) => screen.landmarkId === 'civic-center');
  const convention = REAL_PLAN.screens.find((screen) => screen.landmarkId === 'convention-center');
  const superHq = REAL_PLAN.screens.find((screen) => screen.landmarkId === 'super-hq');
  // 市民中心南侧屏在深南大道南侧，板面朝北（-z）；其余两块板面朝南（+z）。
  assert.equal(civic.facingZ, -1);
  assert.ok(Math.abs(civic.facingX) < 1e-9);
  assert.equal(convention.facingZ, 1);
  assert.equal(superHq.facingZ, 1);
  for (const screen of REAL_PLAN.screens) {
    assert.ok(Math.abs(Math.hypot(screen.facingX, screen.facingZ) - 1) < 1e-3);
  }
  // 位置避开了地标中心本身，也避开了采样到的既有建筑轮廓。
  for (const screen of REAL_PLAN.screens) {
    const hit = buildings.find((building) => building.polygons
      .some((polygon) => collision.polygonContains(polygon, screen.x, screen.z)));
    assert.equal(hit, undefined, `${screen.id} overlaps building ${hit?.id}`);
  }
});

test('missing landmarks drop screens and robots without throwing', () => {
  const plan = pure.planApecCityElements({ landmarks: [], sites: geo.sites });
  assert.equal(plan.screens.length, 0);
  assert.equal(plan.robots.length, 0);
  assert.ok(plan.missing.some((entry) => entry.kind === 'screen' && entry.reason === 'missing-landmark:civic-center'));
  assert.ok(plan.missing.some((entry) => entry.kind === 'robot'));
  assert.ok(plan.hoardings.length >= 3 && plan.hoardings.length <= 5);
});

test('robots patrol deterministic finite ellipses anchored to the IEC gate and lawn', () => {
  assert.equal(REAL_PLAN.robots.length, 2);
  const [gateRobot, lawnRobot] = REAL_PLAN.robots;
  assert.equal(gateRobot.anchor, 'iecGate');
  assert.equal(gateRobot.anchorSource, 'main-anchor');
  assert.equal(gateRobot.baseY, ANCHORS.iecGate.baseY);
  assert.equal(lawnRobot.anchor, 'iecFlowerSea');
  assert.equal(lawnRobot.anchorSource, 'main-anchor');
  assert.equal(lawnRobot.baseY, ANCHORS.iecFlowerSea.baseY);
  // 入口机器人从门廊中心沿门廊朝向的反方向后退了 14 m，不堵门。
  assert.ok(Math.hypot(gateRobot.x - ANCHORS.iecGate.x, gateRobot.z - ANCHORS.iecGate.z) > 10);
  for (const robot of REAL_PLAN.robots) {
    assert.equal(robot.path.length, pure.ROBOT_PATH_SAMPLES);
    for (const point of robot.path) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.z), `${robot.id} path point finite`);
      const nx = (point.x - robot.x) / robot.radiusXM;
      const nz = (point.z - robot.z) / robot.radiusZM;
      assert.ok(nx * nx + nz * nz <= 1.0001, `${robot.id} point inside patrol ellipse`);
    }
    assert.equal(robot.heightSource, 'estimate');
    assert.ok(robot.speedRadPerSec > 0 && robot.radiusXM > 0 && robot.radiusZM > 0);
  }
  // 机器人不在水面上（会场入口/花海都在台地上）。
  for (const robot of REAL_PLAN.robots) {
    const water = geo.water.find((polygon) => collision.polygonContains(polygon, robot.x, robot.z));
    assert.equal(water, undefined, `${robot.id} anchored in water`);
  }
  assert.deepEqual(plain(pure.planApecRobots(geo.landmarks, ANCHORS)), plain({ robots: REAL_PLAN.robots, missing: [] }));
});

test('robots fall back to the IEC landmark centre when main anchors are missing', () => {
  const { robots } = pure.planApecRobots(geo.landmarks, null);
  assert.equal(robots.length, 2);
  for (const robot of robots) {
    assert.equal(robot.anchorSource, 'landmark-center+illustrative-offset');
    assert.equal(robot.baseY, null);
    assert.ok(robot.path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
  }
});

test('hoarding panels sit on the xili hoarding line and face outward', () => {
  const ring = xiliRing();
  const centre = ringCentroid(ring);
  const gate = xiliGate(ring);
  assert.ok(REAL_PLAN.hoardings.length >= 3 && REAL_PLAN.hoardings.length <= 5,
    `hoarding panels=${REAL_PLAN.hoardings.length}`);
  for (const hoarding of REAL_PLAN.hoardings) {
    // 面板中心沿 OSM 场地外环布置，也就是 3 m 施工围挡的中心线。
    assert.ok(distanceToRing(ring, hoarding.x, hoarding.z) <= 0.5, `${hoarding.id} on polygon edge`);
    // 板面法线朝场地外侧（与“场地中心 -> 面板”方向同侧）。
    const outward = { x: Math.sin(hoarding.yaw), z: Math.cos(hoarding.yaw) };
    const radial = { x: hoarding.x - centre.x, z: hoarding.z - centre.z };
    assert.ok(outward.x * radial.x + outward.z * radial.z > 0, `${hoarding.id} faces outward`);
    assert.ok(Math.abs(outward.x - hoarding.outwardX) < 1e-3 && Math.abs(outward.z - hoarding.outwardZ) < 1e-3);
    // 面板两端仍落在同一段围挡线上，不跨过转角。
    const endpoints = [
      { x: hoarding.x + outward.z * hoarding.widthM / 2, z: hoarding.z - outward.x * hoarding.widthM / 2 },
      { x: hoarding.x - outward.z * hoarding.widthM / 2, z: hoarding.z + outward.x * hoarding.widthM / 2 }
    ];
    assert.ok(endpoints.every((point) => distanceToRing(ring, point.x, point.z) <= 0.9), `${hoarding.id} endpoints on edge`);
    // 面板避开最长边中点的大门（宽 9 m）和施工运输通道。
    assert.ok(Math.hypot(hoarding.x - gate.x, hoarding.z - gate.z) > gate.widthM / 2 + 1, `${hoarding.id} clears gate`);
    assert.equal(hoarding.source, 'osm-way/402048868');
    assert.equal(hoarding.facingSource, 'site-ring-outward-estimate');
    assert.equal(hoarding.heightSource, 'estimate');
    assert.ok(hoarding.widthM > 0 && hoarding.heightM > 0 && hoarding.heightM < pure.XILI_HOARDING_HEIGHT_M);
  }
  // 面板间距不小于 40 m，避免挤在一起。
  const sorted = REAL_PLAN.hoardings.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(Math.hypot(sorted[i].x - sorted[i - 1].x, sorted[i].z - sorted[i - 1].z) > 40);
  }
  assert.ok(Math.abs(ringPerimeter(ring) - pure.XILI_HOARDING_HEIGHT_M * 0) > 0);
  assert.deepEqual(plain(pure.planXiliHoardings(geo.sites)), plain({ hoardings: REAL_PLAN.hoardings, missing: [] }));
});

test('hoarding plan is empty without the xili site and never throws', () => {
  const plan = pure.planXiliHoardings(null);
  assert.equal(plan.hoardings.length, 0);
  assert.equal(plan.missing[0].reason, 'missing-xili-site');
  const full = pure.planApecCityElements({ landmarks: geo.landmarks, sites: null });
  assert.equal(full.hoardings.length, 0);
  assert.equal(full.screens.length, 3);
  assert.equal(full.robots.length, 2);
});

test('statistics count the plan and mark every part as an estimate', () => {
  const statistics = pure.summarizeApecCityPlan(REAL_PLAN);
  assert.equal(statistics.screens, REAL_PLAN.screens.length);
  assert.equal(statistics.robots, REAL_PLAN.robots.length);
  assert.equal(statistics.hoardings, REAL_PLAN.hoardings.length);
  assert.equal(statistics.heightSource, 'estimate');
  assert.equal(statistics.approach, 'text-and-colors-only-china-red-apec-purple-no-official-emblem');
  assert.deepEqual(plain(statistics.built), { screens: 0, robots: 0, hoardings: 0 });
  assert.equal(statistics.parts.length, REAL_PLAN.screens.length + REAL_PLAN.robots.length + REAL_PLAN.hoardings.length);
  assert.ok(statistics.parts.every((part) => part.heightSource === 'estimate'));
  assert.ok(statistics.limitations.length >= 4);
  assert.ok(statistics.screenDetails.every((screen) => screen.footer === pure.APEC_CITY_SLOGANS.footer));
  assert.ok(statistics.robotDetails.every((robot) => robot.anchorSource === 'main-anchor'));
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
const fakeCanvasGlobals = () => {
  const drawCalls = [];
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { drawCalls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  return { document, drawCalls };
};

test('runtime builds screens robots and hoarding panels on the real data, then disposes', { skip: !threeDir }, async () => {
  const loadThree = (file) => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE] = await Promise.all([loadThree('three.webgpu.js')]);
  const { document, drawCalls } = fakeCanvasGlobals();
  const module = loadModule(read('sz-apec-city.js'), {
    imports: { 'three/webgpu': THREE, './sz-terrain.js': terrain },
    globals: { document }
  });
  const scene = new THREE.Scene();
  const model = module.buildApecCityElements(scene, {
    terrain: geo.terrain, landmarks: geo.landmarks, sites: geo.sites, anchors: ANCHORS
  });
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0], model.group);
  assert.equal(model.group.name, 'shenzhen-apec-city-elements');
  assert.equal(model.group.visible, true);
  assert.equal(model.statistics.screens, 3);
  assert.equal(model.statistics.robots, 2);
  assert.ok(model.statistics.hoardings >= 3 && model.statistics.hoardings <= 5);
  assert.deepEqual(plain(model.statistics.built), {
    screens: 3, robots: 2, hoardings: model.statistics.hoardings
  });
  assert.equal(model.screens.length, 3);
  assert.equal(model.robots.length, 2);
  assert.equal(model.hoardings.length, model.statistics.hoardings);
  assert.equal(model.parts.length, model.statistics.parts.length);
  assert.ok(model.parts.every((part) => part.heightSource === 'estimate'));
  assert.ok(model.statistics.meshes > 20, `meshes=${model.statistics.meshes}`);
  assert.ok(model.statistics.triangles > 400, `triangles=${model.statistics.triangles}`);
  assert.equal(model.statistics.drawCallsEstimate, model.statistics.meshes);

  // 三块屏各有一块双面屏面、一块钢框、两根钢柱和两个基础。
  const screenGroups = [];
  const robotGroups = [];
  const hoardingGroups = [];
  model.group.traverse((object) => {
    if (object.name?.startsWith('apec-led-screen:')) screenGroups.push(object);
    if (object.name?.startsWith('apec-patrol-robot:')) robotGroups.push(object);
    if (object.name?.startsWith('apec-hoarding-panel:')) hoardingGroups.push(object);
  });
  assert.equal(screenGroups.length, 3);
  assert.equal(robotGroups.length, 2);
  assert.equal(hoardingGroups.length, model.statistics.hoardings);
  for (const screenGroup of screenGroups) assert.equal(screenGroup.children.length, 6);

  // canvas 2D 真的画了两条中文标语、英文页脚和红色底；不加载外部图片。
  const filledText = drawCalls.filter(([method]) => method === 'fillText').map(([, text]) => text);
  for (const text of [module.APEC_CITY_SLOGANS.line1, module.APEC_CITY_SLOGANS.line2, module.APEC_CITY_SLOGANS.footer]) {
    assert.ok(filledText.includes(text), `canvas missing text: ${text}`);
  }
  assert.ok(drawCalls.some(([method]) => method === 'fillRect'));

  // 机器人确定性巡逻：位置和车轮有限，步长封顶。
  const robotPositionsBefore = robotGroups.map((robotGroup) => robotGroup.position.clone());
  model.update(1.0, 0);
  const robotPositionsAfter = robotGroups.map((robotGroup) => robotGroup.position.clone());
  assert.notDeepEqual(plain(robotPositionsAfter.map((v) => [v.x, v.z])),
    plain(robotPositionsBefore.map((v) => [v.x, v.z])));
  for (const [index, robotGroup] of robotGroups.entries()) {
    assert.ok([robotGroup.position.x, robotGroup.position.y, robotGroup.position.z].every(Number.isFinite));
    assert.ok(Number.isFinite(robotGroup.rotation.y));
    assert.equal(robotGroup.position.y, REAL_PLAN.robots[index].baseY);
  }
  for (const robotGroup of robotGroups) {
    const wheels = robotGroup.children.filter((child) => child.name === 'apec-patrol-robot-wheel');
    assert.equal(wheels.length, 4);
    assert.ok(wheels.every((wheel) => Number.isFinite(wheel.rotation.x)));
    assert.ok(wheels.every((wheel) => Math.abs(wheel.rotation.x) > 0));
  }

  // 夜景：大屏和机器人灯条的自发光强度随 nightFactor 提高。
  const face = model.group.getObjectByName('apec-led-screen-face:apec-led-screen-civic-south');
  assert.ok(face?.material?.emissiveMap);
  model.update(0.016, 0);
  const dayFace = face.material.emissiveIntensity;
  const lightBar = model.group.getObjectByName('apec-patrol-robot-light-bar');
  assert.ok(lightBar?.material);
  const dayLightBar = lightBar.material.emissiveIntensity;
  model.update(0.016, 1);
  assert.ok(face.material.emissiveIntensity > dayFace, 'LED screen brighter at night');
  assert.ok(lightBar.material.emissiveIntensity > dayLightBar, 'robot light bar brighter at night');

  model.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(model.group.parent, null);
  assert.doesNotThrow(() => model.update(0.016, 1));
});

test('runtime builds with a 1x1 fallback texture when canvas is unavailable', { skip: !threeDir }, async () => {
  const loadThree = (file) => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE] = await Promise.all([loadThree('three.webgpu.js')]);
  // 不注入 document：模块必须走 DataTexture 降级路径，构建/销毁都不抛错。
  const module = loadModule(read('sz-apec-city.js'), {
    imports: { 'three/webgpu': THREE, './sz-terrain.js': terrain }
  });
  const scene = new THREE.Scene();
  const model = module.buildApecCityElements(scene, {
    terrain: null, landmarks: geo.landmarks, sites: geo.sites, anchors: ANCHORS
  });
  assert.equal(model.statistics.screens, 3);
  assert.equal(model.statistics.robots, 2);
  assert.ok(model.statistics.hoardings >= 3);
  // 没有地形时地面高度回退 0：大屏落地、机器人按锚点台面标高。
  const civic = model.group.getObjectByName('apec-led-screen:apec-led-screen-civic-south');
  assert.equal(civic.position.y, 0);
  model.update(0.016, 0.5);
  model.dispose();
  assert.equal(scene.children.length, 0);
});

test('runtime with no data builds an empty group instead of throwing', { skip: !threeDir }, async () => {
  const loadThree = (file) => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE] = await Promise.all([loadThree('three.webgpu.js')]);
  const module = loadModule(read('sz-apec-city.js'), {
    imports: { 'three/webgpu': THREE, './sz-terrain.js': terrain }
  });
  const scene = new THREE.Scene();
  const model = module.buildApecCityElements(scene, {});
  assert.equal(model.statistics.screens, 0);
  assert.equal(model.statistics.robots, 0);
  assert.equal(model.statistics.hoardings, 0);
  assert.equal(model.group.children.length, 0);
  model.update(0.016, 1);
  model.dispose();
  assert.equal(scene.children.length, 0);
  assert.throws(() => module.buildApecCityElements(null, {}), /require a scene/);
});
