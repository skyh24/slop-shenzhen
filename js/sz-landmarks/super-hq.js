import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry,
  positionWorld, sin, smoothstep, step, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { terrainHeight } from '../sz-terrain.js';
import { convexHull } from '../building-collision.js';
import { footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';

// 深圳湾超级总部基地（按建好形态）：C 塔双塔和连廊、招银环球金融中心、规划展览馆、
// 超级总部站地面部分、十字双轴公共空间。只有 landmarks.json 里列出的设计值算来源，
// 其余平面和细部按效果图比例拟合，标 design 或 estimate，不写实测。

export const sourceIds = [];

// 通用建筑包里应让位给本模型的体量：招银在通用包被拆成 5 个 building:part 盒子；
// 规划展览馆院落里的既有轮廓；以及施工场地内压到塔基/双轴/车站出入口的过时 Overture 足迹
// （场地 landuse=construction，这些体块多为施工棚或旧轮廓，不是建成楼）。是否整片让位由 registry 决定。
export const optionalSkipIds = [
  'way/1443942675', 'way/1443942676', 'way/1443942677', 'way/1443942678', 'way/1443942679',
  'relation/18564923',
  'overture/be4698f6-88cd-4404-8511-d67437c687af', 'overture/768146e0-abb0-47f4-a133-60a030d6bd6f',
  'overture/fe4ddede-9387-4224-8d5d-e9d6d5fc93f9', 'overture/ce09e5e2-b636-4ae2-93c4-67e809b60c78',
  'overture/6c433d54-0d25-4514-91cc-fb4fdf9bec1e', 'overture/ca7be783-4c0e-490d-bffa-a4453c4fb86e',
  'overture/90282fb8-bfdd-4884-8043-a042f3ffb098', 'overture/6d2a79ec-e66a-4a79-bb2b-c507b60b2aee',
  'overture/97eeffed-e063-43d7-aabf-cbcb4a803efb', 'overture/f17904a5-26e6-4c32-8b95-5ae0f48d0339',
  'overture/16aa3cd9-42cd-46b9-af02-462d4ddb4fea', 'overture/d7669d54-79ad-4c0d-bde5-100166b87d00',
  'overture/7ffab2fb-aafd-4f65-b6b4-a30c34778528', 'overture/3e61e23e-8405-48b7-b5e0-3b0af941ba35',
  'overture/504d0598-6b79-4c1d-9c82-e805bf1f0187', 'overture/5e71deac-b359-4937-ba49-6854aad19381',
  'overture/ae4b5ece-7153-462c-aec3-a137a3093af6', 'overture/6032d0cc-9a93-4071-a915-5f0d571efff9',
  'overture/abadf909-eb9a-480e-922a-187ae7d0e85b', 'overture/7b717cb2-d23e-4fbd-90e4-3616af8bbe08',
  'overture/b159bfcb-b09b-4191-bfc0-e33c933249b0', 'overture/171b8abf-3ee6-488d-8798-72e8ccefa4a0',
  'overture/d67274d2-6c5e-4739-9d13-98a4a3bdc691', 'overture/9e47006f-bf13-41ae-96bc-3824ca45e24e',
  'overture/0efbe9d5-2cb9-4e14-bac7-0038476d0d20', 'overture/596521ab-bb06-4fd7-a0c0-b833d1ce19a4'
];

export const siteRoles = ['site', 'cmbTower', 'exhibitionHall', 'metroStation'];

// data/source/landmarks.json super-hq.design（核实日期 2026-11-09）：设计值，不是测量值。
export const designHeights = Object.freeze({
  eastTowerM: 400, eastTowerFloors: 73,
  westTowerM: 336, westTowerFloors: 66,
  skybridgeM: 119.15, skybridgeSpanM: 78, hangerM: 33, skybridgeWeightT: 6000,
  cmbTowerM: 387, cmbTowerFloors: 75
});

export const materials = Object.freeze(['superHqGlass', 'superHqCmbGlass', 'superHqMetal', 'superHqStone',
  'superHqPaving', 'superHqGreen', 'superHqSign']);

// 以下平面和剖面尺寸没有公开施工图，按效果图与 OSM 足迹比例拟合，属于外观估计。
const FIT = Object.freeze({
  towerSemiLongM: 31, towerSemiShortM: 27, towerRingSegments: 16, towerSquareness: 2.6,
  towerSkirtFlare: 1.3, towerSkirtFootM: 4, towerSkirtTopM: 18, towerLobbyTopM: 22.5, towerCrownM: 9,
  towerCanopyLiftM: 8, towerCanopyDepthM: 0.85, towerCanopyWidthM: 26, towerLean: [2.2, 5.5, 8.5, 9.5],
  bridgeLiftM: 1.5, bridgeWidthM: 22, bridgeBodyM: 8.6, bridgeChordM: 1.55, bridgeHangerWidthM: 18,
  greenAxisWidthM: 40, greenWalkM: 22.2, greenBandM: 8.4, greenSeamM: 0.5, greenPlazaM: 24,
  promenadeWidthM: 34, promenadeWalkM: 26, axisSpacingM: 24, promenadeSpacingM: 30,
  axisLiftM: 0.12, axisThicknessM: 0.34, greenLiftM: 0.22, greenThicknessM: 0.5, seamLiftM: 0.04,
  seamThicknessM: 0.3,
  cmbLobbyTopM: 24, cmbShaftM: 300, cmbShoulderM: 340, cmbBladeFraction: [0.32, 0.68],
  cmbShoulderFraction: [0.16, 0.84], cmbCapM: 7,
  exhibitionPlinthM: 1.1, exhibitionBodyM: 15.8, exhibitionRoofM: 18.2, exhibitionLiftM: 1.5,
  stationEntranceM: 4.35, stationCanopyM: 4.95, stationCount: 3
});

const EPS = 1e-6;
const SITE = { site: 'way/336349626', cmbTower: 'way/1443942674', exhibitionHall: 'way/555593808',
  metroStation: 'way/1349162932' };

// ── 纯平面几何工具 ────────────────────────────────────────────────

function ringBounds(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ };
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function ringCentroid(ring) {
  let area = 0, x = 0, z = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cross = a.x * b.z - b.x * a.z;
    area += cross;
    x += (a.x + b.x) * cross;
    z += (a.z + b.z) * cross;
  }
  area /= 2;
  if (Math.abs(area) < EPS) {
    return { x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
      z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length };
  }
  return { x: x / (6 * area), z: z / (6 * area) };
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function edgeDistance(ax, az, bx, bz, x, z) {
  const dx = bx - ax, dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 < EPS ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

function boundaryDistance(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    best = Math.min(best, edgeDistance(a.x, a.z, b.x, b.z, x, z));
  }
  return best;
}

const along = (origin, direction, distance) => point(origin.x + direction.x * distance,
  origin.z + direction.z * distance);

// 最小面积包围矩形方向：给出场地长轴和短轴，避免手写角度。
function minAreaFrame(ring) {
  const hull = convexHull(ring);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < EPS) continue;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.z * uz, v = p.z * ux - p.x * uz;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, spanU: maxU - minU, spanV: maxV - minV, ux, uz };
  }
  if (!best) return null;
  const u = { x: best.ux, z: best.uz };
  const v = { x: -best.uz, z: best.ux };
  const long = best.spanU >= best.spanV ? u : v;
  const short = best.spanU >= best.spanV ? v : u;
  return { longAxis: long, shortAxis: short, longSpan: Math.max(best.spanU, best.spanV),
    shortSpan: Math.min(best.spanU, best.spanV) };
}

// 穿过内部点、沿给定方向的直线与场地多边形的交点参数区间。
function lineSpan(ring, origin, direction) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x, ez = b.z - a.z;
    const det = -direction.x * ez + direction.z * ex;
    if (Math.abs(det) < 1e-9) continue;
    const rx = a.x - origin.x, rz = a.z - origin.z;
    const t = (-rx * ez + rz * ex) / det;
    const s = (direction.x * rz - direction.z * rx) / det;
    if (s < -1e-7 || s > 1 + 1e-7) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  return Number.isFinite(min) && max > min ? { min, max } : null;
}

function clipHalfPlane(ring, signedDistance) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = signedDistance(a), db = signedDistance(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push(point(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
    }
  }
  return out;
}

// 圆角矩形近似环：凸环，等比缩放后各对应边仍平行，可安全用于 loftPart 曲面叠加。
function roundedRing(semiLong, semiShort, segments, squareness, scale = 1) {
  const ring = [];
  const power = 2 / squareness;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    ring.push(point(Math.sign(cosine) * Math.abs(cosine) ** power * semiLong * scale,
      Math.sign(sine) * Math.abs(sine) ** power * semiShort * scale));
  }
  return ring;
}

// ── 场地与双塔定位（纯函数，测试不需要 THREE） ────────────────────

/** 解析：以已核实的超总场地多边形建立局部坐标系（东北角为原点、沿边定向）。
 *  输入：way/336349626 的场地环（GEO.sites['super-hq'].site）。
 *  输出：{ origin, u, v, bounds, area }；后续双塔/双轴/C 塔连廊都用这套局部坐标。 */
export function siteFrame(polygon) {
  if (!polygon?.outer || polygon.outer.length < 3) return null;
  const outer = polygon.outer;
  const center = ringCentroid(outer);
  const frame = minAreaFrame(outer);
  if (!frame || frame.longSpan < 40 || frame.shortSpan < 20) return null;
  const longAxis = { ...frame.longAxis };
  // 长轴统一朝东：东塔固定在 +longAxis 一侧，结果与多边形顶点方向无关。
  if (longAxis.x < 0) {
    longAxis.x *= -1;
    longAxis.z *= -1;
  }
  const shortAxis = { x: -longAxis.z, z: longAxis.x };
  return { center, longAxis, shortAxis, longSpan: frame.longSpan, shortSpan: frame.shortSpan,
    area: Math.abs(ringArea(outer)) };
}

/** 解析：C 塔双塔与连廊的平面布置（纯几何计划）。
 *  输入：超总场地多边形。
 *  输出：东塔/西塔平面（约 62×54 m）、双塔中心距与 119.15 m 连廊的起止点。
 *  说明：设计值来自 landmarks.json（400/336 m、119.15 m）；平面收分是效果图拟合。 */
export function twinTowerPlan(polygon) {
  const frame = siteFrame(polygon);
  if (!frame) return null;
  const semi = { long: FIT.towerSemiLongM, short: FIT.towerSemiShortM };
  // 连廊净跨 78 m：塔面位于交点两侧各 39 m，塔心再退一个平面半轴。
  const offset = designHeights.skybridgeSpanM / 2 + semi.long;
  return {
    frame, semi, offset,
    east: { center: along(frame.center, frame.longAxis, offset), height: designHeights.eastTowerM, facing: -1 },
    west: { center: along(frame.center, frame.longAxis, -offset), height: designHeights.westTowerM, facing: 1 },
    bridge: { level: designHeights.skybridgeM, span: designHeights.skybridgeSpanM,
      from: along(frame.center, frame.longAxis, -designHeights.skybridgeSpanM / 2),
      to: along(frame.center, frame.longAxis, designHeights.skybridgeSpanM / 2) }
  };
}

// ── 部件构造（沿用 parts.js 的字段口径） ─────────────────────────

function designSource(id, polygon, height, heightSource) {
  const bounds = ringBounds(polygon.outer);
  return { id, height, minHeight: 0, heightSource, polygons: [polygon],
    cx: (bounds.minX + bounds.maxX) / 2, cz: (bounds.minZ + bounds.maxZ) / 2,
    minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ };
}

function volume(source, ring, bottom, top, style, options = {}) {
  const { id, holes = [], heightSource = 'estimate', baseSource = 'dem-footprint-samples',
    roofContact = false } = options;
  const [part] = footprintParts({ ...source, polygons: [{ outer: ring, holes }] }, 0, style,
    { id, min: bottom, max: top, derived: true, roofContact });
  return { ...part, heightSource, baseSource, baseSourceId: source.id, shapeSource: 'visual-estimate' };
}

function loft(source, lower, upper, bottom, top, style, options = {}) {
  const { id, heightSource = 'estimate', baseSource = 'dem-ring-footing-samples' } = options;
  // uvOriginY 用基底：各段幕墙楼层线在整栋高度上连续。
  return { ...loftPart(id, source, lower, upper, bottom, top, style,
    { heightSource, uvOriginY: options.originY ?? bottom, smoothSides: true }),
    baseSource, baseSourceId: source.id, shapeSource: 'visual-estimate' };
}

function span(source, a, b, widthA, widthB, depth, style, options = {}) {
  const { id, heightSource = 'estimate', baseSource = 'dem-corner-samples', roofContact = false } = options;
  return { ...spanPart(id, source, a, b, widthA, widthB, depth, style, { heightSource, roofContact }),
    baseSource, baseSourceId: source.id, shapeSource: 'visual-estimate' };
}

function panel(source, triangle, depth, style, options = {}) {
  const { id, heightSource = 'estimate', baseSource = 'dem-corner-samples', roofContact = false } = options;
  return { ...roofPanelPart(id, source, triangle, depth, style, { heightSource, roofContact }),
    baseSource, baseSourceId: source.id, shapeSource: 'visual-estimate' };
}

const grade = (terrain, p) => {
  const value = terrainHeight(terrain, p.x, p.z);
  return Number.isFinite(value) ? value : null;
};

// 沿环取样取最低地面作基底：裙摆不悬空，也不把估计标高写成实测。
function ringFooting(ring, terrain, step = 4) {
  let lowest = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      const value = terrainHeight(terrain, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!Number.isFinite(value)) return null;
      lowest = Math.min(lowest, value);
    }
  }
  return Number.isFinite(lowest) ? lowest : null;
}

// ── C 塔双塔 ────────────────────────────────────────────────────

function towerSections(height) {
  const skybridge = designHeights.skybridgeM;
  const lean = FIT.towerLean;
  return [
    { y: 0, scale: FIT.towerSkirtFlare, lean: 0 },
    { y: FIT.towerSkirtFootM, scale: FIT.towerSkirtFlare - 0.03, lean: 0, style: 'superHqStone' },
    { y: FIT.towerSkirtTopM, scale: 1, lean: 0, style: 'superHqGlass' },
    { y: FIT.towerLobbyTopM, scale: 1, lean: 0, style: 'superHqGlass' },
    { y: skybridge, scale: 1, lean: 0, style: 'superHqGlass' },
    { y: skybridge + 2.9, scale: 1.03, lean: 0, style: 'superHqMetal' },
    { y: height * 0.5, scale: 0.88, lean: lean[0], style: 'superHqGlass' },
    { y: height * 0.78, scale: 0.745, lean: lean[1], style: 'superHqGlass' },
    { y: height - FIT.towerCrownM, scale: 0.665, lean: lean[2], style: 'superHqGlass' },
    { y: height, scale: 0.6, lean: lean[3], style: 'superHqMetal' }
  ];
}

function towerRing(section, center, direction) {
  const origin = along(center, direction, -section.lean);
  return roundedRing(FIT.towerSemiLongM * section.scale, FIT.towerSemiShortM * section.scale,
    FIT.towerRingSegments, FIT.towerSquareness).map(p => point(origin.x + p.x, origin.z + p.z));
}

function towerParts(source, tower, direction, terrain) {
  const sections = towerSections(tower.height);
  const base = ringFooting(towerRing(sections[0], tower.center, direction), terrain);
  if (base === null) return null;
  const parts = [];
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    parts.push(loft(source, towerRing(sections[i - 1], tower.center, direction),
      towerRing(section, tower.center, direction), base + sections[i - 1].y, base + section.y, section.style,
      { id: `${source.id}:section:${i}`, heightSource: section.y === tower.height ? 'design' : 'estimate',
        originY: base }));
  }
  // 中上部高空大堂环带：比塔身略外挑。
  const deckBase = tower.height * 0.78;
  const deckLower = { y: deckBase - 1.4, scale: 0.752, lean: FIT.towerLean[1] };
  const deckUpper = { y: deckBase + 2.6, scale: 0.772, lean: FIT.towerLean[1] };
  parts.push(loft(source, towerRing(deckLower, tower.center, direction),
    towerRing(deckUpper, tower.center, direction), base + deckLower.y, base + deckUpper.y, 'superHqMetal',
    { id: `${source.id}:sky-lobby`, originY: base }));
  // 面向十字双轴的雨棚：从塔身外挑约 6 m，下方留无柱入口空间。
  const canopyScale = FIT.towerSkirtFlare + (1 - FIT.towerSkirtFlare) * (FIT.towerCanopyLiftM / FIT.towerSkirtTopM);
  const face = FIT.towerSemiLongM * canopyScale;
  const canopyA = along(tower.center, direction, tower.facing * (face - 0.7));
  const canopyB = along(tower.center, direction, tower.facing * (face + 5.6));
  parts.push(span(source, { ...canopyA, y: base + FIT.towerCanopyLiftM },
    { ...canopyB, y: base + FIT.towerCanopyLiftM }, FIT.towerCanopyWidthM, FIT.towerCanopyWidthM,
    FIT.towerCanopyDepthM, 'superHqMetal', { id: `${source.id}:entrance-canopy` }));
  return { base, parts };
}

// ── 连廊：119.15 m 上托下挂非对称连廊 ────────────────────────────

function skybridgeParts(source, plan, terrain) {
  const { frame } = plan;
  const direction = frame.longAxis, across = frame.shortAxis;
  const at = (t, s = 0) => point(frame.center.x + direction.x * t + across.x * s,
    frame.center.z + direction.z * t + across.z * s);
  const ground = grade(terrain, at(0));
  if (ground === null) return [];
  // 119.15 m 是相对场地地面的提升/合龙高度（施工报道口径），与楼高同一基准。
  const level = ground + designHeights.skybridgeM;
  const halfSpan = designHeights.skybridgeSpanM / 2;
  const edge = halfSpan + FIT.bridgeLiftM;
  const width = FIT.bridgeWidthM;
  const parts = [
    // 下弦梁底面即设计合龙标高 119.15 m。
    span(source, { ...at(-edge), y: level + FIT.bridgeChordM },
      { ...at(edge), y: level + FIT.bridgeChordM }, width - 2, width - 2, FIT.bridgeChordM, 'superHqMetal',
      { id: `${source.id}:lower-chord`, heightSource: 'design' }),
    span(source, { ...at(-edge), y: level + FIT.bridgeChordM + 0.85 },
      { ...at(edge), y: level + FIT.bridgeChordM + 0.85 }, width - 3.2, width - 3.2, 0.85, 'superHqStone',
      { id: `${source.id}:deck`, roofContact: true }),
    span(source, { ...at(-edge), y: level + FIT.bridgeBodyM },
      { ...at(edge), y: level + FIT.bridgeBodyM }, width - 4.2, width - 4.2,
      FIT.bridgeBodyM - FIT.bridgeChordM - 0.85, 'superHqGlass',
      { id: `${source.id}:glass-body`, heightSource: 'design' }),
    span(source, { ...at(-edge), y: level + FIT.bridgeBodyM + 0.7 },
      { ...at(edge), y: level + FIT.bridgeBodyM + 0.7 }, width - 1.6, width - 1.6, 0.7, 'superHqMetal',
      { id: `${source.id}:roof` })
  ];
  // 下挂倒三角：两块折板构成 33 m 深的 V，最低点低于连廊底面 33 m。
  const hanger = designHeights.hangerM;
  for (const side of [-1, 1]) {
    parts.push(span(source, { ...at(0), y: level - hanger + 1.2 },
      { ...at(side * halfSpan), y: level + 1.2 }, FIT.bridgeHangerWidthM, FIT.bridgeHangerWidthM, 1.2,
      'superHqGlass', { id: `${source.id}:hanger-vane:${side}`, heightSource: 'design' }));
  }
  // 悬挂吊杆：把倒三角吊在连廊下弦梁上，读作“下挂”。
  for (const [index, t] of [-0.62, -0.28, 0.28, 0.62].entries()) {
    const anchor = at(halfSpan * t);
    const vaneTop = level - hanger * (1 - Math.abs(t)) + 1.5;
    parts.push(volume(source, [
      point(anchor.x - 0.8, anchor.z - 0.8), point(anchor.x + 0.8, anchor.z - 0.8),
      point(anchor.x + 0.8, anchor.z + 0.8), point(anchor.x - 0.8, anchor.z + 0.8)
    ], vaneTop, level, 'superHqMetal', { id: `${source.id}:hanger-rod:${index}`, baseSource: 'design-level' }));
  }
  // 倒三角底部“裙摆”：底端两块小翼外翻，仍在 33 m 深度以内。
  const foot = at(0);
  parts.push(span(source, { ...point(foot.x - 5.4, foot.z), y: level - hanger + 1.9 },
    { ...point(foot.x + 5.4, foot.z), y: level - hanger + 1.9 }, FIT.bridgeHangerWidthM + 5,
    FIT.bridgeHangerWidthM + 5, 1.9, 'superHqMetal', { id: `${source.id}:hanger-foot` }));
  for (const side of [-1, 1]) {
    parts.push(span(source, { ...point(foot.x + side * 4.2, foot.z), y: level - hanger + 2.6 },
      { ...point(foot.x + side * 12.5, foot.z), y: level - hanger + 6.2 }, 10, 10, 0.9, 'superHqGlass',
      { id: `${source.id}:hanger-skirt:${side}` }));
  }
  return parts;
}

// ── 十字双轴 ────────────────────────────────────────────────────

function axisStations(ring, origin, direction, normal, half, spacing, margin = 0.9) {
  const range = lineSpan(ring, origin, direction);
  if (!range) return [];
  const valid = t => {
    const center = along(origin, direction, t);
    return [half, -half].every(offset => {
      const p = along(center, normal, offset);
      return inRing(ring, p.x, p.z) && boundaryDistance(ring, p.x, p.z) >= margin;
    });
  };
  let first = null, last = null;
  for (let t = range.min; t <= range.max + 1e-9; t += 1) {
    if (!valid(t)) continue;
    if (first === null) first = t;
    last = t;
  }
  if (first === null || last - first < spacing) return [];
  const values = [first];
  for (let t = Math.ceil((first + 1e-9) / spacing) * spacing; t < last; t += spacing) values.push(t);
  values.push(last);
  return values.map(t => ({ t, center: along(origin, direction, t) }));
}

// 绿轴横断面从内到外：步行面 | 排水缝 | 绿化带，尺寸都由 FIT 推出，避免和文档口径走散。
const AXIS_HALF = FIT.greenAxisWidthM / 2;
const AXIS_WALK = FIT.greenWalkM / 2;
const AXIS_SEAM = AXIS_WALK + FIT.greenSeamM;
const AXIS_GREEN = AXIS_SEAM + FIT.greenBandM;
const AXIS_STRIPS = [
  { name: 'green-west', low: -AXIS_GREEN, high: -AXIS_SEAM, style: 'superHqGreen', lift: FIT.greenLiftM,
    thickness: FIT.greenThicknessM },
  { name: 'seam-west', low: -AXIS_SEAM, high: -AXIS_WALK, style: 'superHqStone', lift: FIT.seamLiftM,
    thickness: FIT.seamThicknessM },
  { name: 'walk', low: -AXIS_WALK, high: AXIS_WALK, style: 'superHqPaving', lift: FIT.axisLiftM,
    thickness: FIT.axisThicknessM, walk: true },
  { name: 'seam-east', low: AXIS_WALK, high: AXIS_SEAM, style: 'superHqStone', lift: FIT.seamLiftM,
    thickness: FIT.seamThicknessM },
  { name: 'green-east', low: AXIS_SEAM, high: AXIS_GREEN, style: 'superHqGreen', lift: FIT.greenLiftM,
    thickness: FIT.greenThicknessM }
];

const PROMENADE_HALF = FIT.promenadeWidthM / 2;
const PROMENADE_WALK = FIT.promenadeWalkM / 2;
const PROMENADE_STRIPS = [
  { name: 'verge-north', low: -PROMENADE_HALF, high: -PROMENADE_WALK, style: 'superHqGreen',
    lift: FIT.greenLiftM, thickness: FIT.greenThicknessM },
  { name: 'walk', low: -PROMENADE_WALK, high: PROMENADE_WALK, style: 'superHqPaving', lift: FIT.axisLiftM,
    thickness: FIT.axisThicknessM, walk: true },
  { name: 'verge-south', low: PROMENADE_WALK, high: PROMENADE_HALF, style: 'superHqGreen',
    lift: FIT.greenLiftM, thickness: FIT.greenThicknessM }
];

const PLAZA_STRIPS = [{ name: 'plaza', low: -AXIS_HALF, high: AXIS_HALF, style: 'superHqPaving',
  lift: FIT.axisLiftM, thickness: FIT.axisThicknessM, walk: true }];

// 一段轴铺装：两条三角面取真实地形高程，每条带（步行面、绿化带、排水缝）各自贴合地面。
function axisSpanParts(source, terrain, stations, strips, normal, label) {
  const parts = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    const key = `${a.t.toFixed(1)}_${b.t.toFixed(1)}`;
    for (const strip of strips) {
      const corners = [along(a.center, normal, strip.low), along(a.center, normal, strip.high),
        along(b.center, normal, strip.high), along(b.center, normal, strip.low)];
      const heights = corners.map(p => grade(terrain, p));
      if (heights.some(value => value === null)) continue;
      const top = corners.map((p, k) => ({ x: p.x, y: heights[k] + strip.lift, z: p.z }));
      for (const [k, triangle] of [[0, [top[0], top[1], top[2]]], [1, [top[0], top[2], top[3]]]]) {
        parts.push(panel(source, triangle, strip.thickness, strip.style, {
          id: `${source.id}:${label}:${strip.name}:${key}:${k}`, roofContact: strip.walk === true }));
      }
    }
  }
  return parts;
}

function axisParts(source, terrain, plan) {
  const { frame, polygon } = plan;
  const { center, longAxis, shortAxis } = frame;
  const parts = [];
  // 南北绿轴：连续穿过双塔之间，在连廊下形成中央绿轴。
  const stations = axisStations(polygon.outer, center, shortAxis, longAxis, AXIS_HALF, FIT.axisSpacingM);
  const plaza = (a, b) => Math.max(Math.abs(a.t), Math.abs(b.t)) <= FIT.greenPlazaM;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    parts.push(...axisSpanParts(source, terrain, [a, b], plaza(a, b) ? PLAZA_STRIPS : AXIS_STRIPS,
      longAxis, 'green-axis'));
  }
  // 东西铺装轴：铺装到达双塔前广场，塔体本身占用轴线中段，不伪造穿过塔体的通道。
  const towerSkirt = plan.offset + FIT.towerSemiLongM * FIT.towerSkirtFlare;
  const range = lineSpan(polygon.outer, center, longAxis);
  if (!range) return parts;
  const arms = [[range.min + 1, -towerSkirt], [towerSkirt, range.max - 1]];
  for (const [index, [from, to]] of arms.entries()) {
    if (!(to > from)) continue;
    const count = Math.max(1, Math.round((to - from) / FIT.promenadeSpacingM));
    const step = (to - from) / count;
    const arm = Array.from({ length: count + 1 }, (_, i) => {
      const distance = from + step * i;
      return { t: i * step, center: along(center, longAxis, distance) };
    });
    parts.push(...axisSpanParts(source, terrain, arm, PROMENADE_STRIPS, shortAxis, `promenade-${index}`));
  }
  // 塔前广场：把东西铺装轴和南北绿轴在塔脚接起来。
  const inner = plan.offset - FIT.towerSemiLongM * FIT.towerSkirtFlare;
  for (const side of [-1, 1]) {
    const near = along(center, longAxis, side * AXIS_HALF);
    const far = along(center, longAxis, side * inner);
    const quad = [along(near, shortAxis, -30), along(near, shortAxis, 30),
      along(far, shortAxis, 30), along(far, shortAxis, -30)];
    const heights = quad.map(p => grade(terrain, p));
    if (heights.some(value => value === null)) continue;
    const top = quad.map((p, k) => ({ x: p.x, y: heights[k] + FIT.axisLiftM, z: p.z }));
    for (const [k, triangle] of [[0, [top[0], top[1], top[2]]], [1, [top[0], top[2], top[3]]]]) {
      parts.push(panel(source, triangle, FIT.axisThicknessM, 'superHqPaving', {
        id: `${source.id}:forecourt:${side}:${k}`, roofContact: true }));
    }
  }
  return parts;
}

// ── 招银环球金融中心 ────────────────────────────────────────────

function cmbTowerParts(source, terrain) {
  const outer = source.polygons[0].outer;
  const base = ringFooting(outer, terrain, 3);
  if (base === null) return [];
  const bounds = ringBounds(outer);
  const centroid = ringCentroid(outer);
  const scaleRing = ratio => outer.map(p => point(centroid.x + (p.x - centroid.x) * ratio,
    centroid.z + (p.z - centroid.z) * ratio));
  const shaft = scaleRing(0.975), lobby = scaleRing(0.945);
  const atFraction = fraction => bounds.minX + bounds.width * fraction;
  const slice = (low, high) => clipHalfPlane(clipHalfPlane(shaft, p => p.x - atFraction(low)),
    p => atFraction(high) - p.x);
  const y = value => base + value;
  const parts = [
    volume(source, outer, y(0), y(1.4), 'superHqStone', { id: `${source.id}:plinth` }),
    // 大堂比塔身凹进约 1 m，读作入口雨棚下的退进玻璃厅。
    volume(source, lobby, y(1.4), y(FIT.cmbLobbyTopM), 'superHqGlass', { id: `${source.id}:lobby` }),
    volume(source, shaft, y(FIT.cmbLobbyTopM), y(FIT.cmbShaftM), 'superHqCmbGlass', { id: `${source.id}:shaft` }),
    // 顶冠按 OSM building:part 的三级台肩拟合：340 m 肩部、387 m 中脊。
    volume(source, slice(...FIT.cmbShoulderFraction), y(FIT.cmbShaftM), y(FIT.cmbShoulderM), 'superHqCmbGlass',
      { id: `${source.id}:crown-shoulder` }),
    volume(source, slice(...FIT.cmbBladeFraction), y(FIT.cmbShoulderM), y(designHeights.cmbTowerM - FIT.cmbCapM),
      'superHqCmbGlass', { id: `${source.id}:crown-blade` }),
    volume(source, slice(...FIT.cmbBladeFraction), y(designHeights.cmbTowerM - FIT.cmbCapM),
      y(designHeights.cmbTowerM), 'superHqMetal', { id: `${source.id}:crown-cap`, heightSource: 'design' })
  ];
  // 东侧入口雨棚朝超级总部场地，投影在足迹外 6 m 内。
  const middle = (bounds.minZ + bounds.maxZ) / 2;
  parts.push(span(source, { ...point(bounds.maxX - 1.2, middle), y: y(9.2) },
    { ...point(bounds.maxX + 6.2, middle), y: y(9.2) }, bounds.depth - 16, bounds.depth - 16, 0.9,
    'superHqMetal', { id: `${source.id}:entrance-canopy` }));
  return parts;
}

// ── 规划展览馆 ──────────────────────────────────────────────────

function exhibitionParts(source, terrain) {
  const outer = source.polygons[0].outer;
  const base = ringFooting(outer, terrain, 3);
  if (base === null) return [];
  const centroid = ringCentroid(outer);
  const inset = ratio => outer.map(p => point(centroid.x + (p.x - centroid.x) * ratio,
    centroid.z + (p.z - centroid.z) * ratio));
  const y = value => base + value;
  const bounds = ringBounds(outer);
  const middle = (bounds.minZ + bounds.maxZ) / 2;
  return [
    volume(source, outer, y(0), y(FIT.exhibitionPlinthM), 'superHqStone', { id: `${source.id}:plinth` }),
    volume(source, inset(0.94), y(FIT.exhibitionPlinthM), y(FIT.exhibitionBodyM), 'superHqGlass',
      { id: `${source.id}:hall` }),
    volume(source, outer, y(FIT.exhibitionBodyM), y(FIT.exhibitionRoofM), 'superHqMetal',
      { id: `${source.id}:roof` }),
    volume(source, inset(0.62), y(FIT.exhibitionRoofM), y(FIT.exhibitionRoofM + FIT.exhibitionLiftM),
      'superHqGlass', { id: `${source.id}:lantern` }),
    // 东侧入口雨棚：朝超级总部场地一侧。
    span(source, { ...point(bounds.maxX - 1.2, middle), y: y(5.6) },
      { ...point(bounds.maxX + 4.8, middle), y: y(5.6) }, 18, 18, 0.8, 'superHqMetal',
      { id: `${source.id}:entrance-canopy` })
  ];
}

// ── 超级总部站地面部分（地下站，只做地面出入口） ─────────────────

function stationInteriors(ring, count) {
  const bounds = ringBounds(ring);
  const groups = Array.from({ length: count }, () => []);
  for (let x = bounds.minX + 4; x <= bounds.maxX - 4; x += 3) {
    for (let z = bounds.minZ + 4; z <= bounds.maxZ - 4; z += 3) {
      if (!inRing(ring, x, z) || boundaryDistance(ring, x, z) < 8) continue;
      const group = Math.min(count - 1, Math.floor((x - bounds.minX) / bounds.width * count));
      groups[group].push({ x, z });
    }
  }
  const chosen = [];
  for (const candidates of groups) {
    if (candidates.length === 0) continue;
    // 每组取最靠北（朝 C 塔场地）的可用点，再取中位，避免出入口全挤在端部。
    candidates.sort((a, b) => a.z - b.z || a.x - b.x);
    const slice = candidates.slice(0, Math.max(1, Math.min(6, candidates.length)))
      .sort((a, b) => a.x - b.x);
    chosen.push(slice[Math.floor(slice.length / 2)]);
  }
  return chosen;
}

function stationParts(source, terrain) {
  const ring = source.polygons[0].outer;
  const base = ringFooting(ring, terrain, 6);
  if (base === null) return [];
  const spots = stationInteriors(ring, FIT.stationCount);
  if (spots.length < 2) return [];
  const parts = [];
  for (const [index, spot] of spots.entries()) {
    const ground = grade(terrain, spot);
    if (ground === null) continue;
    const box = (halfX, halfZ) => [
      point(spot.x - halfX, spot.z - halfZ), point(spot.x + halfX, spot.z - halfZ),
      point(spot.x + halfX, spot.z + halfZ), point(spot.x - halfX, spot.z + halfZ)
    ];
    parts.push(volume(source, box(5.2, 3.6), ground, ground + 0.35, 'superHqStone',
      { id: `${source.id}:entrance:${index}:plinth` }));
    parts.push(volume(source, box(3.2, 2.3), ground + 0.35, ground + FIT.stationEntranceM, 'superHqGlass',
      { id: `${source.id}:entrance:${index}:cabin` }));
    parts.push(volume(source, box(4.4, 3.2), ground + FIT.stationEntranceM, ground + FIT.stationCanopyM,
      'superHqMetal', { id: `${source.id}:entrance:${index}:canopy` }));
    // 站名标识条：挂在雨棚朝场地一侧的檐口，只用色带和灯光，不写品牌名。
    const signRing = [
      point(spot.x - 2.1, spot.z - 3.32), point(spot.x + 2.1, spot.z - 3.32),
      point(spot.x + 2.1, spot.z - 3.04), point(spot.x - 2.1, spot.z - 3.04)
    ];
    parts.push(volume(source, signRing, ground + FIT.stationCanopyM - 0.85,
      ground + FIT.stationCanopyM - 0.08, 'superHqSign', { id: `${source.id}:entrance:${index}:sign` }));
  }
  return parts;
}

// ── 组装 ────────────────────────────────────────────────────────

function siteSources(context) {
  const sites = context?.sites;
  if (!sites?.site?.polygons?.length) return null;
  const sources = { site: designSource(SITE.site, sites.site.polygons[0], designHeights.eastTowerM, 'design') };
  if (sites.cmbTower?.polygons?.length) sources.cmb = designSource(SITE.cmbTower,
    sites.cmbTower.polygons[0], designHeights.cmbTowerM, 'design');
  if (sites.exhibitionHall?.polygons?.length) sources.exhibition = designSource(SITE.exhibitionHall,
    sites.exhibitionHall.polygons[0], FIT.exhibitionRoofM + FIT.exhibitionLiftM, 'estimate');
  if (sites.metroStation?.polygons?.length) sources.station = designSource(SITE.metroStation,
    sites.metroStation.polygons[0], FIT.stationCanopyM, 'estimate');
  return sources;
}

function towerInsideSite(plan) {
  const polygon = plan.polygon;
  const ground = towerRing({ scale: FIT.towerSkirtFlare, lean: 0 },
    plan.east.center, plan.frame.longAxis);
  const westGround = towerRing({ scale: FIT.towerSkirtFlare, lean: 0 },
    plan.west.center, plan.frame.longAxis);
  return [...ground, ...westGround].every(p => inRing(polygon.outer, p.x, p.z));
}

/** 解析：超总按建好形态建模：C 塔双塔 + 连廊 + 招银 387 m + 展馆 + 车站地面口 + 十字双轴。
 *  输入：source（不用，占位）、terrain、context.sites（场地/招银/展馆/车站多边形）。
 *  输出：部件数组（245 部件/4,540 三角）；场地缺失时返回 []，不凭地标 id 造体量。 */
export function build(source, terrain, context = {}) {
  const sources = siteSources(context);
  if (!sources || !terrain) return [];
  const plan = twinTowerPlan(sources.site.polygons[0]);
  if (!plan) return [];
  plan.polygon = sources.site.polygons[0];
  if (!towerInsideSite(plan)) return [];
  const eastSource = designSource('design/super-hq:c-tower-east', sources.site.polygons[0],
    designHeights.eastTowerM, 'design');
  const westSource = designSource('design/super-hq:c-tower-west', sources.site.polygons[0],
    designHeights.westTowerM, 'design');
  const east = towerParts(eastSource, plan.east, plan.frame.longAxis, terrain);
  const west = towerParts(westSource, plan.west, plan.frame.longAxis, terrain);
  if (!east || !west) return [];
  const bridgeSource = designSource('design/super-hq:skybridge', sources.site.polygons[0],
    FIT.bridgeBodyM + 0.7, 'design');
  const axisSource = designSource('estimate/super-hq:cross-axes', sources.site.polygons[0],
    FIT.axisThicknessM, 'estimate');
  const parts = [...east.parts, ...west.parts, ...skybridgeParts(bridgeSource, plan, terrain),
    ...axisParts(axisSource, terrain, plan)];
  if (sources.cmb) parts.push(...cmbTowerParts(sources.cmb, terrain));
  if (sources.exhibition) parts.push(...exhibitionParts(sources.exhibition, terrain));
  if (sources.station) parts.push(...stationParts(sources.station, terrain));
  return parts;
}

// ── 材质 ────────────────────────────────────────────────────────

const glazingStyles = {
  // sill 是每个窗格竖向留给玻璃的比例（0.5 为满格无横缝），与 nonferrous 的口径一致。
  superHqGlass: { frame: 0x839097, tint: 0x4c697b, top: 0x7e919d, bay: 1.54, floor: 4.55, sill: 0.455, lit: 0.085 },
  superHqCmbGlass: { frame: 0x929fa6, tint: 0x587384, top: 0x85979f, bay: 2.24, floor: 4.15, sill: 0.44, lit: 0.055 }
};

function glassMaterial(style, facet) {
  const material = new THREE.MeshStandardNodeMaterial();
  const coord = uv();
  const u = coord.x.div(style.bay), v = coord.y.div(style.floor);
  const soften = cell => max(fwidth(cell), 0.004);
  const pane = (cell, edge) => smoothstep(float(edge).sub(soften(cell)), float(edge).add(soften(cell)),
    abs(fract(cell).sub(0.5))).oneMinus();
  const detail = smoothstep(0.18, 0.73, max(soften(u), soften(v))).oneMinus();
  const glass = mix(float(0.78), pane(u, 0.47).mul(pane(v, style.sill)), detail);
  const wall = smoothstep(0.14, 0.57, abs(normalWorldGeometry.y)).oneMinus();
  const cell = fract(sin(dot(vec2(floor(u), floor(v)), vec2(16.843, 57.193))).mul(43758.5453));
  const tint = color(style.tint).mul(mix(float(1), cell.mul(0.17).add(0.91), detail));
  const reflect = abs(dot(cameraPosition.sub(positionWorld).normalize(), normalWorldGeometry)).oneMinus().pow(2.4);
  const window = mix(tint, color(0x8299aa), reflect.mul(sceneUniforms.night.oneMinus()).mul(0.18));
  material.colorNode = mix(color(style.top), mix(color(style.frame), window, glass), wall);
  if (facet) {
    // 招银塔身保留三角玻璃的斜向折缝，以低对比度表达折板。
    const diagonal = coord.x.mul(0.16).add(coord.y.mul(0.11));
    const seam = smoothstep(float(0.47), float(0.5), abs(fract(diagonal).sub(0.5)))
      .mul(smoothstep(0.16, 0.7, fwidth(diagonal)).oneMinus());
    material.colorNode = mix(material.colorNode, color(0x98aab4), seam.mul(wall).mul(0.24));
  }
  material.roughnessNode = mix(float(0.72), float(0.61), wall.mul(glass));
  material.metalnessNode = wall.mul(glass).mul(0.12);
  const lit = mix(float(style.lit * 0.21), step(cell, style.lit).mul(0.43), detail);
  material.emissiveNode = color(0xebd6b2).mul(lit).mul(wall).mul(glass).mul(sceneUniforms.night);
  return material;
}

function pavingMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.05, roughness: 0.78 });
  const x = positionWorld.x.mul(0.31).add(positionWorld.z.mul(0.05));
  const z = positionWorld.z.mul(0.29).sub(positionWorld.x.mul(0.04));
  const joint = cell => smoothstep(float(0.455), float(0.5), abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.12, 0.5, fwidth(cell)).oneMinus());
  const seams = max(joint(x), joint(z));
  material.colorNode = mix(color(0xb9b6ac), color(0x8f8d86), seams.mul(0.55));
  material.roughnessNode = mix(float(0.82), float(0.68), seams);
  return material;
}

function plantingMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.02, roughness: 0.92 });
  const wave = positionWorld.x.mul(0.083).add(positionWorld.z.mul(0.061));
  material.colorNode = mix(color(0x4f6a3e), color(0x76904f), sin(wave).mul(0.5).add(0.5));
  return material;
}

function stoneMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.04, roughness: 0.68 });
  const x = positionWorld.x.mul(0.21).add(positionWorld.z.mul(0.03));
  const y = positionWorld.y.mul(0.17);
  const joint = cell => smoothstep(float(0.46), float(0.5), abs(fract(cell).sub(0.5)))
    .mul(smoothstep(0.14, 0.55, fwidth(cell)).oneMinus());
  material.colorNode = mix(color(0xcdcec6), color(0xb1b3ab), max(joint(x), joint(y)).mul(0.5));
  return material;
}

function metalMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.17, roughness: 0.58 });
  const streak = sin(positionWorld.y.mul(0.42).add(positionWorld.x.mul(0.07))).mul(0.5).add(0.5);
  material.colorNode = mix(color(0xc2c9cb), color(0x96a0a4), streak.mul(0.35));
  material.emissiveNode = color(0xa8c7e4).mul(smoothstep(90, 320, positionWorld.y))
    .mul(sceneUniforms.night).mul(0.12);
  return material;
}

function signMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.2, roughness: 0.4 });
  material.colorNode = color(0x24424e);
  material.emissiveNode = color(0x9fd6e6).mul(sceneUniforms.night.mul(0.75).add(0.35));
  return material;
}

/** 解析：超总专用材质分派（superHqGlass/superHqCmbGlass/superHqMetal/superHqStone 等 7 种）。
 *  输入：样式名（materials 导出列表）。
 *  输出：对应 MeshStandardNodeMaterial；未知名字直接抛错，避免静默用错材质。 */
export function createSuperHqMaterial(name) {
  if (Object.hasOwn(glazingStyles, name)) return glassMaterial(glazingStyles[name], name === 'superHqCmbGlass');
  switch (name) {
    case 'superHqMetal': return metalMaterial();
    case 'superHqStone': return stoneMaterial();
    case 'superHqPaving': return pavingMaterial();
    case 'superHqGreen': return plantingMaterial();
    case 'superHqSign': return signMaterial();
    default: throw new Error(`Unknown Super HQ material: ${name}`);
  }
}

export function modelCard() {
  return {
    id: 'super-hq',
    name: '深圳湾超级总部基地',
    osm: { ...SITE },
    designHeights: { ...designHeights },
    heightSources: { cTower: 'design', skybridge: 'design', cmbTower: 'design',
      crossAxes: 'estimate', metroStation: 'estimate', exhibitionHall: 'estimate' },
    fittedDimensions: { ...FIT },
    materials: [...materials],
    gaps: ['无施工图和幕墙详图，塔身曲面、连廊非对称造型按效果图拟合',
      'C 塔幕墙施工中，模型按建好形态满铺',
      '连廊可行走性和桥下净空未在浏览器实走验收']
  };
}
