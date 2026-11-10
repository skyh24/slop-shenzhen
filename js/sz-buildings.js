import * as THREE from 'three/webgpu';
import { GEO, REAL_BUILDINGS, CITY_PAYLOAD } from './sz-geodata.js';
import { GeoBuilder, addWalls, addFlatPolygon } from './sz-geometry.js';
import { createBuildingMaterial } from './sz-materials.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';

export const BUILDING_RENDER_CHUNK_SIZE = 1000;
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
// 不属于建筑高度来源；只加在真实足迹内，不生成碰撞体。
const PARAPET_MIN_HEIGHT_M = 20;
const PARAPET_HEIGHT_M = 0.9;
const ROOF_EQUIPMENT_MIN_HEIGHT_M = 60;
const ROOF_EQUIPMENT_MAX = 3;
const flatRing = ring => ring.flatMap(p => [p.x, p.z]);

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].z - ring[i].z);
  }
  return Math.abs(area) / 2;
}

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

// 射线法：点是否在单个环内。裙房净空和屋顶包含判断都只用这一份实现。
function ringContains(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, x, z) {
  if (!ringContains(polygon.outer, x, z)) return false;
  for (const hole of polygon.holes ?? []) if (ringContains(hole, x, z)) return false;
  return true;
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
  for (const point of a.outer) if (polygonContainsPoint(b, point.x, point.z)) return true;
  for (const ring of [b.outer, ...(b.holes ?? [])]) {
    for (const point of ring) if (polygonContainsPoint(a, point.x, point.z)) return true;
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

// 与 sz-roads.js 的 isGroundRoad 同规则：只有按地形起伏的地面道路参与裙房占道检查，
// 桥、隧道和分层道路不按平面占道处理（这里是纯函数，避免把道路渲染模块拖进建筑模块）。
function isGroundRoad({ heightSource, bridge, tunnel, layer }) {
  return heightSource === 'terrain' && !bridge && !tunnel && !layer;
}

function roadLinkPoints(graph, [start, end, , , , , inner]) {
  const points = [{ x: graph.nodes[start * 2], z: graph.nodes[start * 2 + 1] }];
  for (let i = 0; i < inner.length; i += 2) points.push({ x: inner[i], z: inner[i + 1] });
  points.push({ x: graph.nodes[end * 2], z: graph.nodes[end * 2 + 1] });
  return points.filter((point, index) => !index || point.x !== points[index - 1].x || point.z !== points[index - 1].z);
}

const ROAD_TURN_EPSILON = 1e-8;

function roadTurn(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function convexHullPoints(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const half = vertices => {
    const edge = [];
    for (const point of vertices) {
      while (edge.length > 1 && roadTurn(edge[edge.length - 2], edge[edge.length - 1], point) <= ROAD_TURN_EPSILON) edge.pop();
      edge.push(point);
    }
    edge.pop();
    return edge;
  };
  return half(sorted).concat(half([...sorted].reverse()));
}

// 与 sz-roads.js 的 roadSectionPoints 一致：带断面的道路用断面点（leftM 为左侧偏移），否则用中心线。
function roadSectionPoints(graph, link, metadata) {
  const source = metadata.crossSection?.points;
  if (!source) return roadLinkPoints(graph, link);
  const points = [];
  for (let i = 0; i < source.length; i += 3) points.push({ x: source[i], z: source[i + 1], leftM: source[i + 2] });
  return points;
}

// 解析：地面道路实际渲染出来的沥青足迹，规则与 sz-roads.js 的 indexRoadFootprints 相同：
// 逐段断面四边形、弯道外侧斜接三角形、共顶点的地面路段再补凸包覆盖路口。
// 裙房占道检查按这份渲染面判断，不能用中心线加宽近似（弯道和路口会漏掉边角）。
function collectGroundRoadFootprints(graph, add) {
  const junctionArms = new Map();
  const addArm = (nodeIndex, section) => {
    let arm = junctionArms.get(nodeIndex);
    if (!arm) { arm = { points: [], count: 0 }; junctionArms.set(nodeIndex, arm); }
    arm.points.push(...section);
    arm.count++;
  };
  for (let linkIndex = 0; linkIndex < graph.links.length; linkIndex++) {
    const metadata = graph.metadata?.[linkIndex];
    if (!metadata || !isGroundRoad(metadata)) continue;
    const link = graph.links[linkIndex];
    const width = link[3];
    if (!(width > 0)) continue;
    const points = roadSectionPoints(graph, link, metadata);
    let previous = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 1e-6) continue;
      // 断面两侧点：左侧用 leftM（缺省为半宽），右侧补齐到总宽，与渲染一致。
      const section = point => {
        const left = (point.leftM ?? width / 2) / length;
        const right = width / length - left;
        return [{ x: point.x + dz * left, z: point.z - dx * left },
          { x: point.x - dz * right, z: point.z + dx * right }];
      };
      const startSection = section(a);
      const endSection = section(b);
      add([startSection[0], endSection[0], endSection[1], startSection[1]], `${linkIndex}:${i}:surface`);
      if (previous) {
        const change = previous.dx * dz - previous.dz * dx;
        const side = change > 0 ? 0 : 1;
        const before = previous.endSection[side], after = startSection[side];
        if (Math.abs(roadTurn(a, before, after)) > ROAD_TURN_EPSILON) {
          add(change > 0 ? [a, before, after] : [a, after, before], `${linkIndex}:${i}:mitre`);
        }
      } else {
        addArm(link[0], startSection);
      }
      if (i === points.length - 1) addArm(link[1], endSection);
      previous = { dx, dz, endSection };
    }
  }
  // 只有共用节点且至少两条地面路段才补路口凸包；单端点和跨层道路保持各自边界。
  for (const [nodeIndex, arm] of junctionArms) {
    if (arm.count < 2) continue;
    const hull = convexHullPoints(arm.points);
    if (hull.length >= 3) add(hull, `junction:${nodeIndex}`);
  }
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
  // 把与给定 bbox 相交的候选下标交给 visit；跨格对象只访问一次。
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

  if (roadGraph?.links) {
    collectGroundRoadFootprints(roadGraph, (outer, footprintKey) => {
      if (outer.length < 3) return;
      const bounds = ringBounds(outer);
      visitCandidates(bounds, index => {
        if (roadSeen[index].has(footprintKey)) return;
        roadSeen[index].add(footprintKey);
        context[index].roads.push({ polygon: { outer, holes: [] }, bounds });
      });
    });
  }

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
    if (polygonContainsPoint(polygon, entrance.x, entrance.z)) return true;
    if (ringDistanceToPoint(outer, entrance.x, entrance.z) < PODIUM_ENTRANCE_CLEARANCE_M) return true;
  }
  return false;
}

// 解析：普通高层“塔楼+裙房”中的裙房计划：在可用范围内取最大可行外扩。
// 输入：候选建筑、其占用上下文、塔楼放置结果（提供世界坐标下界）。
// 输出：{ outer, holes, height }，放不下返回 null（保留原塔楼）；显示与碰撞共用该外环。
function podiumPlan(candidate, context, placement) {
  const { building, polygon, top, desired } = candidate;
  for (let expand = desired; expand >= PODIUM_EXPAND_MIN_M - 1e-9; expand -= PODIUM_EXPAND_STEP_M) {
    const outer = expandRing(polygon.outer, expand);
    if (podiumBlocked(context, building, outer, polygon.holes ?? [], placement.minY, top)) continue;
    return { outer, holes: polygon.holes ?? [], height: top, expand };
  }
  return null;
}

/** 解析：普通建筑屋顶细节计划：≥20 m 加女儿墙；≥60 m 按 id 固定种子加 1–3 个屋顶设备体块。
 *  输入：单栋建筑与首个足迹多边形。
 *  输出：{ parapet, equipment }；设备位置在足迹包围盒内、尺寸 3–9 m，纯显示估计。 */
function roofPlan(building, polygon) {
  const parapet = building.height >= PARAPET_MIN_HEIGHT_M ? PARAPET_HEIGHT_M : 0;
  const equipment = [];
  if (building.height >= ROOF_EQUIPMENT_MIN_HEIGHT_M) {
    const ring = polygon.outer;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const point of ring) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    }
    const seed = buildingSeed(building.id);
    const count = 1 + Math.floor(seed * ROOF_EQUIPMENT_MAX);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.min(maxX - minX, maxZ - minZ);
    for (let index = 0; index < count; index++) {
      const angle = (seed * 7.3 + index * 2.1) % (Math.PI * 2);
      const radius = span * (0.08 + 0.06 * ((seed + index * 0.37) % 1));
      const sizeX = Math.min(9, Math.max(3, span * (0.1 + 0.05 * ((seed + index * 0.21) % 1))));
      const sizeZ = Math.min(9, Math.max(3, span * (0.09 + 0.04 * ((seed + index * 0.53) % 1))));
      const height = 2 + ((seed + index * 0.31) % 1) * 3;
      equipment.push({ x: cx + Math.cos(angle) * radius, z: cz + Math.sin(angle) * radius,
        sizeX, sizeZ, height });
    }
  }
  return { parapet, equipment };
}

/** 解析：普通建筑总入口：按 1 km 分块合并墙体/屋顶/裙房/女儿墙/屋顶设备，返回碰撞体。
 *  输入：buildings（默认 REAL_BUILDINGS）、terrain、skipIds（地标/场地接管）、roadGraph、entrances、renderChunkSize。
 *  输出：{ group, colliders, allBlocks, roofs, update, dispose }。
 *  约束：所有体量都由共享包足迹+高度派生；heightSource 保留源数据，新增细节标 estimate。 */
export function buildCityBlocks(scene, options = {}) {
  const buildings = options.buildings ?? REAL_BUILDINGS;
  const terrain = options.terrain ?? GEO?.terrain;
  const skipIds = options.skipIds ?? new Set();
  const renderChunkSize = options.renderChunkSize ?? BUILDING_RENDER_CHUNK_SIZE;
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
  for (let buildingIndex = 0; buildingIndex < buildings.length; buildingIndex++) {
    const building = buildings[buildingIndex];
    if (skipIds.has(building.id)) continue;
    const placement = buildingPlacement(building, terrain);
    const key = `${Math.floor(building.cx / renderChunkSize)},${Math.floor(building.cz / renderChunkSize)}`;
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
    const podium = candidateIndex === undefined ? null : podiumPlan(candidates[candidateIndex], occupancy[candidateIndex], placement);
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
      addWalls(batch, [roofPolygon.outer].map(flatRing), placement.maxY, placement.maxY + roof.parapet, meta, placement.baseY);
    }
    for (const unit of roof.equipment) {
      const base = [[unit.x - unit.sizeX / 2, unit.z - unit.sizeZ / 2], [unit.x + unit.sizeX / 2, unit.z - unit.sizeZ / 2],
        [unit.x + unit.sizeX / 2, unit.z + unit.sizeZ / 2], [unit.x - unit.sizeX / 2, unit.z + unit.sizeZ / 2]]
        .map(([x, z]) => [x, z]);
      addWalls(batch, [base.flat()], placement.maxY, placement.maxY + unit.height, meta, placement.baseY);
      addFlatPolygon(batch, [base.flat()], placement.maxY + unit.height, meta);
    }
    allBlocks.push({ ...building, baseY: placement.baseY, minY: placement.minY, maxY: placement.maxY });
  }
  const material = createBuildingMaterial();
  for (const [key, batch] of batches) {
    const mesh = new THREE.Mesh(batch.build(), material);
    mesh.name = `ShenzhenBuildings:${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  return { group, colliders, allBlocks, roofs: allBlocks.filter(block => !block.isPodium && block.height >= ROOF_EQUIPMENT_MIN_HEIGHT_M).length,
    update() {},
    dispose() {
      group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
      scene.remove(group);
    }
  };
}
