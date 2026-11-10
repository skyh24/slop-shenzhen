import * as THREE from 'three/webgpu';
import { CROWN_SPECIES, createCrownLibrary } from './sz-tree-crown.js';

// 树木实例化渲染：按 1000 m 分块，每块树干 + 近冠 + 远冠（1 个低模冠），
// 近/<180 m 切近冠，>900 m 隐藏。所有随机量只由树标识的固定哈希派生，加载结果稳定。
// 近冠全部换成 sz-tree-crown.js 的叶卡树冠（按树种分几何）；远景一律保留低模 icosahedron 冠，
// 近/远切换仍按 250 m 子格和 180/198 m 迟滞，三角形预算可控。

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
const OSM_SOURCE_NAMES = new Set(['osm-node', 'osm-row']);
// 叶卡树冠覆盖的树种；载荷里出现未知树种名时退回 ficus 形态，颜色仍按该树种的调色板。
const CROWN_TEMPLATE_NAMES = new Set(Object.keys(CROWN_SPECIES));

// 树种只定义形态比例和颜色；树高、冠幅来自数据，避免运行时再造随机尺寸。
const SPECIES_STYLE = {
  ficus: { trunkRatio: 0.34, crownColor: 0x3c562f, crownLight: 0x66804d, trunkColor: 0x5f4e3f,
    farSpread: 0.17, farHeight: 0.30 },
  camphor: { trunkRatio: 0.44, crownColor: 0x405c33, crownLight: 0x687d45, trunkColor: 0x5b4b3d,
    farSpread: 0.16, farHeight: 0.32 },
  phoenix: { trunkRatio: 0.40, crownColor: 0x4b6a32, crownLight: 0x7a9448, trunkColor: 0x655642,
    farSpread: 0.24, farHeight: 0.20 },
  bauhinia: { trunkRatio: 0.36, crownColor: 0x54703f, crownLight: 0x7d925c, trunkColor: 0x635343,
    farSpread: 0.18, farHeight: 0.32 },
  'royal-palm': { trunkRatio: 0.76, crownColor: 0x36542c, crownLight: 0x5b7738, trunkColor: 0x746a58,
    farSpread: 0.08, farHeight: 0.40 },
  kapok: { trunkRatio: 0.52, crownColor: 0x4a5f38, crownLight: 0x6f8049, trunkColor: 0x6a5847,
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

function polygonContains(polygon, x, z) {
  let inside = false;
  for (let ringIndex = -1; ringIndex < polygon.holes.length; ringIndex++) {
    const ring = ringIndex < 0 ? polygon.outer : polygon.holes[ringIndex];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
    }
  }
  return inside;
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

// 树干半径按冠幅估计，只影响外观和碰撞，不写成实测胸径。
function trunkRadiusFor(style, crown) {
  return Math.max(0.10, Math.min(0.55, crown * 0.030)) * (style === SPECIES_STYLE['royal-palm'] ? 0.9 : 1);
}

function trunkHeightFor(style, height) {
  return Math.max(1.4, height * style.trunkRatio);
}

function colliderPolygon(x, z, radius) {
  const sides = 6;
  const outer = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    outer.push({ x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius });
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
  for (const entry of raw.osm) {
    requireTree(Array.isArray(entry) && entry.length === 2, 'osm entry');
    const [index, id] = entry;
    requireTree(Number.isInteger(index) && index >= 0 && index < count, 'osm index');
    requireTree(typeof id === 'string' && /^(?:node|way)\/\d+$/.test(id), 'osm id');
    requireTree(!seen.has(index), 'osm duplicate');
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
      skipped: { unsupportedGround: 0, roadConflict: 0, pathConflict: 0, buildingConflict: 0 },
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
  const { groundHeight, roadHeight, pathAt = () => [], colliders = [] } = options;
  const trees = decodeTreePayload(payload);
  if (!trees || trees.count === 0) {
    const empty = emptyResult();
    scene.add(empty.group);
    return empty;
  }
  const group = new THREE.Group();
  group.name = 'shenzhen-trees';
  const countsBySource = {};
  const skipped = { unsupportedGround: 0, roadConflict: 0, pathConflict: 0, buildingConflict: 0 };
  const empty = emptyResult();
  if (typeof groundHeight !== 'function') {
    empty.statistics.payloadCount = trees.count;
    empty.statistics.skipped.unsupportedGround = trees.count;
    scene.add(empty.group);
    return empty;
  }

  const hitsCollider = createColliderIndex(colliders);
  const probes = [[0, 0], [PROBE_RADIUS_M, 0], [-PROBE_RADIUS_M, 0], [0, PROBE_RADIUS_M], [0, -PROBE_RADIUS_M]];
  const placed = [];
  const treeColliders = [];
  const crownTemplates = new Set();
  for (let index = 0; index < trees.count; index++) {
    const x = trees.x[index];
    const z = trees.z[index];
    const height = trees.height[index];
    const crown = trees.crown[index];
    let baseY = Infinity;
    let reason = null;
    for (const [dx, dz] of probes) {
      const sample = groundHeight(x + dx, z + dz);
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
        if (paths && paths.length) {
          reason = 'pathConflict';
          break;
        }
      }
    }
    if (!reason && hitsCollider(x, z, crown / 2, baseY, baseY + height)) reason = 'buildingConflict';
    if (reason) {
      skipped[reason] += 1;
      continue;
    }
    const speciesName = trees.speciesNames[trees.species[index]] ?? 'ficus';
    const sourceName = trees.sources[trees.source[index]] ?? 'unknown';
    countsBySource[sourceName] = (countsBySource[sourceName] ?? 0) + 1;
    const style = speciesStyle(speciesName);
    const trunkHeight = trunkHeightFor(style, height);
    const trunkRadius = trunkRadiusFor(style, crown);
    const id = trees.osm.get(index) ?? `tree/${index}`;
    // 未知树种退回 ficus 叶卡形态，颜色仍用该树种的调色板。
    const crownTemplate = CROWN_TEMPLATE_NAMES.has(speciesName) ? speciesName : 'ficus';
    crownTemplates.add(crownTemplate);
    const record = { index, id, x, z, y: baseY, height, crown, speciesName, sourceName,
      style, trunkHeight, trunkRadius, seed: treeSeed(id), crownTemplate };
    placed.push(record);
    // 碰撞体略小于树干可视半径：真实行道树树干约 0.4–0.9 m 直径，1.1 倍会把 2.5 m 人行道封死。
    const radius = Math.max(0.18, trunkRadius * 0.8);
    treeColliders.push({ type: 'tree', name: id, sourceId: id, polygon: colliderPolygon(x, z, radius),
      minY: baseY, maxY: baseY + Math.max(1.6, trunkHeight),
      minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius });
  }

  // 按 1000 m 分块建树干实例；近冠/远冠再按 250 m LOD 子格拆分，切换以子格为单位。
  const grouped = new Map();
  for (const record of placed) {
    const key = `${Math.floor(record.x / CHUNK_SIZE_M)},${Math.floor(record.z / CHUNK_SIZE_M)}`;
    let list = grouped.get(key);
    if (!list) grouped.set(key, (list = []));
    list.push(record);
  }
  const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, TRUNK_SIDES, 1, true).translate(0, 0.5, 0);
  const farGeometry = new THREE.IcosahedronGeometry(1, 1);
  const trunkMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.96 });
  const leafMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.87 });
  // 叶卡树冠：每个树种一份共享几何，图集和材质全场共用；每个 LOD 子格按树种各一份实例属性和矩阵。
  const crownLibrary = crownTemplates.size > 0 ? createCrownLibrary([...crownTemplates]) : null;
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
    return tint.copy(palette.crown).lerp(palette.light, treeSeed(record.id + ':crown'));
  }
  // 远冠：所有树种共用 1 个低模球，近景换叶卡后远景不动。
  function poseFar(record, farMesh, instance) {
    const { style } = record;
    const crownHeight = Math.max(0.8, record.height - record.trunkHeight);
    pose(farMesh, instance, record.x, record.y + record.trunkHeight + crownHeight * 0.42, record.z,
      record.crown * (0.36 + style.farSpread * 0.6),
      crownHeight * (0.35 + style.farHeight * 0.3),
      record.crown * (0.36 + style.farSpread * 0.6));
    farMesh.setColorAt(instance, tintFor(record));
  }
  // 近冠叶卡：几何已归一化（冠底 y=0、冠顶 y≈1、水平半宽 0.5）。
  function poseCard(record, cardMesh, instance, data, sway) {
    const crownHeight = Math.max(0.8, record.height - record.trunkHeight);
    rotation.setFromAxisAngle(upAxis, record.seed * Math.PI * 2);
    cardMesh.setMatrixAt(instance, matrix.compose(
      position.set(record.x, record.y + record.trunkHeight - 0.15, record.z),
      rotation, scale.set(record.crown, crownHeight, record.crown)));
    const leafTint = tintFor(record);
    data.setXYZW(instance, leafTint.r, leafTint.g, leafTint.b, treeSeed(record.id + ':leaf'));
    // 整树摆幅按树高给（世界米）：11 m 树约 0.2 m，和纽约参考同一量级，只是外观估计。
    const amplitude = Math.min(0.4, Math.max(0.08, record.height * 0.018));
    sway.setXY(instance, amplitude, treeSeed(record.id + ':wind'));
    return amplitude;
  }
  for (const key of [...grouped.keys()].sort(compareChunkKeys)) {
    const records = grouped.get(key);
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, records.length);
    trunks.name = `tree-trunks:${key}`;
    trunks.userData.sources = records.map(record => record.id);
    records.forEach((record, instance) => {
      pose(trunks, instance, record.x, record.y, record.z,
        record.trunkRadius, record.trunkHeight, record.trunkRadius);
      color.setHex(record.style.trunkColor).lerp(trunkLight, treeSeed(record.id + ':trunk'));
      trunks.setColorAt(instance, color);
    });
    trunks.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    trunks.frustumCulled = true;
    trunks.computeBoundingSphere();
    group.add(trunks);
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
      const far = new THREE.InstancedMesh(farGeometry, leafMaterial, cell.records.length);
      far.name = `tree-crowns-far:${key}/${cellKey}`;
      cell.records.forEach((record, instance) => poseFar(record, far, instance));
      far.instanceMatrix.needsUpdate = true;
      far.castShadow = false;
      far.receiveShadow = true;
      far.frustumCulled = true;
      far.computeBoundingSphere();
      far.instanceColor.needsUpdate = true;
      group.add(far);
      // 近冠按树种分实例网格：几何不同，但材质、图集共用。
      const byTemplate = new Map();
      for (const record of cell.records) {
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
      chunkCells.push({ key: cellKey, cards, far, trees: cell.records.length,
        cardTrees, cardTriangles: cellCardTriangles, box: cell.box, mode: 'far' });
    }
    chunks.push({ key, trunks, cells: chunkCells, trees: records.length });
  }
  scene.add(group);

  const lodCells = chunks.reduce((sum, chunk) => sum + chunk.cells.length, 0);
  const statistics = {
    version: 1,
    payloadCount: trees.count,
    placed: placed.length,
    chunks: chunks.length,
    lodCells,
    countsBySource,
    skipped,
    cardCrownSpecies: crownLibrary ? crownLibrary.statistics.species.map(item => item.name) : [],
    instances: { trunks: placed.length, cards: placed.length, farCrowns: placed.length },
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
    let trunkTrees = 0;
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
        cell.far.visible = cell.mode === 'far';
        if (!visible) {
          hiddenCells += 1;
          continue;
        }
        visibleCells += 1;
        chunkVisible = true;
        if (cell.mode === 'near') {
          nearCells += 1;
          nearTrees += cell.trees;
          cardTrees += cell.cardTrees;
          nearCardTriangles += cell.cardTriangles;
        } else {
          farCells += 1;
          farTrees += cell.trees;
        }
      }
      chunk.trunks.visible = chunkVisible;
      if (chunkVisible) {
        visibleChunks += 1;
        trunkTrees += chunk.trees;
      }
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
      triangles: trunkTrees * TRUNK_TRIANGLES + nearCardTriangles + farTrees * FAR_CROWN_TRIANGLES
    };
  }

  function dispose() {
    group.removeFromParent();
    for (const geometry of cardGeometries) geometry.dispose();
    cardGeometries.length = 0;
    crownLibrary?.dispose();
    trunkGeometry.dispose();
    farGeometry.dispose();
    trunkMaterial.dispose();
    leafMaterial.dispose();
    chunks.length = 0;
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
  return { group, colliders: treeColliders, statistics, update, dispose };
}
