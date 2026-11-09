import { polygonContains } from '../building-collision.js';
import { baseAt, blend, footprintParts, spanPart } from './parts.js';

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

// 连桥立面图的端部至跨中桥面标高及两边锚距，单位为米。
const BRIDGE_LENGTH = 89.75;
const BRIDGE_END_SPAN = 6.9;
const BRIDGE_WIDTH = [4.024, 2.126];
const DECK_RISE = [105.740, 106.083, 106.470, 106.870, 107.249, 107.570, 107.841, 108.062, 108.236, 108.360, 108.435, 108.440];
const CABLE_TIP = 105.740 + 11.813;
const CABLE_MIDDLE = 108.440 + 3.762;

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
  const index = (1 - Math.abs(2 * t - 1)) * (DECK_RISE.length - 1);
  const i = Math.min(DECK_RISE.length - 2, Math.floor(index));
  return blend(DECK_RISE[i], DECK_RISE[i + 1], index - i);
}

function bridgeWidth(t) {
  return blend(...BRIDGE_WIDTH, (1 - Math.abs(2 * t - 1)) ** 0.72);
}

function bridgeCable(t) {
  return blend(CABLE_MIDDLE, CABLE_TIP, (2 * t - 1) ** 2);
}

function bridgeParts(source, buildings, terrain) {
  const axis = bridgeAxis(source);
  const base = baseAt(source, terrain);
  const westAnchor = buildings.get(WEST.connectors[1]);
  const eastAnchor = buildings.get(EAST.connectors[1]);
  for (const [sourcePart, t] of [[westAnchor, 0], [eastAnchor, 1]]) {
    const p = axis(t, 0);
    if (!sourcePart.polygons.some(polygon => polygonContains(polygon, p.x, p.z))) {
      throw new Error(`Bridge axis misses the sourced tower attachment: ${sourcePart.id}`);
    }
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
    const mid = 1 - Math.abs(a + b - 1);
    add('bridge-deck', axis(a, yA), axis(b, yB), wA, wB, blend(0.734, 0.25, mid), 'djiDeck', 'design');
    add('suspension-cable', axis(a, base + bridgeCable(a)), axis(b, base + bridgeCable(b)), 0.12, 0.12, 0.12, 'djiSteel');
    for (const side of [-1, 1]) {
      add('bridge-guard', axis(a, yA + 1.08, side * (wA / 2 - 0.075)),
        axis(b, yB + 1.08, side * (wB / 2 - 0.075)), 0.15, 0.15, 1.08, 'djiGuard');
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

function wingBraces(wing, volume) {
  const points = volume.polygon.outer;
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { a, b, length: Math.hypot(b.x - a.x, b.z - a.z) };
  });
  const longest = Math.max(...edges.map(edge => edge.length));
  const capY = volume.maxY - 0.8;
  const kneeY = Math.max(volume.minY + 5, capY - 17.4);
  const placement = { baseSourceId: volume.baseSourceId };
  const braces = [];
  for (const { a, b, length } of edges) {
    if (length < longest * 0.57) continue;
    const pointAt = (t, y) => ({ x: blend(a.x, b.x, t), z: blend(a.z, b.z, t), y });
    const knee = pointAt(0.54, kneeY);
    for (const t of [0.035, 0.965]) {
      braces.push(spanPart(`${volume.id}:v-brace:${braces.length}`, wing, pointAt(t, capY), knee, 0.5, 0.53, 1.05, 'djiBrace', placement));
    }
    braces.push(spanPart(`${volume.id}:crossbeam:${braces.length}`, wing, pointAt(0.035, kneeY), pointAt(0.965, kneeY), 0.32, 0.32, 0.55, 'djiBrace', placement));
  }
  return braces;
}

function towerParts(tower, buildings, terrain, bridgeY, bridge) {
  const core = buildings.get(tower.core);
  const base = baseAt(core, terrain);
  const parts = footprintParts(core, base, 'djiCore');
  for (const id of tower.connectors) parts.push(...footprintParts(buildings.get(id), base, 'djiCore', { baseSourceId: core.id }));
  for (const [id, direction] of tower.wings) {
    const wing = buildings.get(id);
    const [lowerTop, upperBottom] = wingGap(wing, direction, base, bridgeY, bridge);
    if (!(wing.minHeight < lowerTop && lowerTop < upperBottom && upperBottom < wing.height)) {
      throw new Error(`Invalid suspended wing heights: ${wing.id}`);
    }
    const volumes = [
      ...footprintParts(wing, base, 'djiWing', { id: `${id}:lower`, max: lowerTop, derived: true, baseSourceId: core.id }),
      ...footprintParts(wing, base, 'djiWing', { id: `${id}:upper`, min: upperBottom, derived: true, baseSourceId: core.id })
    ];
    parts.push(...volumes, ...volumes.flatMap(volume => wingBraces(wing, volume)));
  }
  return parts;
}

function build(buildings, terrain) {
  const bridge = buildings.get(BRIDGE);
  const bridgeY = baseAt(bridge, terrain);
  return [
    ...towerParts(EAST, buildings, terrain, bridgeY, bridge),
    ...towerParts(WEST, buildings, terrain, bridgeY, bridge),
    ...bridgeParts(bridge, buildings, terrain)
  ];
}

export { sourceIds, build };
