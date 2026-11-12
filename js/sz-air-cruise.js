import { polygonBoxOverlaps } from './building-collision.js';
import { terrainHeight } from './sz-terrain.js';
import { flightEntryYaw, flightEnvelopeRadius } from './sz-flight-motion.js';

const GRADE_LIMIT = 0.10;
const TERRAIN_CLEARANCE_M = 18;
const STRUCTURE_CLEARANCE_M = 14;
const MAX_CLEARANCE_LIFT_M = 45;
const HEADING_WINDOW_M = 12;

function bracket(values, value) {
  let low = 0;
  let high = values.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= value) low = mid;
    else high = mid;
  }
  return low;
}

function interpolate(values, distances, distance) {
  const i = bracket(distances, distance);
  const fraction = Math.max(0, Math.min(1, (distance - distances[i]) / (distances[i + 1] - distances[i])));
  return values[i] + (values[i + 1] - values[i]) * fraction;
}

function smoothHeight(values, distances, halfWidth) {
  return distances.map(distance => {
    let sum = 0;
    let totalWeight = 0;
    for (let offset = -halfWidth; offset <= halfWidth; offset += 5) {
      const weight = 1 + Math.cos(Math.PI * offset / halfWidth);
      sum += weight * interpolate(values, distances, distance + offset);
      totalWeight += weight;
    }
    return sum / totalWeight;
  });
}

function fitHeightEnvelope(floor, distances) {
  // 先向两侧扩出滤波半径，随后限坡并平滑。滤波覆盖内的最低净空仍由原约束保证。
  const radius = 30;
  const expanded = floor.map((height, i) => {
    let result = height;
    const distance = distances[i];
    for (let j = i - 1; j >= 0 && distance - distances[j] <= radius + 5; j--) result = Math.max(result, floor[j]);
    for (let j = i + 1; j < floor.length && distances[j] - distance <= radius + 5; j++) result = Math.max(result, floor[j]);
    return result;
  });
  for (let i = 1; i < expanded.length; i++) {
    expanded[i] = Math.max(expanded[i], expanded[i - 1] - GRADE_LIMIT * (distances[i] - distances[i - 1]));
  }
  for (let i = expanded.length - 2; i >= 0; i--) {
    expanded[i] = Math.max(expanded[i], expanded[i + 1] - GRADE_LIMIT * (distances[i + 1] - distances[i]));
  }
  return smoothHeight(expanded, distances, radius);
}

function sweptTop(a, b, bodyRadius, nearColliders) {
  const x = (a.x + b.x) / 2;
  const z = (a.z + b.z) / 2;
  const hx = Math.abs(a.x - b.x) / 2 + bodyRadius;
  const hz = Math.abs(a.z - b.z) / 2 + bodyRadius;
  let top = -Infinity;
  let obstacle = null;
  for (const c of nearColliders(x, z, Math.max(hx, hz), false)) {
    if (c.maxY <= top || c.minX > x + hx || c.maxX < x - hx || c.minZ > z + hz || c.maxZ < z - hz) continue;
    if (c.polygon && !polygonBoxOverlaps(c.polygon, x, z, hx, hz)) continue;
    top = c.maxY;
    obstacle = c.sourceId ?? c.buildingId ?? c.name ?? c.type ?? c.kind ?? null;
  }
  return { top, obstacle };
}

function planFlightSpeed(points, distances, flight, headingAt) {
  const speeds = distances.map(distance => {
    const from = Math.max(0, distance - 15);
    const to = Math.min(distances.at(-1), distance + 15);
    const angle = headingAt(to) - headingAt(from);
    const curvature = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) / (to - from);
    return Math.min(flight.speedMps, Math.sqrt(flight.lateralAccelerationMps2 / Math.max(1e-6, curvature)));
  });
  speeds[0] = speeds[speeds.length - 1] = 0;
  for (let i = 1; i < speeds.length; i++) {
    const limit = Math.sqrt(speeds[i - 1] ** 2 + 2 * flight.accelerationMps2 * (distances[i] - distances[i - 1]));
    speeds[i] = Math.min(speeds[i], limit);
  }
  const times = [0];
  for (let i = speeds.length - 2; i >= 0; i--) {
    const limit = Math.sqrt(speeds[i + 1] ** 2 + 2 * flight.brakingMps2 * (distances[i + 1] - distances[i]));
    speeds[i] = Math.min(speeds[i], limit);
  }
  let length3d = 0;
  for (let i = 1; i < points.length; i++) {
    const step = distances[i] - distances[i - 1];
    times.push(times[i - 1] + 2 * step / (speeds[i - 1] + speeds[i]));
    length3d += Math.hypot(step, points[i].y - points[i - 1].y);
  }
  return { speeds, times, length3d };
}

export function planAirCruise(route, flight, { groundHeight, roadHeight, nearColliders, bodyRadius, maxAltitude }) {
  const points = route.points.map(([x, z]) => ({ x, z, y: 0, ground: roadHeight(x, z) ?? groundHeight(x, z) }));
  const distances = [0];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!Number.isFinite(point.ground)) throw new Error(`Air cruise has no surface at station ${distances[i].toFixed(1)}`);
    if (i + 1 < points.length) distances.push(distances[i] + Math.hypot(points[i + 1].x - point.x, points[i + 1].z - point.z));
  }
  const total = distances.at(-1);
  const floor = points.map(point => point.ground + TERRAIN_CLEARANCE_M);
  const obstacles = [];
  const clearance = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const hit = sweptTop(a, b, bodyRadius, nearColliders);
    const midGround = groundHeight((a.x + b.x) / 2, (a.z + b.z) / 2);
    if (!Number.isFinite(midGround)) throw new Error(`Air cruise has no terrain at station ${distances[i].toFixed(1)}`);
    const required = Math.max(hit.top + STRUCTURE_CLEARANCE_M, midGround + TERRAIN_CLEARANCE_M);
    floor[i - 1] = Math.max(floor[i - 1], required);
    floor[i] = Math.max(floor[i], required);
    clearance.push({ top: Math.max(hit.top, midGround), obstacle: hit.obstacle });
  }
  const target = smoothHeight(points.map(p => p.ground + flight.targetHeightM), distances, 100);
  const nominal = fitHeightEnvelope(target, distances);
  const profile = fitHeightEnvelope(target.map((height, i) => Math.max(height, floor[i])), distances);
  let minimumClearance = Infinity;
  let maxGrade = 0;
  let lift = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    p.y = profile[i];
    if (p.y < floor[i] - 0.01 || p.y > maxAltitude || p.y - nominal[i] > MAX_CLEARANCE_LIFT_M) {
      throw new Error(`Air cruise exceeds clearance envelope at station ${distances[i].toFixed(1)} m (${clearance[i]?.obstacle ?? 'terrain'}, world y=${p.y.toFixed(1)})`);
    }
    if (i > 0) {
      minimumClearance = Math.min(minimumClearance, Math.min(p.y, points[i - 1].y) - clearance[i - 1].top);
      maxGrade = Math.max(maxGrade, Math.abs(p.y - points[i - 1].y) / (distances[i] - distances[i - 1]));
    }
    const excess = p.y - nominal[i];
    if (excess > 0.5) {
      if (!lift) obstacles.push(lift = { fromM: distances[i], toM: distances[i], maxLiftM: 0, sources: [] });
      lift.toM = distances[i];
      lift.maxLiftM = Math.max(lift.maxLiftM, excess);
      if (floor[i] > target[i]) {
        const source = clearance[i - 1]?.obstacle ?? clearance[i]?.obstacle ?? 'terrain';
        if (!lift.sources.includes(source)) lift.sources.push(source);
      }
    } else lift = null;
  }

  function poseAt(distance, output = {}) {
    const d = Math.max(0, Math.min(total, distance));
    const i = bracket(distances, d);
    const a = points[i], b = points[i + 1];
    const t = (d - distances[i]) / (distances[i + 1] - distances[i]);
    output.x = a.x + (b.x - a.x) * t;
    output.y = a.y + (b.y - a.y) * t;
    output.z = a.z + (b.z - a.z) * t;
    output.ground = a.ground + (b.ground - a.ground) * t;
    return output;
  }

  const back = {}, ahead = {};
  function headingAt(distance) {
    poseAt(distance - HEADING_WINDOW_M, back);
    poseAt(distance + HEADING_WINDOW_M, ahead);
    return Math.atan2(ahead.x - back.x, ahead.z - back.z);
  }

  const altitudes = points.map(p => p.y - p.ground);
  const audit = {
    heightM: [Math.min(...altitudes), Math.max(...altitudes)],
    worldYM: [Math.min(...profile), Math.max(...profile)], minimumClearance, maxGrade, obstacles
  };
  function atSpeed(speedMps) {
    const { speeds, times, length3d } = planFlightSpeed(points, distances, { ...flight, speedMps }, headingAt);
    const duration = times.at(-1);
    function flightAt(time, output) {
      const i = bracket(times, time);
      const dt = time - times[i];
      const acceleration = (speeds[i + 1] - speeds[i]) / (times[i + 1] - times[i]);
      const complete = time >= duration;
      const distance = complete ? total : distances[i] + (speeds[i] + acceleration * dt * 0.5) * dt;
      poseAt(distance, output);
      output.distance = distance;
      output.heading = headingAt(distance);
      output.speed = complete ? 0 : Math.max(0, speeds[i] + acceleration * dt);
    }
    return { ...route, points, poseAt, flightAt, duration, estimateSeconds: duration + flight.initialTurnSeconds,
      length3d, distance: total, audit, speedMps };
  }
  return { ...atSpeed(flight.speedMps), atSpeed };
}

export function createAirCruise(data, geometry, aircraft, fullSpeedMps = data?.flight.speedMps) {
  const routes = (data?.routes ?? []).map(route => {
    try {
      const plan = planAirCruise(route, data.flight, geometry);
      return { ...plan, full: plan.atSpeed(fullSpeedMps) };
    } catch (error) {
      console.warn(`[air cruise] ${route.id}:`, error);
      return { ...route, unavailable: true };
    }
  });
  const pose = {}, lookAhead = {};
  let route = null;
  let clock = 0;
  let pace = 0;
  let turnElapsed = 0;
  let launched = false;
  let status = 'idle';

  if (aircraft) aircraft.limitCamera = (origin, camera) => {
    const clears = (a, b) => Math.min(a.y, b.y) > sweptTop(a, b, 0.6, geometry.nearColliders).top + 0.8;
    if (clears(origin, camera)) return;
    const offset = Math.hypot(camera.x - origin.x, camera.z - origin.z);
    const count = Math.max(1, Math.ceil(offset / 1.5));
    let safe = origin;
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      const next = { x: origin.x + (camera.x - origin.x) * t, y: origin.y + (camera.y - origin.y) * t,
        z: origin.z + (camera.z - origin.z) * t };
      if (!clears(safe, next)) {
        // 留出正的观察距离，避免相机在障碍边缘退到注视点。
        camera.copy(safe === origin ? aircraft.position : safe);
        return;
      }
      safe = next;
    }
  };

  function syncPose(dt = 0) {
    route.flightAt(clock, pose);
    aircraft.position.set(pose.x, pose.y, pose.z);
    aircraft.entryTurnRemaining = Math.max(0, data.flight.initialTurnSeconds - turnElapsed);
    aircraft.heading = pose.heading + flightEntryYaw(aircraft.entryTurnRemaining, data.flight.initialTurnSeconds);
    aircraft.speed = pose.speed * pace;
    aircraft.mesh.position.copy(aircraft.position);
    aircraft.mesh.rotation.y = aircraft.heading;
    aircraft.updateRotors(dt, 0.57 + 0.15 * Math.min(1, aircraft.speed / route.speedMps));
    aircraft.mesh.updateMatrixWorld(true);
  }

  function start(next) {
    if (!next || next.unavailable) return false;
    route = next;
    clock = pace = turnElapsed = 0;
    launched = false;
    status = 'aligning';
    aircraft.mesh.visible = true;
    syncPose();
    return true;
  }

  return {
    routes,
    get active() { return route !== null; },
    get route() { return route; },
    get entity() { return route ? aircraft : null; },
    get status() { return status; },
    get distance() { return route ? pose.distance : 0; },
    get altitude() { return route ? pose.y - pose.ground : 0; },
    get targetSpeed() { return route?.speedMps ?? data?.flight.speedMps ?? 0; },
    get scenicSpeed() { return data?.flight.speedMps ?? 0; },
    get fullSpeed() { return fullSpeedMps ?? 0; },
    get targetHeight() { return data?.flight.targetHeightM ?? 0; },
    start,
    restart() { return start(route); },
    togglePause() {
      if (!route || status === 'complete') return;
      status = status === 'paused' ? 'waiting' : 'paused';
      pace = 0;
      aircraft.speed = 0;
    },
    stop() {
      if (!route) return;
      aircraft.mesh.visible = false;
      route = null;
      status = 'idle';
    },
    prefetch() {
      if (!route) return null;
      return route.poseAt(pose.distance + Math.min(420, 90 + aircraft.speed * 2), lookAhead);
    },
    update(dt, ready) {
      if (!route) return;
      if (status !== 'paused' && status !== 'complete') {
        const turning = Math.min(dt, Math.max(0, data.flight.initialTurnSeconds - turnElapsed));
        turnElapsed += turning;
        const advance = dt - turning;
        if (turnElapsed < data.flight.initialTurnSeconds) {
          status = 'aligning';
        } else {
          if (!launched && ready) {
            launched = true;
            pace = 1;
          } else {
            pace += Math.max(-advance * 2, Math.min(advance * 1.8, Number(ready) - pace));
          }
          clock = Math.min(route.duration, clock + advance * pace);
          status = clock >= route.duration ? 'complete' : ready ? 'flying' : 'waiting';
        }
      }
      syncPose(dt);
    }
  };
}

export function createSceneAirCruise(data, controller, site, fullSpeedMps) {
  const aircraft = data && controller.createHelicopterEntity('AirCruiseEvtol');
  if (aircraft) aircraft.mesh.visible = false;
  const bounds = aircraft?.collisionBounds;
  return createAirCruise(data, {
    // 跨水面或地面裁切边界时使用同一派生地形格网，仍不取上层桥面。
    groundHeight: (x, z) => site.groundHeight(x, z) ?? terrainHeight(site.terrain, x, z),
    roadHeight: site.roadHeight,
    nearColliders: controller.nearColliders.bind(controller),
    bodyRadius: flightEnvelopeRadius(bounds) + 0.75,
    maxAltitude: controller.maxFlightAltitude
  }, aircraft, fullSpeedMps);
}
