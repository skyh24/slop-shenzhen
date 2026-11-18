import { routeSignalStops } from './sz-intersection-control.js';
import { laneOffsets, usableWidth } from './sz-road-section.js';
import { laneRoute, poseOnRoute } from './sz-road-trajectory.js';

const SNAP_RADIUS = 44;
const SNAP_ALTERNATIVES = 7;
const TURN_BEND = 9;
const CURVATURE_LIMIT = 0.18;
// 弯道最低限速：再急的弯也保持前进，直角弯不再把车速压到 4 m/s 以下。
const CURVE_MIN_SPEED = 5.5;
// 弯道横向加速度预算与车辆抓地一致；按舒适度算会在真实车道的缓弯里无故降速。
const CURVE_LATERAL_ACCELERATION = 9.5;
// 曲率测量窗口：折线离散化的定点转角不能当作真实弯道曲率。
const CURVATURE_WINDOW = 6;
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
  const curveLimits = samples.map(() => Infinity);
  // 曲率取前后各约 6 米的弦：折线顶点、路段接缝的单点转角会被放大成尖峰曲率，
  // 按段逐点计算会让明显可过的缓弯也触发减速和白刹车。
  let before = 0;
  for (let i = 1, after = 1; i < samples.length - 1; i++) {
    while (before < i - 1 && samples[before + 1].s <= samples[i].s - CURVATURE_WINDOW) before++;
    while (after < samples.length - 1 && samples[after].s < samples[i].s + CURVATURE_WINDOW) after++;
    const a = samples[before], b = samples[i], c = samples[after];
    const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    if (Math.min(ab, bc, ca) < 1e-3) continue;
    // 三点外接圆曲率：对圆弧精确，也不受采样步长影响。
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const curvature = 2 * Math.abs(cross) / (ab * bc * ca);
    if (curvature > CURVATURE_LIMIT) return { failedAt: b.s };
    const limit = Math.max(CURVE_MIN_SPEED, Math.sqrt(CURVE_LATERAL_ACCELERATION / Math.max(curvature, 0.001)));
    curveLimits[i] = Math.min(curveLimits[i], limit);
    limits[i] = Math.min(limits[i], limit);
  }
  // 即使当前是绿灯，进路口也先降速。预计用时另加平均等待。
  let stopIndex = 0;
  for (let i = 0; i < samples.length && stopIndex < stops.length; i++) {
    const s = samples[i].s;
    while (stopIndex < stops.length && s > stops[stopIndex].clearS) stopIndex++;
    if (stopIndex < stops.length && s >= stops[stopIndex].s - model.hz - 1) limits[i] = Math.min(limits[i], 10);
  }
  // 窄车道按路宽再压一档限速：车身几乎占满铺装，只有慢速才能让四轮保持在同一块路面上。
  for (let i = 0; i < samples.length; i++) {
    const edge = samples[i].edge;
    // 高架保留以桥面铺装宽分档的限速；护栏净宽用于车道和车身余量。
    const width = edge?.elevated ? edge.section.pavementWidthM : edge?.section.travelWidthM ?? 0;
    if (edge?.rampSpeed) limits[i] = Math.min(limits[i], edge.rampSpeed);
    if (width > 0 && width < 6.5) limits[i] = Math.min(limits[i], width < 4.5 ? 4 : 5.5);
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
    const braking = 2 * PLANNING_BRAKE * (samples[i + 1].s - samples[i].s);
    limits[i] = Math.min(limits[i], Math.sqrt(limits[i + 1] ** 2 + braking));
    // 巡航复用曲率与提前制动，路线片段末端不作为停车点。
    curveLimits[i] = Math.min(curveLimits[i], Math.sqrt(curveLimits[i + 1] ** 2 + braking));
  }
  return { limits, curveLimits };
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
  const structureSeams = new Set();
  for (const edge of network.edges) {
    for (const next of edge.next) {
      if (edge.structureNeighbors || next.structureNeighbors) {
        structureSeams.add(edge);
        structureSeams.add(next);
      }
    }
  }
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
    const { section } = edge;
    // 双向路取本侧最靠路缘的车道，单向详细路沿用最右侧；无车道数据时退回默认偏移。
    const offsets = (laneOffsets(section) ?? section.routeOffsetsM)
      .filter(offset => Math.abs(offset) + model.hx + 0.12 <= section.travelWidthM / 2);
    const lane = edge.highway === 'motorway' || section.twoWay || detailed.has(edge.osmId) ? offsets.at(-1)
      : structureSeams.has(edge) ? 0
      : offsets.reduce((best, offset) => best === undefined || Math.abs(offset) < Math.abs(best) ? offset : best, undefined);
    // 兜底车道同样必须落在本侧半幅内，否则该边不参与规划。
    if (lane === undefined || Math.abs(lane) > section.travelWidthM / 2) continue;
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
      // 结构的中心线折点不是路口；停车退距只从实际链路端点算。
      const first = Math.max(edge.structureNeighbors ? 0 : margin,
        ((neighbors.get(edge.from)?.size ?? 0) > 2 ? 9 + margin : margin) - along);
      const last = Math.min(seg.length - (edge.structureNeighbors ? 0 : margin),
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

  // 巡航车道偏移与 planCruise 的 side、laneSegments 的 offset 同为“行驶方向右侧为正”。
  // 双向路两个方向都取 laneOffsets（只含本侧半幅）；无车道数据时用同侧中心数组换算。
  function cruiseLanes(edge) {
    const { section } = edge;
    const width = edge.sign === 1 ? section.forwardLaneWidthM : section.backwardLaneWidthM;
    if (width < model.hx * 2 + 0.15) return section.defaultOffsetsM;
    const lanes = laneOffsets(section);
    if (lanes) return lanes;
    const centers = section.twoWay || edge.sign === 1 ? section.forwardCentersM : section.backwardCentersM;
    return centers.map(center => -center).reverse();
  }

  function cruiseContinuation(edge) {
    const { dx, dz } = edge.segments.at(-1);
    const candidates = edge.next.filter(next => roads.has(next) && canTurn(edge, next)).map(next => ({
      next, sameWay: Boolean(edge.osmId && next.osmId === edge.osmId),
      sameName: Boolean(edge.name && next.name === edge.name),
      straight: dx * next.segments[0].dx + dz * next.segments[0].dz
    }));
    const sameWay = candidates.filter(c => c.sameWay);
    const sameName = candidates.filter(c => c.sameName);
    if (sameWay.length === 1) return sameWay[0].next;
    if (!sameWay.length && sameName.length === 1) return sameName[0].next;
    const options = (sameWay.length ? sameWay : sameName.length ? sameName : candidates)
      .filter(c => c.straight >= 0.85).sort((a, b) => b.straight - a.straight);
    if (options[0] && (!options[1] || options[0].straight - options[1].straight > 0.12)) return options[0].next;
    return null;
  }

  function planCruise(car, previousEdge = null) {
    const { x, y, z } = car.position;
    const { surfaceId = 'terrain' } = car._support ?? {};
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const candidates = [];
    for (const { edge, segment: index } of network.nearSegments(x, z, 9)) {
      if (!roads.has(edge) || (edge.surfaceId ?? 'terrain') !== surfaceId) continue;
      if (previousEdge && edge !== previousEdge && !previousEdge.next.includes(edge)) continue;
      const seg = edge.segments[index];
      const heading = sin * seg.dx + cos * seg.dz;
      if (heading < 0.87) continue;
      const along = (x - seg.x) * seg.dx + (z - seg.z) * seg.dz;
      if (along < -0.8 || along > seg.length + 0.8) continue;
      const side = (x - seg.x) * -seg.dz + (z - seg.z) * seg.dx;
      const lanes = cruiseLanes(edge);
      const lengthBefore = edge.segments.slice(0, index).reduce((sum, part) => sum + part.length, 0);
      for (let lane = 0; lane < lanes.length; lane++) {
        const error = Math.abs(side - lanes[lane]);
        if (error <= 1.65) candidates.push({ edge, lane, s: lengthBefore + Math.max(0, Math.min(seg.length, along)),
          score: error + 4 * (1 - heading) });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const margin = model.hz + model.z + 1.25;
    for (const start of candidates.slice(0, 3)) {
      const height = roadHeight(x, z, start.edge);
      if (!Number.isFinite(height) || Math.abs(height - y) > 0.26) continue;
      const path = [];
      const selectedRoads = new Map();
      let distance = -start.s, next = start.edge;
      while (next && !selectedRoads.has(next) && path.length < 48 && distance < 900) {
        const lanes = cruiseLanes(next);
        // 并入段车道较少时提前交回，避免巡航在没有换道指令时横移。
        if (start.lane >= lanes.length) { next = null; break; }
        const length = roads.get(next).length;
        selectedRoads.set(next, { length, offset: lanes[start.lane],
          speed: roads.get(next).speed });
        path.push(next);
        distance += length;
        next = cruiseContinuation(next);
      }
      const last = path.at(-1);
      const continues = Boolean(next && !selectedRoads.has(next) && start.lane < cruiseLanes(next).length);
      if (!last || distance < 6 + margin) continue;
      let samples = laneRoute(laneSegments({ path, start: { s: Math.max(0, start.s - 9) },
        end: { s: selectedRoads.get(last).length - margin } }, selectedRoads), TURN_BEND);
      for (let attempt = 0; attempt < 2 && samples.length >= 2; attempt++) {
        let stops = routeSignalStops(samples, control, intersectionMargin);
        const incomplete = stops.find(stop => !Number.isFinite(stop.clearS));
        if (incomplete) {
          samples = samples.filter(p => p.s <= incomplete.s - margin);
          stops = stops.filter(stop => stop.clearS < (samples.at(-1)?.s ?? 0));
        }
        if (samples.length < 2) break;
        const length = samples.at(-1).s;
        const { limits, curveLimits, failedAt } = validateSamples(samples, model, roadHeight, isClear, stops, selectedRoads);
        if (limits) return { samples, stops, length, curveLimits,
          continues: continues && attempt === 0 && !incomplete };
        samples = samples.filter(p => p.s <= failedAt - margin);
      }
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

  return { snap, route, replan, planCruise };
}
