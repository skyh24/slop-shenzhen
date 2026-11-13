import * as THREE from 'three/webgpu';
import { attribute, float, materialColor, mix, vec3 } from 'three/tsl';
import { sceneUniforms } from './sz-materials.js';
import { facadeProfile } from './sz-facade-profiles.js';
import { signedRingArea } from './sz-polygon.js';

// 普通建筑名称标牌：按玩家位置分块流式生成，近处贴墙入口牌，高楼屋顶立式双面牌。
// 标牌只读取 building.name；数据缺少 name 或名字只是“1栋/A座”时跳过，不补造名称。
export const SIGN_CHUNK_SIZE = 200;
export const ENTRANCE_RADIUS = 300;
export const ROOF_RADIUS = 900;
export const ENTRANCE_UNLOAD_RADIUS = ENTRANCE_RADIUS * 1.3;
export const ROOF_UNLOAD_RADIUS = ROOF_RADIUS * 1.3;
export const NEAREST_NAME_RADIUS = 150;
export const ROOF_SIGN_MIN_HEIGHT = 60;
// 每个 200 m 块把该块所有名牌画进一张图集，块内只用一个网格、一个材质（改前每块牌一个网格一个材质）。
export const SIGN_ATLAS_MAX_WIDTH = 2048;
export const SIGN_ATLAS_MAX_HEIGHT = 4096;
// 图集里每块牌的分辨率和改前单张 canvas 一致，文字像素密度不变；放不下时整体减半。
const SIGN_TILE_PIXEL_WIDTH = { entrance: 640, compound: 640, roof: 1024 };
const SIGN_TILE_PADDING = 4;
// 夜间增益和改前每材质 color.setRGB 的系数一致：屋顶发光字明显提亮，入口印刷牌只轻微提亮。
export const SIGN_NIGHT = Object.freeze({ printedGain: 0.12, roofGain: 0.85, roofTint: [1, 0.985, 0.94] });
// 小区门牌：把只有单元号（1栋/A座）的住宅楼按邻近具名住宅聚成小区，只在小区临路边立一块门牌。
export const COMPOUND_RADIUS = 90;
export const COMPOUND_CELL = 100;
export const COMPOUND_MIN_MEMBERS = 2;

const ROAD_QUERY_RADIUS = 400;
const ROAD_CELL = 200;
const MAX_NAME_CHARS = 14;
const SIGN_FONT = "'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC',sans-serif";

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

function charCount(text) {
  return Array.from(text).length;
}

function isResidential(building) {
  if (!building) return false;
  if (building.category === 'residential') return true;
  return facadeProfile(building.facade).residential === true;
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
  return facadeProfile(building.facade).floorHeight;
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

function signPanelBackground(info) {
  if (info.kind === 'roof') return '#101722';
  return info.variant === 'residential' ? '#7c1f22' : '#14181d';
}

function drawSignPanel(ctx, width, height, info) {
  const residential = info.variant === 'residential';
  const roof = info.kind === 'roof';
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = signPanelBackground(info);
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

function tileHeightOf(info, scale) {
  const baseWidth = SIGN_TILE_PIXEL_WIDTH[info.kind] ?? 640;
  const width = Math.max(96, Math.round(baseWidth * scale));
  const aspect = Number.isFinite(info.aspect) && info.aspect > 0 ? info.aspect : 4;
  return Math.max(48, Math.round(width / aspect));
}

const KIND_ORDER = { roof: 0, entrance: 1, compound: 2 };

// 纯布局：把一块内所有名牌按货架算法排进一张图集。输入输出都确定，便于单测和前后对比。
// 每块牌的分辨率和改前单张 canvas 相同；超过最大高度时整体减半重排，宁可降一档也不开超大贴图。
export function planSignAtlas(specs, options = {}) {
  const maxWidth = Number.isFinite(options.maxWidth) ? options.maxWidth : SIGN_ATLAS_MAX_WIDTH;
  const maxHeight = Number.isFinite(options.maxHeight) ? options.maxHeight : SIGN_ATLAS_MAX_HEIGHT;
  if (!Array.isArray(specs) || specs.length === 0) return { width: 0, height: 0, scale: 1, tiles: [] };
  let scale = 1;
  for (;;) {
    const ordered = specs.map((spec, index) => ({ spec, index })).sort((a, b) => {
      const kindA = KIND_ORDER[a.spec.kind] ?? 9;
      const kindB = KIND_ORDER[b.spec.kind] ?? 9;
      if (kindA !== kindB) return kindA - kindB;
      const heightA = tileHeightOf(a.spec, scale);
      const heightB = tileHeightOf(b.spec, scale);
      if (heightA !== heightB) return heightB - heightA;
      const nameOrder = String(a.spec.name).localeCompare(String(b.spec.name), 'zh');
      return nameOrder !== 0 ? nameOrder : a.index - b.index;
    });
    const tiles = [];
    let cursorX = 0;
    let cursorY = 0;
    let shelfHeight = 0;
    let usedWidth = 0;
    for (const { spec } of ordered) {
      const width = Math.max(96, Math.round((SIGN_TILE_PIXEL_WIDTH[spec.kind] ?? 640) * scale));
      const height = tileHeightOf(spec, scale);
      const padding = Math.max(2, Math.round(SIGN_TILE_PADDING * scale));
      const slotWidth = width + padding * 2;
      const slotHeight = height + padding * 2;
      if (cursorX > 0 && cursorX + slotWidth > maxWidth) {
        cursorY += shelfHeight;
        cursorX = 0;
        shelfHeight = 0;
      }
      tiles.push({ spec, x: cursorX, y: cursorY, width, height, padding, slotWidth, slotHeight });
      cursorX += slotWidth;
      usedWidth = Math.max(usedWidth, cursorX);
      shelfHeight = Math.max(shelfHeight, slotHeight);
    }
    const height = cursorY + shelfHeight;
    if (height <= maxHeight || scale <= 0.25) {
      return { width: Math.max(256, usedWidth), height: Math.max(1, height), scale, tiles };
    }
    scale /= 2;
  }
}

// 浏览器默认实现：一张图集画一块内所有牌。测试通过 options.createAtlasTexture 注入替身。
export function createSignAtlasTexture(layout) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  if (!layout || !layout.tiles.length || !(layout.width > 0) || !(layout.height > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(layout.width);
  canvas.height = Math.ceil(layout.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const tile of layout.tiles) {
    ctx.save();
    // 内边距也填该牌底色：生成 mipmap 时相邻牌不会串色。
    ctx.fillStyle = signPanelBackground(tile.spec);
    ctx.fillRect(tile.x, tile.y, tile.slotWidth, tile.slotHeight);
    ctx.translate(tile.x + tile.padding, tile.y + tile.padding);
    drawSignPanel(ctx, tile.width, tile.height, tile.spec);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// 一块内所有名牌合成一个几何：入口牌单面，屋顶/小区牌双面。位置直接烘进顶点，网格留在原点。
export function buildSignAtlasGeometry(layout) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const glows = [];
  const indices = [];
  const pushQuad = (corners, normal, quadUvs, glow) => {
    const base = positions.length / 3;
    corners.forEach((corner, index) => {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(quadUvs[index][0], quadUvs[index][1]);
      glows.push(glow);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const width = layout.width > 0 ? layout.width : 1;
  const height = layout.height > 0 ? layout.height : 1;
  for (const tile of layout.tiles) {
    const spec = tile.spec;
    const u0 = (tile.x + tile.padding) / width;
    const u1 = (tile.x + tile.padding + tile.width) / width;
    const v1 = 1 - (tile.y + tile.padding) / height;
    const v0 = 1 - (tile.y + tile.padding + tile.height) / height;
    const glow = spec.kind === 'roof' ? 1 : 0;
    const cos = Math.cos(spec.rotationY);
    const sin = Math.sin(spec.rotationY);
    const world = (lx, ly, lz) => [spec.x + lx * cos + lz * sin, spec.y + ly, spec.z - lx * sin + lz * cos];
    const halfWidth = spec.width / 2;
    const halfHeight = spec.height / 2;
    if (spec.kind === 'entrance') {
      pushQuad([
        world(-halfWidth, -halfHeight, 0), world(halfWidth, -halfHeight, 0),
        world(halfWidth, halfHeight, 0), world(-halfWidth, halfHeight, 0)
      ], [sin, 0, cos], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], glow);
    } else {
      // 正面
      pushQuad([
        world(-halfWidth, -halfHeight, 0.03), world(halfWidth, -halfHeight, 0.03),
        world(halfWidth, halfHeight, 0.03), world(-halfWidth, halfHeight, 0.03)
      ], [sin, 0, cos], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], glow);
      // 背面：反向绕序并把 U 镜像，从背后看文字仍然正读。
      pushQuad([
        world(halfWidth, -halfHeight, -0.03), world(-halfWidth, -halfHeight, -0.03),
        world(-halfWidth, halfHeight, -0.03), world(halfWidth, halfHeight, -0.03)
      ], [-sin, 0, -cos], [[u1, v0], [u0, v0], [u0, v1], [u1, v1]], glow);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('signGlow', new THREE.Float32BufferAttribute(glows, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// 一块图集只有一个材质：夜间亮度按顶点 signGlow 区分屋顶发光字和入口印刷牌，行为和改前逐材质更新一致。
export function createSignAtlasMaterial(texture) {
  const material = new THREE.MeshBasicNodeMaterial({ map: texture, toneMapped: false, side: THREE.FrontSide });
  material.name = 'BuildingSignAtlasMaterial';
  const glow = attribute('signGlow', 'float');
  const gain = mix(float(SIGN_NIGHT.printedGain), float(SIGN_NIGHT.roofGain), glow);
  const tint = mix(vec3(1, 1, 1), vec3(...SIGN_NIGHT.roofTint), glow);
  material.colorNode = materialColor.mul(tint).mul(float(1).add(sceneUniforms.night.mul(gain)));
  return material;
}

// buildings 建议传 buildCityBlocks().allBlocks（带 baseY），否则用 options.groundHeight(x, z) 补地面高；
// 缺 baseY 时按 0 处理，山区标牌会埋进地形。roadGraph 可传 GEO.roadGraph。
// update(position) 每帧调用；nearestName(x, z) 返回 150m 内最近有名字建筑的显示名（string|null）。
export function buildBuildingSigns(scene, options = {}) {
  const buildings = Array.isArray(options.buildings) ? options.buildings : [];
  const roadGraph = options.roadGraph ?? null;
  const maxChunkOps = Number.isFinite(options.maxChunkOps) ? Math.max(1, Math.floor(options.maxChunkOps)) : 2;
  // 单块可能挤着几十栋有名字的楼；再限一个每帧建牌数，避免 Canvas 建纹理造成长帧。
  const maxSignsPerUpdate = Number.isFinite(options.maxSignsPerUpdate)
    ? Math.max(1, Math.floor(options.maxSignsPerUpdate)) : 4;
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

  const atlasFactory = options.createAtlasTexture ?? createSignAtlasTexture;
  // 一块内所有名牌画进一张图集：白天一张贴图、一个网格，夜间按顶点属性区分亮度。
  const canCreateTextures = typeof atlasFactory === 'function'
    && (options.createAtlasTexture !== undefined || typeof document !== 'undefined');
  const chunks = new Map();
  // 每帧最多重建几块图集；图集重建要重画 canvas，流式生成期间不能每帧对每块都做。
  const rebuildBudget = Number.isFinite(options.maxAtlasRebuilds)
    ? Math.max(1, Math.floor(options.maxAtlasRebuilds)) : 1;
  let disposed = false;
  const statistics = { signs: 0, textures: 0, meshes: 0, chunks: 0, updateMs: 0, compounds: 0,
    compoundClusters: 0, texturesCreated: 0, texturesDisposed: 0,
    namedBuildings: buildings.filter(b => buildingDisplayName(b)).length };
  buildCompoundClusters();

  function chunkCenter(key) {
    const [cx, cz] = key.split(',').map(Number);
    return { x: cx * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2, z: cz * SIGN_CHUNK_SIZE + SIGN_CHUNK_SIZE / 2 };
  }

  function ensureChunkState(key) {
    let state = chunks.get(key);
    if (!state) {
      const chunkGroup = new THREE.Group();
      chunkGroup.name = `BuildingSigns:${key}`;
      group.add(chunkGroup);
      state = {
        key,
        group: chunkGroup,
        records: { entrance: [], roof: [], compound: [] },
        wanted: { entrance: false, roof: false, compound: false },
        done: { entrance: false, roof: false, compound: false },
        cursor: { entrance: 0, roof: 0, compound: 0 },
        atlas: null,
        dirty: false
      };
      chunks.set(key, state);
    }
    return state;
  }

  function recordCount(state) {
    return state.records.entrance.length + state.records.roof.length + state.records.compound.length;
  }

  function disposeAtlas(state) {
    if (!state.atlas) return;
    state.group.remove(state.atlas.mesh);
    state.atlas.geometry.dispose();
    state.atlas.material.dispose();
    state.atlas.texture?.dispose?.();
    state.atlas = null;
    statistics.texturesDisposed++;
  }

  function rebuildAtlas(state) {
    state.dirty = false;
    const records = [...state.records.roof, ...state.records.entrance, ...state.records.compound];
    if (records.length === 0) {
      disposeAtlas(state);
      return;
    }
    const specs = records.map(record => record.spec);
    const layout = planSignAtlas(specs);
    const texture = atlasFactory(layout, specs);
    if (!texture) return;
    const geometry = buildSignAtlasGeometry(layout);
    const material = createSignAtlasMaterial(texture);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `BuildingSignAtlas:${state.key}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.signs = records.map(record => ({ kind: record.spec.kind,
      buildingId: record.buildingId ?? null, name: record.spec.name }));
    // 先建新图集再释放旧图集，重建期间不出现空帧。
    disposeAtlas(state);
    state.group.add(mesh);
    state.atlas = { mesh, geometry, material, texture, layout };
    statistics.texturesCreated++;
  }

  // 只有该块想生成的牌都生成完（或卸载后）才重建图集，避免流式生成期间每帧重画 canvas。
  function markChunkDirty(state) {
    const ready = (!state.wanted.entrance || state.done.entrance)
      && (!state.wanted.roof || state.done.roof)
      && (!state.wanted.compound || state.done.compound);
    if (ready && (recordCount(state) || state.atlas)) state.dirty = true;
  }

  // 每帧只建预算内的牌子；没建完的块保留游标，下一次 update 接着做，避免一帧内建几十张 Canvas。
  function generateKind(state, kind, list, budget) {
    if (state.done[kind]) return;
    state.wanted[kind] = true;
    let cursor = state.cursor[kind];
    for (; cursor < list.length; cursor++) {
      if (budget.remaining <= 0) break;
      const building = list[cursor];
      const tall = Number.isFinite(building.height) && building.height >= ROOF_SIGN_MIN_HEIGHT;
      if (tall !== (kind === 'roof')) continue;
      const spec = planBuildingSigns(building, { ...options, roadIndex: getRoadIndex() });
      if (!spec) continue;
      if (!canCreateTextures) continue;
      budget.remaining--;
      state.records[kind].push({ spec, buildingId: building.id });
    }
    state.cursor[kind] = cursor;
    if (cursor >= list.length) state.done[kind] = true;
  }

  // 小区门牌：和入口牌同半径生成，每块每帧受同一预算限制。
  function generateCompounds(state, budget) {
    state.wanted.compound = true;
    if (state.done.compound) return;
    const list = compoundByChunk.get(state.key) || [];
    let cursor = state.cursor.compound;
    for (; cursor < list.length; cursor++) {
      if (budget.remaining <= 0 || !canCreateTextures) break;
      const spec = planCompoundSign(list[cursor], { ...options, roadIndex: getRoadIndex() });
      if (!spec) continue;
      budget.remaining--;
      state.records.compound.push({ spec, buildingId: null });
    }
    state.cursor.compound = cursor;
    if (cursor >= list.length) state.done.compound = true;
  }

  function generateChunk(key, wantEntrance, wantRoof, budget) {
    const state = ensureChunkState(key);
    const list = chunkBuildings.get(key) || [];
    if (wantEntrance) generateKind(state, 'entrance', list, budget);
    if (wantRoof) generateKind(state, 'roof', list, budget);
    if (wantEntrance) generateCompounds(state, budget);
    markChunkDirty(state);
  }

  function unloadKind(state, kind) {
    if (state.records[kind].length === 0 && !state.done[kind] && !state.wanted[kind]) return false;
    state.records[kind] = [];
    state.done[kind] = false;
    state.cursor[kind] = 0;
    state.wanted[kind] = false;
    return true;
  }

  function pruneChunk(state) {
    if (recordCount(state) || state.atlas) return;
    group.remove(state.group);
    chunks.delete(state.key);
  }

  function refreshStatistics() {
    let signs = 0;
    let compounds = 0;
    let activeChunks = 0;
    let meshes = 0;
    for (const state of chunks.values()) {
      const count = recordCount(state);
      signs += count;
      compounds += state.records.compound.length;
      if (count) activeChunks++;
      if (state.atlas) meshes++;
    }
    statistics.signs = signs;
    statistics.meshes = meshes;
    statistics.textures = meshes;
    statistics.compounds = compounds;
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
    const operations = [];
    for (const state of chunks.values()) {
      const center = chunkCenter(state.key);
      const distance = Math.hypot(center.x - x, center.z - z);
      if (state.records.entrance.length && distance > ENTRANCE_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'entrance', state, distance });
      }
      if (state.records.compound.length && distance > ENTRANCE_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'compound', state, distance });
      }
      if (state.records.roof.length && distance > ROOF_UNLOAD_RADIUS) {
        operations.push({ type: 'unload', kind: 'roof', state, distance });
      }
      // 远到连屋顶牌都卸载了，就把空块状态也删掉，避免跨城长跑后块表无限增长。
      if (recordCount(state) === 0 && !state.atlas && distance > ROOF_UNLOAD_RADIUS) {
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
        const wantEntrance = distance <= ENTRANCE_RADIUS && !(state && state.done.entrance);
        const wantCompound = distance <= ENTRANCE_RADIUS && !(state && state.done.compound);
        const wantRoof = !(state && state.done.roof);
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
        if (unloadKind(operation.state, operation.kind)) operation.state.dirty = true;
        pruneChunk(operation.state);
      } else {
        generateChunk(operation.key, operation.entrance, operation.roof, budget);
      }
    }
    // 图集重建单独限预算：先重建牌子多的块，牌子少的排后面。
    let rebuilt = 0;
    for (const state of chunks.values()) {
      if (rebuilt >= rebuildBudget) break;
      if (!state.dirty) continue;
      rebuildAtlas(state);
      rebuilt++;
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
      disposeAtlas(state);
      state.group.removeFromParent();
      group.remove(state.group);
    }
    chunks.clear();
    if (scene && typeof scene.remove === 'function') scene.remove(group);
    refreshStatistics();
  }

  return { group, update, dispose, statistics, nearestName };
}
