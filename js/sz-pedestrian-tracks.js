import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { polygonBoxOverlaps } from './building-collision.js';

// 深圳没有全城实测的人行道网格：本模块沿地面道路中心线两侧偏移出“模拟步行带”（walk track），
// 再用地形接触高度、建筑碰撞和车行道范围把不可走的部分筛掉。轨道和铺装都是模拟，
// 不是 OSM 实测人行道，也不是市政铺装范围。缺失处宁可不生成，不向车道、建筑和绿地硬填。
const EPSILON = 1e-9;
const CELL_SIZE = 24;
const BARRIER_CELL = 32;
const BARRIER_SEGMENT = 40;

export const DEFAULT_EXCLUDED_HIGHWAYS = ['motorway', 'motorway_link', 'trunk', 'trunk_link'];
export const TRACK_DEFAULTS = {
  walkMarginM: 2.1, // 路缘外步行带中心到车行道边缘的距离（m）
  sampleStepM: 3, // 步行带接触高度与碰撞检查步长
  colliderRadiusM: 0.55, // 身体半宽加摆动的保守值
  colliderHeightM: 1.9,
  colliderTest: 'box', // 步行带碰撞精度：box 用建筑包围盒，更保守也更快；polygon 按轮廓
  minRunLengthM: 10,
  maxStepRiseM: 1.8, // 相邻采样点高差上限，超过按断开处理（m）
  connectRadiusM: 14,
  connectorStepM: 1.5,
  maxConnectionsPerEnd: 4,
  pavement: true,
  pavementHalfWidthM: 1.1, // 模拟铺装带宽 2.2 m
  pavementStepM: 8,
  surfaceRiseM: 0.03, // 铺装面相对 heightAt 的抬升，人物脚底用同一抬升
  cornerPavementRiseM: 0.018, // 转角铺装压在下层，避免与直段共面闪烁
  excludedHighways: DEFAULT_EXCLUDED_HIGHWAYS
};

function config(options) {
  return { ...TRACK_DEFAULTS, ...options };
}

// 城市范围远小于 100 km，整数键比字符串键快；碰撞/屏障索引都在重建热路径里。
function cellKey(x, z) {
  return (x + 10000) * 100000 + (z + 10000);
}

function boundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

const LINK_BOUNDS_CACHE = new WeakMap();

function linkBounds(graph, link) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const add = (x, z) => {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
  };
  add(graph.nodes[link[0] * 2], graph.nodes[link[0] * 2 + 1]);
  add(graph.nodes[link[1] * 2], graph.nodes[link[1] * 2 + 1]);
  for (let i = 0; i < link[6].length; i += 2) add(link[6][i], link[6][i + 1]);
  return bounds;
}

// 路网是静态的，每帧/每次重建都扫一遍 11k 条路不划算；包围盒按 graph 缓存一次。
function linkBoundsCache(graph) {
  let cache = LINK_BOUNDS_CACHE.get(graph);
  if (cache) return cache;
  cache = new Array(graph.links.length);
  for (let i = 0; i < graph.links.length; i++) cache[i] = linkBounds(graph, graph.links[i]);
  LINK_BOUNDS_CACHE.set(graph, cache);
  return cache;
}

// Liang–Barsky：把一段中心线裁到关注范围内，避免为了 260 m 的活动区生成整条十几公里的路。
function clipSegment(ax, az, bx, bz, bounds) {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - bounds.minX, bounds.maxX - ax, az - bounds.minZ, bounds.maxZ - az];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPSILON) {
      if (q[i] < 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

function clipPolyline(points, bounds) {
  const runs = [];
  let current = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const clipped = clipSegment(a.x, a.z, b.x, b.z, bounds);
    if (!clipped) {
      if (current && current.length > 1) runs.push(current);
      current = null;
      continue;
    }
    const start = { x: a.x + (b.x - a.x) * clipped[0], z: a.z + (b.z - a.z) * clipped[0] };
    const end = { x: a.x + (b.x - a.x) * clipped[1], z: a.z + (b.z - a.z) * clipped[1] };
    if (current) {
      const last = current[current.length - 1];
      if (Math.hypot(last.x - start.x, last.z - start.z) < 1e-6) current.push(end);
      else {
        if (current.length > 1) runs.push(current);
        current = [start, end];
      }
    } else {
      current = [start, end];
    }
  }
  if (current && current.length > 1) runs.push(current);
  return runs;
}

export function resamplePolyline(points, stepM) {
  if (!(stepM > 0)) throw new Error('Resampling step must be positive');
  if (points.length < 2) return points.map(point => ({ x: point.x, z: point.z }));
  const result = [{ x: points[0].x, z: points[0].z }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / stepM - 1e-9));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      result.push({ x: a.x + dx * t, z: a.z + dz * t });
    }
  }
  return result;
}

// 左侧法向 (dz, -dx)：side = +1 是该侧，side = -1 是对侧。
export function offsetPolyline(points, offsetM) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next.x - previous.x;
    let dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    result.push({ x: points[i].x + dz * offsetM, z: points[i].z - dx * offsetM });
  }
  return result;
}

// 全城建筑碰撞体约 4 万条。先在 120 m 粗格上建一次静态索引，活动区重建时只取附近一组，
// 不必每次重扫全城。
export function createColliderGrid(colliders, cellSize = 120) {
  const cells = new Map();
  let indexed = 0;
  for (const collider of colliders) {
    if (!collider?.polygon || !(collider.polygon.outer?.length >= 3)) continue;
    const { minX, maxX, minZ, maxZ, minY, maxY } = collider;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ)
      || !Number.isFinite(maxZ) || !Number.isFinite(minY) || !Number.isFinite(maxY)) continue;
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x++) {
      for (let z = Math.floor(minZ / cellSize); z <= Math.floor(maxZ / cellSize); z++) {
        const key = cellKey(x, z);
        let list = cells.get(key);
        if (!list) cells.set(key, list = []);
        list.push(collider);
      }
    }
    indexed++;
  }
  return { cells, cellSize, indexed };
}

function gatherColliders(grid, bounds) {
  const result = [];
  const seen = new Set();
  const firstX = Math.floor(bounds.minX / grid.cellSize);
  const lastX = Math.floor(bounds.maxX / grid.cellSize);
  const firstZ = Math.floor(bounds.minZ / grid.cellSize);
  const lastZ = Math.floor(bounds.maxZ / grid.cellSize);
  for (let x = firstX; x <= lastX; x++) {
    for (let z = firstZ; z <= lastZ; z++) {
      for (const collider of grid.cells.get(cellKey(x, z)) ?? []) {
        if (seen.has(collider)) continue;
        seen.add(collider);
        result.push(collider);
      }
    }
  }
  return result;
}

function createColliderIndex(colliders, bounds, grid = null) {
  const cells = new Map();
  let indexed = 0;
  const source = grid && bounds ? gatherColliders(grid, bounds) : colliders;
  for (const collider of source) {
    if (!collider?.polygon || !(collider.polygon.outer?.length >= 3)) continue;
    const { minX, maxX, minZ, maxZ, minY, maxY } = collider;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ)
      || !Number.isFinite(maxZ) || !Number.isFinite(minY) || !Number.isFinite(maxY)) continue;
    if (bounds && (maxX < bounds.minX || minX > bounds.maxX || maxZ < bounds.minZ || minZ > bounds.maxZ)) continue;
    for (let x = Math.floor(minX / CELL_SIZE); x <= Math.floor(maxX / CELL_SIZE); x++) {
      for (let z = Math.floor(minZ / CELL_SIZE); z <= Math.floor(maxZ / CELL_SIZE); z++) {
        const key = cellKey(x, z);
        let list = cells.get(key);
        if (!list) cells.set(key, list = []);
        list.push(collider);
      }
    }
    indexed++;
  }
  return { cells, indexed };
}

// 只做包围盒判断的保守版本：铺装边沿不需要精确轮廓，宁可小幅收窄也不压进建筑。
function colliderBoxAt(index, x, z, y, radius, height) {
  const minY = y + 0.25;
  const maxY = y + height;
  const firstX = Math.floor((x - radius) / CELL_SIZE);
  const lastX = Math.floor((x + radius) / CELL_SIZE);
  const firstZ = Math.floor((z - radius) / CELL_SIZE);
  const lastZ = Math.floor((z + radius) / CELL_SIZE);
  for (let cx = firstX; cx <= lastX; cx++) {
    for (let cz = firstZ; cz <= lastZ; cz++) {
      for (const collider of index.cells.get(cellKey(cx, cz)) ?? []) {
        if (!(collider.maxY > minY && collider.minY < maxY)) continue;
        if (x + radius < collider.minX || x - radius > collider.maxX
          || z + radius < collider.minZ || z - radius > collider.maxZ) continue;
        return collider;
      }
    }
  }
  return null;
}

// 只测人物身体实际占用的高度区间，架空层/雨棚下方仍可通行。
function colliderAt(index, x, z, y, radius, height) {
  const minY = y + 0.25;
  const maxY = y + height;
  const firstX = Math.floor((x - radius) / CELL_SIZE);
  const lastX = Math.floor((x + radius) / CELL_SIZE);
  const firstZ = Math.floor((z - radius) / CELL_SIZE);
  const lastZ = Math.floor((z + radius) / CELL_SIZE);
  for (let cx = firstX; cx <= lastX; cx++) {
    for (let cz = firstZ; cz <= lastZ; cz++) {
      for (const collider of index.cells.get(cellKey(cx, cz)) ?? []) {
        if (!(collider.maxY > minY && collider.minY < maxY)) continue;
        if (x + radius < collider.minX || x - radius > collider.maxX
          || z + radius < collider.minZ || z - radius > collider.maxZ) continue;
        if (polygonBoxOverlaps(collider.polygon, x, z, radius, radius)) return collider;
      }
    }
  }
  return null;
}

// 车行道范围只用来判断转角连接是否横穿车道，不参与人物位置约束。
function createRoadBarrierIndex(graph, bounds) {
  const cells = new Map();
  const boxes = linkBoundsCache(graph);
  let segments = 0;
  for (let index = 0; index < graph.links.length; index++) {
    if (!isGroundRoad(graph.metadata[index])) continue;
    const link = graph.links[index];
    if (bounds && !boundsOverlap(boxes[index], bounds)) continue;
    const points = roadLinkPoints(graph, link);
    const half = Math.max(0.05, link[3] / 2 - 0.15);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < EPSILON) continue;
      const dx = (b.x - a.x) / length;
      const dz = (b.z - a.z) / length;
      const pieces = Math.max(1, Math.ceil(length / BARRIER_SEGMENT));
      for (let k = 0; k < pieces; k++) {
        const t0 = length * (k / pieces);
        const t1 = length * ((k + 1) / pieces);
        const segment = { ax: a.x + dx * t0, az: a.z + dz * t0, dx, dz, length: t1 - t0, half };
        const x0 = Math.floor(Math.min(segment.ax, segment.ax + dx * segment.length) / BARRIER_CELL);
        const x1 = Math.floor(Math.max(segment.ax, segment.ax + dx * segment.length) / BARRIER_CELL);
        const z0 = Math.floor(Math.min(segment.az, segment.az + dz * segment.length) / BARRIER_CELL);
        const z1 = Math.floor(Math.max(segment.az, segment.az + dz * segment.length) / BARRIER_CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const key = cellKey(cx, cz);
            let list = cells.get(key);
            if (!list) cells.set(key, list = []);
            list.push(segment);
          }
        }
        segments++;
      }
    }
  }
  return { cells, segments };
}

// 车行道按矩形断面判断（线段两端是直角），避免把路口端头当成圆形而误判转角连接。
function onCarriageway(index, x, z, extraM = 0) {
  const list = index.cells.get(cellKey(Math.floor(x / BARRIER_CELL), Math.floor(z / BARRIER_CELL)));
  if (!list) return false;
  for (const segment of list) {
    const px = x - segment.ax;
    const pz = z - segment.az;
    const along = px * segment.dx + pz * segment.dz;
    if (along < -0.15 || along > segment.length + 0.15) continue;
    const lateral = Math.abs(pz * segment.dx - px * segment.dz);
    if (lateral < segment.half + extraM) return true;
  }
  return false;
}

// 偏移线的终点可能落在相邻路口的车行道里；沿轨道向内裁掉，保证端点站在路缘外。
function trimCarriageway(points, barrier, marginM = 0.3) {
  let start = 0;
  while (start < points.length - 2 && onCarriageway(barrier, points[start].x, points[start].z, marginM)) start++;
  let end = points.length - 1;
  while (end > start + 1 && onCarriageway(barrier, points[end].x, points[end].z, marginM)) end--;
  return start === 0 && end === points.length - 1 ? points : points.slice(start, end + 1);
}

function makeTrack(points, kind, extra) {
  const cum = [0];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    cum.push(length);
  }
  return { kind, points, cum, length, ends: [[], []], ...extra };
}

function walkableRuns(points, cfg, heightAt, colliderIndex, statistics) {
  const runs = [];
  let current = [];
  let lastY = null;
  for (const point of points) {
    const y = heightAt(point.x, point.z);
    let blocked = !Number.isFinite(y);
    if (!blocked && lastY !== null && Math.abs(y - lastY) > cfg.maxStepRiseM) blocked = true;
    if (!blocked) {
      const hit = cfg.colliderTest === 'box'
        ? colliderBoxAt(colliderIndex, point.x, point.z, y, cfg.colliderRadiusM, cfg.colliderHeightM)
        : colliderAt(colliderIndex, point.x, point.z, y, cfg.colliderRadiusM, cfg.colliderHeightM);
      if (hit) {
        blocked = true;
        statistics.colliderBlockedSamples++;
      }
    }
    if (blocked) {
      statistics.blockedSamples++;
      if (current.length > 1) runs.push(current);
      current = [];
      lastY = null;
      continue;
    }
    current.push({ x: point.x, z: point.z, y });
    lastY = y;
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

function trackLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return length;
}

export function buildSidewalkTracks(graph, options = {}) {
  if (!graph || !Array.isArray(graph.links) || !Array.isArray(graph.metadata)) {
    throw new Error('Walk tracks require a source road graph');
  }
  if (typeof options.heightAt !== 'function') throw new Error('Walk tracks require heightAt');
  const cfg = config(options);
  const bounds = cfg.bounds ?? null;
  const colliderIndex = cfg.colliderIndex ?? createColliderIndex(cfg.colliders ?? [], bounds, cfg.colliderGrid ?? null);
  const barrier = cfg.barrier ?? null;
  const excluded = new Set(cfg.excludedHighways ?? []);
  const tracks = [];
  const statistics = { groundLinks: 0, candidateLinks: 0, clippedRuns: 0, blockedSamples: 0,
    colliderBlockedSamples: 0, trimmedPoints: 0, rejectedRuns: 0, tracks: 0, walkableMeters: 0,
    colliderIndexed: colliderIndex.indexed };
  const boxes = linkBoundsCache(graph);
  let nextId = 0;
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    statistics.groundLinks++;
    if (excluded.has(metadata.highway)) continue;
    const link = graph.links[index];
    if (!(link[3] > 0)) continue;
    if (bounds && !boundsOverlap(boxes[index], bounds)) continue;
    statistics.candidateLinks++;
    const centerline = roadLinkPoints(graph, link);
    if (centerline.length < 2) continue;
    const runs = bounds ? clipPolyline(centerline, bounds) : [centerline];
    statistics.clippedRuns += runs.length;
    const offset = link[3] / 2 + cfg.walkMarginM;
    for (const run of runs) {
      if (trackLength(run) < 0.5) continue;
      for (const side of [1, -1]) {
        const line = resamplePolyline(offsetPolyline(run, side * offset), cfg.sampleStepM);
        for (const runPoints of walkableRuns(line, cfg, cfg.heightAt, colliderIndex, statistics)) {
          const points = barrier ? trimCarriageway(runPoints, barrier) : runPoints;
          if (points !== runPoints) statistics.trimmedPoints += runPoints.length - points.length;
          const length = trackLength(points);
          if (length < cfg.minRunLengthM) {
            statistics.rejectedRuns++;
            continue;
          }
          tracks.push(makeTrack(points, 'sidewalk', { id: `walk:${nextId++}`, linkIndex: index, side,
            highway: metadata.highway, widthM: link[3], offsetM: offset }));
          statistics.walkableMeters += length;
        }
      }
    }
  }
  statistics.tracks = tracks.length;
  return { tracks, statistics };
}

function connectorPoints(a, b, cfg, heightAt, colliderIndex, barrier) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.5 || length > cfg.connectRadiusM) return null;
  // 绝大多数被拒绝的转角都是横穿车行道；先用 3 个无高度查询的采样点快速排除。
  if (barrier) {
    for (const t of [0.25, 0.5, 0.75]) {
      if (onCarriageway(barrier, a.x + dx * t, a.z + dz * t)) return null;
    }
  }
  // 转角连接很短（≤ 14 m）：端点高度来自已校验的轨道，中段只取一次地形高度插值，
  // 碰撞/车行道按 4 个分段点检查。连接线只用于过弯，不用于出生选点。
  const stations = [0, 1 / 3, 2 / 3, 1];
  const midY = heightAt(a.x + dx * 0.5, a.z + dz * 0.5);
  if (!Number.isFinite(midY)) return null;
  const points = [];
  for (const t of stations) {
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const y = (a.y ?? midY) + ((b.y ?? midY) - (a.y ?? midY)) * t;
    const merged = t === 0.5 ? midY : y;
    if (Math.abs(midY - y) > cfg.maxStepRiseM) return null;
    if (colliderAt(colliderIndex, x, z, merged, cfg.colliderRadiusM, cfg.colliderHeightM)) return null;
    if (barrier && onCarriageway(barrier, x, z)) return null;
    points.push({ x, z, y: merged });
  }
  return points;
}

// 只在同侧路缘之间做短转角连接；连接线必须完全在车行道外、且不压建筑。
// 连不上就保持两个端点，由人物到端点后原路折返，不能横穿车行道。
export function connectTracks(tracks, options = {}) {
  if (!Array.isArray(tracks)) throw new Error('connectTracks requires an array of tracks');
  const cfg = config(options);
  if (typeof cfg.heightAt !== 'function') throw new Error('connectTracks requires heightAt');
  const colliderIndex = cfg.colliderIndex ?? createColliderIndex(cfg.colliders ?? [], cfg.bounds ?? null, cfg.colliderGrid ?? null);
  const barrier = cfg.barrier ?? (cfg.graph ? createRoadBarrierIndex(cfg.graph, cfg.bounds ?? null) : null);
  const maxPerEnd = cfg.maxConnectionsPerEnd;
  const radius = cfg.connectRadiusM;
  const radiusSq = radius * radius;
  const endpoints = [];
  for (const track of tracks) {
    if (track.length < 0.5) continue;
    for (const end of [0, 1]) {
      const point = track.points[end === 0 ? 0 : track.points.length - 1];
      endpoints.push({ track, end, x: point.x, z: point.z, y: point.y });
    }
  }
  const cellSize = Math.max(8, radius);
  const cells = new Map();
  for (const endpoint of endpoints) {
    const key = cellKey(Math.floor(endpoint.x / cellSize), Math.floor(endpoint.z / cellSize));
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(endpoint);
  }
  const connectors = [];
  const linked = new Set();
  const statistics = { connectors: 0, rejectedConnections: 0, connectionAttempts: 0 };
  let nextId = 0;
  for (const a of endpoints) {
    if (a.track.ends[a.end].length >= maxPerEnd) continue;
    const cx = Math.floor(a.x / cellSize);
    const cz = Math.floor(a.z / cellSize);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        for (const b of cells.get(cellKey(cx + ox, cz + oz)) ?? []) {
          if (b.track === a.track) continue;
          if (a.track.ends[a.end].length >= maxPerEnd) break;
          if (b.track.ends[b.end].length >= maxPerEnd) continue;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq > radiusSq) continue;
          const pair = a.track.id < b.track.id
            ? `${a.track.id}|${a.end}|${b.track.id}|${b.end}`
            : `${b.track.id}|${b.end}|${a.track.id}|${a.end}`;
          if (linked.has(pair)) continue;
          linked.add(pair);
          statistics.connectionAttempts++;
          const points = connectorPoints(a, b, cfg, cfg.heightAt, colliderIndex, barrier);
          if (!points || points.length < 2) {
            statistics.rejectedConnections++;
            continue;
          }
          const connector = makeTrack(points, 'corner', { id: `corner:${nextId++}` });
          connector.ends[0].push({ leg: a.track, end: a.end });
          connector.ends[1].push({ leg: b.track, end: b.end });
          a.track.ends[a.end].push({ leg: connector, end: 0 });
          b.track.ends[b.end].push({ leg: connector, end: 1 });
          connectors.push(connector);
        }
      }
    }
  }
  statistics.connectors = connectors.length;
  return { connectors, statistics };
}

function pavementWidth(colliderIndex, x, z, nx, nz, y, halfWidthM, statistics) {
  if (!colliderBoxAt(colliderIndex, x + nx * halfWidthM, z + nz * halfWidthM, y, 0.05, 0.8)) return halfWidthM;
  statistics.clampedSamples++;
  const half = halfWidthM * 0.5;
  if (!colliderBoxAt(colliderIndex, x + nx * half, z + nz * half, y, 0.05, 0.8)) return half;
  return 0;
}

function tangentAt(points, index) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - previous.x;
  const dz = next.z - previous.z;
  const length = Math.hypot(dx, dz) || 1;
  return { dx: dx / length, dz: dz / length };
}

const PAVEMENT_COLOR = [0.323, 0.311, 0.272]; // 0x9a968e 的线性空间近似，浅暖灰
const INNER_EDGE_DARK = 0.84;
const OUTER_EDGE_SHADE = 0.96;

function jitter(seed) {
  const value = Math.sin(seed) * 43758.5453;
  return value - Math.floor(value);
}

// 模拟铺装条带：沿每条步行带中心生成 2.2 m 宽的浅灰/暖灰顶点色带状网格，边沿遇建筑收窄。
// 几何是动画无关的，按活动区一次生成、切区时整体替换。
export function buildPavementRibbons(legs, options = {}) {
  const cfg = config(options);
  if (typeof cfg.heightAt !== 'function') throw new Error('Pavement requires heightAt');
  const colliderIndex = cfg.colliderIndex ?? createColliderIndex(cfg.colliders ?? [], cfg.bounds ?? null, cfg.colliderGrid ?? null);
  const half = cfg.pavementHalfWidthM;
  const step = Math.max(2, cfg.pavementStepM);
  const positions = [];
  const colors = [];
  const statistics = { triangles: 0, areaM2: 0, clampedSamples: 0, blankRows: 0 };
  for (const leg of legs) {
    if (!leg || leg.length < 2) continue;
    const source = [];
    for (let s = 0; s < leg.length; s += step) source.push(sampleTrack(leg, s, {}));
    source.push(sampleTrack(leg, leg.length, {}));
    if (source.length < 2) continue;
    const rise = leg.kind === 'corner' ? cfg.cornerPavementRiseM : cfg.surfaceRiseM;
    const rows = [];
    for (let i = 0; i < source.length; i++) {
      const point = source[i];
      const tangent = tangentAt(source, i);
      const nx = tangent.dz;
      const nz = -tangent.dx;
      const y = point.y;
      if (!Number.isFinite(y)) { rows.push(null); continue; }
      const leftWidth = pavementWidth(colliderIndex, point.x, point.z, nx, nz, y, half, statistics);
      const rightWidth = pavementWidth(colliderIndex, point.x, point.z, -nx, -nz, y, half, statistics);
      if (leftWidth === 0 && rightWidth === 0) { rows.push(null); statistics.blankRows++; continue; }
      const leftX = point.x + nx * leftWidth;
      const leftZ = point.z + nz * leftWidth;
      const rightX = point.x - nx * rightWidth;
      const rightZ = point.z - nz * rightWidth;
      const leftY = cfg.heightAt(leftX, leftZ);
      const rightY = cfg.heightAt(rightX, rightZ);
      rows.push({
        left: { x: leftX, z: leftZ, y: (Number.isFinite(leftY) ? leftY : y) + rise, width: leftWidth },
        right: { x: rightX, z: rightZ, y: (Number.isFinite(rightY) ? rightY : y) + rise, width: rightWidth }
      });
    }
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (!a || !b) continue;
      const shade = 0.93 + jitter(leg.id.length * 7.31 + leg.length * 0.37 + i * 1.7) * 0.12;
      const innerLeft = leg.side === -1;
      const leftFactor = (innerLeft ? INNER_EDGE_DARK : OUTER_EDGE_SHADE) * shade;
      const rightFactor = (innerLeft ? OUTER_EDGE_SHADE : INNER_EDGE_DARK) * shade;
      const leftColor = PAVEMENT_COLOR.map(value => value * leftFactor);
      const rightColor = PAVEMENT_COLOR.map(value => value * rightFactor);
      const push = (vertex, color) => {
        positions.push(vertex.x, vertex.y, vertex.z);
        colors.push(color[0], color[1], color[2]);
      };
      push(a.left, leftColor);
      push(a.right, rightColor);
      push(b.left, leftColor);
      push(a.right, rightColor);
      push(b.right, rightColor);
      push(b.left, leftColor);
      statistics.triangles += 2;
      const segment = Math.hypot(b.left.x - a.left.x, b.left.z - a.left.z);
      statistics.areaM2 += ((a.left.width + a.right.width + b.left.width + b.right.width) / 2) * Math.min(step, segment + 1e-6);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), statistics };
}

export function buildWalkTracks(graph, options = {}) {
  const cfg = config(options);
  const bounds = cfg.bounds ?? null;
  const colliderIndex = createColliderIndex(cfg.colliders ?? [], bounds, cfg.colliderGrid ?? null);
  const barrier = createRoadBarrierIndex(graph, bounds);
  const built = buildSidewalkTracks(graph, { ...cfg, colliderIndex, barrier });
  const connected = connectTracks(built.tracks, { ...cfg, colliderIndex, barrier });
  const legs = [...built.tracks, ...connected.connectors];
  const pavement = cfg.pavement
    ? buildPavementRibbons(legs, { ...cfg, colliderIndex })
    : { positions: new Float32Array(0), colors: new Float32Array(0), statistics: { triangles: 0, areaM2: 0, clampedSamples: 0 } };
  return {
    tracks: built.tracks,
    connectors: connected.connectors,
    legs,
    pavement,
    statistics: {
      ...built.statistics,
      ...connected.statistics,
      pavementTriangles: pavement.statistics.triangles,
      pavementAreaM2: pavement.statistics.areaM2,
      pavementClampedSamples: pavement.statistics.clampedSamples,
      barrierSegments: barrier.segments,
      colliderIndexed: colliderIndex.indexed
    }
  };
}

export function sampleTrack(track, s, out = {}) {
  const points = track.points;
  const cum = track.cum;
  const clamped = Math.max(0, Math.min(track.length, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const segment = cum[hi] - cum[lo];
  const t = segment > EPSILON ? (clamped - cum[lo]) / segment : 0;
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  out.dx = length > EPSILON ? dx / length : 1;
  out.dz = length > EPSILON ? dz / length : 0;
  return out;
}
