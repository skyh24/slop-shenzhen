import { hasRoadFootprint } from './sz-auto-drive.js';
import { laneOffsets } from './sz-road-section.js';
import { bodyExtent, contactTime, sameTrafficLevel, writeEntityCollider } from './sz-driving-motion.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angle = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const MIN_SPEED = 4;

function laneCenters(edge, model) {
  if (edge.elevated || edge.highway === 'pedestrian' || edge.highway?.endsWith('_link')) return [];
  const { section, sign } = edge;
  // 宽度估计与窄路仍不换道；已核实断面或 OSM 车道数才有可信的车道中心。
  if (section.estimated || section.narrow) return [];
  const width = sign === 1 ? section.forwardLaneWidthM : section.backwardLaneWidthM;
  if (width < model.hx * 2 + 0.45) return [];
  const offsets = laneOffsets(section);
  // laneOffsets 以行驶方向右侧为正、末位最靠路缘；换回 laneFrame 的左侧为正，并保留原有次序。
  if (offsets?.length) return offsets.map(offset => -offset).reverse();
  // 无车道数据时沿用旧规则：双向已核实路不换道，其余退回断面中心数组。
  if (section.twoWay && section.reviewed) return [];
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
  // 最近一次换道请求被拒绝的原因，仅供 QA 读取，不影响行为。
  let detail = null;
  const fail = reason => { detail = reason; return null; };
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

  // 曲线路段由许多小段拼成，每个采样点的横向偏移要按各自最近的段计算。
  // 只按起点的单一小段算，缓弯上偏移会随里程漂移，换道会被误判为“没有直线空间”。
  function laneOffsetAt(edge, x, z) {
    let best = null;
    for (const part of edge.segments) {
      const { s, offset } = laneFrame(part, x, z);
      if (s < -0.5 || s > part.length + 0.5) continue;
      if (best === null || Math.abs(offset) < Math.abs(best)) best = offset;
    }
    return best;
  }

  function request(route, car, direction, index, limitS) {
    // detail 只用于 QA 诊断换道为什么没有开始，不影响行为。
    if (run) return fail('busy');
    if (!enabled) { status = 'disabled'; return fail('disabled'); }
    if (car.speed < MIN_SPEED) { status = 'slow'; return fail('slow'); }
    status = 'unavailable';
    detail = null;
    const { samples, limits } = route;
    const first = index + 1;
    const start = samples[first];
    if (!start?.edge) return fail('sample');
    if ((car._support?.surfaceId ?? 'terrain') !== 'terrain') return fail('level');
    const { edge } = start;
    const { x, y, z } = car.position;
    const centers = laneCenters(edge, model);
    if (centers.length < 2) return fail('centers');
    if (Math.abs(angle(Math.atan2(start.dx, start.dz), car.heading)) > 0.16) return fail('heading');
    if (!hasRoadFootprint(roadHeight, model, x, z, car.heading, edge, y)) return fail('footprint');
    // 同一条路上可能有平行的多段几何，取离起点最近的一段，其他平行段不参与换道。
    let segment = null, nearest = Infinity;
    for (const part of edge.segments) {
      const { s, offset } = laneFrame(part, start.x, start.z);
      if (s < 0 || s > part.length || Math.abs(offset) >= nearest) continue;
      // 路线在转弯处做了平滑，采样方向与原始段方向可以差几度，不能要求几乎完全平行。
      if (start.dx * part.dx + start.dz * part.dz < 0.99) continue;
      segment = part;
      nearest = Math.abs(offset);
    }
    if (!segment) return fail('segment');
    const { offset: from } = laneFrame(segment, start.x, start.z);
    const lane = centers.findIndex(center => Math.abs(center - from) < 0.65);
    const to = centers[lane + direction];
    // 诊断串带上实际横向位置与车道中心，便于定位“找不到本车道”和“已在最外侧”。
    if (lane < 0) return fail(`lane:${from.toFixed(2)}:${centers.map(center => center.toFixed(2)).join('/')}`);
    if (!Number.isFinite(to)) return fail(`outer:${lane}:${from.toFixed(2)}:${centers.map(center => center.toFixed(2)).join('/')}`);

    // 一条路在 OSM 里常被拆成多条 way，换道可以跨到相连的同向 way，但要逐段取自己的车道中心。
    const targetOf = (() => {
      const cache = new Map();
      return part => {
        if (!cache.has(part)) cache.set(part, laneCenters(part, model)[lane + direction]);
        return cache.get(part);
      };
    })();
    // 只改动同一条路上的内部采样点；过路口、出本车道或到达停靠点前回到规划车道。
    // 缓弯不算转弯：换道轨迹跟着各采样点自身的车道中心走，弯道上也能完成，不需要额外找直线。
    let last = first, why = 'route', current = edge;
    for (let i = first + 1; i < samples.length - 1; i++) {
      const point = samples[i];
      if (point.edge !== current) {
        if (!(current.next ?? []).includes(point.edge)) { why = `edge@${i}`; break; }
        current = point.edge;
      }
      if (!Number.isFinite(targetOf(current))) { why = `lanes@${i}`; break; }
      if (point.s >= limitS - 12) { why = `limit@${i}`; break; }
      const offset = laneOffsetAt(current, point.x, point.z);
      if (offset === null) { why = `null@${i}`; break; }
      if (Math.abs(offset - from) > 0.6) { why = `drift@${i}:${offset.toFixed(2)}/${from.toFixed(2)}`; break; }
      last = i;
    }
    let speed = car.speed;
    // 定速巡航的路线只带弯道限速，没有逐点限速表；缺表时按当前车速估算换道长度。
    for (let i = first; i <= last; i++) {
      const limit = limits?.[i];
      if (Number.isFinite(limit)) speed = Math.max(speed, limit);
    }
    const delta = to - from;
    const length = speed * Math.max(2.7, Math.sqrt(5.78 * Math.abs(delta) / 1.65));
    const end = samples[last].s;
    if (end - start.s < length * 2 + speed * 0.5) return fail(`room:${Math.round(end - start.s)}:${Math.round(length * 2 + speed * 0.5)}:${why}`);
    if (conflict(segment, car, to, speed, Math.min(4.5, length / speed + 0.6))) {
      status = 'occupied';
      return fail('conflict');
    }

    const shifted = samples.slice(0, first);
    const smooth = t => t ** 3 * (10 - 15 * t + 6 * t ** 2);
    const shiftAt = s => Math.min(clamp((s - start.s) / length, 0, 1), clamp((end - s) / length, 0, 1));
    let returnS = start.s, outS = start.s;
    for (let i = first; i <= last; i++) {
      const point = samples[i];
      const t = shiftAt(point.s);
      // 相对采样点自己的车道偏移做平移，弯道上换道轨迹与车道中心平行，不会偏出路面。
      const own = laneOffsetAt(point.edge, point.x, point.z);
      const target = targetOf(point.edge);
      const offset = Number.isFinite(own) && Number.isFinite(target) ? target - own : delta;
      const slope = offset * 30 * t ** 2 * (1 - t) ** 2 / length * (point.s < end - length ? 1 : -1);
      const heading = Math.atan2(point.dx, point.dz) + Math.atan(slope);
      const lateral = offset * smooth(t);
      const pose = { ...point, x: point.x + point.dz * lateral, z: point.z - point.dx * lateral,
        dx: Math.sin(heading), dz: Math.cos(heading) };
      const previous = shifted.at(-1);
      const step = Math.hypot(pose.x - previous.x, pose.z - previous.z);
      if (!roadAllows(point.edge, pose.x, pose.z, heading)
        || (i > first && !roadAllows(point.edge, (pose.x + previous.x) / 2, (pose.z + previous.z) / 2, heading))) return fail('shift');
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
    // 并入目标车道的里程，定速巡航据此改按新车位重规划。
    get mergedS() { return run?.outS ?? Infinity; },
    get detail() { return detail; },
    get enabled() { return enabled; },
    set enabled(value) { enabled = value; } };
}
