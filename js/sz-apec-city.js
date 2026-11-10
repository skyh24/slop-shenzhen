// APEC 2026 城市元素：路侧双面 LED 大屏、会场巡逻机器人、西丽站围挡公益广告。
// 全部为展示示意（heightSource = 'estimate'）：只用文字、中国红和 APEC 紫，不画 APEC 官方会徽，
// 也不加载外部素材，文字贴图全部在运行时用 canvas 2D 绘制；没有 canvas 时退回 1×1 纯色贴图。
// 本模块不建碰撞体：大屏、机器人、广告面板都是装饰，交由 Lead 决定是否补碰撞。
import * as THREE from 'three/webgpu';
import { terrainHeight } from './sz-terrain.js';

export const APEC_CITY_COLORS = Object.freeze({
  chinaRed: 0xc8102e,
  apecPurple: 0x5a2a66,
  gold: 0xd8b45a,
  white: 0xf5f1ea,
  steel: 0x4a4f55,
  darkSteel: 0x24282c,
  screenFrame: 0x171b1e,
  robotBody: 0xe8e6e1,
  robotDark: 0x2a2f33,
  lawn: 0x3f5e33
});

// 标语来自 docs/11-MVP.md 第 199 行（APEC 周城市氛围：公交站和楼宇外屏“万屏联动”）。
export const APEC_CITY_SLOGANS = Object.freeze({
  line1: '相约深圳 见证奇迹',
  line2: '共赴深圳之约 共创美好亚太',
  footer: 'APEC CHINA 2026 · SHENZHEN'
});

// 三处路侧大屏：位置 = 已核实地标中心 + 固定示意偏移（米，x 向东、z 向南）。
// 偏移量按 2026-11-09 OSM 路网人工检查选取：civic-center 屏幕落在深南大道南侧人行道边，
// convention-center 屏幕落在滨河大道北侧，super-hq 屏幕落在白石四道北侧；朝向也按同一次检查固定，
// 不是逐块屏的实测位置和朝向。yaw 的板面法线为 (sin(yaw), cos(yaw))。
export const SCREEN_SITE_DEFS = Object.freeze([
  { id: 'apec-led-screen-civic-south', landmarkId: 'civic-center', label: '市民中心南侧',
    offsetX: 40, offsetZ: 466, yaw: Math.PI, facingNote: '面向深南大道（北侧）',
    widthM: 8.4, heightM: 4.6, bottomM: 2.6 },
  { id: 'apec-led-screen-convention', landmarkId: 'convention-center', label: '会展中心',
    offsetX: 74, offsetZ: 175, yaw: 0, facingNote: '面向滨河大道（南侧）',
    widthM: 8.4, heightM: 4.6, bottomM: 2.6 },
  { id: 'apec-led-screen-super-hq', landmarkId: 'super-hq', label: '深圳湾超级总部基地',
    offsetX: 30, offsetZ: -164, yaw: 0, facingNote: '面向白石四道（南侧）',
    widthM: 8.4, heightM: 4.6, bottomM: 2.6 }
]);

// 两台巡逻机器人：分别绕会场入口平台和花海草坪做确定性椭圆巡逻。
// 没有 main 传入的门廊/花海锚点时，退回“会场地标中心 + 示意偏移”，仍标 estimate。
export const ROBOT_PATROL_DEFS = Object.freeze([
  { id: 'apec-patrol-robot-01', anchor: 'iecGate', label: '会场入口巡逻', inwardM: 14,
    radiusXM: 12, radiusZM: 8, speedRadPerSec: 0.32, phase: 0.4, lightColour: 0xc8102e,
    fallbackOffset: { x: 184.4, z: -74.4 } },
  { id: 'apec-patrol-robot-02', anchor: 'iecFlowerSea', label: '花海草坪巡逻', inwardM: 0,
    radiusXM: 10, radiusZM: 7, speedRadPerSec: 0.25, phase: 2.3, lightColour: 0x7a2f8f,
    fallbackOffset: { x: 196.7, z: 44.4 } }
]);

export const ROBOT_PATH_SAMPLES = 48;
// 西丽站围挡总高 3 m、厚 0.25 m（与 js/sz-station-sites.js 的施工围挡一致），广告面板挂在围挡外侧面。
export const XILI_HOARDING_HEIGHT_M = 3;
export const XILI_HOARDING_THICKNESS_M = 0.25;
export const HOARDING_PANEL_WIDTH_M = 4.8;
export const HOARDING_PANEL_HEIGHT_M = 1.9;
export const HOARDING_PANEL_CENTER_M = 1.55;
export const HOARDING_PANEL_OFFSET_M = XILI_HOARDING_THICKNESS_M / 2 + 0.02;
export const SCREEN_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

// ---------- 纯函数：布点计划（不依赖 renderer，可在 node 测试） ----------

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function landmarkCenter(landmarks, id) {
  const landmark = (landmarks ?? []).find((item) => item?.id === id);
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.z)) return null;
  return { x: landmark.x, z: landmark.z };
}

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

function ringPerimeter(ring) {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
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
  if (Math.abs(weight) < 1e-9) {
    return { x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
      z: ring.reduce((sum, point) => sum + point.z, 0) / ring.length };
  }
  return { x: x / (3 * weight), z: z / (3 * weight) };
}

// 外环点列表：共享包 sites 段的解码结果是 { outer: [{x,z}], holes: [] }
function outerRings(site) {
  const rings = [];
  for (const polygon of site?.polygons ?? []) {
    const outer = polygon?.outer;
    if (Array.isArray(outer) && outer.length >= 3 && outer.every(finitePoint)) rings.push(outer);
  }
  return rings;
}

function largestRing(rings) {
  let best = rings[0];
  for (const ring of rings) if (ringArea(ring) > ringArea(best)) best = ring;
  return best;
}

// 沿外环按周长比例取点，同时给出该处单位切线（x 向东、z 向南）
function sampleRing(ring, t) {
  const perimeter = ringPerimeter(ring);
  let target = (((t % 1) + 1) % 1) * perimeter;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (target <= length || i === ring.length - 1) {
      const u = length > 1e-9 ? Math.min(1, target / length) : 0;
      return {
        x: a.x + (b.x - a.x) * u,
        z: a.z + (b.z - a.z) * u,
        dx: length > 1e-9 ? (b.x - a.x) / length : 0,
        dz: length > 1e-9 ? (b.z - a.z) / length : 0
      };
    }
    target -= length;
  }
  const a = ring[0], b = ring[1];
  return { x: a.x, z: a.z, dx: b.x - a.x, dz: b.z - a.z };
}

function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-12 ? clampNumber(((x - a.x) * dx + (z - a.z) * dz) / lengthSq, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

function sampleEllipse(center, radiusXM, radiusZM, phase, count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = phase + (i / count) * Math.PI * 2;
    points.push({ x: center.x + Math.cos(angle) * radiusXM, z: center.z + Math.sin(angle) * radiusZM });
  }
  return points;
}

/** 解析：APEC 路侧 LED 大屏布点计划（3 块，双面）。
 *  输入：GEO.landmarks（已核实中心点）。
 *  输出：{ x, z, yaw, widthM, heightM, primaryLine, source }；偏移是展示估计，非逐屏测绘。 */
export function planApecScreens(landmarks = []) {
  const screens = [];
  const missing = [];
  for (const [index, def] of SCREEN_SITE_DEFS.entries()) {
    const center = landmarkCenter(landmarks, def.landmarkId);
    if (!center) {
      missing.push({ kind: 'screen', id: def.id, reason: `missing-landmark:${def.landmarkId}` });
      continue;
    }
    const facing = { x: Math.sin(def.yaw), z: Math.cos(def.yaw) };
    screens.push({
      id: def.id,
      landmarkId: def.landmarkId,
      label: def.label,
      x: center.x + def.offsetX,
      z: center.z + def.offsetZ,
      yaw: def.yaw,
      facingX: round(facing.x),
      facingZ: round(facing.z),
      facingNote: def.facingNote,
      widthM: def.widthM,
      heightM: def.heightM,
      bottomM: def.bottomM,
      primaryLine: index % 2 === 0 ? APEC_CITY_SLOGANS.line1 : APEC_CITY_SLOGANS.line2,
      lines: [APEC_CITY_SLOGANS.line1, APEC_CITY_SLOGANS.line2],
      footer: APEC_CITY_SLOGANS.footer,
      source: 'landmark-center+illustrative-offset',
      facingSource: 'fixed-yaw-from-osm-road-inspection-2026-11-09',
      heightSource: 'estimate'
    });
  }
  return { screens, missing };
}

// 锚点优先用 main 传入的会场模型门廊/花海点；缺失时退回地标中心加示意偏移。
function resolveRobotAnchor(def, landmarks, anchors) {
  const raw = def.anchor === 'iecFlowerSea'
    ? anchors?.iecFlowerSea ?? anchors?.flowerSea
    : anchors?.[def.anchor];
  if (finitePoint(raw)) {
    const yaw = Number.isFinite(raw.yaw) ? raw.yaw : null;
    // 从门廊中心沿门廊朝向的反方向退一段，避免机器人堵在门口；朝向语义见 iec 模型 gateYaw。
    const inward = yaw === null ? { x: 0, z: 0 } : { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    return {
      x: raw.x + inward.x * def.inwardM,
      z: raw.z + inward.z * def.inwardM,
      baseY: Number.isFinite(raw.baseY) ? raw.baseY : null,
      anchorSource: 'main-anchor'
    };
  }
  const center = landmarkCenter(landmarks, 'iec-xiangmihu');
  if (!center) return null;
  return {
    x: center.x + def.fallbackOffset.x,
    z: center.z + def.fallbackOffset.z,
    baseY: null,
    anchorSource: 'landmark-center+illustrative-offset'
  };
}

/** 解析：会场周边巡逻机器人布点与巡逻椭圆参数。
 *  输入：landmarks、IEC 门廊/花海锚点（来自模型导出的真实台面标高）。
 *  输出：2 台机器人的中心、半径、相位、灯条参数；确定性、无随机。 */
export function planApecRobots(landmarks = [], anchors = null) {
  const robots = [];
  const missing = [];
  for (const def of ROBOT_PATROL_DEFS) {
    const anchor = resolveRobotAnchor(def, landmarks, anchors);
    if (!anchor) {
      missing.push({ kind: 'robot', id: def.id, reason: 'missing-iec-anchor-and-landmark' });
      continue;
    }
    robots.push({
      id: def.id,
      label: def.label,
      anchor: def.anchor,
      anchorSource: anchor.anchorSource,
      x: anchor.x,
      z: anchor.z,
      baseY: anchor.baseY,
      radiusXM: def.radiusXM,
      radiusZM: def.radiusZM,
      speedRadPerSec: def.speedRadPerSec,
      phase: def.phase,
      lightColour: def.lightColour,
      path: sampleEllipse(anchor, def.radiusXM, def.radiusZM, def.phase, ROBOT_PATH_SAMPLES),
      source: def.anchor === 'iecGate' ? 'iec-model-gate-anchor' : 'iec-model-flower-sea-anchor',
      heightSource: 'estimate'
    });
  }
  return { robots, missing };
}

// 西丽站围挡大门：与 js/sz-station-sites.js 一致，取外环最长边中点，宽 9 m；广告面板避开大门。
function xiliGate(ring) {
  let best = { index: -1, length: -1 };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length > best.length) best = { index: i, length };
  }
  if (best.index < 0) return null;
  const a = ring[best.index], b = ring[(best.index + 1) % ring.length];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, widthM: 9 };
}

/** 解析：西丽站在建工地围挡公益广告的布点（4 块）。
 *  输入：GEO.sites['xili-station'].site.polygons（OSM 场地轮廓）。
 *  输出：沿围挡外缘的广告面板位置/朝向/尺寸；位置按周长均分，属展示估计。 */
export function planXiliHoardings(sites = null) {
  const xili = sites?.['xili-station']?.site
    ?? (Array.isArray(sites?.['xili-station']?.polygons) ? sites['xili-station'] : null);
  const rings = outerRings(xili);
  if (rings.length === 0) return { hoardings: [], missing: [{ kind: 'hoarding', id: 'xili-hoarding-apec', reason: 'missing-xili-site' }] };
  const ring = largestRing(rings);
  const perimeter = ringPerimeter(ring);
  const centroid = ringCentroid(ring);
  const gate = xiliGate(ring);
  const panelCount = clampNumber(Math.round(perimeter / 300), 3, 5);
  const gateGap = (gate?.widthM ?? 0) / 2 + 2;
  const halfWidth = HOARDING_PANEL_WIDTH_M / 2;
  // 先按周长等分取候选，再在等分点附近微调，避开大门和转角；完全确定性。
  const deltas = [0, 0.008, -0.008, 0.016, -0.016, 0.028, -0.028, 0.045, -0.045];
  const hoardings = [];
  for (let index = 0; index < panelCount; index++) {
    const baseT = (index + 0.5) / panelCount;
    for (const delta of deltas) {
      const at = sampleRing(ring, baseT + delta);
      if (gate && Math.hypot(at.x - gate.x, at.z - gate.z) < gateGap) continue;
      const endA = { x: at.x - at.dx * halfWidth, z: at.z - at.dz * halfWidth };
      const endB = { x: at.x + at.dx * halfWidth, z: at.z + at.dz * halfWidth };
      // 面板两端必须仍在同一段围挡线上，避免跨过转角悬空。
      if (distanceToRing(ring, endA.x, endA.z) > 0.8 || distanceToRing(ring, endB.x, endB.z) > 0.8) continue;
      const left = { x: -at.dz, z: at.dx };
      const toCentre = { x: centroid.x - at.x, z: centroid.z - at.z };
      const inward = toCentre.x * left.x + toCentre.z * left.z >= 0 ? left : { x: -left.x, z: -left.z };
      const outward = { x: -inward.x, z: -inward.z };
      hoardings.push({
        id: `xili-hoarding-apec-${index + 1}`,
        x: at.x,
        z: at.z,
        yaw: Math.atan2(outward.x, outward.z),
        outwardX: round(outward.x),
        outwardZ: round(outward.z),
        widthM: HOARDING_PANEL_WIDTH_M,
        heightM: HOARDING_PANEL_HEIGHT_M,
        centerM: HOARDING_PANEL_CENTER_M,
        mountMode: 'on-3m-hoarding-outward-face',
        source: 'osm-way/402048868',
        facingSource: 'site-ring-outward-estimate',
        heightSource: 'estimate'
      });
      break;
    }
  }
  return { hoardings, missing: [] };
}

// 计划层：只做布点和来源标注，不建几何；测试、统计和 Lead 检查都用它。
/** 解析：APEC 城市元素总计划（大屏 + 巡逻机器人 + 围挡广告）。
 *  输入：landmarks、sites、IEC 台面锚点。
 *  输出：{ screens, robots, hoardings, missing }；纯函数，测试与统计都用它。 */
export function planApecCityElements({ landmarks = [], sites = null, anchors = null } = {}) {
  const screenPlan = planApecScreens(landmarks);
  const robotPlan = planApecRobots(landmarks, anchors);
  const hoardingPlan = planXiliHoardings(sites);
  return {
    screens: screenPlan.screens,
    robots: robotPlan.robots,
    hoardings: hoardingPlan.hoardings,
    missing: [...screenPlan.missing, ...robotPlan.missing, ...hoardingPlan.missing]
  };
}

// 统计口径：数量来自布点计划；构建后由 buildApecCityElements 补 built/meshes/triangles。
export function summarizeApecCityPlan(plan) {
  return {
    source: 'geo-landmarks+geo-sites-xili-station+main-anchors',
    approach: 'text-and-colors-only-china-red-apec-purple-no-official-emblem',
    heightSource: 'estimate',
    screens: plan.screens.length,
    robots: plan.robots.length,
    hoardings: plan.hoardings.length,
    screenDetails: plan.screens.map((screen) => ({
      id: screen.id, landmarkId: screen.landmarkId, x: round(screen.x, 1), z: round(screen.z, 1),
      yaw: round(screen.yaw, 3), primaryLine: screen.primaryLine, footer: screen.footer,
      facingX: screen.facingX, facingZ: screen.facingZ, source: screen.source, facingSource: screen.facingSource
    })),
    robotDetails: plan.robots.map((robot) => ({
      id: robot.id, anchor: robot.anchor, anchorSource: robot.anchorSource,
      x: round(robot.x, 1), z: round(robot.z, 1), baseY: robot.baseY,
      radiusXM: robot.radiusXM, radiusZM: robot.radiusZM,
      speedRadPerSec: robot.speedRadPerSec, phase: robot.phase
    })),
    hoardingDetails: plan.hoardings.map((hoarding) => ({
      id: hoarding.id, x: round(hoarding.x, 1), z: round(hoarding.z, 1), yaw: round(hoarding.yaw, 3),
      widthM: hoarding.widthM, heightM: hoarding.heightM, source: hoarding.source,
      facingSource: hoarding.facingSource
    })),
    missing: plan.missing,
    built: { screens: 0, robots: 0, hoardings: 0 },
    meshes: 0,
    triangles: 0,
    drawCallsEstimate: 0,
    parts: [
      ...plan.screens.map((screen) => ({ id: screen.id, kind: 'led-screen', heightSource: 'estimate' })),
      ...plan.robots.map((robot) => ({ id: robot.id, kind: 'patrol-robot', heightSource: 'estimate' })),
      ...plan.hoardings.map((hoarding) => ({ id: hoarding.id, kind: 'hoarding-panel', heightSource: 'estimate' }))
    ],
    limitations: [
      '大屏位置是地标中心加固定示意偏移，朝向按 2026-11-09 OSM 路网人工检查固定，不是逐块屏实测',
      '机器人巡逻椭圆、速度和灯光亮度是展示参数，不是实际巡逻路线；没有 AI 或寻路',
      '西丽站广告面板沿 OSM 场地外环等分布置并避开大门，尺寸按 3 m 施工围挡比例示意',
      '只用文字和中国红 / APEC 紫，不使用 APEC 官方会徽；所有贴图运行时 canvas 绘制',
      '本模块不建碰撞体：大屏、机器人和广告面板都是装饰，玩家可以穿过'
    ]
  };
}

// ---------- 运行时贴图：canvas 现画，不加载外部图片 ----------

function hasCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function canvasTexture(width, height, draw) {
  // 没有 canvas 的 node 环境（或极端降级）用 1×1 纯色贴图，构建和销毁仍然可用。
  if (!hasCanvas()) {
    const texture = new THREE.DataTexture(new Uint8Array([200, 16, 46, 255]), 1, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// 双面 LED 面：正反两片、背面 UV 镜像，两面文字都正向可读；中国红底色加 APEC 紫边条和金色描边。
function drawLedFace(primaryFirst) {
  return (context, width, height) => {
    context.fillStyle = '#c8102e';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#5a2a66';
    context.fillRect(0, 0, width, height * 0.1);
    context.fillRect(0, height * 0.9, width, height * 0.1);
    context.strokeStyle = '#d8b45a';
    context.lineWidth = 8;
    context.strokeRect(12, height * 0.13, width - 24, height * 0.74);
    const first = primaryFirst ? APEC_CITY_SLOGANS.line1 : APEC_CITY_SLOGANS.line2;
    const second = primaryFirst ? APEC_CITY_SLOGANS.line2 : APEC_CITY_SLOGANS.line1;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.font = `bold 64px ${SCREEN_FONT}`;
    context.fillText(first, width / 2, height * 0.34);
    context.fillStyle = '#f3e2b4';
    context.font = `bold 44px ${SCREEN_FONT}`;
    context.fillText(second, width / 2, height * 0.55);
    context.fillStyle = '#d8b45a';
    context.font = `bold 30px ${SCREEN_FONT}`;
    context.fillText(APEC_CITY_SLOGANS.footer, width / 2, height * 0.77);
  };
}

// ---------- 几何 ----------

// 双面屏面：正面 z=+faceOffset、背面 z=-faceOffset，背面顶点顺序和 UV 都镜像。
function screenFaceGeometry(width, height, faceOffset) {
  const halfWidth = width / 2;
  const positions = [
    -halfWidth, 0, faceOffset, halfWidth, 0, faceOffset, halfWidth, height, faceOffset, -halfWidth, height, faceOffset,
    -halfWidth, 0, -faceOffset, halfWidth, 0, -faceOffset, halfWidth, height, -faceOffset, -halfWidth, height, -faceOffset
  ];
  const normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
  geometry.computeBoundingBox();
  return geometry;
}

function triangleCount(geometry) {
  return (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
}

// ---------- 构建 ----------

/** 解析：把 APEC 城市元素建成场景对象（46 网格/816 三角，随主题开关显隐）。
 *  输入：terrain、landmarks、sites、anchors。
 *  输出：{ group, statistics, screens, robots, hoardings, update, dispose }；
 *        update 做机器人确定性巡逻与夜间灯条亮度，不含碰撞体。 */
export function buildApecCityElements(scene, {
  terrain = null, landmarks = [], sites = null, anchors = null
} = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('APEC city elements require a scene');
  const plan = planApecCityElements({ landmarks, sites, anchors });
  const statistics = summarizeApecCityPlan(plan);
  const group = new THREE.Group();
  group.name = 'shenzhen-apec-city-elements';
  scene.add(group);

  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const keepGeometry = (geometry) => { geometries.add(geometry); return geometry; };
  const keepMaterial = (material) => { materials.add(material); return material; };
  const keepTexture = (texture) => { textures.add(texture); return texture; };

  const groundY = (x, z) => {
    const height = terrain ? terrainHeight(terrain, x, z) : null;
    return Number.isFinite(height) ? height : 0;
  };
  // 机器人底盘高度：台面锚点优先；没有锚点时取巡逻中心与椭圆四端地面最高值，避免陷进坡里。
  const robotBaseY = (robot) => {
    if (Number.isFinite(robot.baseY)) return robot.baseY;
    const probes = [
      [robot.x, robot.z],
      [robot.x + robot.radiusXM, robot.z],
      [robot.x - robot.radiusXM, robot.z],
      [robot.x, robot.z + robot.radiusZM],
      [robot.x, robot.z - robot.radiusZM]
    ].map(([x, z]) => terrain ? terrainHeight(terrain, x, z) : null).filter(Number.isFinite);
    return probes.length > 0 ? Math.max(...probes) : 0;
  };

  // 1. LED 大屏：深色钢框 + 两根方钢立柱 + 基础 + 双面提词屏面。三块屏共用两种主标语贴图。
  const sloganTextures = [keepTexture(canvasTexture(1024, 512, drawLedFace(true))),
    keepTexture(canvasTexture(1024, 512, drawLedFace(false)))];
  const faceMaterials = sloganTextures.map((texture) => keepMaterial(new THREE.MeshStandardNodeMaterial({
    map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.3, roughness: 0.34, metalness: 0.05
  })));
  const screenRecords = [];
  if (plan.screens.length > 0) {
    const width = plan.screens[0].widthM;
    const height = plan.screens[0].heightM;
    const bottom = plan.screens[0].bottomM;
    const faceGeometry = keepGeometry(screenFaceGeometry(width, height, 0.22));
    const frameGeometry = keepGeometry(new THREE.BoxGeometry(width + 0.36, height + 0.36, 0.42));
    const postHeight = bottom + height + 0.45;
    const postGeometry = keepGeometry(new THREE.BoxGeometry(0.32, postHeight, 0.32));
    const baseGeometry = keepGeometry(new THREE.BoxGeometry(0.9, 0.45, 0.9));
    const frameMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      color: APEC_CITY_COLORS.screenFrame, roughness: 0.55, metalness: 0.35
    }));
    const postMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      color: APEC_CITY_COLORS.steel, roughness: 0.5, metalness: 0.45
    }));
    for (const screen of plan.screens) {
      const textureIndex = screen.primaryLine === APEC_CITY_SLOGANS.line1 ? 0 : 1;
      const screenGroup = new THREE.Group();
      screenGroup.name = `apec-led-screen:${screen.id}`;
      screenGroup.position.set(screen.x, groundY(screen.x, screen.z), screen.z);
      screenGroup.rotation.y = screen.yaw;
      const frame = new THREE.Mesh(frameGeometry, frameMaterial);
      frame.name = `apec-led-screen-frame:${screen.id}`;
      frame.position.set(0, bottom + height / 2, 0);
      frame.castShadow = true;
      frame.receiveShadow = false;
      const face = new THREE.Mesh(faceGeometry, faceMaterials[textureIndex]);
      face.name = `apec-led-screen-face:${screen.id}`;
      face.position.set(0, bottom, 0);
      screenGroup.add(frame, face);
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeometry, postMaterial);
        post.name = `apec-led-screen-post:${screen.id}:${side < 0 ? 'left' : 'right'}`;
        post.position.set(side * (width / 2 - 0.75), postHeight / 2, 0);
        post.castShadow = true;
        const base = new THREE.Mesh(baseGeometry, postMaterial);
        base.name = `apec-led-screen-base:${screen.id}:${side < 0 ? 'left' : 'right'}`;
        base.position.set(side * (width / 2 - 0.75), 0.22, 0);
        base.receiveShadow = true;
        screenGroup.add(post, base);
      }
      group.add(screenGroup);
      screenRecords.push({ plan: screen, group: screenGroup, faceMaterial: faceMaterials[textureIndex] });
    }
  }

  // 2. 巡逻机器人：轮式底盘 + 红色/紫色饰条 + 灯条 + 传感器桅杆；update 里做确定性椭圆巡逻。
  const robotGeometries = {
    chassis: keepGeometry(new THREE.BoxGeometry(1.5, 0.55, 0.95)),
    stripe: keepGeometry(new THREE.BoxGeometry(1.52, 0.1, 0.97)),
    wheel: keepGeometry(new THREE.CylinderGeometry(0.28, 0.28, 0.18, 12).rotateZ(Math.PI / 2)),
    lightBar: keepGeometry(new THREE.BoxGeometry(1.02, 0.12, 0.22)),
    mast: keepGeometry(new THREE.CylinderGeometry(0.06, 0.06, 0.95, 8)),
    head: keepGeometry(new THREE.BoxGeometry(0.3, 0.2, 0.24)),
    bumper: keepGeometry(new THREE.BoxGeometry(1.46, 0.16, 0.12))
  };
  const robotMaterials = {
    body: keepMaterial(new THREE.MeshStandardNodeMaterial({ color: APEC_CITY_COLORS.robotBody, roughness: 0.62, metalness: 0.1 })),
    dark: keepMaterial(new THREE.MeshStandardNodeMaterial({ color: APEC_CITY_COLORS.robotDark, roughness: 0.45, metalness: 0.4 })),
    glass: keepMaterial(new THREE.MeshStandardNodeMaterial({ color: 0x1b2024, roughness: 0.2, metalness: 0.3 }))
  };
  const robotRecords = [];
  for (const robot of plan.robots) {
    const robotGroup = new THREE.Group();
    robotGroup.name = `apec-patrol-robot:${robot.id}`;
    const baseY = robotBaseY(robot);
    // 初始位置就落在椭圆相位点上，第一帧 update 不会跳一下。
    const startAngle = robot.phase;
    robotGroup.position.set(robot.x + Math.cos(startAngle) * robot.radiusXM, baseY,
      robot.z + Math.sin(startAngle) * robot.radiusZM);
    robotGroup.rotation.y = Math.atan2(-Math.sin(startAngle) * robot.radiusXM, Math.cos(startAngle) * robot.radiusZM);
    const accentMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      color: robot.lightColour, roughness: 0.55, metalness: 0.15
    }));
    const lightBarMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      color: 0x2a2f33, emissive: robot.lightColour, emissiveIntensity: 0.16, roughness: 0.4
    }));
    const chassis = new THREE.Mesh(robotGeometries.chassis, robotMaterials.body);
    chassis.position.set(0, 0.58, 0);
    chassis.castShadow = true;
    const stripe = new THREE.Mesh(robotGeometries.stripe, accentMaterial);
    stripe.position.set(0, 0.68, 0);
    const bumper = new THREE.Mesh(robotGeometries.bumper, robotMaterials.dark);
    bumper.position.set(0, 0.45, 0.5);
    const lightBar = new THREE.Mesh(robotGeometries.lightBar, lightBarMaterial);
    lightBar.name = 'apec-patrol-robot-light-bar';
    lightBar.position.set(0, 0.93, 0);
    const mast = new THREE.Mesh(robotGeometries.mast, robotMaterials.dark);
    mast.position.set(0.38, 1.32, -0.05);
    const head = new THREE.Mesh(robotGeometries.head, robotMaterials.glass);
    head.position.set(0.38, 1.84, -0.05);
    const wheels = [];
    for (const side of [-1, 1]) {
      for (const front of [-1, 1]) {
        const wheel = new THREE.Mesh(robotGeometries.wheel, robotMaterials.dark);
        wheel.name = 'apec-patrol-robot-wheel';
        wheel.position.set(side * 0.72, 0.28, front * 0.42);
        robotGroup.add(wheel);
        wheels.push(wheel);
      }
    }
    robotGroup.add(chassis, stripe, bumper, lightBar, mast, head);
    group.add(robotGroup);
    robotRecords.push({
      plan: robot, group: robotGroup, baseY, wheels, lightBarMaterial, accentMaterial, wheelSpin: 0
    });
  }

  // 3. 西丽站围挡公益广告：挂在 3 m 围挡外侧面，复用主标语贴图，面向场地外侧。
  const hoardingRecords = [];
  let hoardingMaterial = null;
  if (plan.hoardings.length > 0) {
    const panelGeometry = keepGeometry(new THREE.PlaneGeometry(HOARDING_PANEL_WIDTH_M, HOARDING_PANEL_HEIGHT_M));
    const panelFrameGeometry = keepGeometry(new THREE.BoxGeometry(HOARDING_PANEL_WIDTH_M + 0.18, HOARDING_PANEL_HEIGHT_M + 0.18, 0.1));
    hoardingMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      map: sloganTextures[0], emissive: 0xffffff, emissiveMap: sloganTextures[0], emissiveIntensity: 0.06,
      roughness: 0.78, side: THREE.DoubleSide
    }));
    const hoardingFrameMaterial = keepMaterial(new THREE.MeshStandardNodeMaterial({
      color: APEC_CITY_COLORS.steel, roughness: 0.6, metalness: 0.3
    }));
    for (const hoarding of plan.hoardings) {
      const ground = groundY(hoarding.x, hoarding.z);
      const outward = { x: Math.sin(hoarding.yaw), z: Math.cos(hoarding.yaw) };
      const panelGroup = new THREE.Group();
      panelGroup.name = `apec-hoarding-panel:${hoarding.id}`;
      panelGroup.position.set(hoarding.x, ground, hoarding.z);
      panelGroup.rotation.y = hoarding.yaw;
      const frame = new THREE.Mesh(panelFrameGeometry, hoardingFrameMaterial);
      frame.name = `apec-hoarding-frame:${hoarding.id}`;
      frame.position.set(0, hoarding.centerM, 0);
      const panel = new THREE.Mesh(panelGeometry, hoardingMaterial);
      panel.name = `apec-hoarding-face:${hoarding.id}`;
      panel.position.set(0, hoarding.centerM, HOARDING_PANEL_OFFSET_M);
      panelGroup.add(frame, panel);
      group.add(panelGroup);
      hoardingRecords.push({ plan: hoarding, group: panelGroup, outward });
    }
  }

  const meshes = [];
  let triangles = 0;
  group.traverse((object) => {
    if (!object.isMesh) return;
    meshes.push(object);
    triangles += triangleCount(object.geometry);
  });
  statistics.built = {
    screens: screenRecords.length,
    robots: robotRecords.length,
    hoardings: hoardingRecords.length
  };
  statistics.meshes = meshes.length;
  statistics.triangles = Math.round(triangles);
  statistics.drawCallsEstimate = meshes.length;

  let elapsed = 0;
  return {
    group,
    statistics,
    screens: plan.screens,
    robots: plan.robots,
    hoardings: plan.hoardings,
    parts: statistics.parts,
    update(dt, nightFactor = 0) {
      // 与其它动画模块一致：单帧步长封顶，避免切回标签页后机器人瞬移。
      const step = clampNumber(Number.isFinite(dt) ? dt : 0, 0, 0.05);
      elapsed += step;
      const night = clampNumber(Number.isFinite(nightFactor) ? nightFactor : 0, 0, 1);
      for (const record of screenRecords) record.faceMaterial.emissiveIntensity = 0.3 + night * 0.95;
      if (hoardingMaterial) hoardingMaterial.emissiveIntensity = 0.06 + night * 0.32;
      for (const record of robotRecords) {
        const robot = record.plan;
        const angle = robot.phase + elapsed * robot.speedRadPerSec;
        const x = robot.x + Math.cos(angle) * robot.radiusXM;
        const z = robot.z + Math.sin(angle) * robot.radiusZM;
        const dx = -Math.sin(angle) * robot.radiusXM;
        const dz = Math.cos(angle) * robot.radiusZM;
        record.group.position.set(x, record.baseY, z);
        record.group.rotation.y = Math.atan2(dx, dz);
        const arcSpeed = robot.speedRadPerSec * Math.hypot(Math.sin(angle) * robot.radiusXM,
          Math.cos(angle) * robot.radiusZM);
        record.wheelSpin += (arcSpeed * step) / 0.28;
        for (const wheel of record.wheels) wheel.rotation.x = record.wheelSpin;
        record.lightBarMaterial.emissiveIntensity = 0.16 + night * 1.5;
      }
    },
    dispose() {
      scene.remove(group);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      geometries.clear();
      materials.clear();
      textures.clear();
      screenRecords.length = 0;
      robotRecords.length = 0;
      hoardingRecords.length = 0;
      group.clear();
    }
  };
}
