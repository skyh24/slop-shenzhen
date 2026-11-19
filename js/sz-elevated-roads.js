import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld } from 'three/tsl';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { deckLaneProfile, throughRoadArms } from './sz-road-section.js';
import {
  centerGradeBudget, createRoadProfile, measureRoadProfile, recordRoadProfileSeam, roadProfileHeight
} from './sz-road-profile.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { DECK_RISE_M, highDeckTunnelPortals, highwayProfileHeight, interchangeRise, profiledUnderpassPortals, roadDeckLayer, roadDeckRise } from './sz-interchange-levels.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';

// 桥面抬升量以桥面顶为准，梁厚另计。接触面与显示几何共用同一批三角面。
const GIRDER_DEPTH_M = 0.35;
const DECK_STEP_M = 4;
// 端部各外延 4 m 平段，让相邻链路/地面路的接触面在节点处有重叠，避免车辆在链路交界
// 因支撑高度跳变 >1.5 m 被判定“无支撑”而刹停。引道必须从这段外延的末端起步，否则会与
// 桥面在同一 (x,z) 上给出两个不同高度，触发接触面“同一身份不得重叠”的自检。
const DECK_OVERLAP_M = 4;
const PIER_SPACING_M = 28;
const PIER_MIN_CLEARANCE_M = 2;
const PIER_BASE_EMBED_M = 0.05;
// 桥墩沿桥纵线换位，完整墩身须避开下层车行道与步道，并预留边缘余量。
const PIER_ROAD_CLEARANCE_M = 0.5;
// 全城结构面按约 2 km 网格分块，每块一个 mesh；桶数超过上限时自动加粗网格。
const CHUNK_GRID_M = 2000;
const MAX_CHUNKS = 64;
// 悬空端引道：长度在 8–40 m 内按高差自适应，坡度不超过 12%；接不上时只标记 dangling。
const APRON_MIN_M = 8;
const APRON_MAX_M = 48;
const APRON_MAX_GRADE = 0.12;
// 桥面接到更少车道时沿宽的一侧收边，保留断面设计宽度和共享接点。
const JUNCTION_TAPER_MIN_M = 15;
// 地面道路索引的网格边长；只在 bridge 且 layer=0 的链路需要判断是否跨路。
const GROUND_INDEX_CELL_M = 1000;
const EPSILON = 1e-8;
// 护栏尺寸照武汉参考实现（0.95 m 高、0.35 m 宽）估计，不是深圳设计图尺寸。
const BARRIER_HEIGHT_M = 0.95;
const ELEVATED_BARRIER_WIDTH_M = 0.35;
// 桥面离开地面超过这个高度才加护栏；匝道落地段两侧留开口给车辆进出。
const BARRIER_MIN_SEPARATION_M = 0.75;
// 中段抬升超过这个高度即按真实跨路桥处理：登记接触面、可驶入并画标线。
const DECK_CONTACT_RISE_M = 1.0;
// 桥面标高由端点地面和估计抬升量确定，地形更高的断面由构建期（tools/sz/elevated_cut.py）
// 在山体上按走廊竖直截断，并把岩壁顶点烘进 terrainSurface.cutWalls；运行时只还原这份几何，
// 不再逐帧采样地形，避免崖顶在相邻断面之间跳动成锯齿。
// 已核实的同向合流、分流。共同桥段与两支道均须在源路网节点和估算桥高上相接。
// 两端实接地面、源线只在两端与其他道路相连的深南广深匝道，单独校正估计纵断面。
const SHENNAN_GUANGSHEN_GRADE_WAY = 'way/40933268';
const BAISHI_GREENWAY_OVERPASS_WAY = 'way/839645212';
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
    id: 'shennan-xinzhou',
    name: '深南新洲立交',
    source: 'OSM 深南大道、新洲路及连接匝道',
    area: Object.freeze({ minX: -1250, maxX: -845, minZ: 260, maxZ: 680 }),
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
  '普通车行高架桥面抬升 4.8 m；南坪快速采用估计纵断面；南光高速高架主线抬升 10.3 m。',
  'bridge 且 layer=0 的链路只有在跨越地面道路时抬升 4.8 m，跨水或涵洞保持贴地；判断用地面边折线与结构面走廊相交，不是实测净空。',
  '匝道与地面道路共享节点处按地形高程落地，坡度按实际生成纵断面检查，不是测量坡度。',
  'layer<0 的非隧道链路按 0 抬升派生贴地结构面，不设护栏；只有纵坡不超过 12% 且两端能接地面或结构面时才接入车行。',
  '悬空端补 8–48 m、坡度不超过 12% 的引道；地形落差过大、无法在限长内接地的端头标记为 dangling，不抛错也不接入车行。',
  '桥墩按约 28 m 间距估计布置，只在净空大于 2 m 时设墩；冲突时先沿桥纵线换位，通用桥还可在桥下有地面承托的横向位置设墩。墩位与基础未做地勘核实。',
  '护栏按 0.95 m 高、0.35 m 宽的混凝土护栏估计，仅桥面离开地面 0.75 m 以上的段落连续设置；不是深圳设计图尺寸。',
  '车行链路要求非隧道、layer 不为 0、两端接通且派生纵坡不超过 12%；不满足的结构面仍显示但标记为不可车行。'
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
  if (!Array.isArray(list)) throw new Error('Interchanges must be an array');
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

// 点到线段距离的平方；用于地面道路折线与结构面走廊的相交判断。
function pointSegmentDistanceSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= EPSILON) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq));
  return (px - (ax + dx * t)) ** 2 + (pz - (az + dz * t)) ** 2;
}

// 两条线段距离不超过 limit 即视为相接；limit 取两条路半宽之和，代表两条缎带在平面上重叠。
function segmentsWithin(ax, az, bx, bz, cx, cz, dx, dz, limit) {
  if (Math.min(ax, bx) - limit > Math.max(cx, dx) || Math.max(ax, bx) + limit < Math.min(cx, dx)
    || Math.min(az, bz) - limit > Math.max(cz, dz) || Math.max(az, bz) + limit < Math.min(cz, dz)) return false;
  const cross = (ox, oz, px, pz, qx, qz) => (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(cx, cz, dx, dz, ax, az);
  const d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz);
  const d4 = cross(ax, az, bx, bz, dx, dz);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const limitSq = limit * limit;
  return pointSegmentDistanceSq(cx, cz, ax, az, bx, bz) <= limitSq
    || pointSegmentDistanceSq(dx, dz, ax, az, bx, bz) <= limitSq
    || pointSegmentDistanceSq(ax, az, cx, cz, dx, dz) <= limitSq
    || pointSegmentDistanceSq(bx, bz, cx, cz, dx, dz) <= limitSq;
}

// 地面道路的稀疏网格索引：只在 bridge 且 layer=0 的链路需要判断是否跨越地面道路，
// 因此按 1 km 网格缓存地面边，查询时只取结构走廊覆盖到的格子，避免全城两两比较。
function createGroundRoadIndex() {
  const cells = new Map();
  const add = (index, points, width, startNode, endNode) => {
    const half = Math.max(0, Number.isFinite(width) ? width : 0) / 2;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    if (!Number.isFinite(minX)) return;
    const i0 = Math.floor((minX - half) / GROUND_INDEX_CELL_M);
    const i1 = Math.floor((maxX + half) / GROUND_INDEX_CELL_M);
    const j0 = Math.floor((minZ - half) / GROUND_INDEX_CELL_M);
    const j1 = Math.floor((maxZ + half) / GROUND_INDEX_CELL_M);
    const entry = { points, half, startNode, endNode };
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(entry);
      }
    }
  };
  // 点是否落在任一条地面道路的铺装走廊内。用于跨路判断和桥墩避让：
  // 只要墩身外缘与路面走廊重叠，就认为墩位压到车行道。
  const occupied = (x, z, radius) => {
    const pad = Math.max(0, radius);
    const i0 = Math.floor((x - pad) / GROUND_INDEX_CELL_M);
    const i1 = Math.floor((x + pad) / GROUND_INDEX_CELL_M);
    const j0 = Math.floor((z - pad) / GROUND_INDEX_CELL_M);
    const j1 = Math.floor((z + pad) / GROUND_INDEX_CELL_M);
    const visited = new Set();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const entry of cells.get(`${i},${j}`) ?? []) {
          if (visited.has(entry)) continue;
          visited.add(entry);
          for (let b = 1; b < entry.points.length; b++) {
            if (pointSegmentDistanceSq(x, z, entry.points[b - 1].x, entry.points[b - 1].z,
              entry.points[b].x, entry.points[b].z) <= (pad + entry.half) ** 2) return true;
          }
        }
      }
    }
    return false;
  };
  const crosses = (points, halfWidth, startNode, endNode) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    if (!Number.isFinite(minX)) return false;
    const i0 = Math.floor((minX - halfWidth) / GROUND_INDEX_CELL_M);
    const i1 = Math.floor((maxX + halfWidth) / GROUND_INDEX_CELL_M);
    const j0 = Math.floor((minZ - halfWidth) / GROUND_INDEX_CELL_M);
    const j1 = Math.floor((maxZ + halfWidth) / GROUND_INDEX_CELL_M);
    const visited = new Set();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const entry of cells.get(`${i},${j}`) ?? []) {
          if (entry.startNode === startNode || entry.startNode === endNode
            || entry.endNode === startNode || entry.endNode === endNode) continue;
          if (visited.has(entry)) continue;
          visited.add(entry);
          for (let a = 1; a < points.length; a++) {
            for (let b = 1; b < entry.points.length; b++) {
              if (segmentsWithin(points[a - 1].x, points[a - 1].z, points[a].x, points[a].z,
                entry.points[b - 1].x, entry.points[b - 1].z, entry.points[b].x, entry.points[b].z,
                halfWidth + entry.half)) return true;
            }
          }
        }
      }
    }
    return false;
  };
  return { add, crosses, occupied };
}

// 地形包在部分水塘/边界缺三角面，采样会返回 null；结构面不能因此整条消失。
// 先做小范围环形补采样；仍取不到（海面、地形包边缘）时按海平面 0 计，保证全城都有面。
function createGroundHeightWithFallback(sampler) {
  const cache = new Map();
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
  return (x, z) => {
    const key = `${Math.round(x / 5)},${Math.round(z / 5)}`;
    if (cache.has(key)) return cache.get(key);
    let height = sampler(x, z);
    if (!Number.isFinite(height)) {
      for (const radius of [25, 50, 100, 200]) {
        for (const [dx, dz] of offsets) {
          height = sampler(x + dx * radius, z + dz * radius);
          if (Number.isFinite(height)) break;
        }
        if (Number.isFinite(height)) break;
      }
    }
    const value = Number.isFinite(height) ? height : 0;
    cache.set(key, value);
    return value;
  };
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
      widthM: width,
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half },
      nx, nz
    };
  });
}

// 同节点同层的独立延续共用接端宽度；同名、同类道路的转弯可共用斜接断面。
// 多支路节点只调整方向和宽度相近的续接边，按实际重叠范围开放护栏。
function findJunctionTapers(graph, groundNodes, skip) {
  const endsByNode = new Map();
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || metadata.tunnel === true || metadata.crossSection) continue;
    if (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0)) continue;
    if (isGroundRoad(metadata) || skip(index)) continue;
    const link = graph.links[index];
    const points = roadLinkPoints(graph, link);
    if (points.length < 2) continue;
    const firstRun = Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z) || 1;
    const lastRun = Math.hypot(points.at(-1).x - points.at(-2).x, points.at(-1).z - points.at(-2).z) || 1;
    const ends = [
      { side: 'start', node: link[0], ux: (points[0].x - points[1].x) / firstRun,
        uz: (points[0].z - points[1].z) / firstRun },
      { side: 'end', node: link[1], ux: (points.at(-1).x - points.at(-2).x) / lastRun,
        uz: (points.at(-1).z - points.at(-2).z) / lastRun }
    ];
    const layer = roadDeckLayer(metadata, graph.names[link[2]]);
    const width = deckLaneProfile(link).widthM;
    const length = polylineLength(points);
    for (const end of ends) {
      if (groundNodes.has(end.node)) continue;
      const key = `${end.node}:${layer}`;
      if (!endsByNode.has(key)) endsByNode.set(key, []);
      endsByNode.get(key).push({ index, ...end, dx: end.ux, dz: end.uz, layer, width, length, name: graph.names[link[2]],
        kind: metadata.highway, direction: link[5] });
    }
  }
  const tapers = new Map();
  for (const list of endsByNode.values()) {
    const exclusive = list.length === 2;
    const primary = list.length > 2 ? throughRoadArms(list) : null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.index === b.index || (primary && !(primary.includes(a) && primary.includes(b)))) continue;
        const dot = a.ux * b.ux + a.uz * b.uz;
        const sameRoad = exclusive && a.name && a.name === b.name && a.kind && a.kind === b.kind
          && a.direction === b.direction && (a.direction === 0 || a.side !== b.side);
        if (dot > (sameRoad ? 0.05 : -0.55)) continue;

        const width = Math.min(a.width, b.width);
        const wide = Math.max(a.width, b.width);
        if (!exclusive && (width / wide < 0.45 || wide - width < 0.5)) continue;
        for (const end of [a, b]) {
          if (!tapers.has(end.index)) tapers.set(end.index, { start: end.width, end: end.width, seams: {} });
          const taper = tapers.get(end.index);
          taper[end.side] = Math.min(taper[end.side], width);
        }
        // 单一源道路的同层转弯使用共同的斜接断面。过短的边沿用搭接，避免内侧路缘折返。
        if (!sameRoad || a.layer <= 0) continue;
        const halfCos = Math.sqrt((1 - dot) / 2);
        const reach = Math.max(JUNCTION_TAPER_MIN_M, width * Math.sqrt(Math.max(0, 1 - halfCos ** 2)) / halfCos * 1.5);
        if (Math.min(a.length, b.length) < reach * 2) continue;
        const scale = 1 / (2 * halfCos ** 2);
        const nx = (a.uz - b.uz) * scale;
        const nz = -(a.ux - b.ux) * scale;
        for (const [end, sign] of [[a, a.side === 'end' ? 1 : -1], [b, b.side === 'start' ? 1 : -1]]) {
          const peerIndex = end === a ? b.index : a.index;
          tapers.get(end.index).seams[end.side] = { nx: nx * sign, nz: nz * sign, reach, width, peerIndex };
        }
      }
    }
  }
  return tapers;
}

// 高层主线保持原设计层。只有同一源节点、行车方向相容的低层匝道才在端部向主线抬升。
function findHighwayJoins(graph, groundNodes, skip) {
  const endsByNode = new Map();
  for (const [index, link] of graph.links.entries()) {
    const metadata = graph.metadata[index];
    if (!metadata || metadata.tunnel || metadata.crossSection || metadata.interchangeApproach
      || (metadata.highwayProfile && !metadata.nanpingMainline) || skip(index)) continue;
    const layer = roadDeckLayer(metadata, graph.names[link[2]]);
    if (layer !== 2 && !(layer === 1 && metadata.highway?.endsWith('_link'))) continue;
    for (const [offset, node] of link.slice(0, 2).entries()) {
      if (groundNodes.has(node)) continue;
      if (!endsByNode.has(node)) endsByNode.set(node, []);
      const side = offset === 0 ? 'start' : 'end';
      endsByNode.get(node).push({ index, side, layer,
        direction: link[5] * (side === 'start' ? 1 : -1) });
    }
  }
  const joins = new Map();
  for (const ends of endsByNode.values()) {
    for (const ramp of ends.filter(end => end.layer === 1)) {
      const mainline = ends.find(end => end.layer === 2 && ramp.direction * end.direction <= 0);
      if (!mainline) continue;
      if (!joins.has(ramp.index)) joins.set(ramp.index, {});
      joins.get(ramp.index)[ramp.side] = { joinIndex: mainline.index, joinSide: mainline.side };
    }
  }
  return joins;
}

// 旧层号不同的桥面压到同一层后，只在有连续平地和足够坡长的地方把低侧落到地面。
function findGroundCrossings(graph, records, terrainHeight, groundIndex) {
  const size = 48;
  const cells = new Map();
  const zones = new Map();
  const approachM = 76;
  for (const road of records) {
    if (road.layer !== 1 || road.reviewed || road.crossing || road.urbanApproach) continue;
    const layer = graph.metadata[road.index].layer;
    const frames = road.frames;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = b.d - a.d;
      if (length <= EPSILON) continue;
      const part = { road, layer, a, b, dx, dz, length };
      const minX = Math.floor(Math.min(a.x, b.x) / size);
      const maxX = Math.floor(Math.max(a.x, b.x) / size);
      const minZ = Math.floor(Math.min(a.z, b.z) / size);
      const maxZ = Math.floor(Math.max(a.z, b.z) / size);
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = `${x},${z}`;
        if (!cells.has(key)) cells.set(key, []);
        const bucket = cells.get(key);
        for (const other of bucket) {
          if (other.layer === layer || other.road === road
            || other.road.startNode === road.startNode || other.road.startNode === road.endNode
            || other.road.endNode === road.startNode || other.road.endNode === road.endNode) continue;
          const determinant = dx * other.dz - dz * other.dx;
          const sine = Math.abs(determinant) / (length * other.length);
          if (sine < 0.45) continue;
          const xDelta = other.a.x - a.x;
          const zDelta = other.a.z - a.z;
          const t = (xDelta * other.dz - zDelta * other.dx) / determinant;
          const u = (xDelta * dz - zDelta * dx) / determinant;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const lower = layer < other.layer ? part : other;
          const upper = lower === part ? other : part;
          if (lower.road.splitStart || lower.road.splitEnd) continue;
          const y = a.y + (b.y - a.y) * t;
          const otherY = other.a.y + (other.b.y - other.a.y) * u;
          if (Math.abs(y - otherY) > 0.35) continue;
          const d = lower.a.d + lower.length * (lower === part ? t : u);
          const half = (lower.road.width + upper.road.width) / (2 * sine);
          const from = d - half - approachM;
          const to = d + half + approachM;
          if (from < 0 || to > lower.road.lengthM) continue;
          const existing = zones.get(lower.road) ?? [];
          if (existing.some(zone => Math.abs(zone.d - d) < 0.05)) continue;
          // 有水、起伏地面或现有地面车道时，保留该交叉供单点设计。
          const floorY = Math.min(y, otherY) - DECK_RISE_M;
          const supported = lower.road.frames.every(frame => frame.d < from || frame.d > to
            || (Math.abs(frame.y - DECK_RISE_M - floorY) <= 0.1
              && !groundIndex.occupied(frame.x, frame.z, frame.widthM / 2)
              && [frame.left, frame, frame.right].every(point =>
                Math.abs((terrainHeight(point.x, point.z) ?? Infinity) - floorY) <= 0.1)));
          if (!supported) continue;
          existing.push({ d, half, approachM });
          zones.set(lower.road, existing);
        }
        bucket.push(part);
      }
    }
  }
  return zones;
}

function applyDeckTaper(frames, width, startWidth, endWidth, length) {
  const fullHalf = width / 2;
  const startHalf = startWidth / 2;
  const endHalf = endWidth / 2;
  if (startHalf >= fullHalf - EPSILON && endHalf >= fullHalf - EPSILON) return;
  // 按各端的横移距离独立分配渐变；平滑曲线让路缘在渐变起止处都接回原方向。
  const startTaper = startWidth < width ? Math.max(JUNCTION_TAPER_MIN_M, (width - startWidth) * 4) : 0;
  const endTaper = endWidth < width ? Math.max(JUNCTION_TAPER_MIN_M, (width - endWidth) * 4) : 0;
  const scale = Math.min(1, length / (startTaper + endTaper));
  const mix = (distance, extent) => {
    const t = extent > EPSILON ? Math.min(1, distance / extent) : 1;
    return t * t * (3 - 2 * t);
  };
  for (const frame of frames) {
    const startMix = mix(frame.d, startTaper * scale);
    const endMix = mix(length - frame.d, endTaper * scale);
    const half = Math.min(startHalf + (fullHalf - startHalf) * startMix,
      endHalf + (fullHalf - endHalf) * endMix);
    frame.widthM = half * 2;
    frame.left.x = frame.x + frame.nx * half;
    frame.left.z = frame.z + frame.nz * half;
    frame.right.x = frame.x - frame.nx * half;
    frame.right.z = frame.z - frame.nz * half;
  }
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
  const crossing = (BARRIER_MIN_SEPARATION_M - da) / (db - da);
  const from = da <= BARRIER_MIN_SEPARATION_M ? crossing : 0;
  const to = db <= BARRIER_MIN_SEPARATION_M ? crossing : 1;
  return [Math.max(0, Math.min(1, from)), Math.max(0, Math.min(1, to))];
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

/** 派生桥面纵断面、共享通行三角面以及护栏、桥墩和碰撞体。 */
function planLink(graph, link, index, metadata, groundHeight, groundNodes, reviewed = null, crossing = null, liftOverride = null, groundIndex = null, split = null, taper = null, alignment = null, groundCrossings = null) {
  const points = roadLinkPoints(graph, link);
  if (points.length < 2) return null;
  const length = polylineLength(points);
  if (length <= EPSILON) return null;
  const [start, end] = [link[0], link[1]];
  const highway = metadata.highwayProfile;
  const startGround = alignment?.startGround ?? groundHeight(points[0].x, points[0].z);
  const endGround = alignment?.endGround ?? groundHeight(points.at(-1).x, points.at(-1).z);
  if (!reviewed && (!Number.isFinite(startGround) || !Number.isFinite(endGround))) return null;
  const layer = roadDeckLayer(metadata, graph.names[link[2]]);
  const lift = liftOverride ?? roadDeckRise(layer, metadata);
  const urban = metadata.interchangeApproach;
  const urbanLift = (distance, groundY) => {
    const rise = interchangeRise(distance);
    return urban.deckY === undefined ? rise : (urban.deckY - groundY) * rise / DECK_RISE_M;
  };
  const startLift = urban ? urbanLift(urban.start, startGround) : lift;
  const endLift = urban ? urbanLift(urban.end, endGround) : lift;
  const sharedStart = !highway?.[2] && (groundNodes.has(start) || alignment?.portalStart === true
    || metadata.explicitCorridorProfile);
  const sharedEnd = !highway?.[3] && (groundNodes.has(end) || alignment?.portalEnd === true
    || metadata.explicitCorridorProfile);
  const fullStart = startGround + startLift;
  const fullEnd = endGround + endLift;
  const startY = sharedStart ? startGround : fullStart;
  const endY = sharedEnd ? endGround : fullEnd;
  const signedBaseGrade = (fullEnd - fullStart) / length;
  const baseGrade = Math.abs(signedBaseGrade);
  const rampGrade = alignment?.g4 && baseGrade < ELEVATED_DRIVE_MAX_GRADE
    ? ELEVATED_DRIVE_MAX_GRADE - baseGrade : ELEVATED_DRIVE_MAX_GRADE;
  const parkBridge = reviewed?.profile === 'park-footbridge-estimate';
  const stations = resample(points, DECK_STEP_M);
  if (stations.length < 2) return null;
  // 高架/匝道桥面按每方向 1–4 车道派生宽度。6.5 m 匝道读成 2 车道，
  // 不再用统一最小宽度把单车道撑成一条没有分隔线的空白带。
  const laneProfile = reviewed ? null : deckLaneProfile(link);
  const width = reviewed?.widthM ?? laneProfile?.widthM ?? Math.max(link[3], 6.5);
  const frames = stationFrames(stations, width);
  if (!reviewed && taper) {
    applyDeckTaper(frames, width, taper.start, taper.end, length);
    for (const [side, seam] of Object.entries(taper.seams)) {
      const portal = side === 'start' ? frames[0] : frames.at(-1);
      const half = seam.width / 2;
      const dx = (seam.nx - portal.nx) * half;
      const dz = (seam.nz - portal.nz) * half;
      for (const frame of frames) {
        const factor = Math.max(0, 1 - Math.abs(frame.d - portal.d) / seam.reach);
        frame.left.x += dx * factor;
        frame.left.z += dz * factor;
        frame.right.x -= dx * factor;
        frame.right.z -= dz * factor;
      }
    }
  }
  const calibratedRamp = layer === 2 || split || (metadata.osmId === SHENNAN_GUANGSHEN_GRADE_WAY
    && metadata.bridge === true && layer === 1 && sharedStart && sharedEnd && !reviewed && !crossing && !split);
  const gradeBudget = calibratedRamp ? centerGradeBudget(frames, ELEVATED_DRIVE_MAX_GRADE) : null;
  const calibrated = gradeBudget !== null && baseGrade < gradeBudget;
  // 在两端分别扣除带方向的基准坡度；不移动源接点或改变桥梁层级。
  const startRampGrade = calibrated ? gradeBudget - signedBaseGrade : rampGrade;
  const endRampGrade = calibrated ? gradeBudget + signedBaseGrade : rampGrade;
  const approachDistanceAt = distance => Math.min(urban.start + Math.max(0, distance - urban.delayStart),
    urban.end + Math.max(0, length - distance - urban.delayEnd));
  const urbanHeightAt = distance => {
    const groundY = startGround + (endGround - startGround) * distance / length;
    return groundY + urbanLift(approachDistanceAt(distance), groundY);
  };
  let deckHeightAt = highway ? distance => highwayProfileHeight(highway, distance / length)
    : urban ? urbanHeightAt
    : reviewed?.heightAt ?? (reviewed
    ? (d => {
      const [a, b] = reviewed.portalHeights;
      const run = delta => Math.min(length / 2, Math.max(4, Math.abs(delta) / 0.05));
      const startWeight = Math.max(0, 1 - d / run(a - reviewed.heightM));
      const endWeight = Math.max(0, 1 - (length - d) / run(b - reviewed.heightM));
      return reviewed.heightM + (a - reviewed.heightM) * startWeight + (b - reviewed.heightM) * endWeight;
    })
    // 两端设计标高间走直线纵坡，只有接地端扣减层高。京港澳引道预留主体纵坡所占的 12% 坡度预算。
    : distance => {
      const fullY = fullStart + (fullEnd - fullStart) * Math.min(1, distance / length);
      const dropStart = sharedStart ? Math.max(0, startLift - distance * startRampGrade) : 0;
      const dropEnd = sharedEnd ? Math.max(0, endLift - (length - distance) * endRampGrade) : 0;
      return fullY - Math.max(dropStart, dropEnd);
    });
  // 匝道留出缓升段，末段与主线共用桥面标高。坡长要计入原有纵坡和曲线内缘。
  let splitStart = null;
  let splitEnd = null;
  if (split && !reviewed && !crossing) {
    const resolve = (side, baseY, groundY) => {
      const info = split[side];
      if (!info || gradeBudget === null || gradeBudget <= baseGrade) return null;
      const peer = graph.metadata[info.joinIndex];
      const targetY = peer.highwayProfile?.[info.joinSide === 'start' ? 0 : 1] ?? groundY + roadDeckRise(2, peer);
      const rise = targetY - baseY;
      const rampM = 1.5 * Math.abs(rise) / (gradeBudget - baseGrade);
      if (Math.abs(rise) <= 0.05 || rampM > length
        || (side === 'start' && sharedEnd && rampM + endLift / endRampGrade > length)
        || (side === 'end' && sharedStart && rampM + startLift / startRampGrade > length)) return null;
      return { ...info, rise, rampM, targetY };
    };
    splitStart = resolve('start', startY, startGround);
    splitEnd = resolve('end', endY, endGround);
    if (splitStart && splitEnd && splitStart.rampM + splitEnd.rampM > length) {
      splitStart = null;
      splitEnd = null;
    }
    if (splitStart || splitEnd) {
      const base = deckHeightAt;
      const riseAtJoin = (join, fromJoin) => {
        if (!join || fromJoin >= join.rampM) return 0;
        const t = 1 - fromJoin / join.rampM;
        return join.rise * t * t * (3 - 2 * t);
      };
      deckHeightAt = d => base(d) + riseAtJoin(splitStart, d) + riseAtJoin(splitEnd, length - d);
    }
  }
  if (groundCrossings) {
    const base = deckHeightAt;
    deckHeightAt = d => {
      let down = 0;
      for (const { d: center, half, approachM } of groundCrossings) {
        const t = Math.max(0, Math.min(1, 1 - (Math.abs(d - center) - half) / approachM));
        down = Math.max(down, DECK_RISE_M * t * t * (3 - 2 * t));
      }
      return base(d) - down;
    };
  }
  const girderDepth = reviewed?.girderDepthM ?? GIRDER_DEPTH_M;
  const geometry = [];
  const topTriangles = [];
  const topPaintTriangles = [];
  const pierRecords = [];
  const pierColliders = [];
  const slabColliders = [];
  const surfaceId = reviewed?.surfaceId ?? `sz-elevated-road:${index}`;
  const osmId = metadata.osmId ?? null;
  const baishiUnderpass = osmId === BAISHI_GREENWAY_OVERPASS_WAY && metadata.bridge === true;
  let areaM2 = 0;
  let maxClearanceM = 0;
  let maxGrade = 0;
  for (const frame of frames) {
    // 桥面沿纵断面取高，山体侵入处由构建期裁切，保留平顺的路面。
    const linearY = deckHeightAt(frame.d);
    const centerGround = groundHeight(frame.x, frame.z);
    frame.y = crossing ? crossing.height(frame, linearY) : linearY;
    if (Number.isFinite(centerGround)) maxClearanceM = Math.max(maxClearanceM, frame.y - centerGround);
  }
  // 接触面只按真实跨越判定：两端都接地面、但中段抬升超过 1 m 的链路是真正的跨路桥，
  // 必须能驶入并画标线；贴着地形的落地匝道（中段不抬升）仍只保留显示几何，
  // 否则会在同一位置叠出假桥面，把桥下行人和自行车吸上去。
  const contactSurface = Boolean(reviewed || crossing || layer <= 0 || !sharedStart || !sharedEnd
    || highway || maxClearanceM > DECK_CONTACT_RISE_M);
  // 匝道端部与高层主线共用同一个端点标高。
  if (splitStart) frames[0].y = splitStart.targetY;
  if (splitEnd) frames.at(-1).y = splitEnd.targetY;
  if (parkBridge) {
    // 桥头用实际岸路横坡接地，向桥内逐渐收平。
    for (const [portal, sign] of [[frames[0], 1], [frames.at(-1), -1]]) {
      for (const side of ['left', 'right']) {
        const p = portal[side];
        const delta = (groundHeight(p.x, p.z) ?? portal.y) - portal.y;
        for (const frame of frames) {
          const blend = Math.max(0, 1 - sign * (frame.d - portal.d) / 5);
          if (blend > 0) frame[side].y = frame.y + delta * blend;
        }
      }
    }
  }
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (alignment?.g4) {
      // 与落地引道一致，按设计纵线量纵坡，收边和转弯内缘不缩短设计里程。
      maxGrade = Math.max(maxGrade, Math.abs(b.y - a.y) / (b.d - a.d));
      continue;
    }
    for (const side of ['left', 'right']) {
      const run = Math.hypot(b[side].x - a[side].x, b[side].z - a[side].z);
      maxGrade = Math.max(maxGrade, Math.abs((b[side].y ?? b.y) - (a[side].y ?? a.y)) / Math.max(EPSILON, run));
    }
  }
  const crossesApproach = frame => groundCrossings?.some(({ d, half, approachM }) =>
    Math.abs(frame.d - d) < half + approachM);
  const isApproach = (a, b) => urban ? interchangeRise(Math.min(approachDistanceAt(a.d), approachDistanceAt(b.d))) < lift - EPSILON : !reviewed && !crossing && (
    crossesApproach(a) || crossesApproach(b)
    || (highway && (!highway[2] || !highway[3]))
    || (sharedStart && a.d * startRampGrade < startLift - EPSILON)
    || (sharedEnd && (length - b.d) * endRampGrade < endLift - EPSILON)
    || (splitStart && a.d < splitStart.rampM - EPSILON)
    || (splitEnd && length - b.d < splitEnd.rampM - EPSILON)
  );
  const gradeProfile = measureRoadProfile(createRoadProfile(), frames,
    (_, a, b) => isApproach(a, b) ? 'approach' : 'deck');
  for (let i = 1; i < frames.length - 1; i++) {
    const frame = frames[i];
    const before = isApproach(frames[i - 1], frame);
    const after = isApproach(frame, frames[i + 1]);
    if (before === after) continue;
    const y = roadProfileHeight(frame);
    recordRoadProfileSeam(gradeProfile, {
      kind: before ? 'approach-to-deck' : 'deck-to-approach', atM: frame.d, fromY: y, toY: y
    }, ELEVATED_JOIN_TOLERANCE_M);
  }
  // 端部 4 m 搭接平段推迟到引道规划之后补（见 pushDeckExtension）：有引道的端头不再外延，
  // 否则引道与桥面会在同一 (x,z) 给出两个高度，触发接触面“同一身份不得重叠”的自检。
  const [splitNode, , , splitApproach] = CHEGONGMIAO_SPLIT;
  // 分流处由下游桥段向后搭接。同一节点的上游平桥不再向前盖住下坡活动面。
  const endsAtSplit = metadata.osmId === splitApproach && graph.nodeIds?.[end] === splitNode && link[5] === 1;
  const surfaceFrames = frames;
  for (let i = 1; i < surfaceFrames.length; i++) {
    const a = surfaceFrames[i - 1];
    const b = surfaceFrames[i];
    const topA = { ...a.left, y: a.left.y ?? a.y };
    const topB = { ...b.left, y: b.left.y ?? b.y };
    const topC = { ...b.right, y: b.right.y ?? b.y };
    const topD = { ...a.right, y: a.right.y ?? a.y };
    // 顶面三角面无论是否登记接触面都进同一批顶点：接触面只决定可站立与可驶入，
    // 显示、标线和面积统计共用这一份几何，避免出现"有桥面却没有标线"的孤立缎带。
    pushTopQuad(geometry, topTriangles, topA, topD, topC, topB);
    // 贴地结构边不登记接触面，但仍要给标线一批与桥面同源的顶面三角面。
    topPaintTriangles.push([topA, topD, topC], [topA, topC, topB]);
    areaM2 += triangleArea2D(topA, topB, topC) + triangleArea2D(topA, topC, topD);
    pushVerticalWall(geometry, topA, topB, topA.y - girderDepth, topB.y - girderDepth);
    pushVerticalWall(geometry, topC, topD, topC.y - girderDepth, topD.y - girderDepth);
    if (reviewed || baishiUnderpass) {
      const [u, v, w, t] = [topA, topB, topC, topD].map(p => ({ ...p, y: p.y - girderDepth }));
      pushQuad(geometry, u, v, w, t);
      if (baishiUnderpass) {
        // 弯斜梁体按可见底面同一条对角线分成两个三角棱柱。
        for (const lower of [[u, v, w], [u, w, t]]) {
          const outer = lower.map(({ x, z }) => ({ x, z }));
          const bottom = lower.map(p => p.y);
          const top = bottom.map(y => y + girderDepth);
          slabColliders.push({ type: 'elevated-slab', name: surfaceId, sourceId: osmId,
            polygon: { outer, holes: [] }, roofPanel: { outer, bottom, top },
            minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
            minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
            minY: Math.min(...bottom), maxY: Math.max(...top) });
        }
        continue;
      }
      // 仅登记梁体厚度，桥下净空不会被盒子填满。
      const outer = [topA, topB, topC, topD].map(({ x, z }) => ({ x, z }));
      slabColliders.push({ type: parkBridge ? 'bridge-slab' : 'elevated-slab',
        name: surfaceId, sourceId: osmId, polygon: { outer, holes: [] },
        minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
        minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
        minY: Math.min(u.y, v.y, w.y, t.y), maxY: Math.max(topA.y, topB.y, topC.y, topD.y),
        verticalSpan: [Math.min(u.y, t.y), Math.min(v.y, w.y), Math.max(topA.y, topD.y), Math.max(topB.y, topC.y)] });
    }
  }

  // 端部封口让桥面板在起点和终点读成实体，不把顶面悬空。
  const first = frames[0];
  const last = frames[frames.length - 1];
  const firstLeft = { ...first.left, y: first.left.y ?? first.y };
  const firstRight = { ...first.right, y: first.right.y ?? first.y };
  const lastLeft = { ...last.left, y: last.left.y ?? last.y };
  const lastRight = { ...last.right, y: last.right.y ?? last.y };
  pushEndCap(geometry, firstLeft, firstRight, Math.min(firstLeft.y, firstRight.y) - girderDepth, false);
  pushEndCap(geometry, lastLeft, lastRight, Math.min(lastLeft.y, lastRight.y) - girderDepth, true);

  return {
    index,
    osmId,
    reviewed, crossing,
    // 分流节点处的上游平桥不补端部搭接段。
    seamPeers: Object.values(taper?.seams ?? {}).map(seam => seam.peerIndex),
    noStartExtension: Boolean(taper?.seams.start),
    noEndExtension: endsAtSplit || Boolean(taper?.seams.end),
    name: graph.names[link[2]] ?? '',
    width,
    barrierWidthM: ELEVATED_BARRIER_WIDTH_M,
    girderDepth,
    laneCount: laneProfile?.laneCount ?? 1,
    perDirectionLanes: laneProfile?.perDirection ?? 1,
    lanes: link[4],
    direction: link[5],
    bridge: metadata.bridge === true,
    tunnel: metadata.tunnel === true,
    layer,
    effectiveLiftM: lift,
    urbanApproach: Boolean(urban || highway),
    highwayMainline: Boolean(highway && metadata.highway === 'motorway'),
    nanpingMainline: metadata.nanpingMainline === true,
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
    gradeProfile,
    // 既有导航筛选不批量改判；最终断面的实测口径另由 gradeProfile 明示。
    maxGrade: metadata.nanpingMainline || metadata.explicitCorridorProfile
      ? gradeProfile.maxGrade : highway ? Math.abs(highway[1] - highway[0]) / length
      : calibrated || splitStart || splitEnd || groundCrossings ? gradeProfile.maxGrade
        : reviewed || crossing || alignment?.g4 ? maxGrade : Math.abs(endY - startY) / length,
    splitStart,
    splitEnd,
    groundCrossings,
    points,
    frames,
    geometry,
    topTriangles,
    topPaintTriangles,
    contactSurface,
    // 端部 4 m 搭接改由 pushDeckExtension 在引道之后补，顶面三角面与 frames 一一对应，不再有前置重叠段。
    leadingOverlapFrames: 0,
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

// 同节点、同高的斜接支路按主线断面识别；其余同高合流再按端点前的横向错开判断。
// 只有实际重叠的车行面让出护栏，显示和碰撞一起开口。
const MERGE_LATERAL_M = 1;
const MERGE_APPROACH_M = 20;
function mergeNeighbors(records, metadata) {
  const byNode = new Map();
  for (const record of records) {
    if (record.reviewed) continue;
    for (const [node, side, y] of [[record.startNode, 'start', record.startDeckY],
      [record.endNode, 'end', record.endDeckY]]) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push({ record, side, y });
    }
  }
  const approachPoint = (record, side, distance) => {
    const points = side === 'start' ? record.points : [...record.points].reverse();
    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const run = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      if (travelled + run >= distance) {
        const t = (distance - travelled) / run;
        return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
          z: points[i - 1].z + (points[i].z - points[i - 1].z) * t };
      }
      travelled += run;
    }
    return points[points.length - 1];
  };
  const neighbors = new Map();
  for (const peers of byNode.values()) {
    if (peers.length < 2) continue;
    for (const arm of peers) {
      const { record, side } = arm;
      const tip = side === 'start' ? record.points[0] : record.points.at(-1);
      const approach = approachPoint(record, side, MERGE_APPROACH_M);
      const dx = approach.x - tip.x, dz = approach.z - tip.z;
      const length = Math.hypot(dx, dz) || 1;
      Object.assign(arm, { dx: dx / length, dz: dz / length, approach, kind: metadata[record.index]?.highway,
        name: record.name, width: record.width });
    }
    const mainByHeight = peers.length >= 3 ? new Map(peers.map(arm => [arm,
      throughRoadArms(peers.filter(other => Math.abs(arm.y - other.y) <= ELEVATED_JOIN_TOLERANCE_M))])) : null;
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i], b = peers[j];
        if (a.record === b.record || a.record.seamPeers.includes(b.record.index)
          || Math.abs(a.y - b.y) > ELEVATED_JOIN_TOLERANCE_M) continue;
        const isSideJoin = [mainByHeight?.get(a), mainByHeight?.get(b)]
          .some(main => main && main.includes(a) !== main.includes(b));
        const dx = b.approach.x - a.approach.x, dz = b.approach.z - a.approach.z;
        if (!isSideJoin && Math.abs(dx * a.dz - dz * a.dx) <= MERGE_LATERAL_M) continue;
        for (const [from, to] of [[a.record, b.record], [b.record, a.record]]) {
          if (!neighbors.has(from)) neighbors.set(from, new Set());
          neighbors.get(from).add(to);
        }
      }
    }
  }
  return neighbors;
}

// 已确认的同层辅道允许重叠车行面互相让出护栏。行车拓扑仍使用源节点。
function interchangeDeckNeighbors(records, metadata, neighbors) {
  const decks = records.filter(road => metadata[road.index]?.interchangeApproach);
  const bounds = new Map(decks.map(road => {
    const edges = road.frames.flatMap(({ left, right }) => [left, right]);
    return [road, {
      minX: Math.min(...edges.map(p => p.x)), maxX: Math.max(...edges.map(p => p.x)),
      minZ: Math.min(...edges.map(p => p.z)), maxZ: Math.max(...edges.map(p => p.z))
    }];
  }));
  for (const road of decks) {
    const { id, sharesDeck } = metadata[road.index].interchangeApproach;
    if (!sharesDeck) continue;
    const a = bounds.get(road);
    for (const peer of decks) {
      if (peer === road || metadata[peer.index].interchangeApproach.id !== id) continue;
      const b = bounds.get(peer);
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ) continue;
      if (!neighbors.has(road)) neighbors.set(road, new Set());
      if (!neighbors.has(peer)) neighbors.set(peer, new Set());
      neighbors.get(road).add(peer);
      neighbors.get(peer).add(road);
    }
  }
}

// 按实际桥面三角面索引，不用路名、共享节点或 layer 猜测上下关系。
const PIER_DECK_CELL_M = 32;
function createPierDeckKeepouts(records) {
  const cells = new Map();
  const cell = value => Math.floor(value / PIER_DECK_CELL_M);
  for (const record of records) {
    for (const triangle of record.topTriangles) {
      const [a, b, c] = triangle;
      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
      const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
      const entry = { record, triangle, minX, maxX, minZ, maxZ };
      for (let ix = cell(minX); ix <= cell(maxX); ix++) {
        for (let iz = cell(minZ); iz <= cell(maxZ); iz++) {
          const key = `${ix},${iz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(entry);
        }
      }
    }
  }
  return (record, x, z, half, fromY, toY) => {
    const minX = x - half, maxX = x + half, minZ = z - half, maxZ = z + half;
    for (let ix = cell(minX); ix <= cell(maxX); ix++) {
      for (let iz = cell(minZ); iz <= cell(maxZ); iz++) {
        for (const entry of cells.get(`${ix},${iz}`) ?? []) {
          if (entry.record === record || entry.minX > maxX || entry.maxX < minX
            || entry.minZ > maxZ || entry.maxZ < minZ) continue;
          // 在墩身的水平及竖向范围剪切，窄桥恰好穿过墩边也能检出。
          let polygon = entry.triangle;
          for (const [axis, value, sign] of [['x', minX, 1], ['x', maxX, -1],
            ['z', minZ, 1], ['z', maxZ, -1], ['y', fromY, 1], ['y', toY, -1]]) {
            if (!polygon.length) break;
            const clipped = [];
            let a = polygon.at(-1);
            let da = (a[axis] - value) * sign;
            for (const b of polygon) {
              const db = (b[axis] - value) * sign;
              if ((da >= 0) !== (db >= 0)) clipped.push(interpolatePoint(a, b, da / (da - db)));
              if (db >= 0) clipped.push(b);
              a = b;
              da = db;
            }
            polygon = clipped;
          }
          if (polygon.length) return true;
        }
      }
    }
    return false;
  };
}

function addPiers(record, groundHeight, carriagewayOccupied, deckKeepout, options) {
  const { frames, osmId, surfaceId, piers, pierColliders, width, reviewed, crossing, girderDepth } = record;
  const { terrainHeight, pedestrianKeepout, sidePierBlocked, waterFoundation } = options;
  const pierGeometry = [];
  record.pierGeometry = pierGeometry;
  const parkBridge = reviewed?.profile === 'park-footbridge-estimate';
  const half = Math.max(0.7, Math.min(1.4, width * 0.08));
  // 车道和步道查询按半径扩展，方墩的角也不能侵入保护带。
  const radius = half * Math.SQRT2 + PIER_ROAD_CLEARANCE_M;
  const usedStations = new Set();
  const canShiftAcross = !reviewed && !crossing && record.effectiveLiftM > 0.05;
  let deckHeight;
  const tryPier = (station, abutment = false, offset = 0) => {
    if (usedStations.has(station) || (crossing && !crossing.allowsPier(station))) return false;
    const x = station.x + station.nx * offset, z = station.z + station.nz * offset;
    if (carriagewayOccupied(x, z, radius) || (!abutment && pedestrianKeepout?.(x, z, radius))) return false;
    if (offset && sidePierBlocked?.(x, z, half)) return false;
    const terrainY = abutment ? (groundHeight(x, z) ?? station.y) - 0.5 : reviewed
      ? (reviewed.pierAt?.(x, z, half) ? reviewed.waterHeightM - 1 : null)
      : terrainHeight(x, z) ?? (offset ? null : waterFoundation?.(x, z) ?? groundHeight(x, z));
    if (!Number.isFinite(terrainY)) return false;
    const corners = [-half, half].flatMap(dx => [-half, half].map(dz => [x + dx, z + dz]));
    const cornerTerrain = corners.map(([px, pz]) => terrainHeight(px, pz));
    let deckY = station.y;
    if (offset) {
      // 横向候选的完整墩身须落在自身桥面投影内，尤其是弯道内缘和宽度渐变处。
      deckHeight ??= createSurfaceHeightAt([{ id: surfaceId, triangles: record.topTriangles }]);
      deckY = deckHeight(x, z, surfaceId);
      if (!Number.isFinite(deckY) || !cornerTerrain.every(Number.isFinite)
        || !corners.every(([px, pz]) => Number.isFinite(deckHeight(px, pz, surfaceId)))) return false;
    }
    const topY = deckY - girderDepth;
    // 基础沿最低一角入土，避免在下沉步道的横坡上用邻近的缓存高程把墩底抬空。
    const baseY = abutment || reviewed ? terrainY : Math.min(terrainY,
      ...cornerTerrain.map((height, i) => height ?? waterFoundation?.(...corners[i])).filter(Number.isFinite)) - PIER_BASE_EMBED_M;
    if ((!abutment && deckY - terrainY <= (parkBridge ? 0.5 : PIER_MIN_CLEARANCE_M))
      || topY - terrainY <= (abutment ? 0.08 : 0.2)
      || deckKeepout(record, x, z, half + PIER_ROAD_CLEARANCE_M, baseY - PIER_BASE_EMBED_M,
        topY + JUNCTION_BARRIER_CLEARANCE_M)) return false;

    usedStations.add(station);
    const pier = { x, z, baseY, topY, half };
    piers.push(pier);
    pushPier(pierGeometry, pier);
    const minX = x - half, maxX = x + half, minZ = z - half, maxZ = z + half;
    pierColliders.push({ type: 'elevated-pier', name: `${surfaceId}:pier:${piers.length}`, sourceId: osmId,
      minX, maxX, minZ, maxZ, minY: baseY, maxY: topY,
      // 墩顶固定在梁底。引道车身底面按桥心摊平，可能略低于前方墩顶。
      topClearance: girderDepth,
      polygon: { outer: [{ x: minX, z: minZ }, { x: maxX, z: minZ },
        { x: maxX, z: maxZ }, { x: minX, z: maxZ }], holes: [] }
    });
    return true;
  };

  // 桥台是岸边短支座，与普通桥墩分开处理，不挪动岸侧接点。
  if (parkBridge) {
    for (const station of [frames.find(f => f.d >= 2), frames.findLast(f => f.d <= record.lengthM - 2)]) {
      if (station) tryPier(station, true);
    }
  }
  for (const planned of pierSpacing(record)) {
    let ahead = frames.indexOf(planned);
    let behind = ahead - 1;
    const alternatives = [];
    let placed = false;
    // 从名义墩位向前后交替找最近的可用断面，限制移动距离。
    while (ahead < frames.length || behind >= 0) {
      const aheadGap = (frames[ahead]?.d ?? Infinity) - planned.d;
      const behindGap = planned.d - (frames[behind]?.d ?? -Infinity);
      if (Math.min(aheadGap, behindGap) > PIER_SPACING_M) break;
      const station = behindGap <= aheadGap ? frames[behind--] : frames[ahead++];
      if (station.d < 2 || station.d > record.lengthM - 2) continue;
      if (tryPier(station)) {
        placed = true;
        break;
      }
      if (canShiftAcross && !usedStations.has(station)) alternatives.push(station);
    }
    if (placed) continue;
    for (const station of alternatives) {
      const offset = station.widthM / 2 - half * Math.SQRT2 - 0.05;
      if (offset > 0 && (tryPier(station, false, offset) || tryPier(station, false, -offset))) break;
    }
  }
}

function interpolatePoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function addBarriers(record, groundHeight, neighbors = []) {
  const { frames, osmId, surfaceId } = record;
  const parkBridge = record.reviewed?.profile === 'park-footbridge-estimate';
  const barrierGeometry = [];
  const barrierRecords = [];
  const barrierColliders = [];
  const openings = new Map();
  const previous = {};
  let barrierLengthM = 0;
  const adjacent = [...neighbors].map(road => ({ id: road.surfaceId, triangles: road.topTriangles }));
  const heightAt = adjacent.length ? createSurfaceHeightAt(adjacent) : null;
  const blocksNeighbor = (a, b) => [0, 0.25, 0.5, 0.75, 1].some(t => {
    const { x, y, z } = interpolatePoint(a, b, t);
    return adjacent.some(({ id }) => {
      const deck = heightAt(x, z, id);
      return deck !== null && deck > y - JUNCTION_BARRIER_CLEARANCE_M && deck < y + BARRIER_HEIGHT_M;
    });
  });
  const width = parkBridge ? 0.10 : ELEVATED_BARRIER_WIDTH_M;
  const deckGroundHeight = record.reviewed
    ? (x, z) => record.reviewed.waterAt?.(x, z) ? record.reviewed.waterHeightM : groundHeight(x, z)
    : groundHeight;
  const upper = p => ({ ...p, y: p.y + BARRIER_HEIGHT_M });
  const cap = (outer, inner) => pushQuad(barrierGeometry, outer, inner, upper(inner), upper(outer));
  const inset = (edge, frame) => {
    const half = Math.hypot(edge.x - frame.x, edge.z - frame.z);
    const point = interpolatePoint(edge, frame, half > EPSILON ? Math.min(1, width / half) : 0);
    return { ...point, y: edge.y };
  };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    for (const side of ['left', 'right']) {
      const edgeA = { ...a[side], y: a[side].y ?? a.y };
      const edgeB = { ...b[side], y: b[side].y ?? b.y };
      // 先把内、外缘钉在同一横断面，再用同一纵向比例裁落地区间；弯道内外边长不等。
      const span = parkBridge ? [0, 1] : barrierSpanOnGround(edgeA, edgeB, deckGroundHeight);
      if (!span) continue;
      const [from, to] = span;
      const start = interpolatePoint(edgeA, edgeB, from);
      const end = interpolatePoint(edgeA, edgeB, to);
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      if (length <= EPSILON) continue;
      const insetA = inset(edgeA, a);
      const insetB = inset(edgeB, b);
      const insetStart = interpolatePoint(insetA, insetB, from);
      const insetEnd = interpolatePoint(insetA, insetB, to);
      // 同层汇入或横穿的车行面让出护栏。
      if (heightAt && (blocksNeighbor(start, end) || blocksNeighbor(insetStart, insetEnd))) {
        if (!openings.has(i - 1)) openings.set(i - 1, new Set());
        openings.get(i - 1).add(side);
        continue;
      }
      const startTop = upper(start);
      const endTop = upper(end);
      const insetStartTop = upper(insetStart);
      const insetEndTop = upper(insetEnd);
      const railBottom = p => parkBridge ? { ...p, y: p.y + BARRIER_HEIGHT_M - 0.12 } : p;
      pushQuad(barrierGeometry, railBottom(start), railBottom(end), endTop, startTop);
      pushQuad(barrierGeometry, startTop, endTop, insetEndTop, insetStartTop);
      pushQuad(barrierGeometry, railBottom(insetStart), insetStartTop, insetEndTop, railBottom(insetEnd));
      if (parkBridge) {
        cap(start, insetStart);
        if (i === frames.length - 1) cap(end, insetEnd);
        for (const y of [0.32, 0.61]) {
          const at = p => ({ ...p, y: p.y + y });
          pushVerticalWall(barrierGeometry, at(start), at(end), start.y + y - 0.045, end.y + y - 0.045);
        }
      } else {
        // 混凝土段在落地端和分流开口处封头；连续站间不增加内部面。
        const before = previous[side];
        if (before?.i !== i - 1 || from > EPSILON || before.to < 1 - EPSILON) {
          if (before) cap(before.end, before.insetEnd);
          cap(start, insetStart);
        }
        previous[side] = { i, to, end, insetEnd };
      }
      barrierLengthM += length;
      barrierRecords.push({ side, length, startY: start.y, endY: end.y,
        startD: a.d + (b.d - a.d) * from, endD: a.d + (b.d - a.d) * to });
      // 斜坡接触按实际护栏高度收裁，不能把全段最小、最大高度当成同一堵竖墙。
      const outer = [start, end, insetEnd, insetStart].map(({ x, z }) => ({ x, z }));
      barrierColliders.push({
        type: 'elevated-barrier',
        name: `${surfaceId}:${side}:${barrierRecords.length}`,
        sourceId: osmId,
        minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
        minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
        minY: Math.min(start.y, end.y), maxY: Math.max(startTop.y, endTop.y),
        verticalSpan: [start.y, end.y, startTop.y, endTop.y],
        polygon: { outer, holes: [] }
      });
    }
  }
  for (const { end, insetEnd } of Object.values(previous)) cap(end, insetEnd);
  Object.assign(record, { barriers: barrierRecords, barrierColliders, barrierLengthM, barrierGeometry, openings });
}

/** 解析：悬空端引道。端头没有共享地面节点、也没有同高结构邻居时，从桥面向外补一段
 *  8–48 m 的引道，按 12% 上限反推长度并尽量贴近地形；接不上返回 null，由调用方标记 dangling。
 *  引道顶面三角面与桥面同批进入 surface，长度计入 statistics.aprons/apronLengthM。 */
function buildApron(record, side, groundHeight) {
  const frames = record.frames;
  if (frames.length < 2) return null;
  const end = side === 'start' ? frames[0] : frames[frames.length - 1];
  const inner = side === 'start' ? frames[1] : frames[frames.length - 2];
  const run = Math.hypot(end.x - inner.x, end.z - inner.z);
  if (run <= EPSILON) return null;
  const ux = (end.x - inner.x) / run;
  const uz = (end.z - inner.z) / run;
  // 引道直接从桥面端头起步：端部 4 m 搭接段只在没有引道的一端补（见 pushDeckExtension），
  // 否则搭接段与引道会在同一 (x,z) 给出两个高度，接触面自检判定重叠。
  const ox = end.x;
  const oz = end.z;
  const groundEnd = groundHeight(ox, oz);
  if (!Number.isFinite(groundEnd)) return null;
  const drop = end.y - groundEnd;
  if (drop <= 0.05) return { side, lengthM: 0, grade: 0, atGrade: true, endY: end.y, frames: [], triangleStart: record.topTriangles.length };
  const required = drop / APRON_MAX_GRADE;
  if (required > APRON_MAX_M + 1e-6) return null;
  const length = Math.max(APRON_MIN_M, Math.min(APRON_MAX_M, required));
  const steps = Math.max(2, Math.ceil(length / DECK_STEP_M));
  const half = record.width / 2;
  const nx = end.nx;
  const nz = end.nz;
  const apronFrames = [];
  let maxGrade = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ox + ux * length * t;
    const z = oz + uz * length * t;
    const terrain = groundHeight(x, z);
    if (!Number.isFinite(terrain)) return null;
    // 线性下坡为目标，地面更高时以地面为下限；t=1 接回地形。
    const y = Math.max(end.y + (groundEnd - end.y) * t, terrain);
    const left = { x: x + nx * half, z: z + nz * half };
    const right = { x: x - nx * half, z: z - nz * half };
    if (i === 0) {
      left.y = end.left.y ?? end.y;
      right.y = end.right.y ?? end.y;
    } else {
      const leftGround = groundHeight(left.x, left.z);
      const rightGround = groundHeight(right.x, right.z);
      if (!Number.isFinite(leftGround) || !Number.isFinite(rightGround)) return null;
      left.y = Math.max(y, leftGround);
      right.y = Math.max(y, rightGround);
    }
    apronFrames.push({ x, z, y, left, right, nx, nz, d: end.d + length * t });
    if (i > 0) {
      const previous = apronFrames[i - 1];
      const ds = Math.hypot(x - previous.x, z - previous.z) || 1;
      // 纵坡只按引道中心线判定；边缘为避免埋地会 clamp 到地形，局部陡坎不算纵坡。
      maxGrade = Math.max(maxGrade, Math.abs(y - previous.y) / ds);
    }
  }
  if (maxGrade > APRON_MAX_GRADE + 1e-6) return null;
  const girderDepth = GIRDER_DEPTH_M;
  const apronTriangles = [];
  let apronLengthM = 0;
  // 引道顶面三角面排在桥面之后，记下起点供标线按段回取（见 sz-road-paint 的 deckSegments）。
  const triangleStart = record.topTriangles.length;
  for (let i = 1; i < apronFrames.length; i++) {
    const a = apronFrames[i - 1];
    const b = apronFrames[i];
    const topA = { ...a.left, y: a.left.y };
    const topB = { ...b.left, y: b.left.y };
    const topC = { ...b.right, y: b.right.y };
    const topD = { ...a.right, y: a.right.y };
    if (record.contactSurface) pushTopQuad(record.geometry, record.topTriangles, topA, topD, topC, topB);
    else {
      pushTriangle(record.geometry, topA, topD, topC);
      pushTriangle(record.geometry, topA, topC, topB);
    }
    apronTriangles.push([topA, topD, topC], [topA, topC, topB]);
    record.areaM2 += triangleArea2D(topA, topB, topC) + triangleArea2D(topA, topC, topD);
    pushVerticalWall(record.geometry, topA, topB, topA.y - girderDepth, topB.y - girderDepth);
    pushVerticalWall(record.geometry, topC, topD, topC.y - girderDepth, topD.y - girderDepth);
    apronLengthM += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const tip = apronFrames[apronFrames.length - 1];
  pushEndCap(record.geometry, { ...tip.left, y: tip.left.y }, { ...tip.right, y: tip.right.y },
    Math.min(tip.left.y, tip.right.y) - girderDepth, side === 'end');
  return { side, lengthM: apronLengthM, grade: maxGrade, endY: tip.y,
    frames: apronFrames, triangleStart, topTriangles: apronTriangles, widthM: record.width };
}

/** 端部搭接段：沿端头切向外推 DECK_OVERLAP_M，与节点处相邻桥面/地面路的接触面重叠，
 *  避免车辆在链路交接处因支撑高度跳变 >1.5 m 被判定“无支撑”而刹停（round 30/34 诊断）。
 *  只在端头已接通、且该端没有引道时补：引道本身从端头连续下坡，不需要额外搭接。 */
function pushDeckExtension(record, side) {
  const frames = record.frames;
  if (frames.length < 2) return;
  const end = side === 'start' ? frames[0] : frames[frames.length - 1];
  const inner = side === 'start' ? frames[1] : frames[frames.length - 2];
  const run = Math.hypot(end.x - inner.x, end.z - inner.z);
  if (run <= EPSILON) return;
  const ux = (end.x - inner.x) / run;
  const uz = (end.z - inner.z) / run;
  const x = end.x + ux * DECK_OVERLAP_M;
  const z = end.z + uz * DECK_OVERLAP_M;
  const half = record.width / 2;
  // 有坡接缝沿本身切线搭接，平搭接会在坡面上多造一层同位置的台阶。
  const sharedGround = side === 'start' ? record.sharedStart : record.sharedEnd;
  const dy = record.urbanApproach && !sharedGround ? (end.y - inner.y) * DECK_OVERLAP_M / run : 0;
  const outer = { x, z, y: end.y + dy, d: end.d + (side === 'start' ? -1 : 1) * DECK_OVERLAP_M,
    left: { x: x + end.nx * half, z: z + end.nz * half, y: (end.left.y ?? end.y) + dy },
    right: { x: x - end.nx * half, z: z - end.nz * half, y: (end.right.y ?? end.y) + dy } };
  const a = side === 'start' ? outer : end;
  const b = side === 'start' ? end : outer;
  measureRoadProfile(record.gradeProfile, [a, b], () => 'overlap');
  const topA = { ...a.left, y: a.left.y ?? end.y };
  const topB = { ...b.left, y: b.left.y ?? end.y };
  const topC = { ...b.right, y: b.right.y ?? end.y };
  const topD = { ...a.right, y: a.right.y ?? end.y };
  if (record.contactSurface === false) {
    pushTriangle(record.geometry, topA, topD, topC);
    pushTriangle(record.geometry, topA, topC, topB);
  } else pushTopQuad(record.geometry, record.topTriangles, topA, topD, topC, topB);
  record.areaM2 += triangleArea2D(topA, topB, topC) + triangleArea2D(topA, topC, topD);
  const girderDepth = GIRDER_DEPTH_M;
  pushVerticalWall(record.geometry, topA, topB, topA.y - girderDepth, topB.y - girderDepth);
  pushVerticalWall(record.geometry, topC, topD, topC.y - girderDepth, topD.y - girderDepth);
}

// 约 2 km 网格分桶：同一桶的桥面放一个 chunk，减少 draw call；桶数超过上限时网格逐级加粗。


function buildChunks(records) {
  if (records.length === 0) return [];
  const keysFor = cell => {
    const buckets = new Map();
    for (const record of records) {
      const first = record.points[0];
      const last = record.points[record.points.length - 1];
      const x = (first.x + last.x) / 2;
      const z = (first.z + last.z) / 2;
      const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(record);
    }
    return buckets;
  };
  let cell = CHUNK_GRID_M;
  let buckets = keysFor(cell);
  while (buckets.size > MAX_CHUNKS) {
    cell *= 2;
    buckets = keysFor(cell);
  }
  const orderedKeys = [...buckets.keys()].sort((a, b) => {
    const [ax, az] = a.split(',').map(Number);
    const [bx, bz] = b.split(',').map(Number);
    return ax - bx || az - bz;
  });
  return orderedKeys.map(key => buckets.get(key)).map((bucket, chunkIndex) => {
    bucket.sort((a, b) => a.index - b.index);
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
    const materialRanges = [];
    const append = (geometry, color) => {
      if (!geometry?.length) return;
      const start = positions.length;
      for (let i = 0; i < geometry.length; i += 3) {
        positions.push(geometry[i] - origin[0], geometry[i + 1], geometry[i + 2] - origin[1]);
      }
      materialRanges.push({ start, end: positions.length, color });
    };
    for (const record of bucket) {
      append(record.geometry, 0x3b3d41);
      append(record.pierGeometry, 0x8b8983);
      append(record.barrierGeometry, record.reviewed?.profile === 'park-footbridge-estimate' ? 0x64767a : 0xa5a49c);
    }
    return {
      id: `shenzhen-elevated-roads:${chunkIndex}`,
      origin,
      bounds: { minX, maxX, minZ, maxZ },
      positions: new Float32Array(positions),
      materialRanges,
      linkIndices: bucket.map(record => record.index).sort((a, b) => a - b),
      triangles: positions.length / 9
    };
  });
}


/** 解析：全城结构面派生（纯函数）。
 *  选区：所有非地面、非隧道的 bridge/layer 链路；分区矩形只用于 interchangeId 与统计，不再做归属门控。
 *        bridge 且 layer=0 的链路用地面道路索引判断是否跨路，跨路抬 1 层，跨水/涵洞贴地；
 *        layer<0 按 0 抬升。与地面道路完全重合的链路跳过（groundDuplicates）。
 *  端接：共享地面节点或同节点同高结构邻居直接接通；悬空端补 8–40 m、≤12% 引道，
 *        接不上标 dangling 且不接入车行；每条链路只规划一次。
 *  输出：{ links, driveLinks, surfaces, colliders, chunks, interchanges, statistics }；
 *        surface 供控制器当可站立面，collider 供侧向接触，chunk 供渲染。 */
export function planElevatedRoads(graph, terrainSurface, options) {
  validateGraph(graph);
  const interchanges = normalizeInterchanges(options);
  const extraCrossing = options?.extraCrossing;
  // reviewed/crossing 桥面沿用原始地形采样：水面返回 null 是步行桥断面的一部分，
  // 不能拿补采样值把桥头横坡拉平。全城派生记录才用带兜底的采样。
  const terrainHeight = createGroundSurfaceSampler(terrainSurface);
  const groundHeight = createGroundHeightWithFallback(terrainHeight);
  const groundNodes = new Set();
  const groundSignatures = new Set();
  const groundIndex = createGroundRoadIndex();
  const g4Bridges = new Set();
  const g4Nodes = new Set();
  const g4DeckAt = new Map();
  const highTunnelNodes = new Set([...highDeckTunnelPortals(graph).values()].flatMap(ends => [...ends.keys()]));
  const underpassNodes = new Map();
  for (const [tunnel, ends] of profiledUnderpassPortals(graph, terrainSurface?.hongliUnderpass)) {
    for (const [node, peers] of ends) for (const peer of peers) underpassNodes.set(`${peer}:${node}`, tunnel);
  }
  const nanpingNodes = new Map();
  const otherTunnelNodes = new Set();

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    const link = graph.links[index];
    if (metadata?.nanpingMainline && !metadata.tunnel) {
      nanpingNodes.set(link[0], metadata.highwayProfile[0]);
      nanpingNodes.set(link[1], metadata.highwayProfile[1]);
    } else if (metadata?.tunnel && !metadata.nanpingMainline) {
      otherTunnelNodes.add(link[0]);
      otherTunnelNodes.add(link[1]);
    }
    // 与 tools/sz/elevated_cut.py 一致。按快照的高速主线名称和桥梁标签选段。
    if (metadata?.bridge === true && !metadata.tunnel && metadata.layer > 0
      && metadata.highway === 'motorway' && (metadata.highwayProfile || graph.names[link[2]] === '京港澳高速')) {
      g4Bridges.add(index);
      for (const [side, node] of [link[0], link[1]].entries()) {
        if (metadata.highwayProfile) g4DeckAt.set(node, metadata.highwayProfile[side]);
        g4Nodes.add(node);
      }
    }
    if (!isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, link);
    groundSignatures.add(canonicalSignature(points));
    groundNodes.add(link[0]);
    groundNodes.add(link[1]);
    groundIndex.add(index, points, link[3], link[0], link[1]);
  }

  const sources = options?.waterfront;
  const wetPolygon = index => options.water[index];
  const baishiRiver = sources?.waters?.find(row => row.id === 'way/25603390');
  const riverFoundation = baishiRiver && ((x, z) => polygonContainsInclusive(wetPolygon(baishiRiver.waterIndex), x, z)
    ? baishiRiver.heightM - 1 : null);
  const roadProfiles = new Map();
  for (const row of sources?.roadBridges ?? []) {
    const polygon = wetPolygon(row.waterIndex);
    const waterAt = (x, z) => polygonContainsInclusive(polygon, x, z);
    for (const { edge, heightsM } of row.portals) roadProfiles.set(edge, { ...row, waterAt, portalHeights: heightsM,
      pierAt: (x, z, half) => [-half, half].every(dx => [-half, half].every(dz => waterAt(x + dx, z + dz))) });
  }
  const skipJoin = index => options?.exclude?.has(index)
    || roadProfiles.has(index) || extraCrossing?.sourceIds.has(graph.metadata[index]?.osmId)
    || groundSignatures.has(canonicalSignature(roadLinkPoints(graph, graph.links[index])));
  const highwayJoins = findHighwayJoins(graph, groundNodes, skipJoin);
  const junctionTapers = findJunctionTapers(graph, groundNodes, skipJoin);
  const records = [];
  const replan = new Map();
  const recordsByInterchange = new Map(interchanges.map(entry => [entry.id, []]));
  let groundDuplicates = 0;
  let skippedLinks = 0;
  let tunnelLinks = 0;
  for (let index = 0; index < graph.links.length; index++) {
    const link = graph.links[index];
    const metadata = graph.metadata[index];
    if (!metadata || options?.exclude?.has(index)
      || (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0))) continue;
    if (isGroundRoad(metadata)) continue;
    // OSM 隧道只做离线审核；不摊成贴地桥面，避免隧道口出现假护栏。
    if (metadata.tunnel === true) {
      tunnelLinks++;
      continue;
    }
    const points = roadLinkPoints(graph, link);
    if (groundSignatures.has(canonicalSignature(points))) {
      groundDuplicates++;
      continue;
    }
    const crossing = extraCrossing?.sourceIds.has(metadata.osmId) ? extraCrossing : null;
    const profile = roadProfiles.get(index);
    // 分区只用于归属统计，不再决定是否生成结构面。
    const urban = metadata.interchangeApproach;
    const owner = crossing ?? interchanges.find(entry => entry.id === urban?.id)
      ?? interchanges.find(entry => polylineIntersectsArea(points, entry.area));
    const layer = metadata.layer ?? 0;
    const designLayer = roadDeckLayer(metadata, graph.names[link[2]]);
    const isHigh = designLayer === 2;
    const g4 = g4Bridges.has(index);
    const nominalLift = roadDeckRise(designLayer, metadata);
    const groundAt = (node, point) => {
      if (isHigh && nanpingNodes.has(node)) return nanpingNodes.get(node) - nominalLift;
      if (g4DeckAt.has(node)) return g4DeckAt.get(node) - DECK_RISE_M;
      return g4Nodes.has(node) ? terrainHeight(point.x, point.z) : null;
    };
    let liftOverride = null;
    let raisedForCrossing = false;
    // bridge 且 layer=0：跨越地面道路时抬 1 层，跨水/涵洞保持贴地。
    if (metadata.bridge === true && layer === 0 && !profile && !crossing) {
      const width = Math.max(link[3], 6.5);
      raisedForCrossing = groundIndex.crosses(points, width / 2, link[0], link[1]);
      liftOverride = raisedForCrossing ? DECK_RISE_M : 0;
    }
    // 同层支线共用京港澳接点的高度基准和层高；跨层缓降仍用邻段的目标高度。
    const highway = metadata.highwayProfile;
    const alignment = highway ? { g4: true,
      startGround: highway[0] - (highway[2] ? nominalLift : 0),
      endGround: highway[1] - (highway[3] ? nominalLift : 0)
    } : {
      g4,
      portalStart: isHigh && highTunnelNodes.has(link[0]),
      portalEnd: isHigh && highTunnelNodes.has(link[1]),
      startGround: groundAt(link[0], points[0]),
      endGround: groundAt(link[1], points.at(-1))
    };
    const makeRecord = groundCrossings => planLink(graph, link, index, metadata,
      profile || crossing || urban ? terrainHeight : groundHeight, groundNodes, profile, crossing,
      liftOverride, groundIndex, urban || highway ? null : highwayJoins.get(index),
      metadata.explicitCorridorProfile ? null : junctionTapers.get(index), alignment,
      metadata.explicitCorridorProfile ? null : groundCrossings);
    const record = makeRecord();
    if (record === null) {
      skippedLinks++;
      continue;
    }
    record.interchangeId = owner?.id ?? 'generic';
    record.raisedForCrossing = raisedForCrossing;
    records.push(record);
    replan.set(record, makeRecord);
    if (owner) recordsByInterchange.get(owner.id)?.push(record);
  }

  for (const [record, zones] of findGroundCrossings(graph, records, terrainHeight, groundIndex)) {
    const replacement = replan.get(record)(zones);
    if (replacement.gradeProfile.maxGrade <= ELEVATED_DRIVE_MAX_GRADE + 1e-6) Object.assign(record, replacement);
  }

  const recordsByIndex = new Map(records.map(record => [record.index, record]));
  for (const record of records) {
    for (const [split, side] of [[record.splitStart, 'start'], [record.splitEnd, 'end']]) {
      if (!split) continue;
      const peer = recordsByIndex.get(split.joinIndex);
      if (!peer) continue;
      // 两端顶面已经同高对齐，不再各自外延 4 m 搭接，否则会在接缝处叠出两层共面三角面。
      if (split.joinSide === 'start') {
        peer.connectedStart = true;
        peer.noStartExtension = true;
      } else {
        peer.connectedEnd = true;
        peer.noEndExtension = true;
      }
    }
  }

  const walking = [...(sources?.footbridges ?? []), ...(options?.parkFootbridges ?? [])].map((bridge, i) => {
    const { points, id, widthM, girderDepthM, waterIndex, waterHeightM, profile } = bridge;
    const polygon = bridge.coastal ? null : wetPolygon(waterIndex);
    const waterAt = bridge.coastal ? options.isWater : (x, z) => polygonContainsInclusive(polygon, x, z);
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
    const park = profile === 'park-footbridge-estimate';
    return planLink(line, link, -i - 1, { osmId: id, layer: 1, bridge: true }, terrainHeight, new Set(),
      { widthM, girderDepthM, waterAt, waterHeightM, heightAt, walk: true, profile,
        ...(park ? { pierAt: (x, z, half) => [-half, half].every(dx => [-half, half].every(dz => waterAt(x + dx, z + dz))) } : {}),
        surfaceId: park ? `talent-park:bridge:${id}` : `waterfront-bridge:${id}` }, null, null, groundIndex);
  }).filter(Boolean);
  // 端接续：共享地面节点、贴地层或同节点同高结构邻居视为接通；其余悬空端补引道。
  const endingsByNode = new Map();
  for (const record of records) {
    record.aprons = [];
    record.danglingEnds = [];
    record.dangling = false;
    const anchored = Boolean(record.reviewed || record.crossing);
    // 前海地下道路另有纵断面，南坪主线支持驶至源边界，只有同标高的南坪隧道允许续接。
    const clipped = node => ((record.highwayMainline || record.nanpingMainline) && graph.nodeIds?.[node]?.startsWith('clip/'))
      || (record.nanpingMainline && (highTunnelNodes.has(node) || otherTunnelNodes.has(node)))
      || underpassNodes.has(`${record.index}:${node}`);
    record.connectedStart = record.sharedStart || record.effectiveLiftM <= 0.05 || anchored || clipped(record.startNode);
    record.connectedEnd = record.sharedEnd || record.effectiveLiftM <= 0.05 || anchored || clipped(record.endNode);
    for (const [node, side, y] of [[record.startNode, 'start', record.startDeckY],
      [record.endNode, 'end', record.endDeckY]]) {
      if (!endingsByNode.has(node)) endingsByNode.set(node, []);
      endingsByNode.get(node).push({ record, side, y });
    }
  }
  for (const record of records) {
    for (const [node, side, y] of [[record.startNode, 'start', record.startDeckY],
      [record.endNode, 'end', record.endDeckY]]) {
      if (side === 'start' ? record.connectedStart : record.connectedEnd) continue;
      const peers = endingsByNode.get(node) ?? [];
      const joined = peers.some(peer => peer.record !== record
        && Math.abs(peer.y - y) <= ELEVATED_JOIN_TOLERANCE_M);
      if (!joined) continue;
      if (side === 'start') record.connectedStart = true; else record.connectedEnd = true;
    }
  }
  for (const record of records) {
    if (record.reviewed || record.crossing) continue;
    for (const side of ['start', 'end']) {
      if (side === 'start' ? record.connectedStart : record.connectedEnd) continue;
      const apron = buildApron(record, side, groundHeight);
      if (apron === null) {
        record.danglingEnds.push(side);
        continue;
      }
      record.aprons.push(apron);
      measureRoadProfile(record.gradeProfile, apron.frames, () => 'approach');
      record.maxGrade = Math.max(record.maxGrade, apron.grade);
      if (side === 'start') record.connectedStart = true; else record.connectedEnd = true;
    }
    record.dangling = record.danglingEnds.length > 0;
    // 引道按 12% 等分落地时会产生 1e-16 级浮点误差；仅在容差内把它归到上限，避免恰好 12% 的坡被误判为超限。
    if (record.maxGrade > ELEVATED_DRIVE_MAX_GRADE
      && record.maxGrade <= ELEVATED_DRIVE_MAX_GRADE + 1e-6) {
      record.maxGrade = ELEVATED_DRIVE_MAX_GRADE;
    }
  }
  // 端部搭接段在引道之后补：有引道的一端不再外延，避免桥面与引道三角面重叠。
  for (const record of records) {
    if (record.reviewed?.walk) continue;
    const hasApron = side => record.aprons.some(apron => apron.side === side);
    if (!hasApron('start') && record.connectedStart && !record.splitStart && !record.noStartExtension) {
      pushDeckExtension(record, 'start');
    }
    if (!hasApron('end') && record.connectedEnd && !record.noEndExtension && !record.splitEnd) {
      pushDeckExtension(record, 'end');
    }
  }
  for (const record of records) {
    for (const [side, frame, shared, node] of [
      ['start', record.frames[0], record.sharedStart, record.startNode],
      ['end', record.frames.at(-1), record.sharedEnd, record.endNode]
    ]) {
      const apron = record.aprons.find(entry => entry.side === side);
      const heightAt = record.reviewed || record.crossing ? terrainHeight : groundHeight;
      const fromY = roadProfileHeight(frame);
      if (shared || apron?.atGrade) recordRoadProfileSeam(record.gradeProfile,
        { side, kind: 'terrain', node, atM: frame.d, fromY, toY: heightAt(frame.x, frame.z) },
        ELEVATED_JOIN_TOLERANCE_M);
      if (apron?.frames.length) {
        const [join, tip] = [apron.frames[0], apron.frames.at(-1)];
        recordRoadProfileSeam(record.gradeProfile,
          { side, kind: 'deck-to-approach', node, atM: frame.d, fromY, toY: roadProfileHeight(join) },
          ELEVATED_JOIN_TOLERANCE_M);
        recordRoadProfileSeam(record.gradeProfile,
          { side, kind: 'approach-to-terrain', atM: tip.d, fromY: roadProfileHeight(tip), toY: heightAt(tip.x, tip.z) },
          ELEVATED_JOIN_TOLERANCE_M);
      }
      for (const peer of endingsByNode.get(node) ?? []) {
        if (peer.record === record) continue;
        const peerFrame = peer.side === 'start' ? peer.record.frames[0] : peer.record.frames.at(-1);
        recordRoadProfileSeam(record.gradeProfile, {
          side, kind: 'structure', node, atM: frame.d, peer: peer.record.surfaceId,
          fromY, toY: roadProfileHeight(peerFrame),
          separated: record.layer !== peer.record.layer
        }, ELEVATED_JOIN_TOLERANCE_M);
      }
    }
  }
  // 车行链路：高程来自本计划同一批桥面三角面，两端接通、非隧道、layer 不为 0 且纵坡可驾驶。
  // layer=0 但跨路抬升的桥（raisedForCrossing）同样有真实层高，按 effectiveLiftM 判定而不是原始 layer。
  const driveLinks = records.filter(record => record.contactSurface !== false
    && !record.tunnel && (record.layer !== 0 || record.effectiveLiftM > 0.05)
    && !record.dangling && record.connectedStart && record.connectedEnd
    && record.maxGrade <= (record.reviewed ? 0.05 : ELEVATED_DRIVE_MAX_GRADE) + 1e-6);
  const junctionNeighbors = reviewedJunctionNeighbors(graph, driveLinks);
  for (const [record, peers] of mergeNeighbors(records, graph.metadata)) {
    const merged = junctionNeighbors.get(record) ?? new Set();
    for (const peer of peers) merged.add(peer);
    junctionNeighbors.set(record, merged);
  }
  interchangeDeckNeighbors(records, graph.metadata, junctionNeighbors);
  const deckKeepout = createPierDeckKeepouts([...records, ...walking]);
  const carriagewayOccupied = options?.carriagewayOccupied ?? groundIndex.occupied;
  const pierOptions = { ...options, terrainHeight };
  for (const record of [...records, ...walking]) {
    // 慢行与车行在同桥并行时保留车道边界，步行桥靠车道的一侧也保留护栏。
    const sameBridge = record.reviewed && [...records, ...walking].filter(other => other !== record && other.reviewed
      && other.reviewed.walk === record.reviewed.walk && other.reviewed.waterHeightM === record.reviewed.waterHeightM);
    const heightAt = record.reviewed || record.crossing ? terrainHeight : groundHeight;
    addPiers(record, heightAt, carriagewayOccupied, deckKeepout, record.osmId === BAISHI_GREENWAY_OVERPASS_WAY
      ? { ...pierOptions, waterFoundation: riverFoundation } : pierOptions);
    addBarriers(record, heightAt, sameBridge || junctionNeighbors.get(record));
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
    const tunnel = underpassNodes.get(`${record.index}:${record.endNode}`);
    successors.set(record.surfaceId, [...candidates.map(candidate => candidate.id),
      ...(tunnel === undefined ? [] : [`sz-tunnel:${tunnel}`])]);
  }
  const surfaces = [...records, ...walking].filter(record => record.contactSurface !== false).map(record => ({
    id: record.surfaceId,
    heightSource: 'estimate',
    triangles: record.topTriangles,
    // 桥头与地面共享节点处允许车辆从地面踏上桥面；桥下高差超过抬脚高度时不会吸附。
    climbableFromGround: true,
    ...(record.reviewed?.walk ? { solidDeck: true } : {}),
    ...(record.reviewed?.profile === 'park-footbridge-estimate' ? { modes: ['person', 'cyclist', 'helicopter'] } : {}),
    driveSuccessors: successors.get(record.surfaceId) ?? []
  }));
  const chunks = [...buildChunks(records), ...buildChunks(walking).map(c => ({ ...c, id: `walk:${c.id}` }))];
  // 构建期竖直截断山体的岩壁几何按走廊边界烘好，运行时直接还原，不再采样地形。
  const cutWalls = terrainSurface?.cutWalls ?? { positions: [], triangles: 0 };
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
    connectors: 0,
    connectorLengthM: 0,
    gradeConflicts: records.filter(record => record.maxGrade > ELEVATED_DRIVE_MAX_GRADE + 1e-6)
      .map(record => record.index),
    finalProfileGradeConflicts: records.filter(record => record.gradeProfile.maxGrade > ELEVATED_DRIVE_MAX_GRADE + 1e-6)
      .map(record => record.index),
    deckLengthM: records.reduce((sum, record) => sum + record.lengthM, 0),
    areaM2: records.reduce((sum, record) => sum + record.areaM2, 0),
    surfaces: surfaces.length,
    triangles: records.reduce((sum, record) => sum
      + (record.geometry.length + record.barrierGeometry.length + record.pierGeometry.length) / 9, 0),
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
    generic: records.filter(record => record.interchangeId === 'generic').length,
    aprons: records.reduce((sum, record) => sum + record.aprons.length, 0),
    apronLengthM: records.reduce((sum, record) => sum + record.aprons.reduce((length, apron) => length + apron.lengthM, 0), 0),
    dangling: records.filter(record => record.dangling).length,
    nonDrivable: records.length - driveLinks.length,
    layerZero: records.filter(record => record.layer === 0).length,
    layerZeroCrossings: records.filter(record => record.raisedForCrossing).length,
    cutWallTriangles: Math.round(cutWalls.triangles ?? 0),
    sunkLinks: records.filter(record => record.layer < 0).length,
    groundDuplicates,
    skippedLinks,
    tunnelLinks,
    limitations: [...LIMITATIONS]
  };
  const area = interchanges.length
    ? {
      minX: Math.min(...interchanges.map(entry => entry.area.minX)),
      maxX: Math.max(...interchanges.map(entry => entry.area.maxX)),
      minZ: Math.min(...interchanges.map(entry => entry.area.minZ)),
      maxZ: Math.max(...interchanges.map(entry => entry.area.maxZ))
    }
    : records.reduce((bounds, record) => {
      for (const point of record.points) {
        bounds.minX = Math.min(bounds.minX, point.x);
        bounds.maxX = Math.max(bounds.maxX, point.x);
        bounds.minZ = Math.min(bounds.minZ, point.z);
        bounds.maxZ = Math.max(bounds.maxZ, point.z);
      }
      return bounds;
    }, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

  return { version: 1, heightSource: 'estimate', area, interchanges: interchangeSummaries,
    links: records, driveLinks, surfaces, colliders, chunks, cutWalls, statistics, walking };
}

/** 解析：把高架计划建成场景：≤64 个约 2 km 空间分块网格 + 可站立表面 + 侧向接触体。
 *  输入：roadGraph、terrainSurface（GEO 里的派生地形），以及 area（旧接口）或 interchanges（多立交分区）。
 *  输出：{ group, meshes, surfaces, colliders, interchanges, statistics, links, update, dispose }。
 *  约束：桥面高度、护栏尺寸、桥墩间距和连接坡道均为 estimate；不导入外部模型。 */
export function buildSzElevatedRoads(scene, { graph, terrainSurface, area, interchanges, exclude, waterfront, parkFootbridges, water, extraCrossing, isWater, pedestrianKeepout, carriagewayOccupied, sidePierBlocked } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('A THREE scene is required');
  const options = area ? { ...area, pedestrianKeepout, carriagewayOccupied, sidePierBlocked }
    : { interchanges, exclude, waterfront, parkFootbridges, water, extraCrossing, isWater,
      pedestrianKeepout, carriagewayOccupied, sidePierBlocked };
  const plan = planElevatedRoads(graph, terrainSurface, options);
  // 车行网络复用渲染桥面的顶面三角面：车轮接触、自动规划和渲染桥面同源，桥下层不串到上层。
  const driveSurfaceIds = new Set(plan.driveLinks.map(record => record.surfaceId));
  const driveSurfaces = plan.surfaces.filter(surface => driveSurfaceIds.has(surface.id));
  const group = new THREE.Group();
  group.name = 'shenzhen-elevated-roads';
  // 没有纹理，沥青观感只靠颜色和粗糙度；polygonOffset 只处理与地面共面处的绘制顺序。
  // 双面渲染让护栏的内外侧面都可见，桥面和墩身的三角面不受影响。
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
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
    const colors = new Uint8Array(chunk.positions.length);
    const color = new THREE.Color();
    for (const { start, end, color: value } of chunk.materialRanges) {
      color.setHex(value);
      const r = Math.round(color.r * 255), g = Math.round(color.g * 255), b = Math.round(color.b * 255);
      for (let i = start; i < end; i += 3) {
        colors[i] = r;
        colors[i + 1] = g;
        colors[i + 2] = b;
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
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
  // 山体裁切段的沟底与崖壁用土石色，与桥面沥青分开，避免读成可驶入的路面。
  let cutMaterial = null;
  if (plan.cutWalls.positions.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(plan.cutWalls.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    cutMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x6b6152, roughness: 1, metalness: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, cutMaterial);
    mesh.name = 'shenzhen-elevated-roads:cut-walls';
    mesh.receiveShadow = true;
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
      cutMaterial?.dispose();
    }
  };
}
