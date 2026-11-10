import * as THREE from 'three/webgpu';
import { sceneUniforms } from './sz-materials.js';

// 普通建筑名称标牌：按玩家位置分块流式生成，近处贴墙入口牌，高楼屋顶立式双面牌。
// 标牌只读取 building.name；数据缺少 name 或名字只是“1栋/A座”时跳过，不补造名称。
export const SIGN_CHUNK_SIZE = 200;
export const ENTRANCE_RADIUS = 300;
export const ROOF_RADIUS = 900;
export const ENTRANCE_UNLOAD_RADIUS = ENTRANCE_RADIUS * 1.3;
export const ROOF_UNLOAD_RADIUS = ROOF_RADIUS * 1.3;
export const NEAREST_NAME_RADIUS = 150;
export const ROOF_SIGN_MIN_HEIGHT = 60;
export const MAX_SIGN_TEXTURES = 160;
// 小区门牌：把只有单元号（1栋/A座）的住宅楼按邻近具名住宅聚成小区，只在小区临路边立一块门牌。
export const COMPOUND_RADIUS = 90;
export const COMPOUND_CELL = 100;
export const COMPOUND_MIN_MEMBERS = 2;

const ROAD_QUERY_RADIUS = 400;
const ROAD_CELL = 200;
const MAX_NAME_CHARS = 14;
const SIGN_FONT = "'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC',sans-serif";

// 没有 building.levels 时用立面表估计层高；只用于入口牌竖直位置，不当作真实层数。
const FLOOR_HEIGHT_BY_FACADE = {
  glass_tower: 4.2, office: 3.9, residential_tower: 3.0, residential_low: 3.0,
  village: 2.9, industrial: 6.0, public: 4.5, landmark: 4.4
};

// 住宅尾部单元号：1栋、A座、第3栋、1号楼、2单元、3期；可连续出现（1栋2单元）。
const UNIT_SUFFIX = /(?:第\s*)?[0-9A-Za-z一二三四五六七八九十百]+\s*(?:栋|座|号楼|号|单元|期)\s*$/u;
// 整名就是单元号或在单元号后只剩空白的名字，没有小区/楼宇信息。
const UNIT_ONLY = /^(?:(?:第\s*)?[0-9A-Za-z一二三四五六七八九十百]+\s*(?:栋|座|号楼|号|单元|期)\s*)+$/u;
// 4D、2A、T2-A、9-2、29D,30-3 这类纯门牌编号：没有可读楼名，不出牌。
const UNIT_CODE_ONLY = /^[0-9A-Za-z,+&/\-]+$/;
// 机构/写字楼名不做小区门牌的锚点，避免把“某某大队”当成住宅小区名。
const INSTITUTION_NAME = /(公司|集团|学校|小学|中学|大学|幼儿园|医院|法院|公安|派出所|大队|中队|支队|政府|委员会|管理处|工业|厂房|仓库|银行|酒店|宾馆|商场|超市|市场|基地|园区|大厦|写字楼)/u;

function nowMs() {
  return typeof performance === 'object' && performance && typeof performance.now === 'function'
    ? performance.now() : Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash / 4294967296;
}

function charCount(text) {
  return Array.from(text).length;
}

function isResidential(building) {
  if (!building) return false;
  if (building.category === 'residential') return true;
  return typeof building.facade === 'string' && building.facade.startsWith('residential_');
}

function stripUnitSuffix(name) {
  let result = name.trim();
  for (;;) {
    const next = result.replace(UNIT_SUFFIX, '').trim();
    if (next === result) return result;
    result = next;
  }
}

// 只产出显示用名称，不回写 building.name；来源仍是源数据。返回 null 表示这栋楼不出牌。
export function normalizeName(name, building = null) {
  if (typeof name !== 'string') return null;
  const raw = name.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const display = isResidential(building) ? stripUnitSuffix(raw) : raw;
  if (charCount(display) < 2) return null;
  if (UNIT_ONLY.test(display)) return null;
  if (UNIT_CODE_ONLY.test(display) && /[0-9]/.test(display) && charCount(display) <= 8) return null;
  if (/^[0-9]+$/.test(display)) return null;
  if (charCount(display) > MAX_NAME_CHARS) return `${Array.from(display).slice(0, MAX_NAME_CHARS - 1).join('')}…`;
  return display;
}

export function buildingDisplayName(building) {
  if (!building || building.facade === 'landmark') return null;
  return normalizeName(building.name, building);
}

function floorHeightOf(building) {
  if (Number.isFinite(building.levels) && building.levels > 0 && Number.isFinite(building.height)
    && building.height > 0) return building.height / building.levels;
  return FLOOR_HEIGHT_BY_FACADE[building.facade] ?? 3.3;
}

function baseYOf(building, options) {
  if (Number.isFinite(building.baseY)) return building.baseY;
  if (Number.isFinite(building.minY) && Number.isFinite(building.minHeight)) return building.minY - building.minHeight;
  if (typeof options.groundHeight === 'function') {
    const height = options.groundHeight(building.cx, building.cz);
    if (Number.isFinite(height)) return height;
  }
  return 0;
}

function outerRing(building) {
  const ring = building?.polygons?.[0]?.outer;
  if (Array.isArray(ring) && ring.length >= 3) return ring;
  if ([building?.minX, building?.maxX, building?.minZ, building?.maxZ].every(Number.isFinite)) {
    const { minX, maxX, minZ, maxZ } = building;
    return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
  }
  return null;
}

// x 向东、z 向南；正面积环的外法线为 (dz, -dx)，负面积反过来。
function signedRingArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function nearestPointOnRoad(road, x, z) {
  let best = null;
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1];
    const b = road.points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length2 = dx * dx + dz * dz;
    if (length2 === 0) continue;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / length2, 0, 1);
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (!best || distance < best.distance) best = { x: px, z: pz, distance };
  }
  return best;
}

export function createRoadIndex(roadGraph) {
  const nodes = roadGraph?.nodes;
  const links = roadGraph?.links;
  const roads = [];
  const cells = new Map();
  if (Array.isArray(nodes) && Array.isArray(links)) {
    for (let id = 0; id < links.length; id++) {
      const link = links[id];
      if (!Array.isArray(link) || link.length < 2) continue;
      const ax = nodes[link[0] * 2];
      const az = nodes[link[0] * 2 + 1];
      const bx = nodes[link[1] * 2];
      const bz = nodes[link[1] * 2 + 1];
      if (![ax, az, bx, bz].every(Number.isFinite)) continue;
      const points = [{ x: ax, z: az }];
      const inner = link[6];
      if (Array.isArray(inner)) {
        for (let k = 0; k + 1 < inner.length; k += 2) {
          if (Number.isFinite(inner[k]) && Number.isFinite(inner[k + 1])) points.push({ x: inner[k], z: inner[k + 1] });
        }
      }
      points.push({ x: bx, z: bz });
      const road = { id, points, width: Number.isFinite(link[3]) ? link[3] : 0 };
      roads.push(road);
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const point of points) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      }
      for (let cx = Math.floor(minX / ROAD_CELL); cx <= Math.floor(maxX / ROAD_CELL); cx++) {
        for (let cz = Math.floor(minZ / ROAD_CELL); cz <= Math.floor(maxZ / ROAD_CELL); cz++) {
          const key = `${cx},${cz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(road);
        }
      }
    }
  }
  function query(x, z, radius = ROAD_QUERY_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const seen = new Set();
    let best = null;
    for (let cx = Math.floor((x - radius) / ROAD_CELL); cx <= Math.floor((x + radius) / ROAD_CELL); cx++) {
      for (let cz = Math.floor((z - radius) / ROAD_CELL); cz <= Math.floor((z + radius) / ROAD_CELL); cz++) {
        for (const road of cells.get(`${cx},${cz}`) || []) {
          if (seen.has(road)) continue;
          seen.add(road);
          const hit = nearestPointOnRoad(road, x, z);
          if (hit && hit.distance <= radius && (!best || hit.distance < best.distance
            || (hit.distance === best.distance && road.id < best.road.id))) {
            best = { ...hit, road };
          }
        }
      }
    }
    return best;
  }
  return { roads, query };
}

function wallCandidates(building) {
  const ring = outerRing(building);
  if (!ring) return [];
  const area = signedRingArea(ring);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-6) return [];
  const walls = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(length > 0.5)) continue;
    const tangentX = (b.x - a.x) / length;
    const tangentZ = (b.z - a.z) / length;
    const normalX = area > 0 ? tangentZ : -tangentZ;
    const normalZ = area > 0 ? -tangentX : tangentX;
    walls.push({ index: i, length, tangentX, tangentZ, normalX, normalZ,
      midX: (a.x + b.x) / 2, midZ: (a.z + b.z) / 2 });
  }
  return walls;
}

// 选一面墙：优先朝向建筑 400m 内最近道路、且墙宽够放牌子的墙；完全没有道路时用最长墙。
export function selectSignWall(building, roadGraphOrIndex, requiredWidth = 3) {
  const walls = wallCandidates(building);
  if (!walls.length) return null;
  if (!roadGraphOrIndex) return walls.reduce((best, wall) => wall.length > best.length ? wall : best);
  const index = typeof roadGraphOrIndex.query === 'function' ? roadGraphOrIndex : createRoadIndex(roadGraphOrIndex);
  const road = index.query(building.cx, building.cz, ROAD_QUERY_RADIUS);
  if (!road || road.distance > ROAD_QUERY_RADIUS) {
    return walls.reduce((best, wall) => wall.length > best.length ? wall : best);
  }
  let best = null;
  let bestScore = Infinity;
  for (const wall of walls) {
    const dx = road.x - wall.midX;
    const dz = road.z - wall.midZ;
    const distance = Math.hypot(dx, dz);
    const dot = distance > 1e-6 ? (wall.normalX * dx + wall.normalZ * dz) / distance : 1;
    const facesRoad = dot > 0.35 || road.distance < 0.5;
    const shortfall = Math.max(0, requiredWidth + 0.3 - wall.length);
    // 朝向不把墙排除，只罚分；牌宽不够的墙同样罚分，保证窄楼仍有一个可放的最长墙。
    const score = (facesRoad ? 0 : 1 + Math.max(0, -dot)) * 10000
      + shortfall * 400 + Math.max(0, 30 - wall.length) * 2;
    if (score < bestScore || (score === bestScore && wall.length > best.length)) {
      bestScore = score;
      best = wall;
    }
  }
  return best;
}

function entranceTextureInfo(name, building) {
  const chars = charCount(name);
  const aspect = clamp(2.9 + chars * 0.17, 3.0, 5.2);
  const variant = isResidential(building) ? 'residential' : 'standard';
  return { kind: 'entrance', variant, name, chars, aspect };
}

function roofTextureInfo(name, building = null) {
  const chars = charCount(name);
  // 真实深圳高楼屋顶字牌通常 20–40 米宽、5 米以上高，远看才认得出；低于 60 米只做入口牌。
  const tall = Number.isFinite(building?.height) ? building.height : ROOF_SIGN_MIN_HEIGHT;
  const scale = clamp(tall / 150, 0.75, 2.0);
  const width = clamp((chars * 2.6 + 6) * scale, 10, 44);
  const height = clamp(width / 4.4, 3.4, 9);
  return { kind: 'roof', variant: 'warm', name, chars, width, height, aspect: width / height };
}

function planEntrance(building, name, wall, baseY) {
  const info = entranceTextureInfo(name, building);
  let height = clamp(1.2 + (info.chars - 2) * 0.025, 1.2, 1.5);
  let width = info.aspect * height;
  if (width > 8) { width = 8; height = width / info.aspect; }
  if (width < 3) return null;
  if (width > wall.length - 0.3) return null;
  const minY = baseY + (Number.isFinite(building.minHeight) ? building.minHeight : 0);
  const topY = baseY + (Number.isFinite(building.height) ? building.height : 0);
  const floorHeight = floorHeightOf(building);
  let y = minY + clamp(floorHeight * 0.9, 2.6, 3.8);
  y = Math.min(y, topY - height / 2 - 0.15);
  y = Math.max(y, minY + height / 2 + 0.4);
  if (y + height / 2 > topY + 0.001) return null;
  return { kind: 'entrance', name, variant: info.variant, width, height, aspect: width / height,
    x: wall.midX + wall.normalX * 0.12, y, z: wall.midZ + wall.normalZ * 0.12,
    normalX: wall.normalX, normalZ: wall.normalZ, rotationY: Math.atan2(wall.normalX, wall.normalZ),
    wallLength: wall.length, chars: info.chars };
}

function planRoof(building, name, wall, baseY) {
  const info = roofTextureInfo(name, building);
  let width = info.width;
  if (width > wall.length - 0.6) width = wall.length - 0.6;
  if (width < 5) return null;
  const height = clamp(width / 4.4, 3.0, 9);
  const bottomY = baseY + (Number.isFinite(building.height) ? building.height : 0) + 0.35;
  return { kind: 'roof', name, variant: info.variant, width, height, aspect: width / height,
    x: wall.midX - wall.normalX * 0.8, y: bottomY + height / 2, z: wall.midZ - wall.normalZ * 0.8,
    normalX: wall.normalX, normalZ: wall.normalZ, rotationY: Math.atan2(wall.normalX, wall.normalZ),
    wallLength: wall.length, chars: info.chars };
}

// 小区门牌：取小区内离最近道路最近的一栋楼，在它朝路的墙上放一块双面门牌。
// 名称来自具名邻居的显示名（推断的小区归属，只用于显示，不回写建筑数据）。
export function planCompoundSign(cluster, options = {}) {
  if (!cluster || !cluster.name || !Array.isArray(cluster.members) || cluster.members.length < COMPOUND_MIN_MEMBERS) return null;
  const roadIndex = options.roadIndex ?? options.roadGraph;
  let target = null;
  let bestDistance = Infinity;
  for (const member of cluster.members) {
    if (!member || !Number.isFinite(member.cx) || !Number.isFinite(member.cz)) continue;
    const road = roadIndex && typeof roadIndex.query === 'function' ? roadIndex.query(member.cx, member.cz) : null;
    const distance = road ? road.distance : Math.hypot(member.cx - cluster.members[0].cx, member.cz - cluster.members[0].cz);
    if (!target || distance < bestDistance) { target = member; bestDistance = distance; }
  }
  if (!target) return null;
  const chars = charCount(cluster.name);
  let height = clamp(2.0 + chars * 0.06, 2.0, 2.8);
  let aspect = clamp(3.4 + chars * 0.2, 3.4, 6.0);
  let width = height * aspect;
  const wall = selectSignWall(target, roadIndex, Math.min(width, 12));
  if (!wall) return null;
  width = Math.min(width, wall.length - 0.3);
  if (width < 6) return null;
  height = width / aspect;
  const baseY = baseYOf(target, options);
  const minY = baseY + (Number.isFinite(target.minHeight) ? target.minHeight : 0);
  const topY = baseY + (Number.isFinite(target.height) ? target.height : 0);
  let y = minY + clamp(1.6 + height * 0.5, 2.2, 3.4);
  y = Math.min(y, topY - height / 2 - 0.15);
  y = Math.max(y, minY + height / 2 + 0.4);
  if (y + height / 2 > topY + 0.001) return null;
  return { kind: 'compound', name: cluster.name, variant: 'residential', width, height, aspect,
    x: wall.midX + wall.normalX * 0.12, y, z: wall.midZ + wall.normalZ * 0.12,
    normalX: wall.normalX, normalZ: wall.normalZ, rotationY: Math.atan2(wall.normalX, wall.normalZ),
    wallLength: wall.length, chars, members: cluster.members.length, targetId: target.id };
}

// 纯规划函数：不建纹理、不碰 THREE，便于单测和确定性检查。没有可用名称/墙面时返回 null。
export function planBuildingSigns(building, options = {}) {
  const name = buildingDisplayName(building);
  if (!name) return null;
  const tall = Number.isFinite(building.height) && building.height >= ROOF_SIGN_MIN_HEIGHT;
  const baseY = baseYOf(building, options);
  const requiredWidth = tall ? roofTextureInfo(name, building).width : 3;
  const wall = selectSignWall(building, options.roadIndex ?? options.roadGraph, requiredWidth);
  if (!wall) return null;
  return tall ? planRoof(building, name, wall, baseY) : planEntrance(building, name, wall, baseY);
}

function drawSignPanel(ctx, width, height, info) {
  const residential = info.variant === 'residential';
  const roof = info.kind === 'roof';
  ctx.clearRect(0, 0, width, height);
  const background = roof ? '#101722' : (residential ? '#7c1f22' : '#14181d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const inset = Math.max(3, Math.round(height * 0.045));
  ctx.lineWidth = Math.max(2, Math.round(height * 0.02));
  ctx.strokeStyle = roof ? 'rgba(255, 224, 164, 0.92)' : 'rgba(238, 240, 236, 0.72)';
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
  ctx.fillStyle = roof ? '#fff3d4' : '#f5f6f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fontSize = Math.round(height * (roof ? 0.5 : 0.46));
  const maxTextWidth = width * 0.86;
  for (;;) {
    ctx.font = `700 ${fontSize}px ${SIGN_FONT}`;
    if (ctx.measureText(info.name).width <= maxTextWidth || fontSize <= 10) break;
    fontSize -= 1;
  }
  ctx.fillText(info.name, width / 2, height / 2 + height * 0.015);
}

// 浏览器默认实现；测试通过 options.createTexture 注入替身，不在测试里改运行时路径。
export function createCanvasSignTexture(info) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const canvas = document.createElement('canvas');
  const pixelWidth = info.kind === 'roof' ? 1024 : 640;
  const aspect = Number.isFinite(info.aspect) && info.aspect > 0 ? info.aspect : 4;
  canvas.width = pixelWidth;
  canvas.height = Math.max(80, Math.round(pixelWidth / aspect));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawSignPanel(ctx, canvas.width, canvas.height, info);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// 双面立式牌：两片四边形各自使用正读 UV，背面的文字不会镜像。
function doubleSidedPanelGeometry(width, height) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const zOffset = 0.03;
  const positions = [
    -halfWidth, -halfHeight, zOffset, halfWidth, -halfHeight, zOffset,
    halfWidth, halfHeight, zOffset, -halfWidth, halfHeight, zOffset,
    halfWidth, -halfHeight, -zOffset, -halfWidth, -halfHeight, -zOffset,
    -halfWidth, halfHeight, -zOffset, halfWidth, halfHeight, -zOffset
  ];
  const uvs = [
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// buildings 建议传 buildCityBlocks().allBlocks（带 baseY），否则用 options.groundHeight(x, z) 补地面高；
// 缺 baseY 时按 0 处理，山区标牌会埋进地形。roadGraph 可传 GEO.roadGraph。
// update(position) 每帧调用；nearestName(x, z) 返回 150m 内最近有名字建筑的显示名（string|null）。
export function buildBuildingSigns(scene, options = {}) {
  const buildings = Array.isArray(options.buildings) ? options.buildings : [];
  const roadGraph = options.roadGraph ?? null;
  const textureFactory = options.createTexture ?? createCanvasSignTexture;
  const maxChunkOps = Number.isFinite(options.maxChunkOps) ? Math.max(1, Math.floor(options.maxChunkOps)) : 2;
  // 单块可能挤着几十栋有名字的楼；再限一个每帧建牌数，避免 Canvas 建纹理造成长帧。
  const maxSignsPerUpdate = Number.isFinite(options.maxSignsPerUpdate)
    ? Math.max(1, Math.floor(options.maxSignsPerUpdate)) : 4;
  const canCreateTextures = typeof textureFactory === 'function'
    && (options.createTexture !== undefined || typeof document !== 'undefined');
  const group = new THREE.Group();
  group.name = 'ShenzhenBuildingSigns';
  if (scene && typeof scene.add === 'function') scene.add(group);

  // 分块与名称索引只依赖建筑数据；纹理和几何在 update 时按距离产生。
  const chunkBuildings = new Map();
  const nameCells = new Map();
  const compoundByChunk = new Map();
  const chunkKeyOf = (x, z) => `${Math.floor(x / SIGN_CHUNK_SIZE)},${Math.floor(z / SIGN_CHUNK_SIZE)}`;
  const displayNameByBuilding = new Map();

  // 把具名楼加入 HUD 索引；同一栋可能跨多个 200m 索引格。
  function addNameCellEntry(building, display) {
    const cx = Number.isFinite(building?.cx) ? building.cx : (building?.minX + building?.maxX) / 2;
    const cz = Number.isFinite(building?.cz) ? building.cz : (building?.minZ + building?.maxZ) / 2;
    const minX = Number.isFinite(building.minX) ? building.minX : cx;
    const maxX = Number.isFinite(building.maxX) ? building.maxX : cx;
    const minZ = Number.isFinite(building.minZ) ? building.minZ : cz;
    const maxZ = Number.isFinite(building.maxZ) ? building.maxZ : cz;
    for (let kx = Math.floor(minX / ROAD_CELL); kx <= Math.floor(maxX / ROAD_CELL); kx++) {
      for (let kz = Math.floor(minZ / ROAD_CELL); kz <= Math.floor(maxZ / ROAD_CELL); kz++) {
        const cellKey = `${kx},${kz}`;
        if (!nameCells.has(cellKey)) nameCells.set(cellKey, []);
        nameCells.get(cellKey).push({ building, display, minX, maxX, minZ, maxZ });
      }
    }
  }

  for (const building of buildings) {
    const cx = Number.isFinite(building?.cx) ? building.cx : (building?.minX + building?.maxX) / 2;
    const cz = Number.isFinite(building?.cz) ? building.cz : (building?.minZ + building?.maxZ) / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
    const key = chunkKeyOf(cx, cz);
    if (!chunkBuildings.has(key)) chunkBuildings.set(key, []);
    chunkBuildings.get(key).push(building);
    const display = buildingDisplayName(building);
    displayNameByBuilding.set(building, display);
    if (display) addNameCellEntry(building, display);
  }

  // 小区门牌：只有单元号的住宅楼按 90m 邻域归到具名住宅；至少两栋才成一个小区。
  // 名称与归属是显示推断，不回写源数据，也不改变每栋楼的入口牌规则。
  function buildCompoundClusters() {
    const anchors = [];
    const unitOnly = [];
    for (const building of buildings) {
      if (!building || building.facade === 'landmark' || !isResidential(building)
        || typeof building.name !== 'string' || !building.name.trim()) continue;
      if (!Number.isFinite(building.cx) || !Number.isFinite(building.cz)) continue;
      const display = displayNameByBuilding.get(building);
      if (display) {
        // 只把像住宅小区的名字当锚点；机构名仍保留这栋楼自己的入口牌。
        if (!INSTITUTION_NAME.test(display)) anchors.push({ display, building, x: building.cx, z: building.cz });
      } else unitOnly.push(building);
    }
    if (!anchors.length || !unitOnly.length) return;
    const anchorCells = new Map();
    for (const anchor of anchors) {
      const key = `${Math.floor(anchor.x / COMPOUND_CELL)},${Math.floor(anchor.z / COMPOUND_CELL)}`;
      if (!anchorCells.has(key)) anchorCells.set(key, []);
      anchorCells.get(key).push(anchor);
    }
    const clusters = new Map();
    for (const member of unitOnly) {
      let best = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${Math.floor(member.cx / COMPOUND_CELL) + dx},${Math.floor(member.cz / COMPOUND_CELL) + dz}`;
          for (const anchor of anchorCells.get(key) || []) {
            const distance = Math.hypot(anchor.x - member.cx, anchor.z - member.cz);
            if (distance > COMPOUND_RADIUS) continue;
            if (!best || distance < best.distance) best = { anchor, distance };
          }
        }
      }
      if (!best) continue;
      // 同一显示名 + 200m 格视为同一小区，避免一个小区立多块门牌。
      const clusterKey = `${best.anchor.display}|${Math.floor(best.anchor.x / 200)},${Math.floor(best.anchor.z / 200)}`;
      let cluster = clusters.get(clusterKey);
      if (!cluster) {
        cluster = { name: best.anchor.display, anchor: best.anchor.building, members: [] };
        clusters.set(clusterKey, cluster);
      }
      cluster.members.push(member);
    }
    let count = 0;
    for (const cluster of clusters.values()) {
      if (cluster.members.length < COMPOUND_MIN_MEMBERS) continue;
      let sx = 0;
      let sz = 0;
      for (const member of cluster.members) { sx += member.cx; sz += member.cz; }
      const key = chunkKeyOf(sx / cluster.members.length, sz / cluster.members.length);
      if (!compoundByChunk.has(key)) compoundByChunk.set(key, []);
      compoundByChunk.get(key).push(cluster);
      for (const member of cluster.members) addNameCellEntry(member, cluster.name);
      count++;
    }
    statistics.compoundClusters = count;
  }

  let roadIndex = null;
  const getRoadIndex = () => {
    if (!roadIndex && roadGraph) roadIndex = createRoadIndex(roadGraph);
    return roadIndex;
  };

  const chunks = new Map();
  const textureCache = new Map();
  const materialCache = new Map();
  const geometryCache = new Map();
  let textureClock = 0;
  let lastNight = -1;
  let disposed = false;
  const statistics = { signs: 0, textures: 0, chunks: 0, updateMs: 0, compounds: 0, compoundClusters: 0,
    texturesCreated: 0, texturesDisposed: 0, namedBuildings: buildings.filter(b => buildingDisplayName(b)).length };
  buildCompoundClusters();

  function chunkCenter(key) {
    const [cx, cz] = key.split(',').map(Number);
    return { x: cx * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2, z: cz * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2 };
  }

  function acquireTexture(info) {
    const key = `${info.kind}|${info.variant}|${info.name}|${info.aspect.toFixed(3)}`;
    let entry = textureCache.get(key);
    if (entry) {
      entry.refs++;
      entry.lastUsed = ++textureClock;
      textureCache.delete(key);
      textureCache.set(key, entry);
      return { key, texture: entry.texture, kind: info.kind };
    }
    if (textureCache.size >= MAX_SIGN_TEXTURES) {
      for (const [oldKey, oldEntry] of textureCache) {
        if (oldEntry.refs > 0) continue;
        textureCache.delete(oldKey);
        oldEntry.texture.dispose();
        statistics.texturesDisposed++;
        if (textureCache.size < MAX_SIGN_TEXTURES) break;
      }
    }
    const texture = textureFactory(info);
    if (!texture) return null;
    entry = { texture, refs: 1, lastUsed: ++textureClock };
    textureCache.set(key, entry);
    statistics.texturesCreated++;
    return { key, texture, kind: info.kind };
  }

  function releaseTexture(key) {
    const entry = textureCache.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      textureCache.delete(key);
      entry.texture.dispose();
      statistics.texturesDisposed++;
    }
  }

  function acquireMaterial(textureKey, texture, kind) {
    let entry = materialCache.get(textureKey);
    if (entry) {
      entry.refs++;
      return entry;
    }
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.FrontSide });
    material.name = `BuildingSignMaterial:${kind}`;
    entry = { material, refs: 1, kind };
    applyMaterialNight(entry);
    materialCache.set(textureKey, entry);
    return entry;
  }

  function releaseMaterial(textureKey) {
    const entry = materialCache.get(textureKey);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      materialCache.delete(textureKey);
      entry.material.dispose();
    }
  }

  function acquireGeometry(kind, width, height) {
    const key = `${kind}|${width.toFixed(2)}|${height.toFixed(2)}`;
    let entry = geometryCache.get(key);
    if (entry) {
      entry.refs++;
      return entry.geometry;
    }
    const geometry = kind === 'roof' || kind === 'compound'
      ? doubleSidedPanelGeometry(width, height)
      : new THREE.PlaneGeometry(width, height);
    entry = { geometry, refs: 1 };
    geometryCache.set(key, entry);
    return geometry;
  }

  function releaseGeometry(kind, width, height) {
    const key = `${kind}|${width.toFixed(2)}|${height.toFixed(2)}`;
    const entry = geometryCache.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      geometryCache.delete(key);
      entry.geometry.dispose();
    }
  }

  function ensureChunkState(key) {
    let state = chunks.get(key);
    if (!state) {
      const chunkGroup = new THREE.Group();
      chunkGroup.name = `BuildingSigns:${key}`;
      group.add(chunkGroup);
      state = { key, group: chunkGroup, entrance: [], roof: [], compound: [],
        entranceDone: false, roofDone: false, compoundDone: false,
        entranceCursor: 0, roofCursor: 0, compoundCursor: 0 };
      chunks.set(key, state);
    }
    return state;
  }

  // 每帧只建预算内的牌子；没建完的块保留游标，下一次 update 接着做，避免一帧内建几十张 Canvas。
  function generateKind(state, kind, list, budget) {
    if (state[`${kind}Done`]) return;
    let cursor = state[`${kind}Cursor`];
    for (; cursor < list.length; cursor++) {
      if (budget.remaining <= 0) break;
      const building = list[cursor];
      const tall = Number.isFinite(building.height) && building.height >= ROOF_SIGN_MIN_HEIGHT;
      if (tall !== (kind === 'roof')) continue;
      const spec = planBuildingSigns(building, { ...options, roadIndex: getRoadIndex() });
      if (!spec) continue;
      if (!canCreateTextures) continue;
      const texture = acquireTexture(spec);
      if (!texture) continue;
      budget.remaining--;
      const material = acquireMaterial(texture.key, texture.texture, spec.kind);
      const geometry = acquireGeometry(spec.kind, spec.width, spec.height);
      const mesh = new THREE.Mesh(geometry, material.material);
      mesh.name = `BuildingSign:${spec.kind}:${building.id}`;
      mesh.position.set(spec.x, spec.y, spec.z);
      mesh.rotation.y = spec.rotationY;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.sign = { kind: spec.kind, buildingId: building.id, name: spec.name };
      state.group.add(mesh);
      state[spec.kind].push({ mesh, textureKey: texture.key, spec });
    }
    state[`${kind}Cursor`] = cursor;
    if (cursor >= list.length) state[`${kind}Done`] = true;
  }

  // 小区门牌：和入口牌同半径生成，每块每帧受同一预算限制。
  function generateCompounds(state, budget) {
    if (state.compoundDone) return;
    const list = compoundByChunk.get(state.key) || [];
    let cursor = state.compoundCursor;
    for (; cursor < list.length; cursor++) {
      if (budget.remaining <= 0 || !canCreateTextures) break;
      const spec = planCompoundSign(list[cursor], { ...options, roadIndex: getRoadIndex() });
      if (!spec) continue;
      const texture = acquireTexture(spec);
      if (!texture) continue;
      budget.remaining--;
      const material = acquireMaterial(texture.key, texture.texture, 'compound');
      const geometry = acquireGeometry('compound', spec.width, spec.height);
      const mesh = new THREE.Mesh(geometry, material.material);
      mesh.name = `BuildingSign:compound:${list[cursor].name}`;
      mesh.position.set(spec.x, spec.y, spec.z);
      mesh.rotation.y = spec.rotationY;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.sign = { kind: 'compound', buildingId: null, name: spec.name, compound: true };
      state.group.add(mesh);
      state.compound.push({ mesh, textureKey: texture.key, spec });
    }
    state.compoundCursor = cursor;
    if (cursor >= list.length) state.compoundDone = true;
  }

  function generateChunk(key, wantEntrance, wantRoof, budget) {
    const state = ensureChunkState(key);
    const list = chunkBuildings.get(key) || [];
    if (wantEntrance) generateKind(state, 'entrance', list, budget);
    if (wantRoof) generateKind(state, 'roof', list, budget);
    if (wantEntrance) generateCompounds(state, budget);
  }

  function disposeSigns(state, kind) {
    for (const record of state[kind]) {
      state.group.remove(record.mesh);
      releaseGeometry(kind, record.spec.width, record.spec.height);
      releaseMaterial(record.textureKey);
      releaseTexture(record.textureKey);
    }
    state[kind] = [];
    state[`${kind}Done`] = false;
    state[`${kind}Cursor`] = 0;
  }

  function pruneChunk(state) {
    if (state.entrance.length || state.compound.length || state.roof.length) return;
    if (!state.entranceDone && !state.compoundDone && !state.roofDone) {
      group.remove(state.group);
      chunks.delete(state.key);
    }
  }

  function currentNight() {
    const value = Number(sceneUniforms?.night?.value);
    return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
  }

  // 屋顶发光字随 sceneUniforms.night 提亮；入口牌只轻微提高亮度，避免把印刷牌画成霓虹灯。
  function applyMaterialNight(entry) {
    const night = currentNight();
    const roof = entry.kind === 'roof';
    const gain = roof ? 1 + night * 0.85 : 1 + night * 0.12;
    entry.material.color.setRGB(gain, gain * (roof ? 0.985 : 1), gain * (roof ? 0.94 : 1));
  }

  function applyNight() {
    const night = currentNight();
    if (Math.abs(night - lastNight) < 0.02) return;
    lastNight = night;
    for (const entry of materialCache.values()) applyMaterialNight(entry);
  }

  function refreshStatistics() {
    let signs = 0;
    let activeChunks = 0;
    let compounds = 0;
    for (const state of chunks.values()) {
      const count = state.entrance.length + state.roof.length + state.compound.length;
      signs += count;
      compounds += state.compound.length;
      if (count) activeChunks++;
    }
    statistics.signs = signs;
    statistics.compounds = compounds;
    statistics.textures = textureCache.size;
    statistics.chunks = activeChunks;
  }

  function update(position) {
    const started = nowMs();
    if (disposed) return;
    const x = Number(position?.x ?? position?.[0]);
    const z = Number(position?.z ?? position?.[2] ?? (Array.isArray(position) ? position[1] : undefined));
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      statistics.updateMs = nowMs() - started;
      return;
    }
    applyNight();
    const operations = [];
    for (const state of chunks.values()) {
      const center = chunkCenter(state.key);
      const distance = Math.hypot(center.x - x, center.z - z);
      if (state.entrance.length && distance > ENTRANCE_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'entrance', state, distance });
      }
      if (state.compound.length && distance > ENTRANCE_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'compound', state, distance });
      }
      if (state.roof.length && distance > ROOF_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'roof', state, distance });
      }
      // 远到连屋顶牌都卸载了，就把空块状态也删掉，避免跨城长跑后块表无限增长。
      if (!state.entrance.length && !state.compound.length && !state.roof.length && distance > ROOF_UNLOAD_RADIUS) {
        group.remove(state.group);
        chunks.delete(state.key);
      }
    }
    const minCx = Math.floor((x - ROOF_RADIUS) / SIGN_CHUNK_SIZE);
    const maxCx = Math.ceil((x + ROOF_RADIUS) / SIGN_CHUNK_SIZE);
    const minCz = Math.floor((z - ROOF_RADIUS) / SIGN_CHUNK_SIZE);
    const maxCz = Math.ceil((z + ROOF_RADIUS) / SIGN_CHUNK_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = `${cx},${cz}`;
        const center = { x: cx * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2, z: cz * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2 };
        const distance = Math.hypot(center.x - x, center.z - z);
        if (distance > ROOF_RADIUS || !chunkBuildings.has(key)) continue;
        const state = chunks.get(key);
        const wantEntrance = distance <= ENTRANCE_RADIUS && !(state && state.entranceDone);
        const wantCompound = distance <= ENTRANCE_RADIUS && !(state && state.compoundDone);
        const wantRoof = !(state && state.roofDone);
        if (wantEntrance || wantCompound || wantRoof) {
          operations.push({ type: 'load', key, distance, entrance: wantEntrance || wantCompound, roof: wantRoof });
        }
      }
    }
    operations.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'unload' ? -1 : 1;
      return a.type === 'unload' ? b.distance - a.distance : a.distance - b.distance;
    });
    let processed = 0;
    const budget = { remaining: maxSignsPerUpdate };
    for (const operation of operations) {
      if (processed >= maxChunkOps) break;
      processed++;
      if (operation.type === 'unload') {
        disposeSigns(operation.state, operation.kind);
        pruneChunk(operation.state);
      } else {
        generateChunk(operation.key, operation.entrance, operation.roof, budget);
      }
    }
    refreshStatistics();
    statistics.updateMs = nowMs() - started;
  }

  // HUD 用：150m 内最近一个有名字建筑，名称已按出牌规则规范化；没有则 null。
  function nearestName(x, z, radius = NEAREST_NAME_RADIUS) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const seen = new Set();
    let best = null;
    for (let cx = Math.floor((x - radius) / ROAD_CELL); cx <= Math.floor((x + radius) / ROAD_CELL); cx++) {
      for (let cz = Math.floor((z - radius) / ROAD_CELL); cz <= Math.floor((z + radius) / ROAD_CELL); cz++) {
        for (const item of nameCells.get(`${cx},${cz}`) || []) {
          if (seen.has(item)) continue;
          seen.add(item);
          const dx = Math.max(item.minX - x, 0, x - item.maxX);
          const dz = Math.max(item.minZ - z, 0, z - item.maxZ);
          const distance = Math.hypot(dx, dz);
          if (distance > radius) continue;
          if (!best || distance < best.distance
            || (distance === best.distance && item.building.id < best.building.id)) {
            best = { building: item.building, display: item.display, distance };
          }
        }
      }
    }
    return best ? best.display : null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const state of chunks.values()) {
      disposeSigns(state, 'entrance');
      disposeSigns(state, 'compound');
      disposeSigns(state, 'roof');
      group.remove(state.group);
    }
    chunks.clear();
    for (const entry of materialCache.values()) entry.material.dispose();
    materialCache.clear();
    for (const entry of geometryCache.values()) entry.geometry.dispose();
    geometryCache.clear();
    for (const entry of textureCache.values()) entry.texture.dispose();
    textureCache.clear();
    if (scene && typeof scene.remove === 'function') scene.remove(group);
    refreshStatistics();
  }

  applyNight();
  return { group, update, dispose, statistics, nearestName };
}
