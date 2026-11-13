import * as THREE from 'three/webgpu';
import { routeSignalStops } from './sz-intersection-control.js';
import { isGroundRoad, roadTravelPoints } from './sz-roads.js';
import { getDeckSection, getRoadSection, usableWidth } from './sz-road-section.js';
import {
  carStyleCode, createTrafficCarBody, createTrafficVehicleGeometry, createTrafficWheels, VEHICLE_SPECS
} from './sz-vehicles.js';
import { polygonBoxOverlaps, roofPanelContactPolygon, spanContactPolygon } from './building-collision.js';
import { vehicleContact } from './vehicle-physics.js';
import { boxDimensions, followingReach, routeLeader, writeEntityCollider, writeTrafficCollider } from './sz-driving-motion.js';

export { writeTrafficCollider };

const SPAWN_CELL = 100;
const SEARCH_RADIUS = 360;
const DESPAWN_RADIUS = 430;
const NEAR_ROUTE_END_RADIUS = 160;
const RECYCLE_CLEARANCE = 40;
const BODY_CELL = 32;
const SIGNAL_EXIT_BUFFER = 12;
const RAMP_LANE_BLEND = 36;
const ROUTE_RANGE = 560;
const REVIEWED_MAINLINE_RANGE = 1500;
const TURN = Math.PI * 2;
const WHEEL_SPIN_STEP = 0.6;
// 高架链路进入车流后多给一段续行预算，让“地面→匝道→桥面→地面”能在一段路线内走完。
const ELEVATED_ROUTE_RANGE = 1200;
const ELEVATED_ROUTE_SEGMENTS = 260;
// 同一节点两条桥面链路的估计桥面高差超过该值时视为未核实连接，不强行拼接。
// 与 sz-elevated-roads.js 的桥面接缝高差阈值保持一致（surface 层带交接容差）。
const ELEVATED_HEIGHT_TOLERANCE = 0.35;
// 深圳车队约 30 辆：出租车 6、轿车 9、SUV 8、MPV 3、物流面包 2、公交 2（docs/07 的车型配比按 30 辆折算）。
const FLEET = [
  { type: 'taxi', count: 6, speed: 10 },
  { type: 'sedan', count: 9, speed: 11 },
  { type: 'suv', count: 8, speed: 10 },
  { type: 'minivan', count: 3, speed: 10 },
  { type: 'van', count: 2, speed: 9 },
  { type: 'bus', count: 2, speed: 8 }
];
// 涂装按车型轮换；出租车固定天蓝 + livery 1（空车）/ 5（载客），其余为白/银/灰/黑为主的私家车色。
const FLEET_PAINTS = {
  taxi: [
    { color: 0x1f8fe0, style: carStyleCode({ livery: 1, metallic: 0, trim: 0, wheel: 1 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 5, metallic: 0, trim: 0, wheel: 0 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 1, metallic: 0, trim: 1, wheel: 2 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 5, metallic: 0, trim: 1, wheel: 1 }) }
  ],
  sedan: [
    { color: 0xf2f4f7, style: carStyleCode({ livery: 0, metallic: 0, trim: 1, wheel: 0 }) },
    { color: 0xc8d0d8, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x525a63, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x1c2026, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0x1d3b6c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x8a1c22, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) },
    { color: 0xe8ebee, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }
  ],
  suv: [
    { color: 0xeef1f3, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
    { color: 0x9aa2ac, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x3a434d, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x15181c, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0x27405c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x2c3a30, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) },
    { color: 0xb9c0c7, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) }
  ],
  minivan: [
    { color: 0xf0f2f5, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
    { color: 0x4a5058, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x1a1d22, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0xaab2bb, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }
  ],
  van: [
    { color: 0xf4f5f6, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) },
    { color: 0xeef0f2, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 1 }) },
    { color: 0xb9c0c7, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 0 }) },
    { color: 0x8e959c, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 2 }) }
  ]
};
const squareDistance = (x, z, point) => (x - point.x) ** 2 + (z - point.z) ** 2;
const interpolate = (a, b, t) => a + (b - a) * t;
const cellKey = (x, z) => `${x},${z}`;

function seededRandom(id) {
  let state = Math.imul(id + 1, 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function createTrafficGraph(graph, { canTurn = () => true, elevated = null } = {}) {
  const edges = [];
  const outgoing = new Map();
  const cells = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const metadata = graph.metadata[i];
    if (!isGroundRoad(metadata)) continue;
    const link = graph.links[i];
    const [a, b, name] = link;
    const section = getRoadSection(graph, i);
    const points = roadTravelPoints(graph, link, metadata, section.travelWidthM);
    if (points.length < 2) continue;
    for (const sign of section.twoWay ? [1, -1] : [section.direction]) {
      const from = sign === 1 ? a : b;
      const to = sign === 1 ? b : a;
      const path = sign === 1 ? points : [...points].reverse();
      const edge = { from, to, sign, section, name: graph.names[name],
        osmId: metadata.osmId, highway: metadata.highway, sourceIndex: i, segments: [], next: [] };
      for (let j = 1; j < path.length; j++) {
        const start = path[j - 1];
        const end = path[j];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        const dx = (end.x - start.x) / length;
        const dz = (end.z - start.z) / length;
        edge.segments.push({ x: start.x, z: start.z, dx, dz, length });
        if (length < 6) continue;
        const markers = Math.ceil(length / 36);
        for (let k = 0; k < markers; k++) {
          const distance = (k + 0.5) / markers * length;
          const x = start.x + dx * distance;
          const z = start.z + dz * distance;
          const key = cellKey(Math.floor(x / SPAWN_CELL), Math.floor(z / SPAWN_CELL));
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push({ edge, segment: j - 1, distance, x, z });
        }
      }
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      edges.push(edge);
    }
  }
  // 高架链路带表面身份进入同一张车流图：桥面高度来自渲染桥面计划，未知高程链路根本不在这里。
  for (const record of elevated?.links ?? []) {
    if (!Array.isArray(record.points) || record.points.length < 2) continue;
    if (record.osmId === undefined || record.surfaceId === undefined) continue;
    const section = getDeckSection(graph, record);
    for (const sign of section.twoWay ? [1, -1] : [section.direction]) {
      const path = sign === 1 ? record.points : [...record.points].reverse();
      const from = sign === 1 ? record.startNode : record.endNode;
      const to = sign === 1 ? record.endNode : record.startNode;
      const edge = { from, to, sign, section,
        name: record.name ?? '', osmId: record.osmId, highway: null, sourceIndex: record.index,
        structureNeighbors: record.structureNeighbors, tunnel: record.tunnel === true, rampSpeed: record.ramp ? 6.5 : undefined,
        segments: [], next: [], surfaceId: section.surfaceId, elevated: true,
        startDeckY: sign === 1 ? record.startDeckY : record.endDeckY,
        endDeckY: sign === 1 ? record.endDeckY : record.startDeckY,
        sharedStart: sign === 1 ? record.sharedStart : record.sharedEnd,
        sharedEnd: sign === 1 ? record.sharedEnd : record.sharedStart };
      for (let j = 1; j < path.length; j++) {
        const start = path[j - 1];
        const end = path[j];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        if (length < 1e-8) continue;
        const dx = (end.x - start.x) / length;
        const dz = (end.z - start.z) / length;
        edge.segments.push({ x: start.x, z: start.z, dx, dz, length });
        if (length < 6) continue;
        const markers = Math.ceil(length / 36);
        for (let k = 0; k < markers; k++) {
          const distance = (k + 0.5) / markers * length;
          const x = start.x + dx * distance;
          const z = start.z + dz * distance;
          const key = cellKey(Math.floor(x / SPAWN_CELL), Math.floor(z / SPAWN_CELL));
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push({ edge, segment: j - 1, distance, x, z });
        }
      }
      if (edge.segments.length === 0) continue;
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      edges.push(edge);
    }
  }
  // 只按源节点身份连边，不把平面交叉、反向掉头和未解析桥隧拼进路线。
  for (const edge of edges) {
    const last = edge.segments.at(-1);
    edge.next = (outgoing.get(edge.to) ?? []).filter(next => {
      const first = next.segments[0];
      if (next.sourceIndex === edge.sourceIndex || next.to === edge.from
        || last.dx * first.dx + last.dz * first.dz <= -0.45 || !canTurn(edge, next)) return false;
      // 高程衔接：地面↔桥面只走链路的落地端；两条桥面链路则要求共享节点估计桥面高差在容差内。
      if (edge.structureNeighbors && !edge.structureNeighbors.includes(next.surfaceId ?? 'terrain')) return false;
      if (next.structureNeighbors && !next.structureNeighbors.includes(edge.surfaceId ?? 'terrain')) return false;
      if (next.elevated || edge.elevated) {
        if (next.elevated && edge.elevated) {
          return Math.abs(edge.endDeckY - next.startDeckY) <= ELEVATED_HEIGHT_TOLERANCE;
        }
        return next.elevated ? next.sharedStart === true : edge.sharedEnd === true;
      }
      return true;
    });
  }
  function nearSegments(x, z, radius) {
    const segments = new Map();
    for (let ix = Math.floor((x - radius) / SPAWN_CELL); ix <= Math.floor((x + radius) / SPAWN_CELL); ix++) {
      for (let iz = Math.floor((z - radius) / SPAWN_CELL); iz <= Math.floor((z + radius) / SPAWN_CELL); iz++) {
        for (const { edge, segment } of cells.get(cellKey(ix, iz)) ?? []) {
          segments.set(edge.segments[segment], { edge, segment });
        }
      }
    }
    return [...segments.values()];
  }
  return { edges, cells, nearSegments };
}

const isTrunkRamp = edge => edge?.highway === 'trunk_link';

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

export function routeSegments(marker, model, random, detailedRoads, laneChoice) {
  const segments = [];
  const used = new Set();
  let edge = marker.edge;
  let index = marker.segment;
  let start = Math.max(0, marker.distance - 16);
  let remaining = ROUTE_RANGE;
  let reviewed = false;
  let elevatedSeen = false;
  while (edge && remaining > 0
    && segments.length < (elevatedSeen ? ELEVATED_ROUTE_SEGMENTS : reviewed ? 160 : 80)) {
    if (edge.section.reviewed && !reviewed) {
      // 复核快速路多保留一段续行预算，避免按通用街区预算截停在主线上。
      remaining += REVIEWED_MAINLINE_RANGE - ROUTE_RANGE;
      reviewed = true;
    }
    if (edge.elevated && !elevatedSeen) {
      // 高架段同样是已复核链路：给整条“上桥—桥面—下桥”留足续行预算，车流不会停在桥面上。
      remaining += ELEVATED_ROUTE_RANGE;
      elevatedSeen = true;
    }
    used.add(edge.sourceIndex);
    // 高架链路没有地面分幅横断面，统一走桥面中心线（方向 0 时取桥面半宽的居中车道）。
    const useLanes = !edge.elevated && (edge.section.reviewed || detailedRoads.has(edge.osmId));
    const offsets = useLanes ? edge.section.routeOffsetsM : edge.section.defaultOffsetsM;
    const halfWidth = edge.section.travelWidthM / 2;
    const lanes = offsets.filter(offset => Math.abs(offset) + model.hx + 0.08 <= halfWidth);
    const offset = lanes[Math.min(lanes.length - 1, Math.floor(laneChoice * lanes.length))] ?? 0;
    for (; index < edge.segments.length && (remaining > 0 || edge.tunnel); index++) {
      const segment = edge.segments[index];
      const length = edge.tunnel ? segment.length - start : Math.min(segment.length - start, remaining);
      if (length > 0) segments.push({ ...segment, length,
        x: segment.x + segment.dx * start - segment.dz * offset,
        z: segment.z + segment.dz * start + segment.dx * offset, edge });
      remaining -= length;
      start = 0;
    }
    // 已复核分幅的右侧匝道只与最外车道衔接，避免在分岔鼻端横穿内侧车道。
    const outerLane = offset === offsets.at(-1);
    const choices = edge.next.filter(next => !used.has(next.sourceIndex) && usableWidth(next, model.hx)
      && (!edge.section.reviewed || outerLane || !isTrunkRamp(next)));
    const next = choices[Math.floor(random() * choices.length)];
    if (isTrunkRamp(edge) && next?.section.reviewed) laneChoice = 1;
    if (edge.tunnel && next) remaining = Math.max(remaining, next.tunnel ? 1 : 55);
    edge = next;
    index = 0;
  }
  return segments;
}

export function laneRoute(path, maxBend = 3.2) {
  const segments = guideReviewedRamps(path);
  const samples = [];
  const bend = (a, b) => a && b ? Math.min(maxBend, a.length * 0.36, b.length * 0.36) : 0;
  function add(x, z, dx, dz, edge) {
    const previous = samples.at(-1);
    const step = previous ? Math.hypot(x - previous.x, z - previous.z) : 0;
    if (previous && step <= 1e-6) return;
    samples.push({ x, z, dx, dz, edge, s: (previous?.s ?? 0) + step });
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
      add(current.x + distance * current.dx, current.z + distance * current.dz, current.dx, current.dz, current.edge);
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
      add(x, z, dx / length, dz / length, t < 0.5 ? current.edge : next.edge);
    }
  }
  return samples;
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
  const heightAt = (px, pz) => {
    const wx = x + px * cos + pz * sin;
    const wz = z - px * sin + pz * cos;
    for (const edge of edges) {
      const height = roadHeight(wx, wz, edge);
      if (Number.isFinite(height)) {
        if (px === 0 && pz === 0) centerEdge = edge;
        if (edge?.surfaceId) supportedSlabs.add(edge.surfaceId);
        return height;
      }
    }
    return null;
  };
  const center = heightAt(0, 0);
  if (!Number.isFinite(center)) return false;
  const { halfTrack, halfWheelbase } = model;
  const leftFront = heightAt(-halfTrack, halfWheelbase);
  const rightFront = heightAt(halfTrack, halfWheelbase);
  const leftRear = heightAt(-halfTrack, -halfWheelbase);
  const rightRear = heightAt(halfTrack, -halfWheelbase);
  if (![leftFront, rightFront, leftRear, rightRear].every(Number.isFinite)) return false;
  for (const corner of model.corners) {
    if (!Number.isFinite(heightAt(corner[0], corner[1]))) return false;
  }
  const pitch = Math.atan2(leftRear + rightRear - leftFront - rightFront, 4 * halfWheelbase);
  const roll = Math.atan2(rightFront + rightRear - leftFront - leftRear, 4 * halfTrack);
  const y = (leftFront + rightFront + leftRear + rightRear) / 4;
  if (Math.abs(pitch) > 0.28 || Math.abs(roll) > 0.2 || Math.abs(center - y) > 0.26
    || Math.abs(leftFront + rightRear - rightFront - leftRear) > 0.44) return false;
  Object.assign(pose, { x, y, z, heading, pitch, roll, sin, cos, index: lo, edge: centerEdge });
  return true;
}

export function trafficModelBounds(box, spec) {
  const { min, max } = box;
  return { ...boxDimensions(box),
    halfTrack: spec.track / 2, halfWheelbase: spec.wheelbase / 2,
    corners: [[min.x, min.z], [min.x, max.z], [max.x, min.z], [max.x, max.z]] };
}

function intersects(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ && a.minY < b.maxY && a.maxY > b.minY;
}

function touchesObstacle(body, candidate) {
  if (!intersects(body, candidate)) return false;
  if (candidate.type === 'bridge-slab' && (body.supportedSlabs?.has(candidate.name)
    || (body.supportedSlabs?.size && body.minY >= candidate.maxY - 0.02)
    || (candidate.roadAccess && body.minY >= candidate.maxY - 0.28))) return false;
  if (!candidate.polygon) return true;
  let polygon = candidate.polygon;
  if (candidate.roofPanel) polygon = roofPanelContactPolygon(candidate.roofPanel, body.minY, body.maxY);
  else if (candidate.verticalSpan) polygon = spanContactPolygon(polygon, candidate.verticalSpan, body.minY, body.maxY);
  return polygon && polygonBoxOverlaps(polygon, body.x, body.z,
    body.halfW, body.halfL, body.cos, body.sin);
}

function makeObstacleIndex(colliders) {
  const cells = new Map();
  for (const collider of colliders) {
    for (let x = Math.floor(collider.minX / BODY_CELL); x <= Math.floor(collider.maxX / BODY_CELL); x++) {
      for (let z = Math.floor(collider.minZ / BODY_CELL); z <= Math.floor(collider.maxZ / BODY_CELL); z++) {
        const key = cellKey(x, z);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(collider);
      }
    }
  }
  return body => {
    for (let x = Math.floor(body.minX / BODY_CELL); x <= Math.floor(body.maxX / BODY_CELL); x++) {
      for (let z = Math.floor(body.minZ / BODY_CELL); z <= Math.floor(body.maxZ / BODY_CELL); z++) {
        for (const candidate of cells.get(cellKey(x, z)) ?? []) {
          if (touchesObstacle(body, candidate)) return candidate;
        }
      }
    }
    return null;
  };
}

export function createSzTraffic(scene, graph, { roadHeight, elevated = null, colliders = [], nearRegional, signals = null, detailedRoadIds = [], canTurn } = {}) {
  if (typeof roadHeight !== 'function') throw new Error('Traffic requires rendered road height');
  const network = createTrafficGraph(graph, { canTurn, elevated });
  // 轮胎跨接缝时由调用方依次试相邻路段。单条高架边查不到三角面时保留空值，
  // 避免用同一 XZ 的桥下沥青截断相邻桥面的查询。
  const heightAtDeck = typeof elevated?.heightAt === 'function' ? elevated.heightAt : null;
  const heightFor = (x, z, edge) => {
    if (!edge?.surfaceId) return roadHeight(x, z);
    const height = heightAtDeck?.(x, z, edge.surfaceId);
    return Number.isFinite(height) ? height : null;
  };
  const detailedRoads = new Set(detailedRoadIds);
  const staticObstacle = makeObstacleIndex(colliders);
  const blockedByBuilding = body => staticObstacle(body) || nearRegional?.(body.x, body.z, Math.max(body.halfW, body.halfL) * 1.42)
    .find(candidate => touchesObstacle(body, candidate));
  const group = new THREE.Group();
  group.name = 'shenzhen-ground-traffic';
  const busMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.53 });
  const vehicles = [];
  const batches = FLEET.map(entry => {
    const car = entry.type === 'bus' ? null : createTrafficCarBody(entry.type);
    const geometry = car ? car.geometry : createTrafficVehicleGeometry({ type: entry.type });
    if (car) {
      // 每实例涂装与灯光状态（paintColor / carState）由 createLoftedCarMaterial 读取。
      geometry.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(entry.count * 3), 3));
      geometry.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(entry.count * 4), 4));
    }
    geometry.computeBoundingBox();
    // 轿车几何不含车轮，包围盒落到地面后碰撞盒才和可见轮胎一致。
    if (car) geometry.boundingBox.min.y = 0;
    const model = trafficModelBounds(geometry.boundingBox, VEHICLE_SPECS[entry.type]);
    const mesh = new THREE.InstancedMesh(geometry, car ? car.material : busMaterial, entry.count);
    mesh.name = `traffic:${entry.type}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
    const paints = car ? FLEET_PAINTS[entry.type] : null;
    const actors = Array.from({ length: entry.count }, () => {
      const id = vehicles.length;
      const random = seededRandom(id);
      const palette = paints ? paints[id % paints.length] : null;
      const actor = { id, type: entry.type, model, random, desiredSpeed: entry.speed * (0.88 + 0.22 * random()),
        route: null, pose: {}, collider: { type: 'vehicle', id: `traffic:${id}` }, speed: 0, stalled: 0,
        paint: palette ? new THREE.Color(palette.color) : null, style: palette ? palette.style : 0,
        wheelSpin: 0, steer: 0, blinkPhase: (id * 0.37) % 0.8, prevX: 0, prevZ: 0, prevHeading: 0 };
      vehicles.push(actor);
      return actor;
    });
    return { mesh, actors, wheels: Boolean(car) };
  });
  // 环境车轮子单独实例化：左右各一份 InstancedMesh，前轴随路线弯道转向、四轮按车速滚动。
  const wheelCapacity = batches.reduce((sum, batch) => sum + (batch.wheels ? batch.actors.length : 0), 0);
  const wheelSetup = createTrafficWheels();
  const wheelStyles = new THREE.InstancedBufferAttribute(new Float32Array(wheelCapacity * 2), 1);
  wheelSetup.left.setAttribute('wheelStyle', wheelStyles);
  wheelSetup.right.setAttribute('wheelStyle', wheelStyles);
  const wheelLeft = new THREE.InstancedMesh(wheelSetup.left, wheelSetup.material, wheelCapacity * 2);
  const wheelRight = new THREE.InstancedMesh(wheelSetup.right, wheelSetup.material, wheelCapacity * 2);
  for (const [mesh, name] of [[wheelLeft, 'traffic:wheels-left'], [wheelRight, 'traffic:wheels-right']]) {
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
  }
  scene.add(group);

  const scratch = {};
  const probe = {};
  const contact = {};
  const transform = new THREE.Object3D();
  const wheelTransform = new THREE.Object3D();
  const statistics = { directedEdges: network.edges.length, active: 0, spawned: 0, signalEntries: 0, signalWaits: 0,
    signalExitRejects: 0, nearEndRejects: 0, mainlineEndRejects: 0, offscreenRecycled: 0 };
  let refill = 0;
  let spawnKey = null;
  let candidates = [];
  let approachCandidates = [];
  let players = [];
  let walkers = [];
  const frameBodies = [];
  let clock = 0;
  let simulationTime = 0;

  // 每实例涂装与灯光：出租车 livery 1 空车 / 5 载客；刹车点亮尾灯，转向时闪烁同侧转向灯（carState.x/y/z）。
  function writeCarState(batch, actor, slot) {
    const { paintColor, carState } = batch.mesh.geometry.attributes;
    const paint = paintColor.array;
    const o3 = slot * 3;
    paint[o3] = actor.paint.r;
    paint[o3 + 1] = actor.paint.g;
    paint[o3 + 2] = actor.paint.b;
    const state = carState.array;
    const o4 = slot * 4;
    const turning = Math.abs(actor.steer) > 0.06 ? Math.sign(actor.steer) : 0;
    const blinkOn = turning !== 0 && (clock + actor.blinkPhase) % 0.8 <= 0.4;
    state[o4] = actor.blocker || actor.speed < 0.4 ? 1 : 0;
    state[o4 + 1] = blinkOn && turning > 0 ? 1 : 0;
    state[o4 + 2] = blinkOn && turning < 0 ? 1 : 0;
    state[o4 + 3] = actor.style;
  }

  // 轮子按实际位移滚动（角速度 = 位移 / 轮胎半径），前轴转向角由航向变化率换算。
  // 车身实例用 Euler(pitch, heading, roll, 'YXZ') 贴合路面，车轮位置按同一旋转摆到车身坐标系里，
  // 上坡和下坡时轮胎仍落在路面平面上（否则前后轮会与轮拱错开）。
  function placeCarWheels(actor, wheelIndex, dt) {
    const { pose } = actor;
    const spec = VEHICLE_SPECS[actor.type];
    const sinY = Math.sin(pose.heading);
    const cosY = Math.cos(pose.heading);
    const forward = (pose.x - actor.prevX) * sinY + (pose.z - actor.prevZ) * cosY;
    const rawStep = forward / spec.radius;
    actor.wheelSpin = (actor.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), WHEEL_SPIN_STEP)) % TURN;
    const turn = Math.atan2(Math.sin(pose.heading - actor.prevHeading), Math.cos(pose.heading - actor.prevHeading));
    actor.steer += (Math.max(-0.5, Math.min(0.5, turn * 2.4)) - actor.steer) * Math.min(1, dt * 8);
    actor.prevX = pose.x;
    actor.prevZ = pose.z;
    actor.prevHeading = pose.heading;
    const styles = wheelStyles.array;
    styles[wheelIndex * 2] = actor.style;
    styles[wheelIndex * 2 + 1] = actor.style;
    const scale = spec.radius / wheelSetup.baseRadius;
    wheelTransform.scale.set(scale, scale, scale);
    const halfTrack = spec.track / 2;
    const halfBase = spec.wheelbase / 2;
    const lift = wheelSetup.groundOffset * scale;
    // Euler(pitch, heading, roll, 'YXZ') 的三列（three Matrix4.makeRotationFromEuler 的同款公式）
    const a = Math.cos(pose.pitch), b = Math.sin(pose.pitch);
    const c = cosY, d = sinY;
    const e = Math.cos(pose.roll), f = Math.sin(pose.roll);
    const col0 = [c * e + d * f * b, a * f, c * f * b - d * e];
    const col1 = [d * e * b - c * f, a * e, d * f + c * e * b];
    const col2 = [a * d, -b, a * c];
    for (let w = 0; w < 2; w++) {
      const wz = w === 0 ? halfBase : -halfBase;
      wheelTransform.rotation.set(pose.pitch + actor.wheelSpin + w * 0.55, pose.heading + (w === 0 ? actor.steer : 0),
        pose.roll, 'YXZ');
      for (const side of [-1, 1]) {
        const x = side * halfTrack;
        wheelTransform.position.set(
          pose.x + col0[0] * x + col1[0] * lift + col2[0] * wz,
          pose.y + col0[1] * x + col1[1] * lift + col2[1] * wz,
          pose.z + col0[2] * x + col1[2] * lift + col2[2] * wz
        );
        wheelTransform.updateMatrix();
        (side < 0 ? wheelLeft : wheelRight).setMatrixAt(wheelIndex * 2 + w, wheelTransform.matrix);
      }
    }
  }

  function collides(body, actor) {
    for (const candidate of players) {
      if (intersects(body, candidate) && vehicleContact(body, candidate, contact)) return candidate;
    }
    for (const candidate of walkers) {
      if (intersects(body, candidate) && vehicleContact(body, candidate, contact)) return candidate;
    }
    for (const other of vehicles) {
      if (other !== actor && other.route && intersects(body, other.collider)
        && vehicleContact(body, other.collider, contact)) return other.collider;
    }
    return null;
  }

  function blockerOnRoute(actor, route, s, includeTraffic) {
    if (!poseOnRoute(route, s, actor.model, heightFor, scratch)) return { kind: 'road-contact', atS: s };
    const body = writeTrafficCollider(probe, actor.model, scratch);
    body.supportedSlabs = scratch.supportedSlabs;
    const blocker = blockedByBuilding(body) || (includeTraffic ? collides(body, actor) : null);
    return blocker ? { kind: blocker.type ?? 'static', id: blocker.id ?? blocker.sourceId ?? blocker.name ?? null,
      part: blocker.part ?? null, atS: s } : null;
  }

  function junctionExitBlocker(actor, stop, fresh = false) {
    if (!fresh && actor.exitProbe?.stop === stop && actor.exitProbe.until > simulationTime) return actor.exitProbe.blocker;
    const last = Math.min(actor.end, stop.clearS + SIGNAL_EXIT_BUFFER);
    let blocker = null;
    // 当前路线先通过精细静态检查，绿灯放行前再确认整个出口没有排队车辆。
    for (let s = Math.max(actor.s, stop.s); s <= last; s += 1.75) {
      blocker = blockerOnRoute(actor, actor.route, s, true);
      if (blocker) break;
    }
    blocker ??= blockerOnRoute(actor, actor.route, last, true);
    actor.exitProbe = { stop, until: simulationTime + 0.18, blocker };
    return blocker;
  }

  function startRoute(actor, focus) {
    const { model, random } = actor;
    // 高架链路不在桥面中途凭空生成车辆：约一半环境车从已核实高架的落地引道出发，
    // 让桥面车流有真实的地面来源，其余仍按普通路网随机，避免车辆只在桥上概率性出现。
    const approachOnly = actor.id % 2 === 0 && approachCandidates.length > 0;
    const pool = approachOnly ? approachCandidates : candidates;
    for (let attempt = 0; attempt < 5 && pool.length > 0; attempt++) {
      const marker = pool[Math.floor(random() * pool.length)];
      const distance = squareDistance(marker.x, marker.z, focus);
      if (distance < 44 ** 2 || distance > SEARCH_RADIUS ** 2 || !usableWidth(marker.edge, model.hx)) continue;
      const laneChoice = detailedRoads.size ? random() : 0.5;
      const samples = laneRoute(routeSegments(marker, model, random, detailedRoads, laneChoice));
      if (samples.at(-1)?.edge.section.reviewed || samples.at(-1)?.edge.surfaceId) {
        statistics.mainlineEndRejects++;
        continue;
      }
      const first = Math.max(6, model.hz + 1);
      const limit = (samples.at(-1)?.s ?? 0) - model.hz - 1;
      if (limit < first + 42 || !poseOnRoute(samples, first, model, heightFor, actor.pose)) continue;
      if (signals?.contains(actor.pose.x, actor.pose.z, model.hz + 0.5)) continue;
      writeTrafficCollider(actor.collider, model, actor.pose);
      actor.collider.surfaceId = actor.pose.edge?.surfaceId;
      actor.collider.supportedSlabs = actor.pose.supportedSlabs;
      if (blockedByBuilding(actor.collider) || collides(actor.collider, actor)) continue;
      const rearMargin = Math.hypot(model.hx, model.hz) + Math.abs(model.z) + 0.5;
      const routeStops = routeSignalStops(samples, signals, rearMargin).filter(stop => stop.s >= first);
      let last = first;
      while (last < limit) {
        const inJunction = routeStops.some(stop => last + 1 >= stop.s - rearMargin && last <= stop.clearS + SIGNAL_EXIT_BUFFER);
        const next = Math.min(limit, last + (inJunction ? 0.125 : 1));
        if (blockerOnRoute(actor, samples, next, false)) break;
        last = next;
      }
      if (last - first < 42) continue;
      const stops = routeStops.filter(stop => stop.s <= last + model.z + model.hz);
      const exitsBlocked = stops.some(stop => stop.clearS + SIGNAL_EXIT_BUFFER > last);
      if (!poseOnRoute(samples, last, model, heightFor, scratch)) continue;
      // 行程必须驶离桥面回到地面，避免环境车停在桥面上形成永久队尾。
      if (scratch.edge.section.reviewed || scratch.edge.surfaceId) {
        statistics.mainlineEndRejects++;
        continue;
      }
      if (exitsBlocked || signals?.contains(scratch.x, scratch.z, rearMargin + SIGNAL_EXIT_BUFFER)) {
        statistics.signalExitRejects++;
        continue;
      }
      // 路面验证截短的行程同样检查终点，避免在玩家附近制造永久队尾。
      if (squareDistance(scratch.x, scratch.z, focus) < NEAR_ROUTE_END_RADIUS ** 2) {
        statistics.nearEndRejects++;
        continue;
      }
      actor.route = samples;
      actor.stops = stops;
      actor.stopIndex = 0;
      actor.reservation = null;
      actor.exitProbe = null;
      actor.blocker = null;
      actor.waitingForSignal = false;
      actor.s = first;
      actor.end = last;
      actor.speed = Math.min(4, actor.desiredSpeed);
      actor.collider.vx = actor.pose.sin * actor.speed;
      actor.collider.vz = actor.pose.cos * actor.speed;
      actor.stalled = 0;
      actor.wheelSpin = 0;
      actor.steer = 0;
      actor.prevX = actor.pose.x;
      actor.prevZ = actor.pose.z;
      actor.prevHeading = actor.pose.heading;
      statistics.spawned++;
      return;
    }
  }

  function dropRoute(actor) {
    if (actor.reservation) signals.release(actor.reservation, actor.id);
    signals?.cancelRequest(actor.stops?.[actor.stopIndex]?.approach, actor.id);
    actor.reservation = null;
    actor.route = null;
  }

  function advance(actor, dt, elapsedSeconds) {
    const { model, route } = actor;
    const stop = actor.stops[actor.stopIndex];
    const stoppingAt = stop ? stop.s - (model.hz + model.z) - 0.16 : Infinity;
    const remaining = Math.max(0, stoppingAt - actor.s);
    const awaiting = stop && !actor.reservation;
    const atQueue = awaiting && remaining <= 4;
    const queueBlocker = atQueue ? junctionExitBlocker(actor, stop) : null;
    if (atQueue) signals.request(stop.approach, actor.id, elapsedSeconds, !queueBlocker);
    const phaseHeld = awaiting && !signals.canEnter(stop.approach, elapsedSeconds, actor.id);
    const checkingExit = awaiting && !phaseHeld && remaining <= Math.max(12, actor.speed ** 2 / 7.2 + 2);
    const exitBlocker = queueBlocker ?? (checkingExit ? junctionExitBlocker(actor, stop) : null);
    const held = phaseHeld || exitBlocker;
    actor.blocker = exitBlocker ? { ...exitBlocker, atExit: true }
      : phaseHeld ? { kind: 'signal-or-owner', id: stop.approach.id } : null;
    const brakingSpeed = held ? Math.sqrt(2 * 3.6 * remaining) : Infinity;
    const leader = routeLeader({ samples: route, index: actor.pose.index, s: actor.s,
      reach: followingReach(actor.speed), ego: actor.collider,
      bodies: frameBodies, roadHeight: heightFor });
    if (!actor.blocker && leader.blocker && leader.limit < actor.desiredSpeed) {
      actor.blocker = { kind: leader.blocker.type, id: leader.blocker.id };
    }
    let rampSpeed = Infinity;
    for (let i = actor.pose.index; i < route.length && route[i].s <= actor.s + 22; i++) {
      rampSpeed = Math.min(rampSpeed, route[i].edge.rampSpeed ?? Infinity);
    }
    const desired = Math.min(actor.desiredSpeed, leader.limit, rampSpeed);
    const deceleration = leader.gap < 4 ? 7.5 : 3.6;
    const speed = Math.min(brakingSpeed, actor.speed + Math.max(-deceleration * dt, Math.min(2.2 * dt, desired - actor.speed)));
    const next = Math.min(actor.end, actor.s + speed * dt, held ? Math.max(actor.s, stoppingAt) : Infinity);
    const steps = Math.ceil((next - actor.s) / 0.25);
    let s = actor.s;
    for (let step = 1; step <= steps; step++) {
      const target = interpolate(actor.s, next, step / steps);
      const entering = stop && !actor.reservation && target > stoppingAt;
      if (entering) {
        const blocker = junctionExitBlocker(actor, stop, true);
        if (blocker) {
          signals.request(stop.approach, actor.id, elapsedSeconds, false);
          actor.blocker = { ...blocker, atExit: true };
          break;
        }
      }
      const movementBlocker = blockerOnRoute(actor, route, target, true);
      if (movementBlocker) { actor.blocker = movementBlocker; break; }
      if (entering) {
        if (!signals.enter(stop.approach, elapsedSeconds, actor.id)) break;
        actor.reservation = stop.approach;
        statistics.signalEntries++;
      }
      s = target;
      Object.assign(actor.pose, scratch);
      writeTrafficCollider(actor.collider, model, actor.pose);
    }
    if (actor.reservation && s >= stop.clearS) {
      signals.release(actor.reservation, actor.id);
      actor.reservation = null;
      actor.stopIndex++;
    }
    const waiting = Boolean(held && remaining < 1.1);
    if (waiting && !actor.waitingForSignal) statistics.signalWaits++;
    actor.waitingForSignal = waiting;
    if (s >= actor.end - 1e-6 && !actor.blocker) actor.blocker = { kind: 'route-end', atS: s };
    actor.stalled = s === actor.s && !waiting ? actor.stalled + dt : 0;
    actor.speed = steps > 0 && s === next ? speed : 0;
    actor.s = s;
    actor.collider.vx = actor.pose.sin * actor.speed;
    actor.collider.vz = actor.pose.cos * actor.speed;
  }

  function update(dt, focus, entities = [], elapsedSeconds = null, isVisible = null, pedestrians = []) {
    if (!Number.isFinite(focus?.x) || !Number.isFinite(focus?.z)) return;
    dt = Math.max(0, Math.min(dt, 0.05));
    simulationTime += dt;
    clock = Number.isFinite(elapsedSeconds) ? elapsedSeconds : clock + dt;
    players = entities.filter(entity => entity.position && entity.type !== 'helicopter')
      .map(entity => writeEntityCollider({}, entity));
    walkers = pedestrians;
    // 所有跟车决策读取帧首速度；实际推进仍按当前占用逐子步核验。
    frameBodies.length = 0;
    frameBodies.push(...players, ...walkers);
    for (const actor of vehicles) if (actor.route) frameBodies.push({ ...actor.collider });
    for (const actor of vehicles) {
      if (!actor.route) continue;
      const distance = squareDistance(actor.pose.x, actor.pose.z, focus);
      const inBore = actor.pose.edge?.tunnel === true;
      const outside = !inBore && distance > DESPAWN_RADIUS ** 2;
      const terminal = actor.s >= actor.end - 1e-6 && distance > RECYCLE_CLEARANCE ** 2;
      const blocked = actor.stalled > 5 && distance > 130 ** 2;
      // 视锥内保留实体和碰撞；未提供视锥时只按远距上限回收。
      if ((outside || terminal || blocked) && (isVisible ? !isVisible(actor.collider) : outside)) {
        dropRoute(actor);
        statistics.offscreenRecycled++;
      } else if (dt) advance(actor, dt, clock);
    }
    refill -= dt;
    if (refill <= 0 && vehicles.some(actor => !actor.route)) {
      refill = 0.17;
      const ix = Math.floor(focus.x / SPAWN_CELL), iz = Math.floor(focus.z / SPAWN_CELL);
      const key = cellKey(ix, iz);
      if (key !== spawnKey) {
        const reach = Math.ceil(SEARCH_RADIUS / SPAWN_CELL);
        spawnKey = key;
        candidates = [];
        approachCandidates = [];
        for (let x = ix - reach; x <= ix + reach; x++) {
          for (let z = iz - reach; z <= iz + reach; z++) {
            for (const marker of network.cells.get(cellKey(x, z)) ?? []) {
              // 桥面中途不生成车辆，避免车在桥上凭空出现；桥面车流只从落地引道驶入。
              if (marker.edge.elevated) continue;
              candidates.push(marker);
              if (marker.edge.next.some(next => next.elevated)) approachCandidates.push(marker);
            }
          }
        }
      }
      let attempts = 0;
      for (const actor of vehicles) {
        if (actor.route) continue;
        startRoute(actor, focus);
        if (++attempts >= 4) break;
      }
    }
    let active = 0;
    let wheelSlots = 0;
    for (const batch of batches) {
      const { mesh, actors } = batch;
      let count = 0;
      for (const actor of actors) {
        if (!actor.route) continue;
        const { pose } = actor;
        transform.position.set(pose.x, pose.y, pose.z);
        transform.rotation.set(pose.pitch, pose.heading, pose.roll, 'YXZ');
        transform.updateMatrix();
        mesh.setMatrixAt(count, transform.matrix);
        if (batch.wheels) {
          writeCarState(batch, actor, count);
          placeCarWheels(actor, wheelSlots, dt);
          wheelSlots++;
        }
        count++;
      }
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (batch.wheels) {
          mesh.geometry.attributes.paintColor.needsUpdate = true;
          mesh.geometry.attributes.carState.needsUpdate = true;
        }
      }
      mesh.count = count;
      active += count;
    }
    const wheelCount = wheelSlots * 2;
    if (wheelCount > 0) {
      wheelLeft.instanceMatrix.needsUpdate = true;
      wheelRight.instanceMatrix.needsUpdate = true;
      wheelStyles.needsUpdate = true;
    }
    wheelLeft.count = wheelCount;
    wheelRight.count = wheelCount;
    statistics.active = active;
  }

  function nearColliders(x, z, radius) {
    const result = [];
    for (const { route, collider } of vehicles) {
      if (route && collider.minX <= x + radius && collider.maxX >= x - radius
        && collider.minZ <= z + radius && collider.maxZ >= z - radius) result.push(collider);
    }
    return result;
  }

  return { group, update, nearColliders, vehicles, statistics, network, roadHeight: heightFor,
    dispose() {
      for (const actor of vehicles) dropRoute(actor);
      scene.remove(group);
      const geometries = new Set();
      for (const { mesh } of batches) {
        geometries.add(mesh.geometry);
        mesh.dispose();
      }
      geometries.add(wheelSetup.left);
      geometries.add(wheelSetup.right);
      for (const geometry of geometries) geometry.dispose();
      wheelSetup.material.dispose();
      busMaterial.dispose();
      wheelLeft.dispose();
      wheelRight.dispose();
    } };
}
