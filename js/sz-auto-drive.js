import { insideSignalBounds } from './sz-intersection-control.js';
import { writeTrafficCollider } from './sz-traffic.js';
import { vehicleContact } from './vehicle-physics.js';

const ACTOR = 'player-autodrive';
const ROAD_MARGIN = 0.05;
const LOOK_AHEAD = 32;
const headingError = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 接触面身份随每个采样点下传：高架段只查桥面，桥下地面段不会被桥面高度串走。
// edges 可为单条边、边数组或 null；数组用于地面/高架衔接处按附近段表面逐点回退。
export function hasRoadFootprint(roadHeight, model, x, z, heading, edges = null) {
  const list = edges == null || (Array.isArray(edges) && edges.length === 0) ? [null] : Array.isArray(edges) ? edges : [edges];
  const heightAt = (px, pz) => {
    for (const edge of list) {
      const height = roadHeight(px, pz, edge);
      if (Number.isFinite(height)) return height;
    }
    return null;
  };
  if (!Number.isFinite(heightAt(x, z))) return false;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  return model.corners.every(([px, pz]) => Number.isFinite(heightAt(x + px * cos + pz * sin, z - px * sin + pz * cos)));
}

function project(samples, x, z, from, to) {
  let best = null;
  for (let i = from; i < samples.length - 1 && samples[i].s <= to; i++) {
    const a = samples[i], b = samples[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, length = b.s - a.s;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / length ** 2, 0, 1);
    const error = Math.hypot(a.x + t * dx - x, a.z + t * dz - z);
    if (!best || error < best.error) best = { i, s: a.s + t * length, error, dx: dx / length, dz: dz / length };
  }
  return best;
}

function sampleAhead(samples, index, s) {
  while (index < samples.length - 2 && samples[index + 1].s < s) index++;
  const a = samples[index], b = samples[index + 1];
  const t = clamp((s - a.s) / (b.s - a.s), 0, 1);
  return { x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z), i: index };
}

function frontDistance(approach, model, x, z, heading) {
  const along = Math.sin(heading) * approach.dx + Math.cos(heading) * approach.dz;
  const across = Math.cos(heading) * approach.dx - Math.sin(heading) * approach.dz;
  return (x - approach.stopX) * approach.dx + (z - approach.stopZ) * approach.dz
    + Math.abs(along) * model.hz + Math.abs(across) * model.hx + model.z * along + model.x * across;
}

function stopForTraffic(run, model, car, nearTraffic, reach) {
  let stop = Infinity;
  for (const body of nearTraffic(car.position.x, car.position.z, reach)) {
    if (body.minY > car.position.y + 2.5 || body.maxY < car.position.y - 1.5) continue;
    const ahead = project(run.route.samples, body.x, body.z, Math.max(0, run.index - 2), run.s + reach + 4);
    if (!ahead) continue;
    const parallel = Math.abs(body.sin * ahead.dx + body.cos * ahead.dz);
    const perpendicular = Math.abs(body.cos * ahead.dx - body.sin * ahead.dz);
    const across = body.halfW * parallel + body.halfL * perpendicular;
    const along = body.halfL * parallel + body.halfW * perpendicular;
    if (ahead.error > model.hx + across + 0.35 || ahead.s + along < run.s - 0.5) continue;
    stop = Math.min(stop, ahead.s - along - model.hz - 1.1);
  }
  return stop;
}

export function createAutoDrive({ model, roadHeight, control, nearTraffic = () => [] }) {
  let run = null;
  let reservation = null;
  let status = 'idle';
  const statistics = { routeLength: 0, travelled: 0, signalWaits: 0, intersectionWaits: 0, signalEntries: 0 };
  const intersectionMargin = Math.hypot(model.hx, model.hz) + 0.35;
  const candidate = {}, contact = {};

  // 取当前进度前后 ±8 m 内的路段表面，与 poseOnRoute 在衔接处的取边窗口一致；
  // 地面与高架端头各自只覆盖到自己的端头，四角需要能回退到相邻段的表面。
  function routeEdges(route, index) {
    const list = [];
    const center = route.samples[index]?.s ?? 0;
    for (let i = Math.max(0, index - 6); i <= Math.min(route.samples.length - 1, index + 6); i++) {
      const sample = route.samples[i];
      if (!sample || Math.abs(sample.s - center) > 8) continue;
      const edge = sample.edge;
      if (edge && !list.includes(edge)) list.push(edge);
    }
    return list;
  }

  function release() {
    if (reservation) control.release(reservation, ACTOR);
    reservation = null;
  }

  function canStart(route, car, mode) {
    return Boolean(route && !run && mode === 'car' && Math.abs(car.speed) <= 0.3
      && Math.hypot(car.position.x - route.from.x, car.position.z - route.from.z) <= 1.25
      && Math.abs(headingError(car.heading, Math.atan2(route.from.dx, route.from.dz))) <= 0.28
      && !control?.contains(car.position.x, car.position.z, intersectionMargin)
      && hasRoadFootprint(roadHeight, model, car.position.x, car.position.z, car.heading, route.from.edge));
  }

  function start(route, car, mode) {
    if (!canStart(route, car, mode)) return false;
    release();
    run = { route, index: 0, stopIndex: 0, s: 0, stalled: 0, unsafe: false };
    Object.assign(statistics, { routeLength: route.length, travelled: 0, signalWaits: 0, intersectionWaits: 0, signalEntries: 0 });
    status = 'driving';
    return true;
  }

  function stop(reason = 'idle') {
    if (run?.request) control.cancelRequest(run.request, ACTOR);
    if (run || reason === 'idle') status = reason;
    run = null;
  }

  function update(car, { dt, elapsed, mode, manual }) {
    const clearsReservation = reservation && !insideSignalBounds(reservation.bounds, car.position.x, car.position.z, intersectionMargin);
    if (reservation && !run && (clearsReservation
      || frontDistance(reservation, model, car.position.x, car.position.z, car.heading) < -0.4)) release();
    if (!run) return null;
    if (mode !== 'car' || manual) { stop('manual'); return null; }
    if (run.unsafe) { stop('blocked'); return null; }
    const { route } = run;
    const progress = project(route.samples, car.position.x, car.position.z, Math.max(0, run.index - 2), run.s + 18);
    if (!progress || progress.error > 2.6) { stop('blocked'); return null; }
    run.index = progress.i;
    const advance = progress.s - run.s;
    run.s = Math.max(run.s, progress.s);
    statistics.travelled = run.s;
    if (route.length - run.s < 0.7 && Math.abs(car.speed) < 0.15) { stop('arrived'); return null; }

    let signal = route.stops[run.stopIndex];
    if (signal && run.s >= signal.clearS && (!reservation || clearsReservation)) {
      release();
      signal = route.stops[++run.stopIndex];
    }
    const stopAt = signal ? signal.s - model.hz - model.z - 0.65 : Infinity;
    const speed = Math.max(0, car.speed);
    // 在仍可停车的位置先检查到冲突区出口，给已经在路口内的车留出驶离空间。
    const nearStop = signal && !reservation && stopAt - run.s < Math.max(18, speed ** 2 / 3.3 + 4);
    const reach = nearStop ? Math.max(LOOK_AHEAD, signal.clearS - run.s + 8) : LOOK_AHEAD;
    const vehicleStop = stopForTraffic(run, model, car, nearTraffic, reach);
    const exitBlocked = nearStop && vehicleStop < signal.clearS + 2;
    const requested = signal && !reservation && stopAt - run.s <= 4 ? signal.approach : null;
    if (run.request && run.request !== requested) control.cancelRequest(run.request, ACTOR);
    if (requested) control.request(requested, ACTOR, elapsed, !exitBlocked);
    run.request = requested;
    const held = signal && (exitBlocked || !control.canEnter(signal.approach, elapsed, ACTOR));
    const target = sampleAhead(route.samples, run.index, Math.min(route.length, run.s + Math.min(9, 3.5 + speed * 0.43)));
    const dx = target.x - car.position.x, dz = target.z - car.position.z;
    const lateral = dx * Math.cos(car.heading) - dz * Math.sin(car.heading);
    const desiredSteer = Math.atan2(4 * model.halfWheelbase * lateral, dx * dx + dz * dz);
    const lastStop = Math.min(route.length - 0.24, held ? stopAt : Infinity, vehicleStop);
    const remaining = Math.max(0, lastStop - run.s);
    const targetSpeed = Math.min(route.limits[run.index], Math.sqrt(3.3 * remaining));
    let state = vehicleStop - run.s < 4 ? 'traffic' : 'driving';
    if (held && stopAt - run.s < 4) {
      const { sourceIndex, to } = signal.approach;
      state = control.approachState(sourceIndex, to, elapsed).phase === 'green' ? 'intersection' : 'signal';
    }
    if (state === 'signal' && status !== 'signal') statistics.signalWaits++;
    if (state === 'intersection' && status !== 'intersection') statistics.intersectionWaits++;
    status = state;
    run.stalled = advance < 0.004 && state === 'driving' ? run.stalled + dt : 0;
    if (run.stalled > 7) { stop('blocked'); return null; }

    const demand = targetSpeed - speed;
    // 许可检查沿用当前路线采样点及其相邻段的表面身份：地面/高架衔接处四角逐点回退，避免误判无路面。
    const contactEdges = routeEdges(route, run.index);
    return {
      throttle: clamp(demand * 0.52, 0, 1),
      brake: car.speed < -0.05 ? 1 : clamp(-demand * 0.5, 0, 1),
      steerAngle: desiredSteer,
      permitMove(x, z, heading) {
        if (!hasRoadFootprint(roadHeight, model, x, z, heading, contactEdges)) {
          run.unsafe = true;
          return false;
        }
        // 控制器在积分及碰撞推出后都检查候选，用当前悬架姿态和同源车身核对近车净空。
        const pivot = car.chassisPivot;
        writeTrafficCollider(candidate, model, { x, y: car.position.y + (pivot?.position.y ?? 0), z,
          heading, sin: Math.sin(heading), cos: Math.cos(heading),
          pitch: pivot?.rotation.x ?? 0, roll: pivot?.rotation.z ?? 0 });
        const extent = Math.max(x - candidate.minX, candidate.maxX - x, z - candidate.minZ, candidate.maxZ - z);
        for (const body of nearTraffic(x, z, extent)) {
          if (candidate.minY < body.maxY && candidate.maxY > body.minY && vehicleContact(candidate, body, contact)) {
            run.stalled = 0;
            if (status === 'driving') status = 'traffic';
            return false;
          }
        }
        if (!signal || reservation || signal.s - run.s > 20
          || frontDistance(signal.approach, model, x, z, heading) < -ROAD_MARGIN) return true;
        if (exitBlocked || !control.enter(signal.approach, elapsed, ACTOR)) return false;
        reservation = signal.approach;
        statistics.signalEntries++;
        return true;
      }
    };
  }

  return { start, stop, update, canStart, get active() { return Boolean(run); }, get status() { return status; }, statistics };
}
