import * as THREE from 'three/webgpu';
import { GEO, REAL_BUILDINGS, CITY_PAYLOAD } from './sz-geodata.js';
import { GeoBuilder, addWalls, addFlatPolygon } from './sz-geometry.js';
import { createBuildingMaterial } from './sz-materials.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';
import { ringArea, ringContains, polygonContains } from './sz-polygon.js';
import { visitGroundRoadFootprints } from './sz-roads.js';

// 普通楼按 2.4 km 合并成一个渲染块：出生点 1484 次绘制里 105 次来自 1 km 建筑块，
// 放大后块数约降到 1/5，三角形只随视野内建筑范围略增。
export const BUILDING_RENDER_CHUNK_SIZE = 2400;
// 普通高层按“塔楼 + 裙房”两级表达：裙房由塔楼足迹向外放大生成，是显示估计，不是测绘裙房。
// 高度取 16% 塔高并封顶 20 m；只有外扩后的足迹避开地面道路沥青、真实入口、内院和邻楼时才生成，
// 连最小外扩量都放不下就保留原塔楼，不为外观新增阻挡。显示与碰撞共用同一份通过检查的外环。
const PODIUM_MIN_TOWER_HEIGHT_M = 100;
const PODIUM_MIN_AREA_M2 = 1500;
const PODIUM_EXPAND_FRACTION = 0.16;
// 外扩量是随足迹面积变化的缩放参数，不是实测米数偏移：从塔楼质心按比例放大，
// 同一参数在不同形状上的实际外移距离不同；小于最小值就判定没有可用范围。
const PODIUM_EXPAND_MIN_M = 4;
const PODIUM_EXPAND_MAX_M = 9;
const PODIUM_EXPAND_STEP_M = 0.25;
const PODIUM_HEIGHT_FRACTION = 0.16;
const PODIUM_HEIGHT_MAX_M = 20;
const PODIUM_MIN_HEIGHT_M = 6;
// 真实入口保持的通行净距（按单扇门宽度取的估计值，不是测绘数据）。
const PODIUM_ENTRANCE_CLEARANCE_M = 1.5;
// 占用索引的格边长：只把候选裙房外环附近的邻楼、地面道路和入口放进索引，避免全城建索引。
const PODIUM_OCCUPANCY_CELL_M = 64;
const PODIUM_OCCUPANCY_PAD_M = 2;
// 屋顶细节：女儿墙 + 电梯机房/空调机组体块。类型、位置、数量都是显示估计（estimate），
// 不属于建筑高度来源；设备完整底面必须落在真实屋顶有效区域内（扣除内院），放不下就缩小、换位置或跳过。
const PARAPET_MIN_HEIGHT_M = 20;
const PARAPET_HEIGHT_M = 0.9;
const ROOF_EQUIPMENT_MIN_HEIGHT_M = 60;
const ROOF_EQUIPMENT_MAX = 3;
const ROOF_EQUIPMENT_EDGE_MARGIN_M = 0.5;
const ROOF_EQUIPMENT_GAP_M = 0.5;
const ROOF_EQUIPMENT_MIN_SIZE_M = 1.5;
const ROOF_EQUIPMENT_SHRINK_STEPS = [1, 0.75, 0.55, 0.35];
const ROOF_EQUIPMENT_GRID_MAX = 12;
const flatRing = ring => ring.flatMap(p => [p.x, p.z]);

function ringBounds(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function boundsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringsCross(a, b) {
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      if (segmentsCross(a[j], a[i], b[l], b[k])) return true;
    }
  }
  return false;
}

// 两个实心区域的平面重叠检查：包含内院（洞）的轮廓按“洞是空的”处理。
// 只判断中心和四角不够，所以同时查顶点包含和边相交。
function polygonsOverlap(a, b) {
  for (const point of a.outer) if (polygonContains(b, point.x, point.z)) return true;
  for (const ring of [b.outer, ...(b.holes ?? [])]) {
    for (const point of ring) if (polygonContains(a, point.x, point.z)) return true;
  }
  for (const ringA of [a.outer, ...(a.holes ?? [])]) {
    for (const ringB of [b.outer, ...(b.holes ?? [])]) if (ringsCross(ringA, ringB)) return true;
  }
  return false;
}

function pointSegmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
  const ox = x - a.x - dx * t, oz = z - a.z - dz * t;
  return Math.sqrt(ox * ox + oz * oz);
}

function ringDistanceToPoint(ring, x, z) {
  let distance = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    distance = Math.min(distance, pointSegmentDistance(x, z, ring[j], ring[i]));
  }
  return distance;
}

function expandRing(ring, expand) {
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p.x; cz += p.z; }
  cx /= ring.length; cz /= ring.length;
  const radius = Math.sqrt(ringArea(ring) / Math.PI);
  const scale = 1 + expand / Math.max(radius, 6);
  return ring.map(p => ({ x: cx + (p.x - cx) * scale, z: cz + (p.z - cz) * scale }));
}

// 解析：候选裙房建筑清单。只做与高程无关的体量筛选，外环按当前规则放大到期望值。
function collectPodiumCandidates(buildings) {
  const candidates = [];
  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex++) {
    const building = buildings[buildingIndex];
    const polygon = building.polygons?.[0];
    if (!polygon || polygon.outer.length < 3) continue;
    if (building.minHeight > 0 || building.height < PODIUM_MIN_TOWER_HEIGHT_M) continue;
    const area = ringArea(polygon.outer);
    if (area < PODIUM_MIN_AREA_M2) continue;
    const top = Math.min(PODIUM_HEIGHT_MAX_M, Math.max(PODIUM_MIN_HEIGHT_M, building.height * PODIUM_HEIGHT_FRACTION));
    if (building.height - top < 30) continue;
    const desired = Math.min(PODIUM_EXPAND_MAX_M, Math.max(PODIUM_EXPAND_MIN_M,
      Math.sqrt(area) * PODIUM_EXPAND_FRACTION));
    const bounds = ringBounds(expandRing(polygon.outer, desired));
    candidates.push({
      buildingIndex, building, polygon, top, desired,
      bounds: { minX: bounds.minX - PODIUM_OCCUPANCY_PAD_M, maxX: bounds.maxX + PODIUM_OCCUPANCY_PAD_M,
        minZ: bounds.minZ - PODIUM_OCCUPANCY_PAD_M, maxZ: bounds.maxZ + PODIUM_OCCUPANCY_PAD_M }
    });
  }
  return candidates;
}

// 解析：裙房占用索引。只收集候选外环附近的邻楼足迹、地面道路走廊和真实入口点，
// 供 podiumPlan() 判断可用范围；返回与 candidates 同序的上下文数组。
function buildPodiumOccupancy(buildings, terrain, roadGraph, entrances, candidates) {
  const cellOf = value => Math.floor(value / PODIUM_OCCUPANCY_CELL_M);
  const keyOf = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
  const cells = new Map();
  for (let index = 0; index < candidates.length; index++) {
    const { bounds } = candidates[index];
    for (let ix = cellOf(bounds.minX); ix <= cellOf(bounds.maxX); ix++) {
      for (let iz = cellOf(bounds.minZ); iz <= cellOf(bounds.maxZ); iz++) {
        const key = keyOf(ix, iz);
        const list = cells.get(key);
        if (list) list.push(index); else cells.set(key, [index]);
      }
    }
  }
  const context = candidates.map(() => ({ buildings: [], roads: [], entrances: [] }));
  const buildingSeen = candidates.map(() => new Set());
  const roadSeen = candidates.map(() => new Set());
  const rangeCache = new Map();
  const verticalRangeOf = buildingIndex => {
    if (rangeCache.has(buildingIndex)) return rangeCache.get(buildingIndex);
    let range = null;
    try {
      const placement = buildingPlacement(buildings[buildingIndex], terrain);
      range = { minY: placement.minY, maxY: placement.maxY };
    } catch {
      // 邻楼高程未知时不猜：按“会阻挡”处理，调用处据此跳过估计裙房。
      range = null;
    }
    rangeCache.set(buildingIndex, range);
    return range;
  };
  // 把与给定 bbox 相交的候选下标交给 visit；跨格对象由调用方去重。
  const visitCandidates = (bounds, visit) => {
    for (let ix = cellOf(bounds.minX); ix <= cellOf(bounds.maxX); ix++) {
      for (let iz = cellOf(bounds.minZ); iz <= cellOf(bounds.maxZ); iz++) {
        const list = cells.get(keyOf(ix, iz));
        if (!list) continue;
        for (const index of list) if (boundsOverlap(bounds, candidates[index].bounds)) visit(index);
      }
    }
  };

  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex++) {
    const polygon = buildings[buildingIndex].polygons?.[0];
    if (!polygon || polygon.outer.length < 3) continue;
    const bounds = ringBounds(polygon.outer);
    visitCandidates(bounds, index => {
      if (candidates[index].buildingIndex === buildingIndex || buildingSeen[index].has(buildingIndex)) return;
      buildingSeen[index].add(buildingIndex);
      context[index].buildings.push({
        polygon: { outer: polygon.outer, holes: polygon.holes ?? [] }, bounds,
        range: verticalRangeOf(buildingIndex)
      });
    });
  }

  if (roadGraph?.links) visitGroundRoadFootprints(roadGraph, points => {
    const bounds = ringBounds(points);
    visitCandidates(bounds, index => {
      if (roadSeen[index].has(points)) return;
      roadSeen[index].add(points);
      context[index].roads.push({ polygon: { outer: points, holes: [] }, bounds });
    });
  });

  for (const entrance of entrances ?? []) {
    if (!Number.isFinite(entrance?.x) || !Number.isFinite(entrance?.z)) continue;
    const bounds = { minX: entrance.x - PODIUM_ENTRANCE_CLEARANCE_M, maxX: entrance.x + PODIUM_ENTRANCE_CLEARANCE_M,
      minZ: entrance.z - PODIUM_ENTRANCE_CLEARANCE_M, maxZ: entrance.z + PODIUM_ENTRANCE_CLEARANCE_M };
    visitCandidates(bounds, index => {
      context[index].entrances.push({ x: entrance.x, z: entrance.z, bounds });
    });
  }

  return context;
}

// 解析：给定外环是否与占用范围冲突。邻楼高程未知、入口净距不足都按冲突处理。
function podiumBlocked(context, building, outer, holes, baseY, top) {
  const polygon = { outer, holes };
  const bounds = ringBounds(outer);
  for (const obstacle of context.buildings) {
    if (!boundsOverlap(bounds, obstacle.bounds)) continue;
    if (!obstacle.range) return true;
    if (obstacle.range.minY >= baseY + top || obstacle.range.maxY <= baseY) continue;
    if (polygonsOverlap(polygon, obstacle.polygon)) return true;
  }
  for (const road of context.roads) {
    if (!boundsOverlap(bounds, road.bounds)) continue;
    if (polygonsOverlap(polygon, road.polygon)) return true;
  }
  for (const entrance of context.entrances) {
    if (!boundsOverlap(bounds, entrance.bounds)) continue;
    if (polygonContains(polygon, entrance.x, entrance.z)) return true;
    if (ringDistanceToPoint(outer, entrance.x, entrance.z) < PODIUM_ENTRANCE_CLEARANCE_M) return true;
  }
  return false;
}

// 解析：普通高层“塔楼+裙房”中的裙房计划：在可用范围内取最大可行外扩。
// 输入：候选建筑、其占用上下文、塔楼放置结果（提供世界坐标下界）。
// 输出：{ outer, holes, height }，放不下返回 null（保留原塔楼）；显示与碰撞共用该外环。
function podiumPlan(candidate, context, placement, roadClearance) {
  const { building, polygon, top, desired } = candidate;
  for (let expand = desired; expand >= PODIUM_EXPAND_MIN_M - 1e-9; expand -= PODIUM_EXPAND_STEP_M) {
    const outer = expandRing(polygon.outer, expand);
    if (podiumBlocked(context, building, outer, polygon.holes ?? [], placement.minY, top)) continue;
    if (roadClearance?.({ outer, holes: polygon.holes ?? [] }, ringBounds(outer), placement.minY, placement.minY + top, true)) continue;
    return { outer, holes: polygon.holes ?? [], height: top, expand };
  }
  return null;
}

// 屋顶设备底面的矩形环：yaw 为绕竖直轴的旋转（弧度），本地 x 轴对应 sizeX。
function roofUnitRing({ x, z, sizeX, sizeZ, yaw }) {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const hx = sizeX / 2, hz = sizeZ / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, v]) => ({
    x: x + u * cos - v * sin, z: z + u * sin + v * cos
  }));
}

// 屋顶有效区域包含检查：完整底面在内、与边界各边保持净距、不盖内院。
// 只判断中心或四角会漏掉凹口和穿过底面的内院，所以同时检查边相交、边界顶点和双向净距。
function roofUnitFits(rings, polygon, outerBounds, unit, margin) {
  const rect = roofUnitRing(unit);
  // 先用外包围盒排除贴近屋顶边缘的候选，避免每个候选都做整圈边界距离计算。
  const rectBounds = ringBounds(rect);
  if (rectBounds.minX < outerBounds.minX + margin || rectBounds.maxX > outerBounds.maxX - margin
    || rectBounds.minZ < outerBounds.minZ + margin || rectBounds.maxZ > outerBounds.maxZ - margin) return false;
  for (const point of rect) if (!polygonContains(polygon, point.x, point.z)) return false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      for (let k = 0, l = rect.length - 1; k < rect.length; l = k++) {
        if (segmentsCross(a, b, rect[l], rect[k])) return false;
      }
      if (ringContains(rect, a.x, a.z)) return false;
      for (const point of rect) if (pointSegmentDistance(point.x, point.z, a, b) < margin) return false;
    }
    // 凹口或内院的边界顶点可能贴在设备某条边中间，只查四角距离会漏掉。
    for (const vertex of ring) {
      for (let k = 0, l = rect.length - 1; k < rect.length; l = k++) {
        if (pointSegmentDistance(vertex.x, vertex.z, rect[l], rect[k]) < margin) return false;
      }
    }
  }
  return true;
}

// 解析：同一栋楼内设备之间保持间距（按放大后的矩形判断重叠）。
function roofUnitsOverlap(placed, unit, gap) {
  const rect = roofUnitRing(unit);
  const bounds = ringBounds(rect);
  for (const other of placed) {
    // 包围盒预筛也要按要求的间距外扩，否则斜向相邻的两台设备会漏检。
    const apartBounds = { minX: other.bounds.minX - gap, maxX: other.bounds.maxX + gap,
      minZ: other.bounds.minZ - gap, maxZ: other.bounds.maxZ + gap };
    if (!boundsOverlap(bounds, apartBounds)) continue;
    // 对方矩形每边外扩 gap，重叠即说明净距不足。
    const expanded = roofUnitRing({ ...other.unit, sizeX: other.unit.sizeX + gap * 2, sizeZ: other.unit.sizeZ + gap * 2 });
    if (polygonsOverlap({ outer: expanded, holes: [] }, { outer: rect, holes: [] })) return true;
  }
  return false;
}

// 主朝向取最长边方向：矩形在 π/2 旋转下相同，所以把朝向归一化到 [0, π/2)。
function roofOrientations(ring, seed) {
  let longest = 0, longestLength = -1;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ex = ring[i].x - ring[j].x, ez = ring[i].z - ring[j].z;
    const length = Math.sqrt(ex * ex + ez * ez);
    if (length > longestLength) { longestLength = length; longest = Math.atan2(ring[i].z - ring[j].z, ring[i].x - ring[j].x); }
  }
  const quarter = Math.PI / 2;
  const dominant = ((longest % quarter) + quarter) % quarter;
  const orientations = [dominant, dominant + quarter, 0];
  if (seed > 0.5) orientations.reverse();
  return orientations.filter((yaw, index) => orientations.findIndex(other => Math.abs(other - yaw) < 1e-3) === index);
}

// 解析：屋顶设备的候选位置，固定种子决定顺序；先沿用原来的极坐标位置，再用收缩包围盒网格补充。
function roofEquipmentPositions(bounds, seed, index) {
  const centerX = (bounds.minX + bounds.maxX) / 2, centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const span = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const angle = (seed * 7.3 + index * 2.1) % (Math.PI * 2);
  const radius = span * (0.08 + 0.06 * ((seed + index * 0.37) % 1));
  const preferred = { x: centerX + Math.cos(angle) * radius, z: centerZ + Math.sin(angle) * radius };
  const positions = [preferred, { x: centerX, z: centerZ }];
  const inset = Math.min(span * 0.15, 4);
  const step = Math.max(2, span / 4);
  const grid = [];
  for (let x = bounds.minX + inset; x <= bounds.maxX - inset + 1e-9; x += step) {
    for (let z = bounds.minZ + inset; z <= bounds.maxZ - inset + 1e-9; z += step) grid.push({ x, z });
  }
  const distance = point => { const dx = point.x - preferred.x, dz = point.z - preferred.z; return dx * dx + dz * dz; };
  grid.sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
  positions.push(...grid.slice(0, ROOF_EQUIPMENT_GRID_MAX));
  return positions;
}

/** 解析：普通建筑屋顶细节计划：≥20 m 加女儿墙；≥60 m 按 id 固定种子加 1–3 个屋顶设备体块。
 *  输入：单栋建筑与首个足迹多边形。
 *  输出：{ parapet, equipment }；设备 { x, z, sizeX, sizeZ, height, yaw } 的完整底面落在屋顶有效区域内
 *  （扣除内院、距边界 ≥0.5 m、设备之间 ≥0.5 m），放不下就缩小、换位置或跳过。 */
export function roofPlan(building, polygon) {
  const parapet = building.height >= PARAPET_MIN_HEIGHT_M ? PARAPET_HEIGHT_M : 0;
  const equipment = [];
  if (!polygon || polygon.outer.length < 3 || building.height < ROOF_EQUIPMENT_MIN_HEIGHT_M) {
    return { parapet, equipment };
  }
  const ring = polygon.outer;
  const rings = [ring, ...(polygon.holes ?? [])];
  const bounds = ringBounds(ring);
  const span = Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const seed = buildingSeed(building.id);
  const count = 1 + Math.floor(seed * ROOF_EQUIPMENT_MAX);
  const positions = roofEquipmentPositions(bounds, seed, 0);
  const orientations = roofOrientations(ring, seed);
  const placed = [];
  for (let index = 0; index < count; index++) {
    const sizeX = Math.min(9, Math.max(3, span * (0.1 + 0.05 * ((seed + index * 0.21) % 1))));
    const sizeZ = Math.min(9, Math.max(3, span * (0.09 + 0.04 * ((seed + index * 0.53) % 1))));
    const height = 2 + ((seed + index * 0.31) % 1) * 3;
    let unit = null;
    const ordered = index === 0 ? positions : roofEquipmentPositions(bounds, seed, index);
    for (const yaw of orientations) {
      for (const position of ordered) {
        for (const scale of ROOF_EQUIPMENT_SHRINK_STEPS) {
          const candidate = { x: position.x, z: position.z,
            sizeX: Math.max(ROOF_EQUIPMENT_MIN_SIZE_M, sizeX * scale),
            sizeZ: Math.max(ROOF_EQUIPMENT_MIN_SIZE_M, sizeZ * scale), height, yaw };
          if (roofUnitsOverlap(placed, candidate, ROOF_EQUIPMENT_GAP_M)) continue;
          if (!roofUnitFits(rings, polygon, bounds, candidate, ROOF_EQUIPMENT_EDGE_MARGIN_M)) continue;
          unit = candidate;
          break;
        }
        if (unit) break;
      }
      if (unit) break;
    }
    if (!unit) continue;
    equipment.push(unit);
    placed.push({ unit, bounds: ringBounds(roofUnitRing(unit)) });
  }
  return { parapet, equipment };
}

/** 解析：普通建筑总入口：按 2.4 km 分块合并墙体/屋顶/裙房/女儿墙/屋顶设备，返回碰撞体。
 *  输入：buildings（默认 REAL_BUILDINGS）、terrain、skipIds（地标/场地接管）、roadGraph、entrances、renderChunkSize。
 *  输出：{ group, colliders, allBlocks, roofs, roofPlans, update, dispose }。
 *  约束：所有体量都由共享包足迹+高度派生；heightSource 保留源数据，新增细节标 estimate。 */
export function buildCityBlocks(scene, options = {}) {
  const buildings = options.buildings ?? REAL_BUILDINGS;
  const terrain = options.terrain ?? GEO?.terrain;
  const skipIds = options.skipIds ?? new Set();
  const renderChunkSize = options.renderChunkSize ?? BUILDING_RENDER_CHUNK_SIZE;
  const roadClearance = options.roadClearance;
  // 裙房净空输入：地形起伏的地面道路与真实入口点，缺省取共享包里的路侧入口和地铁出入口。
  const roadGraph = options.roadGraph ?? GEO?.roadGraph ?? null;
  const entrances = options.entrances ?? [
    ...(GEO?.roadFrontage?.entrances ?? []), ...(GEO?.metro?.entrances ?? [])
  ];
  const candidates = collectPodiumCandidates(buildings);
  const occupancy = candidates.length ? buildPodiumOccupancy(buildings, terrain, roadGraph, entrances, candidates) : [];
  const candidateByBuilding = new Map(candidates.map((candidate, index) => [candidate.buildingIndex, index]));
  const group = new THREE.Group();
  group.name = 'ShenzhenCityBlocks';
  const batches = new Map();
  const colliders = [];
  const allBlocks = [];
  const roadConflicts = [];
  const roofPlans = new Map();
  const programTowers = [];
  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex++) {
    const building = buildings[buildingIndex];
    if (skipIds.has(building.id)) continue;
    const placement = buildingPlacement(building, terrain);
    if (roadClearance && !building.landmark && /^(?:globfp|overture)\//.test(building.id)) {
      const conflict = building.polygons.map(polygon =>
        roadClearance(polygon, ringBounds(polygon.outer), placement.minY, placement.maxY)).find(Boolean);
      if (conflict) {
        roadConflicts.push({ buildingId: building.id, road: conflict });
        continue;
      }
    }
    const participates = options.program?.includes(building);
    if (participates) programTowers.push(building.id);
    const key = `${Math.floor(building.cx / renderChunkSize)},${Math.floor(building.cz / renderChunkSize)}${participates ? ':program' : ''}`;
    if (!batches.has(key)) batches.set(key, new GeoBuilder(true));
    const batch = batches.get(key);
    const facade = CITY_PAYLOAD.enums.facade.indexOf(building.facade);
    if (facade < 0) throw new Error(`Unknown building facade: ${building.facade}`);
    // 普通超高层不自动套同一种灯光秀，地标灯光由各自模型负责。
    const meta = [facade, buildingSeed(building.id) * 10, 0, building.height];
    for (const polygon of building.polygons) {
      const rings = [polygon.outer, ...polygon.holes].map(flatRing);
      addWalls(batch, rings, placement.minY, placement.maxY, meta, placement.baseY);
      addFlatPolygon(batch, rings, placement.maxY, meta);
      if (building.minHeight > 0) addFlatPolygon(batch, rings, placement.minY, meta, 1, -1);
    }
    colliders.push(...placement.colliders);
    const candidateIndex = candidateByBuilding.get(buildingIndex);
    const podium = candidateIndex === undefined ? null
      : podiumPlan(candidates[candidateIndex], occupancy[candidateIndex], placement, roadClearance);
    if (podium) {
      const rings = [podium.outer, ...podium.holes].map(flatRing);
      const top = placement.minY + podium.height;
      addWalls(batch, rings, placement.minY, top, meta, placement.baseY);
      addFlatPolygon(batch, rings, top, meta);
      colliders.push({
        type: 'building-podium', name: `${building.id}:podium`, sourceId: building.id,
        polygon: { outer: podium.outer, holes: podium.holes },
        minX: Math.min(...podium.outer.map(p => p.x)), maxX: Math.max(...podium.outer.map(p => p.x)),
        minZ: Math.min(...podium.outer.map(p => p.z)), maxZ: Math.max(...podium.outer.map(p => p.z)),
        minY: placement.minY, maxY: top, heightSource: 'estimate', baseSource: 'dem-footprint-bounds-center'
      });
      allBlocks.push({ ...building, id: `${building.id}:podium`, isPodium: true,
        baseY: placement.baseY, minY: placement.minY, maxY: top });
    }
    const roofPolygon = building.polygons[0];
    const roof = roofPlan(building, roofPolygon);
    if (roof.parapet > 0) {
      // 同一条女儿墙边界给内外两面，俯视时仍能看到屋面内侧。
      const boundary = flatRing(roofPolygon.outer);
      addWalls(batch, [boundary, boundary], placement.maxY, placement.maxY + roof.parapet, meta, placement.baseY);
    }
    const equipmentFootprints = [];
    for (const unit of roof.equipment) {
      const outer = roofUnitRing(unit);
      const base = flatRing(outer);
      addWalls(batch, [base], placement.maxY, placement.maxY + unit.height, meta, placement.baseY);
      addFlatPolygon(batch, [base], placement.maxY + unit.height, meta);
      equipmentFootprints.push({ outer, holes: [] });
    }
    if (roof.parapet > 0 || equipmentFootprints.length > 0) {
      // 记录实际绘制的屋面和设备底面；近景层复用这些边界做摆放检查。
      roofPlans.set(building.id, {
        polygon: roofPolygon, roofY: placement.maxY, parapet: roof.parapet,
        equipmentFootprints, appearanceSource: 'estimate'
      });
    }
    allBlocks.push({ ...building, baseY: placement.baseY, minY: placement.minY, maxY: placement.maxY });
  }
  const material = createBuildingMaterial();
  const programMaterial = programTowers.length ? createBuildingMaterial(options.program) : null;
  for (const [key, batch] of batches) {
    const mesh = new THREE.Mesh(batch.build(), key.endsWith(':program') ? programMaterial : material);
    mesh.name = `ShenzhenBuildings:${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  return { group, colliders, allBlocks, roadConflicts, roofPlans, programTowers,
    roofs: allBlocks.filter(block => !block.isPodium && block.height >= ROOF_EQUIPMENT_MIN_HEIGHT_M).length,
    update() {},
    dispose() {
      group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
      programMaterial?.dispose();
      roofPlans.clear();
      scene.remove(group);
    }
  };
}
