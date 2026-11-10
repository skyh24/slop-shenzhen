// 深圳国际交流中心（香蜜湖，APEC 2026 主会场）主体体量。
// OSM 没有该会场的建筑轮廓：场地、湖面、湖畔公园来自共享包 sites 段（way/1080860977、way/25482483、
// way/1361069232）。建筑的体量、层高、场地分级全部是显式估计（heightSource='estimate'），
// 不是设计图、总包图纸或竣工尺寸；模型卡 docs/landmarks/iec-xiangmihu.md 记录估计口径。
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry,
  positionWorld, sin, smoothstep, step, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { terrainHeight } from '../sz-terrain.js';
import { blend, footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';

// 无源建筑：模型接管后无需跳过任何源对象；场地轮廓由 layout 从 sites 段传入。
export const sourceIds = [];

// 场地内的既有通用楼（Overture / Globfp 足迹，运行包里仍在渲染）。新会场体量会与它们穿模，
// 由 registry 在接管本模型时按 optionalSkipIds 让位；ids 来自当前共享包内质心落在场地内的建筑。
export const optionalSkipIds = [
  'way/1431482482', 'way/1431482483', 'way/1431884285', 'way/1572116213', 'way/1572116214',
  'way/1572116215', 'way/1572116216',
  'overture/c62d7299-0efa-4c4c-9e81-69aab128f95c', 'overture/705a6399-8375-438e-885e-2b8e13841fe0',
  'overture/05f1882c-2117-4db5-bee1-82083bcb8cf5', 'overture/c87b7838-ac1d-47c4-8f6e-2d3413d312cf',
  'overture/a4da00e6-7d03-444a-a79b-480796eac8c8', 'overture/ca8e0099-46d0-434d-98db-c4b528c16b81',
  'overture/2c61ffe5-b5d0-45a9-8e7a-45907229fdf6', 'overture/ebcc46a6-aae6-43ae-aead-11b6b37d01fe',
  'overture/6cdf2d06-d641-42f6-8aa6-ee2d77255ae6',
  'overture/b4b547a4-cba1-4028-b2c5-c4a4e360041e', 'overture/be89db54-9c18-4d00-9e5c-cc0fa175dd33',
  'overture/237b7bd7-e35b-46ee-8129-8de766a9df74', 'overture/d56e5bf6-e80c-4027-af1e-454123446bc4',
  'overture/8156a63f-cb6a-4faf-9ba0-58a78d94c78b', 'overture/2f62fd12-9f55-42a7-a703-d73dd3086e4f',
  'overture/8a590566-9588-4073-b4e1-14c030df64f6', 'overture/67738848-c5a0-4b73-901f-89308567d646',
  'overture/e316beed-eab5-4a6f-a134-f4f604e1d8f7', 'overture/f93c06e2-ed59-4c06-a8bd-9857ecec2016',
  'globfp/26138', 'globfp/26139', 'globfp/26310', 'globfp/26334', 'globfp/26340', 'globfp/26355', 'globfp/26362'
];

export const siteId = 'iec-xiangmihu';
const SITE_SOURCE_ID = 'site:iec-xiangmihu';

// 入口基准坐标（米制城市坐标，x 向东、z 向南）。原点取场地 way/1080860977 东北侧离湖最近的边界顶点
// （-2929.9,-195.0），INWARD 为该处边界的内法向、ALONG 为沿湖岸向东南的切向；两者单位正交。
// 均为由当前共享包 OSM 几何换算的显式估计基准，不是测绘放样点。
const ORIGIN = Object.freeze({ x: -2929.9, z: -195.0 });
const INWARD = Object.freeze({ x: -0.7015, z: 0.7127 });
const ALONG = Object.freeze({ x: 0.7127, z: 0.7015 });

// 场地分级标高（estimate）：湖侧入口平台最低，向主会议厅逐级抬高。
// 台面标高按各级台地内 DSM 均值取整（入口平台与 gatePoint 地面齐平），不是设计总图标高；
// DSM 为带建筑/树木的表面模型，台地边缘可能被残留地形局部覆盖，模型卡记为已知缺口。
const GATE_DECK = 16.9;
const PLAZA_LEVELS = [GATE_DECK, 19.4, 20.7];
const HALL_BASE = PLAZA_LEVELS[2];
const BANQUET_BASE = HALL_BASE;
const LAWN_DECK = 16.6;
// 酒店落位按场地内各点 DSM 采样取整，避免楼座悬空；仍是估计值。
const HOTEL_BASES = [16.5, 15.1, 17.0];

function framePoint(u, v) {
  return point(ORIGIN.x + INWARD.x * u + ALONG.x * v, ORIGIN.z + INWARD.z * u + ALONG.z * v);
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

// 平面矩形环（frame 的 u/v 轴在 x–z 平面是左手系，loft 要求逆时针，这里统一成逆时针）。
function frameRing(u0, u1, v0, v1) {
  const ring = [framePoint(u0, v0), framePoint(u1, v0), framePoint(u1, v1), framePoint(u0, v1)];
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

// frame 矩形向外/向内的同心截面，loft 用（对应边平行，方向一致）。
function frameBand(uc, vc, halfU, halfV) {
  return frameRing(uc - halfU, uc + halfU, vc - halfV, vc + halfV);
}

function ringCenter(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p.x; z += p.z; }
  return point(x / ring.length, z / ring.length);
}

// 地面采样：只采轮廓顶点和中心，避免整片网格采样带来的随机性；缺 DEM 时返回 null。
function terrainSamples(terrain, ring) {
  const values = [];
  const add = (x, z) => {
    const y = terrainHeight(terrain, x, z);
    if (Number.isFinite(y)) values.push(y);
  };
  for (const p of ring) add(p.x, p.z);
  const center = ringCenter(ring);
  add(center.x, center.z);
  return values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

// 台基底面：压到轮廓内最低地面以下，避免低侧悬空；没有地面采样时按台面下沉。
function footing(terrain, ring, deckY) {
  const samples = terrainSamples(terrain, ring);
  const bottom = samples ? samples.min - 0.8 : deckY - 6;
  return Math.min(bottom, deckY - 1.2);
}

const SITE_SOURCE = Object.freeze({
  id: SITE_SOURCE_ID, height: 90, heightSource: 'estimate', minHeight: 0, cx: ORIGIN.x, cz: ORIGIN.z
});

function volumeSource(height) {
  return { ...SITE_SOURCE, height };
}

// 竖直体量：同 footprintParts 的显示/碰撞共用几何，整段标记 estimate。
function solid(id, ring, bottomY, topY, style) {
  if (!(topY > bottomY)) throw new Error(`Invalid IEC volume height: ${id}`);
  const height = topY - bottomY;
  return footprintParts({ ...volumeSource(height), polygons: [{ outer: ring, holes: [] }] }, bottomY, style, {
    id, min: 0, max: height, derived: true, baseSourceId: SITE_SOURCE_ID
  });
}

function triangle(partId, a, b, c, style, depth, height) {
  return roofPanelPart(partId, volumeSource(height), [a, b, c], depth, style,
    { baseSourceId: SITE_SOURCE_ID });
}

function quadPanels(id, u0, u1, v0, v1, heightAt, depth, style) {
  const parts = [];
  const p = (u, v) => {
    const world = framePoint(u, v);
    return { x: Math.fround(world.x), y: Math.fround(heightAt(u)), z: Math.fround(world.z) };
  };
  const top = Math.max(heightAt(u0), heightAt(u1));
  parts.push(triangle(`${id}:0`, p(u0, v0), p(u1, v0), p(u1, v1), style, depth, top));
  parts.push(triangle(`${id}:1`, p(u0, v0), p(u1, v1), p(u0, v1), style, depth, top));
  return parts;
}

// ---------- 入口前场 ----------

function plazaParts(terrain) {
  // 三级观湖台地：入口平台 → 主厅平台，逐级抬高（估计）。
  // 每级台地底面压到本轮廓最低地面以下，台面标高固定，高差由两组踏步带过渡。
  const terraces = [
    { id: 'gate-platform', u: [4, 34], v: [-26, 18], level: PLAZA_LEVELS[0] },
    { id: 'terrace-1', u: [46, 76], v: [-36, 18], level: PLAZA_LEVELS[1] },
    { id: 'terrace-2', u: [86, 112], v: [-48, 20], level: PLAZA_LEVELS[2] }
  ];
  const parts = [];
  for (const terrace of terraces) {
    const ring = frameRing(terrace.u[0], terrace.u[1], terrace.v[0], terrace.v[1]);
    parts.push(...solid(`iec-xiangmihu:plaza:${terrace.id}`, ring,
      footing(terrain, ring, terrace.level), terrace.level, 'iecPlaza'));
  }
  // 台地之间的踏级带：入口到第一级 5 级（单级约 0.5 m），第一级到主厅平台 3 级。
  const flights = [
    { id: 'flight-0', u: [34, 46], v: [-26, 18], from: PLAZA_LEVELS[0], to: PLAZA_LEVELS[1], count: 5 },
    { id: 'flight-1', u: [76, 86], v: [-42, 18], from: PLAZA_LEVELS[1], to: PLAZA_LEVELS[2], count: 3 }
  ];
  for (const flight of flights) {
    const [u0, u1] = flight.u;
    const stepU = (u1 - u0) / flight.count;
    for (let i = 0; i < flight.count; i++) {
      const a = u0 + stepU * i, b = u0 + stepU * (i + 1);
      const level = blend(flight.from, flight.to, (i + 1) / flight.count);
      const ring = frameRing(a, b, flight.v[0], flight.v[1]);
      parts.push(...solid(`iec-xiangmihu:plaza:${flight.id}:${i}`, ring,
        footing(terrain, ring, level), level, 'iecPlaza'));
    }
  }
  return parts;
}

function gateParts() {
  // 入口门廊：两片石柱 + 横梁 + 薄雨棚，门洞朝湖（-u 方向）；不做会徽，只留门架体量。
  const parts = [];
  const deck = GATE_DECK;
  const pylonTop = deck + 14;
  for (const [i, v] of [[-20, -15], [11, 14]].entries()) {
    const ring = frameRing(8, 15, v[0], v[1]);
    parts.push(...solid(`iec-xiangmihu:gate:pylon:${i}`, ring, deck, pylonTop, 'iecStone'));
  }
  const lintelA = { ...framePoint(11.5, -22), y: pylonTop };
  const lintelB = { ...framePoint(11.5, 14), y: pylonTop };
  parts.push(spanPart('iec-xiangmihu:gate:lintel', volumeSource(2.2), lintelA, lintelB, 6, 6, 2.2,
    'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  const canopyA = { ...framePoint(14, -26), y: pylonTop + 0.9 };
  const canopyB = { ...framePoint(14, 18), y: pylonTop + 0.9 };
  parts.push(spanPart('iec-xiangmihu:gate:canopy', volumeSource(0.5), canopyA, canopyB, 12, 12, 0.55,
    'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  return parts;
}

function flagParts() {
  // 旗杆阵列：入口平台靠湖一排 9 根旗杆，杆顶挂中国红旗面（纯色无图案），与 APEC 主题的红/紫配色一致。
  const parts = [];
  const poleBottom = GATE_DECK;
  const poleTop = poleBottom + 18;
  for (let i = 0; i < 9; i++) {
    const v = -22 + i * 4.5;
    const u = 5.5;
    const lower = frameRing(u - 0.28, u + 0.28, v - 0.28, v + 0.28);
    const upper = frameRing(u - 0.14, u + 0.14, v - 0.14, v + 0.14);
    parts.push(loftPart(`iec-xiangmihu:flagpole:${i}`, volumeSource(18), lower, upper, poleBottom, poleTop,
      'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
    const a = { ...framePoint(u, v), y: poleTop };
    const b = { ...framePoint(u, v + 2.6), y: poleTop - 0.35 };
    parts.push(spanPart(`iec-xiangmihu:flag:${i}`, volumeSource(3), a, b, 0.07, 0.07, 3,
      'iecFlag', { baseSourceId: SITE_SOURCE_ID }));
  }
  return parts;
}

// ---------- 主会议厅 ----------

function hallParts(terrain) {
  const parts = [];
  const u0 = 112, u1 = 222, v0 = -104, v1 = 86;
  const plinthRing = frameRing(106, 228, -110, 92);
  const plinthBottom = footing(terrain, plinthRing, HALL_BASE);
  parts.push(...solid('iec-xiangmihu:hall:plinth', plinthRing, plinthBottom, HALL_BASE, 'iecStone'));
  const bodyRing = frameRing(u0, u1, v0, v1);
  const stoneTop = HALL_BASE + 3.4;
  parts.push(...solid('iec-xiangmihu:hall:base', bodyRing, HALL_BASE, stoneTop, 'iecStone'));
  const eave = HALL_BASE + 26;
  parts.push(...solid('iec-xiangmihu:hall:glass', bodyRing, stoneTop, eave, 'iecGlass'));

  // 大屋盖：长轴沿湖岸（v），截面为抛物线，檐口 26 m、屋脊 40 m（相对 HALL_BASE 的估计）。
  const roofU0 = 106, roofU1 = 228, roofV0 = -110, roofV1 = 92;
  const ridge = HALL_BASE + 40;
  const center = (roofU0 + roofU1) / 2, half = (roofU1 - roofU0) / 2;
  const roofHeight = u => ridge - (ridge - eave) * ((u - center) / half) ** 2;
  const stations = 10;
  for (let i = 0; i < stations; i++) {
    const a = blend(roofU0, roofU1, i / stations);
    const b = blend(roofU0, roofU1, (i + 1) / stations);
    parts.push(...quadPanels(`iec-xiangmihu:hall:roof:${i}`, a, b, roofV0, roofV1, roofHeight, 0.8, 'iecRoof'));
  }
  for (const [i, u] of [[0, roofU0], [1, roofU1]]) {
    const a = { ...framePoint(u, roofV0), y: eave };
    const b = { ...framePoint(u, roofV1), y: eave };
    parts.push(spanPart(`iec-xiangmihu:hall:fascia:${i}`, volumeSource(1.8), a, b, 1.5, 1.5, 1.8,
      'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  }
  const ridgeA = { ...framePoint(center, roofV0), y: ridge + 0.5 };
  const ridgeB = { ...framePoint(center, roofV1), y: ridge + 0.5 };
  parts.push(spanPart('iec-xiangmihu:hall:ridge', volumeSource(1.4), ridgeA, ridgeB, 2, 2, 1.4,
    'iecRoof', { baseSourceId: SITE_SOURCE_ID }));

  // 入口雨棚：从主厅玻璃幕墙向观湖台地挑出 16 m，4 根柱落在台地上。
  const canopyY = HALL_BASE + 14;
  const canopyA = { ...framePoint(104, -46), y: canopyY };
  const canopyB = { ...framePoint(104, 46), y: canopyY };
  parts.push(spanPart('iec-xiangmihu:hall:canopy', volumeSource(1), canopyA, canopyB, 16, 16, 1.05,
    'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  for (const [i, v] of [-40, -14, 14, 40].entries()) {
    const ring = frameRing(96, 99.6, v - 1.8, v + 1.8);
    parts.push(...solid(`iec-xiangmihu:hall:canopy-column:${i}`, ring, HALL_BASE, canopyY - 0.6, 'iecStone'));
  }
  return parts;
}

// ---------- 宴会厅 / 多功能厅 ----------

function banquetParts(terrain) {
  const parts = [];
  const u0 = 118, u1 = 202, v0 = -178, v1 = -118;
  const plinthRing = frameRing(112, 208, -184, -112);
  parts.push(...solid('iec-xiangmihu:banquet:plinth', plinthRing,
    footing(terrain, plinthRing, BANQUET_BASE), BANQUET_BASE, 'iecStone'));
  const bodyRing = frameRing(u0, u1, v0, v1);
  const stoneTop = BANQUET_BASE + 3.2;
  parts.push(...solid('iec-xiangmihu:banquet:base', bodyRing, BANQUET_BASE, stoneTop, 'iecStone'));
  const eave = BANQUET_BASE + 18;
  parts.push(...solid('iec-xiangmihu:banquet:glass', bodyRing, stoneTop, eave, 'iecGlass'));

  const roofU0 = 114, roofU1 = 206, roofV0 = -182, roofV1 = -114;
  const ridge = BANQUET_BASE + 22.8;
  const center = (roofU0 + roofU1) / 2, half = (roofU1 - roofU0) / 2;
  const roofHeight = u => ridge - (ridge - eave) * ((u - center) / half) ** 2;
  const stations = 4;
  for (let i = 0; i < stations; i++) {
    const a = blend(roofU0, roofU1, i / stations);
    const b = blend(roofU0, roofU1, (i + 1) / stations);
    parts.push(...quadPanels(`iec-xiangmihu:banquet:roof:${i}`, a, b, roofV0, roofV1, roofHeight, 0.7, 'iecRoof'));
  }
  for (const [i, u] of [[0, roofU0], [1, roofU1]]) {
    const a = { ...framePoint(u, roofV0), y: eave };
    const b = { ...framePoint(u, roofV1), y: eave };
    parts.push(spanPart(`iec-xiangmihu:banquet:fascia:${i}`, volumeSource(1.5), a, b, 1.3, 1.3, 1.5,
      'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  }

  // 主厅与宴会厅之间的连接体（二层连廊 + 屋面），按分段实体建模，不填成整块。
  const linkRing = frameRing(130, 190, -118, -100);
  parts.push(...solid('iec-xiangmihu:banquet:link', linkRing, BANQUET_BASE, BANQUET_BASE + 12, 'iecGlass'));
  parts.push(...solid('iec-xiangmihu:banquet:link-roof', frameRing(126, 194, -122, -96),
    BANQUET_BASE + 12, BANQUET_BASE + 12.9, 'iecRoof'));
  return parts;
}

// ---------- 五洲酒店建筑群 ----------

const HOTELS = [
  {
    id: 'wuzhou-a', center: [263, -143], half: [23, 21], base: HOTEL_BASES[0], height: 66,
    plinth: [238, 288, -168, -118],
    tiers: [[0, 26, 46, 42, 40, 36], [26, 52, 40, 36, 34, 30], [52, 62, 34, 30, 28, 24]]
  },
  {
    id: 'wuzhou-b', center: [264, -81], half: [20, 19], base: HOTEL_BASES[1], height: 52,
    plinth: [240, 288, -105, -57],
    tiers: [[0, 17, 40, 38, 36, 34], [17, 34, 36, 34, 32, 30], [34, 47, 32, 30, 26, 24]]
  },
  {
    id: 'wuzhou-c', center: [304, -14], half: [18, 18], base: HOTEL_BASES[2], height: 42,
    plinth: [282, 326, -36, 8],
    tiers: [[0, 14, 36, 36, 33, 33], [14, 28, 33, 33, 30, 30], [28, 38, 30, 30, 26, 26]]
  }
];

function hotelParts(terrain) {
  const parts = [];
  for (const hotel of HOTELS) {
    const plinthRing = frameRing(...hotel.plinth);
    parts.push(...solid(`iec-xiangmihu:${hotel.id}:plinth`, plinthRing,
      footing(terrain, plinthRing, hotel.base), hotel.base, 'iecStone'));
    const [uc, vc] = hotel.center;
    hotel.tiers.forEach(([from, to, lowU, lowV, highU, highV], index) => {
      const lower = frameBand(uc, vc, lowU / 2, lowV / 2);
      const upper = frameBand(uc, vc, highU / 2, highV / 2);
      parts.push(loftPart(`iec-xiangmihu:${hotel.id}:tier:${index}`, volumeSource(to - from), lower, upper,
        hotel.base + from, hotel.base + to, 'iecHotel', { baseSourceId: SITE_SOURCE_ID }));
    });
    const last = hotel.tiers.at(-1);
    const crownBase = hotel.base + last[1];
    const crownHeight = hotel.height;
    const crownLower = frameBand(uc, vc, last[4] / 2, last[5] / 2);
    const crownUpper = frameBand(uc, vc, Math.max(6, last[4] / 2 - 3), Math.max(5, last[5] / 2 - 3));
    parts.push(loftPart(`iec-xiangmihu:${hotel.id}:crown`, volumeSource(crownHeight - (crownBase - hotel.base)),
      crownLower, crownUpper, crownBase, hotel.base + crownHeight, 'iecRoof', { baseSourceId: SITE_SOURCE_ID }));
  }
  // 酒店公共裙房：把两栋酒店在首层连起来，高度低于塔楼，避免整块填成塔楼体量。
  parts.push(...solid('iec-xiangmihu:wuzhou-lobby', frameRing(236, 292, -122, -100),
    footing(terrain, frameRing(236, 292, -122, -100), 25), 25, 'iecHotel'));
  return parts;
}

// ---------- 香蜜湖花海边界 ----------

function flowerParts(terrain) {
  // 湖侧花田台地：只做草坪台面与石质围边，具体花丛由 js/sz-apec.js 的示意花床实例覆盖
  // （对齐 flowerSeaAnchor 与 flowerSeaDeckY）。不在水面放任何体量。
  const lawnRing = frameRing(72, 104, 70, 102);
  const parts = [...solid('iec-xiangmihu:flower-lawn', lawnRing,
    footing(terrain, lawnRing, LAWN_DECK), LAWN_DECK, 'iecGreen')];
  const curb = {
    outer: frameRing(70, 106, 68, 104),
    holes: [frameRing(72, 104, 70, 102)]
  };
  const curbHeight = 1.1;
  parts.push(...footprintParts({ ...volumeSource(curbHeight), polygons: [curb] }, LAWN_DECK - 0.1, 'iecStone', {
    id: 'iec-xiangmihu:flower-curb', min: 0, max: curbHeight, derived: true, baseSourceId: SITE_SOURCE_ID
  }));
  return parts;
}

// ---------- 入口与花海定位（APEC 主题模块对齐用） ----------

// 入口门洞中心（门廊下、入口平台面上）。APEC 立体字与道旗应从 gatePoint 沿 gateYaw 朝向摆放。
export const gatePoint = Object.freeze({ x: framePoint(12, -6).x, z: framePoint(12, -6).z });
// APEC 标识板的朝向：板面法线朝湖（+gateYaw 为 three.js 的 rotation.y）。
export const gateYaw = Math.atan2(-INWARD.x, -INWARD.z);
export const gateDeckY = GATE_DECK;
// 香蜜湖花海中心（湖侧花田台地）与台面标高；花床/花丛实例的原点应落在 flowerSeaDeckY。
export const flowerSeaAnchor = Object.freeze({ x: framePoint(88, 86).x, z: framePoint(88, 86).z });
export const flowerSeaDeckY = LAWN_DECK;

// ---------- 构建 ----------

/** 解析：香蜜湖国际交流中心（APEC 2026 主会场）程序化建模。
 *  输入：source（不用）、terrain、context.sites['iec-xiangmihu']（场地/湖/湖畔公园）。
 *  输出：97 部件（主厅大屋盖、宴会厅、酒店 3 塔、门廊/旗杆/台地）；全部 heightSource='estimate'；
 *        所有顶点在 way/1080860977 内且不进湖。gate/flowerSea 锚点供 APEC 元素对齐。 */
export function build(source, terrain, context = {}) {
  const sites = context?.sites;
  const site = sites?.site;
  if (!site || !Array.isArray(site.polygons) || site.polygons.length === 0) return [];
  const outline = site.polygons[0]?.outer;
  if (!Array.isArray(outline) || outline.length < 3) return [];
  if (!terrain || !Number.isFinite(terrain.step) || !Number.isFinite(terrain.nx)) return [];
  const parts = [
    ...plazaParts(terrain),
    ...gateParts(),
    ...flagParts(),
    ...hallParts(terrain),
    ...banquetParts(terrain),
    ...hotelParts(terrain),
    ...flowerParts(terrain)
  ];
  // 统一来源标注：合成场地 id + 显式估计；基底取当地 DSM 采样，不代表真实基础标高。
  return parts.map(part => ({
    ...part,
    heightSource: 'estimate',
    sourceId: SITE_SOURCE_ID,
    baseSource: 'dem-site-local-sample',
    baseSourceId: SITE_SOURCE_ID,
    layoutSource: 'derived'
  }));
}

// ---------- 材质 ----------

// 7 种样式：屋盖/钢构、玻璃幕墙、石材、铺装、酒店立面、草坪、红旗（不画会徽）。
export const IEC_STYLES = Object.freeze([
  'iecRoof', 'iecGlass', 'iecStone', 'iecPlaza', 'iecHotel', 'iecGreen', 'iecFlag'
]);

function facadeStyle(style) {
  const material = new THREE.MeshStandardNodeMaterial();
  const coord = uv();
  const bay = coord.x.div(style.bay);
  const level = coord.y.div(style.floor);
  const x = abs(fract(bay).sub(0.5));
  const y = abs(fract(level).sub(0.5));
  const wX = max(fwidth(bay), 0.004);
  const wY = max(fwidth(level), 0.004);
  const detail = smoothstep(0.2, 0.75, max(wX, wY)).oneMinus();
  const pane = mix(float((1 - style.fin) * (1 - style.sill)),
    smoothstep(0.5 - style.fin / 2 - wX, 0.5 - style.fin / 2 + wX, x).oneMinus()
      .mul(smoothstep(0.5 - style.sill / 2 - wY, 0.5 - style.sill / 2 + wY, y).oneMinus()), detail);
  const noise = fract(sin(dot(vec2(floor(bay), floor(level)), vec2(12.9898, 78.233))).mul(43758.5453));
  const wall = smoothstep(0.15, 0.65, abs(normalWorldGeometry.y)).oneMinus();
  const view = cameraPosition.sub(positionWorld).normalize();
  const fresnel = abs(dot(view, normalWorldGeometry)).oneMinus().pow(2.4);
  const tint = color(style.glass).mul(mix(float(0.95), noise.mul(0.2).add(0.85), detail));
  const glazing = mix(tint, color(0xa6becd), fresnel.mul(sceneUniforms.night.oneMinus()).mul(0.3));
  material.colorNode = mix(color(style.roof), mix(color(style.frame), glazing, pane), wall);
  material.metalnessNode = mix(float(0.12), mix(float(0.34), float(0.22), pane), wall);
  material.roughnessNode = mix(float(0.74), mix(float(0.42), float(style.rough ?? 0.24), pane), wall);
  const lit = mix(float(style.lit * 0.24), step(noise, style.lit), detail).mul(0.5);
  material.emissiveNode = color(style.glow).mul(lit).mul(pane).mul(wall).mul(sceneUniforms.night);
  return material;
}

function plazaMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.04 });
  const gx = positionWorld.x.div(3.2);
  const gz = positionWorld.z.div(3.2);
  const joint = cell => smoothstep(0.455, 0.5, abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.12, 0.6, fwidth(cell)).oneMinus());
  const seam = max(joint(gx), joint(gz));
  const upper = smoothstep(0.1, 0.5, normalWorldGeometry.y);
  material.colorNode = mix(color(0x9a9b95), mix(color(0xcac9c1), color(0xa9aaa2), seam), upper);
  material.roughnessNode = mix(float(0.86), mix(float(0.8), float(0.62), seam), upper);
  return material;
}

function roofMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.44, metalness: 0.32 });
  const along = positionWorld.x.mul(ALONG.x).add(positionWorld.z.mul(ALONG.z)).div(1.15);
  const rib = smoothstep(0.42, 0.5, abs(fract(along).sub(0.5)))
    .mul(smoothstep(0.15, 0.62, fwidth(along)).oneMinus());
  const upper = smoothstep(0.05, 0.5, normalWorldGeometry.y);
  material.colorNode = mix(color(0x8f989b), mix(color(0xdfe3e2), color(0xb4bab9), rib), upper);
  material.roughnessNode = mix(float(0.7), float(0.38), upper);
  material.emissiveNode = color(0xa9c8de).mul(upper).mul(sceneUniforms.night).mul(0.08);
  return material;
}

function greenMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.02 });
  const stripes = sin(positionWorld.x.mul(0.36).add(positionWorld.z.mul(0.21))).mul(0.5).add(0.5);
  material.colorNode = mix(color(0x38502f), color(0x5d7a3c), stripes.mul(0.7).add(0.3));
  return material;
}

/** 解析：国际交流中心材质分派（iecRoof/iecGlass/iecStone/iecPlaza/iecHotel/iecGreen/iecFlag）。
 *  输入：样式名。
 *  输出：对应 MeshStandardNodeMaterial；未知名抛错。 */
export function createIecMaterial(name) {
  switch (name) {
    case 'iecRoof':
      return roofMaterial();
    case 'iecGlass':
      return facadeStyle({ frame: 0x7d8f97, glass: 0x46606d, roof: 0x7a888b, bay: 2.6, floor: 6.4,
        fin: 0.09, sill: 0.06, lit: 0.1, rough: 0.2, glow: 0xeedfc5 });
    case 'iecStone':
      return new THREE.MeshStandardNodeMaterial({ color: 0xc3c2ba, roughness: 0.76, metalness: 0.03 });
    case 'iecPlaza':
      return plazaMaterial();
    case 'iecHotel':
      return facadeStyle({ frame: 0x9aa2a0, glass: 0x4d6570, roof: 0x848b88, bay: 3.4, floor: 3.6,
        fin: 0.14, sill: 0.16, lit: 0.13, rough: 0.3, glow: 0xffd8a8 });
    case 'iecGreen':
      return greenMaterial();
    case 'iecFlag':
      return new THREE.MeshStandardNodeMaterial({ color: 0xc8102e, roughness: 0.8, metalness: 0.02,
        emissive: 0x33060c, emissiveIntensity: 0.4 });
    default:
      throw new Error(`Unknown IEC material: ${name}`);
  }
}
