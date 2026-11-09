import * as THREE from 'three/webgpu';
import { GeoBuilder } from './sz-geometry.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';
import { polygonContains, polygonBoxOverlaps } from './building-collision.js';
import * as szMaterials from './sz-materials.js';

// 普通楼近景细节：女儿墙、屋顶设备（含水箱/天线/航空障碍灯）、住宅阳台、空调外机、入口雨棚。
// 细节只影响外观，不参与碰撞、不改建筑身份/楼高/足迹；高度基准一律取 buildingPlacement()。
// 流式规则：200 m 分块，块中心距玩家 <650 m 生成、>850 m 卸载，每帧最多生成/重建 2 块；
// 每块给最近的至多 40 栋做完整近景，其余只做女儿墙 + 一个便宜屋顶盒，远处减细节但屋顶不秃。
const DETAIL_CHUNK_SIZE = 200;
const GENERATE_RADIUS = 650;
const DISPOSE_RADIUS = 850;
const BALCONY_RADIUS = 250;
const AC_RADIUS = 200;
const CANOPY_RADIUS = 250;
// 玩家靠近到阈值以内时重建该块，让阳台/空调外机在近处出现；只升级不降级，避免来回抖动。
const REBUILD_MARGIN = 30;
const MAX_CHUNKS_PER_UPDATE = 2;
const MAX_CHUNK_TRIANGLES = 45000;
// 每块只给最近的至多 40 栋做完整近景（阳台/空调/雨棚），其余只做女儿墙，
// 保证单块生成时间有界；密排城中村一个 200 m 块可能有两百栋、每栋几十层。
const MAX_FULL_DETAIL_BUILDINGS = 40;
// 每帧生成预算：一块很贵时本帧不再开第二块，把生成摊到后续帧，避免长卡顿。
const MAX_GENERATION_MS = 10;
const MAX_BALCONIES = 30;
const MAX_AC_UNITS = 16;
const PARAPET_INSET = 0.15;
const PARAPET_THICKNESS = 0.2;
const TANK_SIDES = 8;
const NEIGHBOUR_CELL = 64;

// 细节网格按立面类型合并成 4 组材质（每块最多 4 个 mesh）。
const FACADE_ORDER = ['glass_tower', 'office', 'residential_tower', 'residential_low', 'village', 'industrial', 'public', 'landmark'];

// 立面条带优先复用 js/sz-materials.js 导出的 FACADE_PROFILES（开间/层高与立面着色器同源）；
// 本地表是旧版/单测桩的兜底，取值来自 docs/04 与 sz-materials.js 早期的 BAY/FLOOR 表。
const LOCAL_FACADE_PROFILES = {
  glass_tower: { bayWidth: 1.6, floorHeight: 4.2 },
  office: { bayWidth: 3.0, floorHeight: 3.9 },
  residential_tower: { bayWidth: 3.4, floorHeight: 3.0 },
  residential_low: { bayWidth: 3.2, floorHeight: 3.0 },
  village: { bayWidth: 2.6, floorHeight: 2.9 },
  industrial: { bayWidth: 6.0, floorHeight: 6.0 },
  public: { bayWidth: 4.0, floorHeight: 4.5 },
  landmark: { bayWidth: 1.5, floorHeight: 4.4 }
};
const FACADE_BUCKET = new Map([
  ['residential_tower', 0], ['residential_low', 0],
  ['village', 1],
  ['office', 2], ['industrial', 2], ['public', 2],
  ['glass_tower', 3], ['landmark', 3]
]);
const BUCKET_COLORS = [0xd6cfc2, 0xd3d5d0, 0xb9bec2, 0x99a4ae];
const BUCKET_NAMES = ['residential', 'village', 'office', 'glass'];

// 女儿墙/阳台/设备盒的颜色取各立面 trim（没有就 wallA）的桶内均值，跟 sz-materials 的立面配色保持一致。
function bucketColors() {
  const shared = szMaterials.FACADE_PROFILES;
  if (!Array.isArray(shared)) return BUCKET_COLORS;
  const sums = BUCKET_COLORS.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (const facade of FACADE_ORDER) {
    const profile = shared.find(item => item?.name === facade) ?? shared[FACADE_ORDER.indexOf(facade)];
    const hex = profile?.trim ?? profile?.wallA;
    if (!Number.isInteger(hex)) continue;
    const sum = sums[FACADE_BUCKET.get(facade)];
    sum.r += (hex >> 16) & 255;
    sum.g += (hex >> 8) & 255;
    sum.b += hex & 255;
    sum.n++;
  }
  return sums.map((sum, index) => (sum.n === 0 ? BUCKET_COLORS[index]
    : (Math.round(sum.r / sum.n) << 16) | (Math.round(sum.g / sum.n) << 8) | Math.round(sum.b / sum.n)));
}

const RESIDENTIAL_FACADES = new Set(['residential_tower', 'residential_low']);
const GROUND_AC_FACADES = new Set(['residential_tower', 'residential_low', 'village']);

const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now() : Date.now());

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function facadeProfile(facade) {
  const shared = szMaterials.FACADE_PROFILES;
  let sharedProfile = null;
  if (Array.isArray(shared)) {
    sharedProfile = shared.find(item => item?.name === facade) ?? shared[FACADE_ORDER.indexOf(facade)];
  } else if (shared && typeof shared === 'object') {
    sharedProfile = shared[facade];
  }
  const local = LOCAL_FACADE_PROFILES[facade] ?? LOCAL_FACADE_PROFILES.village;
  const bayWidth = Number(sharedProfile?.bayWidth);
  const floorHeight = Number(sharedProfile?.floorHeight);
  return {
    bayWidth: Number.isFinite(bayWidth) && bayWidth >= 1 ? bayWidth : local.bayWidth,
    floorHeight: Number.isFinite(floorHeight) && floorHeight >= 2 ? floorHeight : local.floorHeight
  };
}

function facadeBucket(facade) {
  const bucket = FACADE_BUCKET.get(facade);
  if (bucket === undefined) throw new Error(`Unhandled facade type: ${facade}`);
  return bucket;
}

// ---------------- 平面与朝向工具 ----------------

function signedRingArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  }
  return sum / 2;
}

function polygonArea(polygon) {
  const holes = polygon.holes ?? [];
  return Math.abs(signedRingArea(polygon.outer))
    - holes.reduce((sum, hole) => sum + Math.abs(signedRingArea(hole)), 0);
}

function largestPolygon(polygons) {
  if (!Array.isArray(polygons) || polygons.length === 0) return null;
  let best = null;
  let bestArea = -Infinity;
  for (const polygon of polygons) {
    if (!polygon?.outer || polygon.outer.length < 3) continue;
    const area = polygonArea(polygon);
    if (area > bestArea) { best = polygon; bestArea = area; }
  }
  return best;
}

// 外环每条边：u 为沿边方向，out 为朝外法线，yaw 让局部 x 轴沿墙。
function ringEdges(polygon) {
  const ring = polygon.outer;
  const ccw = signedRingArea(ring) > 0;
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) continue;
    const ux = dx / length;
    const uz = dz / length;
    // 逆时针环内侧在左（-uz, ux），外法线取反。
    const inX = ccw ? -uz : uz;
    const inZ = ccw ? ux : -ux;
    edges.push({
      ax: a.x, az: a.z, bx: c.x, bz: c.z, length, ux, uz,
      inX, inZ, outX: -inX, outZ: -inZ,
      mx: (a.x + c.x) / 2, mz: (a.z + c.z) / 2,
      yaw: Math.atan2(uz, ux)
    });
  }
  return edges;
}

// 局部 u 轴 = (cs, -sn)，和 ref/building-details.js 的 containsBox 框架一致。
function boxCorners(x, z, w, d, cs, sn) {
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([u, v]) => ({ x: x + u * cs + v * sn, z: z - u * sn + v * cs }));
}

function toLocal(x, z, cx, cz, cs, sn) {
  const dx = x - cx;
  const dz = z - cz;
  return { u: dx * cs - dz * sn, v: dx * sn + dz * cs };
}

function toWorld(u, v, cx, cz, cs, sn) {
  return { x: cx + u * cs + v * sn, z: cz - u * sn + v * cs };
}

// 旋转矩形四角都在屋面多边形内，且边不穿内院孔洞；只查角点会漏掉凹口和孔洞。
function containsBox(polygon, x, z, w, d, cs, sn) {
  if (!boxCorners(x, z, w, d, cs, sn).every(corner => polygonContains(polygon, corner.x, corner.z))) return false;
  const hx = w / 2;
  const hz = d / 2;
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ax = (a.x - x) * cs - (a.z - z) * sn;
      const az = (a.x - x) * sn + (a.z - z) * cs;
      const bx = (b.x - x) * cs - (b.z - z) * sn;
      const bz = (b.x - x) * sn + (b.z - z) * cs;
      if (Math.abs(ax) < hx && Math.abs(az) < hz) return false;
      for (const u of [-hx, hx]) {
        const t = (u - ax) / (bx - ax);
        if (t >= 0 && t <= 1 && Math.abs(az + (bz - az) * t) < hz) return false;
      }
      for (const v of [-hz, hz]) {
        const t = (v - az) / (bz - az);
        if (t >= 0 && t <= 1 && Math.abs(ax + (bx - ax) * t) < hx) return false;
      }
    }
  }
  return true;
}

function createRandom(seed) {
  let state = Math.floor(seed * 4294967296) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- 邻楼索引：细节摆放避让，不参与碰撞 ----------------

class NeighbourIndex {
  constructor(buildings, terrain) {
    this.terrain = terrain;
    this.cells = new Map();
    this.placements = new Map();
    for (const building of buildings) {
      const minX = Number.isFinite(building.minX) ? building.minX : building.cx - 10;
      const maxX = Number.isFinite(building.maxX) ? building.maxX : building.cx + 10;
      const minZ = Number.isFinite(building.minZ) ? building.minZ : building.cz - 10;
      const maxZ = Number.isFinite(building.maxZ) ? building.maxZ : building.cz + 10;
      for (let ix = Math.floor(minX / NEIGHBOUR_CELL); ix <= Math.floor(maxX / NEIGHBOUR_CELL); ix++) {
        for (let iz = Math.floor(minZ / NEIGHBOUR_CELL); iz <= Math.floor(maxZ / NEIGHBOUR_CELL); iz++) {
          const key = `${ix},${iz}`;
          let cell = this.cells.get(key);
          if (!cell) this.cells.set(key, (cell = []));
          cell.push(building);
        }
      }
    }
  }

  placementOf(building) {
    let placement = this.placements.get(building);
    if (!placement) {
      placement = buildingPlacement(building, this.terrain);
      this.placements.set(building, placement);
    }
    return placement;
  }

  near(x, z, radius) {
    const out = new Set();
    const x0 = Math.floor((x - radius) / NEIGHBOUR_CELL);
    const x1 = Math.floor((x + radius) / NEIGHBOUR_CELL);
    const z0 = Math.floor((z - radius) / NEIGHBOUR_CELL);
    const z1 = Math.floor((z + radius) / NEIGHBOUR_CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.cells.get(`${ix},${iz}`);
        if (cell) for (const building of cell) out.add(building);
      }
    }
    return [...out];
  }
}

// 每栋楼只查一次邻楼，后面所有摆放检测复用；密排街区里这比逐候选点查网格快一个量级。
function collectNeighbourSpans(index, building) {
  if (!index) return null;
  const minX = Number.isFinite(building.minX) ? building.minX : building.cx;
  const maxX = Number.isFinite(building.maxX) ? building.maxX : building.cx;
  const minZ = Number.isFinite(building.minZ) ? building.minZ : building.cz;
  const maxZ = Number.isFinite(building.maxZ) ? building.maxZ : building.cz;
  const radius = Math.max((maxX - minX) / 2, (maxZ - minZ) / 2, 10) + 12;
  return index.near(building.cx, building.cz, radius).map(other => ({
    building: other,
    placement: index.placementOf(other),
    minX: Number.isFinite(other.minX) ? other.minX : other.cx - 10,
    maxX: Number.isFinite(other.maxX) ? other.maxX : other.cx + 10,
    minZ: Number.isFinite(other.minZ) ? other.minZ : other.cz - 10,
    maxZ: Number.isFinite(other.maxZ) ? other.maxZ : other.cz + 10,
    polygons: other.polygons
  }));
}

function blockedByNeighbours(spans, building, x, z, w, d, cs, sn, y0, y1) {
  if (!spans) return false;
  const reach = Math.hypot(w, d) / 2 + 0.5;
  for (const span of spans) {
    if (span.building === building) continue;
    if (x + reach < span.minX || x - reach > span.maxX || z + reach < span.minZ || z - reach > span.maxZ) continue;
    const placement = span.placement;
    // 竖向区间不相交的邻楼不会遮挡本细节。
    if (placement.maxY <= y0 + 0.05 || placement.minY >= y1 - 0.05) continue;
    for (const polygon of span.polygons) {
      if (polygonBoxOverlaps(polygon, x, z, w / 2 + 0.05, d / 2 + 0.05, cs, sn)) return true;
    }
  }
  return false;
}

// ---------------- 单栋细节规划（纯函数，按 building.id 固定种子） ----------------

function floorMetrics(building, profile) {
  const top = building.height;
  const bottom = Number.isFinite(building.minHeight) ? building.minHeight : 0;
  const extent = Math.max(0, top - bottom);
  const levels = Number.isInteger(building.levels) && building.levels > 0 ? building.levels : -1;
  let floorHeight = profile.floorHeight;
  if (levels > 0) {
    const fromLevels = extent / levels;
    // 层数是源数据，但换算出的层高只用于外观节奏；明显不合理时回退立面表，不改楼高。
    if (Number.isFinite(fromLevels) && fromLevels >= 2.2 && fromLevels <= 8) floorHeight = fromLevels;
  }
  const floors = levels > 0 ? levels : Math.max(1, Math.round(extent / floorHeight));
  return { floorHeight, floors: clamp(floors, 1, 200) };
}

function roofSampler(polygon, polygonEdges) {
  const center = polygon.outer.reduce((acc, point) => ({ x: acc.x + point.x / polygon.outer.length, z: acc.z + point.z / polygon.outer.length }),
    { x: 0, z: 0 });
  const edges = polygonEdges.slice().sort((a, b) => b.length - a.length);
  const cs = edges.length ? edges[0].ux : 1;
  const sn = edges.length ? -edges[0].uz : 0;
  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (const point of polygon.outer) {
    const local = toLocal(point.x, point.z, center.x, center.z, cs, sn);
    minU = Math.min(minU, local.u); maxU = Math.max(maxU, local.u);
    minV = Math.min(minV, local.v); maxV = Math.max(maxV, local.v);
  }
  return (w, d, rand) => {
    if (maxU - minU < w + 2 || maxV - minV < d + 2) return null;
    const u = minU + w / 2 + 0.5 + rand() * (maxU - minU - w - 1);
    const v = minV + d / 2 + 0.5 + rand() * (maxV - minV - d - 1);
    const world = toWorld(u, v, center.x, center.z, cs, sn);
    return { x: world.x, z: world.z, cs, sn, yaw: Math.atan2(-sn, cs) };
  };
}

function planRoofParts(building, polygon, placement, rand, facade, options) {
  const parts = [];
  const aerialLights = [];
  if (building.height < 12) return { parts, aerialLights };
  const neighbours = options.neighbours;
  const roofY = placement.maxY;
  const sampler = roofSampler(polygon, options.polygonEdges ?? ringEdges(polygon));
  const occupied = [];
  const blocked = (x, z, w, d, cs, sn, height) => blockedByNeighbours(neighbours, building,
    x, z, w, d, cs, sn, roofY, roofY + height);
  function findSpot(w, d, height) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const spot = sampler(w, d, rand);
      if (!spot) return null;
      if (!containsBox(polygon, spot.x, spot.z, w + 0.6, d + 0.6, spot.cs, spot.sn)) continue;
      if (blocked(spot.x, spot.z, w, d, spot.cs, spot.sn, height)) continue;
      const overlaps = occupied.some(item => {
        const corners = boxCorners(item.x, item.z, item.w, item.d, item.cs, item.sn);
        return polygonBoxOverlaps({ outer: corners, holes: [] }, spot.x, spot.z, w / 2 + 0.4, d / 2 + 0.4, spot.cs, spot.sn);
      });
      if (overlaps) continue;
      occupied.push({ x: spot.x, z: spot.z, w, d, cs: spot.cs, sn: spot.sn });
      return spot;
    }
    return null;
  }
  const cheap = options.cheapRoof === true;
  const attempts = cheap ? 3 : 8;
  const tankFacade = !cheap && (facade === 'residential_low' || facade === 'village');
  const equipmentCount = building.height >= 12 ? (cheap || rand() < 0.5 ? 1 : 2) : 0;
  const tankFirst = tankFacade && rand() < 0.4;
  for (let i = 0; i < equipmentCount; i++) {
    const wantTank = (tankFacade && (tankFirst ? i === 0 : rand() < 0.22));
    if (wantTank) {
      const spot = findSpot(2.4, 2.4, 2.6);
      if (spot) {
        parts.push({ kind: 'tank', x: spot.x, z: spot.z, y: roofY, radius: 1.2, h: 2.0 + rand() * 0.6, yaw: spot.yaw });
        continue;
      }
    }
    const w = 3 + rand() * 2;
    const d = 3 + rand() * 2;
    const h = 2.4 + rand() * 0.9;
    const spot = findSpot(w, d, h);
    if (!spot) continue;
    parts.push({ kind: 'machine', x: spot.x, z: spot.z, y: roofY, w, d, h, yaw: spot.yaw, grille: rand() < 0.7 });
  }
  if (building.height >= 150) {
    const h = 6 + rand() * 3;
    const spot = findSpot(0.6, 0.6, h);
    if (spot) {
      parts.push({ kind: 'antenna', x: spot.x, z: spot.z, y: roofY, w: 0.16, d: 0.16, h, yaw: spot.yaw });
      aerialLights.push({ x: spot.x, y: roofY + h + 0.3, z: spot.z });
    }
  }
  return { parts, aerialLights };
}

function planParapet(polygon, polygonEdges, building, rand) {
  if (building.height < 8) return { height: 0, parts: [] };
  const height = 0.8 + rand() * 0.4;
  const parts = [];
  for (const edge of polygonEdges) {
    // 沿外环内缩 0.15 m，留出屋面滴水边；厚度 0.2 m。
    const offset = PARAPET_INSET + PARAPET_THICKNESS / 2;
    const x = edge.mx + edge.inX * offset;
    const z = edge.mz + edge.inZ * offset;
    parts.push({ x, z, w: edge.length + PARAPET_THICKNESS, yaw: edge.yaw });
  }
  return { height, thickness: PARAPET_THICKNESS, inset: PARAPET_INSET, parts };
}

function blockedFacade(spans, building, edge, y0, y1) {
  const cx = edge.mx + edge.outX * 0.9;
  const cz = edge.mz + edge.outZ * 0.9;
  return blockedByNeighbours(spans, building, cx, cz, Math.min(edge.length, 8), 1.8, edge.ux, -edge.uz, y0, y1);
}

function planBalconies(building, edges, placement, rand, facade, floorHeight, floors, options) {
  const balconies = [];
  const usedEdges = new Set();
  if (!RESIDENTIAL_FACADES.has(facade)) return { balconies, usedEdges };
  const player = options.playerPosition;
  if (!player) return { balconies, usedEdges };
  if (Math.hypot(building.cx - player.x, building.cz - player.z) > BALCONY_RADIUS) return { balconies, usedEdges };
  const wallEdges = edges.filter(edge => edge.length >= 4).sort((a, b) => b.length - a.length);
  const profile = facadeProfile(facade);
  const step = Math.max(2.2, profile.bayWidth);
  const wallTop = placement.maxY - 0.4;
  for (const edge of wallEdges) {
    if (usedEdges.size >= 2) break;
    if (blockedFacade(options.neighbours, building, edge, placement.minY + floorHeight, wallTop)) continue;
    const width = Math.min(step * 0.86, 3.0);
    const depth = 1.1 + rand() * 0.2;
    const columns = [];
    for (let t = 1.2 + step / 2; t <= edge.length - 1.2; t += step) {
      if (rand() < 0.22) continue;
      columns.push(t);
    }
    if (!columns.length) continue;
    // 高层住宅的阳台从 2 层起，给首层入口牌和雨棚留出净空；低层住宅仍从 1 层起。
    const firstBalconyFloor = building.height >= 24 ? 2 : 1;
    let placed = false;
    for (const t of columns) {
      const wx = edge.ax + edge.ux * t;
      const wz = edge.az + edge.uz * t;
      // 同一列竖向位置相同，只需按整列高度查一次邻楼，避免逐层重复检测。
      if (blockedByNeighbours(options.neighbours, building, wx + edge.outX * depth * 0.5, wz + edge.outZ * depth * 0.5,
        width, depth, edge.ux, -edge.uz, placement.minY + floorHeight, wallTop)) continue;
      for (let floor = firstBalconyFloor; floor < floors; floor++) {
        const y = placement.minY + floorHeight * floor;
        if (y + 1.1 > wallTop) break;
        if (balconies.length >= MAX_BALCONIES) break;
        balconies.push({ x: wx, z: wz, y, w: width, d: depth, yaw: edge.yaw, outX: edge.outX, outZ: edge.outZ });
        placed = true;
      }
      if (balconies.length >= MAX_BALCONIES) break;
    }
    if (placed) usedEdges.add(edge);
  }
  return { balconies, usedEdges };
}

function planAcUnits(building, wallEdges, placement, rand, facade, floorHeight, floors, options, usedEdges) {
  const units = [];
  if (!GROUND_AC_FACADES.has(facade) && building.category !== 'residential') return units;
  const player = options.playerPosition;
  if (!player) return units;
  if (Math.hypot(building.cx - player.x, building.cz - player.z) > AC_RADIUS) return units;
  const allEdges = wallEdges.filter(edge => edge.length >= 3);
  const preferred = allEdges.filter(edge => !usedEdges.has(edge)).sort((a, b) => b.length - a.length);
  const edges = (preferred.length ? preferred : allEdges.sort((a, b) => b.length - a.length)).slice(0, 2);
  const profile = facadeProfile(facade);
  const step = Math.max(2.0, profile.bayWidth);
  // 层列位置抽样而不是穷举所有楼层×开间：城中村单栋可到 29 层，穷举会让密集块生成卡顿。
  const candidates = MAX_AC_UNITS * 4;
  for (const edge of edges) {
    const columnSpan = edge.length - 1.6 - step;
    if (columnSpan <= 0 || floors < 3) continue;
    for (let i = 0; i < candidates; i++) {
      if (units.length >= MAX_AC_UNITS) return units;
      if (rand() > 0.38) continue;
      const floor = 2 + Math.floor(rand() * Math.max(1, floors - 2));
      const y = placement.minY + floorHeight * (floor - 1) + floorHeight * 0.45;
      if (y + 0.5 > placement.maxY - 0.4) continue;
      const t = 0.8 + step / 2 + rand() * columnSpan;
      const wx = edge.ax + edge.ux * t;
      const wz = edge.az + edge.uz * t;
      if (blockedByNeighbours(options.neighbours, building, wx + edge.outX * 0.3, wz + edge.outZ * 0.3,
        1.1, 0.6, edge.ux, -edge.uz, y - 0.4, y + 0.4)) continue;
      units.push({ x: wx, z: wz, y, w: 0.9, h: 0.58, d: 0.42, yaw: edge.yaw, outX: edge.outX, outZ: edge.outZ });
    }
  }
  return units;
}

function planCanopy(building, wallEdges, placement, rand, facade, floorHeight, options, usedEdges) {
  const player = options.playerPosition;
  if (!player || building.height < 6) return null;
  if (Math.hypot(building.cx - player.x, building.cz - player.z) > CANOPY_RADIUS) return null;
  const allEdges = wallEdges.filter(edge => edge.length >= 5);
  const preferred = allEdges.filter(edge => !usedEdges.has(edge)).sort((a, b) => b.length - a.length);
  const edges = preferred.length ? preferred : allEdges.sort((a, b) => b.length - a.length);
  const y = placement.minY + clamp(floorHeight, 3.0, 4.2);
  for (const edge of edges) {
    const width = clamp(edge.length * 0.55, 3, 6.5);
    const depth = 2.2;
    if (blockedByNeighbours(options.neighbours, building, edge.mx + edge.outX * depth * 0.5,
      edge.mz + edge.outZ * depth * 0.5, width, depth, edge.ux, -edge.uz, y, y + 0.5)) continue;
    return { x: edge.mx, z: edge.mz, y, w: width, d: depth, yaw: edge.yaw, outX: edge.outX, outZ: edge.outZ };
  }
  return null;
}

// 供测试与诊断使用的纯规划函数：不建几何，按 id 固定种子，结果可复现。
export function planBuildingDetails(building, placement, options = {}) {
  if (!building || !placement) throw new Error('Missing building details input');
  const facade = building.facade;
  const profile = facadeProfile(facade);
  const bucket = facadeBucket(facade);
  const polygon = largestPolygon(building.polygons);
  if (!polygon) return null;
  const edges = ringEdges(polygon);
  // 邻楼只查一次；传入索引对象时在这里转成可直接过滤的竖向区间表。
  const spanSource = options.neighbours;
  // 便宜屋顶（名额外的远处楼）只放自己的屋面盒，跳过邻楼索引，避免密排块逐栋建邻楼表。
  const neighbourSpans = options.cheapRoof
    ? null
    : spanSource && typeof spanSource.near === 'function'
      ? collectNeighbourSpans(spanSource, building)
      : (Array.isArray(spanSource) ? spanSource : null);
  const planOptions = { ...options, neighbours: neighbourSpans, polygonEdges: edges };
  const rand = createRandom(buildingSeed(building.id));
  const { floorHeight, floors } = floorMetrics(building, profile);
  const allowFacadeDetails = options.allowFacadeDetails !== false;
  const allowRoofEquipment = options.allowRoofEquipment !== false;
  const parapet = planParapet(polygon, edges, building, createRandom(buildingSeed(building.id) * 0.71 + 0.13));
  const roof = allowRoofEquipment
    ? planRoofParts(building, polygon, placement, createRandom(buildingSeed(building.id) * 0.37 + 0.29), facade, planOptions)
    : { parts: [], aerialLights: [] };
  let balconies = [];
  let acUnits = [];
  let canopy = null;
  if (allowFacadeDetails) {
    const plan = planBalconies(building, edges, placement, rand, facade, floorHeight, floors, planOptions);
    balconies = plan.balconies;
    acUnits = planAcUnits(building, edges, placement, rand, facade, floorHeight, floors, planOptions, plan.usedEdges);
    canopy = planCanopy(building, edges, placement, rand, facade, floorHeight, planOptions, plan.usedEdges);
  }
  return {
    id: building.id, facade, bucket, roofY: placement.maxY, baseY: placement.minY,
    floorHeight, floors, parapet, roofParts: roof.parts, aerialLights: roof.aerialLights,
    balconies, acUnits, canopy
  };
}

// ---------------- 细节几何：全部合批到 GeoBuilder ----------------

function addTriangle(b, p0, p1, p2, nx, ny, nz) {
  const crossX = (p1.y - p0.y) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.y - p0.y);
  const crossY = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
  const crossZ = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  let a = p0;
  let c = p1;
  let d = p2;
  if (crossX * nx + crossY * ny + crossZ * nz < 0) { c = p2; d = p1; }
  const base = b.count;
  b.vertex(a.x, a.y, a.z, nx, ny, nz, 0, 0);
  b.vertex(c.x, c.y, c.z, nx, ny, nz, 0, 0);
  b.vertex(d.x, d.y, d.z, nx, ny, nz, 0, 0);
  b.tri(base, base + 1, base + 2);
}

function addQuad(b, points, nx, ny, nz) {
  const crossX = (points[1].y - points[0].y) * (points[2].z - points[0].z) - (points[1].z - points[0].z) * (points[2].y - points[0].y);
  const crossY = (points[1].z - points[0].z) * (points[2].x - points[0].x) - (points[1].x - points[0].x) * (points[2].z - points[0].z);
  const crossZ = (points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[1].y - points[0].y) * (points[2].x - points[0].x);
  const ordered = crossX * nx + crossY * ny + crossZ * nz < 0
    ? [points[0], points[3], points[2], points[1]] : points;
  const base = b.count;
  for (const point of ordered) b.vertex(point.x, point.y, point.z, nx, ny, nz, 0, 0);
  b.tri(base, base + 1, base + 2);
  b.tri(base, base + 2, base + 3);
}

// 以中心点 + 局部 u(沿墙)/n(垂直墙)/y 定义的盒子；法线显式给出，避免依赖环的绕序。
function addBox(b, x, y, z, w, h, d, yaw) {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const ux = cs;
  const uz = sn;
  const nx = -sn;
  const nz = cs;
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const point = (u, sy, v) => ({ x: x + ux * u + nx * v, y: y + sy, z: z + uz * u + nz * v });
  addQuad(b, [point(hw, -hh, -hd), point(hw, -hh, hd), point(hw, hh, hd), point(hw, hh, -hd)], ux, 0, uz);
  addQuad(b, [point(-hw, -hh, -hd), point(-hw, -hh, hd), point(-hw, hh, hd), point(-hw, hh, -hd)], -ux, 0, -uz);
  addQuad(b, [point(-hw, -hh, hd), point(hw, -hh, hd), point(hw, hh, hd), point(-hw, hh, hd)], nx, 0, nz);
  addQuad(b, [point(-hw, -hh, -hd), point(hw, -hh, -hd), point(hw, hh, -hd), point(-hw, hh, -hd)], -nx, 0, -nz);
  addQuad(b, [point(-hw, hh, -hd), point(hw, hh, -hd), point(hw, hh, hd), point(-hw, hh, hd)], 0, 1, 0);
  addQuad(b, [point(-hw, -hh, -hd), point(hw, -hh, -hd), point(hw, -hh, hd), point(-hw, -hh, hd)], 0, -1, 0);
}

const OCTAGON_STEP = (Math.PI * 2) / TANK_SIDES;

function addOctagonPrism(b, x, y, z, radius, height, yaw) {
  const ring = [];
  for (let k = 0; k < TANK_SIDES; k++) {
    const angle = yaw + k * OCTAGON_STEP;
    ring.push({ x: x + Math.cos(angle) * radius, y, z: z + Math.sin(angle) * radius });
  }
  for (let k = 0; k < TANK_SIDES; k++) {
    const a = ring[k];
    const c = ring[(k + 1) % TANK_SIDES];
    const topA = { x: a.x, y: y + height, z: a.z };
    const topC = { x: c.x, y: y + height, z: c.z };
    const nx = Math.cos(yaw + (k + 0.5) * OCTAGON_STEP);
    const nz = Math.sin(yaw + (k + 0.5) * OCTAGON_STEP);
    addQuad(b, [a, c, topC, topA], nx, 0, nz);
  }
  const topCenter = { x, y: y + height, z };
  for (let k = 0; k < TANK_SIDES; k++) {
    const a = ring[k];
    const c = ring[(k + 1) % TANK_SIDES];
    addTriangle(b, topCenter, { x: a.x, y: y + height, z: a.z }, { x: c.x, y: y + height, z: c.z }, 0, 1, 0);
  }
}

function appendParapet(b, parapet, roofY) {
  for (const part of parapet.parts) {
    addBox(b, part.x, roofY + parapet.height / 2, part.z, part.w, parapet.height, parapet.thickness, part.yaw);
  }
}

function appendRoofPart(b, part, roofY) {
  if (part.kind === 'machine') {
    addBox(b, part.x, roofY + part.h / 2, part.z, part.w, part.h, part.d, part.yaw);
    if (part.grille) {
      // 通风格栅：贴设备房一面薄板，不改变碰撞。
      const ux = Math.cos(part.yaw);
      const uz = Math.sin(part.yaw);
      const offset = part.w / 2 + 0.05;
      addBox(b, part.x + ux * offset, roofY + part.h * 0.55, part.z + uz * offset, 0.07, 0.9, part.d * 0.45, part.yaw);
    }
    return;
  }
  if (part.kind === 'tank') {
    addOctagonPrism(b, part.x, roofY, part.z, part.radius, part.h, part.yaw);
    return;
  }
  if (part.kind === 'antenna') {
    addBox(b, part.x, roofY + part.h / 2, part.z, part.w, part.h, part.d, part.yaw);
    return;
  }
  throw new Error(`Unhandled roof part kind: ${part.kind}`);
}

function appendBalcony(b, balcony) {
  const { x, z, y, w, d, yaw, outX, outZ } = balcony;
  const ux = Math.cos(yaw);
  const uz = Math.sin(yaw);
  // 外挑板
  addBox(b, x + outX * d * 0.5, y - 0.08, z + outZ * d * 0.5, w, 0.16, d, yaw);
  // 正面做镂空栏杆：上下横杆 + 三根立柱，近看能透光，不再是一块实心方盒。
  // 栏杆件只有这一列阳台会用到；单块三角面超预算时由分块裁剪器整体减楼。
  addBox(b, x + outX * (d - 0.05), y + 0.13, z + outZ * (d - 0.05), w, 0.07, 0.06, yaw);
  addBox(b, x + outX * (d - 0.03), y + 0.9, z + outZ * (d - 0.03), w, 0.06, 0.12, yaw);
  for (const offset of [-1, 0, 1]) {
    addBox(b, x + ux * offset * (w / 2 - 0.25) + outX * (d - 0.05), y + 0.52,
      z + uz * offset * (w / 2 - 0.25) + outZ * (d - 0.05), 0.06, 0.78, 0.06, yaw);
  }
  // 两侧栏板保留薄板，挡住栏杆端头。
  for (const sign of [-1, 1]) {
    addBox(b, x + ux * sign * (w / 2 - 0.04) + outX * d * 0.5, y + 0.42,
      z + uz * sign * (w / 2 - 0.04) + outZ * d * 0.5, 0.06, 0.84, d, yaw);
  }
}

function appendAcUnit(b, unit) {
  addBox(b, unit.x + unit.outX * 0.22, unit.y, unit.z + unit.outZ * 0.22, unit.w, unit.h, unit.d, unit.yaw);
}

function appendCanopy(b, canopy) {
  const { x, z, y, w, d, yaw, outX, outZ } = canopy;
  const ux = Math.cos(yaw);
  const uz = Math.sin(yaw);
  addBox(b, x + outX * d * 0.5, y - 0.09, z + outZ * d * 0.5, w, 0.18, d, yaw);
  // 两侧贴墙的薄托板，离地 >3 m，不阻挡通行
  for (const sign of [-1, 1]) {
    addBox(b, x + ux * sign * (w / 2 - 0.3) + outX * 0.3, y - 0.43,
      z + uz * sign * (w / 2 - 0.3) + outZ * 0.3, 0.12, 0.5, 0.6, yaw);
  }
}

function appendPlanGeometry(builders, plan) {
  const b = builders[plan.bucket];
  const before = b.idx.length;
  appendParapet(b, plan.parapet, plan.roofY);
  for (const part of plan.roofParts) appendRoofPart(b, part, plan.roofY);
  for (const balcony of plan.balconies) appendBalcony(b, balcony);
  for (const unit of plan.acUnits) appendAcUnit(b, unit);
  if (plan.canopy) appendCanopy(b, plan.canopy);
  return (b.idx.length - before) / 3;
}

// 用于写入 statistics 的三角面估算；实际数字以合并后的 index 数为准。
function estimatePlanTriangles(plan) {
  let triangles = plan.parapet.parts.length * 12;
  for (const part of plan.roofParts) {
    if (part.kind === 'machine') triangles += part.grille ? 24 : 12;
    else if (part.kind === 'tank') triangles += TANK_SIDES * 3;
    else triangles += 12;
  }
  triangles += plan.balconies.length * 48;
  triangles += plan.acUnits.length * 12;
  if (plan.canopy) triangles += 36;
  return triangles;
}

// ---------------- 主入口：分块流式加载 ----------------

export function buildBuildingDetails(scene, options = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Missing scene for building details');
  const buildings = options.buildings ?? [];
  const terrain = options.terrain;
  if (!Array.isArray(buildings)) throw new Error('Building details require a building list');
  if (!terrain) throw new Error('Missing terrain for building details');
  const skipIds = options.skipIds instanceof Set ? options.skipIds : new Set(options.skipIds ?? []);
  const chunkSize = options.chunkSize ?? DETAIL_CHUNK_SIZE;
  const generateRadius = options.generateRadius ?? GENERATE_RADIUS;
  const disposeRadius = options.disposeRadius ?? DISPOSE_RADIUS;
  const maxChunksPerUpdate = options.maxChunksPerUpdate ?? MAX_CHUNKS_PER_UPDATE;
  const maxChunkTriangles = options.maxChunkTriangles ?? MAX_CHUNK_TRIANGLES;
  const maxFullDetailBuildings = options.maxFullDetailBuildings ?? MAX_FULL_DETAIL_BUILDINGS;
  const maxGenerationMs = options.maxGenerationMs ?? MAX_GENERATION_MS;
  if (!(disposeRadius > generateRadius)) throw new Error('Dispose radius must exceed generate radius');

  const index = new NeighbourIndex(buildings, terrain);
  // 地标专模自己会建屋顶和设备，地标覆盖的普通楼一律不出细节，避免重叠。
  const shouldSkip = building => skipIds.has(building.id) || building.facade === 'landmark' || Boolean(building.landmark);
  const chunkIndex = new Map();
  for (const building of buildings) {
    if (shouldSkip(building)) continue;
    const ix = Math.floor(building.cx / chunkSize);
    const iz = Math.floor(building.cz / chunkSize);
    const key = `${ix},${iz}`;
    let chunk = chunkIndex.get(key);
    if (!chunk) {
      chunk = { key, ix, iz, x: ix * chunkSize + chunkSize / 2, z: iz * chunkSize + chunkSize / 2, buildings: [] };
      chunkIndex.set(key, chunk);
    }
    chunk.buildings.push(building);
  }
  // 每块内部按楼高降序、id 升序处理：三角形预算优先给显眼楼，且与数据排序无关。
  for (const chunk of chunkIndex.values()) {
    chunk.buildings.sort((a, b) => (b.height - a.height) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const materials = bucketColors().map(color => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0.04 }));
  const lightMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x42140f, emissive: 0xff2a18, emissiveIntensity: 1.2, roughness: 0.5 });
  const group = new THREE.Group();
  group.name = 'ShenzhenBuildingDetails';
  scene.add(group);

  const active = new Map();
  const state = {
    active, index, materials, lightMaterial, group, disposed: false,
    aerialMesh: null, aerialDirty: false
  };
  const statistics = {
    chunkSize, generateRadius, disposeRadius, maxChunksPerUpdate,
    chunks: 0, meshes: 0, triangles: 0, buildings: 0, parapetParts: 0, roofParts: 0,
    balconies: 0, acUnits: 0, canopies: 0, aerialLights: 0, aerialMeshes: 0,
    generated: 0, rebuilt: 0, disposed: 0, pending: 0, updateMs: 0, lastGenerationMs: 0,
    chunksDetail: []
  };

  function refreshStatistics() {
    let meshes = 0; let triangles = 0; let buildingCount = 0; let parapetParts = 0; let roofParts = 0;
    let balconies = 0; let acUnits = 0; let canopies = 0; let aerialLights = 0;
    statistics.chunksDetail.length = 0;
    for (const record of active.values()) {
      meshes += record.meshes;
      triangles += record.triangles;
      buildingCount += record.buildingCount;
      parapetParts += record.parapetParts;
      roofParts += record.roofPartCount;
      balconies += record.balconyCount;
      acUnits += record.acUnitCount;
      canopies += record.canopyCount;
      aerialLights += record.aerialLights.length;
      statistics.chunksDetail.push({
        key: record.chunk.key, x: record.chunk.x, z: record.chunk.z,
        meshes: record.meshes, triangles: record.triangles, buildings: record.buildingCount,
        parapetParts: record.parapetParts, roofParts: record.roofPartCount,
        balconies: record.balconyCount, acUnits: record.acUnitCount,
        canopies: record.canopyCount, aerialLights: record.aerialLights.length
      });
    }
    statistics.chunksDetail.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    statistics.chunks = active.size;
    statistics.meshes = meshes;
    statistics.triangles = triangles;
    statistics.buildings = buildingCount;
    statistics.parapetParts = parapetParts;
    statistics.roofParts = roofParts;
    statistics.balconies = balconies;
    statistics.acUnits = acUnits;
    statistics.canopies = canopies;
    statistics.aerialLights = aerialLights;
    statistics.aerialMeshes = state.aerialMesh ? 1 : 0;
  }

  function disposeAerialMesh() {
    if (!state.aerialMesh) return;
    group.remove(state.aerialMesh);
    state.aerialMesh.geometry.dispose();
    state.aerialMesh = null;
  }

  function rebuildAerialLights() {
    disposeAerialMesh();
    const lights = [];
    for (const record of active.values()) for (const light of record.aerialLights) lights.push(light);
    if (lights.length) {
      const builder = new GeoBuilder(false);
      for (const light of lights) addBox(builder, light.x, light.y, light.z, 0.55, 0.55, 0.55, 0);
      const mesh = new THREE.Mesh(builder.build(), lightMaterial);
      mesh.name = 'ShenzhenBuildingDetails:AerialLights';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      state.aerialMesh = mesh;
    }
    statistics.aerialMeshes = state.aerialMesh ? 1 : 0;
    statistics.aerialLights = lights.length;
  }

  function disposeChunk(key) {
    const record = active.get(key);
    if (!record) return;
    group.remove(record.group);
    for (const mesh of record.group.children) mesh.geometry.dispose();
    active.delete(key);
    statistics.disposed++;
    if (record.aerialLights.length) state.aerialDirty = true;
    refreshStatistics();
  }

  function buildChunk(chunk, focusX, focusZ, distance) {
    const started = nowMs();
    const chunkGroup = new THREE.Group();
    chunkGroup.name = `ShenzhenBuildingDetails:${chunk.key}`;
    const builders = [new GeoBuilder(false), new GeoBuilder(false), new GeoBuilder(false), new GeoBuilder(false)];
    const record = {
      chunk, group: chunkGroup, meshes: 0, triangles: 0, buildingCount: 0,
      parapetParts: 0, roofPartCount: 0, balconyCount: 0, acUnitCount: 0, canopyCount: 0,
      aerialLights: [], buildDistance: distance
    };
    const playerPosition = { x: focusX, z: focusZ };
    let budget = maxChunkTriangles;
    // 近处优先：完整近景名额按距离分配，密排块里先保证玩家身边的楼有阳台/空调/雨棚。
    const ordered = chunk.buildings.slice().sort((a, b) => {
      const da = (a.cx - focusX) * (a.cx - focusX) + (a.cz - focusZ) * (a.cz - focusZ);
      const db = (b.cx - focusX) * (b.cx - focusX) + (b.cz - focusZ) * (b.cz - focusZ);
      return (da - db) || (b.height - a.height) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    let fullDetailBuildings = 0;
    // 名额以外的楼只保留女儿墙 + 一个便宜屋顶盒（搜索次数少），远处仍看得出屋顶设备。
    const minimalOptions = { neighbours: index, playerPosition, allowFacadeDetails: false, cheapRoof: true };
    for (const building of ordered) {
      if (building.height < 6) continue;
      if (budget <= 0) break;
      const placement = index.placementOf(building);
      const minimal = fullDetailBuildings >= maxFullDetailBuildings;
      const planOptions = { neighbours: index, playerPosition };
      let plan = minimal ? planBuildingDetails(building, placement, minimalOptions) : planBuildingDetails(building, placement, planOptions);
      if (!plan) continue;
      if (estimatePlanTriangles(plan) > budget) {
        plan = planBuildingDetails(building, placement, minimalOptions);
        if (!plan || estimatePlanTriangles(plan) > budget) continue;
      } else if (!minimal) {
        fullDetailBuildings++;
      }
      budget -= appendPlanGeometry(builders, plan);
      record.buildingCount++;
      record.parapetParts += plan.parapet.parts.length;
      record.roofPartCount += plan.roofParts.length;
      record.balconyCount += plan.balconies.length;
      record.acUnitCount += plan.acUnits.length;
      if (plan.canopy) record.canopyCount++;
      if (plan.aerialLights.length) {
        for (const light of plan.aerialLights) record.aerialLights.push(light);
        state.aerialDirty = true;
      }
    }
    for (let i = 0; i < builders.length; i++) {
      if (builders[i].idx.length === 0) continue;
      const geometry = builders[i].build();
      record.triangles += geometry.index.array.length / 3;
      const mesh = new THREE.Mesh(geometry, materials[i]);
      mesh.name = `ShenzhenBuildingDetails:${chunk.key}:${BUCKET_NAMES[i]}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      chunkGroup.add(mesh);
      record.meshes++;
    }
    group.add(chunkGroup);
    active.set(chunk.key, record);
    statistics.generated++;
    statistics.lastGenerationMs = nowMs() - started;
    // 先清空旧记录再刷新统计：刷新会遍历 active，包含本块。
    refreshStatistics();
    return record;
  }

  function collectPending(focusX, focusZ) {
    const pending = [];
    const ix0 = Math.floor((focusX - generateRadius) / chunkSize);
    const ix1 = Math.floor((focusX + generateRadius) / chunkSize);
    const iz0 = Math.floor((focusZ - generateRadius) / chunkSize);
    const iz1 = Math.floor((focusZ + generateRadius) / chunkSize);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const chunk = chunkIndex.get(`${ix},${iz}`);
        if (!chunk) continue;
        const distance = Math.hypot(chunk.x - focusX, chunk.z - focusZ);
        if (distance > generateRadius) continue;
        const record = active.get(chunk.key);
        if (!record) { pending.push({ chunk, distance, rebuild: false }); continue; }
        // 玩家走近后重建，让阳台/空调外机这些近距离细节出现；只升级不降级。
        const crossedBalcony = record.buildDistance > BALCONY_RADIUS + REBUILD_MARGIN && distance <= BALCONY_RADIUS;
        const crossedAc = record.buildDistance > AC_RADIUS + REBUILD_MARGIN && distance <= AC_RADIUS;
        if (crossedBalcony || crossedAc) pending.push({ chunk, distance, rebuild: true });
      }
    }
    pending.sort((a, b) => (a.distance - b.distance) || (a.chunk.key < b.chunk.key ? -1 : a.chunk.key > b.chunk.key ? 1 : 0));
    return pending;
  }

  function disposeAerialIfNeeded() {
    if (!state.aerialDirty) return;
    state.aerialDirty = false;
    rebuildAerialLights();
  }

  function update(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      throw new Error('Building details update requires a finite x/z position');
    }
    if (state.disposed) return statistics;
    const started = nowMs();
    const focusX = position.x;
    const focusZ = position.z;
    for (const key of [...active.keys()]) {
      const record = active.get(key);
      if (!record) continue;
      if (Math.hypot(record.chunk.x - focusX, record.chunk.z - focusZ) > disposeRadius) disposeChunk(key);
    }
    const pending = collectPending(focusX, focusZ);
    let built = 0;
    for (const item of pending) {
      if (built >= maxChunksPerUpdate) break;
      if (built > 0 && nowMs() - started > maxGenerationMs) break;
      if (item.rebuild) {
        disposeChunk(item.chunk.key);
        buildChunk(item.chunk, focusX, focusZ, item.distance);
        statistics.rebuilt++;
        built++;
      } else {
        buildChunk(item.chunk, focusX, focusZ, item.distance);
        built++;
      }
    }
    disposeAerialIfNeeded();
    // 航空障碍灯慢闪：只改材质标量，不重建几何。
    const pulse = 0.5 + 0.5 * Math.sin(nowMs() * 0.0019);
    lightMaterial.emissiveIntensity = 0.7 + 2.2 * pulse;
    statistics.pending = Math.max(0, pending.length - built);
    statistics.updateMs = nowMs() - started;
    return statistics;
  }

  refreshStatistics();

  function dispose() {
    if (state.disposed) return;
    for (const key of [...active.keys()]) disposeChunk(key);
    disposeAerialMesh();
    for (const material of materials) material.dispose();
    lightMaterial.dispose();
    if (typeof scene.remove === 'function') scene.remove(group);
    // 释放邻楼索引和放置缓存，避免保留 4 万栋楼的引用。
    state.index.cells.clear();
    state.index.placements.clear();
    state.disposed = true;
    refreshStatistics();
    statistics.pending = 0;
  }

  return { group, update, dispose, statistics };
}
