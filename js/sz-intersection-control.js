const CYCLE = 8;
const REQUEST_TIMEOUT = 0.5;

export function signalPhase(group, elapsedSeconds) {
  if ((group !== 0 && group !== 1) || !Number.isFinite(elapsedSeconds)) throw new Error('Invalid signal phase input');
  const local = ((elapsedSeconds - group * 4) % CYCLE + CYCLE) % CYCLE;
  return local < 3 ? 'green' : local < 4 ? 'yellow' : 'red';
}

export function insideSignalBounds(bounds, x, z, margin = 0) {
  return x >= bounds[0] - margin && x <= bounds[2] + margin && z >= bounds[1] - margin && z <= bounds[3] + margin;
}

const approachKey = (index, to) => `${index}/${to}`;
const linkKey = (way, from, to) => `${way}:${from}:${to}`;

export function createIntersectionControl(source, graph) {
  const intersections = source?.intersections ?? [];
  const byLink = new Map();
  const byId = new Map();
  const owners = new Map();
  const pedestrianOwners = new Map();
  const vehicleTurns = new Map();
  const requests = new Map();
  if (intersections.length) {
    const directed = new Map();
    graph.links.forEach(([a, b, , , , direction], index) => {
      const m = graph.metadata[index];
      if (m.heightSource !== 'terrain' || m.bridge || m.tunnel || m.layer) return;
      const add = (from, to) => directed.set(linkKey(m.osmId, graph.nodeIds[from], graph.nodeIds[to]), { index, to });
      if (direction >= 0) add(a, b);
      if (direction <= 0) add(b, a);
    });
    for (const junction of intersections) {
      if (byId.has(junction.id)) throw new Error(`Duplicate signal intersection: ${junction.id}`);
      const approaches = junction.approaches.map(item => {
        const edge = directed.get(linkKey(item.osmWayId, item.fromNodeId, item.toNodeId));
        if (!edge) throw new Error(`Unresolved signal approach: ${item.osmNodeId}`);
        const key = approachKey(edge.index, edge.to);
        if (byLink.has(key)) throw new Error(`Multiple stop lines for the same signal approach: ${item.osmNodeId}`);
        const approach = { ...item, id: junction.id, sourceIndex: edge.index, to: edge.to, bounds: junction.bounds };
        byLink.set(key, approach);
        return approach;
      });
      byId.set(junction.id, { ...junction, approaches });
      requests.set(junction.id, new Map());
    }
  }

  function approachFor(sourceIndex, to) {
    return byLink.get(approachKey(sourceIndex, to)) ?? null;
  }

  function canEnter(approach, elapsedSeconds, actorId) {
    if (pedestrianOwners.has(approach.id)) return false;
    const owner = owners.get(approach.id);
    if (owner !== undefined) return owner === actorId;
    if (signalPhase(approach.group, elapsedSeconds) !== 'green') return false;
    const waiting = requests.get(approach.id);
    // 两相灯色保持不变。预约按最早仍就绪的进向请求，允许等它的下一次绿灯，避免反复抢占。
    for (const [id, item] of waiting ?? []) {
      if (elapsedSeconds - item.lastSeen > REQUEST_TIMEOUT) waiting.delete(id);
      else if (item.ready) return id === actorId;
    }
    return true;
  }

  function vehiclePhase(approach, elapsedSeconds) {
    return pedestrianOwners.has(approach.id) ? 'red' : signalPhase(approach.group, elapsedSeconds);
  }

  return {
    intersections: [...byId.values()],
    approachFor,
    vehiclePhase,
    enterCrossing(crossing, elapsedSeconds, actorId) {
      const { id, group } = crossing;
      if (actorId === undefined) return false;
      if (pedestrianOwners.get(id) === actorId) return true;
      if (!byId.has(id) || owners.has(id) || pedestrianOwners.has(id) || signalPhase(group, elapsedSeconds) !== 'green') return false;
      if (elapsedSeconds < (vehicleTurns.get(id) ?? 0) && [...requests.get(id).values()]
        .some(item => item.ready && elapsedSeconds - item.lastSeen <= REQUEST_TIMEOUT)) return false;
      pedestrianOwners.set(id, actorId);
      return true;
    },
    leaveCrossing(crossing, actorId, elapsedSeconds) {
      const { id } = crossing;
      if (pedestrianOwners.get(id) !== actorId) return;
      pedestrianOwners.delete(id);
      // 已排队的车辆先获得至多一轮正常灯相，避免连续过街长期压住车流。
      if (Number.isFinite(elapsedSeconds)) vehicleTurns.set(id, elapsedSeconds + CYCLE);
    },
    snapshot(elapsedSeconds) {
      return [...byId.keys()].map(id => ({ id, owner: owners.get(id) ?? null,
        pedestrianOwner: pedestrianOwners.get(id) ?? null,
        phases: [0, 1].map(group => vehiclePhase({ id, group }, elapsedSeconds)),
        requests: [...requests.get(id)].filter(([, item]) => elapsedSeconds - item.lastSeen <= REQUEST_TIMEOUT)
          .map(([actorId, item]) => ({ actorId, group: item.group, ready: item.ready })) }));
    },
    approachState(sourceIndex, to, elapsedSeconds) {
      const approach = approachFor(sourceIndex, to);
      return approach ? { ...approach, phase: vehiclePhase(approach, elapsedSeconds) } : null;
    },
    contains(x, z, margin = 0) {
      for (const junction of byId.values()) if (insideSignalBounds(junction.bounds, x, z, margin)) return true;
      return false;
    },
    canEnter,
    request(approach, actorId, elapsedSeconds, ready = true) {
      const waiting = requests.get(approach.id);
      if (!waiting || actorId === undefined || owners.get(approach.id) === actorId) return;
      const previous = waiting.get(actorId);
      if (previous && elapsedSeconds - previous.lastSeen > REQUEST_TIMEOUT) waiting.delete(actorId);
      waiting.set(actorId, { group: approach.group, ready, lastSeen: elapsedSeconds });
    },
    cancelRequest(approach, actorId) {
      if (approach) requests.get(approach.id)?.delete(actorId);
    },
    enter(approach, elapsedSeconds, actorId) {
      if (actorId === undefined || !canEnter(approach, elapsedSeconds, actorId)) return false;
      owners.set(approach.id, actorId);
      vehicleTurns.delete(approach.id);
      requests.get(approach.id)?.delete(actorId);
      return true;
    },
    release(approach, actorId) {
      if (owners.get(approach.id) === actorId) owners.delete(approach.id);
    }
  };
}

export function routeSignalStops(samples, control, rearMargin = 0) {
  const stops = [];
  if (!control?.intersections.length) return stops;
  const seen = new Set();
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const approach = control.approachFor(a.edge.sourceIndex, a.edge.to);
    if (!approach || seen.has(approach.osmNodeId)) continue;
    const { stopX, stopZ, dx, dz } = approach;
    const before = (a.x - stopX) * dx + (a.z - stopZ) * dz;
    const after = (b.x - stopX) * dx + (b.z - stopZ) * dz;
    if (before > 0 || after < 0 || after - before < 1e-6) continue;
    const t = -before / (after - before);
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    if (Math.abs((x - stopX) * -dz + (z - stopZ) * dx) > approach.widthM / 2 + 0.25) continue;
    const s = a.s + (b.s - a.s) * t;
    // 车辆越过停止线后保留通行权直至车尾离开冲突区，灯色按独立游戏时钟继续切换。
    const exit = samples.slice(i).find(p => p.s > s + 3 && !insideSignalBounds(approach.bounds, p.x, p.z, rearMargin));
    stops.push({ approach, s, clearS: exit?.s ?? Infinity });
    seen.add(approach.osmNodeId);
  }
  return stops;
}
