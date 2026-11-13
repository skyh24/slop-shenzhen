import { TRAIN } from './dispatch.js';

export const NORTH_FRAME = Object.freeze({ center: [-3138.1, -7285.3], axis: [0.678056, 0.73501] });
export function northFrame({ center: [x, z], axis: [dx, dz] }) {
  return {
    toWorld: (u, v, y) => ({ x: x + dz * u + dx * v, y, z: z - dx * u + dz * v }),
    lateral: p => (p.x - x) * dz - (p.z - z) * dx,
    along: p => (p.x - x) * dx + (p.z - z) * dz
  };
}

const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const RAIL_PROFILE = [[-2400, 10.7], [-1100, 9.1], [-440, 8.62], [440, 8.62],
  [800, 9.6], [1150, 13.2], [1650, 20], [1950, 17.8]];
export function northRailHeight(v) {
  const i = RAIL_PROFILE.findIndex(p => p[0] > v);
  if (i === 0) return RAIL_PROFILE[0][1];
  if (i < 0) return RAIL_PROFILE.at(-1)[1];
  const [a, y] = RAIL_PROFILE[i - 1], [b, z] = RAIL_PROFILE[i];
  return mix(y, z, smooth((v - a) / (b - a)));
}

export function sampleRail(path, s, out = {}) {
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s < path[mid].s) hi = mid;
    else lo = mid;
  }
  const a = path[lo], b = path[hi];
  const t = (s - a.s) / (b.s - a.s);
  out.x = mix(a.x, b.x, t);
  out.y = mix(a.y, b.y, t);
  out.z = mix(a.z, b.z, t);
  return out;
}

function sectionAt(points, v, frame) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const s = frame.along(a), t = frame.along(b);
    if (Math.min(s, t) <= v && v < Math.max(s, t)) {
      const fraction = (v - s) / (t - s);
      return { u: mix(frame.lateral(a), frame.lateral(b), fraction), s: mix(a.s, b.s, fraction) };
    }
  }
  return null;
}

export function createNorthRailLayout(data) {
  if (!data) return null;
  const frame = northFrame(data);
  const nodes = data.nodes.map(([, x, z]) => ({ x, z, y: northRailHeight(frame.along({ x, z })) }));
  const degree = new Uint16Array(nodes.length);
  const segments = data.edges.map(([a, b, way], index) => {
    degree[a]++; degree[b]++;
    const start = nodes[a], end = nodes[b];
    const count = Math.max(1, Math.ceil(Math.hypot(start.x - end.x, start.z - end.z) / 12));
    const points = Array.from({ length: count + 1 }, (_, i) => {
      if (i === 0) return start;
      if (i === count) return end;
      const p = { x: mix(start.x, end.x, i / count), z: mix(start.z, end.z, i / count) };
      return { ...p, y: northRailHeight(frame.along(p)) };
    });
    return { a, b, points, way: data.ways[way], index };
  });
  for (const segment of segments) {
    const { a, b, index } = segment;
    segment.resources = [`rail-edge:${index}`, ...[a, b].filter(n => degree[n] > 2).map(n => `switch:${data.nodes[n][0]}`)];
    // 同一接入端按独立轨道占用。以每段共享轨道及道岔节点约束进路。
  }
  const routes = data.routes.map(route => {
    let s = 0, previous;
    const points = [], blocks = [];
    for (const edge of route.edges) {
      const segment = segments[Math.abs(edge) - 1];
      const chain = edge < 0 ? [...segment.points].reverse() : segment.points;
      const begin = s;
      for (const point of previous ? chain.slice(1) : chain) {
        if (previous) s += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z);
        points.push({ ...point, s });
        previous = point;
      }
      blocks.push({ begin, end: s, ids: segment.resources, sourceId: segment.way.id });
    }
    const middle = sectionAt(points, 0, frame).s;
    const stop = middle + TRAIN.length / 2 + 2;
    const berthExit = middle + 132;
    // 道岔等资源可以跨分界，停靠时保留整个列车及安全余量内的锁。
    const inbound = [...new Set(blocks.filter(b => b.begin < stop + 4).flatMap(b => b.ids))];
    const outbound = [...new Set(blocks.filter(b => b.end > stop - TRAIN.length - 4).flatMap(b => b.ids))];
    const outgoing = new Set(outbound);
    const incoming = new Set(inbound);
    const parked = inbound.filter(id => outgoing.has(id));
    const retained = new Set(parked);
    const inboundTail = new Map();
    const outboundTail = new Map();
    for (const block of blocks) for (const id of block.ids) {
      if (incoming.has(id) && !retained.has(id)) inboundTail.set(id, block.end);
      if (outgoing.has(id)) outboundTail.set(id, block.end);
    }
    return { ...route, id: `north-${route.berth}`, berth: `berth:${route.berth}`, points, length: s, stop, berthExit,
      blocks, inbound, outbound, parked, inboundTail, outboundTail,
      switches: [...new Set(blocks.flatMap(b => b.ids.filter(id => id.startsWith('switch:'))))] };
  });
  const ordered = [...routes].sort((a, b) => sectionAt(a.points, 0, frame).u - sectionAt(b.points, 0, frame).u);
  const pairs = [[null, 0], ...Array.from({ length: 9 }, (_, i) => [i * 2 + 1, i * 2 + 2]), [19, null]];
  const platforms = pairs.map(([west, east], index) => {
    const stations = Array.from({ length: 33 }, (_, i) => {
      const v = -210 + i * 420 / 32;
      const low = west == null ? null : sectionAt(ordered[west].points, v, frame)?.u + 1.95;
      const high = east == null ? null : sectionAt(ordered[east].points, v, frame)?.u - 1.95;
      return { v, left: low ?? high - 7.2, right: high ?? low + 7.2 };
    });
    return { index, stations };
  });
  return { ...frame, segments, routes, platforms };
}

const ROAD_CROSSINGS = new Set([377627514, 377627515, 377627517, 539239994, 539239998, 539240020, 1247496396, 1247496434]
  .map(id => `way/${id}`));
export function northBridgeProfile(data) {
  if (!data) return null;
  const { lateral } = northFrame(data);
  return {
    id: 'north-station-crossings', sourceIds: ROAD_CROSSINGS,
    height: (point, proposed) => {
      const distance = Math.max(0, Math.abs(lateral(point)) - 107);
      return Math.max(proposed, 17.3 - distance * 0.21);
    },
    allowsPier: point => Math.abs(lateral(point)) > 109
  };
}
