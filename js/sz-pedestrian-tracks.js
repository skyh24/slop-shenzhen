import { convexHull, isGroundRoad, roadSectionPoints } from './sz-roads.js';
import { polygonBoxOverlaps } from './building-collision.js';

// 深圳没有全城实测的人行道网格：本模块沿地面道路中心线两侧偏移出“模拟步行带”（walk track），
// 再用地形接触高度、建筑碰撞和车行道范围把不可走的部分筛掉。轨道和铺装都是模拟，
// 不是 OSM 实测人行道，也不是市政铺装范围。缺失处宁可不生成，不向车道、建筑和绿地硬填。
const EPSILON = 1e-9;
const CELL_SIZE = 24;
const BARRIER_CELL = 32;

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
  connectorStepM: 1.2,
  maxConnectionsPerEnd: 4,
  carriagewayClearanceM: 0.7, // 步行带中心离沥青边的最小距离：0.5 m 路缘外 + 靠右摆动/身体余量
  connectorCarriagewayClearanceM: 0.5,
  pavementCarriagewayClearanceM: 0.08, // 铺装整条带离沥青边的最小距离（m）
  barrierLinkExtendM: 40, // 路面排斥面的道路筛选范围外扩（m）
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

function linkBounds(graph, link, metadata) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const add = (x, z) => {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
  };
  for (const { x, z } of roadSectionPoints(graph, link, metadata)) add(x, z);
  return bounds;
}

// 路网是静态的，每帧/每次重建都扫一遍 11k 条路不划算；包围盒按 graph 缓存一次。
function linkBoundsCache(graph) {
  let cache = LINK_BOUNDS_CACHE.get(graph);
  if (cache) return cache;
  cache = new Array(graph.links.length);
  for (let i = 0; i < graph.links.length; i++) cache[i] = linkBounds(graph, graph.links[i], graph.metadata[i]);
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
function sidewalkPolyline(points, side, widthM, marginM) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next.x - previous.x;
    let dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const { x, z, leftM = widthM / 2 } = points[i];
    const offset = side * ((side === 1 ? leftM : widthM - leftM) + marginM);
    result.push({ x: x + dz * offset, z: z - dx * offset });
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

function turn(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

// 与 js/sz-roads.js 的路面网格同源：有复核断面的路按 crossSection 的左右边取宽度，
// 共用 OSM 节点的路口按各臂端断面的凸包补面，相邻段外侧再补斜接三角形。
// 这样人物避让的车行道范围与实际画出来的沥青是同一份几何，不会在路口切过路面。
// ux、uz 是单位方向；leftM 是该站点到左路缘的米数（无复核断面时取半宽）。
function sectionEdges(point, ux, uz, widthM) {
  const left = point.leftM ?? widthM / 2;
  const right = widthM - left;
  return [
    { x: point.x + uz * left, z: point.z - ux * left },
    { x: point.x - uz * right, z: point.z + ux * right }
  ];
}

// 凸多边形存成朝外的半平面：点在内侧时 signed <= 0；查询时用 margin 把边向外推。
function barrierPolygon(points) {
  const ring = [];
  for (const point of points) {
    const last = ring[ring.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-7 && Math.abs(last.z - point.z) < 1e-7) continue;
    ring.push({ x: point.x, z: point.z });
  }
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.abs(first.x - last.x) < 1e-7 && Math.abs(first.z - last.z) < 1e-7) ring.pop();
  }
  if (ring.length < 3) return null;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
  }
  if (Math.abs(area) < 1e-6) return null;
  if (area < 0) ring.reverse();
  const edges = [];
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < EPSILON) continue;
    const nx = dz / length;
    const nz = -dx / length;
    edges.push({ nx, nz, c: nx * a.x + nz * a.z });
    if (a.x < bounds.minX) bounds.minX = a.x;
    if (a.x > bounds.maxX) bounds.maxX = a.x;
    if (a.z < bounds.minZ) bounds.minZ = a.z;
    if (a.z > bounds.maxZ) bounds.maxZ = a.z;
  }
  return edges.length >= 3 ? { edges, bounds } : null;
}

export function createCarriagewayBarrier(graph, options = {}) {
  if (!graph || !Array.isArray(graph.links) || !Array.isArray(graph.metadata)) {
    throw new Error('Carriageway barrier requires a road graph');
  }
  const cellSize = options.cellSize ?? BARRIER_CELL;
  const extendM = options.linkExtendM ?? 40;
  const bounds = options.bounds ? {
    minX: options.bounds.minX - extendM, minZ: options.bounds.minZ - extendM,
    maxX: options.bounds.maxX + extendM, maxZ: options.bounds.maxZ + extendM
  } : null;
  const boxes = linkBoundsCache(graph);
  const cells = new Map();
  let polygons = 0;
  function add(points) {
    const polygon = barrierPolygon(points);
    if (!polygon) return;
    const { minX, minZ, maxX, maxZ } = polygon.bounds;
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x++) {
      for (let z = Math.floor(minZ / cellSize); z <= Math.floor(maxZ / cellSize); z++) {
        const key = cellKey(x, z);
        let list = cells.get(key);
        if (!list) cells.set(key, list = []);
        list.push(polygon);
      }
    }
    polygons++;
  }
  const included = [];
  const touched = new Set();
  for (let index = 0; index < graph.links.length; index++) {
    if (!isGroundRoad(graph.metadata[index])) continue;
    if (bounds && !boundsOverlap(boxes[index], bounds)) continue;
    included.push(index);
    touched.add(graph.links[index][0]);
    touched.add(graph.links[index][1]);
  }
  for (const index of included) {
    const link = graph.links[index];
    const stations = roadSectionPoints(graph, link, graph.metadata[index]);
    if (stations.length < 2) continue;
    let previous = null;
    for (let i = 1; i < stations.length; i++) {
      const a = stations[i - 1];
      const b = stations[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < EPSILON) continue;
      const ux = dx / length;
      const uz = dz / length;
      const start = sectionEdges(a, ux, uz, link[3]);
      const end = sectionEdges(b, ux, uz, link[3]);
      add([start[0], end[0], end[1], start[1]]);
      if (previous) {
        const change = previous.ux * uz - previous.uz * ux;
        const side = change > 0 ? 0 : 1;
        const before = previous.end[side];
        const after = start[side];
        if (Math.abs(turn(a, before, after)) > EPSILON) add(change > 0 ? [a, before, after] : [a, after, before]);
      }
      previous = { ux, uz, end };
    }
  }
  // 共用节点路口补面：与 indexRoadFootprints 一样取各臂端断面的凸包，臂可以来自区域外的路。
  if (touched.size > 0) {
    const arms = new Map();
    for (let index = 0; index < graph.links.length; index++) {
      const metadata = graph.metadata[index];
      if (!isGroundRoad(metadata)) continue;
      const link = graph.links[index];
      if (!touched.has(link[0]) && !touched.has(link[1])) continue;
      const stations = roadSectionPoints(graph, link, metadata);
      if (stations.length < 2) continue;
      const addArm = (from, to, atStart, node) => {
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const length = Math.hypot(dx, dz);
        if (length < EPSILON) return;
        const points = sectionEdges(atStart ? from : to, dx / length, dz / length, link[3]);
        let list = arms.get(node);
        if (!list) arms.set(node, list = []);
        list.push(...points);
      };
      if (touched.has(link[0])) addArm(stations[0], stations[1], true, link[0]);
      if (touched.has(link[1])) addArm(stations.at(-2), stations.at(-1), false, link[1]);
    }
    for (const points of arms.values()) {
      if (points.length < 4) continue;
      const hull = convexHull(points);
      if (hull.length >= 3) add(hull);
    }
  }
  function contains(x, z, marginM = 0) {
    const list = cells.get(cellKey(Math.floor(x / cellSize), Math.floor(z / cellSize)));
    if (!list) return false;
    for (const polygon of list) {
      const { minX, minZ, maxX, maxZ } = polygon.bounds;
      if (x < minX - marginM || x > maxX + marginM || z < minZ - marginM || z > maxZ + marginM) continue;
      let inside = true;
      for (const edge of polygon.edges) {
        if (edge.nx * x + edge.nz * z - edge.c > marginM) {
          inside = false;
          break;
        }
      }
      if (inside) return true;
    }
    return false;
  }
  return { polygons, cells, cellSize, contains };
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

function onRaisedSidewalk({ heightAt, groundHeight }, x, z) {
  if (typeof groundHeight !== 'function') return false;
  const base = groundHeight(x, z), top = heightAt(x, z);
  return Number.isFinite(base) && Number.isFinite(top) && top - base >= 0.06 && top - base <= 0.18;
}

function walkableRuns(points, cfg, heightAt, colliderIndex, barrier, statistics, raisedOnly = false) {
  const runs = [];
  let current = [];
  let lastY = null;
  for (let i = 0; i < points.length; i++) {
    let point = points[i];
    let raised = onRaisedSidewalk(cfg, point.x, point.z);
    if (!raised && typeof cfg.groundHeight === 'function') {
      const tangent = tangentAt(points, i);
      for (const offset of [0.5, -0.5, 1, -1]) {
        const x = point.x + tangent.dz * offset, z = point.z - tangent.dx * offset;
        if (barrier?.contains(x, z, cfg.carriagewayClearanceM) || !onRaisedSidewalk(cfg, x, z)) continue;
        point = { x, z };
        raised = true;
        break;
      }
    }
    const y = heightAt(point.x, point.z);
    let blocked = !Number.isFinite(y) || (raisedOnly && !raised);
    if (!blocked && lastY !== null && Math.abs(y - lastY) > cfg.maxStepRiseM) blocked = true;
    if (!blocked && barrier && barrier.contains(point.x, point.z, cfg.carriagewayClearanceM)) {
      blocked = true;
      statistics.carriagewayBlockedSamples++;
    }
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
    colliderBlockedSamples: 0, carriagewayBlockedSamples: 0, rejectedRuns: 0, tracks: 0,
    walkableMeters: 0, colliderIndexed: colliderIndex.indexed };
  const boxes = linkBoundsCache(graph);
  let nextId = 0;
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    statistics.groundLinks++;
    const raisedOnly = excluded.has(metadata.highway);
    if (raisedOnly && typeof cfg.groundHeight !== 'function') continue;
    const link = graph.links[index];
    if (!(link[3] > 0)) continue;
    const widthM = link[3];
    if (bounds) {
      const box = boxes[index];
      const pad = widthM + cfg.walkMarginM;
      if (!boundsOverlap({ minX: box.minX - pad, maxX: box.maxX + pad,
        minZ: box.minZ - pad, maxZ: box.maxZ + pad }, bounds)) continue;
    }
    statistics.candidateLinks++;
    const centerline = roadSectionPoints(graph, link, metadata);
    if (centerline.length < 2) continue;
    for (const side of [1, -1]) {
      const sidewalk = sidewalkPolyline(centerline, side, widthM, cfg.walkMarginM);
      const runs = bounds ? clipPolyline(sidewalk, bounds) : [sidewalk];
      statistics.clippedRuns += runs.length;
      for (const run of runs) {
        if (trackLength(run) < 0.5) continue;
        const line = resamplePolyline(run, cfg.sampleStepM);
        for (const points of walkableRuns(line, cfg, cfg.heightAt, colliderIndex, barrier, statistics, raisedOnly)) {
          const length = trackLength(points);
          if (length < cfg.minRunLengthM) {
            statistics.rejectedRuns++;
            continue;
          }
          tracks.push(makeTrack(points, 'sidewalk', { id: `walk:${nextId++}`, linkIndex: index, side,
            highway: metadata.highway, widthM }));
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
  const clearance = cfg.connectorCarriagewayClearanceM;
  if (barrier && (barrier.contains(a.x, a.z, clearance) || barrier.contains(b.x, b.z, clearance))) return null;
  // 连接线只用于过弯：按约 1.2 m 一段逐点验证，绝不允许压到车行道或建筑上。
  const steps = Math.max(2, Math.ceil(length / cfg.connectorStepM));
  const midY = heightAt(a.x + dx * 0.5, a.z + dz * 0.5);
  if (!Number.isFinite(midY)) return null;
  const points = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const y = a.y + (b.y - a.y) * t;
    if (Math.abs(midY - y) > cfg.maxStepRiseM) return null;
    if (barrier && barrier.contains(x, z, clearance)) return null;
    if (colliderAt(colliderIndex, x, z, y, cfg.colliderRadiusM, cfg.colliderHeightM)) return null;
    points.push({ x, z, y });
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
  const barrier = cfg.barrier ?? (cfg.graph
    ? createCarriagewayBarrier(cfg.graph, { bounds: cfg.bounds ?? null, linkExtendM: cfg.barrierLinkExtendM })
    : null);
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

// 每条腿的铺装抬升加 0–1.5 mm 的确定性错位，避免相邻腿/分叉处共面闪烁。
function legStagger(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return ((hash % 1000) / 1000) * 0.0015;
}
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
  const barrier = cfg.barrier ?? null;
  const clearance = cfg.pavementCarriagewayClearanceM;
  const positions = [];
  const colors = [];
  const statistics = { triangles: 0, areaM2: 0, clampedSamples: 0, blankRows: 0, carriagewaySkipped: 0 };
  for (const leg of legs) {
    if (!leg || leg.length < 2) continue;
    const source = [];
    for (let s = 0; s < leg.length; s += step) source.push(sampleTrack(leg, s, {}));
    source.push(sampleTrack(leg, leg.length, {}));
    if (source.length < 2) continue;
    const rise = (leg.kind === 'corner' ? cfg.cornerPavementRiseM : cfg.surfaceRiseM) + legStagger(leg.id);
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
      // 整条带（两边 + 中线）都必须离沥青有正间隙，才把这一排画出来。
      const blocked = onRaisedSidewalk(cfg, point.x, point.z) || onRaisedSidewalk(cfg, leftX, leftZ)
        || onRaisedSidewalk(cfg, rightX, rightZ)
        || (barrier && (barrier.contains(leftX, leftZ, clearance) || barrier.contains(rightX, rightZ, clearance)
          || barrier.contains(point.x, point.z, clearance)));
      rows.push({
        left: { x: leftX, z: leftZ, y: (Number.isFinite(leftY) ? leftY : y) + rise, width: leftWidth },
        right: { x: rightX, z: rightZ, y: (Number.isFinite(rightY) ? rightY : y) + rise, width: rightWidth },
        blocked
      });
    }
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (!a || !b) {
        statistics.carriagewaySkipped++;
        continue;
      }
      if (a.blocked || b.blocked) {
        statistics.carriagewaySkipped++;
        continue;
      }
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
  const barrier = createCarriagewayBarrier(graph, { bounds, linkExtendM: cfg.barrierLinkExtendM });
  const built = buildSidewalkTracks(graph, { ...cfg, colliderIndex, barrier });
  const connected = connectTracks(built.tracks, { ...cfg, colliderIndex, barrier });
  const legs = [...built.tracks, ...connected.connectors];
  const pavement = cfg.pavement
    ? buildPavementRibbons(legs, { ...cfg, colliderIndex, barrier })
    : { positions: new Float32Array(0), colors: new Float32Array(0), statistics: { triangles: 0, areaM2: 0, clampedSamples: 0, carriagewaySkipped: 0 } };
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
      pavementCarriagewaySkipped: pavement.statistics.carriagewaySkipped,
      barrierPolygons: barrier.polygons,
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
