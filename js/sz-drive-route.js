import { routeSignalStops } from './sz-intersection-control.js';
import { laneOffsets, laneRoute, poseOnRoute, usableWidth } from './sz-traffic.js';

const SNAP_RADIUS = 44;
const SNAP_ALTERNATIVES = 7;
const TURN_BEND = 9;
const CURVATURE_LIMIT = 0.18;
const CRUISE = 10.5;
const MAX_ATTEMPTS = 8;

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

function findPath(starts, ends, roads, canTurn, blockedEdges, blockedTurns) {
  const queue = minQueue();
  const best = new Map();
  let goal = null;
  for (const start of starts) {
    if (!blockedEdges.has(start.edge)) queue.push({ edge: start.edge, start, cost: start.error * 2, enterS: start.s, prev: null });
  }
  for (let current = queue.pop(); current; current = queue.pop()) {
    const { edge, cost, enterS, start, prev } = current;
    if (goal && cost >= goal.cost) break;
    if (prev && best.get(edge) !== current) continue;
    for (const end of ends) {
      const total = cost + end.s - enterS + end.error * 2;
      if (edge === end.edge && end.s >= enterS + (prev ? 0 : 5) && total < (goal?.cost ?? Infinity)) {
        goal = { current, end, cost: total };
      }
    }
    const exitCost = cost + roads.get(edge).length - enterS;
    for (const next of edge.next) {
      if (!roads.has(next) || blockedEdges.has(next) || blockedTurns.has(routeKey(edge, next))
        || !canTurn(edge, next) || exitCost >= (best.get(next)?.cost ?? Infinity)) continue;
      const step = { edge: next, start, cost: exitCost, enterS: 0, prev: current };
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

function validateSamples(samples, model, roadHeight, isClear, stops) {
  const limits = samples.map(() => CRUISE);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const turn = Math.atan2(a.dz * b.dx - a.dx * b.dz, a.dx * b.dx + a.dz * b.dz);
    const curvature = Math.abs(turn) / (b.s - a.s);
    if (curvature > CURVATURE_LIMIT) return { failedAt: (a.s + b.s) / 2 };
    const limit = Math.sqrt(2.25 / Math.max(curvature, 0.001));
    limits[i - 1] = Math.min(limits[i - 1], limit);
    limits[i] = Math.min(limits[i], limit);
  }
  const pose = {};
  const length = samples.at(-1).s;
  // 冲突区的弯道出口按更小步距复核，避免预约后才碰到很窄的路缘缺口。
  const spans = [[0, length, 0.75], ...stops.map(stop => [Math.max(0, stop.s - model.hz - 1), stop.clearS, 0.125])];
  for (const [first, last, spacing] of spans) {
    const steps = Math.ceil((last - first) / spacing);
    for (let i = 0; i <= steps; i++) {
      const s = first + (last - first) * i / steps;
      if (!poseOnRoute(samples, s, model, roadHeight, pose) || !isClear(pose)) return { failedAt: s };
    }
  }
  limits[limits.length - 1] = 0;
  for (let i = limits.length - 2; i >= 0; i--) {
    limits[i] = Math.min(limits[i], Math.sqrt(limits[i + 1] ** 2 + 4 * (samples[i + 1].s - samples[i].s)));
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
  const detailed = new Set(detailedRoadIds);
  const canTurn = createTurnFilter(graph);
  const intersectionMargin = Math.hypot(model.hx, model.hz) + 0.35;
  for (const edge of network.edges) {
    if (!usableWidth(edge, model.hx)) continue;
    const lane = !edge.direction || detailed.has(edge.osmId)
      ? laneOffsets(edge).findLast(offset => Math.abs(offset) + model.hx + 0.12 <= edge.width / 2) : 0;
    if (lane === undefined) continue;
    roads.set(edge, { offset: lane, length: edge.segments.reduce((sum, seg) => sum + seg.length, 0) });
  }

  function snap(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const candidates = [];
    const margin = model.hz + 0.5;
    for (const [edge, { offset }] of roads) {
      let along = 0;
      let best = null;
      for (const seg of edge.segments) {
        if (seg.length > margin * 2) {
          const u = Math.max(margin, Math.min(seg.length - margin, (x - seg.x) * seg.dx + (z - seg.z) * seg.dz));
          const px = seg.x + seg.dx * u - seg.dz * offset;
          const pz = seg.z + seg.dz * u + seg.dx * offset;
          const error = Math.hypot(px - x, pz - z);
          if (error <= SNAP_RADIUS && (!best || error < best.error) && !control?.contains(px, pz, intersectionMargin)) {
            best = { x: px, z: pz, dx: seg.dx, dz: seg.dz, edge, s: along + u, error };
          }
        }
        along += seg.length;
      }
      if (best) candidates.push(best);
    }
    candidates.sort((a, b) => a.error - b.error);
    const pose = {};
    const near = candidates.filter(item => item.error <= candidates[0].error + SNAP_ALTERNATIVES).filter(p => {
      const ahead = { ...p, x: p.x + p.dx, z: p.z + p.dz, s: p.s + 1 };
      return poseOnRoute([p, ahead], p.s, model, roadHeight, pose) && isClear(pose);
    }).slice(0, 4);
    return near.length ? { x: near[0].x, z: near[0].z, candidates: near } : null;
  }

  function route(start, end) {
    const blockedEdges = new Set();
    const blockedTurns = new Set();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = findPath(start.candidates, end.candidates, roads, canTurn, blockedEdges, blockedTurns);
      if (!result) return null;
      const segments = laneSegments(result, roads);
      const samples = laneRoute(segments, TURN_BEND);
      if (samples.length < 2) return null;
      const stops = routeSignalStops(samples, control, intersectionMargin);
      if (stops.some(stop => !Number.isFinite(stop.clearS))) return null;
      const { limits, failedAt } = validateSamples(samples, model, roadHeight, isClear, stops);
      if (!limits) {
        excludeNearFailure(samples, failedAt, blockedEdges, blockedTurns);
        continue;
      }
      return { samples, limits, stops, length: samples.at(-1).s,
        from: samples[0], to: samples.at(-1), edges: result.path };
    }
    return null;
  }

  return { snap, route };
}
