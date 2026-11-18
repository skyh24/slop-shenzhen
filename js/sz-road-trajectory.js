// 道路轨迹：把车道与桥面线段采样为连续路线，并按表面身份对车身做贴地校验。
// 规划器与环境车流共用同一实现；本模块不依赖渲染、车流实例或车型网格。
import { boxDimensions, sampleFootprint } from './sz-driving-motion.js';

// 匝道并线在端点附近的对齐长度，与桥面分流共用。
const RAMP_LANE_BLEND = 36;
const interpolate = (a, b, t) => a + (b - a) * t;

// 匝道判定同时服务路线续接与并线引导；只保留这一处定义。
export const isTrunkRamp = edge => edge?.highway === 'trunk_link';

function segmentEnd({ x, z, dx, dz, length }) {
  return { x: x + dx * length, z: z + dz * length };
}

function joinRampLane(segments, from, to) {
  if (!from && !to) return segments;
  const first = segments[0];
  const last = segmentEnd(segments.at(-1));
  const ends = [0];
  for (const { length } of segments) ends.push(ends.at(-1) + length);
  const total = ends.at(-1);
  const blend = Math.min(RAMP_LANE_BLEND, total / (from && to ? 2 : 1));
  const stations = new Set(ends);
  for (let d = 4; d < blend; d += 4) {
    if (from) stations.add(d);
    if (to) stations.add(total - d);
  }
  if (from) stations.add(blend);
  if (to) stations.add(total - blend);
  const result = [];
  let previous = null;
  let index = 0;
  for (const s of [...stations].sort((a, b) => a - b)) {
    while (index < segments.length - 1 && s > ends[index + 1]) index++;
    const seg = segments[index];
    const position = s - ends[index];
    let x = seg.x + seg.dx * position;
    let z = seg.z + seg.dz * position;
    for (const [anchor, source, distance] of [[from, first, s], [to, last, total - s]]) {
      if (!anchor || distance >= blend) continue;
      const t = distance / blend;
      const weight = 1 - t * t * (3 - 2 * t);
      x += (anchor.x - source.x) * weight;
      z += (anchor.z - source.z) * weight;
    }
    if (previous) {
      const dx = x - previous.x, dz = z - previous.z;
      const length = Math.hypot(dx, dz);
      if (length > 1e-5) result.push({ ...previous, dx: dx / length, dz: dz / length, length, edge: seg.edge });
    }
    previous = { x, z };
  }
  return result;
}

function guideBridgeForks(segments) {
  const result = [];
  for (let i = 0; i < segments.length;) {
    const edge = segments[i].edge;
    let end = i + 1;
    while (segments[end]?.edge === edge) end++;
    const following = segments[end];
    const branch = following && edge?.groundFork?.[following.edge.osmId];
    const deck = segments.slice(i, end);
    if (branch) {
      const last = deck.at(-1);
      const target = segmentEnd(last);
      // 在桥面内提前对齐分流幅，避免把横移压到同一桥头断面。
      const offset = branch * following.edge.section.pavementWidthM / 2;
      result.push(...joinRampLane(deck, null, { x: target.x + last.dz * offset, z: target.z - last.dx * offset }));
    } else result.push(...deck);
    i = end;
  }
  return result;
}

function guideReviewedRamps(segments) {
  if (!segments.some(segment => segment.edge?.section.reviewed)) return segments;
  const guided = [];
  for (let i = 0; i < segments.length;) {
    const first = segments[i];
    if (!isTrunkRamp(first.edge)) {
      guided.push(first);
      i++;
      continue;
    }
    let end = i + 1;
    while (segments[end]?.edge === first.edge) end++;
    const previous = segments[i - 1];
    const next = segments[end];
    // 沿真实匝道走向逐渐对齐中心线，整个过渡仍由可见沥青和碰撞预检。
    guided.push(...joinRampLane(segments.slice(i, end), previous?.edge?.section.reviewed ? segmentEnd(previous) : null,
      next?.edge?.section.reviewed ? next : null));
    i = end;
  }
  return guided;
}

export function laneRoute(path, maxBend = 3.2) {
  const ramps = guideReviewedRamps(path);
  const segments = ramps.some(segment => segment.edge?.groundFork) ? guideBridgeForks(ramps) : ramps;
  const samples = [];
  const bend = (a, b) => a && b ? Math.min(maxBend, a.length * 0.36, b.length * 0.36) : 0;
  function add(x, z, dx, dz, edge, laneOffset) {
    const previous = samples.at(-1);
    const step = previous ? Math.hypot(x - previous.x, z - previous.z) : 0;
    if (previous && step <= 1e-6) return;
    samples.push({ x, z, dx, dz, edge, laneOffset, s: (previous?.s ?? 0) + step });
  }
  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    const start = bend(segments[i - 1], current);
    const gap = bend(current, next);
    const end = current.length - gap;
    const steps = Math.max(1, Math.ceil((end - start) / 2));
    for (let k = 0; k <= steps; k++) {
      const distance = interpolate(start, end, k / steps);
      add(current.x + distance * current.dx, current.z + distance * current.dz, current.dx, current.dz,
        current.edge, current.laneOffset);
    }
    if (!next) continue;
    // 过弯只在连接点的短范围内平滑，生成后按实际沥青网格逐步复核。
    const a = samples.at(-1);
    const b = { x: a.x + current.dx * gap * 0.62, z: a.z + current.dz * gap * 0.62 };
    const c = { x: next.x + next.dx * gap * 0.38, z: next.z + next.dz * gap * 0.38 };
    const d = { x: next.x + next.dx * gap, z: next.z + next.dz * gap };
    const subdivisions = Math.max(3, Math.ceil(Math.hypot(d.x - a.x, d.z - a.z)));
    for (let k = 1; k <= subdivisions; k++) {
      const t = k / subdivisions;
      const u = 1 - t;
      const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
      const z = u ** 3 * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t ** 3 * d.z;
      const dx = u * u * (b.x - a.x) + 2 * u * t * (c.x - b.x) + t * t * (d.x - c.x);
      const dz = u * u * (b.z - a.z) + 2 * u * t * (c.z - b.z) + t * t * (d.z - c.z);
      const length = Math.hypot(dx, dz) || 1;
      add(x, z, dx / length, dz / length, t < 0.5 ? current.edge : next.edge,
        t < 0.5 ? current.laneOffset : next.laneOffset);
    }
  }
  return samples;
}

const routeProbes = new WeakMap();

// 探针顺序固定：车心、四轮、车身四角。车心也是普通探针，踩中它的边即本姿态的表面身份。
function probesOnRoute(model) {
  let probes = routeProbes.get(model);
  if (!probes) {
    const { halfTrack, halfWheelbase } = model;
    probes = [[0, 0], [-halfTrack, halfWheelbase], [halfTrack, halfWheelbase],
      [-halfTrack, -halfWheelbase], [halfTrack, -halfWheelbase], ...model.corners];
    routeProbes.set(model, probes);
  }
  return probes;
}

export function poseOnRoute(samples, s, model, roadHeight, pose) {
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (s - a.s) / (b.s - a.s);
  const x = interpolate(a.x, b.x, t);
  const z = interpolate(a.z, b.z, t);
  const heading = Math.atan2(interpolate(a.dx, b.dx, t), interpolate(a.dz, b.dz, t));
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  // 轮胎接触按当前段的表面身份取高度：高架段只采样桥面三角面，桥下地面车不会串到桥上。
  // 相邻两段在衔接处各自只覆盖到自己的端头，车轮跨过接缝时按附近两段身份依次查询，避免半个车身落空。
  const edges = [];
  let from = lo;
  let to = hi;
  while (from > 0 && samples[from - 1].s >= s - 8) from--;
  while (to < samples.length - 1 && samples[to + 1].s <= s + 8) to++;
  for (let i = from; i <= to; i++) {
    if (!edges.includes(samples[i].edge)) edges.push(samples[i].edge);
  }
  const first = t < 0.5 ? a.edge : b.edge;
  if (edges[0] !== first) {
    const index = edges.indexOf(first);
    if (index > 0) edges.unshift(edges.splice(index, 1)[0]);
  }
  let centerEdge = null;
  const supportedSlabs = pose.supportedSlabs ??= new Set();
  supportedSlabs.clear();
  // 每个探针按当前段身份逐个回退取面；第一点（车心）命中的边就是本姿态所在的表面。
  let atCenter = true;
  const heightOnEdges = (wx, wz) => {
    for (const edge of edges) {
      const height = roadHeight(wx, wz, edge);
      if (!Number.isFinite(height)) continue;
      if (atCenter) { centerEdge = edge; atCenter = false; }
      if (edge?.surfaceId) supportedSlabs.add(edge.surfaceId);
      return height;
    }
    return null;
  };
  const { halfTrack, halfWheelbase } = model;
  const heights = pose.heights ??= [];
  if (!sampleFootprint(x, z, sin, cos, probesOnRoute(model), heightOnEdges, heights)) return false;
  const center = heights[0];
  const leftFront = heights[1], rightFront = heights[2], leftRear = heights[3], rightRear = heights[4];
  const pitch = Math.atan2(leftRear + rightRear - leftFront - rightFront, 4 * halfWheelbase);
  const roll = Math.atan2(rightFront + rightRear - leftFront - leftRear, 4 * halfTrack);
  const y = (leftFront + rightFront + leftRear + rightRear) / 4;
  if (Math.abs(pitch) > 0.28 || Math.abs(roll) > 0.2 || Math.abs(center - y) > 0.26
    || Math.abs(leftFront + rightRear - rightFront - leftRear) > 0.44) return false;
  Object.assign(pose, { x, y, z, heading, pitch, roll, sin, cos, index: lo, edge: centerEdge });
  return true;
}

// 由碰撞包围盒与车型轴距/轮距派生路线模型；与车流渲染网格和池化实例无关。
export function routeModelBounds(box, spec) {
  const { min, max } = box;
  return { ...boxDimensions(box),
    halfTrack: spec.track / 2, halfWheelbase: spec.wheelbase / 2,
    corners: [[min.x, min.z], [min.x, max.z], [max.x, min.z], [max.x, max.z]] };
}
