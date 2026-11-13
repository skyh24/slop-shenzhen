import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld } from 'three/tsl';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';

// 立交桥面高程没有实测纵断面，按 layer 的估算层高派生，接触面与显示几何共用同一批三角面。
const LAYER_HEIGHT_M = 4.8;
const GIRDER_DEPTH_M = 0.35;
const DECK_STEP_M = 4;
const PIER_SPACING_M = 28;
const PIER_MIN_CLEARANCE_M = 2;
const MAX_CHUNKS = 12;
const EPSILON = 1e-8;
// 护栏尺寸照武汉参考实现（0.95 m 高、0.35 m 宽）估计，不是深圳设计图尺寸。
const BARRIER_HEIGHT_M = 0.95;
const ELEVATED_BARRIER_WIDTH_M = 0.35;
// 桥面离开地面超过这个高度才加护栏；匝道落地段两侧留开口给车辆进出。
const BARRIER_MIN_SEPARATION_M = 0.75;
// 已核实的同向合流、分流。共同桥段与两支道均须在源路网节点和估算桥高上相接。
const CHEGONGMIAO_SPLIT = ['node/8020094690', 'startNode', ['way/854919713', 'way/1524817657'], 'way/854919717'];
const CHEGONGMIAO_JUNCTIONS = [
  ['node/498882081', 'endNode', ['way/40955020', 'way/961590249'], 'way/854919717'],
  CHEGONGMIAO_SPLIT
];
const ELEVATED_JOIN_TOLERANCE_M = 0.35;
// 游戏车身高度余量，用于判断护栏是否侵入相邻支道。
const JUNCTION_BARRIER_CLEARANCE_M = 2;
// 车行链路只接受可驾驶的估计纵坡；更陡的派生桥面是未核实断面，不接入车流/自动导航。
export const ELEVATED_DRIVE_MAX_GRADE = 0.12;
export const ELEVATED_BARRIER_HEIGHT_M = BARRIER_HEIGHT_M;

const DEFAULT_ELEVATED_AREA = Object.freeze({ minX: -3800, maxX: -2500, minZ: 500, maxZ: 1300 });

// 立交分区：只对 OSM 已有 bridge、tunnel、layer 和匝道的对象建。
// 每个分区是一块矩形选区，用来把同一条匝道稳定归到一处立交；layer 仍只是上下关系，
// 桥面标高按 estimated 层高派生，任何数值都不能写成实测高程。
export const SHENZHEN_INTERCHANGES = Object.freeze([
  Object.freeze({
    id: 'chegongmiao',
    name: '车公庙立交',
    source: 'OSM 车公庙立交 trunk_link 与香蜜湖路 bridge（快照见 data/source/sources.json）',
    area: Object.freeze({ minX: -3800, maxX: -2500, minZ: 500, maxZ: 1300 }),
    heightSource: 'estimate'
  }),
  Object.freeze({
    id: 'shennan-guangshen',
    name: '深南广深立交',
    // 选区取深南广深立交桥 OSM 匝道范围外扩 300 m：深南大道与京港澳高速（广深段）的喇叭形匝道都在其中。
    source: 'OSM 深南广深立交桥 motorway_link/secondary_link bridge layer 1 与京港澳高速 bridge layer 1',
    area: Object.freeze({ minX: -4992, maxX: -3913, minZ: 543, maxZ: 1412 }),
    heightSource: 'estimate'
  }),
  Object.freeze({
    id: 'zhuzilin',
    name: '竹子林立交',
    // 选区取竹子林立交桥 OSM 匝道范围外扩 300 m：滨河大道与京港澳高速（广深段）的喇叭形匝道在此交汇。
    source: 'OSM 竹子林立交桥 primary_link bridge layer 1 与京港澳高速 bridge layer 1',
    area: Object.freeze({ minX: -4703, maxX: -3973, minZ: 1368, maxZ: 2096 }),
    heightSource: 'estimate'
  })
]);

const LIMITATIONS = [
  '桥面高度按 OSM layer 每层 4.8 m 估算，没有实测纵断面或设计线形校正。',
  '匝道与地面道路共享节点处按地形高程落地，坡度为两端线性插值，不是测量坡度。',
  '只建 OSM 已有 bridge、layer 和匝道来源的桥面；OSM tunnel 链路只做离线审核，不摊成贴地桥面。',
  '桥墩按约 28 m 间距估计布置，只在净空大于 2 m 时设墩，墩位与基础未做地勘核实。',
  '护栏按 0.95 m 高、0.35 m 宽的混凝土护栏估计，仅桥面离开地面 0.75 m 以上的段落连续设置；不是深圳设计图尺寸。',
  '车行链路只接受非隧道、layer>0 且派生纵坡不超过 12% 的桥面；高程未知或层间不连续的链路不接入车流和自动导航。'
];

function normalizeArea(area) {
  if (!area || typeof area !== 'object') throw new Error('An elevated road area is required');
  const normalized = {
    minX: area.minX, maxX: area.maxX, minZ: area.minZ, maxZ: area.maxZ
  };
  if (!Object.values(normalized).every(Number.isFinite)
    || normalized.minX >= normalized.maxX || normalized.minZ >= normalized.maxZ) {
    throw new Error('Invalid elevated road area');
  }
  return normalized;
}

// 兼容两种调用：一块矩形（旧接口）或 { interchanges: [...] }（多立交分区）。
function normalizeInterchanges(options) {
  if (options && Number.isFinite(options.minX)) {
    return [{
      id: 'default',
      name: '自定义高架范围',
      source: '调用方传入的矩形范围',
      area: normalizeArea(options),
      heightSource: 'estimate'
    }];
  }
  const list = options?.interchanges ?? SHENZHEN_INTERCHANGES;
  if (!Array.isArray(list) || list.length === 0) throw new Error('At least one interchange area is required');
  const seen = new Set();
  return list.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string'
      || !entry.name || typeof entry.source !== 'string') {
      throw new Error('An interchange requires id, name and source');
    }
    if (seen.has(entry.id)) throw new Error(`Duplicate interchange id: ${entry.id}`);
    seen.add(entry.id);
    if (entry.heightSource !== 'estimate') throw new Error(`Interchange ${entry.id} height must stay an estimate`);
    return { id: entry.id, name: entry.name, source: entry.source,
      area: normalizeArea(entry.area), heightSource: 'estimate' };
  });
}

function validateGraph(graph) {
  if (!Array.isArray(graph?.nodes) || graph.nodes.length % 2 !== 0
    || !Array.isArray(graph?.links) || !Array.isArray(graph?.metadata)
    || graph.links.length !== graph.metadata.length || !Array.isArray(graph?.names)) {
    throw new Error('A source road graph with link metadata is required');
  }
}

function inArea(point, area) {
  return point.x >= area.minX && point.x <= area.maxX && point.z >= area.minZ && point.z <= area.maxZ;
}

// Liang-Barsky：只要线段穿过矩形就选中，避免长匝道两端都在范围外时被漏掉。
function segmentIntersectsArea(a, b, area) {
  if (inArea(a, area) || inArea(b, area)) return true;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let from = 0;
  let to = 1;
  const edges = [
    [-dx, a.x - area.minX], [dx, area.maxX - a.x],
    [-dz, a.z - area.minZ], [dz, area.maxZ - a.z]
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > to) return false;
      if (ratio > from) from = ratio;
    } else {
      if (ratio < from) return false;
      if (ratio < to) to = ratio;
    }
  }
  return from <= to;
}

function polylineIntersectsArea(points, area) {
  for (let i = 0; i < points.length; i++) {
    if (inArea(points[i], area)) return true;
    if (i > 0 && segmentIntersectsArea(points[i - 1], points[i], area)) return true;
  }
  return false;
}

function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return length;
}

// 规范化到「从字典序较小的一端走」，同一段路面无论 OSM 方向都只认一次。
function canonicalSignature(points) {
  const key = list => list.map(point => `${point.x.toFixed(4)},${point.z.toFixed(4)}`).join(';');
  const forward = key(points);
  const backward = key([...points].reverse());
  return forward < backward ? forward : backward;
}

function resample(points, maxStep) {
  if (points.length < 2) return [];
  const stations = [{ x: points[0].x, z: points[0].z, d: 0 }];
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < EPSILON) continue;
    const steps = Math.max(1, Math.ceil(length / maxStep));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const next = distance + length * t;
      stations.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: next });
    }
    distance += length;
  }
  return distance > EPSILON ? stations : [];
}

function stationFrames(stations, width) {
  const half = width / 2;
  return stations.map((station, index) => {
    const previous = stations[Math.max(0, index - 1)];
    const next = stations[Math.min(stations.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = dz / length;
    const nz = -dx / length;
    return {
      ...station,
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half },
      nx, nz
    };
  });
}

function triangleArea2D(a, b, c) {
  return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
}

function pushTriangle(target, a, b, c) {
  target.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function pushTopQuad(geometry, surface, a, b, c, d) {
  // 参数顺序为左前、右前、右后、左后；逆时针（x 东、z 南）让法线朝上。
  pushTriangle(geometry, a, b, c);
  pushTriangle(geometry, a, c, d);
  // 接触面按 controller-surfaces 的三点三角面数组保存，和渲染几何同源。
  surface.push([a, b, c], [a, c, d]);
}

// topA→topB 的左侧为外法线方向；底边高度按两端桥面坡度分别给出。
function pushVerticalWall(geometry, topA, topB, bottomA, bottomB) {
  const lowA = { x: topA.x, y: bottomA, z: topA.z };
  const lowB = { x: topB.x, y: bottomB, z: topB.z };
  pushTriangle(geometry, topA, lowB, lowA);
  pushTriangle(geometry, topA, topB, lowB);
}

function pushEndCap(geometry, leftTop, rightTop, bottomY, forward) {
  const lowLeft = { x: leftTop.x, y: bottomY, z: leftTop.z };
  const lowRight = { x: rightTop.x, y: bottomY, z: rightTop.z };
  if (forward) {
    pushTriangle(geometry, leftTop, lowRight, lowLeft);
    pushTriangle(geometry, leftTop, rightTop, lowRight);
  } else {
    pushTriangle(geometry, leftTop, lowLeft, lowRight);
    pushTriangle(geometry, leftTop, lowRight, rightTop);
  }
}

// 护栏的四边形按给定顺序拆两个三角形；渲染面是单面材质，护栏内外面都从这里来。
function pushQuad(geometry, a, b, c, d) {
  pushTriangle(geometry, a, b, c);
  pushTriangle(geometry, a, c, d);
}

// 桥面离开地面超过阈值才设护栏，落地段两侧留开口；与武汉参考的 surface-barriers 同一口径。
function barrierSpanOnGround(a, b, groundHeight) {
  const separation = point => point.y - (groundHeight(point.x, point.z) ?? point.y);
  const da = separation(a);
  const db = separation(b);
  if (!(Math.max(da, db) > BARRIER_MIN_SEPARATION_M)) return null;
  const at = t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const crossing = (BARRIER_MIN_SEPARATION_M - da) / (db - da);
  const from = da <= BARRIER_MIN_SEPARATION_M ? crossing : 0;
  const to = db <= BARRIER_MIN_SEPARATION_M ? crossing : 1;
  return [at(Math.max(0, Math.min(1, from))), at(Math.max(0, Math.min(1, to)))];
}

function pushPier(geometry, pier) {
  const { x, z, baseY, topY, half } = pier;
  const p0 = { x: x - half, z: z - half };
  const p1 = { x: x + half, z: z - half };
  const p2 = { x: x + half, z: z + half };
  const p3 = { x: x - half, z: z + half };
  for (const [a, b] of [[p0, p1], [p1, p2], [p2, p3], [p3, p0]]) {
    pushVerticalWall(geometry, { x: a.x, y: topY, z: a.z }, { x: b.x, y: topY, z: b.z }, baseY, baseY);
  }
}

function pierSpacing(record) {
  const stations = record.frames;
  const tiles = [];
  for (let distance = PIER_SPACING_M / 2; distance < record.lengthM - 1; distance += PIER_SPACING_M) {
    let index = 1;
    while (index < stations.length - 1 && stations[index].d < distance) index++;
    tiles.push(stations[index]);
  }
  return tiles;
}

/** 解析：单条高架/匝道链路 → 桥面缎带、护栏、桥墩、可站立三角面。
 *  高度：与地面道路共享的端点落地为地形；其余端点按 `layer×4.8 m` 估计，沿线线性插值，
 *        内部再用中心+两侧地形采样做下限，避免桥面埋入地面。
 *  显示和接触同源：桥面顶面三角面给控制器当可站立面，护栏与桥墩的接触体从同一批顶点生成。
 *  输出：{ frames, geometry, topTriangles, barriers, BarrierColliders, PierColliders, surfaceId, ... }。 */
function planLink(graph, link, index, metadata, groundHeight, groundNodes, reviewed = null) {
  const points = roadLinkPoints(graph, link);
  if (points.length < 2) return null;
  const length = polylineLength(points);
  if (length <= EPSILON) return null;
  const [start, end] = [link[0], link[1]];
  const startGround = groundHeight(points[0].x, points[0].z);
  const endGround = groundHeight(points[points.length - 1].x, points[points.length - 1].z);
  if (!reviewed && (!Number.isFinite(startGround) || !Number.isFinite(endGround))) return null;
  const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
  const lift = LAYER_HEIGHT_M * Math.max(0, layer);
  const sharedStart = groundNodes.has(start);
  const sharedEnd = groundNodes.has(end);
  const startY = sharedStart ? startGround : startGround + lift;
  const endY = sharedEnd ? endGround : endGround + lift;
  const stations = resample(points, DECK_STEP_M);
  if (stations.length < 2) return null;
  // 高架/匝道桥面按最小 6.5 m 铺装：OSM 里不少匝道只有 3–4 m 宽，车辆很容易偏出缎带
  // （round 35 诊断）；6.5 m 在双向匝道与视觉合理之间折中（10 m 会与测试面积口径冲突）。
  const width = reviewed?.widthM ?? Math.max(link[3], 6.5);
  const frames = stationFrames(stations, width);
  const deckHeightAt = reviewed?.heightAt ?? (reviewed
    ? (d => {
      const [a, b] = reviewed.portalHeights;
      const run = delta => Math.min(length / 2, Math.max(4, Math.abs(delta) / 0.05));
      const startWeight = Math.max(0, 1 - d / run(a - reviewed.heightM));
      const endWeight = Math.max(0, 1 - (length - d) / run(b - reviewed.heightM));
      return reviewed.heightM + (a - reviewed.heightM) * startWeight + (b - reviewed.heightM) * endWeight;
    })
    : distance => startY + (endY - startY) * Math.min(1, distance / length));
  const girderDepth = reviewed?.girderDepthM ?? GIRDER_DEPTH_M;
  const half = Math.max(0.7, Math.min(1.4, width * 0.08));
  const geometry = [];
  const topTriangles = [];
  const pierRecords = [];
  const pierColliders = [];
  const slabColliders = [];
  const surfaceId = reviewed?.surfaceId ?? `sz-elevated-road:${index}`;
  const osmId = metadata.osmId ?? null;
  let areaM2 = 0;
  let maxClearanceM = 0;

  for (const frame of frames) {
    // 端点之间按直线坡度插值；地形在 link 中部抬升时以地面为下限，避免桥面埋入地下。
    const linearY = deckHeightAt(frame.d);
    const centerGround = groundHeight(frame.x, frame.z);
    const edgeGrounds = [frame.left, frame.right]
      .map(point => groundHeight(point.x, point.z))
      .filter(Number.isFinite);
    const floor = Math.max(centerGround ?? -Infinity, ...edgeGrounds);
    frame.y = reviewed ? linearY : Math.max(linearY, Number.isFinite(floor) ? floor : linearY);
    if (Number.isFinite(centerGround)) maxClearanceM = Math.max(maxClearanceM, frame.y - centerGround);
  }
  // 端部各外延 4 m 平段，让相邻链路/地面路的接触面在节点处有重叠，避免车辆在
  // 链路交界因支撑高度跳变 >1.5 m 被判定“无支撑”而刹停（round 30/34 诊断）。
  const OVERLAP_M = 4;
  const overlapFrame = (frame, inner) => {
    const dx = frame.x - inner.x, dz = frame.z - inner.z;
    const length = Math.hypot(dx, dz) || 1;
    const x = frame.x + dx / length * OVERLAP_M, z = frame.z + dz / length * OVERLAP_M;
    return { ...frame, x, z, d: frame.d + OVERLAP_M,
      left: { x: x + frame.nx * half, z: z + frame.nz * half },
      right: { x: x - frame.nx * half, z: z - frame.nz * half } };
  };
  const [splitNode, , , splitApproach] = CHEGONGMIAO_SPLIT;
  // 分流处由下游桥段向后搭接。同一节点的上游平桥不再向前盖住下坡活动面。
  const endsAtSplit = metadata.osmId === splitApproach && graph.nodeIds?.[end] === splitNode && link[5] === 1;
  const surfaceFrames = reviewed?.walk ? [...frames] : [overlapFrame(frames[0], frames[1]), ...frames];
  if (!reviewed?.walk && !endsAtSplit) surfaceFrames.push(overlapFrame(frames.at(-1), frames.at(-2)));
  for (let i = 1; i < surfaceFrames.length; i++) {
    const a = surfaceFrames[i - 1];
    const b = surfaceFrames[i];
    const topA = { x: a.left.x, y: a.y, z: a.left.z };
    const topB = { x: b.left.x, y: b.y, z: b.left.z };
    const topC = { x: b.right.x, y: b.y, z: b.right.z };
    const topD = { x: a.right.x, y: a.y, z: a.right.z };
    pushTopQuad(geometry, topTriangles, topA, topD, topC, topB);
    areaM2 += triangleArea2D(topA, topB, topC) + triangleArea2D(topA, topC, topD);
    pushVerticalWall(geometry, topA, topB, a.y - girderDepth, b.y - girderDepth);
    pushVerticalWall(geometry, topC, topD, b.y - girderDepth, a.y - girderDepth);
    if (reviewed) {
      const [u, v, w, t] = [topA, topB, topC, topD].map(p => ({ ...p, y: p.y - girderDepth }));
      pushQuad(geometry, u, v, w, t);
      // 仅登记梁体厚度，桥下净空不会被盒子填满。
      const outer = [topA, topB, topC, topD].map(({ x, z }) => ({ x, z }));
      slabColliders.push({ type: 'elevated-slab', sourceId: osmId, polygon: { outer, holes: [] },
        minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
        minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
        minY: Math.min(u.y, v.y), maxY: Math.max(topA.y, topB.y),
        verticalSpan: [u.y, v.y, topA.y, topB.y] });
    }
  }

  // 端部封口让桥面板在起点和终点读成实体，不把顶面悬空。
  const first = frames[0];
  const last = frames[frames.length - 1];
  const firstLeft = { x: first.left.x, y: first.y, z: first.left.z };
  const firstRight = { x: first.right.x, y: first.y, z: first.right.z };
  const lastLeft = { x: last.left.x, y: last.y, z: last.left.z };
  const lastRight = { x: last.right.x, y: last.y, z: last.right.z };
  pushEndCap(geometry, firstLeft, firstRight, first.y - girderDepth, false);
  pushEndCap(geometry, lastLeft, lastRight, last.y - girderDepth, true);

  for (const station of pierSpacing({ frames, lengthM: length })) {
    const terrainY = reviewed
      ? (reviewed.pierAt?.(station.x, station.z, half) ? reviewed.waterHeightM - 1 : null)
      : groundHeight(station.x, station.z);
    if (!Number.isFinite(terrainY)) continue;
    const clearance = station.y - terrainY;
    if (clearance <= PIER_MIN_CLEARANCE_M) continue;
    const topY = station.y - girderDepth;
    if (topY - terrainY <= 0.2) continue;
    const pier = { x: station.x, z: station.z, baseY: terrainY, topY, half };
    pierRecords.push(pier);
    pushPier(geometry, pier);
    // 桥墩接触体和可见墩身同一尺寸，minY 从地面起，只挡桥墩本身。
    pierColliders.push({
      type: 'elevated-pier',
      name: `${surfaceId}:pier:${pierRecords.length}`,
      sourceId: osmId,
      minX: pier.x - half,
      maxX: pier.x + half,
      minZ: pier.z - half,
      maxZ: pier.z + half,
      minY: terrainY,
      maxY: topY,
      polygon: {
        outer: [{ x: pier.x - half, z: pier.z - half }, { x: pier.x + half, z: pier.z - half },
          { x: pier.x + half, z: pier.z + half }, { x: pier.x - half, z: pier.z + half }],
        holes: []
      }
    });
  }

  return {
    index,
    osmId,
    reviewed,
    name: graph.names[link[2]] ?? '',
    width,
    barrierWidthM: ELEVATED_BARRIER_WIDTH_M,
    lanes: link[4],
    direction: link[5],
    bridge: metadata.bridge === true,
    tunnel: metadata.tunnel === true,
    layer,
    startNode: start,
    endNode: end,
    sharedStart,
    sharedEnd,
    startGroundHeight: startGround,
    endGroundHeight: endGround,
    startDeckY: frames[0].y,
    endDeckY: frames[frames.length - 1].y,
    lengthM: length,
    areaM2,
    maxClearanceM,
    maxGrade: reviewed ? Math.max(...frames.slice(1).map((b, i) => Math.abs(b.y - frames[i].y) / (b.d - frames[i].d)))
      : Math.abs(endY - startY) / length,
    points,
    frames,
    geometry,
    topTriangles,
    piers: pierRecords,
    pierColliders,
    slabColliders,
    surfaceId
  };
}

// 确认同一合流/分流的所有支道；相邻但不同层、不同节点或反向的路不互相开口。
function reviewedJunctionNeighbors(graph, driveLinks) {
  const neighbors = new Map();
  for (const [nodeId, branchEnd, branchIds, commonId] of CHEGONGMIAO_JUNCTIONS) {
    const node = graph.nodeIds?.indexOf(nodeId) ?? -1;
    if (node < 0) continue;
    const branchHeight = branchEnd === 'endNode' ? 'endDeckY' : 'startDeckY';
    const commonEnd = branchEnd === 'endNode' ? 'startNode' : 'endNode';
    const commonHeight = commonEnd === 'endNode' ? 'endDeckY' : 'startDeckY';
    const common = driveLinks.find(link => link.osmId === commonId && link[commonEnd] === node && link.direction === 1);
    if (!common) continue;
    const branches = branchIds.map(id => driveLinks.find(link => link.osmId === id && link[branchEnd] === node
      && link.direction === 1 && Math.abs(link[branchHeight] - common[commonHeight]) <= ELEVATED_JOIN_TOLERANCE_M));
    if (branches.some(link => !link)) continue;
    const roads = [...branches, common];
    for (const road of roads) {
      const others = neighbors.get(road) ?? new Set();
      for (const other of roads) if (other !== road) others.add(other);
      neighbors.set(road, others);
    }
  }
  return neighbors;
}

function addBarriers(record, groundHeight, neighbors = []) {
  const { frames, geometry, osmId, surfaceId } = record;
  const barrierRecords = [];
  const barrierColliders = [];
  let barrierLengthM = 0;
  const adjacent = [...neighbors].map(road => ({ id: road.surfaceId, triangles: road.topTriangles }));
  const heightAt = adjacent.length ? createSurfaceHeightAt(adjacent) : null;
  const blocksNeighbor = (a, b) => [0, 0.25, 0.5, 0.75, 1].some(t => {
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t;
    return adjacent.some(({ id }) => {
      const deck = heightAt(x, z, id);
      return deck !== null && deck > y - JUNCTION_BARRIER_CLEARANCE_M && deck < y + BARRIER_HEIGHT_M;
    });
  });
  // 护栏与桥面共用边点：显示三角面和侧向接触体都从同一批顶点生成，桥下不设全高挡墙。
  const barrierInward = (point, frameA, frameB, mix, side) => {
    const nx = frameA.nx + (frameB.nx - frameA.nx) * mix;
    const nz = frameA.nz + (frameB.nz - frameA.nz) * mix;
    const length = Math.hypot(nx, nz) || 1;
    const sign = side === 'left' ? -1 : 1;
    return { x: point.x + (nx / length) * ELEVATED_BARRIER_WIDTH_M * sign,
      z: point.z + (nz / length) * ELEVATED_BARRIER_WIDTH_M * sign };
  };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    for (const side of ['left', 'right']) {
      const edgeA = { x: a[side].x, y: a.y, z: a[side].z };
      const edgeB = { x: b[side].x, y: b.y, z: b[side].z };
      const span = barrierSpanOnGround(edgeA, edgeB, record.reviewed
        ? (x, z) => record.reviewed.waterAt?.(x, z) ? record.reviewed.waterHeightM : groundHeight(x, z)
        : groundHeight);
      if (!span) continue;
      const [start, end] = span;
      const ta = Math.hypot(start.x - edgeA.x, start.z - edgeA.z) / run;
      const tb = Math.hypot(end.x - edgeA.x, end.z - edgeA.z) / run;
      const insetStart = barrierInward(start, a, b, ta, side);
      const insetEnd = barrierInward(end, a, b, tb, side);
      // 护栏外缘和内缘共用显示/接触开口，按相邻桥面的实际三角面保留合流、分流通行区。
      if (heightAt && (blocksNeighbor(start, end)
        || blocksNeighbor({ ...insetStart, y: start.y }, { ...insetEnd, y: end.y }))) continue;
      const startTop = { x: start.x, y: start.y + BARRIER_HEIGHT_M, z: start.z };
      const endTop = { x: end.x, y: end.y + BARRIER_HEIGHT_M, z: end.z };
      const insetStartTop = { x: insetStart.x, y: start.y + BARRIER_HEIGHT_M, z: insetStart.z };
      const insetEndTop = { x: insetEnd.x, y: end.y + BARRIER_HEIGHT_M, z: insetEnd.z };
      const startBottom = { x: start.x, y: start.y, z: start.z };
      const endBottom = { x: end.x, y: end.y, z: end.z };
      const insetStartBottom = { x: insetStart.x, y: start.y, z: insetStart.z };
      const insetEndBottom = { x: insetEnd.x, y: end.y, z: insetEnd.z };
      // 外侧面、顶面、内侧面；渲染材质是单面，护栏从桥面两侧看都要有面。
      pushQuad(geometry, startBottom, endBottom, endTop, startTop);
      pushQuad(geometry, startTop, endTop, insetEndTop, insetStartTop);
      pushQuad(geometry, insetStartBottom, insetStartTop, insetEndTop, insetEndBottom);
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      barrierLengthM += length;
      barrierRecords.push({ side, length, startY: start.y, endY: end.y });
      // 侧向接触体只占桥面到护栏顶这一段高度，桥下道路照常通行。
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(startTop.y, endTop.y);
      barrierColliders.push({
        type: 'elevated-barrier',
        name: `${surfaceId}:${side}:${barrierRecords.length}`,
        sourceId: osmId,
        minX: Math.min(start.x, end.x, insetStart.x, insetEnd.x),
        maxX: Math.max(start.x, end.x, insetStart.x, insetEnd.x),
        minZ: Math.min(start.z, end.z, insetStart.z, insetEnd.z),
        maxZ: Math.max(start.z, end.z, insetStart.z, insetEnd.z),
        minY,
        maxY,
        polygon: {
          outer: [{ x: start.x, z: start.z }, { x: end.x, z: end.z },
            { x: insetEnd.x, z: insetEnd.z }, { x: insetStart.x, z: insetStart.z }],
          holes: []
        }
      });
    }
  }

  Object.assign(record, { barriers: barrierRecords, barrierColliders, barrierLengthM });
}

function buildChunks(records) {
  if (records.length === 0) return [];
  const count = Math.min(MAX_CHUNKS, records.length);
  const ordered = [...records].sort((a, b) => {
    const ax = a.points[0].x + a.points[a.points.length - 1].x;
    const az = a.points[0].z + a.points[a.points.length - 1].z;
    const bx = b.points[0].x + b.points[b.points.length - 1].x;
    const bz = b.points[0].z + b.points[b.points.length - 1].z;
    return ax - bx || az - bz || a.index - b.index;
  });
  const buckets = Array.from({ length: count }, () => []);
  ordered.forEach((record, rank) => buckets[Math.min(count - 1, Math.floor(rank * count / ordered.length))].push(record));
  return buckets.filter(bucket => bucket.length > 0).map((bucket, chunkIndex) => {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const record of bucket) {
      for (const point of record.points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
    }
    const origin = [minX, minZ];
    const positions = [];
    for (const record of bucket) {
      for (let i = 0; i < record.geometry.length; i += 3) {
        positions.push(record.geometry[i] - origin[0], record.geometry[i + 1], record.geometry[i + 2] - origin[1]);
      }
    }
    return {
      id: `shenzhen-elevated-roads:${chunkIndex}`,
      origin,
      bounds: { minX, maxX, minZ, maxZ },
      positions: new Float32Array(positions),
      linkIndices: bucket.map(record => record.index).sort((a, b) => a - b),
      triangles: bucket.reduce((sum, record) => sum + record.geometry.length / 9, 0)
    };
  });
}


// 跨层连接坡道：相邻高架链路共享节点但 layer 估计不同（如 layer1=4.8 m、layer2=9.6 m）时，
// 桥面会出现 4.8 m 台阶，车辆爬不上去。这里在两条链路各退 ~18 m 处拉一条渐变坡道，坡度控制在 35% 内。
const CONNECTOR_RAMP_M = 18;
const CONNECTOR_MAX_GRADE = 0.35;
const CONNECTOR_SEGMENTS = 10;

function connectorBackFrame(record, end) {
  const frames = record.frames;
  if (frames.length < 4) return null;
  const step = record.lengthM / (frames.length - 1);
  const back = Math.max(1, Math.min(frames.length - 2, Math.round(CONNECTOR_RAMP_M / Math.max(step, 0.5))));
  const frame = end === 'start' ? frames[back] : frames[frames.length - 1 - back];
  return frame ? { frame, width: record.width } : null;
}

/** 解析：在两条高架链路各退约 18 m 处拉一条渐变坡道（顶面 + 可站立三角面）。
 *  输入：低/高层链路端点帧与坡度是否合规标记。
 *  输出：与链路记录同构的坡道记录；宽度取两条链路的 0.85、只生成顶面。 */
function makeConnectorRamp(node, serial, low, high, gradeOK) {
  const a = low.frame, b = high.frame;
  const width = Math.min(low.width, high.width) * 0.85;
  const half = width / 2;
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 6) || !Number.isFinite(length)) return null;
  const px = dz / length, pz = -dx / length;
  const frames = [];
  for (let i = 0; i <= CONNECTOR_SEGMENTS; i++) {
    const t = i / CONNECTOR_SEGMENTS;
    const x = a.x + dx * t, z = a.z + dz * t;
    const y = a.y + (b.y - a.y) * t;
    frames.push({ x, z, y, left: { x: x + px * half, z: z + pz * half }, right: { x: x - px * half, z: z - pz * half } });
  }
  const geometry = [];
  const topTriangles = [];
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1], q = frames[i];
    pushTopQuad(geometry, topTriangles,
      { x: p.left.x, y: p.y, z: p.left.z }, { x: p.right.x, y: p.y, z: p.right.z },
      { x: q.right.x, y: q.y, z: q.right.z }, { x: q.left.x, y: q.y, z: q.left.z });
  }
  const areaM2 = length * width;
  return {
    index: 100000 + serial,
    osmId: null,
    name: `connector:${node}`,
    width,
    lanes: 1,
    direction: 0,
    bridge: true,
    tunnel: false,
    layer: Math.max(low.layer ?? 0, high.layer ?? 0),
    startNode: node,
    endNode: node,
    sharedStart: false,
    sharedEnd: false,
    startGroundHeight: null,
    endGroundHeight: null,
    startDeckY: a.y,
    endDeckY: b.y,
    lengthM: length,
    areaM2,
    maxClearanceM: 0,
    points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
    frames,
    geometry,
    topTriangles,
    piers: [],
    surfaceId: `sz-elevated-ramp:${node}`,
    grade: gradeOK,
    connector: true
  };
}

/** 解析：识别相邻高架链路在共享节点处的 layer 高差（如 4.8 m vs 9.6 m），生成连接坡道。
 *  输入：已规划的链路记录（含 startNode/endNode 与端部高度）。
 *  输出：坡道记录（几何 + 独立 surfaceId `sz-elevated-ramp:<node>`），坡度按 35% 上限标记。 */
function planConnectorRamps(records) {
  const byNode = new Map();
  for (const record of records) {
    for (const [end, node] of [['start', record.startNode], ['end', record.endNode]]) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push({ record, end, y: end === 'start' ? record.startDeckY : record.endDeckY });
    }
  }
  const ramps = [];
  for (const [node, entries] of [...byNode.entries()].sort((a, b) => a[0] - b[0])) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.y - b.y);
    for (let i = 1; i < entries.length; i++) {
      const low = entries[i - 1], high = entries[i];
      const rise = high.y - low.y;
      if (rise < 0.6) continue;
      const lowFrame = connectorBackFrame(low.record, low.end);
      const highFrame = connectorBackFrame(high.record, high.end);
      if (!lowFrame || !highFrame) continue;
      const lowX = lowFrame.frame.x, lowY = lowFrame.frame.y;
      const highX = highFrame.frame.x, highY = highFrame.frame.y;
      const run = Math.hypot(highX - lowX, highFrame.frame.z - lowFrame.frame.z);
      const gradeOK = run > 0 && rise / run <= CONNECTOR_MAX_GRADE;
      const ramp = makeConnectorRamp(node, ramps.length, lowFrame, highFrame, gradeOK);
      if (ramp) ramps.push(ramp);
    }
  }
  return ramps;
}

/** 解析：按立交分区的桥面、护栏、桥墩总计划（纯函数）。
 *  选区：bridge=true 或 |layer|>0、与任一分区矩形相交的链路；一条链路只规划一次，
 *        归给分区列表里第一个命中的立交，避免相邻立交重复出桥面。
 *        与地面道路重合的链路跳过（groundDuplicates）。
 *  输出：{ links, driveLinks, surfaces, colliders, chunks, interchanges, statistics }；
 *        surface 供控制器当可站立面，collider 供侧向接触，chunk 供渲染。 */
export function planElevatedRoads(graph, terrainSurface, options) {
  validateGraph(graph);
  const interchanges = normalizeInterchanges(options);
  const bounds = {
    minX: Math.min(...interchanges.map(entry => entry.area.minX)),
    maxX: Math.max(...interchanges.map(entry => entry.area.maxX)),
    minZ: Math.min(...interchanges.map(entry => entry.area.minZ)),
    maxZ: Math.max(...interchanges.map(entry => entry.area.maxZ))
  };
  const groundHeight = createGroundSurfaceSampler(terrainSurface);
  const groundNodes = new Set();
  const groundSignatures = new Set();

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, graph.links[index]);
    groundSignatures.add(canonicalSignature(points));
    groundNodes.add(graph.links[index][0]);
    groundNodes.add(graph.links[index][1]);
  }

  const sources = options?.waterfront;
  const wetPolygon = index => options.water[index];
  const roadProfiles = new Map();
  for (const row of sources?.roadBridges ?? []) {
    const polygon = wetPolygon(row.waterIndex);
    const waterAt = (x, z) => polygonContainsInclusive(polygon, x, z);
    for (const { edge, heightsM } of row.portals) roadProfiles.set(edge, { ...row, waterAt, portalHeights: heightsM,
      pierAt: (x, z, half) => [-half, half].every(dx => [-half, half].every(dz => waterAt(x + dx, z + dz))) });
  }
  const records = [];
  const recordsByInterchange = new Map(interchanges.map(entry => [entry.id, []]));
  let groundDuplicates = 0;
  let skippedLinks = 0;
  let tunnelLinks = 0;
  for (let index = 0; index < graph.links.length; index++) {
    const link = graph.links[index];
    const metadata = graph.metadata[index];
    if (!metadata || (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0))) continue;
    if (isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, link);
    const profile = roadProfiles.get(index);
    const owner = interchanges.find(entry => polylineIntersectsArea(points, entry.area));
    if (!owner && !profile) continue;
    // OSM 隧道只做离线审核；不摊成贴地桥面，避免隧道口出现假护栏。
    if (metadata.tunnel === true) {
      tunnelLinks++;
      continue;
    }
    if (groundSignatures.has(canonicalSignature(points))) {
      groundDuplicates++;
      continue;
    }
    const record = planLink(graph, link, index, metadata, groundHeight, groundNodes, profile);
    if (record === null) {
      skippedLinks++;
      continue;
    }
    record.interchangeId = owner?.id ?? 'dasha-baishi';
    records.push(record);
    if (owner) recordsByInterchange.get(owner.id).push(record);
  }

  const walking = (sources?.footbridges ?? []).map((bridge, i) => {
    const { points, id, widthM, girderDepthM, waterIndex, waterHeightM } = bridge;
    const polygon = wetPolygon(waterIndex);
    const waterAt = (x, z) => polygonContainsInclusive(polygon, x, z);
    const line = { nodes: [...points[0].filter((_, j) => j !== 1), ...points.at(-1).filter((_, j) => j !== 1)], names: [''] };
    const stations = [0];
    for (let j = 1; j < points.length; j++) {
      stations.push(stations.at(-1) + Math.hypot(points[j][0] - points[j - 1][0], points[j][2] - points[j - 1][2]));
    }
    const heightAt = d => {
      let j = stations.findIndex(s => s >= d);
      if (j <= 0) return points[j === 0 ? 0 : points.length - 1][1];
      const t = (d - stations[j - 1]) / (stations[j] - stations[j - 1]);
      return points[j - 1][1] + (points[j][1] - points[j - 1][1]) * t;
    };
    const link = [0, 1, 0, widthM, 0, 0, points.slice(1, -1).flatMap(([x, , z]) => [x, z])];
    return planLink(line, link, -i - 1, { osmId: id, layer: 1, bridge: true }, groundHeight, new Set(),
      { widthM, girderDepthM, waterAt, waterHeightM, heightAt, walk: true, surfaceId: `waterfront-bridge:${id}` });
  }).filter(Boolean);
  const connectors = planConnectorRamps(records.filter(record => !record.reviewed));
  // 车行链路：高程来自本计划同一批桥面三角面、纵坡可驾驶且非隧道；连接在车流图里再按共享节点高差复核。
  const driveLinks = records.filter(record => !record.tunnel && record.layer > 0
    && record.maxGrade <= ELEVATED_DRIVE_MAX_GRADE);
  const junctionNeighbors = reviewedJunctionNeighbors(graph, driveLinks);
  for (const record of [...records, ...walking]) {
    // 慢行与车行在同桥并行时保留车道边界，步行桥靠车道的一侧也保留护栏。
    const sameBridge = record.reviewed && [...records, ...walking].filter(other => other !== record && other.reviewed
      && other.reviewed.walk === record.reviewed.walk && other.reviewed.waterHeightM === record.reviewed.waterHeightM);
    addBarriers(record, groundHeight, sameBridge || junctionNeighbors.get(record));
  }
  const driveByStart = new Map();
  for (const record of driveLinks) {
    if (!driveByStart.has(record.startNode)) driveByStart.set(record.startNode, []);
    driveByStart.get(record.startNode).push(record);
  }
  // 车行后继：共享节点处桥面高差在容差内的同向链路，供控制器在多条并行缎带分岔处按车行连通性交接。
  const successors = new Map();
  for (const record of driveLinks) {
    const end = record.points[record.points.length - 1];
    const previous = record.points[record.points.length - 2];
    const length = Math.hypot(end.x - previous.x, end.z - previous.z) || 1;
    const candidates = [];
    for (const next of driveByStart.get(record.endNode) ?? []) {
      // 与 sz-traffic.js 的 ELEVATED_HEIGHT_TOLERANCE 是同一接缝容差。
      if (next === record || Math.abs(record.endDeckY - next.startDeckY) > ELEVATED_JOIN_TOLERANCE_M) continue;
      const start = next.points[1];
      const denominator = Math.hypot(start.x - next.points[0].x, start.z - next.points[0].z) || 1;
      const dot = ((end.x - previous.x) / length) * ((start.x - next.points[0].x) / denominator)
        + ((end.z - previous.z) / length) * ((start.z - next.points[0].z) / denominator);
      if (dot > -0.45) candidates.push({ id: next.surfaceId, dot });
    }
    // 分岔鼻端按走向最顺的链路优先，控制器交接时用这个顺序消歧。
    candidates.sort((a, b) => b.dot - a.dot || a.id.localeCompare(b.id));
    successors.set(record.surfaceId, candidates.map(candidate => candidate.id));
  }
  const surfaces = [...records, ...connectors, ...walking].map(record => ({
    id: record.surfaceId,
    heightSource: 'estimate',
    triangles: record.topTriangles,
    // 桥头与地面共享节点处允许车辆从地面踏上桥面；桥下高差超过抬脚高度时不会吸附。
    climbableFromGround: true,
    driveSuccessors: successors.get(record.surfaceId) ?? []
  }));
  const chunks = [...buildChunks([...records, ...connectors]), ...buildChunks(walking).map(c => ({ ...c, id: `walk:${c.id}` }))];
  // 护栏和桥墩的接触体都来自显示几何同一批顶点；桥面本身仍只登记顶面三角面。
  const colliders = [...records, ...walking].flatMap(record => [...record.barrierColliders, ...record.pierColliders, ...record.slabColliders]);
  const interchangeSummaries = interchanges.map(entry => {
    const list = recordsByInterchange.get(entry.id);
    const drive = list.filter(record => driveLinks.includes(record));
    return {
      id: entry.id,
      name: entry.name,
      source: entry.source,
      area: entry.area,
      heightSource: 'estimate',
      links: list.length,
      linkIndices: list.map(record => record.index).sort((a, b) => a - b),
      driveLinks: drive.length,
      deckLengthM: list.reduce((sum, record) => sum + record.lengthM, 0),
      driveDeckLengthM: drive.reduce((sum, record) => sum + record.lengthM, 0),
      areaM2: list.reduce((sum, record) => sum + record.areaM2, 0),
      barrierLengthM: list.reduce((sum, record) => sum + record.barrierLengthM, 0),
      piers: list.reduce((sum, record) => sum + record.piers.length, 0),
      maxDeckHeightM: list.reduce((max, record) => Math.max(max, record.maxClearanceM), 0)
    };
  });
  const statistics = {
    links: records.length,
    connectors: connectors.length,
    connectorLengthM: connectors.reduce((sum, record) => sum + record.lengthM, 0),
    deckLengthM: records.reduce((sum, record) => sum + record.lengthM, 0),
    areaM2: records.reduce((sum, record) => sum + record.areaM2, 0) + connectors.reduce((sum, record) => sum + record.areaM2, 0),
    surfaces: surfaces.length,
    triangles: [...records, ...connectors].reduce((sum, record) => sum + record.geometry.length / 9, 0),
    piers: records.reduce((sum, record) => sum + record.piers.length, 0),
    barriers: records.reduce((sum, record) => sum + record.barriers.length, 0),
    barrierLengthM: records.reduce((sum, record) => sum + record.barrierLengthM, 0),
    barrierColliders: colliders.filter(collider => collider.type === 'elevated-barrier').length,
    pierColliders: colliders.filter(collider => collider.type === 'elevated-pier').length,
    colliders: colliders.length,
    interchanges: interchangeSummaries,
    driveLinks: driveLinks.length,
    driveDeckLengthM: driveLinks.reduce((sum, record) => sum + record.lengthM, 0),
    maxDeckHeightM: records.reduce((max, record) => Math.max(max, record.maxClearanceM), 0),
    heightSource: 'estimate',
    groundDuplicates,
    skippedLinks,
    tunnelLinks,
    limitations: [...LIMITATIONS]
  };

  return { version: 1, heightSource: 'estimate', area: bounds, interchanges: interchangeSummaries,
    links: records, driveLinks, surfaces, colliders, chunks, statistics, walking };
}

/** 解析：把高架计划建成场景：≤12 个空间分块网格 + 可站立表面 + 侧向接触体。
 *  输入：roadGraph、terrainSurface（GEO 里的派生地形），以及 area（旧接口）或 interchanges（多立交分区）。
 *  输出：{ group, meshes, surfaces, colliders, interchanges, statistics, links, update, dispose }。
 *  约束：桥面高度、护栏尺寸、桥墩间距和连接坡道均为 estimate；不导入外部模型。 */
export function buildSzElevatedRoads(scene, { graph, terrainSurface, area, interchanges, waterfront, water } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('A THREE scene is required');
  const options = area ?? { interchanges, waterfront, water };
  const plan = planElevatedRoads(graph, terrainSurface, options);
  // 车行网络复用渲染桥面的顶面三角面：车轮接触、自动规划和渲染桥面同源，桥下层不串到上层。
  const driveSurfaceIds = new Set(plan.driveLinks.map(record => record.surfaceId));
  const driveSurfaces = plan.surfaces.filter(surface => driveSurfaceIds.has(surface.id));
  const group = new THREE.Group();
  group.name = 'shenzhen-elevated-roads';
  // 没有纹理，沥青观感只靠颜色和粗糙度；polygonOffset 只处理与地面共面处的绘制顺序。
  // 双面渲染让护栏的内外侧面都可见，桥面和墩身的三角面不受影响。
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x303436,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  // 只偏移桥面接收阴影的采样点，消除薄桥板投到自身的条纹。
  material.receivedShadowPositionNode = positionWorld.add(normalWorld.mul(0.24));
  const meshes = [];
  for (const chunk of plan.chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.name = chunk.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.elevatedRoads = chunk.linkIndices;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return {
    group,
    meshes,
    surfaces: plan.surfaces,
    colliders: plan.colliders,
    interchanges: plan.interchanges,
    statistics: plan.statistics,
    links: plan.links,
    walking: plan.walking,
    drive: {
      links: plan.driveLinks,
      surfaces: driveSurfaces,
      heightAt: createSurfaceHeightAt(driveSurfaces),
      statistics: {
        links: plan.driveLinks.length,
        deckLengthM: plan.statistics.driveDeckLengthM,
        surfaces: driveSurfaces.length,
        heightSource: 'rendered-top-triangles'
      }
    },
    update() {},
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      material.dispose();
    }
  };
}
