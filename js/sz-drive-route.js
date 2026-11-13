import { routeSignalStops } from './sz-intersection-control.js';
import { usableWidth } from './sz-road-section.js';
import { laneRoute, poseOnRoute } from './sz-traffic.js';

const SNAP_RADIUS = 44;
const SNAP_ALTERNATIVES = 7;
const TURN_BEND = 9;
const CURVATURE_LIMIT = 0.18;
const CRUISE = 80 / 3.6;
const PLANNING_BRAKE = 2;
const SNAP_CELL = 48;
const NEARBY_LAYERS = 12;
const SNAP_COST = 0.65;
const MAX_ATTEMPTS = 8;
const FALLBACK_KPH = {
  motorway: 80, trunk: 80, primary: 60, secondary: 50, tertiary: 40,
  residential: 30, living_street: 20, service: 20, unclassified: 30
};

function speedLimit(edge, rules) {
  const width = edge.elevated ? edge.section.pavementWidthM : edge.section.travelWidthM;
  const ramp = edge.highway?.endsWith('_link');
  const fallback = ramp ? 35 : FALLBACK_KPH[edge.highway] ?? 40;
  const posted = rules?.maxKph?.[edge.sign === -1 ? 'backward' : 'forward'] ?? rules?.maxKph?.both;
  return Math.min(CRUISE, (posted ?? fallback) / 3.6,
    width < 4.5 ? 4 : width < 6.5 ? 5.5 : Infinity, ramp ? 40 / 3.6 : Infinity);
}

function allowsCar(edge, rules, model) {
  return !rules || (!rules.closed?.includes('both')
    && !rules.closed?.includes(edge.sign === -1 ? 'backward' : 'forward')
    && (rules.maxheight ?? Infinity) >= model.hy * 2
    && (rules.maxwidth ?? Infinity) >= model.hx * 2
    && (rules.maxlength ?? Infinity) >= model.hz * 2
    && (rules.maxweight ?? Infinity) >= (model.massKg ?? 2000) / 1000);
}

export function createTurnFilter(graph) {
  const byApproach = new Map();
  for (const rule of graph.turnRestrictions?.rules ?? []) {
    const key = `${rule.fromWayId}/${rule.viaNodeId}`;
    if (!byApproach.has(key)) byApproach.set(key, []);
    byApproach.get(key).push(rule);
  }
  return (edge, next) => {
    const rules = byApproach.get(`${edge.osmId}/${graph.nodeIds[edge.to]}`) ?? [];
    return rules.every(rule => {
      const only = rule.restriction.startsWith('only_');
      // 多段 via-way 的离开条件尚未求解，暂时在已确认的入口保守过滤。
      if (rule.viaWayIds.length) return !only && next.osmId !== rule.viaWayIds[0];
      const matches = rule.toWayIds.includes(next.osmId);
      if (only) return matches;
      if (rule.restriction === 'no_u_turn' && edge.osmId === next.osmId && next.to !== edge.from) return true;
      return !matches;
    });
  };
}

function minQueue() {
  const items = [];
  return {
    push(value) {
      let i = items.length;
      while (i > 0) {
        const parent = (i - 1) >>> 1;
        if (items[parent].cost <= value.cost) break;
        items[i] = items[parent];
        i = parent;
      }
      items[i] = value;
    },
    pop() {
      const first = items[0];
      const last = items.pop();
      if (items.length) {
        let i = 0;
        while (2 * i + 1 < items.length) {
          let child = 2 * i + 1;
          if (child + 1 < items.length && items[child + 1].cost < items[child].cost) child++;
          if (items[child].cost >= last.cost) break;
          items[i] = items[child];
          i = child;
        }
        items[i] = last;
      }
      return first;
    }
  };
}

function routeKey(a, b) {
  return `${a.sourceIndex}:${a.to}/${b.sourceIndex}:${b.to}`;
}

function findPath(starts, ends, roads, canTurn, blockedEdges, blockedTurns, control) {
  const queue = minQueue();
  const best = new Map();
  let goal = null;
  for (const start of starts) {
    if (!blockedEdges.has(start.edge)) queue.push({ edge: start.edge, start, cost: start.error * SNAP_COST, enterS: start.s, prev: null });
  }
  for (let current = queue.pop(); current; current = queue.pop()) {
    const { edge, cost, enterS, start, prev } = current;
    if (goal && cost >= goal.cost) break;
    if (prev && best.get(edge) !== current) continue;
    const { length, speed } = roads.get(edge);
    for (const end of ends) {
      const total = cost + (end.s - enterS) / speed + end.error * SNAP_COST;
      if (edge === end.edge && end.s >= enterS + (prev ? 0 : 5) && total < (goal?.cost ?? Infinity)) {
        goal = { current, end, cost: total };
      }
    }
    const approach = control?.approachFor?.(edge.sourceIndex, edge.to);
    const exitCost = cost + (length - enterS) / speed + (approach ? 3 : 0);
    const last = edge.segments.at(-1);
    for (const next of edge.next) {
      if (!roads.has(next) || blockedEdges.has(next) || blockedTurns.has(routeKey(edge, next))
        || !canTurn(edge, next)) continue;
      const first = next.segments[0];
      const transitionCost = exitCost + 2.5 * (1 - last.dx * first.dx - last.dz * first.dz);
      if (transitionCost >= (best.get(next)?.cost ?? Infinity)) continue;
      const step = { edge: next, start, cost: transitionCost, enterS: 0, prev: current };
      best.set(next, step);
      queue.push(step);
    }
  }
  if (!goal) return null;
  const path = [];
  for (let state = goal.current; state; state = state.prev) path.push(state.edge);
  return { path: path.reverse(), start: goal.current.start, end: goal.end };
}

function laneSegments({ path, start, end }, roads) {
  return path.flatMap((edge, i) => {
    const { offset, length } = roads.get(edge);
    const from = i === 0 ? start.s : 0;
    const to = i === path.length - 1 ? end.s : length;
    let accumulated = 0;
    const segments = [];
    for (const seg of edge.segments) {
      const first = Math.max(0, from - accumulated);
      const last = Math.min(seg.length, to - accumulated);
      if (last > first) segments.push({ ...seg, edge, length: last - first,
        x: seg.x + seg.dx * first - seg.dz * offset, z: seg.z + seg.dz * first + seg.dx * offset });
      accumulated += seg.length;
    }
    return segments;
  });
}

function validateSamples(samples, model, roadHeight, isClear, stops, roads) {
  const limits = samples.map(sample => roads.get(sample.edge).speed);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const turn = Math.atan2(a.dz * b.dx - a.dx * b.dz, a.dx * b.dx + a.dz * b.dz);
    const curvature = Math.abs(turn) / (b.s - a.s);
    if (curvature > CURVATURE_LIMIT) return { failedAt: (a.s + b.s) / 2 };
    const limit = Math.sqrt(2.25 / Math.max(curvature, 0.001));
    limits[i - 1] = Math.min(limits[i - 1], limit);
    limits[i] = Math.min(limits[i], limit);
  }
  // 即使当前是绿灯，进路口也先降速。预计用时另加平均等待。
  let stopIndex = 0;
  for (let i = 0; i < samples.length && stopIndex < stops.length; i++) {
    const s = samples[i].s;
    while (stopIndex < stops.length && s > stops[stopIndex].clearS) stopIndex++;
    if (stopIndex < stops.length && s >= stops[stopIndex].s - model.hz - 1) limits[i] = Math.min(limits[i], 10);
  }
  const pose = {};
  const length = samples.at(-1).s;
  // 冲突区的弯道出口按更小步距复核，避免预约后才碰到很窄的路缘缺口。
  const spans = [[0, length, 0.75], ...stops.map(stop => [Math.max(0, stop.s - model.hz - 1), stop.clearS, 0.125])];
  for (const [first, last, spacing] of spans) {
    const steps = Math.max(1, Math.ceil((last - first) / spacing));
    for (let i = 0; i <= steps; i++) {
      const s = first + (last - first) * i / steps;
      if (!poseOnRoute(samples, s, model, roadHeight, pose)
        || !isClear(pose)) return { failedAt: s };
    }
  }
  limits[limits.length - 1] = 0;
  for (let i = limits.length - 2; i >= 0; i--) {
    limits[i] = Math.min(limits[i], Math.sqrt(limits[i + 1] ** 2 + 2 * PLANNING_BRAKE * (samples[i + 1].s - samples[i].s)));
  }
  return { limits };
}

function excludeNearFailure(samples, s, edges, turns) {
  let closest = samples[0];
  let turn = null;
  let distance = TURN_BEND + 1;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (Math.abs(b.s - s) < Math.abs(closest.s - s)) closest = b;
    const gap = Math.abs((a.s + b.s) / 2 - s);
    if (a.edge !== b.edge && gap < distance) {
      turn = routeKey(a.edge, b.edge);
      distance = gap;
    }
  }
  if (turn) turns.add(turn);
  else edges.add(closest.edge);
}

export function createDrivePlanner(network, graph, { model, roadHeight, isClear, control, detailedRoadIds = [] }) {
  const roads = new Map();
  const cells = new Map();
  const neighbors = new Map();
  const detailed = new Set(detailedRoadIds);
  const canTurn = createTurnFilter(graph);
  const intersectionMargin = Math.hypot(model.hx, model.hz) + 0.35;
  const key = (x, z) => `${x},${z}`;
  for (const edge of network.edges) {
    for (const [node, neighbor] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      if (!neighbors.has(node)) neighbors.set(node, new Set());
      neighbors.get(node).add(neighbor);
    }
    const rules = graph.metadata[edge.sourceIndex]?.drive;
    if (!usableWidth(edge, model.hx) || !allowsCar(edge, rules, model)) continue;
    const offsets = edge.section.routeOffsetsM.filter(offset => Math.abs(offset) + model.hx + 0.12 <= edge.section.travelWidthM / 2);
    const lane = edge.section.twoWay || detailed.has(edge.osmId) ? offsets.at(-1)
      : offsets.reduce((best, offset) => best === undefined || Math.abs(offset) < Math.abs(best) ? offset : best, undefined);
    if (lane === undefined) continue;
    const length = edge.segments.reduce((sum, seg) => sum + seg.length, 0);
    roads.set(edge, { offset: lane, length, speed: speedLimit(edge, rules) });
    let along = 0;
    for (const seg of edge.segments) {
      const x = seg.x - seg.dz * lane, z = seg.z + seg.dx * lane;
      const endX = x + seg.dx * seg.length, endZ = z + seg.dz * seg.length;
      const entry = { edge, seg, x, z, along };
      along += seg.length;
      for (let ix = Math.floor(Math.min(x, endX) / SNAP_CELL); ix <= Math.floor(Math.max(x, endX) / SNAP_CELL); ix++) {
        for (let iz = Math.floor(Math.min(z, endZ) / SNAP_CELL); iz <= Math.floor(Math.max(z, endZ) / SNAP_CELL); iz++) {
          const id = key(ix, iz);
          if (!cells.has(id)) cells.set(id, []);
          cells.get(id).push(entry);
        }
      }
    }
  }

  function snap(x, z, { car = null } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const nearby = new Set();
    for (let ix = Math.floor((x - SNAP_RADIUS) / SNAP_CELL); ix <= Math.floor((x + SNAP_RADIUS) / SNAP_CELL); ix++) {
      for (let iz = Math.floor((z - SNAP_RADIUS) / SNAP_CELL); iz <= Math.floor((z + SNAP_RADIUS) / SNAP_CELL); iz++) {
        for (const entry of cells.get(key(ix, iz)) ?? []) nearby.add(entry);
      }
    }
    const probes = [];
    const margin = model.hz + 0.5;
    for (const { edge, seg, x: laneX, z: laneZ, along } of nearby) {
      const { length } = roads.get(edge);
      // 停车时车身不能占用交叉口、匝道鼻端或边端；信号冲突区再按实际边界退让。
      const first = Math.max(margin, ((neighbors.get(edge.from)?.size ?? 0) > 2 ? 9 + margin : margin) - along);
      const last = Math.min(seg.length - margin,
        length - ((neighbors.get(edge.to)?.size ?? 0) > 2 ? 9 + margin : margin) - along);
      if (last < first) continue;
      const projected = (x - laneX) * seg.dx + (z - laneZ) * seg.dz;
      const u = Math.max(first, Math.min(last, projected));
      const level = edge.tunnel ? 'tunnel' : edge.surfaceId ? 'elevated' : 'ground';
      const heightLayer = edge.section.layer;
      for (const delta of [0, -3, 3, -6, 6, -10, 10, -16, 16, -24, 24]) {
        if (u + delta < first || u + delta > last) continue;
        const px = laneX + seg.dx * (u + delta), pz = laneZ + seg.dz * (u + delta);
        const error = Math.hypot(px - x, pz - z);
        if (error > SNAP_RADIUS || (level === 'ground' && control?.contains(px, pz, intersectionMargin))) continue;
        probes.push({ x: px, z: pz, dx: seg.dx, dz: seg.dz, s: along + u + delta, edge, error, level, heightLayer });
      }
    }
    probes.sort((a, b) => a.error - b.error);
    const pose = {};
    const groups = [];
    const seen = new Set();
    for (const p of probes) {
      if (groups.length && p.error > groups[0].error + NEARBY_LAYERS) break;
      if (seen.has(p.edge)) continue;
      const ahead = { ...p, x: p.x + p.dx, z: p.z + p.dz, s: p.s + 1 };
      if (!poseOnRoute([p, ahead], p.s, model, roadHeight, pose) || !isClear(pose)) continue;
      seen.add(p.edge);
      const y = roadHeight(p.x, p.z, p.edge);
      let group = groups.find(g => g.level === p.level && g.heightLayer === p.heightLayer && Math.abs(g.y - y) < 2.5);
      if (!group) {
        group = { level: p.level, heightLayer: p.heightLayer, name: p.edge.name, y, x: p.x, z: p.z, error: p.error, candidates: [] };
        groups.push(group);
      }
      if (group.candidates.length < 6 && p.error <= group.error + SNAP_ALTERNATIVES) group.candidates.push({ ...p, y });
    }
    if (!groups.length) return null;
    const aligned = car && Math.abs(car.speed) <= 0.3 && Math.hypot(car.position.x - x, car.position.z - z) <= 8
      ? groups.flatMap(g => g.candidates).find(p => Math.hypot(car.position.x - p.x, car.position.z - p.z) <= 0.6
        && (p.edge.surfaceId ?? 'terrain') === car._support?.surfaceId
        && Math.sin(car.heading) * p.dx + Math.cos(car.heading) * p.dz >= 0.97)
      : null;
    if (aligned) {
      const group = groups.find(g => g.candidates.includes(aligned));
      const choice = { ...group, x: aligned.x, z: aligned.z, y: aligned.y, candidates: [aligned] };
      return { ...choice, levels: [choice] };
    }
    return { ...groups[0], levels: groups };
  }

  function route(start, end, { blockedEdge = null } = {}) {
    if (!start?.candidates.length || !end?.candidates.length) return null;
    const blockedEdges = new Set(blockedEdge ? [blockedEdge] : []);
    const blockedTurns = new Set();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = findPath(start.candidates, end.candidates, roads, canTurn, blockedEdges, blockedTurns, control);
      if (!result) return null;
      const samples = laneRoute(laneSegments(result, roads), TURN_BEND);
      if (samples.length < 2) return null;
      const stops = routeSignalStops(samples, control, intersectionMargin);
      if (stops.some(stop => !Number.isFinite(stop.clearS))) return null;
      const { limits, failedAt } = validateSamples(samples, model, roadHeight, isClear, stops, roads);
      if (!limits) {
        excludeNearFailure(samples, failedAt, blockedEdges, blockedTurns);
        continue;
      }
      const seconds = samples.slice(1).reduce((total, sample, i) =>
        total + 2 * (sample.s - samples[i].s) / Math.max(1, limits[i] + limits[i + 1]), 3 * stops.length + 2);
      return { samples, limits, stops, seconds, length: samples.at(-1).s,
        from: samples[0], to: samples.at(-1), edges: result.path, destination: end,
        surfaces: [...new Set(result.path.map(edge => edge.surfaceId).filter(Boolean))] };
    }
    return null;
  }

  function replan(current, car, edge, failedEdge) {
    const { x, z } = car.position;
    const candidates = snap(x, z, { car })?.candidates.filter(p => p.edge === edge
      && p.error <= 0.6 && (p.edge.surfaceId ?? 'terrain') === car._support?.surfaceId
      && Math.sin(car.heading) * p.dx + Math.cos(car.heading) * p.dz >= 0.97);
    return route({ candidates: candidates ?? [] }, current.destination, { blockedEdge: failedEdge });
  }

  return { snap, route, replan };
}
