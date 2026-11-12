import { isGroundRoad, roadSectionPoints } from './sz-roads.js';

// 深圳地面道路标线：按 [23 号文档](../../docs/23-BUILDING-AND-STREET-PLAN.md) 第 7 节收束线型。
// 车道数只用来推断线型，不冒充实测；估算车道数与 OSM lanes 分开标记（laneSource）。
const LANE_WIDTH_M = 3.25;
const NARROW_WIDTH_M = 7;
const MAX_LANES = 8;
const LINE_WIDTH = 0.18;
const YELLOW_WIDTH = 0.15;
const STOP_WIDTH = 0.45;
const CROSSWALK_DEPTH = 3.0;
const CROSSWALK_PITCH = 0.82;
const CROSSWALK_STRIPE = 0.45;
// 进向标线的收尾顺序（从路口向外）：斑马线 0.7–3.7 m，停止线约 4.3 m，纵向标线再退 0.6 m。
const CROSSWALK_SETBACK = 0.7;
const STOP_BAR_GAP = 0.35;
const LINE_STOP_GAP = 0.6;
const STOP_CLEARANCE = CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_GAP + STOP_WIDTH + LINE_STOP_GAP;
// 斜接长度上限：超过后改用斜切，急弯处宁可切角也不让偏移线伸出路面或自交。
const MAX_MITER_SCALE = 4;
const PAVEMENT_TOLERANCE = 0.02;
const SAMPLE_STEP = 20;

// 把 OSM 车道数或按路宽估算的车道数翻成线型。双向用中心线分向，单向不画黄线。
export function createLanePlan(link, metadata = {}) {
  const width = Number(link[3]);
  const osmLanes = Number.isInteger(link[4]) && link[4] > 0 ? link[4] : 0;
  const direction = link[5];
  const highway = metadata.highway ?? '';
  if (!Number.isFinite(width) || width < 3 || highway === 'pedestrian') return null;
  const twoWay = direction === 0;
  const estimate = Math.max(1, Math.floor(width / LANE_WIDTH_M));
  // 双向至少要有来去各一条；OSM lanes 为奇数时多出的一条算作 a→b 方向。
  const laneCount = Math.min(MAX_LANES, twoWay ? Math.max(2, osmLanes || estimate) : Math.max(1, osmLanes || estimate));
  const narrow = width < NARROW_WIDTH_M || (twoWay && laneCount <= 2);
  const forward = twoWay ? Math.max(1, Math.ceil(laneCount / 2)) : laneCount;
  const backward = twoWay ? Math.max(1, laneCount - forward) : 0;
  const sectionLaneWidth = metadata.crossSection?.laneWidthM;
  const laneWidth = !twoWay && sectionLaneWidth > 0 ? sectionLaneWidth : width / laneCount;
  // 双向双黄线落在道路中心线上（第 7 节要求车道、停止线、斑马线共用同一条中心线），
  // 两个方向各占半幅；奇数车道时多出的一条分在本侧半幅内。
  const half = width / 2;
  const forwardWidth = twoWay ? half / forward : laneWidth;
  const backwardWidth = twoWay ? half / backward : 0;
  const internal = [];
  if (!narrow) {
    if (twoWay) {
      internal.push({ offset: 0, kind: 'double-yellow' });
      for (let i = 1; i < forward; i++) internal.push({ offset: -half + i * forwardWidth, kind: 'dashed-white' });
      for (let i = 1; i < backward; i++) internal.push({ offset: half - i * backwardWidth, kind: 'dashed-white' });
    } else {
      for (let i = 1; i < laneCount && i * laneWidth < width; i++) {
        internal.push({ offset: -half + i * laneWidth, kind: 'dashed-white' });
      }
    }
  } else if (twoWay) {
    // 窄路不再按估算车道数拆线，只保留中心线和边线。
    internal.push({ offset: 0, kind: 'double-yellow' });
  }
  return { width, travelWidth: width, laneCount, forward, backward, laneWidth, forwardWidth, backwardWidth, edge: width >= 3.2,
    internal, laneSource: osmLanes > 0 ? 'osm-lanes' : 'width-estimate', estimated: osmLanes === 0,
    narrow, twoWay, highway };
}

// 桥面为了接触留有最小铺装宽度，车道数仍按来源断面判断。
export function createDeckLanePlan(link, metadata, deckWidth, barrierWidth) {
  const usable = deckWidth - barrierWidth * 2;
  const sourceWidth = Math.min(link[3], usable);
  const osmLanes = link[4] > 0 ? link[4] : 0;
  const classRamp = metadata.highway.endsWith('_link') && metadata.widthSource === 'estimate-from-class';
  const estimate = classRamp ? 1 : Math.floor((sourceWidth + 0.25) / 3);
  const laneCount = Math.max(1, Math.min(MAX_LANES, osmLanes || estimate));
  const lines = [{ offset: -usable / 2 + 0.24, duty: 1 }, { offset: usable / 2 - 0.24, duty: 1 }];
  for (let lane = 1; lane < laneCount; lane++) {
    const center = link[5] === 0 && lane === Math.ceil(laneCount / 2);
    lines.push({ offset: usable * (lane / laneCount - 0.5), duty: 0.32, color: center ? 'yellow' : 'white' });
  }
  return { laneCount, laneSource: osmLanes ? 'osm-lanes' : 'width-estimate', lines };
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length)));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

// 逐段求偏移点：每个顶点用相邻两段的法线平分线做斜接，整段不再共用首尾弦方向。
// 斜接点会伸出斜切路缘时改用斜切（两段各自法线偏移），保证线在路面内。
function offsetPoints(points, offset, halfWidth) {
  const count = points.length;
  if (count < 2 || !Number.isFinite(offset)) return [];
  const segments = [];
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].z - points[i].z;
    const length = Math.hypot(dx, dz);
    segments.push(length < 1e-6 ? null : { ux: dx / length, uz: dz / length });
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const previous = segments[i - 1] ?? null;
    const next = segments[i] ?? null;
    if (!previous && !next) continue;
    // 断面点到左路缘的距离可能逐点变化；标线偏移先换算到这条断面的坐标。
    const leftWidth = points[i].leftM ?? halfWidth;
    const across = offset + (halfWidth - leftWidth);
    if (!previous || !next) {
      const only = previous ?? next;
      out.push({ x: points[i].x - only.uz * across, z: points[i].z + only.ux * across });
      continue;
    }
    let bx = -previous.uz - next.uz;
    let bz = previous.ux + next.ux;
    let length = Math.hypot(bx, bz);
    if (length < 1e-6) {
      // 180° 折返没有唯一平分线，退回本段法线。
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
      continue;
    }
    bx /= length; bz /= length;
    const cosine = bx * -next.uz + bz * next.ux;
    const scale = cosine < 1 / MAX_MITER_SCALE ? MAX_MITER_SCALE : 1 / cosine;
    const miter = { x: points[i].x + bx * across * scale, z: points[i].z + bz * across * scale };
    let bevel = false;
    if (Math.abs(across) > 1e-6 && scale > 1.0001) {
      // 凸侧斜接点的垂足落到路段之外：只有斜接长度不超过斜切路缘（到平分线与路缘交点）时才算在路面内。
      const distance = Math.min(distanceToSegment(miter, points[i - 1], points[i]), distanceToSegment(miter, points[i], points[i + 1]));
      const inside = distance <= Math.abs(across) + 1e-6;
      const sideWidth = across < 0 ? leftWidth : 2 * halfWidth - leftWidth;
      const limit = sideWidth * cosine / Math.abs(across);
      bevel = !inside && scale > limit - PAVEMENT_TOLERANCE;
    }
    if (bevel) {
      // 斜接会伸出斜切路缘，改画斜切：两段法线偏移点连一条斜线。
      out.push({ x: points[i].x - previous.uz * across, z: points[i].z + previous.ux * across });
      out.push({ x: points[i].x - next.uz * across, z: points[i].z + next.ux * across });
    } else out.push(miter);
  }
  return out;
}

function properlyCrosses(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
    && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

// 偏移折线：丢掉塌缩点，再按非相邻段交叉切分，弯道内侧形成的回环不画。
function offsetRuns(points, offset, halfWidth) {
  const raw = offsetPoints(points, offset, halfWidth);
  const line = [];
  for (const point of raw) {
    const last = line.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.z - last.z) > 0.05) line.push(point);
  }
  if (line.length < 2) return [];
  const runs = [];
  let start = 0;
  for (let j = 2; j < line.length; j++) {
    let cut = -1;
    for (let k = start; k + 1 < j - 1; k++) {
      if (properlyCrosses(line[k], line[k + 1], line[j - 1], line[j])) { cut = k; break; }
    }
    if (cut < 0) continue;
    if (cut + 1 - start > 1) runs.push(line.slice(start, cut + 1));
    start = j;
  }
  if (line.length - start > 1) runs.push(line.slice(start));
  return runs;
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

function line(points, offset, color, period, duty, phase, strips, kind, halfWidth) {
  const width = color === 'yellow' ? YELLOW_WIDTH : LINE_WIDTH;
  for (const run of offsetRuns(points, offset, halfWidth)) {
    for (const piece of sample(run, SAMPLE_STEP)) {
      strips.push({ ax: piece.ax, az: piece.az, bx: piece.bx, bz: piece.bz,
        width, color, period, duty, phase, flow: 1, offset, kind });
      phase += Math.hypot(piece.bx - piece.ax, piece.bz - piece.az);
    }
  }
}

// 进向到停止点的投影距离；找不到或偏离本路段太远时返回 null，避免误剪整条线。
function projectStop(points, stopX, stopZ, width) {
  if (!Number.isFinite(stopX) || !Number.isFinite(stopZ)) return null;
  let best = Infinity;
  let stop = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((stopX - a.x) * dx + (stopZ - a.z) * dz) / (length * length)));
    const distance = Math.hypot(stopX - (a.x + dx * t), stopZ - (a.z + dz * t));
    if (distance < best) { best = distance; stop = total + length * t; }
    total += length;
  }
  return best <= Math.max(4, width) ? stop : null;
}

function subline(points, startS, endS) {
  const total = points.reduce((sum, point, i) => i ? sum + Math.hypot(point.x - points[i - 1].x, point.z - points[i - 1].z) : 0, 0);
  const from = Math.max(0, startS);
  const to = Math.min(total, endS);
  if (to - from < 0.5) return [];
  const out = [];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-9) continue;
    const segmentFrom = Math.max(from, s), segmentTo = Math.min(to, s + length);
    if (segmentTo > segmentFrom + 1e-9) {
      const insert = (distance) => {
        const t = (distance - s) / length;
        const point = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        if (a.leftM !== undefined) point.leftM = a.leftM + (b.leftM - a.leftM) * t;
        const last = out.at(-1);
        if (!last || Math.hypot(last.x - point.x, last.z - point.z) > 1e-6) out.push(point);
      };
      insert(segmentFrom);
      insert(segmentTo);
    }
    s += length;
  }
  return out;
}

function stopLine(approach, strips) {
  const { stopX, stopZ, dx, dz, widthM } = approach;
  if (![stopX, stopZ, dx, dz, widthM].every(Number.isFinite) || widthM < 3) return null;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length, rx = -uz, rz = ux, half = widthM / 2 - 0.15;
  const up = CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_GAP + STOP_WIDTH / 2;
  const cx = stopX - ux * up, cz = stopZ - uz * up;
  strips.push({ ax: cx + rx * half, az: cz + rz * half, bx: cx - rx * half, bz: cz - rz * half,
    width: STOP_WIDTH, color: 'white', period: 1, duty: 1, phase: 0, flow: 1, offset: 0, kind: 'stop' });
  return 'stop';
}

function crosswalk(approach, strips) {
  const { stopX, stopZ, dx, dz, widthM } = approach;
  if (![stopX, stopZ, dx, dz, widthM].every(Number.isFinite) || widthM < 3) return null;
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length, rx = -uz, rz = ux, half = widthM / 2 - 0.15;
  for (let lateral = -half; lateral <= half + 1e-6; lateral += CROSSWALK_PITCH) {
    strips.push({ ax: stopX - ux * (CROSSWALK_SETBACK + CROSSWALK_DEPTH) + rx * lateral,
      az: stopZ - uz * (CROSSWALK_SETBACK + CROSSWALK_DEPTH) + rz * lateral,
      bx: stopX - ux * CROSSWALK_SETBACK + rx * lateral, bz: stopZ - uz * CROSSWALK_SETBACK + rz * lateral,
      width: CROSSWALK_STRIPE, color: 'white', period: 1, duty: 1, phase: 0, flow: 1, offset: 0, kind: 'crosswalk' });
  }
  return 'crosswalk';
}

// 让复核走廊接管范围内的通用标线；跨界的一条线保留两端和虚线相位。
function outsideBounds(strip, bounds) {
  const dx = strip.bx - strip.ax, dz = strip.bz - strip.az;
  let start = 0, end = 1;
  for (const [a, delta, low, high] of [[strip.ax, dx, bounds[0], bounds[2]], [strip.az, dz, bounds[1], bounds[3]]]) {
    if (Math.abs(delta) < 1e-9) {
      if (a < low || a > high) return [strip];
      continue;
    }
    const enter = (low - a) / delta, exit = (high - a) / delta;
    start = Math.max(start, Math.min(enter, exit));
    end = Math.min(end, Math.max(enter, exit));
    if (start >= end) return [strip];
  }
  const result = [];
  if (start > 0) result.push({ ...strip, bx: strip.ax + dx * start, bz: strip.az + dz * start });
  if (end < 1) result.push({ ...strip, ax: strip.ax + dx * end, az: strip.az + dz * end,
    phase: strip.phase + Math.hypot(dx, dz) * end });
  return result;
}

export function createMarkingLayout(graph, { intersections = [], frontage } = {}) {
  if (!graph?.links || !graph.metadata || graph.links.length !== graph.metadata.length) throw new Error('Matched road graph required');
  const strips = [];
  const statistics = { links: 0, paintedLinks: 0, skippedLinks: 0, reviewedLinks: 0, strips: 0, intersections: 0,
    laneSources: {}, estimatedLaneLinks: 0, osmLaneLinks: 0, narrowLinks: 0, oneWayLinks: 0, twoWayLinks: 0,
    stopLines: 0, crosswalks: 0, breakLinks: 0 };
  // 路口进向按源路段索引挂到 link 上，只有信号或已核实过街才画进向设施。
  const approachesByLink = new Map();
  const features = new Map((frontage?.features ?? []).map(feature => [feature.id, feature]));
  const signalPaint = new Set(features.get('source-signal-stop-lines')?.sourceIds);
  const reviewedBounds = new Map();
  for (const corridor of frontage?.corridors ?? []) {
    const paint = features.get(`${corridor.id}:paint`);
    if (!paint?.trianglesXZ.length) continue;
    const ids = new Set(paint.sourceIds);
    for (const way of corridor.roadIds) {
      if (!ids.has(way)) continue;
      const areas = reviewedBounds.get(way) ?? [];
      areas.push(corridor.bounds);
      reviewedBounds.set(way, areas);
    }
  }
  for (const junction of intersections) {
    for (const approach of junction.approaches ?? []) {
      if (!Number.isInteger(approach.sourceIndex)) continue;
      const list = approachesByLink.get(approach.sourceIndex) ?? [];
      list.push(approach);
      approachesByLink.set(approach.sourceIndex, list);
    }
  }
  const degree = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const m = graph.metadata[i];
    if (!isGroundRoad(m)) continue;
    const [a, b] = graph.links[i];
    degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  for (let i = 0; i < graph.links.length; i++) {
    const link = graph.links[i], metadata = graph.metadata[i];
    statistics.links++;
    if (!isGroundRoad(metadata)) { statistics.skippedLinks++; continue; }
    const plan = createLanePlan(link, metadata);
    if (!plan) { statistics.skippedLinks++; continue; }
    statistics.paintedLinks++;
    statistics.laneSources[plan.laneSource] = (statistics.laneSources[plan.laneSource] ?? 0) + 1;
    if (plan.estimated) statistics.estimatedLaneLinks++;
    else statistics.osmLaneLinks++;
    if (plan.narrow) statistics.narrowLinks++;
    if (plan.twoWay) statistics.twoWayLinks++;
    else statistics.oneWayLinks++;
    const points = roadSectionPoints(graph, link, metadata);
    if (points.length < 2) continue;
    const length = points.reduce((sum, point, index) => index ? sum + Math.hypot(point.x - points[index - 1].x, point.z - points[index - 1].z) : 0, 0);
    const junctionGap = Math.min(plan.width * 0.38, 7, length * 0.30);
    let startS = (degree.get(link[0]) ?? 0) >= 3 ? junctionGap : 0;
    let endS = (degree.get(link[1]) ?? 0) >= 3 ? length - junctionGap : Infinity;
    for (const approach of approachesByLink.get(i) ?? []) {
      // 只有信号进向才有停止线；已核实过街（无信号）不剪纵向标线。
      if (!Number.isInteger(approach.group)) continue;
      const stop = projectStop(points, approach.stopX, approach.stopZ, plan.width);
      if (stop === null) continue;
      const clearance = signalPaint.has(`node/${approach.osmNodeId}`) ? LINE_STOP_GAP : STOP_CLEARANCE;
      if (length - stop <= stop) endS = Math.min(endS, stop - clearance);
      else startS = Math.max(startS, stop + clearance);
    }
    const clipped = startS > 0 || endS < Infinity ? subline(points, startS, endS) : points;
    if (clipped.length >= 2) {
      const before = strips.length;
      if (startS > 0 || endS < Infinity) statistics.breakLinks++;
      const half = plan.width / 2;
      if (plan.edge) {
        line(clipped, half - 0.38, 'white', 1, 1, 0, strips, 'edge-right', half);
        line(clipped, -half + 0.38, 'white', 1, 1, 0, strips, 'edge-left', half);
      }
      for (const divider of plan.internal) {
        if (divider.kind === 'double-yellow') {
          line(clipped, divider.offset - 0.12, 'yellow', 1, 1, 0, strips, 'center-left', half);
          line(clipped, divider.offset + 0.12, 'yellow', 1, 1, 0, strips, 'center-right', half);
        } else line(clipped, divider.offset, 'white', 12, 0.25, 0, strips, 'lane', half);
      }
      const areas = reviewedBounds.get(metadata.osmId);
      if (areas) {
        let generic = strips.splice(before);
        for (const area of areas) generic = generic.flatMap(strip => outsideBounds(strip, area));
        for (const strip of generic) strips.push(strip);
        statistics.reviewedLinks++;
      }
    }
  }
  for (const junction of intersections) {
    const approaches = junction.approaches ?? [];
    for (const approach of approaches) {
      if (signalPaint.has(`node/${approach.osmNodeId}`)) continue;
      const signal = Number.isInteger(approach.group);
      const verifiedCrossing = approach.crosswalk === true || junction.crosswalk === true;
      if (signal) {
        if (stopLine(approach, strips)) statistics.stopLines++;
        if (crosswalk(approach, strips)) statistics.crosswalks++;
      } else if (verifiedCrossing && crosswalk(approach, strips)) statistics.crosswalks++;
    }
    if (approaches.length) statistics.intersections++;
  }
  statistics.strips = strips.length;
  return { strips, statistics };
}
