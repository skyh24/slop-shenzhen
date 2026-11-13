import { insideSignalBounds } from './sz-intersection-control.js';
import { vehicleContact } from './vehicle-physics.js';
import { emergencyBrake, followingReach, routeLeader, sameTrafficLevel, writeEntityCollider, writeTrafficCollider } from './sz-driving-motion.js';

const ACTOR = 'player-autodrive';
const ROAD_MARGIN = 0.05;
const START_HEIGHT_TOLERANCE = 0.26;
const headingError = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 接触面身份随每个采样点下传：高架段只查桥面，桥下地面段不会被桥面高度串走。
// edges 可为单条边、边数组或 null；数组用于地面/高架衔接处按附近段表面逐点回退。
export function hasRoadFootprint(roadHeight, model, x, z, heading, edges = null, centerY = null) {
  const list = edges == null || (Array.isArray(edges) && edges.length === 0) ? [null] : Array.isArray(edges) ? edges : [edges];
  const heightAt = (px, pz) => {
    for (const edge of list) {
      const height = roadHeight(px, pz, edge);
      if (Number.isFinite(height) && (centerY === null || Math.abs(height - centerY) <= 1.5)) return height;
    }
    return null;
  };
  const height = heightAt(x, z);
  if (!Number.isFinite(height) || (centerY !== null && !(Math.abs(height - centerY) <= START_HEIGHT_TOLERANCE))) return false;
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

export function createAutoDrive({ model, roadHeight, control, nearTraffic = () => [], replan = () => null }) {
  let run = null;
  let departure = null;
  let activeRoute = null;
  let speedMps = 0;
  let reservation = null;
  let status = 'idle';
  const statistics = { routeLength: 0, travelled: 0, signalWaits: 0, intersectionWaits: 0, signalEntries: 0 };
  const intersectionMargin = Math.hypot(model.hx, model.hz) + 0.35;
  const candidate = {}, contact = {}, ego = {};

  // 取当前进度前后 ±8 m 内的路段表面，与 poseOnRoute 在衔接处的取边窗口一致；
  // 地面与高架端头各自只覆盖到自己的端头，四角需要能回退到相邻段的表面。
  function routeEdges(route, index, position) {
    const list = [];
    const reach = Math.hypot(model.hx, model.hz) + 2;
    for (let i = Math.max(0, index - 6); i <= Math.min(route.samples.length - 1, index + 6); i++) {
      const sample = route.samples[i];
      if (!sample || Math.hypot(sample.x - position.x, sample.z - position.z) > reach + 3) continue;
      const edge = sample.edge;
      for (const candidate of [edge, route.samples[i + 1]?.edge]) {
        if (candidate && !list.includes(candidate)) list.push(candidate);
      }
    }
    const edge = route.samples[index]?.edge;
    if (list.includes(edge)) list.unshift(list.splice(list.indexOf(edge), 1)[0]);
    return list;
  }

  function release() {
    if (reservation) control.release(reservation, ACTOR);
    reservation = null;
  }

  function canStart(route, car, mode) {
    if (!route || run || departure || mode !== 'car' || !(Math.abs(car.speed) <= 0.3)) return false;
    const { x, y, z } = car.position;
    const { x: startX, z: startZ, dx, dz, edge } = route.from;
    const aligned = Math.hypot(x - startX, z - startZ) <= 1.25
      && Math.abs(headingError(car.heading, Math.atan2(dx, dz))) <= 0.28;
    if (!aligned || (!edge?.surfaceId && control?.contains(x, z, intersectionMargin))) return false;
    const surfaceId = edge?.surfaceId ?? 'terrain';
    const support = car._support;
    // 控制器把当前支撑记为 { surfaceId, height }。无支撑记录的调用方仅可用实采地面启动。
    if ((support?.surfaceId ?? 'terrain') !== surfaceId || !Number.isFinite(y)) return false;
    if (support && (!Number.isFinite(support.height) || Math.abs(support.height - y) > START_HEIGHT_TOLERANCE)) return false;
    // 只比较车心高程，坡道的四角各取自己的接触高度。
    return hasRoadFootprint(roadHeight, model, x, z, car.heading, edge, y);
  }

  function start(route, car, mode) {
    if (!canStart(route, car, mode)) return false;
    release();
    const startS = project(route.samples ?? [], car.position.x, car.position.z, 0, 3)?.s ?? 0;
    run = { route, index: 0, stopIndex: 0, s: startS, stalled: 0, unsafe: null, paused: false, replanned: false };
    activeRoute = route;
    Object.assign(statistics, { routeLength: route.length, travelled: startS, signalWaits: 0, intersectionWaits: 0, signalEntries: 0 });
    status = 'driving';
    return true;
  }

  function stop(reason = 'idle') {
    if (run?.request) control.cancelRequest(run.request, ACTOR);
    if (run || departure || reason === 'idle') status = reason;
    run = null;
    departure = null;
    if (reason === 'idle') activeRoute = null;
  }

  function queue(route, prepare) {
    if (!route || run || departure) return false;
    departure = { route, prepare, wait: 0, retry: 0 };
    activeRoute = route;
    Object.assign(statistics, { routeLength: route.length, travelled: 0 });
    status = 'preparing';
    return true;
  }

  function pause() {
    if (!run || run.paused || run.unsafe) return;
    run.paused = true;
    if (run.request) control.cancelRequest(run.request, ACTOR);
    run.request = null;
    status = 'pausing';
  }

  function resume() {
    if (!run?.paused || status !== 'paused') return;
    run.paused = false;
    status = 'driving';
  }

  function canReplace(next, car, mode) {
    const previous = run;
    run = null;
    if (!canStart(next, car, mode)) { run = previous; return false; }
    run = previous;
    stop('idle');
    return start(next, car, mode);
  }

  function update(car, { dt, elapsed, mode, manual }) {
    const clearsReservation = reservation && !insideSignalBounds(reservation.bounds, car.position.x, car.position.z, intersectionMargin);
    if (reservation && !run && (clearsReservation
      || frontDistance(reservation, model, car.position.x, car.position.z, car.heading) < -0.4)) release();
    speedMps = mode === 'car' ? Math.abs(car.speed) : 0;
    if (manual && (run || departure)) { stop('manual'); return null; }
    if (departure) {
      const pending = departure;
      pending.wait += dt;
      pending.retry -= dt;
      if (pending.retry > 0) return null;
      departure = null;
      const ready = pending.prepare(pending.route);
      if (ready === 'car' && start(pending.route, car, ready)) return update(car, { dt, elapsed, mode: ready, manual: false });
      if (ready === 'occupied' && pending.wait < 30) {
        pending.retry = 0.4;
        departure = pending;
        status = 'occupied';
      } else status = 'startUnavailable';
      return null;
    }
    if (!run) return null;
    if (mode !== 'car') { stop('manual'); return null; }
    if (run.unsafe) {
      // 静态净空或承托失败时已由扫掠拒绝移动；不把临时车流等待计作失效。
      const next = !reservation && !run.replanned && replan(run.route, car, run.route.samples[run.index]?.edge, run.unsafe);
      if (next && canReplace(next, car, mode)) {
        run.replanned = true;
        return update(car, { dt, elapsed, mode, manual: false });
      }
      stop('blocked');
      return null;
    }
    const { route } = run;
    const progress = project(route.samples, car.position.x, car.position.z, Math.max(0, run.index - 2), run.s + 18);
    if (!progress || progress.error > 2.6) { stop('blocked'); return null; }
    run.index = progress.i;
    const advance = progress.s - run.s;
    run.s = Math.max(run.s, progress.s);
    statistics.travelled = run.s;
    if (route.length - run.s < 0.7 && Math.abs(car.speed) < 0.05) {
      stop('arrived');
      return { throttle: 0, brake: 1, steerAngle: 0, permitMove: () => true };
    }

    let signal = route.stops[run.stopIndex];
    if (signal && run.s >= signal.clearS && (!reservation || clearsReservation)) {
      release();
      signal = route.stops[++run.stopIndex];
    }
    const stopAt = signal ? signal.s - model.hz - model.z - 0.65 : Infinity;
    const speed = Math.max(0, car.speed);
    // 在仍可停车的位置先检查到冲突区出口，给已经在路口内的车留出驶离空间。
    const nearStop = signal && !reservation && stopAt - run.s < Math.max(18, speed ** 2 / 3.3 + 4);
    const reach = Math.max(followingReach(speed), nearStop ? signal.clearS - run.s + 8 : 0);
    const bodies = nearTraffic(car.position.x, car.position.z, reach);
    const egoBody = writeEntityCollider(ego, car);
    const leader = routeLeader({ samples: route.samples, index: run.index, s: run.s, reach,
      ego: egoBody, bodies, roadHeight });
    const exitBlocked = nearStop && leader.gap + run.s < signal.clearS + 2;
    const requested = signal && !run.paused && !reservation && stopAt - run.s <= 4 ? signal.approach : null;
    if (run.request && run.request !== requested) control.cancelRequest(run.request, ACTOR);
    if (requested) control.request(requested, ACTOR, elapsed, !exitBlocked);
    run.request = requested;
    const held = signal && !reservation && (exitBlocked || !control.canEnter(signal.approach, elapsed, ACTOR));
    const target = sampleAhead(route.samples, run.index, Math.min(route.length, run.s + Math.min(9, 3.5 + speed * 0.43)));
    const dx = target.x - car.position.x, dz = target.z - car.position.z;
    const lateral = dx * Math.cos(car.heading) - dz * Math.sin(car.heading);
    const desiredSteer = Math.atan2(4 * model.halfWheelbase * lateral, dx * dx + dz * dz);
    const lastStop = Math.min(route.length - 0.24, held ? stopAt : Infinity);
    const remaining = Math.max(0, lastStop - run.s);
    const speedIndex = sampleAhead(route.samples, run.index, Math.min(route.length, run.s + speed * dt)).i;
    const limit = route.limits[speedIndex];
    const targetSpeed = run.paused ? 0 : Math.min(limit, Math.sqrt(3.3 * remaining), leader.limit);
    let state = leader.limit < Math.min(2.8, limit) ? 'traffic' : 'driving';
    if (held && stopAt - run.s < 4) {
      const { sourceIndex, to } = signal.approach;
      state = control.approachState(sourceIndex, to, elapsed).phase === 'green' ? 'intersection' : 'signal';
    }
    if (run.paused) state = speed < 0.05 ? 'paused' : 'pausing';
    if (state === 'signal' && status !== 'signal') statistics.signalWaits++;
    if (state === 'intersection' && status !== 'intersection') statistics.intersectionWaits++;
    status = state;
    run.stalled = advance < 0.004 && state === 'driving' ? run.stalled + dt : 0;
    if (run.stalled > 7) { stop('blocked'); return null; }

    const demand = targetSpeed - speed;
    const rolling = 0.18 + 0.0012 * speed ** 2;
    const power = 4.5 * 14.5 / Math.max(speed, 14.5);
    // 抵消滚阻后按目标速度调节油门，提前制动，稳态可达到规划限速。
    const acceleration = demand * 2.4 + rolling;
    // 许可检查沿用当前路线采样点及其相邻段的表面身份：地面/高架衔接处四角逐点回退，避免误判无路面。
    const contactEdges = routeEdges(route, run.index, car.position);
    return {
      throttle: targetSpeed <= 0 ? 0 : clamp(acceleration / power, 0, 1),
      brake: car.speed < -0.05 ? 1 : Math.max(emergencyBrake(egoBody, bodies),
        run.paused ? 0.27 : targetSpeed <= 0 ? clamp(speed / 3, 0.24, 1) : clamp(-acceleration / 9, 0, 1)),
      steerAngle: desiredSteer,
      avoidContact: true,
      rejectMove(kind) {
        if (kind === 'traffic') {
          run.stalled = 0;
          if (status === 'driving') status = 'traffic';
        } else run.unsafe = route.samples[speedIndex + 1]?.edge ?? route.samples[speedIndex]?.edge ?? true;
      },
      permitMove(x, z, heading, y = null) {
        if (!hasRoadFootprint(roadHeight, model, x, z, heading, contactEdges, y)) {
          this.rejectMove('surface');
          return false;
        }
        // 控制器在积分及碰撞推出后都检查候选，用当前悬架姿态和同源车身核对近车净空。
        const pivot = car.chassisPivot;
        writeTrafficCollider(candidate, model, { x, y: (y ?? car.position.y) + (pivot?.position.y ?? 0), z,
          heading, sin: Math.sin(heading), cos: Math.cos(heading),
          pitch: pivot?.rotation.x ?? 0, roll: pivot?.rotation.z ?? 0 });
        const extent = Math.max(x - candidate.minX, candidate.maxX - x, z - candidate.minZ, candidate.maxZ - z);
        for (const body of nearTraffic(x, z, extent)) {
          if (sameTrafficLevel(candidate, body) && vehicleContact(candidate, body, contact)) {
            this.rejectMove('traffic');
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

  return { start, queue, pause, resume, stop, update, canStart,
    get active() { return Boolean(run || departure); },
    get status() { return status; },
    get route() { return activeRoute; },
    get progress() {
      return { speed: speedMps, travelled: statistics.travelled, length: statistics.routeLength };
    },
    statistics };

}
