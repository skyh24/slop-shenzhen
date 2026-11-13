import * as THREE from 'three/webgpu';
import { polygonContains } from './sz-polygon.js';
import { CROWN_SPECIES, createCrownLibrary } from './sz-tree-crown.js';

// 近景按树种实例化整棵树，远景的低模树干和树冠按同一子格切换。

const CHUNK_SIZE_M = 1000;
// 近/远切换以 250 m 子格为单位：只按 1 km 块切换时，市中心一块的 3000 多棵树
// 会被整块强制高模，实测约 5.5M 三角形；250 m 子格把近景树林压到 0.5M 以内。
const LOD_CELL_M = 250;
const MAX_TREES = 60000;
const NEAR_ENTER_M = 180;
const NEAR_EXIT_M = 198;
const FAR_EXIT_M = 900;
const FAR_ENTER_M = 828;
const PROBE_RADIUS_M = 0.9;
const TRUNK_SIDES = 8;
const TRUNK_TRIANGLES = TRUNK_SIDES * 2; // 无盖圆柱
const FAR_CROWN_TRIANGLES = 80; // IcosahedronGeometry detail=1
const COLLIDER_CELL_M = 48;
const WOODLAND_CLEAR_M = 6;
const WOODLAND_SOURCE = 'simulated-woodland';
const OSM_SOURCE_NAMES = new Set(['osm-node', 'osm-row']);
const TREE_CLEARANCE_CORRIDOR = 'shennan-chegongmiao';
const D1_ENTRANCE_NODE = 1491790883;
const ENTRANCE_CLEAR_RADIUS_M = 1.5; // 模拟树退让值，仅保护源出口点。
const WALK_CLEAR_HEIGHT_M = 2.5; // 本样区的人行设计净高。
// 叶卡树冠覆盖的树种；载荷里出现未知树种名时退回 ficus 形态，颜色仍按该树种的调色板。
const CROWN_TEMPLATE_NAMES = new Set(Object.keys(CROWN_SPECIES));

// 树种只定义形态比例和颜色；树高、冠幅来自数据，避免运行时再造随机尺寸。
const SPECIES_STYLE = {
  ficus: { crownColor: 0x3c562f, crownLight: 0x66804d, trunkColor: 0x5f4e3f,
    farSpread: 0.17, farHeight: 0.30 },
  camphor: { crownColor: 0x405c33, crownLight: 0x687d45, trunkColor: 0x5b4b3d,
    farSpread: 0.16, farHeight: 0.32 },
  phoenix: { crownColor: 0x4b6a32, crownLight: 0x7a9448, trunkColor: 0x655642,
    farSpread: 0.24, farHeight: 0.20 },
  bauhinia: { crownColor: 0x54703f, crownLight: 0x7d925c, trunkColor: 0x635343,
    farSpread: 0.18, farHeight: 0.32 },
  'royal-palm': { crownColor: 0x36542c, crownLight: 0x5b7738, trunkColor: 0x746a58,
    farSpread: 0.08, farHeight: 0.40 },
  kapok: { crownColor: 0x4a5f38, crownLight: 0x6f8049, trunkColor: 0x6a5847,
    farSpread: 0.20, farHeight: 0.26 }
};
const DEFAULT_SPECIES_STYLE = SPECIES_STYLE.ficus;

function requireTree(condition, field) {
  if (!condition) throw new Error(`Invalid Shenzhen tree data: ${field}`);
}

// 和 tools/sz/trees.py 的 _seed 相同的 FNV-1a；标识是 ASCII，前端逐字符哈希与后端逐字节一致。
function treeSeed(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return hash / 4294967296;
}

function compareChunkKeys(a, b) {
  const [ax, az] = a.split(',').map(Number);
  const [bx, bz] = b.split(',').map(Number);
  return ax - bx || az - bz;
}

function pointSegmentDistanceSq(x, z, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
  const px = a.x + dx * t - x;
  const pz = a.z + dz * t - z;
  return px * px + pz * pz;
}

function createTreeFrontageClearance(frontage) {
  const corridor = frontage?.corridors.find(row => row.id === TREE_CLEARANCE_CORRIDOR);
  if (!corridor) return null;
  const [minX, minZ, maxX, maxZ] = corridor.bounds;
  const paving = frontage.features.filter(feature =>
    feature.id.startsWith(`${corridor.id}:`) && ['sidewalk', 'paving'].includes(feature.kind));
  const triangles = [];
  for (const { trianglesXZ } of paving) {
    for (let i = 0; i < trianglesXZ.length; i += 6) {
      const [ax, az, bx, bz, cx, cz] = trianglesXZ.slice(i, i + 6);
      triangles.push({ minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
        minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz), minY: 0, maxY: 1,
        polygon: { outer: [{ x: ax, z: az }, { x: bx, z: bz }, { x: cx, z: cz }], holes: [] } });
    }
  }
  const hitsPaving = createColliderIndex(triangles);
  // 过街标线是离散条纹，净空使用同来源的连续轴线。
  const crossings = (corridor.crossingAxes ?? []).flatMap(({ widthM, points }) => {
    const axis = points.map(([x, z]) => ({ x, z }));
    return axis.slice(1).map((b, i) => ({ a: axis[i], b, halfWidth: widthM / 2 }));
  });
  const entrance = frontage.entrances.find(row => row.osmNodeId === D1_ENTRANCE_NODE);
  const inScope = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  const hits = (x, z, radius) => {
    if (entrance && Math.hypot(x - entrance.x, z - entrance.z) <= ENTRANCE_CLEAR_RADIUS_M + radius) return true;
    if (hitsPaving(x, z, radius, 0, 1)) return true;
    return crossings.some(({ a, b, halfWidth }) => pointSegmentDistanceSq(x, z, a, b) <= (halfWidth + radius) ** 2);
  };
  return { inScope, hits };
}

function treeSwayAmplitude(height) {
  return Math.min(0.4, Math.max(0.08, height * 0.018));
}

function crownBlocksFrontage(record, geometry, frontage, heightAt) {
  const { x, z, y, height, crown, trunkHeight, trunkRadius, style } = record;
  const sway = treeSwayAmplitude(height);
  if (!frontage.hits(x, z, crown + sway)) return false;
  // 以冠幅内采样的最高通行标高判断净高，避免把坡上路面按树根标高处理。
  let walkY = y;
  const sampleRadius = crown * 0.6;
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const sample = heightAt(x + dx * sampleRadius, z + dz * sampleRadius);
    if (Number.isFinite(sample)) walkY = Math.max(walkY, sample);
  }
  const heightLimit = walkY + WALK_CLEAR_HEIGHT_M - y;
  const halfHeight = farCrownHalfHeight(record);
  const farBottom = trunkHeight - Math.min(0.25, halfHeight * 0.25);
  if (farBottom < heightLimit) {
    const normalizedY = Math.max(0, 1 - (heightLimit - farBottom) / halfHeight);
    const farRadius = crown * (0.36 + style.farSpread * 0.6) * Math.sqrt(1 - normalizedY * normalizedY);
    if (frontage.hits(x, z, farRadius)) return true;
  }

  // 用实际近景共享网格截取净高以下的外伸部分，旋转后仍适用的径向包络不含主干。
  const positions = geometry.attributes.position;
  const indices = geometry.index.array;
  const limit = (heightLimit + 0.06) / height; // 留出近景风动的少量竖向余量。
  let radius = 0;
  for (let i = 0; i < indices.length; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge];
      const b = indices[i + ((edge + 1) % 3)];
      const ay = positions.getY(a);
      const by = positions.getY(b);
      if (ay > limit && by > limit) continue;
      const ax = positions.getX(a), az = positions.getZ(a);
      if (ay <= limit) radius = Math.max(radius, Math.hypot(ax, az));
      if ((ay <= limit) === (by <= limit)) continue;
      const t = (limit - ay) / (by - ay);
      radius = Math.max(radius, Math.hypot(ax + (positions.getX(b) - ax) * t,
        az + (positions.getZ(b) - az) * t));
    }
  }
  return radius * crown > trunkRadius + 1e-5 && frontage.hits(x, z, radius * crown + sway);
}

function farCrownHalfHeight({ height, trunkHeight, style }) {
  return (height - trunkHeight) * (0.35 + style.farHeight * 0.3);
}

// 静态碰撞体一次性索引到 48 m 网格，避免每棵树都扫全城建筑。
function createColliderIndex(colliders) {
  const cells = new Map();
  const cellKey = (ix, iz) => `${ix},${iz}`;
  for (const collider of colliders) {
    if (![collider.minX, collider.maxX, collider.minZ, collider.maxZ].every(Number.isFinite)) continue;
    for (let ix = Math.floor(collider.minX / COLLIDER_CELL_M); ix <= Math.floor(collider.maxX / COLLIDER_CELL_M); ix++) {
      for (let iz = Math.floor(collider.minZ / COLLIDER_CELL_M); iz <= Math.floor(collider.maxZ / COLLIDER_CELL_M); iz++) {
        const key = cellKey(ix, iz);
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(collider);
      }
    }
  }
  let stamp = 0;
  return (x, z, radius, minY, maxY) => {
    const queryStamp = ++stamp;
    const fromX = Math.floor((x - radius) / COLLIDER_CELL_M);
    const toX = Math.floor((x + radius) / COLLIDER_CELL_M);
    const fromZ = Math.floor((z - radius) / COLLIDER_CELL_M);
    const toZ = Math.floor((z + radius) / COLLIDER_CELL_M);
    for (let ix = fromX; ix <= toX; ix++) {
      for (let iz = fromZ; iz <= toZ; iz++) {
        const list = cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const collider of list) {
          if (collider._treeSeen === queryStamp) continue;
          collider._treeSeen = queryStamp;
          if (collider.maxY <= minY || collider.minY >= maxY) continue;
          if (collider.maxX < x - radius || collider.minX > x + radius
            || collider.maxZ < z - radius || collider.minZ > z + radius) continue;
          const polygon = collider.polygon;
          if (!polygon) return true;
          if (polygonContains(polygon, x, z)) return true;
          for (let ringIndex = -1; ringIndex < polygon.holes.length; ringIndex++) {
            const ring = ringIndex < 0 ? polygon.outer : polygon.holes[ringIndex];
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              if (pointSegmentDistanceSq(x, z, ring[i], ring[j]) <= radius * radius) return true;
            }
          }
        }
      }
    }
    return false;
  };
}

function speciesStyle(name) {
  return SPECIES_STYLE[name] ?? DEFAULT_SPECIES_STYLE;
}

function colliderPolygon(x, z, radius) {
  const outer = [];
  for (let i = 0; i < TRUNK_SIDES; i++) {
    const angle = (i / TRUNK_SIDES) * Math.PI * 2;
    outer.push({ x: x + Math.sin(angle) * radius, z: z + Math.cos(angle) * radius });
  }
  return { outer, holes: [] };
}

export function decodeTreePayload(raw) {
  if (raw === undefined || raw === null) return null;
  requireTree(typeof raw === 'object' && !Array.isArray(raw), 'object');
  requireTree(raw.version === 1, 'version');
  const count = raw.count;
  requireTree(Number.isSafeInteger(count) && count >= 0 && count <= MAX_TREES, 'count');
  const numericFields = ['x', 'z', 'height', 'crown', 'species', 'source', 'appearance'];
  for (const field of numericFields) {
    const values = raw[field];
    requireTree(Array.isArray(values) && values.length === count, `${field} length`);
    requireTree(values.every(value => Number.isSafeInteger(value)), `${field} values`);
  }
  const speciesNames = raw.speciesNames;
  const sources = raw.sources;
  const appearanceSources = raw.appearanceSources;
  requireTree(Array.isArray(speciesNames) && speciesNames.length > 0 && speciesNames.length <= 64
    && speciesNames.every(name => typeof name === 'string' && name.length > 0), 'speciesNames');
  requireTree(Array.isArray(sources) && sources.length > 0 && sources.length <= 64
    && sources.every(name => typeof name === 'string' && name.length > 0), 'sources');
  requireTree(Array.isArray(appearanceSources) && appearanceSources.length > 0 && appearanceSources.length <= 64
    && appearanceSources.every(name => typeof name === 'string' && name.length > 0)
    && appearanceSources.includes('osm-tags') && appearanceSources.includes('species-estimate'),
  'appearanceSources');
  requireTree(Array.isArray(raw.osm), 'osm');
  const osmSourceIndices = new Set(sources
    .map((name, index) => (OSM_SOURCE_NAMES.has(name) ? index : -1))
    .filter(index => index >= 0));
  const seen = new Set();
  const nodeIds = new Set();
  for (const entry of raw.osm) {
    requireTree(Array.isArray(entry) && entry.length === 2, 'osm entry');
    const [index, id] = entry;
    requireTree(Number.isInteger(index) && index >= 0 && index < count, 'osm index');
    requireTree(typeof id === 'string' && /^(?:node|way)\/\d+$/.test(id), 'osm id');
    requireTree(!seen.has(index), 'osm duplicate');
    if (id.startsWith('node/')) {
      requireTree(!nodeIds.has(id), `duplicate OSM tree node ${id}`);
      nodeIds.add(id);
    }
    const sourceIndex = raw.source[index];
    requireTree(Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length,
      'source index');
    if (osmSourceIndices.size > 0) requireTree(osmSourceIndices.has(sourceIndex), 'osm source');
    seen.add(index);
  }
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  const height = new Float64Array(count);
  const crown = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    requireTree(Math.abs(raw.x[i]) <= 1e7 && Math.abs(raw.z[i]) <= 1e7, 'position range');
    requireTree(raw.height[i] > 0 && raw.height[i] <= 4000, 'height range');
    requireTree(raw.crown[i] > 0 && raw.crown[i] <= 4000, 'crown range');
    requireTree(raw.species[i] >= 0 && raw.species[i] < speciesNames.length, 'species index');
    requireTree(raw.source[i] >= 0 && raw.source[i] < sources.length, 'source index');
    requireTree(raw.appearance[i] >= 0 && raw.appearance[i] < appearanceSources.length, 'appearance index');
    x[i] = raw.x[i] / 10;
    z[i] = raw.z[i] / 10;
    height[i] = raw.height[i] / 10;
    crown[i] = raw.crown[i] / 10;
  }
  return {
    version: 1,
    count,
    x,
    z,
    height,
    crown,
    species: Uint8Array.from(raw.species),
    source: Uint8Array.from(raw.source),
    appearance: Uint8Array.from(raw.appearance),
    speciesNames: [...speciesNames],
    sources: [...sources],
    appearanceSources: [...appearanceSources],
    osm: new Map(raw.osm.map(([index, id]) => [index, id])),
    stats: raw.stats ?? null,
    limitations: Array.isArray(raw.limitations) ? [...raw.limitations] : []
  };
}

export function planTreeChunks(trees, size = CHUNK_SIZE_M) {
  requireTree(Number.isFinite(size) && size > 0, 'chunk size');
  const chunks = new Map();
  if (!trees || !trees.count) return chunks;
  const grouped = new Map();
  for (let index = 0; index < trees.count; index++) {
    const x = trees.x[index];
    const z = trees.z[index];
    const key = `${Math.floor(x / size)},${Math.floor(z / size)}`;
    let records = grouped.get(key);
    if (!records) grouped.set(key, (records = []));
    records.push({ index, x, z, height: trees.height[index], crown: trees.crown[index],
      species: trees.species[index], source: trees.source[index], appearance: trees.appearance[index] });
  }
  for (const key of [...grouped.keys()].sort(compareChunkKeys)) chunks.set(key, grouped.get(key));
  return chunks;
}

// 纯 LOD 判定：<180 m 近冠、180..900 m 远冠、>900 m 隐藏；运行时切换另有少量迟滞防抖。
export function treeLod(distance, nearDistance = NEAR_ENTER_M, farDistance = FAR_EXIT_M) {
  if (!Number.isFinite(distance)) return 'hidden';
  if (distance < nearDistance) return 'near';
  if (distance > farDistance) return 'hidden';
  return 'far';
}

function emptyResult() {
  const group = new THREE.Group();
  group.name = 'shenzhen-trees';
  return {
    group,
    colliders: [],
    statistics: {
      version: 1, payloadCount: 0, placed: 0, chunks: 0, lodCells: 0, countsBySource: {},
      skipped: { unsupportedGround: 0, roadConflict: 0, pathConflict: 0, buildingConflict: 0,
        openMedian: 0, roadside: 0, frontageTrunkConflict: 0, frontageCrownConflict: 0, reservedWalk: 0 },
      instances: { trunks: 0, cards: 0, farCrowns: 0 },
      triangles: { trunkPerTree: TRUNK_TRIANGLES, cardPerTree: {}, farPerTree: FAR_CROWN_TRIANGLES },
      visible: { chunks: 0, lodCells: 0, nearCells: 0, farCells: 0, hiddenCells: 0, trees: 0,
        nearTrees: 0, farTrees: 0, cardTrees: 0, triangles: 0 }
    },
    update() {},
    dispose() { group.removeFromParent(); }
  };
}

export function buildSzTrees(scene, payload, options = {}) {
  const { groundHeight, heightAt = groundHeight, roadHeight, shennanMedianHeight = () => null,
    streetTreeSideAllowed = () => true, pathAt = () => [], simulatedPathAt, reserveWalk = () => false, colliders = [], roadFrontage } = options;
  const trees = decodeTreePayload(payload);
  const payloadCount = trees?.count ?? 0;
  const pilotTrees = options.pilotTrees ?? [];
  const observedById = new Map();
  for (const tree of options.observedTrees ?? []) {
    const { id, x, z, positionSource, appearanceSource } = tree;
    requireTree(/^node\/\d+$/.test(id) && Number.isFinite(x) && Number.isFinite(z)
      && positionSource === 'osm-node' && appearanceSource === 'visual-estimate', `observed tree ${id}`);
    requireTree(!observedById.has(id), `duplicate observed tree ${id}`);
    observedById.set(id, tree);
  }
  const payloadOsmIds = new Set(trees?.osm.values());
  // 旧包可能只有场地里的源树点。没有全局树尺寸时用原场地尺度的估计值。
  const additionalTrees = [...pilotTrees];
  for (const tree of observedById.values()) {
    if (payloadOsmIds.has(tree.id)) continue;
    const scale = 0.84 + treeSeed(tree.id) * 0.36;
    additionalTrees.push({ ...tree, speciesName: 'ficus', height: 5.9 * scale, crown: 4.9 * scale });
  }
  const woodlandTrees = options.woodlandTrees ?? [];
  const woodlandStart = payloadCount + additionalTrees.length;
  const count = woodlandStart + woodlandTrees.length;
  const empty = emptyResult();
  if (!count || typeof groundHeight !== 'function') {
    empty.statistics.payloadCount = payloadCount;
    empty.statistics.skipped.unsupportedGround = count;
    scene.add(empty.group);
    return empty;
  }
  const group = new THREE.Group();
  group.name = 'shenzhen-trees';
  const countsBySource = {};
  const { skipped } = empty.statistics;
  const hitsCollider = createColliderIndex(colliders);
  const frontage = createTreeFrontageClearance(roadFrontage);
  const probes = [[0, 0], [PROBE_RADIUS_M, 0], [-PROBE_RADIUS_M, 0], [0, PROBE_RADIUS_M], [0, -PROBE_RADIUS_M]];
  const candidates = [];
  const treeColliders = [];
  const crownTemplates = new Set();
  for (let index = 0; index < count; index++) {
    const woodland = index >= woodlandStart;
    const extra = woodland ? woodlandTrees[index - woodlandStart] : additionalTrees[index - payloadCount];
    const osmId = trees?.osm.get(index);
    const observed = observedById.get(extra?.id ?? osmId);
    const x = observed?.x ?? extra?.x ?? trees.x[index];
    const z = observed?.z ?? extra?.z ?? trees.z[index];
    const height = extra?.height ?? trees.height[index];
    const crown = extra?.crown ?? trees.crown[index];
    const sourceName = woodland ? WOODLAND_SOURCE
      : extra ? extra.positionSource ?? 'simulated-street' : trees.sources[trees.source[index]] ?? 'unknown';
    const appearanceSource = extra ? extra.appearanceSource ?? 'species-estimate' : trees.appearanceSources[trees.appearance[index]];
    // 树列可从同一 OSM 线生成多个实例，保留各自位置和共同源 ID。
    const legacyId = osmId ?? `tree/${index}`;
    const locationId = `tree:${x},${z}`;
    const id = extra?.id ?? (osmId?.startsWith('node/') ? osmId : `${osmId ?? sourceName}:${locationId}`);
    const sourceId = extra?.id ? id : legacyId;
    const clearance = woodland ? crown * 0.57 + 0.35 : crown / 2;
    if (options.excludedSite?.(x, z, clearance)) {
      skipped.reservedWalk++;
      continue;
    }
    if (woodland && options.isWater && options.isWater(x, z) !== false) {
      skipped.unsupportedGround++;
      continue;
    }
    if (sourceName.startsWith('simulated-') && Number.isFinite(shennanMedianHeight(x, z))) {
      skipped.openMedian++;
      continue;
    }
    if (sourceName === 'simulated-street' && !streetTreeSideAllowed(x, z)) {
      skipped.roadside++;
      continue;
    }
    let baseY = Infinity;
    let reason = null;
    const scale = woodland ? crown * 0.03 / PROBE_RADIUS_M : 1;
    for (const [dx, dz] of probes) {
      const sample = groundHeight(x + dx * scale, z + dz * scale);
      if (sample === null || sample === undefined || !Number.isFinite(sample)) {
        reason = 'unsupportedGround';
        break;
      }
      if (sample < baseY) baseY = sample;
    }
    if (!reason) {
      for (const [dx, dz] of probes) {
        if (roadHeight && roadHeight(x + dx, z + dz) !== null) {
          reason = 'roadConflict';
          break;
        }
        const paths = pathAt(x + dx, z + dz);
        if (paths?.length || (sourceName.startsWith('simulated-') && simulatedPathAt?.(x + dx, z + dz))) {
          reason = 'pathConflict';
          break;
        }
      }
    }
    if (sourceName === 'simulated-street') baseY = heightAt(x, z) ?? baseY;
    if (!reason && hitsCollider(x, z, clearance, baseY, baseY + height)) reason = 'buildingConflict';
    if (reason) {
      skipped[reason] += 1;
      continue;
    }
    const speciesName = extra?.speciesName ?? trees.speciesNames[trees.species[index]] ?? 'ficus';
    const style = speciesStyle(speciesName);
    // 未知树种退回 ficus 叶卡形态，颜色仍用该树种的调色板。
    const crownTemplate = CROWN_TEMPLATE_NAMES.has(speciesName) ? speciesName : 'ficus';
    const habit = CROWN_SPECIES[crownTemplate];
    const trunkHeight = height * habit.trunkRatio;
    const trunkRadius = crown * habit.trunkRadiusRatio;
    if (options.carriagewayOccupied?.(x, z, woodland ? clearance : trunkRadius)) {
      skipped.roadConflict++;
      continue;
    }
    const checkFrontage = sourceName === 'simulated-street' && frontage?.inScope(x, z);
    if (checkFrontage && frontage.hits(x, z, trunkRadius)) {
      skipped.frontageTrunkConflict++;
      continue;
    }
    if (sourceName.startsWith('simulated-') && (reserveWalk(x, z, trunkRadius + 0.3)
      || options.reserveBayWalk?.(x, z, trunkRadius + 0.3))) {
      skipped.reservedWalk++;
      continue;
    }
    if (!woodland) crownTemplates.add(crownTemplate);
    candidates.push({ id, sourceId, x, z, y: baseY, height, crown, speciesName, sourceName, appearanceSource,
      style, trunkHeight, trunkRadius, checkFrontage, seed: treeSeed(sourceId), crownTemplate, woodland });
  }

  // 近景共用的树种几何也用于低枝净高检查。
  const crownLibrary = crownTemplates.size > 0 ? createCrownLibrary([...crownTemplates]) : null;
  const placed = [];
  // 已验收树点优先。只在构建时查询九个相邻格，补植树点与原有树干至少相距 6 米。
  const occupied = new Map();
  for (const { x, z, woodland } of candidates) {
    if (!woodland) continue;
    const ix = Math.floor(x / WOODLAND_CLEAR_M), iz = Math.floor(z / WOODLAND_CLEAR_M);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const key = `${ix + dx},${iz + dz}`;
      if (!occupied.has(key)) occupied.set(key, []);
    }
  }
  for (const record of candidates) {
    const { id, sourceId, x, z, y, trunkHeight, trunkRadius, sourceName, appearanceSource, checkFrontage, crownTemplate,
      woodland } = record;
    if (checkFrontage && crownBlocksFrontage(record, crownLibrary.geometryFor(crownTemplate), frontage, heightAt)) {
      skipped.frontageCrownConflict++;
      continue;
    }
    if (occupied.size) {
      const ix = Math.floor(x / WOODLAND_CLEAR_M), iz = Math.floor(z / WOODLAND_CLEAR_M);
      let overlaps = false;
      if (woodland) {
        for (let dx = -1; dx <= 1 && !overlaps; dx++) for (let dz = -1; dz <= 1 && !overlaps; dz++) {
          overlaps = occupied.get(`${ix + dx},${iz + dz}`)?.some(other =>
            (other.x - x) ** 2 + (other.z - z) ** 2 < WOODLAND_CLEAR_M ** 2);
        }
        if (overlaps) {
          skipped.woodlandOverlap = (skipped.woodlandOverlap ?? 0) + 1;
          continue;
        }
      }
      occupied.get(`${ix},${iz}`)?.push(record);
    }
    countsBySource[sourceName] = (countsBySource[sourceName] ?? 0) + 1;
    placed.push(record);
    const polygon = colliderPolygon(x, z, trunkRadius);
    const maxY = y + trunkHeight;
    treeColliders.push({ type: 'tree', name: id, sourceId, positionSource: sourceName, appearanceSource, polygon,
      loft: { lower: polygon.outer, upper: colliderPolygon(x, z, trunkRadius * 0.65).outer, minY: y, maxY },
      minY: y, maxY, minX: x - trunkRadius, maxX: x + trunkRadius,
      minZ: z - trunkRadius, maxZ: z + trunkRadius });
  }

  // 按 1000 m 分块，树木按 250 m 子格切换细节档。
  const grouped = new Map();
  for (const record of placed) {
    const key = `${Math.floor(record.x / CHUNK_SIZE_M)},${Math.floor(record.z / CHUNK_SIZE_M)}`;
    let list = grouped.get(key);
    if (!list) grouped.set(key, (list = []));
    list.push(record);
  }
  const trunkGeometry = new THREE.CylinderGeometry(0.65, 1, 1, TRUNK_SIDES, 1, true).translate(0, 0.5, 0);
  const farGeometry = new THREE.IcosahedronGeometry(1, 1);
  const trunkMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.96 });
  const leafMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.87 });
  const cardTriangles = crownLibrary ? crownLibrary.statistics.triangles : {};
  const chunks = [];
  const cardGeometries = [];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const rotation = new THREE.Quaternion();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const tint = new THREE.Color();
  const trunkLight = new THREE.Color(0x77634c);
  const lowDetailPipelines = new Map();
  // 每个树种只建一次颜色对象，避免为每棵树重复分配 THREE.Color。
  const styleColors = new Map();
  const colorsFor = name => {
    let entry = styleColors.get(name);
    if (!entry) {
      const style = speciesStyle(name);
      entry = { crown: new THREE.Color(style.crownColor), light: new THREE.Color(style.crownLight) };
      styleColors.set(name, entry);
    }
    return entry;
  };
  const pose = (mesh, instance, x, y, z, sx, sy, sz) => {
    mesh.setMatrixAt(instance, matrix.compose(position.set(x, y, z), identity, scale.set(sx, sy, sz)));
  };
  // 每棵树的叶色：树种调色板按固定哈希插值，再按树标识微调明度。颜色只是外观估计。
  function tintFor(record) {
    const palette = colorsFor(record.speciesName);
    return tint.copy(palette.crown).lerp(palette.light, treeSeed(record.sourceId + ':crown'));
  }
  // 远冠底部盖住树干顶端，低模轮廓也能接到主干。
  function poseFar(record, farMesh, instance) {
    const { style } = record;
    const halfHeight = farCrownHalfHeight(record);
    const overlap = Math.min(0.25, halfHeight * 0.25);
    pose(farMesh, instance, record.x, record.y + record.trunkHeight + halfHeight - overlap, record.z,
      record.crown * (0.36 + style.farSpread * 0.6),
      halfHeight,
      record.crown * (0.36 + style.farSpread * 0.6));
    farMesh.setColorAt(instance, tintFor(record));
  }
  // 近景整树从地面起，用同一个矩阵放置主干、分枝和叶片。
  function poseCard(record, cardMesh, instance, data, sway) {
    rotation.setFromAxisAngle(upAxis, record.seed * Math.PI * 2);
    cardMesh.setMatrixAt(instance, matrix.compose(
      position.set(record.x, record.y, record.z), rotation, scale.set(record.crown, record.height, record.crown)));
    const leafTint = tintFor(record);
    data.setXYZW(instance, leafTint.r, leafTint.g, leafTint.b, treeSeed(record.sourceId + ':leaf'));
    // 整树摆幅按树高给（世界米）：11 m 树约 0.2 m，和纽约参考同一量级，只是外观估计。
    const amplitude = treeSwayAmplitude(record.height);
    sway.setXY(instance, amplitude, treeSeed(record.sourceId + ':wind'));
    return amplitude;
  }
  function buildLowDetail(records, name, shadow) {
    if (!records.length) return [];
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, records.length);
    trunks.name = `tree-trunks-${name}`;
    trunks.userData.sources = records.map(record => record.sourceId);
    const crowns = new THREE.InstancedMesh(farGeometry, leafMaterial, records.length);
    crowns.name = `tree-crowns-${name}`;
    records.forEach((record, instance) => {
      pose(trunks, instance, record.x, record.y, record.z, record.trunkRadius, record.trunkHeight, record.trunkRadius);
      color.setHex(record.style.trunkColor).lerp(trunkLight, treeSeed(record.sourceId + ':trunk'));
      trunks.setColorAt(instance, color);
      poseFar(record, crowns, instance);
    });
    trunks.castShadow = shadow;
    for (const mesh of [trunks, crowns]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      const pipelineKey = mesh === crowns ? 'crown' : shadow ? 'shadow-trunk' : 'trunk';
      const pipeline = lowDetailPipelines.get(pipelineKey);
      if (pipeline) mesh.userData.sharesPipelineWith = pipeline;
      else lowDetailPipelines.set(pipelineKey, mesh);
      group.add(mesh);
    }
    return [trunks, crowns];
  }
  for (const key of [...grouped.keys()].sort(compareChunkKeys)) {
    const records = grouped.get(key);
    const cells = new Map();
    for (const record of records) {
      const cellKey = `${Math.floor(record.x / LOD_CELL_M)},${Math.floor(record.z / LOD_CELL_M)}`;
      let cell = cells.get(cellKey);
      if (!cell) cells.set(cellKey, (cell = { key: cellKey, records: [], box: { minX: Infinity, maxX: -Infinity,
        minZ: Infinity, maxZ: -Infinity } }));
      cell.records.push(record);
      cell.box.minX = Math.min(cell.box.minX, record.x);
      cell.box.maxX = Math.max(cell.box.maxX, record.x);
      cell.box.minZ = Math.min(cell.box.minZ, record.z);
      cell.box.maxZ = Math.max(cell.box.maxZ, record.z);
    }
    const chunkCells = [];
    for (const cellKey of [...cells.keys()].sort(compareChunkKeys)) {
      const cell = cells.get(cellKey);
      const regular = [], woodland = [];
      for (const record of cell.records) (record.woodland ? woodland : regular).push(record);
      const far = buildLowDetail(regular, `far:${key}/${cellKey}`, true);
      // 补植树木始终使用同一低模，不建叶卡和阴影投射批次。
      const grove = buildLowDetail(woodland, `woodland:${key}/${cellKey}`, false);
      // 近冠按树种分实例网格：几何不同，但材质、图集共用。
      const byTemplate = new Map();
      for (const record of regular) {
        let list = byTemplate.get(record.crownTemplate);
        if (!list) byTemplate.set(record.crownTemplate, (list = []));
        list.push(record);
      }
      const cards = [];
      let cardTrees = 0;
      let cellCardTriangles = 0;
      let maxSway = 0;
      for (const template of [...byTemplate.keys()].sort()) {
        const groupRecords = byTemplate.get(template);
        const geometry = crownLibrary.geometryFor(template);
        // 几何属性共享库里的缓冲，只有实例属性和矩阵按子格各一份。
        const cardGeometry = new THREE.BufferGeometry();
        for (const name of Object.keys(geometry.attributes)) {
          cardGeometry.setAttribute(name, geometry.attributes[name]);
        }
        cardGeometry.setIndex(geometry.index);
        cardGeometry.boundingSphere = geometry.boundingSphere;
        cardGeometry.boundingBox = geometry.boundingBox;
        const data = new THREE.InstancedBufferAttribute(new Float32Array(groupRecords.length * 4), 4);
        const sway = new THREE.InstancedBufferAttribute(new Float32Array(groupRecords.length * 2), 2);
        cardGeometry.setAttribute('aTreeData', data);
        cardGeometry.setAttribute('aTreeSway', sway);
        const cardMesh = new THREE.InstancedMesh(cardGeometry, crownLibrary.material, groupRecords.length);
        cardMesh.name = `tree-crowns-near:${key}/${cellKey}:${template}`;
        groupRecords.forEach((record, instance) => {
          maxSway = Math.max(maxSway, poseCard(record, cardMesh, instance, data, sway));
        });
        cardMesh.instanceMatrix.needsUpdate = true;
        cardMesh.geometry.attributes.aTreeData.needsUpdate = true;
        cardMesh.geometry.attributes.aTreeSway.needsUpdate = true;
        cardMesh.castShadow = true;
        cardMesh.receiveShadow = true;
        cardMesh.frustumCulled = true;
        cardMesh.computeBoundingSphere();
        // 风摆在着色器里做，包围球留出摆幅，避免近处树被视锥提前剔掉。
        cardMesh.boundingSphere.radius += maxSway + 0.12;
        group.add(cardMesh);
        cardGeometries.push(cardGeometry);
        const triangles = groupRecords.length * (cardTriangles[template] ?? 0);
        cards.push({ template, mesh: cardMesh, trees: groupRecords.length, triangles });
        cardTrees += groupRecords.length;
        cellCardTriangles += triangles;
      }
      chunkCells.push({ key: cellKey, cards, far, grove, trees: cell.records.length, woodland: woodland.length,
        cardTrees, cardTriangles: cellCardTriangles, box: cell.box, mode: 'far' });
    }
    chunks.push({ cells: chunkCells });
  }
  scene.add(group);

  const lodCells = chunks.reduce((sum, chunk) => sum + chunk.cells.length, 0);
  const statistics = {
    version: 1,
    payloadCount,
    placed: placed.length,
    chunks: chunks.length,
    lodCells,
    countsBySource,
    skipped,
    cardCrownSpecies: crownLibrary ? crownLibrary.statistics.species.map(item => item.name) : [],
    instances: { trunks: placed.length, cards: placed.length - (countsBySource[WOODLAND_SOURCE] ?? 0), farCrowns: placed.length },
    triangles: {
      trunkPerTree: TRUNK_TRIANGLES,
      cardPerTree: { ...cardTriangles },
      farPerTree: FAR_CROWN_TRIANGLES
    },
    crown: crownLibrary ? { ...crownLibrary.statistics } : null,
    visible: { chunks: 0, lodCells: 0, nearCells: 0, farCells: 0, hiddenCells: 0, trees: 0,
      nearTrees: 0, farTrees: 0, cardTrees: 0, triangles: 0 }
  };

  // 相机到子格包围盒的水平距离；子格内可能有树，按最近边缘算比按质心更符合“近处高模”的意图。
  function boxDistance(box, x, z) {
    const dx = x < box.minX ? box.minX - x : x > box.maxX ? x - box.maxX : 0;
    const dz = z < box.minZ ? box.minZ - z : z > box.maxZ ? z - box.maxZ : 0;
    return Math.hypot(dx, dz);
  }

  function update(cameraPosition) {
    if (!cameraPosition) return;
    let visibleChunks = 0;
    let visibleCells = 0;
    let nearCells = 0;
    let farCells = 0;
    let hiddenCells = 0;
    let nearTrees = 0;
    let farTrees = 0;
    let cardTrees = 0;
    let nearCardTriangles = 0;
    let nearWoodlandTrees = 0;
    let visibleWoodlandTrees = 0;
    const x = cameraPosition.x;
    const z = cameraPosition.z;
    for (const chunk of chunks) {
      let chunkVisible = false;
      for (const cell of chunk.cells) {
        const distance = boxDistance(cell.box, x, z);
        const canBeNear = distance < (cell.mode === 'near' ? NEAR_EXIT_M : NEAR_ENTER_M);
        const visible = cell.mode === 'hidden' ? distance <= FAR_ENTER_M : distance <= FAR_EXIT_M;
        cell.mode = visible ? (canBeNear ? 'near' : 'far') : 'hidden';
        for (const card of cell.cards) card.mesh.visible = cell.mode === 'near';
        for (const mesh of cell.far) mesh.visible = cell.mode === 'far';
        for (const mesh of cell.grove) mesh.visible = visible;
        if (!visible) {
          hiddenCells += 1;
          continue;
        }
        visibleCells += 1;
        visibleWoodlandTrees += cell.woodland;
        chunkVisible = true;
        if (cell.mode === 'near') {
          nearCells += 1;
          nearTrees += cell.trees;
          cardTrees += cell.cardTrees;
          nearCardTriangles += cell.cardTriangles;
          nearWoodlandTrees += cell.woodland;
        } else {
          farCells += 1;
          farTrees += cell.trees;
        }
      }
      if (chunkVisible) visibleChunks += 1;
    }
    statistics.visible = {
      chunks: visibleChunks,
      lodCells: visibleCells,
      nearCells,
      farCells,
      hiddenCells,
      trees: nearTrees + farTrees,
      nearTrees,
      farTrees,
      cardTrees,
      woodlandTrees: visibleWoodlandTrees,
      triangles: nearCardTriangles + (farTrees + nearWoodlandTrees) * (TRUNK_TRIANGLES + FAR_CROWN_TRIANGLES)
    };
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    for (const mesh of group.children) mesh.dispose();
    group.clear();
    for (const geometry of cardGeometries) geometry.dispose();
    cardGeometries.length = 0;
    crownLibrary?.dispose();
    trunkGeometry.dispose();
    farGeometry.dispose();
    trunkMaterial.dispose();
    leafMaterial.dispose();
    chunks.length = 0;
    placed.length = 0;
    treeColliders.length = 0;
  }

  update(new THREE.Vector3());
  // 叶卡树冠材质只有一个管线：每个子格网格的几何布局相同，指定一个可见代表让预编译只编一次，
  // 否则每个子格各编一次，冷启动 compile 阶段会从几秒涨到几十秒。
  const cardMeshes = [];
  for (const chunk of chunks) {
    for (const cell of chunk.cells) for (const card of cell.cards) cardMeshes.push(card.mesh);
  }
  const representative = cardMeshes.find(mesh => mesh.visible) ?? cardMeshes[0];
  if (representative) {
    for (const mesh of cardMeshes) if (mesh !== representative) mesh.userData.sharesPipelineWith = representative;
  }
  function flightObstacles(bounds) {
    const obstacles = [];
    for (const record of placed) {
      // 树干碰撞只覆盖近地；低空检查必须计入远近两档树冠及摆动。
      const radius = record.crown * 0.75 + 0.35;
      if (record.x + radius < bounds.minX || record.x - radius > bounds.maxX
        || record.z + radius < bounds.minZ || record.z - radius > bounds.maxZ) continue;
      obstacles.push({ minX: record.x - radius, maxX: record.x + radius, minZ: record.z - radius,
        maxZ: record.z + radius, minY: record.y + record.trunkHeight * 0.65,
        maxY: record.y + record.height + 0.5 });
    }
    return obstacles;
  }
  return { group, colliders: treeColliders, statistics, update, dispose, flightObstacles };
}
