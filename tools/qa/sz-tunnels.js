import * as THREE from 'three/webgpu';
import { isGroundRoad, roadLinkPoints } from '../../js/sz-roads.js';
import { createGroundSurfaceSampler } from '../../js/sz-ground-surface.js';
import { polygonContains } from '../../js/sz-polygon.js';
// 默认立交选区与桥面共用 sz-elevated-roads.js 导出的 SHENZHEN_INTERCHANGES，隧道和桥面不会各用一套范围。
// 这里用命名空间导入，只取该导出；条目结构仍是 {id,name,source,area,heightSource}，heightSource 必须是 estimate。
import * as elevated from '../../js/sz-elevated-roads.js';

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
  return {
    type: 'tunnel-wall',
    polygon: { outer: [{ x: edgeA.x, z: edgeA.z }, { x: edgeB.x, z: edgeB.z },
      { x: outerB.x, z: outerB.z }, { x: outerA.x, z: outerA.z }], holes: [] },
    minY: Math.min(frameA.floorY, frameB.floorY),
    maxY: Math.max(frameA.ceilingY, frameB.ceilingY)
  };
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
  const withGround = stations.map(station => ({ ...station, groundY: groundHeight(station.x, station.z) }));
  // 地形高程未知就不建洞身，也不用别的数据顶替。
  if (!withGround.every(station => Number.isFinite(station.groundY))) return record;
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

/** 解析：OSM 隧道链路（metadata.tunnel === true）与立交分区相交的部分 → 洞身计划（纯函数）。
 *  输入：roadGraph、terrainSurface（派生地形）、{interchanges, buildings}；默认立交取 SHENZHEN_INTERCHANGES。
 *  输出：{version, heightSource, tunnels, surfaces, colliders, reviewList, statistics}。
 *  洞底三角面同时是车辆接触面；洞顶、洞壁、洞口框来自同一批顶点生成。 */
export function planSzTunnels(graph, terrainSurface, options = {}) {
  validateGraph(graph);
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
  const statistics = {
    tunnels: tunnels.length,
    drivableTunnels: tunnels.filter(record => record.drivable).length,
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
    surfaces,
    colliders,
    reviewList,
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
  // 顶点色代替贴图：洞底沥青、洞壁洞顶混凝土、洞口框略亮；洞内没有真实照明数据。
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const meshes = [];
  for (const chunk of buildChunks(plan.tunnels)) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.name = chunk.id;
    // 洞身埋在地下，不投影；接收阴影让洞口附近有明暗层次。
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.tunnels = chunk.tunnelIndices;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return {
    group,
    meshes,
    surfaces: plan.surfaces,
    colliders: plan.colliders,
    reviewList: plan.reviewList,
    statistics: plan.statistics,
    tunnels: plan.tunnels,
    update() {},
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      material.dispose();
    }
  };
}
