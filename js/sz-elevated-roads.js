import * as THREE from 'three/webgpu';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createGroundSurfaceSampler } from './sz-ground-surface.js';

// 立交桥面高程没有实测纵断面，按 layer 的估算层高派生，接触面与显示几何共用同一批三角面。
const LAYER_HEIGHT_M = 4.8;
const GIRDER_DEPTH_M = 0.35;
const DECK_STEP_M = 4;
const PIER_SPACING_M = 28;
const PIER_MIN_CLEARANCE_M = 2;
const MAX_CHUNKS = 12;
const EPSILON = 1e-8;

const DEFAULT_ELEVATED_AREA = Object.freeze({ minX: -3800, maxX: -2500, minZ: 500, maxZ: 1300 });

const LIMITATIONS = [
  '桥面高度按 OSM layer 每层 4.8 m 估算，没有实测纵断面或设计线形校正。',
  '匝道与地面道路共享节点处按地形高程落地，坡度为两端线性插值，不是测量坡度。',
  '仅补齐车公庙立交范围（默认 x -3800..-2500、z 500..1300），不代表全市其余桥隧。',
  '桥墩按约 28 m 间距估计布置，只在净空大于 2 m 时设墩，墩位与基础未做地勘核实。'
];

function normalizeArea(area) {
  if (!area || typeof area !== 'object') throw new Error('An elevated road area is required');
  const normalized = {
    minX: area.minX, maxX: area.maxX, minZ: area.minZ, maxZ: area.maxZ
  };
  if (!Object.values(normalized).every(Number.isFinite)
    || normalized.minX >= normalized.maxX || normalized.minZ >= normalized.maxZ) {
    throw new Error('Invalid elevated road area');
  }
  return normalized;
}

function validateGraph(graph) {
  if (!Array.isArray(graph?.nodes) || graph.nodes.length % 2 !== 0
    || !Array.isArray(graph?.links) || !Array.isArray(graph?.metadata)
    || graph.links.length !== graph.metadata.length || !Array.isArray(graph?.names)) {
    throw new Error('A source road graph with link metadata is required');
  }
}

function inArea(point, area) {
  return point.x >= area.minX && point.x <= area.maxX && point.z >= area.minZ && point.z <= area.maxZ;
}

// Liang-Barsky：只要线段穿过矩形就选中，避免长匝道两端都在范围外时被漏掉。
function segmentIntersectsArea(a, b, area) {
  if (inArea(a, area) || inArea(b, area)) return true;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let from = 0;
  let to = 1;
  const edges = [
    [-dx, a.x - area.minX], [dx, area.maxX - a.x],
    [-dz, a.z - area.minZ], [dz, area.maxZ - a.z]
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > to) return false;
      if (ratio > from) from = ratio;
    } else {
      if (ratio < from) return false;
      if (ratio < to) to = ratio;
    }
  }
  return from <= to;
}

function polylineIntersectsArea(points, area) {
  for (let i = 0; i < points.length; i++) {
    if (inArea(points[i], area)) return true;
    if (i > 0 && segmentIntersectsArea(points[i - 1], points[i], area)) return true;
  }
  return false;
}

function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return length;
}

// 规范化到「从字典序较小的一端走」，同一段路面无论 OSM 方向都只认一次。
function canonicalSignature(points) {
  const key = list => list.map(point => `${point.x.toFixed(4)},${point.z.toFixed(4)}`).join(';');
  const forward = key(points);
  const backward = key([...points].reverse());
  return forward < backward ? forward : backward;
}

function resample(points, maxStep) {
  if (points.length < 2) return [];
  const stations = [{ x: points[0].x, z: points[0].z, d: 0 }];
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < EPSILON) continue;
    const steps = Math.max(1, Math.ceil(length / maxStep));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const next = distance + length * t;
      stations.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: next });
    }
    distance += length;
  }
  return distance > EPSILON ? stations : [];
}

function stationFrames(stations, width) {
  const half = width / 2;
  return stations.map((station, index) => {
    const previous = stations[Math.max(0, index - 1)];
    const next = stations[Math.min(stations.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = dz / length;
    const nz = -dx / length;
    return {
      ...station,
      left: { x: station.x + nx * half, z: station.z + nz * half },
      right: { x: station.x - nx * half, z: station.z - nz * half },
      nx, nz
    };
  });
}

function triangleArea2D(a, b, c) {
  return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
}

function pushTriangle(target, a, b, c) {
  target.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function pushTopQuad(geometry, surface, a, b, c, d) {
  // 参数顺序为左前、右前、右后、左后；逆时针（x 东、z 南）让法线朝上。
  pushTriangle(geometry, a, b, c);
  pushTriangle(geometry, a, c, d);
  // 接触面按 controller-surfaces 的三点三角面数组保存，和渲染几何同源。
  surface.push([a, b, c], [a, c, d]);
}

// topA→topB 的左侧为外法线方向；底边高度按两端桥面坡度分别给出。
function pushVerticalWall(geometry, topA, topB, bottomA, bottomB) {
  const lowA = { x: topA.x, y: bottomA, z: topA.z };
  const lowB = { x: topB.x, y: bottomB, z: topB.z };
  pushTriangle(geometry, topA, lowB, lowA);
  pushTriangle(geometry, topA, topB, lowB);
}

function pushEndCap(geometry, leftTop, rightTop, bottomY, forward) {
  const lowLeft = { x: leftTop.x, y: bottomY, z: leftTop.z };
  const lowRight = { x: rightTop.x, y: bottomY, z: rightTop.z };
  if (forward) {
    pushTriangle(geometry, leftTop, lowRight, lowLeft);
    pushTriangle(geometry, leftTop, rightTop, lowRight);
  } else {
    pushTriangle(geometry, leftTop, lowLeft, lowRight);
    pushTriangle(geometry, leftTop, lowRight, rightTop);
  }
}

function pushPier(geometry, pier) {
  const { x, z, baseY, topY, half } = pier;
  const p0 = { x: x - half, z: z - half };
  const p1 = { x: x + half, z: z - half };
  const p2 = { x: x + half, z: z + half };
  const p3 = { x: x - half, z: z + half };
  for (const [a, b] of [[p0, p1], [p1, p2], [p2, p3], [p3, p0]]) {
    pushVerticalWall(geometry, { x: a.x, y: topY, z: a.z }, { x: b.x, y: topY, z: b.z }, baseY, baseY);
  }
}

function pierSpacing(record) {
  const stations = record.frames;
  const tiles = [];
  for (let distance = PIER_SPACING_M / 2; distance < record.lengthM - 1; distance += PIER_SPACING_M) {
    let index = 1;
    while (index < stations.length - 1 && stations[index].d < distance) index++;
    tiles.push(stations[index]);
  }
  return tiles;
}

function planLink(graph, link, index, metadata, groundHeight, groundNodes, area) {
  const points = roadLinkPoints(graph, link);
  if (points.length < 2 || !polylineIntersectsArea(points, area)) return null;
  const length = polylineLength(points);
  if (length <= EPSILON) return null;
  const [start, end] = [link[0], link[1]];
  const startGround = groundHeight(points[0].x, points[0].z);
  const endGround = groundHeight(points[points.length - 1].x, points[points.length - 1].z);
  if (!Number.isFinite(startGround) || !Number.isFinite(endGround)) return null;
  const layer = Number.isFinite(metadata.layer) ? metadata.layer : 0;
  const lift = LAYER_HEIGHT_M * Math.max(0, layer);
  const sharedStart = groundNodes.has(start);
  const sharedEnd = groundNodes.has(end);
  const startY = sharedStart ? startGround : startGround + lift;
  const endY = sharedEnd ? endGround : endGround + lift;
  const stations = resample(points, DECK_STEP_M);
  if (stations.length < 2) return null;
  const width = link[3];
  const frames = stationFrames(stations, width);
  const deckHeightAt = distance => startY + (endY - startY) * Math.min(1, distance / length);
  const half = Math.max(0.7, Math.min(1.4, width * 0.08));
  const geometry = [];
  const topTriangles = [];
  const pierRecords = [];
  let areaM2 = 0;
  let maxClearanceM = 0;

  for (const frame of frames) {
    // 端点之间按直线坡度插值；地形在 link 中部抬升时以地面为下限，避免桥面埋入地下。
    const linearY = deckHeightAt(frame.d);
    const centerGround = groundHeight(frame.x, frame.z);
    const edgeGrounds = [frame.left, frame.right]
      .map(point => groundHeight(point.x, point.z))
      .filter(Number.isFinite);
    const floor = Math.max(centerGround ?? -Infinity, ...edgeGrounds);
    frame.y = Math.max(linearY, Number.isFinite(floor) ? floor : linearY);
    if (Number.isFinite(centerGround)) maxClearanceM = Math.max(maxClearanceM, frame.y - centerGround);
  }
  // 端部各外延 4 m 平段，让相邻链路/地面路的接触面在节点处有重叠，避免车辆在
  // 链路交界因支撑高度跳变 >1.5 m 被判定“无支撑”而刹停（round 30/34 诊断）。
  const OVERLAP_M = 4;
  const overlapFrame = (frame, inner) => {
    const dx = frame.x - inner.x, dz = frame.z - inner.z;
    const length = Math.hypot(dx, dz) || 1;
    const x = frame.x + dx / length * OVERLAP_M, z = frame.z + dz / length * OVERLAP_M;
    return { ...frame, x, z, d: frame.d + OVERLAP_M,
      left: { x: x + frame.nx * half, z: z + frame.nz * half },
      right: { x: x - frame.nx * half, z: z - frame.nz * half } };
  };
  const surfaceFrames = [overlapFrame(frames[0], frames[1] ?? frames[0]), ...frames,
    overlapFrame(frames[frames.length - 1], frames[frames.length - 2] ?? frames[0])];
  for (let i = 1; i < surfaceFrames.length; i++) {
    const a = surfaceFrames[i - 1];
    const b = surfaceFrames[i];
    const topA = { x: a.left.x, y: a.y, z: a.left.z };
    const topB = { x: b.left.x, y: b.y, z: b.left.z };
    const topC = { x: b.right.x, y: b.y, z: b.right.z };
    const topD = { x: a.right.x, y: a.y, z: a.right.z };
    pushTopQuad(geometry, topTriangles, topA, topD, topC, topB);
    areaM2 += triangleArea2D(topA, topB, topC) + triangleArea2D(topA, topC, topD);
    pushVerticalWall(geometry, topA, topB, a.y - GIRDER_DEPTH_M, b.y - GIRDER_DEPTH_M);
    pushVerticalWall(geometry, topC, topD, b.y - GIRDER_DEPTH_M, a.y - GIRDER_DEPTH_M);
  }

  // 端部封口让桥面板在起点和终点读成实体，不把顶面悬空。
  const first = frames[0];
  const last = frames[frames.length - 1];
  const firstLeft = { x: first.left.x, y: first.y, z: first.left.z };
  const firstRight = { x: first.right.x, y: first.y, z: first.right.z };
  const lastLeft = { x: last.left.x, y: last.y, z: last.left.z };
  const lastRight = { x: last.right.x, y: last.y, z: last.right.z };
  pushEndCap(geometry, firstLeft, firstRight, first.y - GIRDER_DEPTH_M, false);
  pushEndCap(geometry, lastLeft, lastRight, last.y - GIRDER_DEPTH_M, true);

  for (const station of pierSpacing({ frames, lengthM: length })) {
    const terrainY = groundHeight(station.x, station.z);
    if (!Number.isFinite(terrainY)) continue;
    const clearance = station.y - terrainY;
    if (clearance <= PIER_MIN_CLEARANCE_M) continue;
    const topY = station.y - GIRDER_DEPTH_M;
    if (topY - terrainY <= 0.2) continue;
    const pier = { x: station.x, z: station.z, baseY: terrainY, topY, half };
    pierRecords.push(pier);
    pushPier(geometry, pier);
  }

  const osmId = metadata.osmId ?? null;
  return {
    index,
    osmId,
    name: graph.names[link[2]] ?? '',
    width,
    lanes: link[4],
    direction: link[5],
    bridge: metadata.bridge === true,
    tunnel: metadata.tunnel === true,
    layer,
    startNode: start,
    endNode: end,
    sharedStart,
    sharedEnd,
    startGroundHeight: startGround,
    endGroundHeight: endGround,
    startDeckY: frames[0].y,
    endDeckY: frames[frames.length - 1].y,
    lengthM: length,
    areaM2,
    maxClearanceM,
    points,
    frames,
    geometry,
    topTriangles,
    piers: pierRecords,
    surfaceId: `sz-elevated-road:${index}`
  };
}

function buildChunks(records) {
  if (records.length === 0) return [];
  const count = Math.min(MAX_CHUNKS, records.length);
  const ordered = [...records].sort((a, b) => {
    const ax = a.points[0].x + a.points[a.points.length - 1].x;
    const az = a.points[0].z + a.points[a.points.length - 1].z;
    const bx = b.points[0].x + b.points[b.points.length - 1].x;
    const bz = b.points[0].z + b.points[b.points.length - 1].z;
    return ax - bx || az - bz || a.index - b.index;
  });
  const buckets = Array.from({ length: count }, () => []);
  ordered.forEach((record, rank) => buckets[Math.min(count - 1, Math.floor(rank * count / ordered.length))].push(record));
  return buckets.filter(bucket => bucket.length > 0).map((bucket, chunkIndex) => {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const record of bucket) {
      for (const point of record.points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
    }
    const origin = [minX, minZ];
    const positions = [];
    for (const record of bucket) {
      for (let i = 0; i < record.geometry.length; i += 3) {
        positions.push(record.geometry[i] - origin[0], record.geometry[i + 1], record.geometry[i + 2] - origin[1]);
      }
    }
    return {
      id: `shenzhen-elevated-roads:${chunkIndex}`,
      origin,
      bounds: { minX, maxX, minZ, maxZ },
      positions: new Float32Array(positions),
      linkIndices: bucket.map(record => record.index).sort((a, b) => a - b),
      triangles: bucket.reduce((sum, record) => sum + record.geometry.length / 9, 0)
    };
  });
}


// 跨层连接坡道：相邻高架链路共享节点但 layer 估计不同（如 layer1=4.8 m、layer2=9.6 m）时，
// 桥面会出现 4.8 m 台阶，车辆爬不上去。这里在两条链路各退 ~18 m 处拉一条渐变坡道，坡度控制在 35% 内。
const CONNECTOR_RAMP_M = 18;
const CONNECTOR_MAX_GRADE = 0.35;
const CONNECTOR_SEGMENTS = 10;

function connectorBackFrame(record, end) {
  const frames = record.frames;
  if (frames.length < 4) return null;
  const step = record.lengthM / (frames.length - 1);
  const back = Math.max(1, Math.min(frames.length - 2, Math.round(CONNECTOR_RAMP_M / Math.max(step, 0.5))));
  const frame = end === 'start' ? frames[back] : frames[frames.length - 1 - back];
  return frame ? { frame, width: record.width } : null;
}

function makeConnectorRamp(node, serial, low, high, gradeOK) {
  const a = low.frame, b = high.frame;
  const width = Math.min(low.width, high.width) * 0.85;
  const half = width / 2;
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 6) || !Number.isFinite(length)) return null;
  const px = dz / length, pz = -dx / length;
  const frames = [];
  for (let i = 0; i <= CONNECTOR_SEGMENTS; i++) {
    const t = i / CONNECTOR_SEGMENTS;
    const x = a.x + dx * t, z = a.z + dz * t;
    const y = a.y + (b.y - a.y) * t;
    frames.push({ x, z, y, left: { x: x + px * half, z: z + pz * half }, right: { x: x - px * half, z: z - pz * half } });
  }
  const geometry = [];
  const topTriangles = [];
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1], q = frames[i];
    pushTopQuad(geometry, topTriangles,
      { x: p.left.x, y: p.y, z: p.left.z }, { x: p.right.x, y: p.y, z: p.right.z },
      { x: q.right.x, y: q.y, z: q.right.z }, { x: q.left.x, y: q.y, z: q.left.z });
  }
  const areaM2 = length * width;
  return {
    index: 100000 + serial,
    osmId: null,
    name: `connector:${node}`,
    width,
    lanes: 1,
    direction: 0,
    bridge: true,
    tunnel: false,
    layer: Math.max(low.layer ?? 0, high.layer ?? 0),
    startNode: node,
    endNode: node,
    sharedStart: false,
    sharedEnd: false,
    startGroundHeight: null,
    endGroundHeight: null,
    startDeckY: a.y,
    endDeckY: b.y,
    lengthM: length,
    areaM2,
    maxClearanceM: 0,
    points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
    frames,
    geometry,
    topTriangles,
    piers: [],
    surfaceId: `sz-elevated-ramp:${node}`,
    grade: gradeOK,
    connector: true
  };
}

function planConnectorRamps(records) {
  const byNode = new Map();
  for (const record of records) {
    for (const [end, node] of [['start', record.startNode], ['end', record.endNode]]) {
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node).push({ record, end, y: end === 'start' ? record.startDeckY : record.endDeckY });
    }
  }
  const ramps = [];
  for (const [node, entries] of [...byNode.entries()].sort((a, b) => a[0] - b[0])) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.y - b.y);
    for (let i = 1; i < entries.length; i++) {
      const low = entries[i - 1], high = entries[i];
      const rise = high.y - low.y;
      if (rise < 0.6) continue;
      const lowFrame = connectorBackFrame(low.record, low.end);
      const highFrame = connectorBackFrame(high.record, high.end);
      if (!lowFrame || !highFrame) continue;
      const lowX = lowFrame.frame.x, lowY = lowFrame.frame.y;
      const highX = highFrame.frame.x, highY = highFrame.frame.y;
      const run = Math.hypot(highX - lowX, highFrame.frame.z - lowFrame.frame.z);
      const gradeOK = run > 0 && rise / run <= CONNECTOR_MAX_GRADE;
      const ramp = makeConnectorRamp(node, ramps.length, lowFrame, highFrame, gradeOK);
      if (ramp) ramps.push(ramp);
    }
  }
  return ramps;
}

export function planElevatedRoads(graph, terrainSurface, area = DEFAULT_ELEVATED_AREA) {
  validateGraph(graph);
  const bounds = normalizeArea(area);
  const groundHeight = createGroundSurfaceSampler(terrainSurface);
  const groundNodes = new Set();
  const groundSignatures = new Set();

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, graph.links[index]);
    groundSignatures.add(canonicalSignature(points));
    groundNodes.add(graph.links[index][0]);
    groundNodes.add(graph.links[index][1]);
  }

  const records = [];
  let groundDuplicates = 0;
  let skippedLinks = 0;
  for (let index = 0; index < graph.links.length; index++) {
    const link = graph.links[index];
    const metadata = graph.metadata[index];
    if (!metadata || (metadata.bridge !== true && !(Math.abs(metadata.layer ?? 0) > 0))) continue;
    if (isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, link);
    if (!polylineIntersectsArea(points, bounds)) continue;
    if (groundSignatures.has(canonicalSignature(points))) {
      groundDuplicates++;
      continue;
    }
    const record = planLink(graph, link, index, metadata, groundHeight, groundNodes, bounds);
    if (record === null) skippedLinks++;
    else records.push(record);
  }

  const connectors = planConnectorRamps(records);
  const surfaces = [...records, ...connectors].map(record => ({
    id: record.surfaceId,
    heightSource: 'estimate',
    triangles: record.topTriangles
  }));
  const chunks = buildChunks([...records, ...connectors]);
  const statistics = {
    links: records.length,
    connectors: connectors.length,
    connectorLengthM: connectors.reduce((sum, record) => sum + record.lengthM, 0),
    deckLengthM: records.reduce((sum, record) => sum + record.lengthM, 0),
    areaM2: records.reduce((sum, record) => sum + record.areaM2, 0) + connectors.reduce((sum, record) => sum + record.areaM2, 0),
    surfaces: surfaces.length,
    triangles: [...records, ...connectors].reduce((sum, record) => sum + record.geometry.length / 9, 0),
    piers: records.reduce((sum, record) => sum + record.piers.length, 0),
    maxDeckHeightM: records.reduce((max, record) => Math.max(max, record.maxClearanceM), 0),
    heightSource: 'estimate',
    groundDuplicates,
    skippedLinks,
    limitations: [...LIMITATIONS]
  };

  return { version: 1, heightSource: 'estimate', area: bounds, links: records, surfaces, chunks, statistics };
}

export function buildSzElevatedRoads(scene, { graph, terrainSurface, area } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('A THREE scene is required');
  const plan = planElevatedRoads(graph, terrainSurface, area);
  const group = new THREE.Group();
  group.name = 'shenzhen-elevated-roads';
  // 没有纹理，沥青观感只靠颜色和粗糙度；polygonOffset 只处理与地面共面处的绘制顺序。
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0x303436,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const meshes = [];
  for (const chunk of plan.chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.name = chunk.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.elevatedRoads = chunk.linkIndices;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return {
    group,
    meshes,
    surfaces: plan.surfaces,
    statistics: plan.statistics,
    links: plan.links,
    update() {},
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      material.dispose();
    }
  };
}
