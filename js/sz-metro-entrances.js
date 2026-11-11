// 全市地铁出入口：用 OSM 已核实的出入口节点生成石基座 + 玻璃雨棚 + 站名牌。
// 点位是实测 OSM 节点；雨棚形状、朝向和贴图为外观参数，不代表逐口实测。
import * as THREE from 'three/webgpu';
import { cameraPosition, distance, float, positionWorld, smoothstep } from 'three/tsl';
import { polygonBoxOverlaps } from './building-collision.js';
import { finitePoint } from './sz-polygon.js';
import { canvasTexture, mergeParts } from './sz-mesh-utils.js';

// 雨棚净尺寸按深圳地铁常见出入口量级取值；站名牌挂在雨棚前沿上方。
export const ENTRANCE_SIZE_M = Object.freeze({ width: 4.5, depth: 2.8, height: 2.6 });
export const ENTRANCE_CHUNK_SIZE_M = 500;
export const SIGN_NEAR_M = 450; // 近距离显示带文字站名牌
export const SIGN_FAR_M = 1200; // 超过此距离不再画站名牌
const STRUCTURE_MAX_DISTANCE_M = 1500;
const BASE_WIDTH_M = 5.0;
const BASE_DEPTH_M = 3.2;
const PROBE_HALF_X_M = 2.55;
const PROBE_HALF_Z_M = 1.65;
const COLLIDER_HALF_X_M = 2.5;
const COLLIDER_HALF_Z_M = 1.6;

const STONE_COLOR = 0xb9b3a6;
const CURB_COLOR = 0x8d8880;
const FRAME_COLOR = 0x3b4247;
const STAIR_COLOR = 0x161a1d;
const ROOF_COLOR = 0x565f63;
const GLASS_COLOR = 0xb9d4e2;
const SIGN_BACKGROUND = '#12352c';
const SIGN_TEXT = '#f2f5f1';
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function hashAngle(text) {
  return (hashSeed(text) % 360) * Math.PI / 180;
}

function exitRef(entrance) {
  const raw = typeof entrance?.ref === 'string' ? entrance.ref.trim().toUpperCase() : '';
  if (raw && /^[A-Z]\d{0,2}$/.test(raw)) return raw;
  const name = typeof entrance?.name === 'string' ? entrance.name.trim() : '';
  const fromName = /([A-Za-z]\d{0,2})\s*(?:出口|口)?\s*$/.exec(name);
  if (fromName) return fromName[1].toUpperCase();
  return '';
}

// “香梅北 D出口”“石厦站A口”只保留站名；“A”“C2出口”没有站名。
function stationNameFromEntrance(entrance) {
  const name = typeof entrance?.name === 'string' ? entrance.name.trim() : '';
  if (!name) return '';
  let text = name.replace(/\s*[A-Za-z]\d{0,2}\s*(?:出口|口)\s*$/, '').trim();
  text = text.replace(/\s*(?:出口|口)\s*$/, '').trim();
  if (/^[A-Za-z]\d{0,2}$/.test(text)) return '';
  if (text.endsWith('站')) text = text.slice(0, -1).trim();
  if (/^[A-Za-z]\d{0,2}$/.test(text)) return '';
  return text;
}

function lineTable(metro) {
  const table = new Map();
  for (const line of metro?.lines ?? []) {
    if (typeof line?.ref !== 'string' || !HEX_COLOUR.test(line.colour ?? '')) continue;
    table.set(line.ref, { ref: line.ref, colour: line.colour.toUpperCase(), name: line.name ?? '' });
  }
  return table;
}

function stationDistance(entrance, station) {
  return Math.hypot(entrance.x - station.x, entrance.z - station.z);
}

// 站点关联：优先线路交集，其次距离，最后按 OSM id，保证同一次加载结果一致。
function nearestStation(entrance, stations, maxDistanceM) {
  let best = null;
  let bestOverlap = false;
  let bestDistance = Infinity;
  for (const station of stations) {
    if (!Number.isFinite(station.x) || !Number.isFinite(station.z)) continue;
    const d = stationDistance(entrance, station);
    if (!(d <= maxDistanceM)) continue;
    const overlap = (entrance.lineRefs ?? []).some(ref => (station.lineRefs ?? []).includes(ref));
    if (!best || (overlap && !bestOverlap) || (overlap === bestOverlap
      && (d < bestDistance || (d === bestDistance && String(station.id) < String(best.id))))) {
      best = station;
      bestOverlap = overlap;
      bestDistance = d;
    }
  }
  return best ? { station: best, overlap: bestOverlap, distance: bestDistance } : null;
}

function resolvedLines(entrance, station, lineLookup) {
  const refs = [...new Set([...(entrance.lineRefs ?? []), ...(station?.lineRefs ?? [])])];
  const lines = refs.map(ref => lineLookup.get(ref)).filter(Boolean);
  return lines.sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
}

/**
 * 把 OSM 出入口关联到最近车站，并解析中文站名、出入口编号和线路色。
 * 无坐标、无站名或没有可用官方线路色的入口记为 unresolved，不进入建模。
 */
/** 解析：把 OSM 地铁出入口关联到最近车站并解析中文站名/出口字母/官方线路色。
 *  输入：metro.entrances/stations/lines；maxStationDistanceM 默认 300 m。
 *  输出：{ entrances, unresolved }；无站名或无官方线路色的入口记 unresolved，不硬配。
 *  来源：位置来自 OSM 节点；朝向、雨棚形状为外观估计。 */
export function planMetroEntrances(metro, options = {}) {
  if (!Array.isArray(metro?.entrances) || !Array.isArray(metro?.stations)) {
    throw new Error('Metro entrances require entrance and station arrays');
  }
  const maxStationDistanceM = options.maxStationDistanceM ?? 300;
  if (!(maxStationDistanceM > 0)) throw new Error('Metro entrance station distance must be positive');
  const stations = metro.stations.filter(station => station && String(station.id ?? '') !== '');
  const lineLookup = lineTable(metro);
  const entrances = [];
  const unresolved = [];
  const ordered = [...metro.entrances].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  for (const entrance of ordered) {
    if (!finitePoint(entrance)) {
      unresolved.push({ id: entrance?.id ?? '', reason: 'missing-coordinates' });
      continue;
    }
    const match = nearestStation(entrance, stations, maxStationDistanceM);
    const station = match?.station ?? null;
    const stationName = station?.name?.trim() || (entrance.stationNames ?? []).find(name => typeof name === 'string' && name.trim())
      || stationNameFromEntrance(entrance);
    if (!stationName) {
      unresolved.push({ id: entrance.id, reason: 'no-station-name', x: entrance.x, z: entrance.z });
      continue;
    }
    const lines = resolvedLines(entrance, station, lineLookup);
    if (lines.length === 0) {
      unresolved.push({ id: entrance.id, reason: 'no-line-colour', x: entrance.x, z: entrance.z });
      continue;
    }
    entrances.push({
      id: entrance.id,
      x: entrance.x,
      z: entrance.z,
      stationId: station?.id ?? null,
      stationName,
      stationDistanceM: match ? Math.round(match.distance * 10) / 10 : null,
      associationSource: match ? (match.overlap ? 'line-overlap-nearest-station' : 'nearest-station')
        : 'entrance-name',
      ref: exitRef(entrance),
      lineRefs: lines.map(line => line.ref),
      colours: lines.map(line => line.colour),
      positionSource: entrance.positionSource ?? 'osm-node',
      source: entrance.source ?? null
    });
  }
  return { entrances, unresolved };
}

function fitFont(context, text, maxWidth, startSize, family) {
  let size = startSize;
  while (size > 12) {
    context.font = `bold ${size}px ${family}`;
    if (context.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

const SIGN_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function drawStationTile(context, x, y, width, height, name, lines) {
  context.fillStyle = SIGN_BACKGROUND;
  context.fillRect(x, y, width, height);
  context.strokeStyle = 'rgba(255,255,255,0.35)';
  context.lineWidth = 2;
  context.strokeRect(x + 1, y + 1, width - 2, height - 2);
  const stripeHeight = 13;
  const stripeTop = y + height - stripeHeight;
  const stripeWidth = width / Math.max(1, lines.length);
  lines.forEach((line, index) => {
    context.fillStyle = line.colour;
    context.fillRect(x + index * stripeWidth, stripeTop, stripeWidth, stripeHeight);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `bold 10px ${SIGN_FONT}`;
    context.fillText(line.ref, x + (index + 0.5) * stripeWidth, stripeTop + stripeHeight / 2 + 0.5);
  });
  // 左侧“地铁”竖排小字，说明设施类型；不使用任何官方标志。
  context.fillStyle = 'rgba(255,255,255,0.72)';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.font = `bold 12px ${SIGN_FONT}`;
  context.fillText('地铁', x + 8, y + 15);
  const size = fitFont(context, name, width - 58, 30, SIGN_FONT);
  context.fillStyle = SIGN_TEXT;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `bold ${size}px ${SIGN_FONT}`;
  context.fillText(name, x + 8 + (width - 58) / 2, y + (height - stripeHeight) / 2 + 1);
}

function drawBadgeTile(context, x, y, width, height, ref) {
  // 出口字母牌用白底黑字，和线路色条分开；线路色仍由站名牌底部色条承担。
  context.fillStyle = '#f2f5f1';
  context.fillRect(x, y, width, height);
  context.strokeStyle = 'rgba(18,53,44,0.8)';
  context.lineWidth = 3;
  context.strokeRect(x + 2, y + 2, width - 4, height - 4);
  if (!ref) return;
  context.fillStyle = '#15201b';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `bold ${ref.length > 1 ? 30 : 38}px ${SIGN_FONT}`;
  context.fillText(ref, x + width / 2, y + height / 2 + 1);
}

function signAtlas(entrances) {
  const stationKeys = new Map();
  const stationOrder = [];
  for (const entrance of entrances) {
    const key = `${entrance.stationName}|${entrance.lineRefs.join(',')}`;
    if (!stationKeys.has(key)) {
      stationKeys.set(key, stationOrder.length);
      stationOrder.push({ key, name: entrance.stationName, lines: entrance.colours.map((colour, i) => ({
        ref: entrance.lineRefs[i], colour
      })) });
    }
  }
  if (stationOrder.length > 96) throw new Error(`Metro sign atlas has ${stationOrder.length} station tiles`);
  const letterKeys = new Map();
  for (const entrance of entrances) if (entrance.ref && !letterKeys.has(entrance.ref)) letterKeys.set(entrance.ref, letterKeys.size + 1);
  if (letterKeys.size > 128) throw new Error(`Metro sign atlas has ${letterKeys.size} exit badges`);
  const columns = 8;
  const stationRows = Math.max(1, Math.ceil(stationOrder.length / columns));
  const width = 2048;
  const height = 1024;
  const stationRegionHeight = stationRows * 64;
  const texture = canvasTexture(width, height, (context) => {
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    stationOrder.forEach((tile, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      drawStationTile(context, column * 256, row * 64, 256, 64, tile.name, tile.lines);
    });
    for (const [ref, index] of letterKeys) {
      const column = (index - 1) % 32;
      const row = Math.floor((index - 1) / 32);
      drawBadgeTile(context, column * 64, stationRegionHeight + row * 64, 64, 64, ref);
    }
  });
  return { texture, stationKeys, letterKeys, columns, stationRegionHeight, width, height };
}

function boxPart(width, height, depth, x, y, z, colour) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return { geometry, colour };
}

function structureGeometry() {
  const parts = [
    boxPart(BASE_WIDTH_M, 0.26, BASE_DEPTH_M, 0, 0.13, 0, STONE_COLOR),
    boxPart(BASE_WIDTH_M - 0.38, 0.06, BASE_DEPTH_M - 0.38, 0, 0.28, 0, CURB_COLOR),
    boxPart(3.2, 0.03, 1.9, 0, 0.31, 0, STAIR_COLOR)
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(boxPart(0.16, 2.32, 0.16, sx * 2.32, 1.42, sz * 1.43, FRAME_COLOR));
  }
  parts.push(boxPart(4.78, 0.14, 0.14, 0, 2.58, 1.46, FRAME_COLOR));
  parts.push(boxPart(4.78, 0.14, 0.14, 0, 2.58, -1.46, FRAME_COLOR));
  parts.push(boxPart(0.14, 0.14, 3.0, 2.36, 2.58, 0, FRAME_COLOR));
  parts.push(boxPart(0.14, 0.14, 3.0, -2.36, 2.58, 0, FRAME_COLOR));
  // 实心雨棚顶板：从远处也能读成“出入口”，不是空框。
  parts.push(boxPart(5.24, 0.2, 3.44, 0, 2.74, 0, ROOF_COLOR));
  parts.push(boxPart(5.3, 0.12, 3.5, 0, 2.88, 0, FRAME_COLOR));
  // 站名牌立柱：牌面挂在雨棚前沿上方。
  parts.push(boxPart(0.1, 0.74, 0.1, -1.26, 3.32, 1.5, FRAME_COLOR));
  parts.push(boxPart(0.1, 0.74, 0.1, 1.26, 3.32, 1.5, FRAME_COLOR));
  return mergeParts(parts);
}

function glassGeometry() {
  return mergeParts([
    boxPart(4.9, 0.06, 3.08, 0, 2.6, 0, 0xffffff),
    boxPart(0.06, 2.1, 2.9, 2.4, 1.45, 0, 0xffffff),
    boxPart(0.06, 2.1, 2.9, -2.4, 1.45, 0, 0xffffff)
  ]);
}

function rotationOf(yaw) {
  const quaternion = new THREE.Quaternion();
  quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return quaternion;
}

function localToWorld(x, y, z, yaw, lx, ly, lz) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos];
}

function addQuad(target, corners, normal, uvs, colour) {
  const base = target.positions.length / 3;
  for (const [index, corner] of corners.entries()) {
    target.positions.push(corner[0], corner[1], corner[2]);
    target.normals.push(normal[0], normal[1], normal[2]);
    target.uvs.push(uvs[index][0], uvs[index][1]);
    target.colours.push(colour[0], colour[1], colour[2]);
  }
  target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function signGeometry(entrances, atlas) {
  const near = { positions: [], normals: [], uvs: [], colours: [], indices: [] };
  const far = { positions: [], normals: [], uvs: [], colours: [], indices: [] };
  // 站名牌整体抬到雨棚顶以上，从街对面也能读到站名。
  const signBottom = 2.95;
  const signTop = 3.58;
  const signZ = 1.63;
  const badgeColour = new THREE.Color();
  const stationColour = new THREE.Color(SIGN_BACKGROUND).convertSRGBToLinear();
  for (const entrance of entrances) {
    const yaw = entrance.yaw;
    const frontNormal = [Math.sin(yaw), 0, Math.cos(yaw)];
    const backNormal = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    const plate = (x0, x1, tile) => {
      const corners = [
        localToWorld(entrance.x, entrance.y, entrance.z, yaw, x0, signBottom, signZ),
        localToWorld(entrance.x, entrance.y, entrance.z, yaw, x1, signBottom, signZ),
        localToWorld(entrance.x, entrance.y, entrance.z, yaw, x1, signTop, signZ),
        localToWorld(entrance.x, entrance.y, entrance.z, yaw, x0, signTop, signZ)
      ];
      const u0 = tile.column * tile.width / atlas.width;
      const u1 = (tile.column * tile.width + tile.width) / atlas.width;
      const v1 = 1 - (tile.regionTop + tile.row * tile.height) / atlas.height;
      const v0 = 1 - (tile.regionTop + tile.row * tile.height + tile.height) / atlas.height;
      // 正面
      addQuad(near, corners, frontNormal, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [1, 1, 1]);
      // 背面：反向绕序并把 U 镜像，从背后看文字仍然正读。
      const backCorners = [corners[0], corners[3], corners[2], corners[1]];
      addQuad(near, backCorners, backNormal, [[u1, v0], [u1, v1], [u0, v1], [u0, v0]], [1, 1, 1]);
      const solid = [tile.solidColour.r, tile.solidColour.g, tile.solidColour.b];
      addQuad(far, corners, frontNormal, [[0, 0], [0, 0], [0, 0], [0, 0]], solid);
      addQuad(far, backCorners, backNormal, [[0, 0], [0, 0], [0, 0], [0, 0]], solid);
    };
    const stationKey = `${entrance.stationName}|${entrance.lineRefs.join(',')}`;
    const stationIndex = atlas.stationKeys.get(stationKey);
    plate(-0.95, 1.5, {
      column: stationIndex % atlas.columns,
      row: Math.floor(stationIndex / atlas.columns),
      regionTop: 0,
      width: 256,
      height: 64,
      solidColour: stationColour
    });
    const badgeIndex = atlas.letterKeys.get(entrance.ref);
    if (badgeIndex !== undefined && entrance.colours.length) {
      badgeColour.set(entrance.colours[0]).convertSRGBToLinear();
      plate(-1.5, -0.98, {
        column: (badgeIndex - 1) % 32,
        row: Math.floor((badgeIndex - 1) / 32),
        regionTop: atlas.stationRegionHeight,
        width: 64,
        height: 64,
        solidColour: badgeColour
      });
    }
  }
  return { near: buildSignMeshGeometry(near), far: buildSignMeshGeometry(far) };
}

function buildSignMeshGeometry(target) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(target.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(target.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(target.uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(target.colours, 3));
  geometry.setIndex(target.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function nearbyCollider(colliders, x, y, z, halfX, halfZ, height) {
  for (const collider of colliders) {
    if (!Number.isFinite(collider?.minX) || !Number.isFinite(collider?.maxX)
      || !Number.isFinite(collider?.minZ) || !Number.isFinite(collider?.maxZ)) continue;
    if (!(collider.minY < y + height && collider.maxY > y)) continue;
    if (!(collider.minX < x + halfX && collider.maxX > x - halfX
      && collider.minZ < z + halfZ && collider.maxZ > z - halfZ)) continue;
    if (!collider.polygon || polygonBoxOverlaps(collider.polygon, x, z, halfX, halfZ)) return true;
  }
  return false;
}

function rotatePoint(x, z, yaw, lx, lz) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos };
}

/** 解析：建全城地铁出入口：石基座 + 玻璃雨棚 + 顶置站名牌，按 500/1000 m 分块实例化。
 *  输入：groundHeight/roadHeight/pathAt/colliders/isWater 用于落点校验；chunkSizeM 可调。
 *  输出：{ group, colliders, statistics, entrances, update(camera), dispose }；
 *        站名牌按相机距离 LOD（<450 m 文字牌、450–1200 m 纯色牌、>1200 m 不画）。 */
export function buildSzMetroEntrances(scene, metro, options = {}) {
  const chunkSizeM = options.chunkSizeM ?? ENTRANCE_CHUNK_SIZE_M;
  const { groundHeight, roadHeight = null, pathAt = () => [], colliders = [], isWater = null } = options;
  if (typeof groundHeight !== 'function') throw new Error('Metro entrances require a ground height sampler');
  const plan = planMetroEntrances(metro, options);
  const stationById = new Map((metro?.stations ?? []).map(station => [station.id, station]));
  const skipped = { unsupportedGround: 0, roadConflict: 0, pathConflict: 0, waterConflict: 0, buildingConflict: 0, duplicate: 0 };
  const skippedEntrances = [];
  const placed = [];
  const seen = new Set();
  for (const entrance of plan.entrances) {
    const station = entrance.stationId === null ? null : stationById.get(entrance.stationId);
    const yaw = station && Number.isFinite(station.x) && Number.isFinite(station.z)
      ? Math.atan2(station.x - entrance.x, station.z - entrance.z)
      : hashAngle(entrance.id);
    const facingSource = station ? 'nearest-station-estimate' : 'id-hash-estimate';
    const probes = [[0, 0], [PROBE_HALF_X_M, PROBE_HALF_Z_M], [-PROBE_HALF_X_M, PROBE_HALF_Z_M],
      [PROBE_HALF_X_M, -PROBE_HALF_Z_M], [-PROBE_HALF_X_M, -PROBE_HALF_Z_M]]
      .map(([lx, lz]) => rotatePoint(entrance.x, entrance.z, yaw, lx, lz));
    const heights = probes.map(probe => groundHeight(probe.x, probe.z));
    let reason = null;
    if (!heights.every(Number.isFinite)) reason = 'unsupportedGround';
    else if (typeof roadHeight === 'function' && probes.some(probe => roadHeight(probe.x, probe.z) != null)) reason = 'roadConflict';
    else if (probes.some(probe => pathAt(probe.x, probe.z).length > 0)) reason = 'pathConflict';
    else if (typeof isWater === 'function' && probes.some(probe => isWater(probe.x, probe.z))) reason = 'waterConflict';
    else {
      const key = `${Math.round(entrance.x * 2)},${Math.round(entrance.z * 2)}`;
      if (seen.has(key)) reason = 'duplicate';
      else if (nearbyCollider(colliders, entrance.x, Math.min(...heights), entrance.z,
        COLLIDER_HALF_X_M, COLLIDER_HALF_Z_M, 3.4)) reason = 'buildingConflict';
      else seen.add(key);
    }
    if (reason) {
      skipped[reason]++;
      skippedEntrances.push({ id: entrance.id, reason });
      continue;
    }
    placed.push({ ...entrance, y: Math.min(...heights), yaw, facingSource });
  }
  const skippedTotal = Object.values(skipped).reduce((sum, value) => sum + value, 0);
  const baseStatistics = {
    sourceEntrances: Array.isArray(metro?.entrances) ? metro.entrances.length : 0,
    planned: plan.entrances.length,
    placed: placed.length,
    skipped,
    skippedTotal,
    unresolved: plan.unresolved.length,
    unresolvedReasons: plan.unresolved.reduce((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {}),
    lod: { signNearM: SIGN_NEAR_M, signFarM: SIGN_FAR_M, structureMaxM: STRUCTURE_MAX_DISTANCE_M },
    heightSource: 'estimate',
    limitations: [
      'entrance positions are OSM nodes; canopy shape and facing are display estimates, not surveyed',
      'station signs are generated from OSM station names and official route colours; no operator logo is used',
      'canopy style is a generic Shenzhen-metro exit prototype, not a per-entrance surveyed design'
    ]
  };
  if (placed.length === 0) {
    return { group: null, colliders: [], statistics: { ...baseStatistics, chunks: 0, entrances: [],
      drawCallsEstimate: 0, colliderCount: 0, signAtlas: null },
    entrances: [], update() {}, dispose() {} };
  }

  const structureMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.06 });
  const glassMaterial = new THREE.MeshStandardNodeMaterial({
    color: GLASS_COLOR, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0.04, depthWrite: false
  });
  const atlas = signAtlas(placed);
  const nearSignMaterial = new THREE.MeshBasicNodeMaterial({ map: atlas.texture, alphaTest: 0.5 });
  const farSignMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true, alphaTest: 0.5 });
  // 站名牌按相机距离渐隐/渐显：近距离显示文字，450–1200 m 用纯色牌示意，超过 1200 m 不画。
  // 无 TSL 的离线测试只验证几何和统计，不构造 LOD 节点。
  if (typeof distance === 'function' && typeof smoothstep === 'function'
    && typeof float === 'function' && positionWorld && cameraPosition) {
    const cameraDistance = distance(positionWorld, cameraPosition);
    const nearAppear = smoothstep(SIGN_NEAR_M - 45, SIGN_NEAR_M, cameraDistance);
    nearSignMaterial.opacityNode = float(1).sub(nearAppear);
    farSignMaterial.opacityNode = nearAppear.mul(float(1).sub(smoothstep(SIGN_FAR_M - 50, SIGN_FAR_M, cameraDistance)));
  }

  const group = new THREE.Group();
  group.name = 'shenzhen-metro-entrances';
  const structure = structureGeometry();
  const glass = glassGeometry();
  const signs = signGeometry(placed, atlas);
  const structureMeshes = [];
  // 玻璃和结构共用同一套 chunkMap 分块：包围球只覆盖一个块，视锥剔除才真正生效。
  const glassMeshes = [];
  const chunkMap = new Map();
  for (const entrance of placed) {
    const key = `${Math.floor(entrance.x / chunkSizeM)},${Math.floor(entrance.z / chunkSizeM)}`;
    if (!chunkMap.has(key)) chunkMap.set(key, []);
    chunkMap.get(key).push(entrance);
  }
  for (const [key, chunk] of chunkMap) {
    // 玻璃几何和材质全城共用一份，每块只多一个 InstancedMesh，不 clone。
    const mesh = new THREE.InstancedMesh(structure, structureMaterial, chunk.length);
    mesh.name = `metro-entrance-structures:${key}`;
    const glassChunkMesh = new THREE.InstancedMesh(glass, glassMaterial, chunk.length);
    glassChunkMesh.name = `metro-entrance-glass:${key}`;
    const matrix = new THREE.Matrix4();
    chunk.forEach((entrance, index) => {
      matrix.compose(new THREE.Vector3(entrance.x, entrance.y, entrance.z),
        rotationOf(entrance.yaw), new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(index, matrix);
      glassChunkMesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    // 玻璃既不投影也不收影：透明面在阴影贴图里读不出效果，只会多一次阴影提交。
    glassChunkMesh.instanceMatrix.needsUpdate = true;
    glassChunkMesh.castShadow = false;
    glassChunkMesh.receiveShadow = false;
    glassChunkMesh.computeBoundingSphere();
    group.add(mesh, glassChunkMesh);
    structureMeshes.push(mesh);
    glassMeshes.push(glassChunkMesh);
  }

  const nearSigns = new THREE.Mesh(signs.near, nearSignMaterial);
  nearSigns.name = 'metro-entrance-signs-near';
  nearSigns.castShadow = false;
  const farSigns = new THREE.Mesh(signs.far, farSignMaterial);
  farSigns.name = 'metro-entrance-signs-far';
  farSigns.castShadow = false;
  group.add(nearSigns, farSigns);
  scene.add(group);

  const entranceColliders = placed.map(entrance => {
    const outer = [[-COLLIDER_HALF_X_M, -COLLIDER_HALF_Z_M], [COLLIDER_HALF_X_M, -COLLIDER_HALF_Z_M],
      [COLLIDER_HALF_X_M, COLLIDER_HALF_Z_M], [-COLLIDER_HALF_X_M, COLLIDER_HALF_Z_M]]
      .map(([lx, lz]) => rotatePoint(entrance.x, entrance.z, entrance.yaw, lx, lz));
    return {
      type: 'metro-entrance',
      name: entrance.id,
      sourceId: entrance.id,
      stationId: entrance.stationId,
      stationName: entrance.stationName,
      exitRef: entrance.ref,
      polygon: { outer, holes: [] },
      minX: Math.min(...outer.map(point => point.x)),
      maxX: Math.max(...outer.map(point => point.x)),
      minZ: Math.min(...outer.map(point => point.z)),
      maxZ: Math.max(...outer.map(point => point.z)),
      minY: entrance.y,
      maxY: entrance.y + 3.4,
      heightSource: 'estimate'
    };
  });
  const statistics = {
    ...baseStatistics,
    chunks: chunkMap.size,
    entrances: placed.map(entrance => ({
      id: entrance.id, x: entrance.x, z: entrance.z, y: entrance.y,
      stationId: entrance.stationId, stationName: entrance.stationName, ref: entrance.ref,
      lineRefs: entrance.lineRefs, colours: entrance.colours, facingSource: entrance.facingSource
    })),
    signAtlas: { stations: atlas.stationKeys.size, badges: atlas.letterKeys.size, width: atlas.width, height: atlas.height },
    drawCallsEstimate: chunkMap.size * 2 + 2,
    colliderCount: entranceColliders.length
  };
  return {
    group,
    colliders: entranceColliders,
    statistics,
    entrances: placed,
    update(cameraPositionValue) {
      if (!cameraPositionValue) return;
      let anyVisible = false;
      const limitSq = STRUCTURE_MAX_DISTANCE_M * STRUCTURE_MAX_DISTANCE_M;
      for (let i = 0; i < structureMeshes.length; i++) {
        // 玻璃块和同索引的结构块同一套距离判断，避免玻璃留在隐藏的结构块外面。
        const center = structureMeshes[i].boundingSphere.center;
        const dx = cameraPositionValue.x - center.x;
        const dz = cameraPositionValue.z - center.z;
        const visible = dx * dx + dz * dz < limitSq;
        structureMeshes[i].visible = visible;
        glassMeshes[i].visible = visible;
        if (visible) anyVisible = true;
      }
      nearSigns.visible = anyVisible;
      farSigns.visible = anyVisible;
    },
    dispose() {
      scene.remove(group);
      structure.dispose();
      glass.dispose();
      signs.near.dispose();
      signs.far.dispose();
      structureMaterial.dispose();
      glassMaterial.dispose();
      nearSignMaterial.dispose();
      farSignMaterial.dispose();
      atlas.texture.dispose();
    }
  };
}
