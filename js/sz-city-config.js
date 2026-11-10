import { GEO, REAL_BUILDINGS } from './sz-geodata.js';
import { createCitySpatial } from './sz-spatial.js';
import { polygonContainsInclusive } from './sz-polygon.js';
import { polygonBoxOverlaps } from './building-collision.js';
import { STR } from './sz-strings.js';

const TAU = Math.PI * 2;
const wrap = angle => ((angle % TAU) + TAU) % TAU;
const EMPTY_BOUNDS = Object.freeze({ minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

// 数据规范的 bearing 从北顺时针计；纽约玩家模型的 heading=0 朝 +z（南）。
export const headingFromBearing = bearing => wrap(Math.PI - bearing);
export const bearingFromHeading = heading => wrap(Math.PI - heading);
export const SIGNAL_TIMING = Object.freeze({ cycle: 60, avenueAmber: 26, avenueRed: 30, streetAmber: 56, walk: 7 });

export function signalPhase(time, isAvenue) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const t = ((time % cycle) + cycle) % cycle;
  return isAvenue ? (t < avenueAmber ? 'green' : t < avenueRed ? 'amber' : 'red')
    : (t < avenueRed ? 'red' : t < streetAmber ? 'green' : 'amber');
}

export function walkSignal(time, isAvenue) {
  const { cycle, avenueRed, walk } = SIGNAL_TIMING;
  const t = (((time - (isAvenue ? 0 : avenueRed)) % cycle) + cycle) % cycle;
  return t < walk;
}

export function isTypingInField(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  return path.some(target => target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
    || target.isContentEditable === true));
}

function makeBuildingIndex(buildings) {
  const cells = new Map();
  for (const building of buildings) {
    for (let x = Math.floor(building.minX / 100); x <= Math.floor(building.maxX / 100); x++) {
      for (let z = Math.floor(building.minZ / 100); z <= Math.floor(building.maxZ / 100); z++) {
        const key = `${x},${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(building);
      }
    }
  }
  return (x, z, extent) => {
    const found = new Set();
    for (let i = Math.floor((x - extent) / 100); i <= Math.floor((x + extent) / 100); i++) {
      for (let j = Math.floor((z - extent) / 100); j <= Math.floor((z + extent) / 100); j++) {
        for (const building of cells.get(`${i},${j}`) || []) found.add(building);
      }
    }
    return found;
  };
}

function bodyFor(mode) {
  switch (mode) {
    case 'person': return { halfWidth: 0.58, halfLength: 0.58 };
    case 'car': return { halfWidth: 0.96, halfLength: 2.28 };
    case 'cyclist': return { halfWidth: 0.65, halfLength: 1.1 };
    default: throw new Error(`Unsupported ground arrival mode: ${mode}`);
  }
}

function roadCandidates(road, target, radius) {
  const out = [];
  for (let i = 1; i < road.pts.length; i++) {
    const a = road.pts[i - 1], b = road.pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const nearest = Math.max(0, Math.min(length, ((target.x - a.x) * dx + (target.z - a.z) * dz) / length));
    const along = new Set([nearest]);
    for (const offset of [-24, -16, -8, 8, 16, 24]) along.add(Math.max(0, Math.min(length, nearest + offset)));
    const direction = road.dir === -1 ? -1 : 1;
    const heading = Math.atan2(dx * direction, dz * direction);
    // 双向道路靠各自右侧到达；偏移由道路宽度派生，不声明为实测车道中心。
    const laneOffset = road.dir === 0 ? road.w / 4 : 0;
    for (const s of along) {
      const x = a.x + dx * s / length - dz * direction / length * laneOffset;
      const z = a.z + dz * s / length + dx * direction / length * laneOffset;
      const distance = Math.hypot(x - target.x, z - target.z);
      if (distance <= radius) out.push({ x, z, heading, distance, road });
    }
  }
  return out;
}

export function createCityConfig(geo, buildings = [], labels = STR) {
  const spatial = createCitySpatial(geo);
  const nearBuildings = makeBuildingIndex(buildings);
  const bounds = Object.freeze({ minX: geo.bounds[0], minZ: geo.bounds[1], maxX: geo.bounds[2], maxZ: geo.bounds[3],
    sidewalkHeight: 0 });
  const landmarks = geo.landmarks.filter(lm => lm.phase === 1 && spatial.inBounds(lm.x, lm.z))
    .map(lm => ({ ...lm, short: lm.short || lm.name, group: lm.district || '',
      height: Number.isFinite(lm.height) ? lm.height : null }));
  const landmarkSites = Object.fromEntries(landmarks.map(lm => [lm.id, lm]));
  const roads = spatial.roads.map(road => ({ ...road, raw: road.name,
    highway: ['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(road.highway),
    highwayClass: road.highway }));
  const roadById = new Map(roads.map(road => [road.id, road]));

  function nearestRoads(x, z, radius = 160) {
    const names = new Set();
    return spatial.nearestRoads(x, z, radius).flatMap(hit => {
      if (!hit.road.name || names.has(hit.road.name)) return [];
      names.add(hit.road.name);
      return [{ ...hit, road: roadById.get(hit.road.id), dist: hit.distance }];
    });
  }

  function districtAt(x, z) {
    if (!spatial.inBounds(x, z)) return null;
    // 当前包没有行政区界；只接受今后导入的有来源面，不按经度猜区名。
    return (geo.districts || []).find(d => d.source && polygonContainsInclusive(d.polygon, x, z))?.id ?? null;
  }

  function getLocationInfo(x, z) {
    if (!spatial.inBounds(x, z)) return { kind: 'outside', district: null, road: null, landmark: null };
    const nearby = landmarks.map(lm => ({ lm, distance: Math.hypot(x - lm.x, z - lm.z) }))
      .filter(hit => hit.distance <= 80).sort((a, b) => a.distance - b.distance)[0]?.lm ?? null;
    return { kind: spatial.isWater(x, z) ? 'water' : 'land', district: districtAt(x, z),
      road: nearestRoads(x, z, 160)[0]?.road ?? null, landmark: nearby };
  }

  function getLocationLabel(x, z) {
    const info = getLocationInfo(x, z);
    if (info.kind === 'outside') return labels.locationOutside || '';
    const district = (geo.districts || []).find(d => d.id === info.district)?.name;
    const name = info.road?.name || info.landmark?.name;
    if (name) return district ? `${district}${labels.locationSeparator || ' · '}${name}` : name;
    return (info.kind === 'water' ? labels.locationWater : labels.locationUnknown) || labels.title || '';
  }

  function getLandIntervalsAtZ(z) {
    if (!Number.isFinite(z) || z < bounds.minZ || z > bounds.maxZ) return [];
    const cuts = new Set([bounds.minX, bounds.maxX]);
    for (const polygon of [...geo.coverage, ...geo.land, ...geo.water]) {
      for (const ring of [polygon.outer, ...polygon.holes]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j], b = ring[i];
          if ((a.z > z) !== (b.z > z)) cuts.add(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
          if (a.z === z) cuts.add(a.x);
        }
      }
    }
    const xs = [...cuts].sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < xs.length; i++) {
      const westX = xs[i - 1], eastX = xs[i];
      if (eastX - westX < 1e-7 || !spatial.isOnLand((westX + eastX) / 2, z)) continue;
      const last = intervals[intervals.length - 1];
      if (last && Math.abs(last.eastX - westX) < 1e-7) last.eastX = eastX;
      else intervals.push({ westX, eastX });
    }
    return intervals;
  }

  function getIslandBoundsAtZ(z) {
    const intervals = getLandIntervalsAtZ(z);
    // 仅供旧渲染接口取包围范围；控制器必须检查 isOnLand，不能穿过范围内的海湾/湖。
    return { westX: intervals[0]?.westX ?? Infinity, eastX: intervals.at(-1)?.eastX ?? -Infinity, intervals };
  }

  function clearArrival(candidate, mode, isClear) {
    const body = bodyFor(mode);
    const cs = Math.cos(candidate.heading), sn = Math.sin(candidate.heading);
    const points = [[0, 0], [-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [sx, sz] of points) {
      const x = candidate.x + sx * body.halfWidth * cs + sz * body.halfLength * sn;
      const z = candidate.z - sx * body.halfWidth * sn + sz * body.halfLength * cs;
      if (spatial.groundHeight(x, z) === null) return false;
    }
    // 这里只为初始落点保守避让；实际通行/架空层净空由场景的同源碰撞体判定。
    for (const building of nearBuildings(candidate.x, candidate.z, Math.hypot(body.halfWidth, body.halfLength))) {
      if (building.polygons.some(p => polygonBoxOverlaps(p, candidate.x, candidate.z, body.halfWidth, body.halfLength, cs, sn))) return false;
    }
    return !isClear || isClear(candidate, mode);
  }

  function findGroundArrival(target, mode = 'car', options = {}) {
    bodyFor(mode);
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z) || !spatial.inBounds(target.x, target.z)) return null;
    const radius = options.radius ?? 600;
    if (!Number.isFinite(radius) || radius < 0 || radius > 2000) throw new Error('Invalid arrival search radius');
    const candidates = spatial.nearestRoads(target.x, target.z, radius)
      .filter(hit => hit.road.heightSource === 'terrain' && !hit.road.bridge && !hit.road.tunnel && !hit.road.layer)
      .flatMap(hit => roadCandidates(hit.road, target, radius))
      .sort((a, b) => a.distance - b.distance || a.road.id - b.road.id || a.x - b.x || a.z - b.z);
    for (const candidate of candidates) {
      const y = spatial.groundHeight(candidate.x, candidate.z);
      if (y === null || !clearArrival({ ...candidate, y }, mode, options.isClear)) continue;
      return { x: candidate.x, y, z: candidate.z, heading: candidate.heading,
        bearing: bearingFromHeading(candidate.heading), sourceRoadId: candidate.road.osmId,
        widthSource: candidate.road.widthSource, placement: 'derived-road-arrival',
        heightSource: geo.terrain.processing?.heightSource ?? null, distance: candidate.distance };
    }
    return null;
  }

  const teleports = Object.fromEntries(landmarks.flatMap(lm => {
    const arrival = findGroundArrival(lm);
    return arrival ? [[lm.id, { ...arrival, landmarkId: lm.id, name: lm.name }]] : [];
  }));
  const spawnTarget = landmarks.find(lm => lm.id === 'civic-center');
  const spawn = spawnTarget ? findGroundArrival(spawnTarget, 'person') : null;
  return { spatial, ISLAND_BOUNDS: bounds, ROADS: roads, SZ_LANDMARKS: landmarks, NYC_LANDMARKS: landmarks,
    LANDMARK_SITES: landmarkSites, TELEPORT_LOCATIONS: teleports, SPAWN_POINT: spawn,
    nearestRoads, districtAt, getLocationInfo, getLocationLabel, getLandIntervalsAtZ, getIslandBoundsAtZ,
    isOnLand: spatial.isOnLand, isWater: spatial.isWater, inBounds: spatial.inBounds,
    terrainHeight: spatial.groundHeight, findGroundArrival,
    ALL_AVENUES: [], AVENUES: [], ALL_STREETS: [], STREETS: [], BLOCKS: [],
    CENTRAL_PARK_BOUNDS: EMPTY_BOUNDS, blockAt: () => null, getBlockBounds: () => null };
}

const config = createCityConfig(GEO, REAL_BUILDINGS);
export const { ISLAND_BOUNDS, ROADS, SZ_LANDMARKS, NYC_LANDMARKS, LANDMARK_SITES, TELEPORT_LOCATIONS, SPAWN_POINT,
  nearestRoads, districtAt, getLocationInfo, getLocationLabel, getLandIntervalsAtZ, getIslandBoundsAtZ,
  isOnLand, isWater, inBounds, terrainHeight, findGroundArrival,
  ALL_AVENUES, AVENUES, ALL_STREETS, STREETS, BLOCKS, CENTRAL_PARK_BOUNDS, blockAt, getBlockBounds } = config;

// 留给迁移期静态依赖使用的空集合，不代表深圳存在纽约对应实体。
export const MANHATTAN_COASTLINE = [];
export const BROADWAY_LINE = [];
export const WATERFRONT_PIERS = [];
export const EAST_RIVER_BRIDGES = [];
export const OUTER_BRIDGES = [];
export const CUT_Z = ISLAND_BOUNDS.minZ;
export function streetZ() { throw new Error('Numbered New York streets are unavailable in Shenzhen'); }
export function avenueX() { throw new Error('New York avenues are unavailable in Shenzhen'); }
export function getBroadwayX() { return null; }
export function fromOldFrame() { throw new Error('New York coordinate conversion is unavailable in Shenzhen'); }
