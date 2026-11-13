import * as THREE from 'three/webgpu';
import { roadLinkPoints } from './sz-roads.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';

const STATION_SIZE = 8;
const FORK_LEAD_M = 2;
const CHUNK_M = 240;
const PALETTE = { asphalt: 0x34393b, concrete: 0xb3bbb8, lining: 0x686d70, light: 0xf4f8ff };

// 在桥端把两条地面车行幅对齐到桥的左右半幅，再沿各自源线展开。
function groundForkSection(graph, index, frame, axis, side, blendM, routeId) {
  const link = graph.links[index];
  const points = roadLinkPoints(graph, link);
  const width = link[3], half = width / 2;
  const stations = [0, FORK_LEAD_M];
  for (let d = 6; d < blendM; d += 4) stations.push(d);
  stations.push(blendM);
  let walked = 0, station = 0;
  const samples = [];
  const append = (x, z) => {
    if (x !== samples.at(-3) || z !== samples.at(-2)) samples.push(x, z, half);
  };
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const end = walked + length;
    const blendAt = d => {
      const t = (d - walked) / length;
      const mix = Math.max(0, (d - FORK_LEAD_M) / (blendM - FORK_LEAD_M));
      const weight = mix * mix * (3 - 2 * mix);
      const x = frame.x + d * axis.x + side * half * axis.z;
      const z = frame.z + d * axis.z - side * half * axis.x;
      append(x + weight * (a.x + t * (b.x - a.x) - x), z + weight * (a.z + t * (b.z - a.z) - z));
    };
    while (station < stations.length && stations[station] <= end) blendAt(stations[station++]);
    if (end > blendM) append(b.x, b.z);
    else if (end > FORK_LEAD_M && end < blendM) blendAt(end);
    walked = end;
  }
  return { id: routeId, laneWidthM: width / link[4], outerShoulderM: 0, laneCountSource: 'osm-lanes', points: samples };
}

export function graphWithRoadStructures(graph, plan) {
  if (!plan?.records.length) return graph;
  const approaches = new Set(plan.records.map(record => record.index));
  const forks = new Map();
  for (const route of plan.routes) {
    if (!route.groundFork) continue;
    const { leftWay, rightWay, blendM } = route.groundFork;
    const deck = plan.records.find(record => record.route === route.id && record.sharedEnd);
    const end = graph.links[deck.index][1];
    const frames = readFrames(deck.stations);
    const frame = frames.at(-1), prev = frames.at(-2);
    const length = Math.hypot(frame.x - prev.x, frame.z - prev.z);
    const axis = { x: (frame.x - prev.x) / length, z: (frame.z - prev.z) / length };
    for (const [way, side] of [[leftWay, 1], [rightWay, -1]]) {
      const i = graph.metadata.findIndex((meta, i) => meta.osmId === way && graph.links[i][0] === end);
      forks.set(i, groundForkSection(graph, i, frame, axis, side, blendM, route.id));
    }
  }
  return { ...graph, metadata: graph.metadata.map((meta, i) => forks.has(i) ? { ...meta, crossSection: forks.get(i) }
    : approaches.has(i) && meta.heightSource === 'terrain' ? { ...meta, heightSource: 'structure-approach' } : meta) };
}

function readFrames(stations) {
  const frames = [];
  for (let i = 0; i < stations.length; i += STATION_SIZE) {
    const [d, x, y, z, lx, lz, rx, rz] = stations.slice(i, i + STATION_SIZE);
    frames.push({ d, x, y, z, left: { x: lx, y, z: lz }, right: { x: rx, y, z: rz } });
  }
  return frames;
}

function matchGroundEdge(graph, frame, node, approach) {
  const link = graph.links[approach];
  if (!link) return;
  const points = roadLinkPoints(graph, link);
  const atStart = link[0] === node;
  const [a, b] = atStart ? points.slice(0, 2) : points.slice(-2);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length <= 1e-6) return;
  let nx = (b.z - a.z) / length * link[3] / 2, nz = (a.x - b.x) / length * link[3] / 2;
  if ((frame.left.x - frame.x) * nx + (frame.left.z - frame.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  // 地面源边与纵断面源边在同一节点收口，消除站距舍入产生的亚毫米缝隙。
  const center = atStart ? a : b;
  frame.x = center.x;
  frame.z = center.z;
  frame.left = { x: frame.x + nx, y: frame.y, z: frame.z + nz };
  frame.right = { x: frame.x - nx, y: frame.y, z: frame.z - nz };
}

function offset(p, y) {
  return { x: p.x, y: p.y + y, z: p.z };
}

function between(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function inset(edge, across, distance) {
  return between(edge, across, distance / Math.hypot(across.x - edge.x, across.z - edge.z));
}

function quad([a, b, c, d]) {
  return [[a, b, c], [a, c, d]];
}

function collider(type, name, outer, bottom, top) {
  return { type, name, minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
    minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
    minY: Math.min(...bottom), maxY: Math.max(...top),
    polygon: { outer, holes: [] }, roofPanel: { outer, bottom, top } };
}

function solid(draw, colliders, type, name, footprint, lower, upper, roadAccess = false, drawTop = true) {
  // 顶、底及侧壁按同一对角线拆分，实体碰撞体直接引用显示平面。
  const top = footprint.map((point, i) => offset(point, upper[i]));
  const bottom = footprint.map((point, i) => offset(point, lower[i]));
  if (drawTop) draw.push(...quad(top));
  draw.push(...quad(bottom).map(triangle => triangle.reverse()));
  for (let i = 0; i < footprint.length; i++) {
    const next = (i + 1) % footprint.length;
    draw.push(...quad([bottom[i], bottom[next], top[next], top[i]]));
  }
  for (const indices of [[0, 1, 2], [0, 2, 3]]) {
    colliders.push({ ...collider(type, name, indices.map(i => footprint[i]),
      indices.map(i => bottom[i].y), indices.map(i => top[i].y)), roadAccess });
  }
}

function makeMesh(triangles, material, name) {
  if (triangles.length === 0) return null;
  const positions = new Float32Array(triangles.length * 9);
  let i = 0;
  for (const triangle of triangles) for (const p of triangle) {
    positions[i++] = p.x;
    positions[i++] = p.y;
    positions[i++] = p.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = name !== 'light';
  mesh.receiveShadow = name !== 'light';
  return mesh;
}

function frameAt(frames, d) {
  let i = 1;
  while (i < frames.length - 1 && frames[i].d < d) i++;
  const a = frames[i - 1], b = frames[i];
  const t = (d - a.d) / (b.d - a.d);
  return { ...between(a, b, t), d, left: between(a.left, b.left, t), right: between(a.right, b.right, t) };
}

function buildRoadCover(cover, span, frames, batch, colliders, camera) {
  const { startM, endM } = span;
  const [start, end] = [frameAt(frames, startM), frameAt(frames, endM)];
  const sections = [start, ...frames.filter(f => f.d > startM && f.d < endM), end];
  const y = cover.clearanceM;
  const id = cover.osmId;
  const extend = (p, q) => inset(p, q, -0.04);
  const section = (a, b) => [extend(a.left, a.right), extend(a.right, a.left),
    extend(b.right, b.left), extend(b.left, b.right)];
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i];
    const footprint = section(a, b);
    solid(batch.cover, colliders, 'road-cover-roof', id, footprint, Array(4).fill(y + 0.32), Array(4).fill(y + 0.32 + cover.roofM));
    camera.roofTriangles.push(...quad(footprint.map(p => offset(p, y))));
    for (const [side, other] of [['left', 'right'], ['right', 'left']]) {
      const wall = [extend(a[side], a[other]), extend(b[side], b[other]),
        inset(b[side], b[other], cover.wallM), inset(a[side], a[other], cover.wallM)];
      solid(batch.coverSide, colliders, 'road-cover-side', id, wall, Array(4).fill(0.90), Array(4).fill(y + 0.32));
    }
  }
  for (let d = startM + 0.25; d + 0.24 < endM; d += cover.beamSpacingM) {
    const a = frameAt(frames, d), b = frameAt(frames, d + 0.24);
    solid(batch.coverSteel, colliders, 'road-cover-beam', id, section(a, b), Array(4).fill(y), Array(4).fill(y + 0.32));
    for (const [side, other] of [['left', 'right'], ['right', 'left']]) {
      const column = [extend(a[side], a[other]), extend(b[side], b[other]),
        inset(b[side], b[other], 0.23), inset(a[side], a[other], 0.23)];
      solid(batch.coverSteel, colliders, 'road-cover-column', id, column, [0, 0, 0, 0], Array(4).fill(y));
    }
  }
}

export function buildSzRoadStructures(scene, graph, plan, { groundHeight, pierAllowed = () => false, overWater = () => false } = {}) {
  const group = new THREE.Group();
  group.name = 'shenzhen-reviewed-road-structures';
  const links = [], surfaces = [], colliders = [];
  const tunnelRoutes = new Map();
  if (!plan?.records.length) return { group, links, surfaces, colliders, heightAt: () => null, constrainCamera() {}, dispose() {} };
  const playerDecks = new Set(plan.routes?.filter(route => route.playerDeckAccess).map(route => route.id));
  const waterBases = new Map(plan.routes.filter(route => Number.isFinite(route.waterPierBaseM))
    .map(route => [route.id, route.waterPierBaseM]));
  const widthEstimates = new Map(plan.routes.map(route => [route.id, route.widthEstimates]));
  const groundForks = new Map(plan.routes.filter(route => route.groundFork)
    .map(route => [route.id, { [route.groundFork.leftWay]: 1, [route.groundFork.rightWay]: -1 }]));
  const materials = {
    asphalt: new THREE.MeshStandardNodeMaterial({ color: PALETTE.asphalt, roughness: 0.94, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    concrete: new THREE.MeshStandardNodeMaterial({ color: PALETTE.concrete, roughness: 0.9, side: THREE.DoubleSide }),
    lining: new THREE.MeshStandardNodeMaterial({ color: PALETTE.lining, roughness: 0.9, side: THREE.DoubleSide,
      emissive: 0x292e35, emissiveIntensity: 0.58 }),
    boreAsphalt: new THREE.MeshStandardNodeMaterial({ color: 0x26292e, roughness: 0.94,
      side: THREE.DoubleSide, emissive: 0x535864, emissiveIntensity: 0.65 }),
    boreLining: new THREE.MeshStandardNodeMaterial({ color: 0x676d70, roughness: 0.9,
      side: THREE.DoubleSide, emissive: 0x646c72, emissiveIntensity: 0.62 }),
    guide: new THREE.MeshBasicNodeMaterial({ color: 0xc4e8d6, side: THREE.DoubleSide }),
    cover: new THREE.MeshStandardNodeMaterial({ color: 0xe2e4df, roughness: 0.78, side: THREE.DoubleSide }),
    coverSide: new THREE.MeshStandardNodeMaterial({ color: 0x819396, roughness: 0.68, side: THREE.DoubleSide }),
    coverSteel: new THREE.MeshStandardNodeMaterial({ color: 0xabb4b1, roughness: 0.65, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicNodeMaterial({ color: PALETTE.light, side: THREE.DoubleSide })
  };
  const groundAt = new Map();
  const endpointNodes = new Set(plan.records.flatMap(row => {
    const link = graph.links[row.index];
    return [row.sharedStart ? link[0] : null, row.sharedEnd ? link[1] : null].filter(node => node !== null);
  }));
  for (let index = 0; index < graph.links.length; index++) {
    const [a, b] = graph.links[index];
    if (graph.metadata[index].heightSource !== 'terrain') continue;
    for (const node of [a, b]) {
      if (!endpointNodes.has(node)) continue;
      const edges = groundAt.get(node) ?? [];
      edges.push(index);
      groundAt.set(node, edges);
    }
  }
  const framesByIndex = new Map(plan.records.map(record => [record.index, readFrames(record.stations)]));
  const routeRecords = new Map();
  for (const record of plan.records) {
    const records = routeRecords.get(record.route) ?? [];
    records.push(record);
    routeRecords.set(record.route, records);
  }
  const routeAccess = new Map();
  if (groundHeight) for (const records of routeRecords.values()) {
    const start = records[0], end = records.at(-1);
    // 与地面共面的接段可能跨越多条源边，接地权限延伸到第一个竖曲线。
    for (const fromEnd of [false, true]) {
      if (fromEnd ? !end.sharedEnd : !start.sharedStart) continue;
      const ordered = fromEnd ? [...records].reverse() : records;
      const frames = ordered.flatMap(record => {
        const source = framesByIndex.get(record.index);
        return (fromEnd ? [...source].reverse() : source).map(frame => [frame, record.stationOffsetM + frame.d]);
      });
      const breakAt = frames.find(([p]) => {
        const ground = groundHeight(p.x, p.z);
        return !Number.isFinite(ground) || Math.abs(p.y - ground) > 0.08;
      });
      const access = routeAccess.get(start.route) ?? {};
      access[fromEnd ? 'end' : 'start'] = breakAt ? breakAt[1] + (fromEnd ? -5 : 5) : frames.at(-1)[1];
      routeAccess.set(start.route, access);
    }
  }
  for (let i = 1; i < plan.records.length; i++) {
    const a = plan.records[i - 1], b = plan.records[i];
    if (a.route !== b.route) continue;
    const before = framesByIndex.get(a.index).at(-1), after = framesByIndex.get(b.index)[0];
    // 同一源节点两侧合用一条截面边，弯坡在共同边的两端同时对齐。
    const left = between(before.left, after.left, 0.5), right = between(before.right, after.right, 0.5);
    before.left = after.left = left;
    before.right = after.right = right;
  }
  const neighbors = new Map();
  for (const { ramp, incoming, outgoing } of plan.connections ?? []) {
    neighbors.set(ramp, [incoming, outgoing]);
    for (const index of [incoming, outgoing]) {
      neighbors.set(index, [...(neighbors.get(index) ?? []), ramp]);
    }
    const fromDeck = graph.links[ramp][0] === graph.links[outgoing][0];
    const frames = framesByIndex.get(ramp);
    const deck = framesByIndex.get(outgoing)[0];
    const width = Math.hypot(deck.left.x - deck.x, deck.left.z - deck.z);
    // 匝道端截面沿桥头同一条横线收口，近端渐变，保留车轮跨缝时的支撑。
    for (const frame of frames) {
      const distance = fromDeck ? frame.d : frames.at(-1).d - frame.d;
      const t = Math.max(0, 1 - distance / 12);
      if (!t) continue;
      const half = Math.hypot(frame.left.x - frame.x, frame.left.z - frame.z);
      for (const side of ['left', 'right']) {
        const target = { x: frame.x + (deck[side].x - deck.x) * half / width,
          z: frame.z + (deck[side].z - deck.z) * half / width, y: frame.y };
        frame[side] = between(frame[side], target, t * t * (3 - 2 * t));
      }
    }
  }
  const mergeHeight = createSurfaceHeightAt([...neighbors.keys()].map(index => {
    const frames = framesByIndex.get(index);
    return { id: String(index), triangles: frames.slice(1).flatMap((b, i) => {
      const a = frames[i];
      return quad([a.left, a.right, b.right, b.left]);
    }) };
  }));
  const partsByRoute = new Map();
  const batches = new Map();
  const coversByIndex = new Map();
  const litBores = new Set(plan.routes.filter(route => route.tunnelLighting === 'continuous').map(route => route.id));
  for (const cover of plan.roadCovers ?? []) for (const span of cover.spans) {
    const parts = coversByIndex.get(span.index) ?? [];
    parts.push({ cover, span });
    coversByIndex.set(span.index, parts);
  }
  for (const record of plan.records) {
    const { index, route, widthM, lanes, kind, sharedStart, sharedEnd, stationOffsetM, coverM, openApronM } = record;
    const link = graph.links[index];
    const frames = framesByIndex.get(index);
    const [first, last] = [frames[0], frames.at(-1)];
    for (const [frame, node, shared, incoming] of [[first, link[0], sharedStart, true], [last, link[1], sharedEnd, false]]) {
      if (!shared || kind === 'ramp') continue;
      const tangent = incoming ? frames[1] : frames.at(-2);
      const dx = tangent.x - frame.x, dz = tangent.z - frame.z;
      const adjacent = (groundAt.get(node) ?? []).flatMap(i => {
        const ground = graph.links[i];
        if (ground[5] !== 0 && ground[Number((ground[5] === 1) === incoming)] !== node) return [];
        const points = roadLinkPoints(graph, ground);
        const inner = ground[0] === node ? points[1] : points.at(-2);
        const ux = inner.x - frame.x, uz = inner.z - frame.z;
        const dot = (dx * ux + dz * uz) / (Math.hypot(dx, dz) * Math.hypot(ux, uz));
        return [{ i, dot }];
      }).sort((a, b) => a.dot - b.dot);
      const match = adjacent[0];
      if (match?.dot < -0.8 && !graph.metadata[match.i].crossSection) matchGroundEdge(graph, frame, node, match.i);
    }
    const id = `sz-road-structure:${index}`;
    const tunnel = kind === 'tunnel';
    const litBore = tunnel && litBores.has(route);
    const roadCovers = coversByIndex.get(index) ?? [];
    const approach = kind === 'approach';
    const ramp = kind === 'ramp';
    const sideAllowance = tunnel ? 0.6 : 0.35;
    // 长平接段可能远在坡脚之前就进入计划。接地权限沿共面段延续至刚开始抬升的位置。
    const accessEnd = (fromEnd) => {
      if ((!approach && !ramp) || !groundHeight) return 13;
      const ordered = fromEnd ? [...frames].reverse() : frames;
      const gradeBreak = ordered.find(p => Math.abs(p.y - groundHeight(p.x, p.z)) > 0.08);
      return gradeBreak ? Math.abs(gradeBreak.d - ordered[0].d) + 5 : last.d;
    };
    const startAccessM = sharedStart ? accessEnd(false) : 0;
    const endAccessM = sharedEnd ? accessEnd(true) : 0;
    const access = routeAccess.get(route);

    const topTriangles = [];
    const roofTriangles = [];
    const cameraTriangles = [];
    const accessTriangles = [];
    const exposedTriangles = [];
    const openings = new Map();
    let nextLight = Math.ceil(stationOffsetM / 18) * 18 - stationOffsetM;
    let nextPier = Math.ceil(stationOffsetM / 42) * 42 + 21 - stationOffsetM;

    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      const chunkId = `${route}:${Math.floor((stationOffsetM + a.d) / CHUNK_M)}`;
      let batch = batches.get(chunkId);
      if (!batch) batches.set(chunkId, batch = { asphalt: [], concrete: [], lining: [], light: [], boreAsphalt: [], boreLining: [], guide: [] });
      const footprint = [a.left, a.right, b.right, b.left];
      const floor = quad([a.left, a.right, b.right, b.left]);
      topTriangles.push(...floor);
      const covered = tunnel && a.d >= coverM[0] - 1e-5 && b.d <= coverM[1] + 1e-5;
      if (tunnel && !covered) exposedTriangles.push(...floor);
      (covered && litBore ? batch.boreAsphalt : batch.asphalt).push(...floor);
      const entry = sharedStart && a.d < startAccessM;
      const exit = sharedEnd && b.d > last.d - endAccessM;
      if (entry || exit || stationOffsetM + a.d < access?.start || stationOffsetM + b.d > access?.end) accessTriangles.push(...floor);
      const opensToNeighbor = (side, opposite, insetM) => (neighbors.get(index) ?? []).some(other =>
        [0, 0.5, 1].some(t => {
          const edge = between(a[side], b[side], t);
          const inside = between(a[opposite], b[opposite], t);
          const point = inset(edge, inside, insetM);
          const height = mergeHeight(point.x, point.z, String(other));
          return height !== null && Math.abs(height - point.y) <= 0.25;
        }));

      if (tunnel || roadCovers.length) {
        const cameraInset = plan.tunnelWallM + 0.55;
        cameraTriangles.push(...quad([inset(a.left, a.right, cameraInset), inset(a.right, a.left, cameraInset),
          inset(b.right, b.left, cameraInset), inset(b.left, b.right, cameraInset)]));
      }
      if (tunnel) {
        const lining = covered && litBore ? batch.boreLining : batch.lining;
        const trench = (!sharedStart || b.d > openApronM + 1e-5) && (!sharedEnd || a.d < last.d - openApronM - 1e-5);
        const clearance = plan.tunnelClearanceM;
        if (covered) {
          solid(lining, colliders, 'tunnel-roof', id, footprint, Array(4).fill(clearance),
            Array(4).fill(clearance + plan.tunnelRoofM));
          roofTriangles.push(...floor.map(triangle => triangle.map(p => offset(p, clearance))));
        }
        if (covered || trench) {
          for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
            if (!covered && opensToNeighbor(side, opposite, plan.tunnelWallM)) continue;
            const wall = [a[side], b[side], inset(b[side], b[opposite], plan.tunnelWallM), inset(a[side], a[opposite], plan.tunnelWallM)];
            const height = p => covered ? clearance + plan.tunnelRoofM : Math.max(0, (groundHeight?.(p.x, p.z) ?? p.y) - p.y);
            const ha = height(a[side]), hb = height(b[side]);
            if (Math.max(ha, hb) > 0.02) solid(lining, colliders, 'tunnel-wall', id, wall, [0, 0, 0, 0], [ha, hb, hb, ha]);
          }
        }
        while (nextLight < b.d) {
          if (covered && nextLight >= a.d && nextLight + 0.75 <= coverM[1]) {
            const section = d => {
              const t = (d - a.d) / (b.d - a.d);
              const left = between(a.left, b.left, t), right = between(a.right, b.right, t);
              return [between(left, right, 0.39), between(left, right, 0.61)];
            };
            const [la, ra] = section(nextLight);
            // 灯具短于站距，跨站时用下一站的实际断面。
            const end = Math.min(nextLight + 0.75, b.d);
            const [lb, rb] = section(end);
            const lower = clearance - plan.tunnelLightDepthM;
            solid(batch.light, colliders, 'tunnel-light', id, [la, lb, rb, ra], Array(4).fill(lower), Array(4).fill(clearance));
            if (litBore) {
              // 低位反光诱导标贴内壁，入口和弯道保持同一套道路里程。
              for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
                const edge = inset(a[side], a[opposite], plan.tunnelWallM + 0.015);
                const far = inset(b[side], b[opposite], plan.tunnelWallM + 0.015);
                const p = between(edge, far, (nextLight - a.d) / (b.d - a.d));
                const q = between(edge, far, (end - a.d) / (b.d - a.d));
                batch.guide.push(...quad([offset(p, 0.48), offset(q, 0.48), offset(q, 0.61), offset(p, 0.61)]));
              }
            }
          }
          nextLight += 18;
        }
      } else if (approach) {
        const soil = footprint.map(p => (groundHeight?.(p.x, p.z) ?? p.y) - p.y);
        if (soil.some(y => y < -0.04)) {
          solid(batch.concrete, colliders, 'bridge-slab', id, footprint, soil.map(y => Math.min(0, y)), [0, 0, 0, 0], entry || exit, false);
        }
      } else {
        solid(batch.concrete, colliders, 'bridge-slab', id, footprint, Array(4).fill(-plan.bridgeSlabM), [0, 0, 0, 0], entry || exit, false);
        if (nextPier < b.d) {
          const center = between(a, b, (nextPier - a.d) / (b.d - a.d));
          const waterBase = waterBases.get(route);
          const radius = 1.2;
          const inWater = waterBase !== undefined && overWater(center.x, center.z, radius);
          const baseY = inWater ? waterBase : groundHeight?.(center.x, center.z);
          const rise = center.y - plan.bridgeSlabM - baseY;
          if (rise > 2 && pierAllowed(center.x, center.z, radius, inWater)) {
            const pier = [[-1.2, -1], [1.2, -1], [1.2, 1], [-1.2, 1]]
              .map(([x, z]) => ({ x: center.x + x, y: baseY, z: center.z + z }));
            solid(batch.concrete, colliders, 'elevated-pier', id, pier, [0, 0, 0, 0], Array(4).fill(rise));
          }
          nextPier += 42;
        }
      }
      if (!tunnel && (kind === 'bridge' || ramp || neighbors.has(index)) && !entry && !exit) {
        for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
          // 只在已登记相邻路面的同高重叠处开放侧边。投影相交的下层道路不会改变栏杆。
          const open = opensToNeighbor(side, opposite, 0.18);
          if (open) {
            const sides = openings.get(i - 1) ?? new Set();
            sides.add(side);
            openings.set(i - 1, sides);
          } else if (!approach) {
            solid(batch.concrete, colliders, 'elevated-barrier', id,
              [a[side], b[side], inset(b[side], b[opposite], sideAllowance), inset(a[side], a[opposite], sideAllowance)],
              [0, 0, 0, 0], Array(4).fill(0.95));
          }
        }
      }
      const withinGroundApron = (sharedStart && a.d < openApronM - 1e-5)
        || (sharedEnd && b.d > last.d - openApronM + 1e-5);
      if (!tunnel && groundHeight && !withinGroundApron) {
        for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
          if (opensToNeighbor(side, opposite, 0.25)) continue;
          const wall = [a[side], b[side], inset(b[side], b[opposite], 0.25), inset(a[side], a[opposite], 0.25)];
          const height = wall.map(p => Math.max(0, groundHeight(p.x, p.z) - p.y));
          if (Math.max(...height) > 0.06) solid(batch.concrete, colliders, 'road-cut-wall', id, wall, [0, 0, 0, 0], height);
        }
      }
    }
    const flightRoadDeck = kind === 'bridge' && playerDecks.has(route);
    const surface = { id, heightSource: 'estimate', triangles: topTriangles, accessTriangles,
      modes: flightRoadDeck ? ['car', 'person', 'helicopter'] : ['car'], flightRoadDeck,
      driveSuccessors: [], structured: true };
    const road = { index, osmId: record.way, name: graph.names[link[2]], direction: link[5], layer: record.layer ?? (tunnel ? -1 : 1),
      width: widthM, lanes, laneSource: widthEstimates.get(route)?.[record.way] && lanes !== link[4] ? 'reviewed-estimate'
        : lanes && !link[4] ? 'municipal-design' : undefined,
      groundFork: sharedEnd ? groundForks.get(route) : undefined,
      barrierWidthM: sideAllowance, frames, points: roadLinkPoints(graph, link),
      topTriangles, surfaceId: id, startNode: link[0], endNode: link[1], sharedStart, sharedEnd,
      startDeckY: first.y, endDeckY: last.y, tunnel, structured: true,
      stationOffsetM, lengthM: last.d, maxGrade: record.maxGrade, ramp, openings, exposedTriangles };
    surfaces.push(surface);
    links.push(road);
    const parts = partsByRoute.get(route) ?? [];
    parts.push({ road, surface });
    partsByRoute.set(route, parts);
    if (tunnel || roadCovers.length) {
      const camera = { route, roofTriangles, cameraTriangles, tunnel };
      tunnelRoutes.set(id, camera);
      for (const { cover, span } of roadCovers) {
        const batch = { cover: [], coverSide: [], coverSteel: [] };
        buildRoadCover(cover, span, frames, batch, colliders, camera);
        batches.set(`${cover.osmId}:${index}:${span.startM}`, batch);
      }
    }
  }
  for (const parts of partsByRoute.values()) for (let i = 0; i < parts.length; i++) {
    const { surface, road } = parts[i];
    surface.driveSuccessors = [parts[i - 1]?.surface.id, parts[i + 1]?.surface.id].filter(Boolean);
    surface.driveSuccessors.push(...(neighbors.get(road.index) ?? []).map(index => `sz-road-structure:${index}`));
    if (road.sharedStart || road.sharedEnd) surface.driveSuccessors.push('terrain');
    road.structureNeighbors = surface.driveSuccessors;
  }
  for (const [id, batch] of batches) {
    const route = new THREE.Group();
    route.name = id;
    for (const [name, triangles] of Object.entries(batch)) {
      const mesh = makeMesh(triangles, materials[name], name);
      if (mesh) route.add(mesh);
    }
    group.add(route);
  }
  scene.add(group);
  const heightAt = createSurfaceHeightAt(surfaces);
  const cameraFloorAt = createSurfaceHeightAt([...tunnelRoutes].map(([id, data]) => ({ id, triangles: data.cameraTriangles })));
  const roofAt = createSurfaceHeightAt([...tunnelRoutes].map(([id, data]) => ({ id, triangles: data.roofTriangles })));

  function constrainCamera(entity, position, look) {
    const id = entity._support?.surfaceId;
    const tunnel = tunnelRoutes.get(id);
    if (!tunnel) return;
    const adjacent = links.find(link => link.surfaceId === id)?.structureNeighbors ?? [];
    const candidates = [id, ...adjacent.filter(next => tunnelRoutes.has(next))];
    const eye = { x: entity.position.x, y: entity.position.y + 1.52, z: entity.position.z };
    if (!tunnel.tunnel && !candidates.some(candidate => roofAt(eye.x, eye.z, candidate) !== null
        || roofAt(position.x, position.z, candidate) !== null)) return;
    const safe = point => candidates.some(candidate => {
      const floor = cameraFloorAt(point.x, point.z, candidate);
      const roof = roofAt(point.x, point.z, candidate);
      return floor !== null && point.y > floor + 0.35 && (roof === null || point.y < roof - 0.65);
    });
    const steps = Math.min(80, Math.max(1, Math.ceil(Math.hypot(position.x - eye.x, position.y - eye.y, position.z - eye.z) / 0.25)));
    let accepted = eye;
    for (let i = 1; i <= steps; i++) {
      const sample = between(eye, position, i / steps);
      if (!safe(sample)) break;
      accepted = sample;
    }
    position.set(accepted.x, accepted.y, accepted.z);
    if (!safe(look)) look.set(eye.x + Math.sin(entity.heading) * 1.5, eye.y, eye.z + Math.cos(entity.heading) * 1.5);
  }

  return { group, links, surfaces, colliders, heightAt, constrainCamera,
    dispose() {
      group.removeFromParent();
      group.traverse(node => node.geometry?.dispose());
      for (const material of Object.values(materials)) material.dispose();
    } };
}
