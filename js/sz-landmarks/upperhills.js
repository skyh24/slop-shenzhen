import * as THREE from 'three/webgpu';
import { abs, cameraPosition, color, dot, float, floor, fract, fwidth, max, mix, normalWorldGeometry,
  positionWorld, sin, smoothstep, step, uv, vec2 } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { terrainHeight } from '../sz-terrain.js';
import { convexHull } from '../building-collision.js';
import { baseAt, blend, footprintParts, point, roofPanelPart, spanPart } from './parts.js';

const T1 = 'way/684494961';
const T2 = 'way/684494959';
const MALL = 'way/684494957';
const NORTH_WING = 'way/684494962';
const WEST_WING = 'way/684494956';
const PAVILION = 'way/1393874916';
const retailId = number => `way/${1431500000 + number}`;
const TOWN = [...Array.from({ length: 32 }, (_, i) => retailId(1320 + i)), retailId(1368), retailId(1369)];
export const sourceIds = [T1, T2, MALL, NORTH_WING, WEST_WING, PAVILION, ...TOWN];

// 西桥为 OSM 两条同节点交会的步线中线，东桥为幸福廊桥实线。高程与横断面另行拟合。
const WEST_BRIDGE = {
  id: 'west', sourceIds: ['way/775816318', 'way/775816329'],
  points: [[644.21, -1418.32], [677.18, -1419.76], [711.84, -1420.17], [743.82, -1421.58], [777.16, -1421.95],
    [807.09, -1422.35], [837.19, -1422.57], [868.28, -1423.57], [889.14, -1425.47]],
  widths: [6.5, 10.4, 7.2, 10.4, 7.2, 10.4, 7.2, 10.4, 6.5],
  piers: [1, 3, 5]
};
const EAST_BRIDGE = {
  id: 'east', sourceIds: ['way/709520555'],
  points: [[1286.71, -1500.06], [1325, -1506.51], [1386.95, -1516.95], [1400.35, -1516.07], [1409.12, -1516.83],
    [1426.59, -1520.66], [1460.25, -1520.88], [1484.83, -1527.01], [1502.36, -1528.01],
    [1513.66, -1528.66], [1528.06, -1530.77], [1536.43, -1532.0], [1550.92, -1533.3],
    [1566.4, -1534.68], [1600.59, -1540.0]],
  widths: [7, 7.2, 7.5, 8.5, 8, 7, 7, 8.5, 8, 7, 7, 8.5, 8, 7.5, 6.5],
  piers: [1, 5, 7, 12]
};
const SOUTH_STEPS = [
  { id: 'way/1393822065', a: [1127.69, -1376.96], b: [1127.53, -1387.81] },
  { id: 'way/1393822071', a: [1130.31, -1392.32], b: [1130.07, -1402.78] },
  { id: 'way/1393822072', a: [1132.54, -1406.82], b: [1132.48, -1417.49] }
];
const flightRise = 5.6;

// 外缘参照都市实践四层平面与 OSM 室外步线，围合小镇台地及两个公园桥口。
const TOWN_DECK = [[884, -1434], [883, -1462], [877, -1547], [953, -1571], [1197, -1573], [1230, -1525],
  [1234, -1489], [1229, -1442], [1192, -1418],
  [1137.5, -1417.12], [1128, -1417.12], [1124, -1417.49], [1112, -1414], [1003, -1404], [947, -1398], [885, -1410]];
const EAST_LANDING = [[1224, -1513], [1248, -1511], [1291, -1506], [1291, -1494], [1247, -1490], [1227, -1487]];

function solid(id, source, outer, bottom, top, style, { holes = [], roofContact = false, baseSource, heightSource } = {}) {
  const [part] = footprintParts({ ...source, polygons: [{ outer, holes }] }, 0, style,
    { id: `upperhills:${id}`, min: bottom, max: top, derived: true, roofContact });
  return { ...part, baseSource: baseSource ?? part.baseSource, heightSource: heightSource ?? part.heightSource };
}

const ring = coords => coords.map(([x, z]) => point(x, z));
const pairs = points => points.map((a, i) => [a, points[(i + 1) % points.length]]);
const between = (a, b, t) => point(blend(a.x, b.x, t), blend(a.z, b.z, t));
const mean = points => point(points.reduce((sum, p) => sum + p.x, 0) / points.length,
  points.reduce((sum, p) => sum + p.z, 0) / points.length);
const inset = (points, ratio) => {
  const center = mean(points);
  return points.map(p => between(center, p, ratio));
};

function footingY(outline, terrain) {
  let lowest = Infinity;
  for (const [a, b] of pairs(outline)) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4);
    for (let i = 0; i < steps; i++) {
      const p = between(a, b, i / steps);
      const grade = terrainHeight(terrain, p.x, p.z);
      if (grade === null) return null;
      lowest = Math.min(lowest, grade);
    }
  }
  return Number.isFinite(lowest) ? lowest - 0.45 : null;
}

function towerFrame(source) {
  const outer = source.polygons[0].outer;
  const [p, q] = pairs(outer).reduce((best, edge) =>
    Math.abs(edge[1].x - edge[0].x) > Math.abs(best[1].x - best[0].x) ? edge : best);
  const direction = Math.sign(q.x - p.x) / Math.hypot(q.x - p.x, q.z - p.z);
  const ux = (q.x - p.x) * direction, uz = (q.z - p.z) * direction;
  const center = mean(outer);
  const u = outer.map(p => (p.x - center.x) * ux + (p.z - center.z) * uz);
  const v = outer.map(p => (p.z - center.z) * ux - (p.x - center.x) * uz);
  return { width: (Math.max(...u) - Math.min(...u)) / 2, depth: (Math.max(...v) - Math.min(...v)) / 2,
    world: (u, v) => point(center.x + ux * u - uz * v, center.z + uz * u + ux * v) };
}

function towerOutline(frame, cut) {
  const { width: u, depth: v, world } = frame;
  return [[-u + cut, -v], [u - cut, -v], [u - cut, -v + cut], [u, -v + cut],
    [u, v - cut], [u - cut, v - cut], [u - cut, v], [-u + cut, v],
    [-u + cut, v - cut], [-u, v - cut], [-u, -v + cut], [-u + cut, -v + cut]].map(p => world(...p));
}

function edgeFrame(a, b) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const nx = (a.z - b.z) / length, nz = (b.x - a.x) / length;
  return { length, at: (t, inset) => point(blend(a.x, b.x, t) + nx * inset, blend(a.z, b.z, t) + nz * inset) };
}

function edgeBox(at, a, b, low, high) {
  return [at(a, low), at(b, low), at(b, high), at(a, high)];
}

function officeTower(source, base, tall) {
  const id = tall ? 't1' : 't2';
  const outline = towerOutline(towerFrame(source), tall ? 2.25 : 0.55);
  const edges = pairs(outline);
  const floor = tall ? 10.6 : 7.8;
  const parapet = tall ? 379.1 : source.height - 5.5;
  const roof = source.height;
  const slots = tall
    ? [[91, 4.0, [9]], [140.5, 8.8, [0, 3, 6, 9]], [229, 4.0, [9]], [304.5, 6.7, [0, 3, 6, 9]]]
    : [[92, 5.5, [9]], [147, 8.4, [0, 3, 6]], [188, 4.4, [9]]];
  const volume = (name, polygon, low, high, style, options) =>
    solid(`${id}:${name}`, source, polygon, base + low, base + high, style, options);
  const parts = [
    volume('recessed-lobby', inset(outline, tall ? 0.84 : 0.93), 0, floor - 0.85, 'upperhillsLobby'),
    volume('entrance-soffit', outline, floor - 0.85, floor, 'upperhillsConcrete')
  ];
  if (tall) {
    const { at } = edgeFrame(...edges[3]);
    for (const station of [0.16, 0.5, 0.84]) parts.push(volume(`entry-pier:${station}`,
      edgeBox(at, station - 0.018, station + 0.018, 0.45, 2.4), 0, floor - 0.85, 'upperhillsConcrete'));
  }
  let bottom = floor;
  for (const [start, height, faces] of slots) {
    parts.push(volume(`curtain:${bottom}`, outline, bottom, start, 'upperhillsOffice'));
    const from = tall ? 0.28 : 0.17, to = 1 - from;
    const depth = 0.65;
    const profile = edges.flatMap(([a, b], i) => {
      if (!faces.includes(i)) return [a];
      const { at, length } = edgeFrame(a, b);
      parts.push(volume(`louvre-backing:${start}:${i}`, edgeBox(at, from, to, depth - 0.06, depth),
        start, start + height, 'upperhillsVent'));
      const count = Math.max(4, Math.round(length * (to - from) / 2.45));
      for (let j = 0; j < count; j++) {
        const t = blend(from, to, (j + 0.5) / count);
        parts.push(volume(`louvre:${start}:${i}:${j}`, edgeBox(at, t - 0.28 / length, t + 0.28 / length, 0.12, depth - 0.06),
          start, start + height, 'upperhillsMetal'));
      }
      return [a, at(from, 0), at(from, depth), at(to, depth), at(to, 0)];
    });
    bottom = start + height;
    parts.push(volume(`curtain-recess:${start}`, profile, start, bottom, 'upperhillsOffice'));
  }
  const crownEdge = roof - (tall ? 2.25 : 1.1);
  parts.push(volume('upper-curtain', outline, bottom, parapet, tall ? 'upperhillsHotel' : 'upperhillsOffice'));
  parts.push(volume('open-crown-rim', outline, parapet, crownEdge, 'upperhillsHotel', { holes: [inset(outline, 0.945).reverse()] }));
  for (const side of [3, 9]) {
    const { at } = edgeFrame(...edges[side]);
    parts.push(volume(`raised-crown:${side}`, edgeBox(at, 0.045, 0.955, 0, 0.85), crownEdge, roof, 'upperhillsMetal',
      { heightSource: source.heightSource }));
  }
  return parts;
}

function clipX(points, x, side) {
  return pairs(points).flatMap(([a, b]) => {
    const da = (a.x - x) * side, db = (b.x - x) * side;
    const inside = da >= 0 ? [a] : [];
    if (da * db < 0) inside.push(between(a, b, da / (da - db)));
    return inside;
  });
}

function roofedWing(id, source, base, baseTop, levels, openings = []) {
  const { outer, holes } = source.polygons[0];
  const toShape = ring => ring.map(p => new THREE.Vector2(p.x, p.z));
  const vertices = [outer, ...holes].flat();
  const triangles = THREE.ShapeUtils.triangulateShape(toShape(outer), holes.map(toShape)).map(ids => ids.map(i => vertices[i]));
  const parts = [];
  for (let station = 1; station < levels.length; station++) {
    const [a, ya] = levels[station - 1], [b, yb] = levels[station];
    const minY = openings.some(([low, high]) => a >= low && b <= high) ? baseTop : base;
    for (const triangle of triangles) {
      const shape = clipX(clipX(triangle, a, 1), b, -1).map(p => ({
        x: Math.fround(p.x), y: blend(ya, yb, (p.x - a) / (b - a)), z: Math.fround(p.z)
      }));
      for (let i = 1; i + 1 < shape.length; i++) {
        const tri = [shape[0], shape[i], shape[i + 1]];
        const [p, q, r] = tri;
        if (Math.abs((q.x - p.x) * (r.z - p.z) - (r.x - p.x) * (q.z - p.z)) < 1e-5) continue;
        parts.push(roofPanelPart(`upperhills:${id}:${parts.length}`, source, tri, tri.map(p => p.y - minY), 'upperhillsWing',
          { baseSource: 'dem-south-walkway-point' }));
      }
    }
  }
  return parts;
}

const warmFacades = new Map([[1330, 'Red'], [1332, 'Ochre'], [1334, 'Rust'], [1336, 'Ochre'], [1338, 'Rust'],
  [1340, 'Red'], [1342, 'Ochre'], [1345, 'Rust'], [1350, 'Red']]);

function townBlock(source, deckY) {
  const no = Number(source.id.slice(-4));
  const { outer, holes } = source.polygons[0];
  const mass = no === 1368 ? 23 : no === 1348 ? 18 : no === 1347 || no < 1322 ? 14.8
    : (source.height > 25 ? 4 : 3) * 3.85;
  const style = `upperhillsLoft${warmFacades.get(no) ?? 'Ivory'}`;
  const stem = `loft:${no}`;
  const options = { holes, baseSource: 'dem-south-walkway-point' };
  const canInset = outer.length === 4 && holes.length === 0 && no > 1327 && no < 1347;
  const parts = [solid(`${stem}:retail`, source, outer, deckY, deckY + 4.0, 'upperhillsLobby', options),
    solid(`${stem}:upper`, source, outer, deckY + 4.0, deckY + mass - (canInset ? 2.8 : 0), style, options)];
  if (canInset) {
    const terrace = inset(outer, 0.82);
    parts.push(solid(`${stem}:roof-room`, source, terrace, deckY + mass - 2.8, deckY + mass, style, options));
  }
  return parts;
}

function ballroom(source, base) {
  const { outer } = source.polygons[0];
  const floor = inset(outer, 0.9);
  const edges = pairs(outer);
  const parts = [
    solid('pavilion:plinth', source, floor, base, base + 9.0, 'upperhillsConcrete'),
    solid('pavilion:ballroom', source, outer, base + 9.0, base + 28.3, 'upperhillsLobby'),
    solid('pavilion:upper-ballroom', source, outer, base + 36.5, base + source.height, 'upperhillsOffice')
  ];
  // 朝笔架山的露台开口留空，上下宴会体和背后的玻璃体分别封闭。
  for (const [i, edge] of edges.entries()) {
    if (edge[0].x > source.cx && edge[1].x > source.cx) continue;
    const { at } = edgeFrame(...edge);
    parts.push(solid(`pavilion:terrace-screen:${i}`, source, edgeBox(at, 0, 1, -0.36, 0.36),
      base + 28.3, base + 36.5, 'upperhillsLobby'));
  }
  return parts;
}

function southAccess(source, grade, terrain) {
  const parts = [];
  const footing = (a, b, width) => footingY(edgeBox(edgeFrame(a, b).at, 0, 1, -width / 2, width / 2), terrain);
  for (const [i, flight] of SOUTH_STEPS.entries()) {
    const level = grade + i * flightRise;
    const start = point(...flight.a), end = point(...flight.b);
    const base = footing(start, end, 2.35);
    if (base === null) return [];
    const count = 32;
    for (let j = 0; j < count; j++) {
      const y = level + flightRise * (j + 1) / count;
      const a = { ...between(start, end, j / count), y };
      const b = { ...between(start, end, (j + 1) / count), y };
      const step = spanPart(`upperhills:south-stair:${i}:${j}`, source, a, b, 2.35, 2.35,
        y - base, 'upperhillsPaving', { roofContact: true });
      parts.push({ ...step, baseSource: 'dem-stair-footing-samples', routeSourceIds: [flight.id] });
    }
    if (i + 1 < SOUTH_STEPS.length) {
      const y = level + flightRise;
      const nextStart = point(...SOUTH_STEPS[i + 1].a), nextEnd = point(...SOUTH_STEPS[i + 1].b);
      const arrival = edgeFrame(start, end), departure = edgeFrame(nextStart, nextEnd);
      // 转角平台横跨两段的完整梯口，给真实脚印在转向时保留连续踏面。
      const outline = convexHull([
        ...edgeBox(arrival.at, 1 - 0.12 / arrival.length, 1 + 0.75 / arrival.length, -1.38, 1.38),
        ...edgeBox(departure.at, -0.75 / departure.length, 0.12 / departure.length, -1.38, 1.38)
      ]);
      const base = footingY(outline, terrain);
      if (base === null) return [];
      parts.push(solid(`south-landing:${i}`, source, outline, base, y, 'upperhillsPaving',
        { roofContact: true, baseSource: 'dem-stair-footing-samples' }));
    }
  }
  return parts;
}

function ribbonPoints(coords, startY, endY, widths, rise = 0) {
  const points = ring(coords);
  const normals = points.slice(1).map((b, i) => {
    const a = points[i], d = Math.hypot(b.x - a.x, b.z - a.z);
    return point((a.z - b.z) / d, (b.x - a.x) / d);
  });
  const distances = [0];
  for (const [i, p] of points.slice(1).entries()) distances.push(distances[i] + Math.hypot(p.x - points[i].x, p.z - points[i].z));
  return points.map((p, i) => {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(normals.length - 1, i)];
    const dot = a.x * b.x + a.z * b.z;
    const t = distances[i] / distances.at(-1);
    const y = blend(startY, endY, t) + rise * Math.sin(t * Math.PI) ** 2;
    const at = (across, rise = 0) => ({ x: p.x + across * (a.x + b.x) / (1 + dot),
      y: y + rise, z: p.z + across * (a.z + b.z) / (1 + dot) });
    return { at, width: widths[i] };
  });
}

function bridgeDeck(id, source, stations, depth, rails = true) {
  const parts = [];
  const add = (a, b, low, high, rise, thickness, style, roofContact = false) => {
    const quad = [a.at(low(a.width), rise), b.at(low(b.width), rise), b.at(high(b.width), rise), a.at(high(a.width), rise)];
    for (const [i, tri] of [[0, [quad[0], quad[1], quad[2]]], [1, [quad[0], quad[2], quad[3]]]]) {
      parts.push(roofPanelPart(`upperhills:${id}:${parts.length}:${i}`, source, tri, thickness, style,
        { roofContact, baseSource: 'dem-south-walkway-point' }));
    }
  };
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    add(a, b, w => -w / 2, w => w / 2, 0, depth, 'upperhillsPaving', true);
    if (rails) {
      add(a, b, w => -w / 2, w => -w / 2 + 0.16, 1.06, 1.06, 'upperhillsMetal');
      add(a, b, w => w / 2 - 0.16, w => w / 2, 1.06, 1.06, 'upperhillsMetal');
    }
  }
  return parts;
}

function westPergolas(source, stations) {
  const parts = [];
  for (const [i, station] of stations.entries()) {
    if (i % 2 !== 1) continue;
    const side = i % 4 === 1 ? 1 : -1;
    const edge = station.width / 2 - 0.42;
    const a = station.at(side * edge), b = station.at(side * (edge - 1.25), 3.4);
    const end = station.at(side * (edge - 2.45), 3.4);
    const tangent = stations[i + 1].at(0), length = Math.hypot(tangent.x - a.x, tangent.z - a.z);
    const dx = (tangent.x - a.x) / length, dz = (tangent.z - a.z) / length;
    const offset = (p, d) => ({ x: p.x + dx * d, y: p.y, z: p.z + dz * d });
    for (const d of [-3.2, -1.6, 0, 1.6, 3.2]) {
      parts.push(spanPart(`upperhills:west-timber:${i}:${d}:leg`, source, offset(a, d), offset(b, d), 0.23, 0.23, 0.25, 'upperhillsTimber'));
      parts.push(spanPart(`upperhills:west-timber:${i}:${d}:shade`, source, offset(b, d), offset(end, d), 0.22, 0.22, 0.22, 'upperhillsTimber'));
    }
  }
  return parts;
}

function parkBridge(bridge, source, terrain, deckY) {
  const west = bridge.id === 'west';
  const park = bridge.points[west ? 0 : bridge.points.length - 1];
  const parkY = terrainHeight(terrain, ...park);
  if (parkY === null) return [];
  // 西桥跨越彩田路高架及公园边坡，跨中高差是照片和现有地形对照后的拟合值。
  const stations = ribbonPoints(bridge.points, west ? parkY + 0.12 : deckY, west ? deckY : parkY + 0.12, bridge.widths, west ? 3.35 : 0);
  const thickness = west ? 1.18 : 0.88;
  const pieces = bridgeDeck(`park-bridge:${bridge.id}`, source, stations, thickness);
  // 只在已核对不占源车行面的站位拟合桥墩，路中主跨留空。
  for (const i of bridge.piers) {
    const { at } = stations[i];
    const { x, y, z } = at(0, -thickness);
    const ground = terrainHeight(terrain, x, z);
    if (ground !== null && y > ground + 0.1) {
      pieces.push(spanPart(`upperhills:park-pier:${bridge.id}:${i}`, source, at(-1.1, -thickness), at(1.1, -thickness),
        1.3, 1.3, y - ground + 0.3, 'upperhillsConcrete'));
    }
  }
  if (west) pieces.push(...westPergolas(source, stations));
  return pieces.map(part => ({ ...part, routeSourceIds: bridge.sourceIds,
    baseSource: part.id.startsWith('upperhills:park-pier:') ? 'dem-bridge-pier-point' : 'dem-bridge-endpoints-and-photo-profile' }));
}

function loftLinks(source, deckY) {
  // 四、五层平面及内街照片可见短廊。端口按当前 OSM 轮廓配准，标高为楼层差估计。
  const links = [
    [[1019.05, -1469.8], [1025.6, -1469.8]],
    [[1049.14, -1486.0], [1055.08, -1486.0]]
  ];
  return links.flatMap((coords, i) => bridgeDeck(`loft-link:${i}`, source,
    ribbonPoints(coords, deckY + 4.25, deckY + 4.25, [2.4, 2.4]), 0.48));
}

export function build(buildings, terrain) {
  if (!sourceIds.every(id => buildings.get(id)?.polygons.length === 1)
    || [T1, T2].some(id => buildings.get(id).polygons[0].outer.length !== 4)) return [];
  const grade = terrainHeight(terrain, ...SOUTH_STEPS[0].a);
  if (grade === null) return [];
  const [tall, short, mall, north, west, pavilion] = [T1, T2, MALL, NORTH_WING, WEST_WING, PAVILION].map(id => buildings.get(id));
  const deckY = grade + SOUTH_STEPS.length * flightRise;
  const footprints = [ring(TOWN_DECK), ...[mall, north, west].map(source => source.polygons[0].outer)];
  const footings = footprints.map(outline => footingY(outline, terrain));
  const access = southAccess(mall, grade, terrain);
  if (footings.some(y => y === null || y >= deckY) || access.length === 0) return [];
  // 裙座下缘沿同一 DSM 取样落地，东桥口独立用薄板保留架空空间。
  const podium = solid('town-deck', mall, footprints[0], footings[0], deckY, 'upperhillsPaving',
    { roofContact: true, baseSource: 'dem-town-footing-samples' });
  const skirts = [['south', mall], ['north', north], ['west', west]].map(([side, source], i) =>
    solid(`${side}-retail-base`, source, footprints[i + 1], footings[i + 1], deckY, 'upperhillsLobby',
      { holes: source.polygons[0].holes, baseSource: 'dem-town-footing-samples' }));
  const bridgeLanding = solid('east-bridge-landing', mall, ring(EAST_LANDING), deckY - 0.88, deckY, 'upperhillsPaving',
    { roofContact: true, baseSource: 'dem-south-walkway-point' });
  const northLevels = [[north.minX, deckY + 17], [north.cx - 25, grade + 64.2], [north.maxX, deckY + 18.5]];
  const gate = [1008, 1025];
  const southLevels = [[mall.minX, grade + 33], [995, grade + 47], [gate[0], grade + 48.0],
    [gate[1], grade + 46.5], [mall.maxX, grade + 34]];
  return [
    ...officeTower(tall, baseAt(tall, terrain), true), ...officeTower(short, baseAt(short, terrain), false),
    ...ballroom(pavilion, baseAt(pavilion, terrain)), podium, ...skirts, bridgeLanding,
    ...roofedWing('north-loft-wing', north, deckY, deckY, northLevels),
    ...roofedWing('south-loft-wing', mall, deckY, deckY + 6.5, southLevels, [gate]),
    solid('west-hotel-wing', west, west.polygons[0].outer, deckY, deckY + 24.5, 'upperhillsLoftIvory',
      { holes: west.polygons[0].holes, baseSource: 'dem-south-walkway-point' }),
    ...TOWN.flatMap(id => townBlock(buildings.get(id), deckY)),
    ...access, ...loftLinks(mall, deckY),
    ...parkBridge(WEST_BRIDGE, mall, terrain, deckY), ...parkBridge(EAST_BRIDGE, mall, terrain, deckY)
  ];
}

const solidMaterials = {
  upperhillsConcrete: [0xafa898, 0.77, 0.07],
  upperhillsMetal: [0x78838a, 0.35, 0.53],
  upperhillsVent: [0x262f36, 0.58, 0.32],
  upperhillsTimber: [0xb38969, 0.68, 0.09]
};
const plaster = {
  upperhillsLoftIvory: 0xd8d1c2, upperhillsLoftRed: 0xb53627,
  upperhillsLoftOchre: 0xc58e36, upperhillsLoftRust: 0xa65940
};

function wallMaterial(name) {
  const glass = name === 'upperhillsOffice' || name === 'upperhillsHotel' || name === 'upperhillsLobby';
  const hotel = name === 'upperhillsHotel';
  const lobby = name === 'upperhillsLobby';
  const wing = name === 'upperhillsWing';
  const material = new THREE.MeshStandardNodeMaterial();
  const wall = smoothstep(0.2, 0.59, abs(normalWorldGeometry.y)).oneMinus();
  const u = wing ? positionWorld.x.add(positionWorld.z.mul(0.73)) : uv().x;
  const v = wing ? positionWorld.y : uv().y;
  const bx = u.div(glass ? 3 : 3.8), by = v.div(hotel ? 4.2 : lobby ? 5.6 : glass ? 4.5 : 3.85);
  const line = (cell, fraction) => {
    const soft = max(fwidth(cell), 0.005);
    return smoothstep(float(fraction).sub(soft), float(fraction).add(soft), abs(fract(cell).sub(0.5))).oneMinus();
  };
  const detail = smoothstep(0.18, 0.78, max(fwidth(bx), fwidth(by))).oneMinus();
  const panes = mix(float(glass ? 0.82 : 0.27), line(bx, glass ? 0.47 : 0.29).mul(line(by, glass ? 0.44 : 0.30)), detail);
  const noise = fract(sin(dot(vec2(floor(bx), floor(by)), vec2(9.278, 71.291))).mul(27385.42));
  const skyEdge = abs(dot(cameraPosition.sub(positionWorld).normalize(), normalWorldGeometry)).oneMinus().pow(2.2);
  const tint = color(lobby ? 0x617478 : glass ? 0x779cac : 0x404b50).mul(mix(float(1), noise.mul(0.17).add(0.91), detail));
  const windowColor = mix(tint, color(0xb0c7d2), skyEdge.mul(glass ? 0.37 : 0.12).mul(sceneUniforms.night.oneMinus()));
  const cladding = color(glass ? 0x647a84 : plaster[name] ?? 0xd2cdc1);
  material.colorNode = mix(color(wing ? 0xa1a7a7 : 0xa5a8a4), mix(cladding, windowColor, panes), wall);
  material.roughnessNode = mix(float(0.72), float(glass ? 0.19 : 0.3), wall.mul(panes));
  material.metalnessNode = wall.mul(panes).mul(glass ? 0.42 : 0.15);
  const lit = mix(float(0.04), step(noise, 0.10).mul(0.65), detail);
  material.emissiveNode = color(hotel || lobby || !glass ? 0xf3d2a2 : 0xc7e1f3)
    .mul(lit.add(lobby ? 0.09 : 0.025)).mul(wall).mul(panes).mul(sceneUniforms.night);
  return material;
}

export function createUpperhillsMaterial(name) {
  if (Object.hasOwn(solidMaterials, name)) {
    const [color, roughness, metalness] = solidMaterials[name];
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }
  if (Object.hasOwn(plaster, name)) return wallMaterial(name);
  switch (name) {
    case 'upperhillsOffice':
    case 'upperhillsHotel':
    case 'upperhillsLobby':
    case 'upperhillsWing': return wallMaterial(name);
    case 'upperhillsPaving': {
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0.06 });
      const facing = smoothstep(0.0, 0.7, normalWorldGeometry.y);
      material.colorNode = mix(color(0x9a938b), color(0xc8c4b8), facing);
      return material;
    }
    default: throw new Error(`Unknown UpperHills material: ${name}`);
  }
}
