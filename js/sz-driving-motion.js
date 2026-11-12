// 交通体共用模型包络、世界速度与垂直范围。坡道接缝按实际高度相交判定。
export function boxDimensions({ min, max }) {
  return { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2,
    hx: (max.x - min.x) / 2, hy: (max.y - min.y) / 2, hz: (max.z - min.z) / 2 };
}

export function writeTrafficCollider(body, model, pose) {
  const { sin, cos, pitch, roll } = pose;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const bx = cr * model.x - sr * model.y;
  const tilted = sr * model.x + cr * model.y;
  const by = cp * tilted - sp * model.z;
  const bz = sp * tilted + cp * model.z;
  const tiltedRadius = Math.abs(sr) * model.hx + Math.abs(cr) * model.hy;
  const halfW = Math.abs(cr) * model.hx + Math.abs(sr) * model.hy;
  const halfL = Math.abs(sp) * tiltedRadius + Math.abs(cp) * model.hz;
  const halfY = Math.abs(cp) * tiltedRadius + Math.abs(sp) * model.hz;
  const x = pose.x + cos * bx + sin * bz;
  const z = pose.z - sin * bx + cos * bz;
  const y = pose.y + by;
  const radiusX = Math.abs(cos) * halfW + Math.abs(sin) * halfL;
  const radiusZ = Math.abs(sin) * halfW + Math.abs(cos) * halfL;
  Object.assign(body, { x, y, z, heading: pose.heading, sin, cos, halfW, halfL,
    minX: x - radiusX, maxX: x + radiusX, minZ: z - radiusZ, maxZ: z + radiusZ, minY: y - halfY, maxY: y + halfY,
    vx: pose.vx ?? 0, vz: pose.vz ?? 0 });
  Object.assign(body.obb ??= {}, { cx: x, cz: z, cs: cos, sn: sin, hx: halfW, hz: halfL });
  return body;
}

const PERSON = { x: 0, y: 0.87, z: 0, hx: 0.33, hy: 0.87, hz: 0.29 };
const CAR = { x: 0, y: 0.9, z: 0, hx: 0.86, hy: 0.9, hz: 2.18 };

export function writeEntityCollider(body, entity, position = entity.position) {
  const { heading, chassisPivot: pivot } = entity;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  body.type = entity.type === 'person' ? 'person' : 'player';
  body.id = entity.type;
  return writeTrafficCollider(body, entity.collisionBounds ? boxDimensions(entity.collisionBounds)
    : entity.type === 'car' ? CAR : PERSON, {
    x: position.x, y: position.y + (pivot?.position.y ?? 0), z: position.z, heading, sin, cos,
    pitch: pivot?.rotation.x ?? 0, roll: pivot?.rotation.z ?? 0,
    vx: sin * (entity.speed ?? 0) + (entity.vx ?? 0), vz: cos * (entity.speed ?? 0) + (entity.vz ?? 0)
  });
}

export function writePedestrianCollider(body, x, y, z, heading, speed) {
  const sin = Math.sin(heading), cos = Math.cos(heading);
  body.type = 'person';
  return writeTrafficCollider(body, PERSON, { x, y, z, heading, sin, cos, pitch: 0, roll: 0,
    vx: sin * speed, vz: cos * speed });
}

export function sameTrafficLevel(a, b) {
  return a.minY < b.maxY && a.maxY > b.minY;
}

export function bodyExtent(body, dx, dz) {
  return body.halfL * Math.abs(body.sin * dx + body.cos * dz)
    + body.halfW * Math.abs(body.cos * dx - body.sin * dz);
}

// 连续分离轴检测。以本次预测/子步朝向扫掠平移，两个物体可同时移动。
export function contactTime(a, b, seconds, vx = (a.vx ?? 0) - (b.vx ?? 0), vz = (a.vz ?? 0) - (b.vz ?? 0), margin = 0) {
  if (!(seconds > 0) || !sameTrafficLevel(a, b)) return Infinity;
  const dx = a.x - b.x, dz = a.z - b.z;
  let enter = 0, leave = seconds;
  for (let axis = 0; axis < 4; axis++) {
    const body = axis < 2 ? a : b;
    const ax = axis % 2 === 0 ? body.cos : body.sin;
    const az = axis % 2 === 0 ? -body.sin : body.cos;
    const distance = dx * ax + dz * az;
    const speed = vx * ax + vz * az;
    const limit = bodyExtent(a, ax, az) + bodyExtent(b, ax, az) + margin;
    if (Math.abs(speed) < 1e-7) {
      if (Math.abs(distance) >= limit) return Infinity;
      continue;
    }
    const first = (-limit - distance) / speed, last = (limit - distance) / speed;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter >= leave) return Infinity;
  }
  return enter;
}

// 零恢复系数。追尾可以保留前车的同向速度，迎面来车不会让玩家突然反向。
export function constrainContactVelocity(car, nx, nz, obstacle = null) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  let vx = sin * car.speed + (car.vx ?? 0), vz = cos * car.speed + (car.vz ?? 0);
  const normal = vx * nx + vz * nz;
  const other = (obstacle?.vx ?? 0) * nx + (obstacle?.vz ?? 0) * nz;
  const closing = Math.max(0, other - normal);
  if (normal >= Math.min(0, other)) return 0;
  const removed = Math.min(0, other) - normal;
  const tangent = vx * nz - vz * nx;
  const friction = Math.sign(tangent) * Math.min(Math.abs(tangent), removed * 0.22);
  vx += removed * nx - friction * nz;
  vz += removed * nz + friction * nx;
  car.speed = vx * sin + vz * cos;
  const sideways = vx * cos - vz * sin;
  car.vx = sideways * cos;
  car.vz = -sideways * sin;
  return closing;
}

const GAP = 2;
const HEADWAY = 1.35;
const COMFORT_BRAKE = 3;

export function followingReach(speed) {
  return Math.max(20, speed * HEADWAY + speed ** 2 / (2 * COMFORT_BRAKE) + 12);
}

export function followingSpeed(gap, leaderSpeed) {
  const space = Math.max(0, gap - GAP);
  if (space < 0.22) return 0;
  const timeLimit = space / HEADWAY;
  const reaction = COMFORT_BRAKE * HEADWAY;
  const stoppingLimit = Math.sqrt(reaction ** 2 + 2 * COMFORT_BRAKE * space + Math.max(0, leaderSpeed) ** 2) - reaction;
  return Math.min(timeLimit, stoppingLimit);
}

// 在前方路线投影车身而非只看车心。短时扫掠让横穿者和切入车辆也能成为前方障碍。
export function routeLeader({ samples, index, s, reach, ego, bodies, roadHeight }) {
  let limit = Infinity;
  let gap = Infinity;
  let blocker = null;
  const horizon = Math.min(4, 0.75 + Math.hypot(ego.vx, ego.vz) / COMFORT_BRAKE);
  for (const body of bodies) {
    if (ego.id !== undefined && body.id === ego.id) continue;
    const dx = body.x - ego.x, dz = body.z - ego.z;
    const radius = reach + body.halfL + ego.halfL;
    if (Math.abs(dx) > radius || Math.abs(dz) > radius) continue;
    const conflict = contactTime(ego, body, horizon, undefined, undefined, 0.2);
    const predict = Number.isFinite(conflict) ? conflict : 0;
    const x = body.x + (body.vx ?? 0) * predict, z = body.z + (body.vz ?? 0) * predict;
    let nearest = null;
    for (let i = Math.max(0, index - 2); i < samples.length - 1 && samples[i].s <= s + reach + 4; i++) {
      const a = samples[i], b = samples[i + 1], length = b.s - a.s;
      const fx = (b.x - a.x) / length, fz = (b.z - a.z) / length;
      const along = (x - a.x) * fx + (z - a.z) * fz;
      const t = Math.max(0, Math.min(length, along));
      const px = a.x + fx * t, pz = a.z + fz * t;
      const error = Math.hypot(x - px, z - pz);
      if (!nearest || error < nearest.error) nearest = { a, b, px, pz, fx, fz, error, s: a.s + t, t, length };
    }
    if (!nearest) continue;
    const { a, b, px, pz, fx, fz, error, t, length } = nearest;
    const endBias = (x - px) * fx + (z - pz) * fz;
    const projectedS = nearest.s + (t === 0 || t === length ? endBias : 0);
    if (projectedS < s - 0.25 || projectedS > s + reach + 4) continue;
    if (error > bodyExtent(ego, fz, -fx) + bodyExtent(body, fz, -fx) + 0.35) continue;
    const y = roadHeight(px, pz, t < length / 2 ? a.edge : b.edge);
    if (!Number.isFinite(y) || y + (ego.maxY - ego.minY) <= body.minY || y >= body.maxY) continue;
    const leadSpeed = body.type === 'person' ? 0 : Math.max(0, (body.vx ?? 0) * fx + (body.vz ?? 0) * fz);
    // 同向车已在前方时用当前净间距；横向切入才需要预测位置。
    const leaderS = projectedS - leadSpeed * predict;
    const clearance = leaderS - s - bodyExtent(body, fx, fz) - bodyExtent(ego, fx, fz);
    const speed = followingSpeed(clearance, leadSpeed);
    gap = Math.min(gap, clearance);
    if (speed < limit) { limit = speed; blocker = body; }
  }
  return { limit, gap, blocker };
}

export function emergencyBrake(ego, bodies) {
  const speed = Math.hypot(ego.vx, ego.vz);
  if (speed < 0.8) return 0;
  const horizon = speed / 8.5 + 0.25;
  let demand = 0;
  for (const body of bodies) {
    const time = contactTime(ego, body, horizon, undefined, undefined, 0.12);
    if (!Number.isFinite(time)) continue;
    const closing = ((ego.vx - (body.vx ?? 0)) * ego.vx + (ego.vz - (body.vz ?? 0)) * ego.vz) / speed;
    if (closing < 0.5 || time > Math.min(horizon, closing / 15 + 0.25)) continue;
    demand = Math.max(demand, Math.min(1, closing / Math.max(0.05, time) / 16));
  }
  return demand;
}
