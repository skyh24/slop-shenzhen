// 深圳地面道路标线：实线边线、白虚线、双黄中心线、停止线和断头端线。
const LANE_WIDTH_M = 3.25;
const MAX_LANES = 8;
const LINE_WIDTH = 0.18;
const YELLOW_WIDTH = 0.15;
const STOP_WIDTH = 0.45;
const CROSSWALK_DEPTH = 3.0;
const CROSSWALK_PITCH = 0.82;
const CROSSWALK_STRIPE = 0.45;

function linkPoints(graph, link) {
  const [a, b, , , , , inner] = link;
  const points = [{ x: graph.nodes[a * 2], z: graph.nodes[a * 2 + 1] }];
  for (let i = 0; i < inner.length; i += 2) points.push({ x: inner[i], z: inner[i + 1] });
  points.push({ x: graph.nodes[b * 2], z: graph.nodes[b * 2 + 1] });
  return points.filter((point, i) => !i || point.x !== points[i - 1].x || point.z !== points[i - 1].z);
}

export function createLanePlan(link, metadata = {}) {
  const width = Number(link[3]);
  const sourceLanes = Number.isInteger(link[4]) ? link[4] : 0;
  const direction = link[5];
  const highway = metadata.highway ?? '';
  if (!Number.isFinite(width) || width < 3 || highway === 'pedestrian') return null;
  const laneCount = Math.min(MAX_LANES, sourceLanes > 0 ? sourceLanes : Math.max(1, Math.floor(width / LANE_WIDTH_M)));
  const travelWidth = width;
  const forward = direction === 0 ? Math.max(1, Math.round(laneCount / 2)) : laneCount;
  const backward = direction === 0 ? Math.max(1, laneCount - forward) : 0;
  const total = forward + backward;
  if (!total) return null;
  const internal = [];
  const simple = width < 7 && total <= 2;
  if (simple) {
    internal.push(direction === 0 ? { offset: 0, kind: 'double-yellow' } : { offset: 0, kind: 'dashed-white' });
  } else {
    const step = travelWidth / total;
    for (let i = 1; i < total; i++) {
      const offset = -travelWidth / 2 + i * step;
      internal.push({ offset, kind: Math.abs(offset) < 0.05 && direction === 0 ? 'double-yellow' : 'dashed-white' });
    }
  }
  return { width, travelWidth, laneCount, forward, backward, edge: width >= 3.2, internal,
    laneSource: sourceLanes > 0 ? 'osm-lanes' : 'width-estimate', simple, highway };
}

function sample(points, step) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) continue;
    for (let d = 0; d < length - 1e-6; d += step) {
      const t0 = d / length, t1 = Math.min(1, (d + step) / length);
      out.push({ ax: a.x + (b.x - a.x) * t0, az: a.z + (b.z - a.z) * t0,
        bx: a.x + (b.x - a.x) * t1, bz: a.z + (b.z - a.z) * t1 });
    }
  }
  return out;
}

function line(points, offset, color, period, duty, phase, strips) {
  const dx = points.at(-1).x - points[0].x, dz = points.at(-1).z - points[0].z;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  for (const piece of sample(points, 20)) {
    strips.push({ ax: piece.ax - uz * offset, az: piece.az + ux * offset,
      bx: piece.bx - uz * offset, bz: piece.bz + ux * offset,
      width: color === 'yellow' ? YELLOW_WIDTH : LINE_WIDTH, color, period, duty, phase, flow: 1 });
    phase += Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
  }
}

function stopBar(approach, strips) {
  const { stopX, stopZ, dx, dz, widthM } = approach;
  if (![stopX, stopZ, dx, dz, widthM].every(Number.isFinite) || widthM < 3) return;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length, rx = -uz, rz = ux, half = widthM / 2 - 0.15;
  const cx = stopX - ux * 0.35, cz = stopZ - uz * 0.35;
  strips.push({ ax: cx + rx * half, az: cz + rz * half, bx: cx - rx * half, bz: cz - rz * half,
    width: STOP_WIDTH, color: 'white', period: 1, duty: 1, phase: 0, flow: 1 });
  for (let lateral = -half; lateral <= half + 1e-6; lateral += CROSSWALK_PITCH) {
    strips.push({ ax: stopX - ux * (CROSSWALK_DEPTH + 0.7) + rx * lateral,
      az: stopZ - uz * (CROSSWALK_DEPTH + 0.7) + rz * lateral,
      bx: stopX - ux * 0.7 + rx * lateral, bz: stopZ - uz * 0.7 + rz * lateral,
      width: CROSSWALK_STRIPE, color: 'white', period: 1, duty: 1, phase: 0, flow: 1 });
  }
}

export function createMarkingLayout(graph, { intersections = [] } = {}) {
  if (!graph?.links || !graph.metadata || graph.links.length !== graph.metadata.length) throw new Error('Matched road graph required');
  const strips = [];
  const statistics = { links: 0, paintedLinks: 0, skippedLinks: 0, deadEnds: 0, strips: 0, intersections: 0, laneSources: {} };
  const degree = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const m = graph.metadata[i];
    if (m.heightSource !== 'terrain' || m.bridge || m.tunnel || m.layer) continue;
    const [a, b] = graph.links[i];
    degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  for (let i = 0; i < graph.links.length; i++) {
    const link = graph.links[i], metadata = graph.metadata[i];
    statistics.links++;
    if (metadata.heightSource !== 'terrain' || metadata.bridge || metadata.tunnel || metadata.layer) { statistics.skippedLinks++; continue; }
    const plan = createLanePlan(link, metadata);
    if (!plan) { statistics.skippedLinks++; continue; }
    statistics.paintedLinks++;
    statistics.laneSources[plan.laneSource] = (statistics.laneSources[plan.laneSource] ?? 0) + 1;
    const points = linkPoints(graph, link);
    if (points.length < 2) continue;
    if (plan.edge) {
      line(points, plan.travelWidth / 2 - 0.38, 'white', 1, 1, 0, strips);
      line(points, -plan.travelWidth / 2 + 0.38, 'white', 1, 1, 0, strips);
    }
    for (const divider of plan.internal) {
      if (divider.kind === 'double-yellow') {
        line(points, divider.offset - 0.12, 'yellow', 1, 1, 0, strips);
        line(points, divider.offset + 0.12, 'yellow', 1, 1, 0, strips);
      } else line(points, divider.offset, 'white', 12, 0.25, 0, strips);
    }
    for (const end of [0, 1]) {
      if ((degree.get(link[end]) ?? 0) > 1) continue;
      const p = end === 0 ? points[0] : points.at(-1);
      const q = end === 0 ? points[1] : points.at(-2);
      const dx = p.x - q.x, dz = p.z - q.z, length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const ux = dx / length, uz = dz / length, rx = -uz, rz = ux, half = Math.max(1.2, plan.travelWidth / 2 - 0.18);
      strips.push({ ax: p.x - ux * 1.3 + rx * half, az: p.z - uz * 1.3 + rz * half,
        bx: p.x - ux * 1.3 - rx * half, bz: p.z - uz * 1.3 - rz * half,
        width: STOP_WIDTH, color: 'white', period: 1, duty: 1, phase: 0, flow: 1 });
      statistics.deadEnds++;
    }
  }
  for (const approach of intersections.flatMap(junction => junction.approaches ?? [])) {
    const before = strips.length; stopBar(approach, strips);
    if (strips.length > before) statistics.intersections++;
  }
  statistics.strips = strips.length;
  return { strips, statistics };
}
