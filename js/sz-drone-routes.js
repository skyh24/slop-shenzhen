import * as THREE from 'three/webgpu';
import { createCargoDroneMesh } from './sz-vehicles.js';
import { terrainHeight } from './sz-terrain.js';
import { STR } from './sz-strings.js';

const SHENZHEN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const PAD_HALF = 1.8;
const PAD_DEPTH = 0.72;
const CABINET_X = 3;
const CABINET_SIZE = [1.55, 2.15, 0.85];
const CLEARANCE = 12;
const MAX_CRUISE_Y = 260;
const CRUISE_SPEED = 20;
const LIFT_SPEED = 6;
const LOAD_SECONDS = 4;
const DELIVERY_SECONDS = 10;
const APPROACH_DISTANCE = 24;

export function isApecAirSuspended(air, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid suspension date');
  const day = SHENZHEN_DAY.format(date);
  return (air?.apecSuspension?.windows ?? []).some(({ from, to }) => day >= from && day <= to);
}

function offset(point, lx, lz) {
  const sin = Math.sin(point.yaw), cos = Math.cos(point.yaw);
  return { x: point.x + lx * cos + lz * sin, z: point.z - lx * sin + lz * cos };
}

function box(x, z, halfX, halfZ, minY, maxY) {
  return { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, minY, maxY };
}

function overlaps(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

// 线段与扩张后的场景包络相交比例。净空校验使用保守的包络，包含窄物体及相邻采样点间的障碍。
function boxEntry(a, b, bounds, margin, horizontal = false) {
  let entry = 0, exit = 1;
  const axes = horizontal ? ['X', 'Z'] : ['X', 'Y', 'Z'];
  for (const axis of axes) {
    const key = axis.toLowerCase();
    const start = a[key], delta = b[key] - start;
    const min = bounds['min' + axis] - margin, max = bounds['max' + axis] + margin;
    if (Math.abs(delta) < 1e-8) {
      if (start < min || start > max) return Infinity;
      continue;
    }
    const t0 = (min - start) / delta, t1 = (max - start) / delta;
    entry = Math.max(entry, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (entry > exit) return Infinity;
  }
  return entry;
}

export function cameraClearFraction(target, desired, obstacles, heightAt) {
  let fraction = 1;
  for (const obstacle of obstacles) fraction = Math.min(fraction, boxEntry(target, desired, obstacle, 0.38));
  const steps = Math.max(1, Math.ceil(target.distanceTo(desired) / 0.45));
  for (let i = 1; i <= steps && i / steps <= fraction; i++) {
    const t = i / steps;
    const ground = heightAt(THREE.MathUtils.lerp(target.x, desired.x, t), THREE.MathUtils.lerp(target.z, desired.z, t));
    if (Number.isFinite(ground) && THREE.MathUtils.lerp(target.y, desired.y, t) < ground + 0.55) {
      fraction = (i - 1) / steps;
      break;
    }
  }
  return fraction;
}

function stationSite(source, site, obstacles) {
  const radius = Math.min(180, source.coordinatePrecisionM ?? 0);
  const local = obstacles.filter(item => overlaps(item, box(source.x, source.z, radius + 32, radius + 32)));
  const ground = (x, z) => site.isWater(x, z) !== false || Number.isFinite(site.roadHeight(x, z))
    ? null : site.heightAt(x, z);
  const offsets = [];
  for (let dx = -radius; dx <= radius; dx += 4) {
    for (let dz = -radius; dz <= radius; dz += 4) {
      const distance = Math.hypot(dx, dz);
      if (distance <= radius) offsets.push({ dx, dz, distance });
    }
  }
  offsets.push({ dx: 0, dz: 0, distance: 0 });
  offsets.sort((a, b) => a.distance - b.distance);
  for (const { dx, dz, distance } of offsets) {
    const x = source.x + dx, z = source.z + dz;
    const center = ground(x, z);
    if (!Number.isFinite(center)) continue;
    // 四个方向试放，接收柜始终在起降台一侧，入口留出步行和相机空间。
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const candidate = { x, z, yaw };
      const samples = [];
      for (let lx = -2; lx <= 4; lx++) {
        for (let lz = -2; lz <= 2; lz++) samples.push(offset(candidate, lx, lz));
      }
      const heights = samples.map(p => ground(p.x, p.z));
      if (!heights.every(Number.isFinite) || Math.max(...heights) - Math.min(...heights) > 0.48) continue;
      const y = Math.max(...heights) + 0.06;
      const apron = offset(candidate, 1, 0);
      const [halfX, halfZ] = Math.abs(Math.cos(yaw)) > 0.5 ? [3.2, 2.35] : [2.35, 3.2];
      if (local.some(item => overlaps(item, box(apron.x, apron.z, halfX, halfZ))
        && item.maxY > y - PAD_DEPTH)) continue;
      let previous = center;
      let approach = null;
      for (let d = 3; d <= 28; d++) {
        const p = offset(candidate, 0, d);
        const h = ground(p.x, p.z);
        if (!Number.isFinite(h) || Math.abs(h - previous) > 0.28
          || local.some(item => overlaps(item, box(p.x, p.z, 0.85, 0.85)) && item.minY < h + 2 && item.maxY > h)) break;
        previous = h;
        if (d === 28) approach = { ...p, y: h, heading: yaw + Math.PI };
      }
      if (approach) return { ...candidate, y, approach, offsetM: distance, positionSource: 'scene-estimate' };
    }
  }
  return null;
}

function flightPath(from, to, altitude, obstacles, heightAt) {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  if (!(length > 70)) return { reason: 'invalid-span' };
  const lower = Math.max(from.y, to.y);
  let highest = lower;
  let limitingObstacle = null;
  const dx = (to.x - from.x) / length, dz = (to.z - from.z) / length;
  const steps = Math.ceil(length / 2);
  for (let i = 0; i <= steps; i++) {
    for (const side of [-2, 0, 2]) {
      const y = heightAt(from.x + dx * length * i / steps - dz * side, from.z + dz * length * i / steps + dx * side);
      if (!Number.isFinite(y)) return { reason: 'unknown-terrain' };
      highest = Math.max(highest, y);
    }
  }
  const corridor = obstacles.filter(obstacle => Number.isFinite(boxEntry(from, to, obstacle, 2, true)));
  for (const obstacle of corridor) {
    if (!Number.isFinite(obstacle.maxY) || !Number.isFinite(obstacle.minY)) {
      return { reason: 'unknown-obstacle-height', limitingObstacle: obstacle.sourceId ?? obstacle.name ?? obstacle.type };
    }
    if (obstacle.maxY <= highest) continue;
    highest = obstacle.maxY;
    limitingObstacle = obstacle.sourceId ?? obstacle.name ?? obstacle.type ?? null;
  }
  const cruiseY = Math.max(lower + altitude, highest + CLEARANCE + 4);
  if (!Number.isFinite(cruiseY) || cruiseY > MAX_CRUISE_Y) return { reason: 'cruise-ceiling', cruiseY, limitingObstacle };
  // 两段二次曲线连接垂直起降与水平巡航。折线采样同时用于显示、运动和碰撞。
  const a = new THREE.Vector3(from.x, from.y, from.z), b = new THREE.Vector3(to.x, to.y, to.z);
  const topA = a.clone().setY(cruiseY), topB = b.clone().setY(cruiseY);
  const inset = 12;
  const liftA = topA.clone().setY(cruiseY - inset), liftB = topB.clone().setY(cruiseY - inset);
  const runA = topA.clone().lerp(topB, inset / length), runB = topB.clone().lerp(topA, inset / length);
  const sections = [[a, liftA], new THREE.QuadraticBezierCurve3(liftA, topA, runA).getPoints(24),
    [runA, runB], new THREE.QuadraticBezierCurve3(runB, topB, liftB).getPoints(24), [liftB, b]];
  const speeds = [0, LIFT_SPEED, CRUISE_SPEED, CRUISE_SPEED, LIFT_SPEED, 0];
  const points = [a];
  let seconds = 0;
  const legs = [];
  for (const [index, segment] of sections.entries()) {
    const cumulative = [0];
    for (let i = 1; i < segment.length; i++) {
      const start = segment[i - 1], end = segment[i];
      const obstacle = corridor.find(item => Number.isFinite(boxEntry(start, end, item, 1.6)));
      if (obstacle) return { reason: 'blocked-segment', section: index, cruiseY,
        limitingObstacle: obstacle.sourceId ?? obstacle.name ?? obstacle.type };
      points.push(end);
      cumulative.push(cumulative[i - 1] + start.distanceTo(end));
    }
    const duration = 2 * cumulative.at(-1) / (speeds[index] + speeds[index + 1]);
    legs.push({ segment, cumulative, start: seconds, duration, speed: speeds[index],
      acceleration: (speeds[index + 1] - speeds[index]) / duration });
    seconds += duration;
  }
  return { points, legs, seconds, cruiseY, yaw: Math.atan2(dx, dz) };
}

export function planDroneFlights(air, site) {
  const sources = air?.droneStations ?? [];
  const obstacles = site.obstacles ?? [];
  const stations = sources.map(source => {
    const placement = stationSite(source, site, obstacles);
    return { ...source, sourceX: source.x, sourceZ: source.z, ...placement, available: Boolean(placement) };
  });
  const byId = new Map(stations.map(station => [station.id, station]));
  const routes = (air?.droneRoutes ?? []).map(source => {
    const from = byId.get(source.fromStationId), to = byId.get(source.toStationId);
    const path = from?.available && to?.available
      ? flightPath(from, to, source.altitudeM ?? 100, obstacles, site.flightHeightAt)
      : { reason: 'no-safe-station' };
    return { ...source, from, to, path, simulationOnly: source.confidence?.includes('vertices-low') ?? false };
  });
  return { stations, routes };
}

function poseOnPath(path, elapsed, reverse, pose) {
  const time = reverse ? path.seconds - elapsed : elapsed;
  const match = path.legs.findIndex(leg => time <= leg.start + leg.duration);
  const index = match < 0 ? path.legs.length - 1 : match;
  const leg = path.legs[index];
  const t = THREE.MathUtils.clamp(time - leg.start, 0, leg.duration);
  const distance = leg.speed * t + 0.5 * leg.acceleration * t * t;
  let pointIndex = leg.cumulative.findIndex((length, i) => i > 0 && length >= distance);
  if (pointIndex < 0) pointIndex = leg.segment.length - 1;
  const start = leg.cumulative[pointIndex - 1], end = leg.cumulative[pointIndex];
  pose.position.lerpVectors(leg.segment[pointIndex - 1], leg.segment[pointIndex],
    THREE.MathUtils.clamp((distance - start) / (end - start), 0, 1));
  const phase = reverse ? 4 - index : index;
  pose.phase = phase < 2 ? 'takeoff' : phase === 2 ? 'cruise' : 'descent';
  pose.speed = leg.speed + leg.acceleration * t;
  const slope = Math.abs(leg.segment[pointIndex].y - leg.segment[pointIndex - 1].y) / (end - start);
  pose.pitch = 0.12 * (pose.speed / CRUISE_SPEED) * (1 - slope);
}

export function dronePoseAt(path, fromEnd, elapsed, pose = { position: new THREE.Vector3() }, turnAtHome = false) {
  const out = elapsed - LOAD_SECONDS;
  const delivery = out - path.seconds;
  const back = delivery - DELIVERY_SECONDS;
  const home = fromEnd ? path.points.at(-1) : path.points[0];
  const destination = fromEnd ? path.points[0] : path.points.at(-1);
  const outboundYaw = path.yaw + (fromEnd ? Math.PI : 0);
  pose.phase = 'loading';
  pose.yaw = outboundYaw;
  pose.pitch = pose.speed = 0;
  pose.returning = back >= 0;
  pose.cargo = elapsed >= 1.1 && delivery < 3;
  pose.delivered = delivery >= 3 && back < 0;
  pose.rotors = 0;
  if (out < 0) {
    pose.position.copy(home);
    if (turnAtHome) pose.yaw -= Math.PI * (1 - THREE.MathUtils.smoothstep(elapsed, 0, 3.6));
    pose.rotors = Math.max(0, (elapsed - 1.2) / (LOAD_SECONDS - 1.2)) * 0.8;
  } else if (delivery < 0) {
    poseOnPath(path, out, fromEnd, pose);
    pose.rotors = 0.8 + 0.14 * (pose.speed / CRUISE_SPEED);
  } else if (back < 0) {
    pose.phase = 'delivery';
    pose.position.copy(destination);
    pose.yaw += Math.PI * THREE.MathUtils.smoothstep(delivery, 4, 8);
    pose.rotors = 0.8 * (Math.max(0, 1 - delivery / 1.4) + Math.max(0, (delivery - 8) / 2));
  } else if (back < path.seconds) {
    pose.yaw += Math.PI;
    poseOnPath(path, back, !fromEnd, pose);
    pose.rotors = 0.8 + 0.14 * (pose.speed / CRUISE_SPEED);
  } else {
    pose.phase = 'complete';
    pose.yaw += Math.PI;
    pose.position.copy(home);
    pose.rotors = 0.8 * Math.max(0, 1 - (back - path.seconds) / 1.4);
  }
  return pose;
}

function stationMesh(station, materials, resources) {
  const group = new THREE.Group();
  group.name = station.id;
  group.position.set(station.x, station.y, station.z);
  group.rotation.y = station.yaw;
  function block(name, size, position, material) {
    const geometry = new THREE.BoxGeometry(...size);
    resources.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    group.add(mesh);
    return mesh;
  }
  block('landing-platform', [2 * PAD_HALF, PAD_DEPTH, 2 * PAD_HALF], [0, -PAD_DEPTH / 2, 0], materials.pad);
  for (const x of [-1.64, 1.64]) {
    block('pad-edge', [0.12, 0.015, 3.38], [x, 0.008, 0], materials.yellow);
  }
  for (const x of [-0.41, 0.41]) block('pad-marking', [0.14, 0.015, 1.2], [x, 0.008, 0], materials.white);
  block('pad-marking', [0.82, 0.015, 0.14], [0, 0.008, 0], materials.white);
  block('receiver-foundation', [1.7, PAD_DEPTH, 1], [CABINET_X, -PAD_DEPTH / 2, 0], materials.pad);
  block('delivery-cabinet', CABINET_SIZE, [CABINET_X, CABINET_SIZE[1] / 2, 0], materials.yellow);
  block('locker-door', [1.21, 0.9, 0.035], [CABINET_X, 0.84, 0.44], materials.pad);
  const light = block('locker-status', [1.3, 0.065, 0.72], [CABINET_X, 2.17, 0], materials.standby);

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 144;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#19262b';
    ctx.fillRect(0, 0, 512, 144);
    ctx.fillStyle = '#fff4d9';
    ctx.font = 'bold 43px sans-serif';
    ctx.fillText(STR.drones.receiver, 20, 56, 472);
    ctx.font = '29px sans-serif';
    ctx.fillText(station.name, 20, 110, 472);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.MeshBasicMaterial({ map: texture });
    resources.add(texture);
    resources.add(sign);
    block('station-sign', [1.49, 0.42, 0.008], [CABINET_X, 1.86, 0.431], sign);
  }
  return { group, light };
}

export function buildSzDroneRoutes(scene, { air, site, obstacles = site.obstacles ?? [], treeObstacles, clock = () => new Date() } = {}) {
  const sourceStations = new Map((air?.droneStations ?? []).map(station => [station.id, station]));
  const canopies = (air?.droneRoutes ?? []).flatMap(route => {
    const from = sourceStations.get(route.fromStationId), to = sourceStations.get(route.toStationId);
    if (!treeObstacles || !from || !to) return [];
    const margin = 220;
    return treeObstacles({
      minX: Math.min(from.x, to.x) - margin, maxX: Math.max(from.x, to.x) + margin,
      minZ: Math.min(from.z, to.z) - margin, maxZ: Math.max(from.z, to.z) + margin
    });
  });
  const flightHeightAt = site.flightHeightAt ?? ((x, z) => site.heightAt(x, z)
    ?? terrainHeight(site.terrain, x, z) ?? (site.isWater(x, z) === true ? 0 : null));
  const { stations, routes } = planDroneFlights(air, { ...site, obstacles: [...obstacles, ...canopies], flightHeightAt });
  const group = new THREE.Group();
  group.name = 'shenzhen-drone-routes';
  scene.add(group);
  const materials = {
    pad: new THREE.MeshStandardMaterial({ color: 0x29383c, roughness: 0.93 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xffb938, roughness: 0.69 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf4eee2, roughness: 0.78 }),
    standby: new THREE.MeshBasicMaterial({ color: 0xffab36 }),
    received: new THREE.MeshBasicMaterial({ color: 0x38ee92 }),
    route: new THREE.LineBasicMaterial({ color: 0xa3ddff, transparent: true, opacity: 0.26, depthWrite: false })
  };
  const resources = new Set(Object.values(materials));
  const facilities = new Map();
  const colliders = [];
  for (const station of stations) {
    if (!station.available) continue;
    const facility = stationMesh(station, materials, resources);
    facilities.set(station.id, facility);
    group.add(facility.group);
    const cabinet = offset(station, CABINET_X, 0);
    const [hx, hz] = Math.abs(Math.cos(station.yaw)) > 0.5 ? [0.85, 0.5] : [0.5, 0.85];
    colliders.push({ ...box(cabinet.x, cabinet.z, hx, hz, station.y - PAD_DEPTH, station.y + CABINET_SIZE[1] + 0.06),
      type: 'drone-cabinet', name: station.name });
    colliders.push({ ...box(station.x, station.z, PAD_HALF, PAD_HALF, station.y - PAD_DEPTH, station.y),
      type: 'drone-platform', name: station.name });
  }

  const records = new Map();
  const byStation = new Map();
  for (const route of routes) {
    const record = { route, mission: null };
    records.set(route.id, record);
    for (const station of [route.from, route.to]) if (station) byStation.set(station.id, record);
    if (!route.path.points) continue;
    const geometry = new THREE.BufferGeometry().setFromPoints(route.path.points);
    resources.add(geometry);
    record.line = new THREE.Line(geometry, materials.route);
    record.line.name = route.id;
    record.line.visible = false;
    record.aircraft = createCargoDroneMesh();
    record.aircraft.group.name = route.id + ':drone';
    record.aircraft.group.visible = false;
    group.add(record.line, record.aircraft.group);
  }

  let suspended = isApecAirSuspended(air, clock());
  let checkIn = 0;
  let disposed = false;
  let preview = null;
  let following = null;
  const cameraTarget = new THREE.Vector3(NaN, NaN, NaN);
  let cameraObstacles = [];
  function checkSuspension() {
    suspended = isApecAirSuspended(air, clock());
    for (const record of records.values()) {
      if (suspended && record.mission && !record.mission.demo) {
        record.mission = null;
        record.aircraft.group.visible = false;
      }
    }
  }
  function showLines() {
    for (const record of records.values()) {
      if (record.line) record.line.visible = record.route.id === preview || record.mission === following && following !== null;
    }
  }
  function status(stationId, player) {
    const record = byStation.get(stationId);
    const station = record?.route.from?.id === stationId ? record.route.from : record?.route.to;
    const nearby = station?.available && Math.hypot(player.x - station.x, player.z - station.z) <= APPROACH_DISTANCE
      && Math.abs(player.y - station.y) <= 4;
    return { route: record?.route, suspended, nearby: Boolean(nearby), mission: record?.mission,
      available: !disposed && Boolean(record?.aircraft) };
  }
  function start(stationId, demo, player) {
    if (disposed) return null;
    checkSuspension();
    const state = status(stationId, player);
    if (!state.available || !state.nearby || !demo && (suspended || state.route.simulationOnly)) return null;
    const record = records.get(state.route.id);
    const active = record.mission;
    if (active && active.demo !== demo && active.pose.phase !== 'complete') return null;
    if (!active || active.pose.phase === 'complete' && active !== following || active.demo !== demo) {
      const fromEnd = stationId === state.route.to.id;
      record.mission = { routeId: state.route.id, droneId: record.aircraft.group.name, stationId, demo,
        fromEnd, elapsed: 0, pose: dronePoseAt(state.route.path, fromEnd, 0) };
    }
    following = record.mission;
    showLines();
    return following;
  }

  return {
    group, colliders, stations, routes,
    get suspended() { return suspended; },
    get statistics() {
      return { stations: stations.map(({ id, x, y, z, available, offsetM, approach }) => ({ id, x, y, z, available, offsetM, approach })),
        routes: routes.map(({ id, path, simulationOnly }) =>
          ({ id, reason: path.reason, obstacle: path.limitingObstacle, cruiseY: path.cruiseY,
            seconds: path.seconds, simulationOnly })), suspended };
    },
    status, start,
    cameraClear(target, desired, controller) {
      if (!cameraTarget.equals(target)) {
        cameraTarget.copy(target);
        cameraObstacles = controller.nearColliders(target.x, target.z, 10, false).slice();
        const local = box(target.x, target.z, 9, 9);
        for (const crown of canopies) {
          if (overlaps(crown, local) && crown.minY < target.y + 8 && crown.maxY > target.y - 2) cameraObstacles.push(crown);
        }
      }
      return cameraClearFraction(target, desired, cameraObstacles, flightHeightAt);
    },
    preview(stationId) { preview = byStation.get(stationId)?.route.id ?? null; showLines(); },
    stopFollowing() { following = null; showLines(); },
    isActive(mission) { return !disposed && records.get(mission.routeId)?.mission === mission
      && records.get(mission.routeId).aircraft.group.parent === group && group.parent === scene; },
    repeat(mission) {
      if (mission !== following || !this.isActive(mission) || mission.pose.phase !== 'complete' || mission.pose.rotors > 0) return false;
      checkSuspension();
      if (!this.isActive(mission)) return false;
      mission.elapsed = 0;
      mission.turnAtHome = true;
      return true;
    },
    update(dt, camera) {
      if (disposed) return;
      const step = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
      checkIn -= step;
      if (checkIn <= 0) { checkSuspension(); checkIn = 1; }
      for (const { light } of facilities.values()) light.material = materials.standby;
      for (const record of records.values()) {
        const { mission, route, aircraft } = record;
        if (!mission) continue;
        if (mission.pose.phase === 'complete' && mission !== following && mission.pose.rotors === 0) {
          record.mission = null;
          aircraft.group.visible = false;
          continue;
        }
        mission.elapsed += step;
        const pose = dronePoseAt(route.path, mission.fromEnd, mission.elapsed, mission.pose, mission.turnAtHome);
        aircraft.group.visible = mission === following || !camera || pose.position.distanceToSquared(camera) < 550 ** 2;
        aircraft.group.position.copy(pose.position);
        aircraft.group.position.y -= aircraft.bounds.min.y;
        aircraft.group.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
        aircraft.cargoBox.visible = pose.cargo;
        aircraft.statusLight.visible = pose.rotors > 0.2 && mission.elapsed % 1.1 < 0.55;
        if (aircraft.group.visible) aircraft.update(step, pose.rotors);
        aircraft.group.updateMatrixWorld(true);
        if (pose.delivered) facilities.get((mission.fromEnd ? route.from : route.to).id).light.material = materials.received;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      for (const record of records.values()) record.aircraft?.dispose();
      for (const resource of resources) resource.dispose();
      records.clear();
      byStation.clear();
      facilities.clear();
      group.clear();
    }
  };
}
