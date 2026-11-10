import { polygonContains } from '../building-collision.js';
import { baseAt, blend, footprintParts, loftPart, spanPart } from './parts.js';

const EAST = {
  core: 'way/1110477862',
  wings: [['way/1110477861', 'south'], ['way/1110477863', 'outer'], ['way/1110477864', 'bridge']],
  connectors: ['way/1151596327', 'way/1151596328']
};
const WEST = {
  core: 'way/1110477866',
  wings: [['way/1110477867', 'south'], ['way/1110477865', 'outer'], ['way/1110477868', 'bridge']],
  connectors: ['way/1151596330', 'way/1151596329']
};
const BRIDGE = 'way/1110959408';
const sourceIds = [BRIDGE, ...[EAST, WEST].flatMap(tower => [tower.core, ...tower.wings.map(([id]) => id), ...tower.connectors])];

// 连桥出版值（论文图 3 横断面、图 4 立面、图 5 索立面），单位米。
const BRIDGE_LENGTH = 89.75; // 75.95 主跨 + 两端各 6.9 边跨
const BRIDGE_END_SPAN = 6.9;
const BRIDGE_WIDTH = [4.024, 2.126];
const BRIDGE_EDGE_WIDTH = [1.305, 0.537]; // 图 3：中央桥面两侧边梁宽
const BRIDGE_EDGE_DEPTH = [0.734, 0.25]; // 图 3：边梁梁高
const BRIDGE_TRUSS_HEIGHT = [4.0, 1.6]; // 图 4：桁架/护栏区总高（端部、跨中）
const DECK_RISE = [105.740, 106.083, 106.470, 106.870, 107.249, 107.570, 107.841, 108.062, 108.236, 108.360, 108.435, 108.440];
const CABLE_TIP = 105.740 + 11.813;
const CABLE_MIDDLE = 108.440 + 3.762;
// 两塔桥侧体量内表面间距的数据实测值，用来确认 89.75 米桥面两端确实埋在塔体里。
const BRIDGE_VISIBLE_SPAN = [31.5, 32.4];

// 核心筒和连接件改用深蓝灰钢色，避免读成额外的浅色塔楼；竖挺、V 撑复用既有材质键。
// djiDeck 留给连桥桥面（测试和文档都按它认桥面），核心筒不占用。
const CORE_STYLE = 'djiGuard';
const FIN_STYLE = 'djiBrace';
const BRACE_STYLE = 'djiSteel';
const TRUSS_STYLE = 'djiGuard';
// 桥的吊索/护栏用既有 pingAnCrownEdge（带夜间自发光）复用为“桥体灯带”，不新增材质键。
const NIGHT_STEEL = 'pingAnCrownEdge';

// 核心筒竖挺：外凸 0.45 米、宽 0.45 米、间距约 2.2 米（照片比例，估计值）。
const FIN_PROUD = 0.45;
const FIN_INSET = 0.2;
const FIN_WIDTH = 0.45;
const FIN_SPACING = 2.2;

// 悬浮块 V 形撑：贴幕墙外凸 0.15 米，斜杆高度方向厚 1.8 米，顶部横杆高 0.6 米。
const BRACE_PROUD = 0.15;
const BRACE_THICKNESS = 0.36;
const BRACE_DEPTH = 1.8;
const CROSSBAR_DEPTH = 0.6;
const BRACE_FACE_RATIO = 0.5;

const midness = t => 1 - Math.abs(2 * t - 1);

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i].x * ring[j].z - ring[j].x * ring[i].z;
  }
  return area / 2;
}

// 逆时针环外法线为 (dz, -dx)，顺时针环为 (-dz, dx)；法线用于把竖挺和 V 撑放到幕墙外。
function outwardNormals(ring) {
  const sign = signedArea(ring) < 0 ? -1 : 1;
  return ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    return { x: sign * dz / length, z: -sign * dx / length };
  });
}

function bridgeAxis(source) {
  const ring = source.polygons[0].outer;
  const center = {
    x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
    z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length
  };
  let dx = 0, dz = 0, length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span > length) {
      const direction = b.x > a.x ? 1 : -1;
      dx = direction * (b.x - a.x) / span;
      dz = direction * (b.z - a.z) / span;
      length = span;
    }
  }
  if (length === 0) throw new Error(`Missing bridge axis: ${source.id}`);
  return (t, y, offset = 0) => ({
    x: center.x + dx * (t - 0.5) * BRIDGE_LENGTH + dz * offset,
    z: center.z + dz * (t - 0.5) * BRIDGE_LENGTH - dx * offset,
    y
  });
}

function bridgeDeck(t) {
  const index = midness(t) * (DECK_RISE.length - 1);
  const i = Math.min(DECK_RISE.length - 2, Math.floor(index));
  return blend(DECK_RISE[i], DECK_RISE[i + 1], index - i);
}

function bridgeWidth(t) {
  return blend(...BRIDGE_WIDTH, midness(t) ** 0.72);
}

function bridgeEdgeWidth(t) {
  return blend(...BRIDGE_EDGE_WIDTH, midness(t) ** 0.72);
}

function bridgeTruss(t) {
  return blend(...BRIDGE_TRUSS_HEIGHT, midness(t));
}

function bridgeCable(t) {
  return blend(CABLE_MIDDLE, CABLE_TIP, (2 * t - 1) ** 2);
}

// 沿轴从桥端向内量塔楼实体覆盖长度：89.75 米结构长度里两端各约 29 米埋在塔体里。
function coveredLength(axis, end, solids, base) {
  let distance = 0;
  for (; distance <= BRIDGE_LENGTH / 2; distance += 0.1) {
    const t = end === 0 ? distance / BRIDGE_LENGTH : 1 - distance / BRIDGE_LENGTH;
    const p = axis(t, 0);
    const y = base + bridgeDeck(t);
    if (!solids.some(part => y >= part.minY && y <= part.maxY && polygonContains(part.polygon, p.x, p.z))) break;
  }
  return distance;
}

function bridgeParts(source, buildings, terrain, towerSolids) {
  const axis = bridgeAxis(source);
  const base = baseAt(source, terrain);
  const westAnchor = buildings.get(WEST.connectors[1]);
  const eastAnchor = buildings.get(EAST.connectors[1]);
  for (const [sourcePart, t] of [[westAnchor, 0], [eastAnchor, 1]]) {
    const p = axis(t, 0);
    const y = base + bridgeDeck(t);
    const anchorBase = baseAt(sourcePart, terrain);
    if (!sourcePart.polygons.some(polygon => polygonContains(polygon, p.x, p.z))
      || y < anchorBase + sourcePart.minHeight || y > anchorBase + sourcePart.height) {
      throw new Error(`Bridge axis misses the sourced tower attachment: ${sourcePart.id}`);
    }
  }
  // 桥面可见净跨只有约 31.8 米，其余长度必须完全埋在塔楼体量内，否则桥会浮在空中。
  const embedded = [coveredLength(axis, 0, towerSolids.west, base), coveredLength(axis, 1, towerSolids.east, base)];
  const clear = BRIDGE_LENGTH - embedded[0] - embedded[1];
  if (embedded.some(distance => distance < (BRIDGE_LENGTH - BRIDGE_VISIBLE_SPAN[1]) / 2)
    || clear < BRIDGE_VISIBLE_SPAN[0] || clear > BRIDGE_VISIBLE_SPAN[1]) {
    throw new Error(`Bridge ends are not embedded in the tower bodies: ${embedded.map(d => d.toFixed(2)).join(' / ')} m, clear ${clear.toFixed(2)} m`);
  }

  const pieces = [];
  const add = (name, a, b, widthA, widthB, depth, style, heightSource) => {
    pieces.push(spanPart(`${source.id}:${name}:${pieces.length}`, source, a, b, widthA, widthB, depth, style, { heightSource }));
  };
  const spans = (DECK_RISE.length - 1) * 2;
  for (let i = 0; i < spans; i++) {
    const a = i / spans, b = (i + 1) / spans;
    const yA = base + bridgeDeck(a);
    const yB = base + bridgeDeck(b);
    const wA = bridgeWidth(a);
    const wB = bridgeWidth(b);
    const mid = midness((a + b) / 2);
    add('bridge-deck', axis(a, yA), axis(b, yB), wA, wB, blend(...BRIDGE_EDGE_DEPTH, mid), 'djiDeck', 'design');
    add('suspension-cable', axis(a, base + bridgeCable(a)), axis(b, base + bridgeCable(b)), 0.12, 0.12, 0.12, NIGHT_STEEL);
    // 图 3 的边梁贴在中央桥面两侧，顶面与桥面齐平；图 4 的桁架/护栏区立在边梁外沿，端部高、跨中低。
    const eA = bridgeEdgeWidth(a);
    const eB = bridgeEdgeWidth(b);
    const hA = bridgeTruss(a);
    const hB = bridgeTruss(b);
    for (const side of [-1, 1]) {
      add('bridge-edge-beam', axis(a, yA, side * (wA / 2 + eA / 2)), axis(b, yB, side * (wB / 2 + eB / 2)),
        eA, eB, blend(...BRIDGE_EDGE_DEPTH, mid), TRUSS_STYLE, 'design');
      add('bridge-guard', axis(a, yA + hA, side * (wA / 2 + eA - 0.075)),
        axis(b, yB + hB, side * (wB / 2 + eB - 0.075)), 0.15, 0.15, Math.max(hA, hB), NIGHT_STEEL, 'design');
    }
  }

  for (const end of [0, 1]) {
    const foot = end === 0 ? BRIDGE_END_SPAN / BRIDGE_LENGTH : 1 - BRIDGE_END_SPAN / BRIDGE_LENGTH;
    const head = axis(end, base + CABLE_TIP);
    for (const side of [-1, 1]) {
      add('inclined-bridge-tower', axis(foot, base + bridgeDeck(foot), side * bridgeWidth(foot) * 0.41),
        head, 0.78, 0.43, 0.56, 'djiSteel');
      add('anchoring-cable', axis(end + (end ? -0.003 : 0.003), base + bridgeDeck(end), side * bridgeWidth(end) * 0.49),
        head, 0.09, 0.09, 0.09, 'djiSteel');
    }
  }
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    const lead = t < 0.5 ? t - 0.028 : t + 0.028;
    const gauge = Math.abs(t - 0.5) > 0.27 ? 0.04 : 0.03;
    for (const side of [-1, 1]) {
      add('diagonal-hanger', axis(t, base + bridgeDeck(t), side * bridgeWidth(t) * 0.46),
        axis(lead, base + bridgeCable(lead)), gauge, gauge, gauge, 'djiSteel');
    }
  }
  return pieces;
}

function wingGap(wing, direction, base, bridgeY, bridge) {
  const bottom = base + wing.minHeight;
  const top = base + wing.height;
  // 正立面可辨认两段悬浮盒。除连桥缺口外，分段高度按立面比例派生。
  if (direction === 'bridge') return [bridgeY + bridge.minHeight - 2.2 - base, bridgeY + CABLE_TIP + 1.15 - base];
  const ratio = direction === 'south' ? [0.454, 0.52] : [0.466, 0.529];
  return ratio.map(t => blend(bottom, top, t) - base);
}

// 每个悬浮块的长立面上，两根斜杆从顶边两角收到底边中央，加一根顶部横杆；照片比例，估计值。
function facadeBraces(wing, volume, solids) {
  const ring = volume.polygon.outer;
  const normals = outwardNormals(ring);
  const longest = Math.max(...ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return Math.hypot(b.x - a.x, b.z - a.z);
  }));
  const offset = BRACE_PROUD - BRACE_THICKNESS / 2;
  const capY = volume.maxY - 0.4;
  const footY = volume.minY + 1.9;
  const placement = { baseSourceId: volume.baseSourceId };
  const braces = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < longest * BRACE_FACE_RATIO) continue;
    const normal = normals[i];
    const dx = (b.x - a.x) / length;
    const dz = (b.z - a.z) / length;
    const at = (t, y) => ({
      x: a.x + dx * length * t + normal.x * offset,
      z: a.z + dz * length * t + normal.z * offset,
      y
    });
    // 立面被核心筒或连接件挡住时不加，避免 V 撑埋在别人体量里。
    const probe = { x: a.x + dx * length / 2 + normal.x * 0.35, z: a.z + dz * length / 2 + normal.z * 0.35 };
    if (solids.some(part => part.sourceId !== wing.id && polygonContains(part.polygon, probe.x, probe.z))) continue;
    const knee = at(0.5, footY);
    for (const t of [0.045, 0.955]) {
      braces.push(spanPart(`${volume.id}:v-brace:${i}:${braces.length}`, wing, at(t, capY), knee,
        BRACE_THICKNESS, BRACE_THICKNESS, BRACE_DEPTH, BRACE_STYLE, placement));
    }
    braces.push(spanPart(`${volume.id}:crossbar:${i}`, wing, at(0.045, capY), at(0.955, capY),
      BRACE_THICKNESS, BRACE_THICKNESS, CROSSBAR_DEPTH, BRACE_STYLE, placement));
    // 照片里的 V 撑是 Y 形：顶横杆中点还有一根竖杆落到 V 底；竖杆在平面内没有长度，用细 loft 建。
    const section = y => {
      const centre = at(0.5, y);
      const half = BRACE_THICKNESS / 2;
      return [[-half, -half], [half, -half], [half, half], [-half, half]].map(([u, v]) => ({
        x: centre.x + dx * u + normal.x * v, z: centre.z + dz * u + normal.z * v
      }));
    };
    braces.push(loftPart(`${volume.id}:v-brace-mid:${i}`, wing, section(footY), section(capY),
      footY, capY, BRACE_STYLE, placement));
  }
  return braces;
}

// 核心筒全高竖挺：深色核心筒上的一圈金属条，顶部 13 米、块间缝隙和塔身都能读出竖向分格。
function spineFins(core, base) {
  const ring = core.polygons[0].outer;
  const normals = outwardNormals(ring);
  const fins = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 4) continue;
    const count = Math.max(3, Math.round((length - 1.4) / FIN_SPACING));
    const normal = normals[i];
    const dx = (b.x - a.x) / length;
    const dz = (b.z - a.z) / length;
    for (let k = 0; k < count; k++) {
      const centre = length * (k + 0.5) / count;
      const quad = [[-FIN_WIDTH / 2, -FIN_INSET], [-FIN_WIDTH / 2, FIN_PROUD], [FIN_WIDTH / 2, FIN_PROUD],
        [FIN_WIDTH / 2, -FIN_INSET]].map(([along, out]) => ({
        x: a.x + dx * (centre + along) + normal.x * out,
        z: a.z + dz * (centre + along) + normal.z * out
      }));
      // loftPart 要求逆时针环；竖挺截面固定，按环方向校正。
      if (signedArea(quad) < 0) quad.reverse();
      fins.push(loftPart(`${core.id}:fin:${fins.length}`, core, quad, quad, base, base + core.height, FIN_STYLE));
    }
  }
  return fins;
}

function towerParts(tower, buildings, terrain, bridgeY, bridge) {
  const core = buildings.get(tower.core);
  const base = baseAt(core, terrain);
  // 只有核心筒落地；连接件是核心筒外延，按源足迹和源高度（198/180/157.5/144 米）建模。
  const masses = footprintParts(core, base, CORE_STYLE);
  for (const id of tower.connectors) masses.push(...footprintParts(buildings.get(id), base, CORE_STYLE, { baseSourceId: core.id }));
  const plan = [...masses, ...spineFins(core, base)];
  const wings = new Map();
  const volumes = [];
  for (const [id, direction] of tower.wings) {
    const wing = buildings.get(id);
    wings.set(id, wing);
    const [lowerTop, upperBottom] = wingGap(wing, direction, base, bridgeY, bridge);
    if (!(wing.minHeight < lowerTop && lowerTop < upperBottom && upperBottom < wing.height)) {
      throw new Error(`Invalid suspended wing heights: ${wing.id}`);
    }
    volumes.push(
      ...footprintParts(wing, base, 'djiWing', { id: `${id}:lower`, max: lowerTop, derived: true, baseSourceId: core.id }),
      ...footprintParts(wing, base, 'djiWing', { id: `${id}:upper`, min: upperBottom, derived: true, baseSourceId: core.id })
    );
  }
  const solids = [...masses, ...volumes];
  const parts = [...plan, ...volumes];
  for (const volume of volumes) parts.push(...facadeBraces(wings.get(volume.sourceId), volume, solids));
  return parts;
}

// 塔楼源体量包裹：核心筒、三翼、四个连接件在源高度区间内的足迹并集，用来核查连桥端部埋在塔体内。
function towerEnvelope(tower, buildings, terrain) {
  return [tower.core, ...tower.wings.map(([id]) => id), ...tower.connectors].map(id => {
    const building = buildings.get(id);
    const base = baseAt(building, terrain);
    return { polygon: building.polygons[0], minY: base + building.minHeight, maxY: base + building.height };
  });
}

function build(buildings, terrain) {
  const bridge = buildings.get(BRIDGE);
  const bridgeY = baseAt(bridge, terrain);
  return [
    ...towerParts(EAST, buildings, terrain, bridgeY, bridge),
    ...towerParts(WEST, buildings, terrain, bridgeY, bridge),
    ...bridgeParts(bridge, buildings, terrain, {
      west: towerEnvelope(WEST, buildings, terrain), east: towerEnvelope(EAST, buildings, terrain)
    })
  ];
}

export { sourceIds, build };
