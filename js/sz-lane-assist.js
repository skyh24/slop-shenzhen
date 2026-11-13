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
export function createLaneAssist({ model, roadHeight, control, isClear, nearTraffic }) {
  let run = null;
  let status = 'idle';
  let enabled = true;
  const ego = {};

  function roadAllows(edge, x, z, heading) {
    const margin = Math.hypot(model.hx, model.hz) + 0.8;
    if (control?.contains(x, z, margin)) return false;
    const y = roadHeight(x, z, edge);
    return hasRoadFootprint(roadHeight, model, x, z, heading, edge) && isClear({ x, y, z, heading, edge });
  }

  function conflict(segment, car, to, speed, horizon) {
    const { s } = laneFrame(segment, car.position.x, car.position.z);
    const bodies = nearTraffic(car.position.x, car.position.z, 48 + speed * horizon);
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

  function request(route, car, direction, index, limitS) {
    if (run) return null;
    if (!enabled) { status = 'disabled'; return null; }
    if (car.speed < MIN_SPEED) { status = 'slow'; return null; }
    status = 'unavailable';
    const { samples, limits } = route;
    const first = index + 1;
    const start = samples[first];
    if (!start?.edge || (car._support?.surfaceId ?? 'terrain') !== 'terrain') return null;
    const { edge } = start;
    const { x, y, z } = car.position;
    const centers = laneCenters(edge, model);
    if (centers.length < 2 || Math.abs(angle(Math.atan2(start.dx, start.dz), car.heading)) > 0.16
      || !hasRoadFootprint(roadHeight, model, x, z, car.heading, edge, y)) return null;
    const segment = edge.segments.find(segment => {
      const { s } = laneFrame(segment, start.x, start.z);
      return s >= 0 && s <= segment.length && start.dx * segment.dx + start.dz * segment.dz > 0.9999;
    });
    if (!segment) return null;
    const { offset: from } = laneFrame(segment, start.x, start.z);
    const lane = centers.findIndex(center => Math.abs(center - from) < 0.65);
    const to = centers[lane + direction];
    if (lane < 0 || !Number.isFinite(to)) return null;

    // 仅改动同一条直路的内部采样点；过路口、转弯和停靠前回到规划车道。
    let last = first;
    for (let i = first + 1; i < samples.length - 1; i++) {
      const point = samples[i];
      if (point.edge !== edge || point.s >= limitS - 12
        || Math.abs(laneFrame(segment, point.x, point.z).offset - from) > 0.12
        || point.dx * segment.dx + point.dz * segment.dz < 0.9999) break;
      last = i;
    }
    let speed = car.speed;
    for (let i = first; i <= last; i++) speed = Math.max(speed, limits[i]);
    const delta = to - from;
    const length = speed * Math.max(2.7, Math.sqrt(5.78 * Math.abs(delta) / 1.65));
    const end = samples[last].s;
    if (end - start.s < length * 2 + speed * 1.25) return null;
    if (conflict(segment, car, to, speed, Math.min(4.5, length / speed + 0.6))) {
      status = 'occupied';
      return null;
    }

    const shifted = samples.slice(0, first);
    const smooth = t => t ** 3 * (10 - 15 * t + 6 * t ** 2);
    const shiftAt = s => Math.min(clamp((s - start.s) / length, 0, 1), clamp((end - s) / length, 0, 1));
    let returnS = start.s, outS = start.s;
    for (let i = first; i <= last; i++) {
      const point = samples[i];
      const t = shiftAt(point.s);
      const offset = delta * smooth(t);
      const slope = delta * 30 * t ** 2 * (1 - t) ** 2 / length * (point.s < end - length ? 1 : -1);
      const heading = Math.atan2(point.dx, point.dz) + Math.atan(slope);
      const pose = { ...point, x: point.x + segment.dz * offset, z: point.z - segment.dx * offset,
        dx: Math.sin(heading), dz: Math.cos(heading) };
      const previous = shifted.at(-1);
      const step = Math.hypot(pose.x - previous.x, pose.z - previous.z);
      if (!roadAllows(edge, pose.x, pose.z, heading)
        || (i > first && !roadAllows(edge, (pose.x + previous.x) / 2, (pose.z + previous.z) / 2, heading))) return null;
      pose.s = previous.s + step;
      if (point.s <= start.s + length) outS = pose.s;
      if (point.s <= end - length) returnS = pose.s;
      shifted.push(pose);
    }
    const endS = shifted.at(-1).s;
    const extra = endS - end;
    for (let i = last + 1; i < samples.length; i++) shifted.push({ ...samples[i], s: samples[i].s + extra });
    const stops = route.stops.map(stop => stop.s >= end ? { ...stop, s: stop.s + extra, clearS: stop.clearS + extra } : stop);
    run = { segment, from, to, speed, outS, returnS, endS };
    status = 'changing';
    return { ...route, samples: shifted, stops, length: route.length + extra, to: shifted.at(-1) };
  }

  function cancel(reason = 'idle') {
    run = null;
    status = reason;
  }

  // 换道时仍由自动驾驶跟车、过信号和扫掠接触；临近并入时再复核目标车道后方。
  function update(car, s) {
    if (!run) return false;
    const { segment, from, to, speed, outS, returnS, endS } = run;
    if (s >= endS) { cancel('complete'); return false; }
    const check = s < outS + 2 ? to : s >= returnS - Math.max(8, car.speed ** 2 / 9) ? from : null;
    const waiting = check !== null && conflict(segment, car, check, speed, 3.5);
    status = waiting ? 'waiting' : 'changing';
    return waiting;
  }

  return { request, cancel, update, get active() { return Boolean(run); }, get status() { return status; },
    get enabled() { return enabled; },
    set enabled(value) { enabled = value; } };
}
