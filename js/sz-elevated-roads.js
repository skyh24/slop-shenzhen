import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld } from 'three/tsl';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { deckLaneProfile } from './sz-road-section.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';

// 立交桥面高程没有实测纵断面，按 layer 的估算层高派生，接触面与显示几何共用同一批三角面。
// 城区立交按梁底净空 4.8 m 控制；桥面顶 = 净空 + 梁高，避免把 4.8 m 误当成梁底高度。
const LAYER_CLEARANCE_M = 4.8;
const GIRDER_DEPTH_M = 0.35;
const LAYER_HEIGHT_M = LAYER_CLEARANCE_M + GIRDER_DEPTH_M;
const DECK_STEP_M = 4;
// 端部各外延 4 m 平段，让相邻链路/地面路的接触面在节点处有重叠，避免车辆在链路交界
// 因支撑高度跳变 >1.5 m 被判定“无支撑”而刹停。引道必须从这段外延的末端起步，否则会与
// 桥面在同一 (x,z) 上给出两个不同高度，触发接触面“同一身份不得重叠”的自检。
const DECK_OVERLAP_M = 4;
const PIER_SPACING_M = 28;
const PIER_MIN_CLEARANCE_M = 2;
// 桥墩不得落在下方地面车行道上：墩身外缘再留 0.5 m，落在路面走廊内则沿桥纵线换位，换不到就跳墩。
const PIER_ROAD_CLEARANCE_M = 0.5;
// 全城结构面按约 2 km 网格分块，每块一个 mesh；桶数超过上限时自动加粗网格。
const CHUNK_GRID_M = 2000;
const MAX_CHUNKS = 64;
// 悬空端引道：长度在 8–40 m 内按高差自适应，坡度不超过 12%；接不上时只标记 dangling。
const APRON_MIN_M = 8;
const APRON_MAX_M = 48;
const APRON_MAX_GRADE = 0.12;
// 不同车道数的桥面在节点相接时，宽的一侧用 15–30 m 缓慢收窄到对方的宽度；
// 只在桥面内部收边，不把整条链路改窄，也不影响桥墩和接触面的全长。
const JUNCTION_TAPER_MIN_M = 15;
const JUNCTION_TAPER_MAX_M = 30;
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
// 桥面标高固定为端点地面 + layer×4.8 m，地形更高的断面由构建期（tools/sz/elevated_cut.py）
// 在山体上按走廊竖直截断，并把岩壁顶点烘进 terrainSurface.cutWalls；运行时只还原这份几何，
// 不再逐帧采样地形，避免崖顶在相邻断面之间跳动成锯齿。
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
  '全城非地面、非隧道链路都按 OSM layer 与地形派生结构面；面高程是估算，专项结构纵断面另行核对。',
  'bridge 且 layer=0 的链路只有在跨越地面道路时按 1 层（梁底净空 4.8 m，桥面顶 5.15 m）抬升，跨水或涵洞保持贴地；判断用地面边折线与结构面走廊相交，不是实测净空。',
  '匝道与地面道路共享节点处按地形高程落地，坡度按实际生成纵断面检查，不是测量坡度。',
  'layer<0 的非隧道链路按 0 抬升派生贴地结构面，不设护栏；只有纵坡不超过 12% 且两端能接地面或结构面时才接入车行。',
  '悬空端补 8–48 m、坡度不超过 12% 的引道；地形落差过大、无法在限长内接地的端头标记为 dangling，不抛错也不接入车行。',
  '桥墩按约 28 m 间距估计布置，只在净空大于 2 m 时设墩；墩位避开下方地面车行道走廊，落在路面内时沿桥纵线换位，换不到则跳墩。墩位与基础未做地勘核实。',
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
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half },
      nx, nz
    };
  });
}

// 同节点、同层、方向相反的结构邻居才视为同一条线的延续。宽桥面在延续到窄桥面的
// 一端缓慢收窄；分岔出去的窄匝道不参与，否则 16 m 主桥会在分岔口被削成 5 m。
// 只读取路网，不改变邻居；审核桥的实测宽度不参与派生。
function findJunctionTapers(graph, groundNodes) {
  const endsByNode = new Map();
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || metadata.tunnel === true || metadata.crossSection) continue;
    if (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0)) continue;
    if (isGroundRoad(metadata)) continue;
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
    const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
    const width = deckLaneProfile(link).widthM;
    for (const end of ends) {
      if (groundNodes.has(end.node)) continue;
      if (!endsByNode.has(end.node)) endsByNode.set(end.node, []);
      endsByNode.get(end.node).push({ index, ...end, layer, width });
    }
  }
  const tapers = new Map();
  for (const list of endsByNode.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.index === b.index || a.layer !== b.layer) continue;
        if (a.ux * b.ux + a.uz * b.uz > -0.55) continue;
        if (Math.min(a.width, b.width) / Math.max(a.width, b.width) < 0.45) continue;
        const wide = a.width > b.width ? a : b;
        const narrow = wide === a ? b : a;
        if (wide.width - narrow.width < 0.5) continue;
        if (!tapers.has(wide.index)) tapers.set(wide.index, { start: wide.width, end: wide.width });
        tapers.get(wide.index)[wide.side] = Math.min(tapers.get(wide.index)[wide.side], narrow.width);
      }
    }
  }
  return tapers;
}

// OSM 相邻链路把连续高架误写成 layer 2 接 layer 1 时，上层端头会在节点处悬空 5.15 m，
// 看起来像断头。这里在同一个路网节点上找方向相反、宽度相近、层数差 1 的结构邻居，
// 让上层最后一段按 12% 缓降到下层桥面高程，并把两端都登记为接通，避免再补落地引道。
// 只读取原始路网，不读取已生成的桥面，规划顺序保持无依赖。
function findLayerSplits(graph, groundNodes, g4LayersAt) {
  const endsByNode = new Map();
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || metadata.tunnel === true || metadata.crossSection) continue;
    if (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0)) continue;
    if (isGroundRoad(metadata)) continue;
    const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
    if (layer <= 0) continue;
    const link = graph.links[index];
    const points = roadLinkPoints(graph, link);
    if (points.length < 2) continue;
    const firstRun = Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z) || 1;
    const lastRun = Math.hypot(points.at(-1).x - points.at(-2).x, points.at(-1).z - points.at(-2).z) || 1;
    const ends = [
      { side: 'start', node: link[0], x: points[0].x, z: points[0].z,
        ux: (points[0].x - points[1].x) / firstRun, uz: (points[0].z - points[1].z) / firstRun },
      { side: 'end', node: link[1], x: points.at(-1).x, z: points.at(-1).z,
        ux: (points.at(-1).x - points.at(-2).x) / lastRun, uz: (points.at(-1).z - points.at(-2).z) / lastRun }
    ];
    for (const end of ends) {
      if (groundNodes.has(end.node)) continue;
      if (!endsByNode.has(end.node)) endsByNode.set(end.node, []);
      endsByNode.get(end.node).push({ index, ...end, layer, width: Math.max(link[3], 6.5) });
    }
  }
  const splits = new Map();
  for (const list of endsByNode.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.index === b.index || Math.abs(a.layer - b.layer) !== 1) continue;
        // 两条边从同一节点向相反方向离开，才是同一条连续线形，不是在此处相交的立交。
        if (a.ux * b.ux + a.uz * b.uz > -0.55) continue;
        const upper = a.layer > b.layer ? a : b;
        const lower = a.layer > b.layer ? b : a;
        if (Math.min(upper.width, lower.width) / Math.max(upper.width, lower.width) < 0.6) continue;
        if (!splits.has(upper.index)) splits.set(upper.index, {});
        const entry = splits.get(upper.index);
        if (entry[upper.side]) continue;
        const layerHeight = g4LayersAt.get(lower.node)?.has(lower.layer) ? LAYER_CLEARANCE_M : LAYER_HEIGHT_M;
        entry[upper.side] = { toLift: lower.layer * layerHeight, joinIndex: lower.index, joinSide: lower.side };
      }
    }
  }
  return splits;
}

function applyDeckTaper(frames, width, startWidth, endWidth, length) {
  const fullHalf = width / 2;
  const startHalf = startWidth / 2;
  const endHalf = endWidth / 2;
  if (startHalf >= fullHalf - EPSILON && endHalf >= fullHalf - EPSILON) return;
  // 横向收边按 1:4 控制，最长 30 m；两端都收时各占半条链路，避免渐变在中间交叉成沙漏。
  const difference = Math.max(width - startWidth, width - endWidth);
  const cap = Math.max(EPSILON, startWidth < width - 0.05 && endWidth < width - 0.05 ? length / 2 : length);
  const taper = Math.min(cap, Math.max(JUNCTION_TAPER_MIN_M, difference * 4), JUNCTION_TAPER_MAX_M);
  for (const frame of frames) {
    const startMix = Math.min(1, frame.d / taper);
    const endMix = Math.min(1, (length - frame.d) / taper);
    const half = Math.min(startHalf + (fullHalf - startHalf) * startMix,
      endHalf + (fullHalf - endHalf) * endMix);
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

/** 派生桥面纵断面、共享通行三角面以及护栏、桥墩和碰撞体。 */
function planLink(graph, link, index, metadata, groundHeight, groundNodes, reviewed = null, crossing = null, liftOverride = null, groundIndex = null, split = null, taper = null, alignment = null) {
  const points = roadLinkPoints(graph, link);
  if (points.length < 2) return null;
  const length = polylineLength(points);
  if (length <= EPSILON) return null;
  const [start, end] = [link[0], link[1]];
  const startGround = alignment?.startGround ?? groundHeight(points[0].x, points[0].z);
  const endGround = alignment?.endGround ?? groundHeight(points.at(-1).x, points.at(-1).z);
  if (!reviewed && (!Number.isFinite(startGround) || !Number.isFinite(endGround))) return null;
  const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
  // bridge 且 layer=0 的链路可能因跨路被抬到 1 层；其余仍按 layer 计算。
  const lift = Number.isFinite(liftOverride) ? liftOverride : LAYER_HEIGHT_M * Math.max(0, layer);
  const startLift = alignment?.startLift ?? lift;
  const endLift = alignment?.endLift ?? lift;
  const sharedStart = groundNodes.has(start);
  const sharedEnd = groundNodes.has(end);
  const fullStart = startGround + startLift;
  const fullEnd = endGround + endLift;
  const startY = sharedStart ? startGround : fullStart;
  const endY = sharedEnd ? endGround : fullEnd;
  const baseGrade = Math.abs(fullEnd - fullStart) / length;
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
  if (!reviewed && taper) applyDeckTaper(frames, width, taper.start, taper.end, length);
  let deckHeightAt = reviewed?.heightAt ?? (reviewed
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
      const dropStart = sharedStart ? Math.max(0, startLift - distance * rampGrade) : 0;
      const dropEnd = sharedEnd ? Math.max(0, endLift - (length - distance) * rampGrade) : 0;
      return fullY - Math.max(dropStart, dropEnd);
    });
  // 同节点错层衔接：在上层链路靠近节点的一段内线性降到下层桥面高程。
  // 纵坡固定不超过 12%；长度不够时放弃衔接，仍按引道/悬空端规则处理，避免造出不可驾驶的陡坡。
  let splitStart = null;
  let splitEnd = null;
  if (split && !reviewed && !crossing) {
    const resolve = (side, baseY, groundY) => {
      const info = split[side];
      if (!info) return null;
      const targetY = groundY + info.toLift;
      const drop = baseY - targetY;
      if (drop <= 0.05) return null;
      const rampM = drop / ELEVATED_DRIVE_MAX_GRADE;
      if (rampM > length + 1e-6) return null;
      return { drop, rampM, targetY, grade: drop / rampM, joinIndex: info.joinIndex, joinSide: info.joinSide };
    };
    splitStart = resolve('start', startY, startGround);
    splitEnd = resolve('end', endY, endGround);
    if (splitStart && splitEnd && splitStart.rampM + splitEnd.rampM > length) {
      splitStart = null;
      splitEnd = null;
    }
    if (splitStart || splitEnd) {
      const base = deckHeightAt;
      deckHeightAt = d => {
        let y = base(d);
        if (splitStart) y -= splitStart.drop * Math.min(1, Math.max(0, (splitStart.rampM - d) / splitStart.rampM));
        if (splitEnd) y -= splitEnd.drop * Math.min(1, Math.max(0, (d - (length - splitEnd.rampM)) / splitEnd.rampM));
        return y;
      };
    }
  }
  const girderDepth = reviewed?.girderDepthM ?? GIRDER_DEPTH_M;
  const half = Math.max(0.7, Math.min(1.4, width * 0.08));
  const geometry = [];
  const topTriangles = [];
  const topPaintTriangles = [];
  const pierRecords = [];
  const pierColliders = [];
  const slabColliders = [];
  const surfaceId = reviewed?.surfaceId ?? `sz-elevated-road:${index}`;
  const osmId = metadata.osmId ?? null;
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
    || maxClearanceM > DECK_CONTACT_RISE_M);
  // 错层衔接端必须精确落在下层桥面高程，不能因为地形下限抬回去；坡度已在 12% 内，这里只锁端点。
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
    if (reviewed) {
      const [u, v, w, t] = [topA, topB, topC, topD].map(p => ({ ...p, y: p.y - girderDepth }));
      pushQuad(geometry, u, v, w, t);
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

  const abutments = parkBridge ? [frames.find(f => f.d >= 2), frames.findLast(f => f.d <= length - 2)] : [];
  for (const station of reviewed || crossing ? [...pierSpacing({ frames, lengthM: length }), ...abutments] : []) {
    if (crossing && !crossing.allowsPier(station)) continue;
    // 审核桥与通用桥同一底线：桥墩不能落在下方地面车行道上。
    if (groundIndex?.occupied(station.x, station.z, half + PIER_ROAD_CLEARANCE_M)) continue;
    const abutment = abutments.includes(station);
    const terrainY = abutment ? (groundHeight(station.x, station.z) ?? station.y) - 0.5 : reviewed
      ? (reviewed.pierAt?.(station.x, station.z, half) ? reviewed.waterHeightM - 1 : null)
      : groundHeight(station.x, station.z);
    if (!Number.isFinite(terrainY)) continue;
    const clearance = station.y - terrainY;
    if (!abutment && clearance <= (parkBridge ? 0.5 : PIER_MIN_CLEARANCE_M)) continue;
    const topY = station.y - girderDepth;
    if (topY - terrainY <= (abutment ? 0.08 : 0.2)) continue;
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
      // 墩顶固定在梁底。引道上车身底面按桥心高度摊平，会低于前方墩顶几厘米，接触检测按这段梁底净空放行。
      topClearance: girderDepth,
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
    reviewed, crossing,
    // 分流节点处的上游平桥不补端部搭接段。
    noEndExtension: endsAtSplit,
    name: graph.names[link[2]] ?? '',
    width,
    barrierWidthM: ELEVATED_BARRIER_WIDTH_M,
    laneCount: laneProfile?.laneCount ?? 1,
    perDirectionLanes: laneProfile?.perDirection ?? 1,
    lanes: link[4],
    direction: link[5],
    bridge: metadata.bridge === true,
    tunnel: metadata.tunnel === true,
    layer,
    effectiveLiftM: lift,
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
    // 错层衔接那段 12% 缓降必须计入纵坡，否则驾驶面会把它当平桥。
    maxGrade: reviewed || crossing || alignment?.g4 ? maxGrade
      : Math.max(Math.abs(endY - startY) / length, splitStart?.grade ?? 0, splitEnd?.grade ?? 0),
    splitStart: splitStart && {
      joinIndex: splitStart.joinIndex, joinSide: splitStart.joinSide,
      dropM: splitStart.drop, rampM: splitStart.rampM, targetY: splitStart.targetY
    },
    splitEnd: splitEnd && {
      joinIndex: splitEnd.joinIndex, joinSide: splitEnd.joinSide,
      dropM: splitEnd.drop, rampM: splitEnd.rampM, targetY: splitEnd.targetY
    },
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

// 非核实的同高合流：两条桥面在同一节点以相同高度相接、且在交汇前横向错开（不是同一条缎带续接），
// 说明各自是独立车道/匝道。交汇重叠段的护栏必须让位，否则会立进相邻桥面的车道里。
const MERGE_LATERAL_M = 1;
const MERGE_APPROACH_M = 20;
function mergeNeighbors(records) {
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
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i], b = peers[j];
        if (a.record === b.record || Math.abs(a.y - b.y) > ELEVATED_JOIN_TOLERANCE_M) continue;
        const end = a.side === 'start' ? a.record.points[0] : a.record.points[a.record.points.length - 1];
        const pa = approachPoint(a.record, a.side, MERGE_APPROACH_M);
        const pb = approachPoint(b.record, b.side, MERGE_APPROACH_M);
        const ux = end.x - pa.x, uz = end.z - pa.z;
        const run = Math.hypot(ux, uz) || 1;
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        const along = (dx * ux + dz * uz) / run;
        if (Math.hypot(dx - ux * along / run, dz - uz * along / run) <= MERGE_LATERAL_M) continue;
        for (const [from, to] of [[a.record, b.record], [b.record, a.record]]) {
          if (!neighbors.has(from)) neighbors.set(from, new Set());
          neighbors.get(from).add(to);
        }
      }
    }
  }
  return neighbors;
}

function addPiers(record, groundHeight, neighbors = [], groundIndex = null) {
  const { frames, geometry, osmId, surfaceId, piers, pierColliders, width } = record;
  const half = Math.max(0.7, Math.min(1.4, width * 0.08));
  const roadClearance = half + PIER_ROAD_CLEARANCE_M;
  const adjacent = [...neighbors].map(road => ({ id: road.surfaceId, triangles: road.topTriangles }));
  const heightAt = adjacent.length ? createSurfaceHeightAt(adjacent) : null;
  function overlapsNeighbor(frame) {
    const clearance = half + 0.25;
    return [-clearance, 0, clearance].some(dx => [-clearance, 0, clearance].some(dz =>
      adjacent.some(({ id }) => {
        const deck = heightAt(frame.x + dx, frame.z + dz, id);
        return deck !== null && deck < frame.y - GIRDER_DEPTH_M + JUNCTION_BARRIER_CLEARANCE_M;
      })));
  }
  const usedStations = new Set();
  for (const planned of pierSpacing(record)) {
    // 分岔内两条派生桥面仍有重叠。只在原桥纵线上顺移估算桥墩，避开同节点支道的铺装和车身净空；
    // 同时避开下方地面车行道，桥墩不允许落在行车道铺装内。换位后同一站不得被相邻墩位重复占用。
    const station = frames
      .filter(frame => frame.d <= record.lengthM - 2 && Math.abs(frame.d - planned.d) <= PIER_SPACING_M
        && !usedStations.has(frame) && !overlapsNeighbor(frame)
        && !(groundIndex?.occupied(frame.x, frame.z, roadClearance)))
      .sort((a, b) => Math.abs(a.d - planned.d) - Math.abs(b.d - planned.d) || a.d - b.d)[0];
    if (!station) continue;
    usedStations.add(station);
    const terrainY = groundHeight(station.x, station.z);
    if (!Number.isFinite(terrainY)) continue;
    const clearance = station.y - terrainY;
    if (clearance <= PIER_MIN_CLEARANCE_M) continue;
    const topY = station.y - GIRDER_DEPTH_M;
    if (topY - terrainY <= 0.2) continue;
    const pier = { x: station.x, z: station.z, baseY: terrainY, topY, half };
    piers.push(pier);
    pushPier(geometry, pier);
    // 桥墩接触体和可见墩身同一尺寸，minY 从地面起，只挡桥墩本身。
    pierColliders.push({
      type: 'elevated-pier',
      name: `${surfaceId}:pier:${piers.length}`,
      sourceId: osmId,
      minX: pier.x - half,
      maxX: pier.x + half,
      minZ: pier.z - half,
      maxZ: pier.z + half,
      minY: terrainY,
      maxY: topY,
      topClearance: GIRDER_DEPTH_M,
      polygon: {
        outer: [{ x: pier.x - half, z: pier.z - half }, { x: pier.x + half, z: pier.z - half },
          { x: pier.x + half, z: pier.z + half }, { x: pier.x - half, z: pier.z + half }],
        holes: []
      }
    });
  }
}

function addBarriers(record, groundHeight, neighbors = []) {
  const { frames, geometry, osmId, surfaceId } = record;
  const parkBridge = record.reviewed?.profile === 'park-footbridge-estimate';
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
    const width = parkBridge ? 0.10 : ELEVATED_BARRIER_WIDTH_M;
    return { x: point.x + (nx / length) * width * sign,
      z: point.z + (nz / length) * width * sign };
  };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    for (const side of ['left', 'right']) {
      const edgeA = { ...a[side], y: a[side].y ?? a.y };
      const edgeB = { ...b[side], y: b[side].y ?? b.y };
      const span = parkBridge ? [edgeA, edgeB] : barrierSpanOnGround(edgeA, edgeB, record.reviewed
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
      const railBottom = p => parkBridge ? { ...p, y: p.y + BARRIER_HEIGHT_M - 0.12 } : p;
      pushQuad(geometry, railBottom(startBottom), railBottom(endBottom), endTop, startTop);
      pushQuad(geometry, startTop, endTop, insetEndTop, insetStartTop);
      pushQuad(geometry, railBottom(insetStartBottom), insetStartTop, insetEndTop, railBottom(insetEndBottom));
      if (parkBridge) {
        pushQuad(geometry, startBottom, startTop, insetStartTop, insetStartBottom);
        if (i === frames.length - 1) pushQuad(geometry, endBottom, insetEndBottom, insetEndTop, endTop);
        for (const y of [0.32, 0.61]) {
          const at = p => ({ ...p, y: p.y + y });
          pushVerticalWall(geometry, at(startBottom), at(endBottom), start.y + y - 0.045, end.y + y - 0.045);
        }
      }
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
  const outer = { x, z, left: { x: x + end.nx * half, z: z + end.nz * half, y: end.left.y ?? end.y },
    right: { x: x - end.nx * half, z: z - end.nz * half, y: end.right.y ?? end.y } };
  const a = side === 'start' ? outer : end;
  const b = side === 'start' ? end : outer;
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
  const g4LayersAt = new Map();

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    const link = graph.links[index];
    // 与 tools/sz/elevated_cut.py 一致。按快照的高速主线名称和桥梁标签选段。
    if (metadata?.bridge === true && !metadata.tunnel && metadata.layer > 0
      && metadata.highway === 'motorway' && graph.names[link[2]] === '京港澳高速') {
      g4Bridges.add(index);
      for (const node of [link[0], link[1]]) {
        if (!g4LayersAt.has(node)) g4LayersAt.set(node, new Set());
        g4LayersAt.get(node).add(metadata.layer);
      }
    }
    if (!isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, link);
    groundSignatures.add(canonicalSignature(points));
    groundNodes.add(link[0]);
    groundNodes.add(link[1]);
    groundIndex.add(index, points, link[3], link[0], link[1]);
  }

  // 同节点错层断裂（OSM 把连续高架的花括号层数写错）在这里统一找出，规划时缓降衔接。
  const layerSplits = findLayerSplits(graph, groundNodes, g4LayersAt);
  // 同层延续到更窄桥面时，宽桥面的一端按 1:4 收边；分岔窄匝道不参与。
  const junctionTapers = findJunctionTapers(graph, groundNodes);
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
    const owner = crossing ?? interchanges.find(entry => polylineIntersectsArea(points, entry.area));
    const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
    const g4 = g4Bridges.has(index);
    let liftOverride = g4 ? layer * LAYER_CLEARANCE_M : null;
    let raisedForCrossing = false;
    // bridge 且 layer=0：跨越地面道路时抬 1 层，跨水/涵洞保持贴地。
    if (metadata.bridge === true && layer === 0 && !profile && !crossing) {
      const width = Math.max(link[3], 6.5);
      raisedForCrossing = groundIndex.crosses(points, width / 2, link[0], link[1]);
      liftOverride = raisedForCrossing ? LAYER_HEIGHT_M : 0;
    }
    // 同层支线共用京港澳接点的高度基准和层高；跨层缓降仍用邻段的目标高度。
    const alignment = g4LayersAt.has(link[0]) || g4LayersAt.has(link[1]) ? {
      g4,
      startGround: g4LayersAt.has(link[0]) ? terrainHeight(points[0].x, points[0].z) : null,
      endGround: g4LayersAt.has(link[1]) ? terrainHeight(points.at(-1).x, points.at(-1).z) : null,
      startLift: g4LayersAt.get(link[0])?.has(layer) ? layer * LAYER_CLEARANCE_M : null,
      endLift: g4LayersAt.get(link[1])?.has(layer) ? layer * LAYER_CLEARANCE_M : null
    } : null;
    const record = planLink(graph, link, index, metadata, profile || crossing ? terrainHeight : groundHeight,
      groundNodes, profile, crossing, liftOverride, groundIndex, layerSplits.get(index), junctionTapers.get(index), alignment);
    if (record === null) {
      skippedLinks++;
      continue;
    }
    record.interchangeId = owner?.id ?? 'generic';
    record.raisedForCrossing = raisedForCrossing;
    records.push(record);
    if (owner) recordsByInterchange.get(owner.id)?.push(record);
  }

  // 上层缓降端的下层邻居也要登记接通，否则它仍会被当成悬空端补一条落地引道。
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
    record.connectedStart = record.sharedStart || record.effectiveLiftM <= 0.05 || anchored;
    record.connectedEnd = record.sharedEnd || record.effectiveLiftM <= 0.05 || anchored;
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
  // 车行链路：高程来自本计划同一批桥面三角面，两端接通、非隧道、layer 不为 0 且纵坡可驾驶。
  // layer=0 但跨路抬升的桥（raisedForCrossing）同样有真实层高，按 effectiveLiftM 判定而不是原始 layer。
  const driveLinks = records.filter(record => record.contactSurface !== false
    && !record.tunnel && (record.layer !== 0 || record.effectiveLiftM > 0.05)
    && !record.dangling && record.connectedStart && record.connectedEnd
    && record.maxGrade <= (record.reviewed ? 0.05 : ELEVATED_DRIVE_MAX_GRADE) + 1e-6);
  const junctionNeighbors = reviewedJunctionNeighbors(graph, driveLinks);
  for (const [record, peers] of mergeNeighbors(records)) {
    const merged = junctionNeighbors.get(record) ?? new Set();
    for (const peer of peers) merged.add(peer);
    junctionNeighbors.set(record, merged);
  }
  for (const record of [...records, ...walking]) {
    // 慢行与车行在同桥并行时保留车道边界，步行桥靠车道的一侧也保留护栏。
    const sameBridge = record.reviewed && [...records, ...walking].filter(other => other !== record && other.reviewed
      && other.reviewed.walk === record.reviewed.walk && other.reviewed.waterHeightM === record.reviewed.waterHeightM);
    const heightAt = record.reviewed || record.crossing ? terrainHeight : groundHeight;
    if (!record.reviewed && !record.crossing) addPiers(record, heightAt, junctionNeighbors.get(record), groundIndex);
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
    successors.set(record.surfaceId, candidates.map(candidate => candidate.id));
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
    deckLengthM: records.reduce((sum, record) => sum + record.lengthM, 0),
    areaM2: records.reduce((sum, record) => sum + record.areaM2, 0),
    surfaces: surfaces.length,
    triangles: records.reduce((sum, record) => sum + record.geometry.length / 9, 0),
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
export function buildSzElevatedRoads(scene, { graph, terrainSurface, area, interchanges, exclude, waterfront, parkFootbridges, water, extraCrossing, isWater } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('A THREE scene is required');
  const options = area ? area : { interchanges, exclude, waterfront, parkFootbridges, water, extraCrossing, isWater };
  const plan = planElevatedRoads(graph, terrainSurface, options);
  // 车行网络复用渲染桥面的顶面三角面：车轮接触、自动规划和渲染桥面同源，桥下层不串到上层。
  const driveSurfaceIds = new Set(plan.driveLinks.map(record => record.surfaceId));
  const driveSurfaces = plan.surfaces.filter(surface => driveSurfaceIds.has(surface.id));
  const group = new THREE.Group();
  group.name = 'shenzhen-elevated-roads';
  // 没有纹理，沥青观感只靠颜色和粗糙度；polygonOffset 只处理与地面共面处的绘制顺序。
  // 双面渲染让护栏的内外侧面都可见，桥面和墩身的三角面不受影响。
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x3b3d41,
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
