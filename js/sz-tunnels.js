import * as THREE from 'three/webgpu';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { polygonContains } from './sz-polygon.js';
import { deckLaneProfile } from './sz-road-section.js';
import { createSzRoadSurfaceMaterial } from './sz-road-material.js';
import { HIGH_DECK_TUNNEL_APPROACH_M, highDeckTunnelPortals } from './sz-interchange-levels.js';
import { createRoadProfile, measureRoadProfile, recordRoadProfileSeam } from './sz-road-profile.js';
// 默认立交选区与桥面共用 sz-elevated-roads.js 导出的 SHENZHEN_INTERCHANGES，隧道和桥面不会各用一套范围。
// 这里用命名空间导入，只取该导出；条目结构仍是 {id,name,source,area,heightSource}，heightSource 必须是 estimate。
import * as elevated from './sz-elevated-roads.js';

// 隧道埋深没有实测纵断面，按 OSM layer 每层 6 m 估算；layer 只是上下关系，不是米。
export const TUNNEL_LAYER_DEPTH_M = 6;
// 洞身净空和最小洞宽都是估算值，不是设计图尺寸；洞内为直线断面。
export const TUNNEL_BORE_HEIGHT_M = 5;
export const TUNNEL_MIN_WIDTH_M = 6.5;
const TUNNEL_STEP_M = 4;
// 洞口与地面道路共享节点处落地，向内按这个长度线性下到估算埋深；更短的洞按两端插入过渡。
const PORTAL_TRANSITION_M = 12;
const PORTAL_FRAME_M = 1.5;
const WALL_THICKNESS_M = 0.35;
const MAX_CHUNKS = 8;
const EPSILON = 1e-8;
const REVIEW_STEP_M = 4;
const REVIEW_REASON = 'centreline crosses building without tunnel source';

// 显示用顶点色：路面接近沥青、洞壁和洞顶接近混凝土、洞口框略亮。没有贴图。
const FLOOR_COLOR = [0.18, 0.19, 0.2];
const WALL_COLOR = [0.42, 0.43, 0.44];
const CEILING_COLOR = [0.34, 0.35, 0.36];
const PORTAL_COLOR = [0.5, 0.5, 0.48];

const UP = Object.freeze({ x: 0, y: 1, z: 0 });
const DOWN = Object.freeze({ x: 0, y: -1, z: 0 });

const LIMITATIONS = [
  '隧道埋深按 OSM layer 每层 6 m 估算，没有实测纵断面或设计标高，不能写成测量值。',
  '洞口与地面道路共享节点处按地形高程落地，洞内埋深在 12 m 内线性过渡；坡度是几何派生值，不是测量坡度。',
  '洞身净空按 5 m、洞宽不小于 6.5 m 估算，均不是设计图尺寸。',
  'layer 为 0 的 OSM 隧道链路没有上下关系，只登记来源记录、不生成洞身，避免把零埋深当成实测。',
  '中心线穿楼但没有 OSM tunnel/bridge/layer 来源的链路只进 reviewList，不自动挖洞。',
  '只处理与立交分区相交的 OSM tunnel 链路；分区以外的隧道留待后续核对。',
  '洞顶和洞壁只作显示与洞壁碰撞，洞顶三角面不进入车辆接触面。'
];

function clamp01(value) {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function normalizeArea(area) {
  if (!area || typeof area !== 'object') throw new Error('An interchange area is required');
  const normalized = {
    minX: area.minX, maxX: area.maxX, minZ: area.minZ, maxZ: area.maxZ
  };
  if (!Object.values(normalized).every(Number.isFinite)
    || normalized.minX >= normalized.maxX || normalized.minZ >= normalized.maxZ) {
    throw new Error('Invalid interchange area');
  }
  return normalized;
}

// 显式传入的候选范围必须是数组；空数组表示没有选区，返回空计划而不抛错。
function normalizeInterchanges(list) {
  if (!Array.isArray(list)) throw new Error('At least one interchange area is required');
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

// Liang-Barsky：只要线段穿过矩形就选中，避免洞身两端都在范围外时被漏掉。
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

// 规范化到「从字典序较小的一端走」，同一段洞身无论 OSM 方向都只建一次。
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
      stations.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: distance + length * t });
    }
    distance += length;
  }
  return distance > EPSILON ? stations : [];
}

function emptyBucket() {
  return { positions: [], colors: [], triangles: [] };
}

function crossNormal(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  return { x: uy * vz - uz * vy, y: uz * vx - ux * vz, z: ux * vy - uy * vx };
}

function pushTriangle(bucket, a, b, c, color) {
  const normal = crossNormal(a, b, c);
  if (Math.hypot(normal.x, normal.y, normal.z) < EPSILON) return;
  bucket.triangles.push([a, b, c]);
  bucket.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  bucket.colors.push(color[0], color[1], color[2], color[0], color[1], color[2], color[0], color[1], color[2]);
}

// 朝向由期望法线决定：同一批顶点按需要的朝向摆好绕序，显示和接触三角面不会因绕序不同而分叉。
function pushQuad(bucket, a, b, c, d, desired, color) {
  const normal = crossNormal(a, b, c);
  if (normal.x * desired.x + normal.y * desired.y + normal.z * desired.z < 0) {
    pushTriangle(bucket, a, d, c, color);
    pushTriangle(bucket, a, c, b, color);
    return;
  }
  pushTriangle(bucket, a, b, c, color);
  pushTriangle(bucket, a, c, d, color);
}

function mergeBuckets(buckets) {
  const positions = [];
  const colors = [];
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.positions.length; i++) positions.push(bucket.positions[i]);
    for (let i = 0; i < bucket.colors.length; i++) colors.push(bucket.colors[i]);
  }
  return { positions, colors };
}

// 洞口框：门柱和门楣都朝洞外，中间留出洞身断面，不用一块封板把洞口堵死。
function pushPortal(bucket, frame, outward, color) {
  const { left, right, floorY, ceilingY } = frame;
  const outerLeft = { x: left.x + frame.nx * PORTAL_FRAME_M, z: left.z + frame.nz * PORTAL_FRAME_M };
  const outerRight = { x: right.x - frame.nx * PORTAL_FRAME_M, z: right.z - frame.nz * PORTAL_FRAME_M };
  const desired = { x: outward.x, y: 0, z: outward.z };
  const beamY = ceilingY + PORTAL_FRAME_M;
  const leftBottom = { x: left.x, y: floorY, z: left.z };
  const leftTop = { x: left.x, y: ceilingY, z: left.z };
  const leftBeam = { x: left.x, y: beamY, z: left.z };
  const outerLeftBottom = { x: outerLeft.x, y: floorY, z: outerLeft.z };
  const outerLeftBeam = { x: outerLeft.x, y: beamY, z: outerLeft.z };
  const rightBottom = { x: right.x, y: floorY, z: right.z };
  const rightTop = { x: right.x, y: ceilingY, z: right.z };
  const rightBeam = { x: right.x, y: beamY, z: right.z };
  const outerRightBottom = { x: outerRight.x, y: floorY, z: outerRight.z };
  const outerRightBeam = { x: outerRight.x, y: beamY, z: outerRight.z };
  pushQuad(bucket, leftBottom, outerLeftBottom, outerLeftBeam, leftBeam, desired, color);
  pushQuad(bucket, rightBottom, outerRightBottom, outerRightBeam, rightBeam, desired, color);
  pushQuad(bucket, leftTop, leftBeam, rightBeam, rightTop, desired, color);
}

// 洞壁碰撞用逐段薄条：polygon 沿同一批洞壁顶点向内给一个厚度，minY/maxY 取该段实际洞底/洞顶。
function wallCollider(frameA, frameB, side) {
  const edgeA = side === 'left' ? frameA.left : frameA.right;
  const edgeB = side === 'left' ? frameB.left : frameB.right;
  const direction = side === 'left' ? 1 : -1;
  const outerA = { x: edgeA.x + frameA.nx * WALL_THICKNESS_M * direction,
    z: edgeA.z + frameA.nz * WALL_THICKNESS_M * direction };
  const outerB = { x: edgeB.x + frameB.nx * WALL_THICKNESS_M * direction,
    z: edgeB.z + frameB.nz * WALL_THICKNESS_M * direction };
  const outer = [{ x: edgeA.x, z: edgeA.z }, { x: edgeB.x, z: edgeB.z },
    { x: outerB.x, z: outerB.z }, { x: outerA.x, z: outerA.z }];
  return {
    type: 'tunnel-wall',
    polygon: { outer, holes: [] },
    minX: Math.min(...outer.map(point => point.x)),
    maxX: Math.max(...outer.map(point => point.x)),
    minZ: Math.min(...outer.map(point => point.z)),
    maxZ: Math.max(...outer.map(point => point.z)),
    minY: Math.min(frameA.floorY, frameB.floorY),
    maxY: Math.max(frameA.ceilingY, frameB.ceilingY),
    verticalSpan: [frameA.floorY, frameB.floorY, frameA.ceilingY, frameB.ceilingY]
  };
}

// 地形缺失站按最近有效站在段内线性补齐；整条都缺地形时返回 null。
function resolveStationGrounds(stations, groundHeight) {
  const grounds = stations.map(station => groundHeight(station.x, station.z));
  let firstValid = -1;
  let lastValid = -1;
  for (let i = 0; i < grounds.length; i++) {
    if (!Number.isFinite(grounds[i])) continue;
    if (firstValid < 0) firstValid = i;
    lastValid = i;
  }
  if (firstValid < 0) return null;
  const resolved = grounds.slice();
  for (let i = 0; i < firstValid; i++) resolved[i] = grounds[firstValid];
  for (let i = lastValid + 1; i < grounds.length; i++) resolved[i] = grounds[lastValid];
  let previous = firstValid;
  for (let i = firstValid + 1; i <= lastValid; i++) {
    if (!Number.isFinite(grounds[i])) continue;
    for (let j = previous + 1; j < i; j++) {
      resolved[j] = grounds[previous] + (grounds[i] - grounds[previous]) * ((j - previous) / (i - previous));
    }
    previous = i;
  }
  return resolved;
}

// 解析：单条 OSM 隧道链路 → 洞身三角面（洞底可站立面、洞壁、洞顶、洞口框）与洞壁碰撞。
// 埋深 = |layer| × 6 m；共享地面的洞口落在地形高程上，向内 12 m 线性下到估算埋深。
// 输出记录字段：index/osmId/name/layer/lengthM/depthM/frames/floorTriangles/wallTriangles/
// ceilingTriangles/portalTriangles/portalCount/geometry/colors/colliders/surfaceId/drivable。
function planTunnel(graph, link, index, metadata, interchangeIds, groundHeight, groundNodes) {
  const points = roadLinkPoints(graph, link);
  const lengthM = polylineLength(points);
  const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
  const depthM = TUNNEL_LAYER_DEPTH_M * Math.abs(layer);
  const startNode = link[0];
  const endNode = link[1];
  const sharedStart = groundNodes.has(startNode);
  const sharedEnd = groundNodes.has(endNode);
  const width = Math.max(link[3], TUNNEL_MIN_WIDTH_M);
  const record = {
    index,
    osmId: metadata.osmId ?? null,
    name: graph.names[link[2]] ?? '',
    width,
    lanes: link[4],
    direction: link[5],
    layer,
    depthM,
    lengthM,
    drivable: false,
    startNode,
    endNode,
    sharedStart,
    sharedEnd,
    startGroundHeight: null,
    endGroundHeight: null,
    startFloorY: null,
    endFloorY: null,
    portalStart: false,
    portalEnd: false,
    portalCount: 0,
    interchangeIds,
    points,
    frames: [],
    floorTriangles: [],
    wallTriangles: [],
    ceilingTriangles: [],
    portalTriangles: [],
    geometry: [],
    colors: [],
    colliders: [],
    surfaceId: `sz-tunnel:${index}`
  };
  // layer 为 0 时没有上下关系，无法估算埋深；只登记来源记录，不生成洞身。
  if (depthM <= 0 || !(lengthM > EPSILON)) return record;
  const stations = resample(points, TUNNEL_STEP_M);
  if (stations.length < 2) return record;
  // 构建期裁地形会在洞口走廊删掉地形三角面，审核与单测读的是裁过地形的包：
  // 洞口几站按最近有效站补齐，整条都缺地形时才跳过洞身。
  const grounds = resolveStationGrounds(stations, groundHeight);
  if (!grounds) return record;
  const withGround = stations.map((station, index) => ({ ...station, groundY: grounds[index] }));
  const half = width / 2;
  const frames = withGround.map((station, frameIndex) => {
    const previous = withGround[Math.max(0, frameIndex - 1)];
    const next = withGround[Math.min(withGround.length - 1, frameIndex + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const frameLength = Math.hypot(dx, dz) || 1;
    // 左侧法线和 sz-elevated-roads.js 同一约定：nx=dz/len、nz=-dx/len。
    const nx = dz / frameLength;
    const nz = -dx / frameLength;
    const startSink = sharedStart ? clamp01(station.d / PORTAL_TRANSITION_M) : 1;
    const endSink = sharedEnd ? clamp01((lengthM - station.d) / PORTAL_TRANSITION_M) : 1;
    const floorY = station.groundY - depthM * Math.min(startSink, endSink);
    return {
      x: station.x, z: station.z, d: station.d, groundY: station.groundY,
      floorY, ceilingY: floorY + TUNNEL_BORE_HEIGHT_M, nx, nz,
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half }
    };
  });
  const floorBucket = emptyBucket();
  const wallBucket = emptyBucket();
  const ceilingBucket = emptyBucket();
  const portalBucket = emptyBucket();
  const colliders = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const floorLeftA = { x: a.left.x, y: a.floorY, z: a.left.z };
    const floorLeftB = { x: b.left.x, y: b.floorY, z: b.left.z };
    const floorRightA = { x: a.right.x, y: a.floorY, z: a.right.z };
    const floorRightB = { x: b.right.x, y: b.floorY, z: b.right.z };
    const ceilingLeftA = { x: a.left.x, y: a.ceilingY, z: a.left.z };
    const ceilingLeftB = { x: b.left.x, y: b.ceilingY, z: b.left.z };
    const ceilingRightA = { x: a.right.x, y: a.ceilingY, z: a.right.z };
    const ceilingRightB = { x: b.right.x, y: b.ceilingY, z: b.right.z };
    pushQuad(floorBucket, floorLeftA, floorRightA, floorRightB, floorLeftB, UP, FLOOR_COLOR);
    pushQuad(ceilingBucket, ceilingLeftA, ceilingLeftB, ceilingRightB, ceilingRightA, DOWN, CEILING_COLOR);
    const inwardLeft = { x: -(a.nx + b.nx), y: 0, z: -(a.nz + b.nz) };
    const inwardRight = { x: a.nx + b.nx, y: 0, z: a.nz + b.nz };
    pushQuad(wallBucket, floorLeftA, floorLeftB, ceilingLeftB, ceilingLeftA, inwardLeft, WALL_COLOR);
    pushQuad(wallBucket, floorRightA, floorRightB, ceilingRightB, ceilingRightA, inwardRight, WALL_COLOR);
    colliders.push(wallCollider(a, b, 'left'), wallCollider(a, b, 'right'));
  }
  if (sharedStart) pushPortal(portalBucket, frames[0], { x: frames[0].nz, z: -frames[0].nx }, PORTAL_COLOR);
  if (sharedEnd) {
    const last = frames[frames.length - 1];
    pushPortal(portalBucket, last, { x: -last.nz, z: last.nx }, PORTAL_COLOR);
  }
  const merged = mergeBuckets([floorBucket, wallBucket, ceilingBucket, portalBucket]);
  const portalCount = (sharedStart ? 1 : 0) + (sharedEnd ? 1 : 0);
  const gradeProfile = measureRoadProfile(createRoadProfile(), frames, () => 'bore');
  recordTunnelTerrainSeams(gradeProfile, frames, startNode, endNode, sharedStart, sharedEnd, groundHeight);
  return {
    ...record,
    drivable: portalCount > 0,
    startGroundHeight: frames[0].groundY,
    endGroundHeight: frames[frames.length - 1].groundY,
    startFloorY: frames[0].floorY,
    endFloorY: frames[frames.length - 1].floorY,
    portalStart: sharedStart,
    portalEnd: sharedEnd,
    portalCount,
    frames,
    gradeProfile,
    floorTriangles: floorBucket.triangles,
    wallTriangles: wallBucket.triangles,
    ceilingTriangles: ceilingBucket.triangles,
    portalTriangles: portalBucket.triangles,
    geometry: merged.positions,
    colors: merged.colors,
    colliders
  };
}

function buildingBounds(building) {
  const provided = { minX: building?.minX, maxX: building?.maxX, minZ: building?.minZ, maxZ: building?.maxZ };
  if (Object.values(provided).every(Number.isFinite) && provided.minX < provided.maxX && provided.minZ < provided.maxZ) {
    return provided;
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const polygon of building?.polygons ?? []) {
    for (const point of polygon?.outer ?? []) {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) continue;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

function prepareBuildings(buildings) {
  if (!Array.isArray(buildings)) throw new Error('Buildings must be an array');
  const prepared = [];
  for (const building of buildings) {
    if (!building || !Array.isArray(building.polygons)) continue;
    const polygons = building.polygons.filter(polygon => Array.isArray(polygon?.outer) && polygon.outer.length >= 3
      && polygon.outer.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.z)));
    if (polygons.length === 0) continue;
    const bounds = buildingBounds({ ...building, polygons });
    if (bounds) prepared.push({ ...bounds, polygons });
  }
  return prepared;
}

// 沿中心线按 4 m 步长找第一个同时落在选区内和建筑轮廓内的点；只报告，不改道路也不挖洞。
function firstBuildingCrossing(points, areaEntries) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < EPSILON) continue;
    const steps = Math.max(1, Math.ceil(length / REVIEW_STEP_M));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      for (const { area, buildings } of areaEntries) {
        if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) continue;
        for (const building of buildings) {
          if (x < building.minX || x > building.maxX || z < building.minZ || z > building.maxZ) continue;
          for (const polygon of building.polygons) {
            if (polygonContains(polygon, x, z)) return { x, z };
          }
        }
      }
    }
  }
  return null;
}

// 评审清单：选区内没有 bridge/tunnel/layer 来源的地面道路，中心线穿楼就记一条，不生成隧道。
function planReviewList(graph, areas, buildings) {
  if (!Array.isArray(buildings)) throw new Error('Buildings must be an array');
  if (areas.length === 0 || buildings.length === 0) return [];
  // 每个选区先按包围盒从全城建筑里筛候选，再整理候选轮廓；避免逐个整理 3 万多个建筑。
  const areaEntries = [];
  for (const area of areas) {
    const candidates = buildings.filter(building => {
      const bounds = [building?.minX, building?.maxX, building?.minZ, building?.maxZ];
      if (!bounds.every(Number.isFinite)) return true;
      return building.maxX >= area.minX && building.minX <= area.maxX
        && building.maxZ >= area.minZ && building.minZ <= area.maxZ;
    });
    const prepared = prepareBuildings(candidates);
    if (prepared.length > 0) areaEntries.push({ area, buildings: prepared });
  }
  if (areaEntries.length === 0) return [];
  const reviewList = [];
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    const link = graph.links[index];
    const points = roadLinkPoints(graph, link);
    const hits = areaEntries.filter(entry => polylineIntersectsArea(points, entry.area));
    if (hits.length === 0) continue;
    const crossing = firstBuildingCrossing(points, hits);
    if (!crossing) continue;
    reviewList.push({
      osmId: metadata.osmId ?? null,
      name: graph.names[link[2]] ?? '',
      reason: REVIEW_REASON,
      x: crossing.x,
      z: crossing.z
    });
  }
  return reviewList;
}

function buildChunks(records) {
  const built = records.filter(record => record.geometry.length > 0);
  if (built.length === 0) return [];
  const count = Math.min(MAX_CHUNKS, built.length);
  const ordered = [...built].sort((a, b) => {
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
    for (const record of bucket) {
      for (const point of record.points) {
        minX = Math.min(minX, point.x);
        minZ = Math.min(minZ, point.z);
      }
    }
    const origin = [minX, minZ];
    const positions = [];
    const colors = [];
    for (const record of bucket) {
      for (let i = 0; i < record.geometry.length; i += 3) {
        positions.push(record.geometry[i] - origin[0], record.geometry[i + 1], record.geometry[i + 2] - origin[1]);
      }
      for (let i = 0; i < record.colors.length; i++) colors.push(record.colors[i]);
    }
    return {
      id: `shenzhen-tunnels:${chunkIndex}`,
      origin,
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      tunnelIndices: bucket.map(record => record.index).sort((a, b) => a - b),
      triangles: bucket.reduce((sum, record) => sum + record.geometry.length / 9, 0)
    };
  });
}

// ---------------------------------------------------------------------------
// 全城通用隧道（docs/36）：路面高程取两端洞口地形高程的线性连线，洞内不抬升、不下挖；
// 只有「地形 - 路面 > 0.6 m」的洞身段才建顶板、侧墙、洞门和灯带，平地与下穿段只登记
// 通行面。旧立交分区模式保留在上面，供离线审核与既有单测使用；options.wholeCity 为
// true 时走这一套全城规则。
// ---------------------------------------------------------------------------

export const TUNNEL_CLEARANCE_M = 5.2;
export const TUNNEL_MIN_WIDE_WIDTH_M = 9;
export const TUNNEL_BORE_MIN_DEPTH_M = 0.6;
export const TUNNEL_OPEN_MIN_DEPTH_M = 0.05;
export const TUNNEL_OPEN_MAX_DEPTH_M = 5.6;
export const TUNNEL_LIGHT_SPACING_M = 12;
export const TUNNEL_PORTAL_THICKNESS_M = 0.8;
export const TUNNEL_PORTAL_WING_M = 1.2;
export const TUNNEL_PORTAL_RISE_M = 0.9;
export const TUNNEL_DRIVE_MAX_GRADE = 0.12;
// 洞内相邻段共享节点处的竖直容差（与高架 ELEVATED_HEIGHT_TOLERANCE 同口径）。
const TUNNEL_JOIN_TOLERANCE_M = 0.35;
const TUNNEL_GRID_M = 2000;

function recordTunnelTerrainSeams(profile, frames, startNode, endNode, sharedStart, sharedEnd, groundHeight) {
  for (const [side, frame, node, shared] of [
    ['start', frames[0], startNode, sharedStart], ['end', frames.at(-1), endNode, sharedEnd]
  ]) {
    if (!shared) continue;
    recordRoadProfileSeam(profile, {
      side, kind: 'terrain', node, atM: frame.d, fromY: frame.floorY, toY: groundHeight(frame.x, frame.z)
    }, TUNNEL_JOIN_TOLERANCE_M);
  }
}

// 顶点色：路面沥青、结构与洞门混凝土、灯带接近纯白（0xf4f8ff）。
const CITY_ASPHALT_COLOR = [0.2, 0.21, 0.215];
const CITY_CONCRETE_COLOR = [0.66, 0.68, 0.67];
const CITY_LIGHT_COLOR = [244 / 255, 248 / 255, 1];

const CITY_LIMITATIONS = [
  '隧道纵断面按 sink 口径估算：共享地面端 12 m 内由地面压到洞底，洞内不再抬升，没有实测设计标高或纵坡资料。',
  '洞身净空 5.2 m、洞宽不小于 9 m 均为估算值，不是设计图尺寸。',
  '只有覆盖高差 > 5.6 m 的洞身段生成顶板、侧墙、洞门和灯带；覆盖不足与平地立交下穿段只登记通行面。',
  '洞口开敞段按“地形 - 路面 ∈ (0.05, 5.6)”识别，构建期裁地形由 tools/sz/tunnel_portals.py 负责。',
  '灯带每 12 m 一条，位置落在 4 m 采样站上，实际间距不超过 12 m。',
  '洞顶只登记 slab 碰撞体，洞内不填满；洞壁碰撞来自同一批墙体顶点。',
  '可车行只检查净空与纵坡，未核验限高标志、运营状态和实际交通组织。'
];

function cityTriangle(list, a, b, c) {
  const normal = crossNormal(a, b, c);
  if (Math.hypot(normal.x, normal.y, normal.z) < EPSILON) return;
  list.push([a, b, c]);
}

function cityQuad(list, a, b, c, d, desired) {
  const normal = crossNormal(a, b, c);
  if (normal.x * desired.x + normal.y * desired.y + normal.z * desired.z < 0) {
    cityTriangle(list, a, d, c);
    cityTriangle(list, a, c, b);
    return;
  }
  cityTriangle(list, a, b, c);
  cityTriangle(list, a, c, d);
}

// 左右侧法线与 sz-elevated-roads.js 同约定：nx = dz / len、nz = -dx / len。
function tunnelFrameDirection(stations, frameIndex) {
  const previous = stations[Math.max(0, frameIndex - 1)];
  const next = stations[Math.min(stations.length - 1, frameIndex + 1)];
  const dx = next.x - previous.x;
  const dz = next.z - previous.z;
  const length = Math.hypot(dx, dz) || 1;
  return { nx: dz / length, nz: -dx / length };
}

function tunnelFrameAt(frames, distance) {
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (distance <= b.d + EPSILON) {
      const t = b.d - a.d > EPSILON ? Math.max(0, Math.min(1, (distance - a.d) / (b.d - a.d))) : 0;
      const nx = a.nx + (b.nx - a.nx) * t;
      const nz = a.nz + (b.nz - a.nz) * t;
      const length = Math.hypot(nx, nz) || 1;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        d: distance,
        floorY: a.floorY + (b.floorY - a.floorY) * t,
        ceilingY: a.floorY + (b.floorY - a.floorY) * t + TUNNEL_CLEARANCE_M,
        nx: nx / length,
        nz: nz / length
      };
    }
  }
  return frames[frames.length - 1];
}

// 洞门：0.8 m 厚、比洞宽每侧外扩 1.2 m、总高 5.2 + 0.9 m 的门形框，洞口断面保持开敞。
function tunnelPortalBox(list, frame, n0, n1, y0, y1) {
  const t = { x: -frame.nz, z: frame.nx };
  const n = { x: frame.nx, z: frame.nz };
  const axial = TUNNEL_PORTAL_THICKNESS_M / 2;
  const at = (alongN, alongT, y) => ({
    x: frame.x + n.x * alongN + t.x * alongT,
    y,
    z: frame.z + n.z * alongN + t.z * alongT
  });
  const plusT = { x: t.x, y: 0, z: t.z };
  const minusT = { x: -t.x, y: 0, z: -t.z };
  const plusN = { x: n.x, y: 0, z: n.z };
  const minusN = { x: -n.x, y: 0, z: -n.z };
  cityQuad(list, at(n0, axial, y0), at(n1, axial, y0), at(n1, axial, y1), at(n0, axial, y1), plusT);
  cityQuad(list, at(n0, -axial, y0), at(n1, -axial, y0), at(n1, -axial, y1), at(n0, -axial, y1), minusT);
  cityQuad(list, at(n1, -axial, y0), at(n1, axial, y0), at(n1, axial, y1), at(n1, -axial, y1), plusN);
  cityQuad(list, at(n0, -axial, y0), at(n0, axial, y0), at(n0, axial, y1), at(n0, -axial, y1), minusN);
  cityQuad(list, at(n0, -axial, y1), at(n0, axial, y1), at(n1, axial, y1), at(n1, -axial, y1), UP);
  cityQuad(list, at(n0, -axial, y0), at(n0, axial, y0), at(n1, axial, y0), at(n1, -axial, y0), DOWN);
}

function tunnelPortal(list, frame, flow, width, baseHeight) {
  const half = width / 2;
  const outer = half + TUNNEL_PORTAL_WING_M;
  const floorY = frame.floorY;
  const ceilingY = floorY + TUNNEL_CLEARANCE_M;
  const topY = ceilingY + TUNNEL_PORTAL_RISE_M;
  // 门柱贴着洞宽外侧加宽，门楣从洞顶盖到 5.2 + 0.9 m；flow 只记录朝向，几何本身对称。
  tunnelPortalBox(list, frame, half, outer, floorY, topY);
  tunnelPortalBox(list, frame, -outer, -half, floorY, topY);
  tunnelPortalBox(list, frame, -outer, outer, ceilingY, topY);
  if (baseHeight) {
    // 补上洞门背后的覆土切面，沿原地形取高，洞门净空保持不变。
    const outward = { x: -frame.nz * flow, y: 0, z: frame.nx * flow };
    const edge = [-outer, -half / 2, 0, half / 2, outer].map(offset => {
      const x = frame.x + frame.nx * offset - outward.x * 0.15;
      const z = frame.z + frame.nz * offset - outward.z * 0.15;
      return { x, z, y: Math.max(topY, (baseHeight(x, z) ?? topY) + 0.05) };
    });
    for (let i = 1; i < edge.length; i++) {
      const a = edge[i - 1], b = edge[i];
      cityQuad(list, { ...a, y: topY }, { ...b, y: topY }, b, a, outward);
    }
  }
  return { x: frame.x, z: frame.z, y: floorY, ceilingY, topY,
    nx: frame.nx, nz: frame.nz, flow };
}

function tunnelSlabCollider(a, b) {
  // 按两站实际洞顶裁碰撞范围，避免上坡端的顶高延伸到低端路面上。
  const topA = a.ceilingY + 0.4;
  const topB = b.ceilingY + 0.4;
  const polygon = { outer: [
    { x: a.left.x, z: a.left.z }, { x: b.left.x, z: b.left.z },
    { x: b.right.x, z: b.right.z }, { x: a.right.x, z: a.right.z }
  ], holes: [] };
  return {
    type: 'tunnel-slab',
    name: 'tunnel-slab:' + a.d.toFixed(1),
    polygon,
    minX: Math.min(a.left.x, a.right.x, b.left.x, b.right.x),
    maxX: Math.max(a.left.x, a.right.x, b.left.x, b.right.x),
    minZ: Math.min(a.left.z, a.right.z, b.left.z, b.right.z),
    maxZ: Math.max(a.left.z, a.right.z, b.left.z, b.right.z),
    minY: Math.min(a.ceilingY, b.ceilingY),
    maxY: Math.max(topA, topB),
    verticalSpan: [a.ceilingY, b.ceilingY, topA, topB]
  };
}

// 单条 OSM 隧道链路：纵断面走 sink 口径（共享地面端 12 m 由地面压到洞底，洞内不抬升），
// 洞身段按地形与路面的覆盖高差派生，与构建期裁地形（cover 0.05–5.6 m）互补。
function planCityTunnel(graph, link, index, metadata, groundHeight, groundNodes, profile, deckPortals) {
  const points = roadLinkPoints(graph, link);
  const lengthM = polylineLength(points);
  const sourceWidth = Number.isFinite(link[3]) ? link[3] : 0;
  const fixedFloor = Number.isFinite(metadata.nanpingDeckY);
  const mountain = metadata.mountainTunnel;
  const width = mountain?.width ?? (fixedFloor ? deckLaneProfile(link).widthM : Math.max(sourceWidth, TUNNEL_MIN_WIDE_WIDTH_M));
  const startNode = link[0];
  const endNode = link[1];
  const record = {
    index,
    osmId: metadata.osmId ?? null,
    name: graph.names[link[2]] ?? '',
    width,
    lanes: link[4],
    direction: link[5],
    layer: Number.isFinite(metadata.layer) ? metadata.layer : 0,
    lengthM,
    tunnel: true,
    heightSource: 'estimate',
    mountainPavement: Boolean(mountain),
    drivable: false,
    blockedReason: null,
    startNode,
    endNode,
    sharedStart: (!fixedFloor && groundNodes.has(startNode)) || deckPortals?.has(startNode) === true,
    sharedEnd: (!fixedFloor && groundNodes.has(endNode)) || deckPortals?.has(endNode) === true,
    startGroundHeight: null,
    endGroundHeight: null,
    startDeckY: null,
    endDeckY: null,
    maxGrade: 0,
    gradeProfile: createRoadProfile(),
    clearanceM: TUNNEL_CLEARANCE_M,
    points,
    frames: [],
    topTriangles: [],
    pavementTriangles: [],
    chunkTriangles: { asphalt: [], concrete: [], light: [] },
    portalSpans: [],
    portals: [],
    portalCount: 0,
    boreLengthM: 0,
    structureNeighbors: [],
    colliders: [],
    surfaceId: 'sz-tunnel:' + index
  };
  if (points.length < 2 || !(lengthM > EPSILON)) return record;
  // 双幅洞口接入构建期估计工程面，在同一洞顶边界插入断面，避免用四米站距近似洞口。
  const profilePoints = profile ? points.flatMap((point, i) => {
    const next = points[i + 1];
    if (!next) return [point];
    const splits = [profile.northPortalZ, profile.southPortalZ]
      .map(z => ({ z, t: (z - point.z) / (next.z - point.z) }))
      .filter(({ t }) => t > EPSILON && t < 1 - EPSILON).sort((a, b) => a.t - b.t);
    return [point, ...splits.map(({ z, t }) => ({ z, x: point.x + (next.x - point.x) * t }))];
  }) : points;
  const stations = resample(profilePoints, TUNNEL_STEP_M);
  if (stations.length < 2) return record;
  const grounds = stations.map(station => groundHeight(station.x, station.z));
  let firstValid = -1;
  let lastValid = -1;
  for (let i = 0; i < grounds.length; i++) {
    if (!Number.isFinite(grounds[i])) continue;
    if (firstValid < 0) firstValid = i;
    lastValid = i;
  }
  // 地形缺失的站用最近有效站兜底（段内线性插值），不再因个别站缺地形整条跳过。
  if (firstValid < 0 && !fixedFloor && !mountain) {
    record.blockedReason = 'terrain';
    return record;
  }
  const resolved = grounds.slice();
  if (firstValid < 0) {
    resolved.fill(mountain?.startY ?? metadata.nanpingDeckY);
  } else {
    for (let i = 0; i < firstValid; i++) resolved[i] = grounds[firstValid];
    for (let i = lastValid + 1; i < grounds.length; i++) resolved[i] = grounds[lastValid];
    let previous = firstValid;
    for (let i = firstValid + 1; i <= lastValid; i++) {
      if (!Number.isFinite(grounds[i])) continue;
      for (let j = previous + 1; j < i; j++) {
        const t = (j - previous) / (i - previous);
        resolved[j] = grounds[previous] + (grounds[i] - grounds[previous]) * t;
      }
      previous = i;
    }
  }
  const startGround = resolved[0];
  const endGround = resolved[resolved.length - 1];
  const depthM = profile ? profile.datumM - profile.boreFloorM : TUNNEL_LAYER_DEPTH_M * Math.abs(record.layer);
  const half = width / 2;
  const approachLength = deckPortals ? HIGH_DECK_TUNNEL_APPROACH_M : PORTAL_TRANSITION_M;
  const frames = stations.map((station, frameIndex) => {
    const { nx, nz } = tunnelFrameDirection(stations, frameIndex);
    // 两侧从接点标高压到洞底，与构建期洞口长度一致。
    const startSink = record.sharedStart ? clamp01(station.d / approachLength) : 1;
    const endSink = record.sharedEnd ? clamp01((lengthM - station.d) / approachLength) : 1;
    const sink = Math.min(startSink, endSink);
    // 紫众道从京港澳两幅斜坡下穿。洞身留 0.3 m 覆土余量，洞口过渡和源路接点保持原高程。
    const coverAllowance = metadata.osmId === 'way/1083453776' ? 0.3 * clamp01(
      (Math.min(station.d, lengthM - station.d) - PORTAL_TRANSITION_M) / PORTAL_TRANSITION_M
    ) : 0;
    const t = station.d / lengthM;
    const blend = mountain?.bore ? t : t * t * (3 - 2 * t);
    const floorY = mountain ? mountain.startY + (mountain.endY - mountain.startY) * blend
      : fixedFloor ? metadata.nanpingDeckY : profile ? profile.boreFloorM
      + profile.approachGrade * Math.max(0, profile.northPortalZ - station.z, station.z - profile.southPortalZ)
      : resolved[frameIndex] - depthM * sink - coverAllowance;
    const groundY = Number.isFinite(grounds[frameIndex]) ? grounds[frameIndex] : null;
    return {
      x: station.x, z: station.z, d: station.d,
      groundY, floorY, ceilingY: floorY + TUNNEL_CLEARANCE_M,
      sink: fixedFloor ? 1 : profile ? (profile.datumM - floorY) / depthM : sink,
      sep: resolved[frameIndex] - floorY,
      nx, nz,
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half }
    };
  });
  record.frames = frames;
  record.depthM = depthM;
  record.startGroundHeight = startGround;
  record.endGroundHeight = endGround;
  record.startDeckY = frames[0].floorY;
  record.endDeckY = frames[frames.length - 1].floorY;
  // 路面顶面同时是通行面：整条链路（含开敞段和洞身段）都推顶面三角面。
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const leftA = { x: a.left.x, y: a.floorY, z: a.left.z };
    const rightA = { x: a.right.x, y: a.floorY, z: a.right.z };
    const leftB = { x: b.left.x, y: b.floorY, z: b.left.z };
    const rightB = { x: b.right.x, y: b.floorY, z: b.right.z };
    record.topTriangles.push([leftA, rightA, rightB], [leftA, rightB, leftB]);
    record.pavementTriangles.push([leftA, rightA, rightB], [leftA, rightB, leftB]);
  }
  // 地面引道和洞口的端断面法线可能不同，按同一纵坡外推短搭接，补齐两条斜边之间的缺口。
  if (profile || mountain) {
    for (const [shared, portal, inner] of [[record.sharedStart, frames[0], frames[1]],
      [record.sharedEnd, frames.at(-1), frames.at(-2)]]) {
      if (!shared) continue;
      const scale = (mountain ? 1 : 4) / Math.hypot(portal.x - inner.x, portal.z - inner.z);
      const dx = (portal.x - inner.x) * scale;
      const dz = (portal.z - inner.z) * scale;
      const y = portal.floorY + (portal.floorY - inner.floorY) * scale;
      const left = { ...portal.left, y: portal.floorY };
      const right = { ...portal.right, y: portal.floorY };
      const outsideLeft = { x: left.x + dx, y, z: left.z + dz };
      const outsideRight = { x: right.x + dx, y, z: right.z + dz };
      const strips = portal === frames[0]
        ? [[outsideLeft, outsideRight, right], [outsideLeft, right, left]]
        : [[left, right, outsideRight], [left, outsideRight, outsideLeft]];
      record.pavementTriangles.push(...strips);
    }
  }
  // 洞身段：相邻两站覆盖高差中点为「地形 - 路面 > 5.6 m」的区间；以上开敞引道只铺路面。
  const bore = [];
  for (let i = 1; i < frames.length; i++) {
    if (fixedFloor || mountain) {
      const mid = (frames[i - 1].d + frames[i].d) / 2;
      bore.push(!mountain || (mountain.bore && mid >= (mountain.openStartM ?? 0)
        && mid <= lengthM - (mountain.openEndM ?? 0)));
      continue;
    }
    if (profile) {
      const midZ = (frames[i - 1].z + frames[i].z) / 2;
      bore.push(midZ >= profile.northPortalZ && midZ <= profile.southPortalZ);
      continue;
    }
    const a = frames[i - 1].sep;
    const b = frames[i].sep;
    if (a === null || b === null) { bore.push(false); continue; }
    bore.push((a + b) / 2 > TUNNEL_OPEN_MAX_DEPTH_M);
  }
  measureRoadProfile(record.gradeProfile, frames, i => bore[i] ? 'bore' : 'approach');
  recordTunnelTerrainSeams(record.gradeProfile, frames, startNode, endNode,
    !fixedFloor && record.sharedStart && !mountain?.deckPortals?.some(([node]) => node === startNode),
    !fixedFloor && record.sharedEnd && !mountain?.deckPortals?.some(([node]) => node === endNode), groundHeight);
  for (let i = 1; i < bore.length; i++) {
    if (bore[i - 1] === bore[i]) continue;
    const frame = frames[i];
    // 开敞段和洞身使用同一站的路面，分界处没有另造搭接面或虚拟坡长。
    recordRoadProfileSeam(record.gradeProfile, {
      kind: bore[i] ? 'approach-to-bore' : 'bore-to-approach',
      atM: frame.d, fromY: frame.floorY, toY: frame.floorY
    }, TUNNEL_JOIN_TOLERANCE_M);
  }
  const runs = [];
  for (let i = 0; i < bore.length; i++) {
    if (!bore[i]) continue;
    if (i === 0 || !bore[i - 1]) runs.push({ firstInterval: i, lastInterval: i });
    else runs[runs.length - 1].lastInterval = i;
  }
  // 既有车行判定保留洞内口径。全断面审计另外计入与裁地形绑定的洞口压深。
  record.maxGrade = 0;
  for (const run of runs) {
    for (let i = run.firstInterval + 1; i <= run.lastInterval + 1; i++) {
      if (frames[i].sink < 1 - EPSILON || frames[i - 1].sink < 1 - EPSILON) continue;
      const step = frames[i].d - frames[i - 1].d;
      if (step <= EPSILON) continue;
      record.maxGrade = Math.max(record.maxGrade, Math.abs(frames[i].floorY - frames[i - 1].floorY) / step);
    }
  }
  const light = record.chunkTriangles.light;
  const concrete = record.chunkTriangles.concrete;
  const asphalt = record.chunkTriangles.asphalt;
  const colliders = record.colliders;
  if (mountain?.baseHeight) {
    for (let i = 1; i < frames.length; i++) {
      if (bore[i - 1]) continue;
      const a = frames[i - 1], b = frames[i];
      for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const topAt = frame => Math.max(frame.floorY, mountain.baseHeight(
          frame[side].x + frame.nx * sign * WALL_THICKNESS_M,
          frame[side].z + frame.nz * sign * WALL_THICKNESS_M) ?? frame.floorY);
        const yA = topAt(a), yB = topAt(b);
        if (Math.max(yA - a.floorY, yB - b.floorY) < 0.04) continue;
        cityQuad(concrete, { ...a[side], y: a.floorY }, { ...b[side], y: b.floorY },
          { ...b[side], y: yB }, { ...a[side], y: yA },
          { x: -sign * (a.nx + b.nx), y: 0, z: -sign * (a.nz + b.nz) });
        colliders.push(wallCollider({ ...a, ceilingY: yA }, { ...b, ceilingY: yB }, side));
      }
    }
  }
  for (const run of runs) {
    const firstStation = run.firstInterval;
    const lastStation = run.lastInterval + 1;
    const runStartM = frames[firstStation].d;
    const runEndM = frames[lastStation].d;
    record.portalSpans.push({ fromM: runStartM, toM: runEndM, lengthM: runEndM - runStartM });
    record.boreLengthM += runEndM - runStartM;
    for (let i = run.firstInterval + 1; i <= run.lastInterval + 1; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      const leftA = { x: a.left.x, y: a.floorY, z: a.left.z };
      const rightA = { x: a.right.x, y: a.floorY, z: a.right.z };
      const leftB = { x: b.left.x, y: b.floorY, z: b.left.z };
      const rightB = { x: b.right.x, y: b.floorY, z: b.right.z };
      const ceilingLeftA = { x: a.left.x, y: a.ceilingY, z: a.left.z };
      const ceilingLeftB = { x: b.left.x, y: b.ceilingY, z: b.left.z };
      const ceilingRightA = { x: a.right.x, y: a.ceilingY, z: a.right.z };
      const ceilingRightB = { x: b.right.x, y: b.ceilingY, z: b.right.z };
      cityQuad(concrete, ceilingLeftA, ceilingLeftB, ceilingRightB, ceilingRightA, DOWN);
      const inwardLeft = { x: -(a.nx + b.nx), y: 0, z: -(a.nz + b.nz) };
      const inwardRight = { x: a.nx + b.nx, y: 0, z: a.nz + b.nz };
      cityQuad(concrete, leftA, leftB, ceilingLeftB, ceilingLeftA, inwardLeft);
      cityQuad(concrete, rightA, rightB, ceilingRightB, ceilingRightA, inwardRight);
      colliders.push(wallCollider(a, b, 'left'), wallCollider(a, b, 'right'), tunnelSlabCollider(a, b));
    }
    // 灯带：洞身内每 12 m 一条，贴在洞顶下方。
    for (let k = Math.ceil((runStartM + 0.001) / TUNNEL_LIGHT_SPACING_M);
      k * TUNNEL_LIGHT_SPACING_M < runEndM - 0.001; k++) {
      const frame = tunnelFrameAt(frames, k * TUNNEL_LIGHT_SPACING_M);
      const t = { x: -frame.nz, z: frame.nx };
      const lightHalf = width * 0.11;
      const axial = 0.45;
      const y = frame.ceilingY - 0.03;
      const at = (alongN, alongT) => ({
        x: frame.x + frame.nx * alongN + t.x * alongT,
        y,
        z: frame.z + frame.nz * alongN + t.z * alongT
      });
      cityQuad(light, at(-lightHalf, -axial), at(lightHalf, -axial), at(lightHalf, axial), at(-lightHalf, axial), DOWN);
    }
    // 洞身与开敞段相接的两个断面建洞门；链路边界上的洞身段不建，留给相邻链路续接。
    if (firstStation > 0 || mountain?.portalStart || (fixedFloor && deckPortals?.has(startNode))) {
      record.portals.push(tunnelPortal(concrete, frames[firstStation], -1, width, mountain?.baseHeight));
    }
    if (lastStation < frames.length - 1 || mountain?.portalEnd || (fixedFloor && deckPortals?.has(endNode))) {
      record.portals.push(tunnelPortal(concrete, frames[lastStation], 1, width, mountain?.baseHeight));
    }
  }
  record.portalCount = record.portals.length;
  // 净空固定 5.2 m，只有纵坡超限或没有洞身地形时不可车行；连通性在链路之间再判。
  if (profile || deckPortals || mountain) record.maxGrade = record.gradeProfile.maxGrade;
  record.drivable = record.maxGrade <= TUNNEL_DRIVE_MAX_GRADE + EPSILON;
  if (!record.drivable) record.blockedReason = 'grade';
  return record;
}

function tunnelChunkCell(grid, ix, iz) {
  const key = ix + ',' + iz;
  let cell = grid.get(key);
  if (!cell) {
    cell = { ix, iz, triangles: { asphalt: [], concrete: [], light: [] },
      links: new Set(), bounds: { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
        minY: Infinity, maxY: -Infinity } };
    grid.set(key, cell);
  }
  return cell;
}

// mode: 'structure' 只装洞身结构（顶板、侧墙、洞门、灯带）；'pavement' 装全部隧道
// 路面——平地下穿也必须有可渲染的路面，但路面不进 chunks（洞身结构为空即无洞）。
function buildTunnelGridChunks(records, mode = 'structure') {
  const grid = new Map();
  const pavement = mode !== 'structure';
  const materials = pavement ? ['asphalt'] : ['concrete', 'light'];
  for (const record of records) {
    const buckets = pavement ? { asphalt: record.pavementTriangles } : record.chunkTriangles;
    for (const material of materials) {
      for (const triangle of buckets[material]) {
        const cx = (triangle[0].x + triangle[1].x + triangle[2].x) / 3;
        const cz = (triangle[0].z + triangle[1].z + triangle[2].z) / 3;
        const ix = Math.floor(cx / TUNNEL_GRID_M);
        const iz = Math.floor(cz / TUNNEL_GRID_M);
        const cell = tunnelChunkCell(grid, ix, iz);
        cell.triangles[material].push(triangle);
        cell.links.add(record.index);
        for (const point of triangle) {
          cell.bounds.minX = Math.min(cell.bounds.minX, point.x);
          cell.bounds.maxX = Math.max(cell.bounds.maxX, point.x);
          cell.bounds.minZ = Math.min(cell.bounds.minZ, point.z);
          cell.bounds.maxZ = Math.max(cell.bounds.maxZ, point.z);
          cell.bounds.minY = Math.min(cell.bounds.minY, point.y);
          cell.bounds.maxY = Math.max(cell.bounds.maxY, point.y);
        }
      }
    }
  }
  const prefix = pavement ? `sz-tunnels:pavement:${mode === 'mountain' ? 'mountain:' : ''}` : 'sz-tunnels:';
  return [...grid.values()].map(cell => {
    const origin = [cell.ix * TUNNEL_GRID_M, cell.iz * TUNNEL_GRID_M];
    const positions = [];
    const colors = [];
    const groups = [];
    let triangles = 0;
    materials.forEach((material, materialIndex) => {
      const list = cell.triangles[material];
      if (list.length === 0) return;
      const color = material === 'asphalt' ? CITY_ASPHALT_COLOR
        : material === 'concrete' ? CITY_CONCRETE_COLOR : CITY_LIGHT_COLOR;
      const start = positions.length;
      for (const triangle of list) {
        for (const point of triangle) {
          positions.push(point.x - origin[0], point.y, point.z - origin[1]);
          colors.push(color[0], color[1], color[2]);
        }
        triangles++;
      }
      groups.push({ start, count: positions.length - start, materialIndex });
    });
    return {
      id: prefix + cell.ix + ',' + cell.iz,
      origin,
      bounds: cell.bounds,
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      groups,
      linkIndices: [...cell.links].sort((a, b) => a - b),
      triangles
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// 洞底高程查询：按链路中心线最近点插值，超出洞宽走廊返回 null。
function createTunnelHeightAt(links) {
  const bySurface = new Map(links.filter(link => Array.isArray(link.frames) && link.frames.length >= 2)
    .map(link => [link.surfaceId, link]));
  return (x, z, surfaceId) => {
    const link = bySurface.get(surfaceId);
    if (!link) return null;
    let best = Infinity;
    let height = null;
    const { frames, width } = link;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length2 = dx * dx + dz * dz;
      if (length2 < EPSILON) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const distance2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (distance2 < best) {
        best = distance2;
        height = a.floorY + (b.floorY - a.floorY) * t;
      }
    }
    if (!Number.isFinite(height)) return null;
    const corridor = width / 2 + 2;
    return best <= corridor * corridor ? height : null;
  };
}

function collectGroundNodes(graph) {
  const groundNodes = new Set();
  for (let index = 0; index < graph.links.length; index++) {
    if (!isGroundRoad(graph.metadata[index])) continue;
    groundNodes.add(graph.links[index][0]);
    groundNodes.add(graph.links[index][1]);
  }
  return groundNodes;
}

// 链路之间按共享 OSM 节点求连通分量；分量里没有任何一端接地面道路的隧道不进车流。
function tunnelComponents(records) {
  const parent = records.map((_, index) => index);
  const find = index => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) { const next = parent[index]; parent[index] = root; index = next; }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const byNode = new Map();
  records.forEach((record, index) => {
    for (const node of [record.startNode, record.endNode]) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push(index);
    }
  });
  for (const indices of byNode.values()) {
    for (let i = 1; i < indices.length; i++) union(indices[0], indices[i]);
  }
  const grounded = new Set();
  records.forEach((record, index) => {
    if (record.sharedStart || record.sharedEnd) grounded.add(find(index));
  });
  records.forEach((record, index) => {
    const neighbors = new Set();
    const deckAt = (candidate, node) => candidate.startNode === node ? candidate.startDeckY : candidate.endDeckY;
    for (const [side, node, atM] of [['start', record.startNode, 0], ['end', record.endNode, record.lengthM]]) {
      for (const other of byNode.get(node) ?? []) {
        if (other === index) continue;
        const candidate = records[other];
        const yA = deckAt(record, node);
        const yB = deckAt(candidate, node);
        recordRoadProfileSeam(record.gradeProfile, {
          side, kind: 'structure', node, atM, peer: candidate.surfaceId, fromY: yA, toY: yB,
          separated: record.layer !== candidate.layer
        }, TUNNEL_JOIN_TOLERANCE_M);
        // 共享节点但洞底错位超过容差（例如上下重叠的两层隧道）不连边。
        if (!Number.isFinite(yA) || !Number.isFinite(yB)) continue;
        if (Math.abs(yA - yB) <= TUNNEL_JOIN_TOLERANCE_M + EPSILON) neighbors.add(candidate.surfaceId);
      }
    }
    if (record.sharedStart || record.sharedEnd) neighbors.add('terrain');
    record.structureNeighbors = [...neighbors];
    if (record.drivable && !grounded.has(find(index))) {
      record.drivable = false;
      record.blockedReason = 'isolated';
    }
  });
}

function cityLink(record) {
  return {
    index: record.index,
    osmId: record.osmId,
    name: record.name,
    points: record.points,
    width: record.width,
    lanes: record.lanes,
    direction: record.direction,
    startNode: record.startNode,
    endNode: record.endNode,
    sharedStart: record.sharedStart,
    sharedEnd: record.sharedEnd,
    startGroundHeight: record.startGroundHeight,
    endGroundHeight: record.endGroundHeight,
    startDeckY: record.startDeckY,
    endDeckY: record.endDeckY,
    structureNeighbors: record.structureNeighbors,
    tunnel: true,
    drivable: record.drivable,
    heightSource: 'estimate',
    surfaceId: record.surfaceId,
    clearanceM: record.clearanceM,
    lengthM: record.lengthM,
    layer: record.layer,
    blockedReason: record.blockedReason,
    maxGrade: record.maxGrade,
    gradeProfile: record.gradeProfile,
    boreLengthM: record.boreLengthM,
    portalCount: record.portalCount,
    portalSpans: record.portalSpans,
    frames: record.frames,
    topTriangles: record.topTriangles,
    leadingOverlapFrames: 0,
    stationOffsetM: 0
  };
}

function planWholeCity(graph, terrainSurface, options) {
  const groundHeight = typeof options.groundHeight === 'function'
    ? options.groundHeight : createGroundSurfaceSampler(terrainSurface);
  const groundNodes = collectGroundNodes(graph);
  const deckPortals = highDeckTunnelPortals(graph);
  const records = [];
  const profiles = new Map();
  for (const plan of [terrainSurface?.keyuanUnderpass, terrainSurface?.hongliUnderpass]) {
    for (const id of plan?.tunnels ?? []) profiles.set(id, plan);
  }
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || (metadata.tunnel !== true && !metadata.mountainTunnel)) continue;
    if (metadata.mountainTunnel?.deckPortals?.length) {
      deckPortals.set(index, new Map(metadata.mountainTunnel.deckPortals));
    }
    records.push(planCityTunnel(graph, graph.links[index], index, metadata, groundHeight, groundNodes,
      profiles.get(metadata.osmId), deckPortals.get(index)));
  }
  tunnelComponents(records);
  for (const record of records) {
    const metadata = graph.metadata[record.index];
    if (Number.isFinite(metadata?.nanpingDeckY) || (metadata?.mountainTunnel?.deckPortals?.length
      && ![record.startNode, record.endNode].some(node => groundNodes.has(node)))) {
      record.structureNeighbors = record.structureNeighbors.filter(id => id !== 'terrain');
    }
    for (const peers of deckPortals.get(record.index)?.values() ?? []) {
      record.structureNeighbors.push(...peers.map(index => `sz-elevated-road:${index}`));
    }
  }
  const built = records.filter(record => record.frames.length >= 2);
  const links = built.map(cityLink);
  const surfaces = built.map(record => ({
    id: record.surfaceId,
    heightSource: 'estimate',
    triangles: record.pavementTriangles,
    climbableFromGround: true
  }));
  const chunks = buildTunnelGridChunks(built);
  const pavementChunks = [
    ...buildTunnelGridChunks(built.filter(record => !record.mountainPavement), 'pavement'),
    ...buildTunnelGridChunks(built.filter(record => record.mountainPavement), 'mountain')
  ];
  const colliders = built.flatMap(record => record.colliders);
  const portals = built.flatMap(record => record.portals.map(portal => ({ osmId: record.osmId, index: record.index, ...portal })));
  const driveLinks = links.filter(link => link.drivable);
  const boreTunnels = built.filter(record => record.boreLengthM > 0).length;
  const statistics = {
    tunnels: records.length,
    links: links.length,
    surfaces: surfaces.length,
    chunks: chunks.length,
    boreTunnels,
    boreLengthM: built.reduce((sum, record) => sum + record.boreLengthM, 0),
    portals: portals.length,
    portalCount: portals.length,
    lights: built.reduce((sum, record) => sum + record.chunkTriangles.light.length / 2, 0),
    triangles: chunks.reduce((sum, chunk) => sum + chunk.triangles, 0),
    pavementChunks: pavementChunks.length,
    pavementTriangles: pavementChunks.reduce((sum, chunk) => sum + chunk.triangles, 0),
    drivableTunnels: links.filter(link => link.drivable).length,
    drivableLinks: driveLinks.length,
    blockedTunnels: links.length - driveLinks.length,
    finalProfileGradeConflicts: links.filter(link => link.gradeProfile.maxGrade > TUNNEL_DRIVE_MAX_GRADE + EPSILON)
      .map(link => link.index),
    clearanceM: TUNNEL_CLEARANCE_M,
    heightSource: 'estimate',
    limitations: [...CITY_LIMITATIONS]
  };
  return {
    version: 1,
    heightSource: 'estimate',
    wholeCity: true,
    interchanges: [],
    tunnels: records,
    links,
    surfaces,
    colliders,
    portals,
    chunks,
    pavementChunks,
    reviewList: [],
    drive: { links: driveLinks, heightAt: createTunnelHeightAt(driveLinks) },
    statistics
  };
}

/** 解析：OSM 隧道链路（metadata.tunnel === true）与立交分区相交的部分 → 洞身计划（纯函数）。
 *  输入：roadGraph、terrainSurface（派生地形）、{interchanges, buildings}；默认立交取 SHENZHEN_INTERCHANGES。
 *  输出：{version, heightSource, tunnels, surfaces, colliders, reviewList, statistics}。
 *  洞底三角面同时是车辆接触面；洞顶、洞壁、洞口框来自同一批顶点生成。 */

// 顶面三角面：每区间两个三角面，顺序与 frames 对齐（供 sz-road-paint 逐段上漆）。
function frameTopTriangles(frames) {
  const list = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    list.push(
      [{ x: a.left.x, y: a.floorY, z: a.left.z },
        { x: a.right.x, y: a.floorY, z: a.right.z },
        { x: b.right.x, y: b.floorY, z: b.right.z }],
      [{ x: a.left.x, y: a.floorY, z: a.left.z },
        { x: b.right.x, y: b.floorY, z: b.right.z },
        { x: b.left.x, y: b.floorY, z: b.left.z }]
    );
  }
  return list;
}

export function planSzTunnels(graph, terrainSurface, options = {}) {
  validateGraph(graph);
  // 全城模式：不做立交分区过滤，按地形与路面高差派生洞身（docs/36 通用规则）。
  if (options.wholeCity === true) return planWholeCity(graph, terrainSurface, options);
  const interchanges = normalizeInterchanges(options.interchanges ?? elevated.SHENZHEN_INTERCHANGES ?? []);
  const buildings = options.buildings ?? [];
  const groundNodes = new Set();
  for (let index = 0; index < graph.links.length; index++) {
    if (!isGroundRoad(graph.metadata[index])) continue;
    groundNodes.add(graph.links[index][0]);
    groundNodes.add(graph.links[index][1]);
  }
  const selected = [];
  const seenSignatures = new Map();
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || metadata.tunnel !== true) continue;
    const link = graph.links[index];
    const points = roadLinkPoints(graph, link);
    const interchangeIds = interchanges
      .filter(interchange => polylineIntersectsArea(points, interchange.area))
      .map(interchange => interchange.id);
    if (interchangeIds.length === 0) continue;
    const signature = canonicalSignature(points);
    // OSM 里同一段洞身的重复链表只建一次，保留来源序号较小的一条。
    if (seenSignatures.has(signature)) continue;
    seenSignatures.set(signature, index);
    selected.push({ index, link, metadata, interchangeIds });
  }
  // 只有真的选中隧道链路时才展开地形；默认分区没有隧道时不必付这份解析成本。
  const groundHeight = selected.length > 0 ? createGroundSurfaceSampler(terrainSurface) : null;
  const tunnels = selected.map(item => planTunnel(graph, item.link, item.index, item.metadata,
    item.interchangeIds, groundHeight, groundNodes));
  const surfaces = tunnels.filter(record => record.floorTriangles.length > 0).map(record => ({
    id: record.surfaceId,
    heightSource: 'estimate',
    triangles: record.floorTriangles,
    // 洞底只在洞口与地面同高处接入，控制器不把洞内低面从地面直接吸附上来。
    climbableFromGround: false
  }));
  const colliders = tunnels.flatMap(record => record.colliders);
  const reviewList = planReviewList(graph, interchanges.map(interchange => interchange.area), buildings);
  const built = tunnels.filter(record => record.geometry.length > 0);
  // 车流消费的图数据：structureNeighbors 在这里只有 'terrain'（分区模式不追踪洞间连边）。
  const links = tunnels.filter(record => record.frames.length >= 2).map(record => ({
    index: record.index,
    osmId: record.osmId,
    name: record.name,
    points: record.points,
    width: record.width,
    lanes: record.lanes,
    direction: record.direction,
    startNode: record.startNode,
    endNode: record.endNode,
    sharedStart: record.sharedStart,
    sharedEnd: record.sharedEnd,
    startDeckY: record.startFloorY,
    endDeckY: record.endFloorY,
    structureNeighbors: ['terrain'],
    tunnel: true,
    drivable: record.drivable,
    heightSource: 'estimate',
    surfaceId: record.surfaceId,
    clearanceM: record.frames[0].ceilingY - record.frames[0].floorY,
    maxGrade: record.lengthM > 0
      ? Math.abs(record.endFloorY - record.startFloorY) / record.lengthM : 0,
    gradeProfile: record.gradeProfile,
    boreLengthM: record.geometry.length > 0 ? record.lengthM : 0,
    portalCount: record.portalCount,
    portalSpans: record.geometry.length > 0
      ? [{ fromM: 0, toM: record.lengthM, lengthM: record.lengthM }]
      : [],
    frames: record.frames,
    topTriangles: frameTopTriangles(record.frames),
    leadingOverlapFrames: 0,
    stationOffsetM: 0
  }));
  const floorSurfaceIds = new Set(tunnels
    .filter(record => record.floorTriangles.length > 0)
    .map(record => record.surfaceId));
  const driveLinks = links.filter(link => link.drivable && floorSurfaceIds.has(link.surfaceId));
  const portals = [];
  for (const record of tunnels) {
    if (record.frames.length < 2) continue;
    if (record.portalStart) {
      const frame = record.frames[0];
      portals.push({ osmId: record.osmId, index: record.index, x: frame.x, z: frame.z, y: frame.floorY,
        ceilingY: frame.ceilingY, topY: frame.ceilingY + TUNNEL_PORTAL_RISE_M,
        nx: frame.nx, nz: frame.nz, flow: -1 });
    }
    if (record.portalEnd) {
      const frame = record.frames[record.frames.length - 1];
      portals.push({ osmId: record.osmId, index: record.index, x: frame.x, z: frame.z, y: frame.floorY,
        ceilingY: frame.ceilingY, topY: frame.ceilingY + TUNNEL_PORTAL_RISE_M,
        nx: frame.nx, nz: frame.nz, flow: 1 });
    }
  }
  const chunks = buildChunks(tunnels);
  const statistics = {
    tunnels: tunnels.length,
    links: links.length,
    drivableTunnels: tunnels.filter(record => record.drivable).length,
    drivableLinks: driveLinks.length,
    boreLengthM: built.reduce((sum, record) => sum + record.lengthM, 0),
    triangles: tunnels.reduce((sum, record) => sum + record.geometry.length / 9, 0),
    portalCount: tunnels.reduce((sum, record) => sum + record.portalCount, 0),
    walls: tunnels.reduce((sum, record) => sum + record.wallTriangles.length / 2, 0),
    reviewItems: reviewList.length,
    heightSource: 'estimate',
    limitations: [...LIMITATIONS]
  };
  return {
    version: 1,
    heightSource: 'estimate',
    interchanges,
    tunnels,
    links,
    surfaces,
    colliders,
    portals,
    chunks,
    reviewList,
    drive: { links: driveLinks, heightAt: createTunnelHeightAt(driveLinks) },
    statistics
  };
}

/** 解析：把隧道计划建成场景（≤8 个空间分块网格 + 可站立洞底面 + 洞壁碰撞）。
 *  输入：scene、{graph, terrainSurface, interchanges, buildings}。
 *  输出：{group, meshes, surfaces, colliders, reviewList, statistics, tunnels, update, dispose}。 */
export function buildSzTunnels(scene, options = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('A THREE scene is required');
  const plan = planSzTunnels(options.graph, options.terrainSurface, options);
  const group = new THREE.Group();
  group.name = 'shenzhen-tunnels';
  // 顶点色代替贴图：路面沥青、结构混凝土、灯带自发光三段共用一套几何。
  const materials = [];
  let surfaceMaterial = null;
  const createSurfaceMaterial = () => {
    if (!surfaceMaterial) {
      surfaceMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
      materials.push(surfaceMaterial);
    }
    return surfaceMaterial;
  };
  let cityMaterials = null;
  const createCityMaterials = () => {
    if (cityMaterials) return cityMaterials;
    const concrete = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    const light = typeof THREE.MeshBasicNodeMaterial === 'function'
      ? new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide })
      : new THREE.MeshStandardNodeMaterial({ color: 0xf4f8ff, emissive: 0xf4f8ff, emissiveIntensity: 0.8 });
    materials.push(concrete, light);
    cityMaterials = [createSurfaceMaterial(), concrete, light];
    return cityMaterials;
  };
  const meshes = [];
  const chunkList = [...(plan.chunks ?? []), ...(plan.pavementChunks ?? [])];
  for (const chunk of chunkList) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    // 洞身分块按材质分段（混凝土 / 灯带）；路面分块与分区模式用单材质整块。
    const pavement = chunk.id.includes(':pavement:');
    const grouped = !pavement && Array.isArray(chunk.groups) && chunk.groups.length > 0;
    const material = chunk.id.startsWith('sz-tunnels:pavement:mountain:') ? createSzRoadSurfaceMaterial()
      : grouped ? createCityMaterials() : createSurfaceMaterial();
    if (grouped && typeof geometry.addGroup === 'function') {
      for (const groupRange of chunk.groups) {
        geometry.addGroup(groupRange.start, groupRange.count, groupRange.materialIndex);
      }
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.name = chunk.id;
    // 洞身埋在地下，不投影；接收阴影让洞口附近有明暗层次。
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.tunnels = chunk.linkIndices ?? chunk.tunnelIndices ?? [];
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return {
    version: plan.version,
    heightSource: 'estimate',
    group,
    meshes,
    links: plan.links,
    surfaces: plan.surfaces,
    colliders: plan.colliders,
    portals: plan.portals,
    chunks: plan.chunks,
    pavementChunks: plan.pavementChunks ?? [],
    reviewList: plan.reviewList,
    statistics: plan.statistics,
    tunnels: plan.tunnels,
    drive: plan.drive,
    // 相机夹取占位：洞内不做额外裁剪，返回 true 表示允许当前视角。
    constrainCamera: () => true,
    update() {},
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      for (const material of materials) material.dispose();
    }
  };
}
