import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { buildWalkTracks, createColliderGrid, createCrossingWalkTracks, createPublicWalkTrack, sampleTrack } from './sz-pedestrian-tracks.js';
import { polygonContains } from './sz-polygon.js';
import { contactTime, writeEntityCollider, writePedestrianCollider } from './sz-driving-motion.js';
import { WALK_RADIUS, WALK_GAP, createWalkerGrid, clearOfWalkers, createWalkAvoidance } from './sz-walk-avoidance.js';
import { vehicleContact } from './vehicle-physics.js';

// 正式深圳场景的环境人群：复用纽约的 PersonRig / PersonCrowd（步态、脚底接地、远近 LOD），
// 但不搬纽约的人行道/斑马线数据。深圳没有全城铺装人行道网格，行走位置来自
// sz-pedestrian-tracks.js 的模拟步行带（沿地面道路两侧偏移），铺装条带同样是模拟。
// 人群只在玩家附近维持：活动区按 focus 增量重建，130 m 内才解算骨骼，220 m 外回收。
// 道路等级 → 活动强度（模拟代理，不是实测客流）
const HIGHWAY_ACTIVITY = {
  primary: 1.0, secondary: 0.9, tertiary: 0.78, primary_link: 0.62, secondary_link: 0.55,
  tertiary_link: 0.5, residential: 0.5, unclassified: 0.45, living_street: 0.42
};
const DENSITY_DEFAULTS = {
  densityCellM: 100, // 建筑覆盖率统计格（m）
  densityBase: 0.18, // 无建筑时的最低活跃度
  densityBuildingScale: 2.4, // 建筑足迹覆盖率对活跃度的斜率
  greenFactor: 0.4, // 绿地里的人流系数
  nearGreenFactor: 0.8, // 绿地外 greenNeighborM 内的人流系数
  greenNeighborM: 150,
  densitySpreadLow: 0.15, // 活动度 → 目标人数的映射下界
  densitySpreadHigh: 0.7, // 活动度 → 目标人数的映射上界
  targetMinPeds: 40,
  targetMaxPeds: 140,
  trackCapacityPerM: 0.45, // 每米出生环内可用步行带最多容纳的人数（约 2.2 m 一个）

  densityHysteresisPeds: 8,
  retirePerFrame: 2
};
const PED_DEFAULTS = {
  maxPeds: 140,
  seed: 20261109,
  greenAreas: [],
  highwayActivity: HIGHWAY_ACTIVITY,
  regionRadiusM: 260,
  regionShiftM: 100,
  spawnMinM: 20,
  spawnMaxM: 160,
  recycleRadiusM: 220,
  nearRadiusM: 130,
  viewProtectM: 90,
  spawnBudget: 6,
  farDistanceM: 34,
  castShadow: true,
  keepRightM: 0.38,
  targetSpeedMin: 1.1,
  targetSpeedMax: 1.5,
  walkMarginM: 2.1,
  pauseTurnS: 0.9,
  restMinS: 35,
  restMaxS: 80,
  restPauseMinS: 1.5,
  restPauseMaxS: 3.5,
  surfaceRiseM: 0.03,
  pavement: true,
  pavementHalfWidthM: 1.1
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const cellKey = (x, z) => (x + 10000) * 100000 + (z + 10000);
const squareDistance = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

export function seededRandom(seed) {
  let state = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const hash = (i, salt) => {
  const value = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

function polygonArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area) / 2;
}

function normalizeGreenArea(area) {
  if (!area) return null;
  if (Array.isArray(area)) return area.length >= 3 ? [{ outer: area, holes: [] }] : null;
  if (area.outer?.length >= 3) return [area];
  // 兼容 GEO.parks[].areas[]：多块绿地各自是 polygon
  if (Array.isArray(area.areas)) return area.areas.map(item => item.polygon).filter(polygon => polygon?.outer?.length >= 3);
  return null;
}

// 地点人流代理：约 100 m 网格上的建筑足迹覆盖率 + 道路等级 + 绿地。全部是模拟参数，
// 不代表实测客流；没有建筑覆盖的人行道至少保留 densityBase，避免整段没人。
export function createSzDensityModel(options = {}) {
  const cfg = { ...DENSITY_DEFAULTS, ...options };
  const cellM = cfg.densityCellM;
  const cellArea = cellM * cellM;
  const coverage = new Map();
  let buildings = 0;
  for (const collider of options.colliders ?? []) {
    if (!collider?.polygon || !(collider.polygon.outer?.length >= 3)) continue;
    const { minX, maxX, minZ, maxZ, minY, maxY } = collider;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ)
      || !Number.isFinite(maxZ) || !Number.isFinite(minY) || !Number.isFinite(maxY)) continue;
    if (!(maxY > 1 && minY < 60)) continue; // 只统计人物活动高度内的实体
    let area = polygonArea(collider.polygon.outer);
    for (const hole of collider.polygon.holes ?? []) area -= polygonArea(hole);
    if (!(area > 1)) continue;
    const firstX = Math.floor(minX / cellM);
    const lastX = Math.floor(maxX / cellM);
    const firstZ = Math.floor(minZ / cellM);
    const lastZ = Math.floor(maxZ / cellM);
    const cells = (lastX - firstX + 1) * (lastZ - firstZ + 1);
    const share = area / cells;
    for (let x = firstX; x <= lastX; x++) {
      for (let z = firstZ; z <= lastZ; z++) {
        const key = cellKey(x, z);
        coverage.set(key, (coverage.get(key) ?? 0) + share);
      }
    }
    buildings++;
  }
  const green = new Set();
  const nearGreen = new Set();
  let greenPolygons = 0;
  for (const source of options.greenAreas ?? []) {
    for (const polygon of normalizeGreenArea(source) ?? []) {
      greenPolygons++;
      const { minX, maxX, minZ, maxZ } = boundsOfRing(polygon.outer);
      const firstX = Math.floor((minX - cfg.greenNeighborM) / cellM);
      const lastX = Math.floor((maxX + cfg.greenNeighborM) / cellM);
      const firstZ = Math.floor((minZ - cfg.greenNeighborM) / cellM);
      const lastZ = Math.floor((maxZ + cfg.greenNeighborM) / cellM);
      for (let x = firstX; x <= lastX; x++) {
        for (let z = firstZ; z <= lastZ; z++) {
          const key = cellKey(x, z);
          const centerX = (x + 0.5) * cellM;
          const centerZ = (z + 0.5) * cellM;
          if (polygonContains(polygon, centerX, centerZ)) green.add(key);
          else nearGreen.add(key);
        }
      }
    }
  }
  function coverageAt(x, z) {
    const value = coverage.get(cellKey(Math.floor(x / cellM), Math.floor(z / cellM))) ?? 0;
    return Math.min(1, value / cellArea);
  }
  function greenAt(x, z) {
    const key = cellKey(Math.floor(x / cellM), Math.floor(z / cellM));
    return green.has(key) ? 'green' : nearGreen.has(key) ? 'near' : 'none';
  }
  function densityAt(x, z) {
    const activity = cfg.densityBase + cfg.densityBuildingScale * coverageAt(x, z);
    const greenKind = greenAt(x, z);
    const factor = greenKind === 'green' ? cfg.greenFactor : greenKind === 'near' ? cfg.nearGreenFactor : 1;
    return Math.max(0, Math.min(1, activity * factor));
  }
  return { densityAt, coverageAt, greenAt,
    statistics: { buildings, greenPolygons, coverageCells: coverage.size, greenCells: green.size } };
}

function boundsOfRing(ring) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const point of ring) {
    if (point.x < bounds.minX) bounds.minX = point.x;
    if (point.x > bounds.maxX) bounds.maxX = point.x;
    if (point.z < bounds.minZ) bounds.minZ = point.z;
    if (point.z > bounds.maxZ) bounds.maxZ = point.z;
  }
  return bounds;
}

function createPed(id, cfg) {
  const female = hash(id, 1) < 0.48;
  const hairRoll = hash(id, 2);
  return {
    id,
    rig: new PersonRig({
      seed: id * 1.6180339 + 0.13,
      female,
      scale: (female ? 0.91 : 0.97) + hash(id, 4) * 0.1,
      girth: 0.9 + hash(id, 5) * 0.24,
      hair: female ? (hairRoll < 0.68 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
      armSwing: 0.75 + hash(id, 6) * 0.5,
      stride: 0.94 + hash(id, 7) * 0.12
    }),
    placed: false,
    leg: null,
    s: 0,
    dir: 1,
    fromLeg: null,
    x: 0,
    z: 0,
    heading: 0,
    v: 0,
    speed: cfg.targetSpeedMin + (cfg.targetSpeedMax - cfg.targetSpeedMin) * hash(id, 3),
    lateral: 0,
    pause: 0,
    restAt: 0,
    collider: { id: `pedestrian:${id}` }
  };
}

function poseOffsetLimit(leg, cfg) {
  if (leg.kind === 'crossing-network') return 0;
  if (Number.isFinite(leg.lateralM)) return leg.lateralM;
  if (leg.allows || leg.walkAt || leg.publicHeight) return 1.45;
  if (leg.kind === 'public-walk') return 0.5;
  return Math.max(0, cfg.pavementHalfWidthM - WALK_RADIUS);
}

function offsetPose(leg, s, lateral, out) {
  sampleTrack(leg, s, out);
  // 连线切换只在端点附近收回中心；公共面允许在原边界内保持横向位置。
  const fade = leg.kind === 'public-walk' || leg.publicHeight ? 1 : clamp(s / 0.9, 0, 1) * clamp((leg.length - s) / 0.9, 0, 1);
  out.raised = leg.raisedOnly;
  const centerX = out.x, centerZ = out.z;
  out.x += (out.rightX ?? out.dz) * lateral * fade;
  out.z += (out.rightZ ?? -out.dx) * lateral * fade;
  out.centerX = centerX;
  out.centerZ = centerZ;
  return out;
}

function pickTrack(region, random) {
  const total = region.spawnWeight;
  if (!(total > 0)) return null;
  const target = random() * total;
  let lo = 0;
  let hi = region.spawnTracks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (region.spawnCum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return region.spawnTracks[lo];
}

export function createSzPedestrians(scene, graph, options = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Ambient pedestrians require a scene');
  if (!graph || !Array.isArray(graph.links) || !Array.isArray(graph.metadata)) {
    throw new Error('Ambient pedestrians require the source road graph');
  }
  if (typeof options.heightAt !== 'function') throw new Error('Ambient pedestrians require heightAt');
  if (!Array.isArray(options.colliders)) throw new Error('Ambient pedestrians require collider bounds');
  const cfg = { ...DENSITY_DEFAULTS, ...PED_DEFAULTS, ...options };
  const random = seededRandom(cfg.seed);
  // 全城建筑碰撞体只索引一次，活动区重建时取附近一组。
  const colliderGrid = createColliderGrid(cfg.colliders);
  // 地点人流代理：建筑足迹覆盖率 + 道路等级 + 绿地；全部是模拟参数。
  const densityModel = createSzDensityModel({ ...cfg, colliders: cfg.colliders, greenAreas: cfg.greenAreas ?? [] });
  const densityAt = typeof cfg.densityAt === 'function' ? cfg.densityAt : densityModel.densityAt;
  const targetMin = Math.max(0, Math.min(cfg.targetMinPeds, cfg.maxPeds));
  const targetMax = Math.max(targetMin, Math.min(cfg.targetMaxPeds, cfg.maxPeds));
  const activityWeights = cfg.highwayActivity ?? HIGHWAY_ACTIVITY;
  const group = new THREE.Group();
  group.name = 'shenzhen-ambient-pedestrians';
  const crowd = new PersonCrowd(cfg.maxPeds, { farDistance: cfg.farDistanceM, castShadow: cfg.castShadow });
  for (const mesh of crowd.meshes) group.add(mesh);
  // 铺装整条带只画在沥青外，另用 polygonOffset 压住地形/前场的共面深度。
  const pavementMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.94,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  pavementMaterial.name = 'simulated-sidewalk-pavement';
  let pavementMesh = null;
  const peds = [];
  for (let id = 0; id < cfg.maxPeds; id++) peds.push(createPed(id, cfg));
  scene.add(group);

  const ground = (owner, x, z) => {
    if (owner.leg?.publicHeight) return owner.leg.publicHeight(x, z) ?? owner.y;
    const height = cfg.heightAt(x, z);
    const rise = owner.leg?.kind === 'public-walk' ? 0 : cfg.surfaceRiseM;
    return Number.isFinite(height) ? height + rise : rise;
  };
  const publicTracks = (cfg.publicRoutes ?? []).map(route => createPublicWalkTrack(route.points, route));
  const crossingTracks = cfg.crossingLegs?.length ? createCrossingWalkTracks(cfg.crossingLegs) : [];
  if (crossingTracks.some(track => track.signal) && !cfg.crossingControl) {
    throw new Error('Signalized walks require intersection control');
  }
  if (cfg.publicRoute) publicTracks.push(createPublicWalkTrack(cfg.publicRoute, cfg.publicWalkSurface));
  const scratch = { x: 0, y: 0, z: 0, dx: 1, dz: 0 };
  const nearPeds = [];
  const grid = createWalkerGrid();
  const nearby = [];
  const stepPose = {};
  const stepSample = {};
  const spawnPose = {};
  const rightOffset = (leg, dir) => -dir * Math.min(cfg.keepRightM, poseOffsetLimit(leg, cfg));
  const pose = (leg, s, lateral, out) => {
    // 采样对象会复用，清掉上条公共步道的法线。
    out.rightX = out.rightZ = undefined;
    offsetPose(leg, s, clamp(lateral, -poseOffsetLimit(leg, cfg), poseOffsetLimit(leg, cfg)), out);
    if (leg.kind === 'sidewalk' && !out.raised && cfg.groundHeight) {
      const base = cfg.groundHeight(out.centerX, out.centerZ);
      out.raised = Number.isFinite(base) && out.y - base >= 0.06 && out.y - base <= 0.18;
    }
    return out;
  };
  function segment(leg, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, distance = Math.hypot(dx, dz);
    const count = Math.max(1, Math.ceil(distance / 0.18));
    const padding = distance / count / 2;
    let height = a.y;
    for (let i = 1; i <= count; i++) {
      // 中间样点多留半步净空；最终落脚点也必须通过同一套检查。
      const t = (i - 0.5) / count;
      const middle = region.heightForPose(a.x + dx * t, a.z + dz * t, height, leg, WALK_RADIUS, b.raised, padding);
      if (middle === null) return false;
      height = middle;
    }
    b.y = region.heightForPose(b.x, b.z, height, leg, WALK_RADIUS, b.raised);
    return b.y !== null;
  }
  const avoidance = [];
  const vehicleProbe = {}, walkProbe = {}, walkContact = {};
  const nearbyVehicles = [];
  let region = null;
  let lastFocus = null;
  let clock = 0;
  let spawnCursor = 0;
  let pavementGeometry = null;
  const statistics = {
    walkPlans: 0, walkPasses: 0, walkYields: 0, walkDetours: 0,
    maxPeds: cfg.maxPeds, placed: 0, near: 0, drawn: 0, spawned: 0, recycled: 0, spawnFailures: 0,
    regionBuilds: 0, regionBuildMs: 0, tracks: 0, connectors: 0, walkableMeters: 0,
    pavementTriangles: 0, pavementAreaM2: 0, pavementCarriagewaySkipped: 0,
    carriagewayBlockedSamples: 0, barrierPolygons: 0, colliderIndexed: 0,
    vehicleYields: 0, crossingWaits: 0, crossingsEntered: 0, crossingsCompleted: 0,
    targetPeds: 0, spawnCapacity: 0, density: 0, densityBuildings: densityModel.statistics.buildings,
    densityGreenPolygons: densityModel.statistics.greenPolygons
  };

  const walkerAvoidance = createWalkAvoidance({ pose, segment, rightOffset,
    offsetLimit: leg => poseOffsetLimit(leg, cfg), statistics });

  function applyPavement(pavement) {
    if (pavementMesh) {
      group.remove(pavementMesh);
      pavementGeometry?.dispose();
      pavementMesh = null;
      pavementGeometry = null;
    }
    if (!cfg.pavement || pavement.positions.length === 0) return;
    pavementGeometry = new THREE.BufferGeometry();
    pavementGeometry.setAttribute('position', new THREE.BufferAttribute(pavement.positions, 3));
    pavementGeometry.setAttribute('color', new THREE.BufferAttribute(pavement.colors, 3));
    pavementGeometry.computeVertexNormals();
    pavementGeometry.computeBoundingSphere();
    pavementMesh = new THREE.Mesh(pavementGeometry, pavementMaterial);
    pavementMesh.name = 'shenzhen-simulated-pavement';
    pavementMesh.receiveShadow = true;
    group.add(pavementMesh);
  }

  function buildRegion(focus) {
    const started = typeof performance === 'object' && performance?.now ? performance.now() : Date.now();
    const radius = cfg.regionRadiusM;
    const bounds = { minX: focus.x - radius, minZ: focus.z - radius, maxX: focus.x + radius, maxZ: focus.z + radius };
    const regionalTracks = (cfg.regionalRoutes?.(focus.x, focus.z, radius) ?? [])
      .map(route => createPublicWalkTrack(route.points, route));
    const tracks = [...publicTracks, ...regionalTracks];
    const built = buildWalkTracks(graph, {
      ...cfg,
      bounds,
      heightAt: cfg.heightAt,
      colliders: cfg.colliders,
      colliderGrid,
      excludeWalkAt: (x, z) => cfg.excludeWalkAt?.(x, z) || tracks.some(track => track.reserve?.(x, z)),
      pavement: cfg.pavement,
      surfaceRiseM: cfg.surfaceRiseM,
      pavementHalfWidthM: cfg.pavementHalfWidthM,
      walkMarginM: cfg.walkMarginM
    });
    for (const track of [...tracks, ...crossingTracks]) {
      if (!track.points.some(p => p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ)) continue;
      if (!track.crossing) built.tracks.push(track);
      built.legs.push(track);
      built.statistics.walkableMeters += track.length;
    }
    // 出生权重按“可用轨道长度 × 地点活跃度”加权，CBD/商业街密、公园/支路稀；只统计
    // 出生环（spawnMinM–spawnMaxM）内的轨道长度，避免把远处车流走廊算成本地人流目标。
    const spawnTracks = [];
    const spawnCum = [];
    const crossingApproaches = [];
    let spawnWeight = 0;
    let weightedDensity = 0;
    let totalLength = 0;
    const ringMin = cfg.spawnMinM;
    const ringMax = cfg.spawnMaxM;
    for (const track of built.tracks) {
      const samples = Math.max(2, Math.min(8, Math.ceil(track.length / 15)));
      let sum = 0;
      let inRing = 0;
      for (let i = 0; i < samples; i++) {
        sampleTrack(track, track.length * (i + 0.5) / samples, scratch);
        const distance = Math.hypot(scratch.x - focus.x, scratch.z - focus.z);
        if (distance < ringMin || distance > ringMax) continue;
        inRing++;
        sum += densityAt(scratch.x, scratch.z);
      }
      if (inRing === 0) continue;
      const available = (track.length * inRing) / samples;
      const place = clamp((sum / inRing) * (activityWeights[track.highway] ?? 0.5), 0.05, 1);
      track.activity = place;
      spawnTracks.push(track);
      spawnWeight += available * (0.2 + place);
      spawnCum.push(spawnWeight);
      if (track.kind === 'crossing-network' && track.ends.some(end => end.some(next => next.leg.crossing))) {
        crossingApproaches.push(track);
      }
      weightedDensity += available * place;
      totalLength += available;
    }
    const density = totalLength > 0 ? weightedDensity / totalLength : 0;
    // 活动度 → 目标人数：15% 以下按最低 40 人，70% 以上按最高 140 人，中间线性。
    // 出生环内没有任何可行走轨道时目标为 0（如实反映“这里没有模拟人行道”）。
    const spread = clamp((density - cfg.densitySpreadLow) / (cfg.densitySpreadHigh - cfg.densitySpreadLow), 0, 1);
    const capacity = Math.floor(totalLength * cfg.trackCapacityPerM);
    const targetPeds = totalLength > 0
      ? Math.min(capacity, clamp(Math.round(targetMin + (targetMax - targetMin) * spread), targetMin, targetMax))
      : 0;
    region = { center: { x: focus.x, z: focus.z }, bounds, spawnTracks, spawnCum, spawnWeight, crossingApproaches,
      targetPeds, capacity, density, ...built };
    applyPavement(built.pavement);
    statistics.regionBuilds++;
    statistics.regionBuildMs = (typeof performance === 'object' && performance?.now ? performance.now() : Date.now()) - started;
    statistics.tracks = built.tracks.length;
    statistics.localTracks = built.statistics.localTracks;
    statistics.connectors = built.connectors.length;
    statistics.walkableMeters = built.statistics.walkableMeters;
    statistics.pavementTriangles = built.statistics.pavementTriangles;
    statistics.pavementAreaM2 = built.statistics.pavementAreaM2;
    statistics.pavementCarriagewaySkipped = built.statistics.pavementCarriagewaySkipped;
    statistics.carriagewayBlockedSamples = built.statistics.carriagewayBlockedSamples;
    statistics.barrierPolygons = built.statistics.barrierPolygons;
    statistics.colliderIndexed = built.statistics.colliderIndexed;
    statistics.targetPeds = targetPeds;
    statistics.spawnCapacity = capacity;
    statistics.density = density;
  }

  function collectAvoidance(players) {
    avoidance.length = 0;
    if (!Array.isArray(players)) return;
    for (const entity of players) {
      const position = entity?.position;
      if (!position || entity.type === 'car' || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
      const height = cfg.heightAt(position.x, position.z);
      if (!Number.isFinite(height) || !(Math.abs(position.y - height) < 3)) continue;
      avoidance.push({ x: position.x, z: position.z, radius: entity.type === 'person' ? 1.1 : 2.6 });
    }
  }

  function trySpawn(ped, focus, isVisible, approach = null) {
    if (!region || region.spawnTracks.length === 0) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const track = approach ?? pickTrack(region, random);
      if (!track || track.length < 2) continue;
      // 窄巷内留出单人通行净宽，环境行人逐个进入。
      if (track.singleFile && peds.some(other => other.placed && other.leg === track)) continue;
      const s = 0.6 + random() * Math.max(0, track.length - 1.2);
      sampleTrack(track, s, scratch);
      const distance = Math.hypot(scratch.x - focus.x, scratch.z - focus.z);
      if (distance < cfg.spawnMinM || distance > cfg.spawnMaxM) continue;
      // 视锥内近处不允许凭空出现；远处 90 m 外允许被人群补充，避免镜头前突然冒人。
      if (isVisible && distance < cfg.viewProtectM && isVisible(scratch.x, scratch.z, 7, scratch.y)) continue;
      ped.leg = track;
      ped.s = s;
      ped.dir = approach && track.ends[0].some(next => next.leg.crossing) ? -1
        : approach ? 1 : random() < 0.5 ? 1 : -1;
      ped.fromLeg = null;
      ped.pendingLeg = null;
      ped.speed = track.jogSpeed && ped.id % 7 === 0 ? track.jogSpeed
        : cfg.targetSpeedMin + (cfg.targetSpeedMax - cfg.targetSpeedMin) * hash(ped.id, 3);
      ped.lateral = rightOffset(track, ped.dir);
      ped.v = ped.speed * (0.5 + random() * 0.5);
      ped.pause = 0;
      ped.restOffset = null;
      pose(track, s, ped.lateral, spawnPose);
      if (!segment(track, spawnPose, spawnPose)) {
        ped.lateral = 0;
        pose(track, s, 0, spawnPose);
        if (!segment(track, spawnPose, spawnPose)) continue;
      }
      const { x, y, z } = spawnPose;
      if (avoidance.some(player => squareDistance(x, z, player.x, player.z) < (player.radius + 1) ** 2)
        || grid.query(x, z, 1, nearby).some(other => Math.abs(y - other.y) < 1.65
          && squareDistance(x, z, other.x, other.z) < 1)) continue;
      Object.assign(ped, { x, y, z, vx: 0, vz: 0, heading: Math.atan2(scratch.dx * ped.dir, scratch.dz * ped.dir),
        lateralV: 0, stuckFor: 0, motionDir: ped.dir, avoid: null, yielding: null, priority: null, staticPath: null, nextLeg: null,
        centerUntil: 0, staticCheck: 0, nextLinkCheck: 0, walkCheck: clock + ped.id % 11 * 0.022 });
      writePedestrianCollider(walkProbe, ped.x, ped.y, ped.z, ped.heading, 0);
      if (nearbyVehicles.some(body => Number.isFinite(contactTime(walkProbe, body, 1)))) continue;
      ped.restAt = clock + cfg.restMinS + random() * (cfg.restMaxS - cfg.restMinS);
      ped.rig.placed = false;
      ped.placed = true;
      grid.add(ped);
      statistics.spawned++;
      return true;
    }
    statistics.spawnFailures++;
    return false;
  }

  function unplace(ped) {
    releaseCrossing(ped);
    ped.placed = false;
    ped.activeWalker = false;
    ped.leg = null;
    ped.fromLeg = null;
    ped.rig.placed = false;
  }

  function releaseCrossing(ped) {
    if (!ped.leg?.signal) return;
    cfg.crossingControl.leaveCrossing(ped.leg.signal, ped.collider.id, clock);
  }

  function crossingClear(track) {
    const steps = Math.ceil(track.length / 1.5);
    for (let i = 0; i <= steps; i++) {
      sampleTrack(track, track.length * i / steps, scratch);
      writePedestrianCollider(walkProbe, scratch.x, scratch.y, scratch.z, 0, 0);
      if (nearbyVehicles.some(vehicle => Number.isFinite(contactTime(walkProbe, vehicle, 2.5)))) return false;
    }
    return true;
  }

  function nextLink(ped, end) {
    const links = ped.leg.ends[end];
    const held = ped.priority?.yielding?.pocket.link?.leg;
    if (ped.nextLeg && links.includes(ped.nextLeg) && ped.nextLeg.leg !== held) return ped.nextLeg;
    const open = links.filter(link => link.leg !== held);
    const choices = open.length ? open : links;
    const fresh = choices.filter(link => link.leg !== ped.fromLeg);
    const pool = fresh.length > 0 ? fresh : choices;
    ped.nextLeg = pool[Math.floor(random() * pool.length)] ?? null;
    return ped.nextLeg;
  }

  function advance(ped, dt) {
    if (!dt) return;
    grid.query(ped.x, ped.z, 1.6, nearby);
    const vehicles = nearbyVehicles.filter(body => Math.abs(body.x - ped.x) < 42 && Math.abs(body.z - ped.z) < 42);
    if (ped.pause > 0) {
      ped.pause = Math.max(0, ped.pause - dt);
      if (ped.pause === 0) ped.restOffset = null;
    }
    let target = ped.pause > 0 ? 0 : ped.walkSpeed;
    let lateral = ped.pause > 0 && Number.isFinite(ped.restOffset) ? ped.restOffset : ped.walkOffset;
    let dir = ped.dir, leg = ped.leg, s = ped.s;
    let stopAt = null, forcedLink = null;
    const yielding = ped.yielding;
    if (yielding) {
      const { pocket, original, winner } = yielding;
      if (!yielding.cleared && yielding.waiting) {
        const anchor = pocket.base ?? pose(original, pocket.end ? original.length : 0, 0, {});
        if ((winner.x - anchor.x) * yielding.fx + (winner.z - anchor.z) * yielding.fz < -1.25) yielding.cleared = true;
      }
      if (yielding.cleared && leg === original) {
        ped.yielding = null;
        lateral = rightOffset(leg, dir);
      } else if (yielding.cleared) {
        dir = pocket.link.end ? 1 : -1;
        forcedLink = { leg: original, end: pocket.end };
        target = Math.min(ped.speed, 1);
        lateral = 0;
      } else if (leg !== pocket.leg) {
        dir = -yielding.dir;
        forcedLink = pocket.link;
        target = 0.85;
        lateral = 0;
      } else {
        const gap = pocket.s - s;
        stopAt = pocket.s;
        dir = gap >= 0 ? 1 : -1;
        target = Math.min(0.85, Math.abs(gap) * 3);
        lateral = Math.abs(gap) < 0.14 ? pocket.offset : (pocket.link ? 0 : yielding.offset);
        yielding.waiting = Math.abs(gap) < 0.04 && Math.abs(ped.lateral - pocket.offset) < 0.08;
      }
    }
    if (ped.priority?.yielding) {
      const q = ped.priority;
      const gap = (q.x - ped.x) * ped.fx + (q.z - ped.z) * ped.fz;
      if (!q.yielding.waiting) target = Math.min(target, Math.max(0, (gap - WALK_GAP - 0.23) * 1.1));
      // 留在狭处中线，退让者才能沿原路走到让行点。
      lateral = 0;
    }
    const end = dir > 0 ? 1 : 0;
    const distance = end ? leg.length - s : s;
    if (!forcedLink && !leg.ends[end].length) target = Math.min(target, Math.sqrt(2 * 1.8 * distance));
    for (const player of avoidance) {
      if (squareDistance(ped.x, ped.z, player.x, player.z) < player.radius ** 2) {
        target = 0;
        lateral = ped.lateral;
        break;
      }
    }
    if (!leg.crossing && !ped.avoid && !yielding && !ped.priority && ped.pause === 0 && clock >= ped.restAt) {
      const restingSide = leg.restSide?.(s);
      if (!leg.restSide || Number.isFinite(restingSide)) {
        ped.pause = cfg.restPauseMinS + random() * (cfg.restPauseMaxS - cfg.restPauseMinS);
        ped.restAt = clock + cfg.restMinS + random() * (cfg.restMaxS - cfg.restMinS);
        ped.restOffset = restingSide;
        target = 0;
      }
    }
    if (vehicles.length) {
      writePedestrianCollider(walkProbe, ped.x, ped.y, ped.z, Math.atan2(ped.fx * dir * ped.dir, ped.fz * dir * ped.dir),
        Math.max(ped.v, target));
      const threat = vehicles.find(body => {
        const time = contactTime(walkProbe, body, 1.05, undefined, undefined, 0.12);
        if (!Number.isFinite(time)) return false;
        const standing = contactTime(walkProbe, body, 1.05, -(body.vx ?? 0), -(body.vz ?? 0));
        return time < 0.45 || !Number.isFinite(standing) || standing > time + 0.16;
      });
      if (threat) {
        statistics.vehicleYields++;
        target = 0;
        lateral = ped.lateral;
      }
    }
    // 退让时先减速再换移动方向，朝向由实际步幅和受限角速度决定。
    if (dir !== ped.motionDir && ped.v > 0.06 && ped.motionDir) {
      target = 0;
      dir = ped.motionDir;
      stopAt = null;
    } else ped.motionDir = dir;
    const v = ped.v + clamp(target - ped.v, -3.2 * dt, 1.7 * dt);
    const maxSide = leg.restSide && ped.pause > 0 ? 0.65 : 0.95;
    const sideV = (ped.lateralV ?? 0) + clamp(clamp((lateral - ped.lateral) * 3.7, -maxSide, maxSide)
      - (ped.lateralV ?? 0), -4.4 * dt, 4.4 * dt);
    const offset = clamp(ped.lateral + sideV * dt, -poseOffsetLimit(leg, cfg), poseOffsetLimit(leg, cfg));
    const ds = v * dt;
    const finalEnd = dir > 0 ? 1 : 0;
    const nextS = clamp(s + dir * ds, stopAt !== null && dir < 0 ? stopAt : 0,
      stopAt !== null && dir > 0 ? stopAt : leg.length);
    let nextLeg = leg, nextDir = ped.dir, positionS = nextS;
    let switched = false;
    if (stopAt === null && target > 0 && (finalEnd ? leg.length - s : s) < 0.002) {
      const link = forcedLink ?? nextLink(ped, finalEnd);
      if (link?.leg.crossing && !crossingClear(link.leg)) {
        if (ped.pendingLeg !== link) statistics.crossingWaits++;
        ped.pendingLeg = link;
      } else if (link) {
        nextLeg = link.leg;
        positionS = link.end ? nextLeg.length : 0;
        nextDir = link.end ? -1 : 1;
        switched = true;
      }
    }
    const heading = ped.heading;
    const x = ped.x, y = ped.y, z = ped.z;
    const stepClear = point => {
      if (!segment(nextLeg, ped, point) || !clearOfWalkers(ped, point, nearby)) return false;
      if (!vehicles.length) return true;
      writePedestrianCollider(walkProbe, x, y, z, heading, 0);
      const dx = point.x - x, dz = point.z - z;
      return vehicles.every(body => {
        const time = contactTime(walkProbe, body, 1, dx, dz);
        if (!Number.isFinite(time)) return true;
        return time === 0 && vehicleContact(walkProbe, body, walkContact)
          && dx * walkContact.nx + dz * walkContact.nz <= 0;
      });
    };
    let newOffset = switched ? 0 : offset;
    let point = pose(nextLeg, positionS, newOffset, stepPose);
    let accepted = stepClear(point);
    if (!accepted && !switched) {
      // 避让被挡时先试只走直线，再试仅做本次侧移。均从当前位置连续扫掠。
      newOffset = ped.lateral;
      point = pose(leg, nextS, newOffset, stepPose);
      accepted = stepClear(point);
      if (!accepted && Math.abs(offset - ped.lateral) > 0.0001) {
        newOffset = offset;
        positionS = s;
        point = pose(leg, s, newOffset, stepPose);
        accepted = stepClear(point);
      }
    }
    if (!accepted) {
      ped.v = ped.lateralV = 0;
      if (switched && !forcedLink && clock >= (ped.nextLinkCheck ?? 0)) {
        // 原连接暂不可走时才考虑其它同侧连接，避免每帧在岔路换目标。
        const alternatives = leg.ends[finalEnd].filter(link => link.leg !== nextLeg
          && link.leg !== ped.priority?.yielding?.pocket.link?.leg);
        ped.nextLeg = alternatives.find(link => {
          const entry = pose(link.leg, link.end ? link.leg.length : 0, 0, {});
          return segment(link.leg, ped, entry) && clearOfWalkers(ped, entry, nearby);
        }) ?? ped.nextLeg;
        ped.nextLinkCheck = clock + 0.75;
      }
      return;
    }
    const dx = point.x - x, dz = point.z - z;
    const movement = Math.hypot(dx, dz);
    // 轨道换接也要遵守速度预算；端点有误差时保留当前落脚。
    if (movement > (ds + Math.abs(sideV * dt) + 0.015)) {
      ped.v = ped.lateralV = 0;
      return;
    }
    if (switched) {
      if (nextLeg.signal && leg.signal?.id !== nextLeg.signal.id
        && !cfg.crossingControl.enterCrossing(nextLeg.signal, clock, ped.collider.id)) {
        if (ped.pendingLeg !== ped.nextLeg) statistics.crossingWaits++;
        ped.pendingLeg = ped.nextLeg;
        ped.v = 0;
        return;
      }
      ped.pendingLeg = null;
      if (nextLeg.crossing) statistics.crossingsEntered++;
      if (leg.crossing) {
        if (leg.signal && leg.signal.id !== nextLeg.signal?.id) releaseCrossing(ped);
        statistics.crossingsCompleted++;
      }
      ped.fromLeg = leg;
      ped.nextLeg = null;
      ped.leg = nextLeg;
      ped.dir = yielding && !yielding.cleared ? yielding.dir : nextDir;
      ped.motionDir = nextDir;
      ped.avoid = ped.staticPath = null;
    }
    Object.assign(ped, { x: point.x, y: point.y, z: point.z, s: positionS, lateral: newOffset,
      lateralV: switched ? 0 : (newOffset - ped.lateral) / dt, v: positionS !== s || switched ? v : 0,
      vx: dx / dt, vz: dz / dt });
    if (movement > 0.0005) {
      // 少量横向步幅时仍朝向行进方向，避免出现原地左右转圈。
      pose(ped.leg, ped.s, ped.lateral, stepSample);
      const travelDir = switched ? nextDir : dir;
      const base = Math.atan2(stepSample.dx * travelDir, stepSample.dz * travelDir);
      const angle = Math.atan2(dx, dz);
      const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
      const wanted = base + clamp(wrap(angle - base), -0.62, 0.62);
      ped.heading += clamp(wrap(wanted - ped.heading), -2.8 * dt, 2.8 * dt);
    }
    if (!switched && stopAt === null && !forcedLink && !leg.ends[finalEnd].length
      && (finalEnd ? leg.length - ped.s : ped.s) < 0.002 && !yielding) {
      ped.dir = -ped.dir;
      ped.pause = cfg.pauseTurnS;
      ped.v = 0;
      ped.fromLeg = null;
      ped.avoid = ped.staticPath = null;
    }
  }

  function update(dt, focus, elapsed, isVisible = null, players = null, traffic = []) {
    if (!focus || !Number.isFinite(focus.x) || !Number.isFinite(focus.z)) return;
    dt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.05));
    clock = Number.isFinite(elapsed) ? elapsed : clock + dt;
    const jump = lastFocus ? Math.hypot(focus.x - lastFocus.x, focus.z - lastFocus.z) > cfg.recycleRadiusM : false;
    if (!region || jump || Math.hypot(focus.x - region.center.x, focus.z - region.center.z) > cfg.regionShiftM) {
      buildRegion(focus);
    }
    lastFocus = { x: focus.x, z: focus.z };
    collectAvoidance(players);
    nearbyVehicles.length = 0;
    nearbyVehicles.push(...traffic);
    const car = players?.find(entity => entity.type === 'car');
    if (car) nearbyVehicles.push(writeEntityCollider(vehicleProbe, car));
    // 远处回收：保证活动区人数只受 focus 附近轨道容量限制。
    const recycleSq = cfg.recycleRadiusM ** 2;
    let placedNow = 0;
    for (const ped of peds) {
      if (!ped.placed) continue;
      if (squareDistance(ped.x, ped.z, focus.x, focus.z) > recycleSq) {
        unplace(ped);
        statistics.recycled++;
        continue;
      }
      placedNow++;
    }
    // 地点密度目标：走过的街区比当前目标稀时，先回收看不见的最远处人物，不直接在眼前减人。
    const targetPeds = region?.targetPeds ?? targetMin;
    if (!jump && placedNow > targetPeds + cfg.densityHysteresisPeds) {
      const retired = [];
      for (const ped of peds) {
        if (!ped.placed) continue;
        const distanceSq = squareDistance(ped.x, ped.z, focus.x, focus.z);
        if (distanceSq < cfg.viewProtectM ** 2) continue;
        if (isVisible && isVisible(ped.x, ped.z, 7, ped.y)) continue;
        if (!isVisible && distanceSq < 150 ** 2) continue;
        retired.push({ ped, distanceSq });
      }
      retired.sort((a, b) => b.distanceSq - a.distanceSq);
      for (let i = 0; i < Math.min(cfg.retirePerFrame, retired.length) && placedNow > targetPeds; i++) {
        unplace(retired[i].ped);
        statistics.recycled++;
        placedNow--;
      }
    }
    grid.clear();
    for (const ped of peds) if (ped.placed) grid.add(ped);
    let budget = jump ? cfg.maxPeds : cfg.spawnBudget;
    // 保留少量源人行道客流，防止邻近数公里的通用步道耗尽路口的出生配额。
    if (region.crossingApproaches.length && budget > 0
      && peds.filter(ped => ped.placed && ped.leg?.kind === 'crossing-network').length < 3) {
      const pedestrian = peds.find(ped => !ped.placed);
      const approach = region.crossingApproaches[Math.floor(random() * region.crossingApproaches.length)];
      if (pedestrian && trySpawn(pedestrian, focus, isVisible, approach)) placedNow++;
      budget--;
    }
    let scanned = 0;
    while (budget > 0 && scanned < peds.length && placedNow < targetPeds) {
      const ped = peds[spawnCursor];
      spawnCursor = (spawnCursor + 1) % peds.length;
      scanned++;
      if (ped.placed) continue;
      budget--;
      if (trySpawn(ped, focus, isVisible)) placedNow++;
    }
    nearPeds.length = 0;
    crowd.begin();
    let placed = 0;
    let drawn = 0;
    const nearSq = cfg.nearRadiusM ** 2;
    for (const ped of peds) {
      if (!ped.placed) continue;
      placed++;
      const dx = ped.x - focus.x;
      const dz = ped.z - focus.z;
      const distanceSq = dx * dx + dz * dz;
      ped.activeWalker = distanceSq <= nearSq || Boolean(ped.leg?.crossing);
      if (!ped.activeWalker) {
        ped.frameVX = ped.frameVZ = ped.vx = ped.vz = 0;
        if (ped.rig.placed) ped.rig.placed = false;
        continue;
      }
      sampleTrack(ped.leg, ped.s, scratch);
      ped.fx = scratch.dx * ped.dir;
      ped.fz = scratch.dz * ped.dir;
      nearPeds.push(ped);
    }
    // 规划读取同一帧的位置和速度，执行再校核连续包络。
    walkerAvoidance.update(nearPeds, grid, clock);
    for (let i = 0; i < nearPeds.length; i++) {
      const ped = nearPeds[i];
      const { x, z } = ped;
      ped.vx = ped.vz = 0;
      advance(ped, dt);
      ped.stuckFor = Math.hypot(ped.x - x, ped.z - z) > 0.003 ? 0 : (ped.stuckFor ?? 0) + dt;
      writePedestrianCollider(ped.collider, ped.x, ped.y, ped.z, ped.heading, ped.v);
      if (dt) {
        ped.collider.vx = (ped.x - x) / dt;
        ped.collider.vz = (ped.z - z) / dt;
      }
      const distanceSq = squareDistance(ped.x, ped.z, focus.x, focus.z);
      if (distanceSq > nearSq) { ped.rig.placed = false; continue; }
      const draw = !isVisible || isVisible(ped.x, ped.z, 7, ped.y);
      if (draw) drawn++;
      // 隐藏但离得近的人仍然推进步态；超过 50 m 且看不见则等待重新落地，省掉骨骼计算。
      if (!draw && distanceSq > 2500) ped.rig.placed = false;
      else crowd.updateWalker(ped, dt, ground, draw, draw ? Math.sqrt(distanceSq) : 0);
    }
    crowd.end();
    statistics.placed = placed;
    statistics.near = nearPeds.length;
    statistics.drawn = drawn;
  }

  function nearColliders(x, z, radius) {
    // 车流会查询整个活动半径，宽查询直接扫 140 人池比枚举空格更便宜。
    const pool = radius <= 12 ? grid.query(x, z, radius + 0.65, []) : nearPeds;
    return pool.filter(ped => ped.activeWalker
      && Math.abs(ped.x - x) < radius + 0.4 && Math.abs(ped.z - z) < radius + 0.4).map(ped => ped.collider);
  }

  function dispose() {
    for (const ped of peds) releaseCrossing(ped);
    scene.remove(group);
    crowd.dispose();
    if (pavementMesh) {
      group.remove(pavementMesh);
      pavementGeometry?.dispose();
      pavementMesh = null;
      pavementGeometry = null;
    }
    pavementMaterial.dispose();
    region = null;
    grid.clear();
  }

  return { group, meshes: crowd.meshes, update, nearColliders, statistics, dispose, peds, densityAt,
    densityModel, get region() { return region; } };
}
