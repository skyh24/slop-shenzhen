import { hasRoadFootprint } from './sz-auto-drive.js';
import { bodyExtent, contactTime, sameTrafficLevel, writeEntityCollider } from './sz-driving-motion.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angle = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const MIN_SPEED = 4;

function laneCenters(edge, model) {
  if (edge.elevated || edge.highway === 'pedestrian' || edge.highway?.endsWith('_link')) return [];
  const { section, sign } = edge;
  if (section.estimated || section.narrow || (section.twoWay && section.reviewed)) return [];
  const width = sign === 1 ? section.forwardLaneWidthM : section.backwardLaneWidthM;
  if (width < model.hx * 2 + 0.45) return [];
  return sign === 1 ? section.forwardCentersM : section.backwardCentersM;
}

function laneFrame(segment, x, z) {
  const dx = x - segment.x, dz = z - segment.z;
  return { s: dx * segment.dx + dz * segment.dz, offset: dx * segment.dz - dz * segment.dx };
}

// 五次曲线的起终点与车道切线相同，横向加速度在起终点平滑归零。
function lanePose(run, s) {
  const { segment, start, length, from, to } = run;
  const t = clamp((s - start) / length, 0, 1);
  const offset = from + (to - from) * t ** 3 * (10 - 15 * t + 6 * t * t);
  const slope = (to - from) * 30 * t * t * (1 - t) ** 2 / length;
  return { x: segment.x + segment.dx * s + segment.dz * offset,
    z: segment.z + segment.dz * s - segment.dx * offset,
    heading: Math.atan2(segment.dx, segment.dz) + Math.atan(slope), offset };
}

function straightSpan(edge, index) {
  const first = edge.segments[index];
  let length = first.length;
  // 连续、几乎共线的采样点属于同一车道；遇到曲率或拓扑变化在该段内收尾。
  for (let i = index + 1; i < edge.segments.length; i++) {
    const part = edge.segments[i];
    if (Math.abs(laneFrame(first, part.x, part.z).offset) > 0.28
      || Math.abs(first.dz * part.dx - first.dx * part.dz) > 0.015
      || first.dx * part.dx + first.dz * part.dz <= 0) break;
    length += part.length;
  }
  return { ...first, length };
}

export function createLaneAssist({ network, model, roadHeight, control, isClear, nearTraffic }) {
  let run = null;
  let status = 'idle';
  let enabled = true;
  const ego = {};

  function roadAllows(plan, x, z, heading) {
    const margin = Math.hypot(model.hx, model.hz) + 0.8;
    if (control?.contains(x, z, margin)) return false;
    return hasRoadFootprint(roadHeight, model, x, z, heading, plan.edge);
  }

  function conflict(plan, car, s) {
    const { segment, to, start, length, speed } = plan;
    const horizon = clamp((start + length - s) / Math.max(speed, MIN_SPEED) + 0.6, 0.7, 4.5);
    const reach = 48 + Math.max(speed, car.speed) * horizon;
    const bodies = nearTraffic(car.position.x, car.position.z, reach);
    writeEntityCollider(ego, car);
    for (const body of bodies) {
      if (!sameTrafficLevel(ego, body)) continue;
      const relative = laneFrame(segment, body.x, body.z);
      const velocity = (body.vx ?? 0) * segment.dx + (body.vz ?? 0) * segment.dz;
      const sideways = (body.vx ?? 0) * segment.dz - (body.vz ?? 0) * segment.dx;
      const extent = bodyExtent(body, segment.dx, segment.dz) + model.hz;
      const width = bodyExtent(body, segment.dz, -segment.dx) + model.hx + 0.2;
      const gap = relative.s - s;
      const front = extent + Math.max(5, speed * 0.8) + Math.max(0, speed - velocity) ** 2 / 7;
      const rear = extent + Math.max(4, velocity * 0.8) + Math.max(0, velocity - speed) * (horizon + 0.4);
      const endOffset = relative.offset + sideways * horizon;
      if (Math.min(relative.offset, endOffset) < to + width && Math.max(relative.offset, endOffset) > to - width
        && gap >= -rear && gap <= front) return true;
      if (Number.isFinite(contactTime(ego, body, 0.75, undefined, undefined, 0.18))) return true;
    }
    return false;
  }

  function request(car, direction, manual) {
    if (run) return false;
    if (!enabled) { status = 'disabled'; return false; }
    if (manual) { status = 'release'; return false; }
    if (car.speed < MIN_SPEED) { status = 'slow'; return false; }
    status = 'unavailable';
    if (!network || (car._support?.surfaceId ?? 'terrain') !== 'terrain') return false;
    const { x, y, z } = car.position;
    let selected = null;
    for (const { edge, segment: index } of network.nearSegments(x, z, 24)) {
      const segment = edge.segments[index];
      const { s, offset } = laneFrame(segment, x, z);
      const heading = Math.atan2(segment.dx, segment.dz);
      if (s < 0 || s > segment.length || Math.abs(offset) > edge.section.travelWidthM / 2
        || Math.abs(angle(heading, car.heading)) > 0.16) continue;
      if (!hasRoadFootprint(roadHeight, model, x, z, car.heading, edge, y)) continue;
      const lanes = laneCenters(edge, model);
      const lane = lanes.reduce((best, center, i) => Math.abs(center - offset) < Math.abs(lanes[best] - offset) ? i : best, 0);
      const error = Math.abs(lanes[lane] - offset);
      if (!(error < 0.95) || (selected && error >= selected.error)) continue;
      selected = { edge, index, s, offset, to: lanes[lane + direction], error };
    }
    if (!selected || !Number.isFinite(selected.to)) return false;
    const segment = straightSpan(selected.edge, selected.index);
    const { s: start, offset: from, to, edge } = selected;
    const speed = car.speed;
    const duration = Math.max(2.7, Math.sqrt(5.78 * Math.abs(to - from) / 1.65));
    const length = speed * duration;
    const plan = { segment, start, from, to, length, edge, speed };
    // 预留对正和车辆净空。未核实的下一条边、分岔与桥面不跨越。
    const last = start + length + Math.max(10, speed * 1.1);
    if ((selected.index === 0 && start < 8 + model.hz) || last > segment.length - 8 - model.hz) return false;
    for (let s = start; s <= last; s = Math.min(s + 1.5, last)) {
      const pose = lanePose(plan, s);
      const height = roadHeight(pose.x, pose.z, edge);
      if (!roadAllows(plan, pose.x, pose.z, pose.heading) || !isClear({ ...pose, y: height })) return false;
      if (s === last) break;
    }
    if (conflict(plan, car, start)) { status = 'occupied'; return false; }
    run = plan;
    status = 'changing';
    return true;
  }

  function cancel(reason = 'cancelled') {
    if (!run) return;
    run = null;
    status = reason;
  }

  function update(car, { manual = false } = {}) {
    if (manual) cancel();
    if (!run) return null;
    const plan = run;
    const { segment, start, length, to, speed } = plan;
    const { s, offset } = laneFrame(segment, car.position.x, car.position.z);
    const tangent = Math.atan2(segment.dx, segment.dz);
    if (s >= start + length && Math.abs(offset - to) < 0.18 && Math.abs(angle(tangent, car.heading)) < 0.012
      && Math.abs(car.angularVel ?? 0) < 0.04) {
      cancel('complete');
      return null;
    }
    const blocked = s > segment.length - model.hz - 9 || conflict(plan, car, s);
    status = blocked ? 'waiting' : 'changing';
    const target = lanePose(plan, Math.min(segment.length - model.hz, s + Math.max(3.5, car.speed * 0.44)));
    const dx = target.x - car.position.x, dz = target.z - car.position.z;
    const lateral = dx * Math.cos(car.heading) - dz * Math.sin(car.heading);
    const demand = speed - car.speed;
    return {
      throttle: blocked ? 0 : clamp(demand * 0.55, 0, 1),
      brake: blocked ? 0.68 : clamp(-demand * 0.55, 0, 1),
      steerAngle: Math.atan2(4 * model.halfWheelbase * lateral, dx * dx + dz * dz),
      permitMove(x, z, heading) {
        if (roadAllows(plan, x, z, heading)) return true;
        cancel('unavailable');
        return false;
      }
    };
  }

  return { request, cancel, update, get active() { return Boolean(run); }, get status() { return status; },
    get enabled() { return enabled; },
    set enabled(value) {
      enabled = value;
      if (!enabled) cancel('disabled');
      else if (status === 'disabled') status = 'idle';
    } };
}
