// 碰撞圆包含交通模块的人体矩形；额外间距留给摆臂与预测误差。
export const WALK_RADIUS = 0.445;
export const WALK_GAP = 2 * WALK_RADIUS;
const HORIZON = 2.3;
const RANGE = 8;
const CELL = 4;
const SIDE_RATE = 0.95;
const offsetsWithin = limit => [...new Set([0.5, 0.78, 1.05, limit].map(offset => Math.min(limit, offset)))];
const GAP2 = WALK_GAP ** 2;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const sameLevel = (a, b) => Math.abs(a.y - b.y) < 1.65;

// 规划读帧首位置；执行时同时读取本帧已移动者的起点和终点。
export function createWalkerGrid() {
  const cells = new Map();
  const key = (x, z) => Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
  function add(ped) {
    const id = key(ped.x, ped.z);
    let cell = cells.get(id);
    if (!cell) cells.set(id, cell = []);
    cell.push(ped);
    ped.frameX = ped.x;
    ped.frameZ = ped.z;
    ped.frameVX = ped.vx ?? 0;
    ped.frameVZ = ped.vz ?? 0;
  }
  function query(x, z, radius, result) {
    result.length = 0;
    for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++) {
      for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++) {
        for (const ped of cells.get(ix * 100000 + iz) ?? []) {
          if (Math.abs(ped.frameX - x) <= radius && Math.abs(ped.frameZ - z) <= radius) result.push(ped);
        }
      }
    }
    return result;
  }
  return { add, query, clear: () => cells.clear() };
}

function closest2(x, z, dx, dz, horizon) {
  const t = clamp(-(x * dx + z * dz) / (dx * dx + dz * dz || 1), 0, horizon);
  return (x + t * dx) ** 2 + (z + t * dz) ** 2;
}

export function clearOfWalkers(ped, next, neighbors) {
  const dx = next.x - ped.x, dz = next.z - ped.z;
  for (const q of neighbors) {
    if (q === ped || !sameLevel(next, q)) continue;
    const x = ped.x - q.frameX, z = ped.z - q.frameZ;
    if (Math.abs(x) > 1.4 || Math.abs(z) > 1.4) continue;
    const u = ped.x - q.x, v = ped.z - q.z;
    // 同时检查帧内相对扫掠与已提交位置，禁止调换位置时互穿。
    if (closest2(x, z, dx - q.x + q.frameX, dz - q.z + q.frameZ, 1) < GAP2
      || closest2(u, v, dx, dz, 1) < GAP2) return false;
  }
  return true;
}

function threat(p, neighbors, pose, nominal) {
  const pace = Math.max(p.v, p.speed * 0.7);
  const look = pose(p.leg, p.s + p.dir * pace * HORIZON, nominal, {});
  const vx = (look.x - p.x) / HORIZON, vz = (look.z - p.z) / HORIZON;
  let best = null, bestTime = Infinity;
  for (const q of neighbors) {
    if (p === q || !sameLevel(p, q)) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const forward = dx * p.fx + dz * p.fz;
    if (forward < -0.05 || forward > RANGE || Math.hypot(dx, dz) > RANGE) continue;
    const fx = q.fx ?? 0, fz = q.fz ?? 0;
    const dot = p.leg === q.leg ? p.dir * q.dir : p.fx * fx + p.fz * fz;
    const headOn = dot < -0.5;
    const lead = q.leg === p.leg ? (q.s - p.s) * p.dir : forward;
    const qSpeed = q.pause > 0 ? 0 : Math.max(0, q.frameVX * p.fx + q.frameVZ * p.fz);
    const qx = q.frameVX || 0, qz = q.frameVZ || 0;
    const ux = qx - vx, uz = qz - vz;
    const time = clamp(-(dx * ux + dz * uz) / (ux * ux + uz * uz || 1), 0, HORIZON);
    const d2 = (dx + time * ux) ** 2 + (dz + time * uz) ** 2;
    const side = Math.abs(dx * p.fz - dz * p.fx);
    if (d2 > (WALK_GAP + 0.13) ** 2 && !(lead > 0 && lead < 1.9 && side < 0.83)) continue;
    if (time < bestTime) {
      bestTime = time;
      best = { q, headOn, lead, qSpeed, dot };
    }
  }
  return best;
}

export function createWalkAvoidance({ pose, segment, offsetLimit, rightOffset, statistics }) {
  const nearby = [];
  const candidates = [];
  const seen = new Set();

  function canUse(p, point, t, neighbors, cooperative = null, coopOffset = 0) {
    for (const q of neighbors) {
      if (q === p || !sameLevel(point, q)) continue;
      let x = q.x + q.frameVX * t, z = q.z + q.frameVZ * t;
      if (q === cooperative && q.leg === p.leg) {
        const side = coopOffset;
        const offset = q.lateral + clamp(side - q.lateral, -SIDE_RATE * t, SIDE_RATE * t);
        const next = pose(q.leg, q.s + q.dir * Math.max(q.v, q.speed * 0.65) * t, offset, {});
        x = next.x;
        z = next.z;
      }
      if ((point.x - x) ** 2 + (point.z - z) ** 2 < (WALK_GAP + 0.06) ** 2) return false;
    }
    return true;
  }

  function sideClear(p, offset, length, neighbors, cooperative, coopOffset) {
    let previous = p;
    const count = Math.max(1, Math.ceil(length / 0.32));
    const pace = Math.max(0.65, p.speed);
    for (let i = 1; i <= count; i++) {
      const d = length * i / count, t = d / pace;
      const side = p.lateral + clamp(offset - p.lateral, -SIDE_RATE * t, SIDE_RATE * t);
      const point = pose(p.leg, p.s + p.dir * d, side, {});
      if (!segment(p.leg, previous, point) || !canUse(p, point, t, neighbors, cooperative, coopOffset)) return false;
      previous = point;
    }
    return true;
  }

  // 只在常用走线被实体截住时搜索短距离的几排候选；终点仍是原步行带。
  function aroundStatic(p, nominal) {
    const length = Math.min(5, p.dir > 0 ? p.leg.length - p.s : p.s);
    if (length < 0.65) return null;
    const rows = Math.ceil(length / 0.62);
    const limit = offsetLimit(p.leg);
    const offsets = [...new Set([nominal, 0, p.lateral, -nominal, ...offsetsWithin(limit).flatMap(o => [o, -o])])];
    let previous = [{ point: p, offset: p.lateral, cost: 0, prior: null }];
    for (let i = 1; i <= rows; i++) {
      const s = p.s + p.dir * length * i / rows;
      const next = [];
      for (const offset of offsets) {
        if (i === rows && offset !== nominal && offset !== 0) continue;
        const point = pose(p.leg, s, offset, {});
        let best = null;
        for (const a of previous) {
          const shift = Math.abs(a.offset - offset);
          const cost = a.cost + shift * 1.7 + Math.abs(nominal - offset) * 0.4;
          if (shift > 0.68 || (best && cost >= best.cost) || !segment(p.leg, a.point, point)) continue;
          best = { s, point, offset, cost, prior: a };
        }
        if (best) next.push(best);
      }
      if (!next.length) return null;
      previous = next;
    }
    let best = previous.reduce((a, b) => a.cost <= b.cost ? a : b);
    const path = [];
    while (best.prior) {
      path.push({ s: best.s, offset: best.offset });
      best = best.prior;
    }
    return path;
  }

  function pocket(p, winner, neighbors) {
    const dir = p.dir;
    const end = dir > 0 ? 0 : 1;
    const room = dir > 0 ? p.s : p.leg.length - p.s;
    const limit = offsetLimit(p.leg);
    let previous = p;
    const offsets = offsetsWithin(limit).flatMap(o => [-dir * o, dir * o]);
    for (let d = 0; d <= Math.min(8, room) + 0.001; d += 0.45) {
      const s = p.s - dir * d;
      const base = pose(p.leg, s, p.lateral, {});
      if (!segment(p.leg, previous, base) || !canUse(p, base, 0, neighbors)) break;
      previous = base;
      for (const offset of offsets) {
        if (Math.abs(offset) < WALK_GAP + 0.04
          || Math.abs(offset - p.lateral) < 0.35) continue;
        const place = pose(p.leg, s, offset, {});
        const clear = segment(p.leg, base, place) && canUse(p, place, 0, neighbors);
        if (clear) return { leg: p.leg, s, offset, base };
      }
    }
    // 可退到已连接的同侧支路，等待后沿原连接返回，不换漫游目标。
    if (room <= 8 && segment(p.leg, previous, pose(p.leg, end ? p.leg.length : 0, 0, {}))) {
      for (const link of p.leg.ends[end]) {
        if (link.leg === winner.leg || link.leg.length < 1.7) continue;
        const s = link.end ? link.leg.length - 1.55 : 1.55;
        const entry = pose(link.leg, link.end ? link.leg.length : 0, 0, {});
        const place = pose(link.leg, s, 0, {});
        if (segment(link.leg, entry, place) && canUse(p, place, 0, neighbors)) {
          return { leg: link.leg, s, offset: 0, end, link };
        }
      }
    }
    return null;
  }

  function reservePass(p, q, grid) {
    if (p.yielding || p.priority || q.yielding || q.priority) return;
    // 每对人只有一个决策；有近会车点的一方先退，相同时由固定编号裁决。
    grid.query(q.x, q.z, RANGE, candidates);
    const a = pocket(p, q, nearby), b = pocket(q, p, candidates);
    if (!a && !b) return;
    const retreat = (actor, option) => option.link ? (actor.dir > 0 ? actor.s : actor.leg.length - actor.s) + 1.55
      : Math.abs(option.s - actor.s);
    const pYields = a && (!b || retreat(p, a) < retreat(q, b) - 0.15
      || (Math.abs(retreat(p, a) - retreat(q, b)) <= 0.15 && p.id > q.id));
    const loser = pYields ? p : q, winner = pYields ? q : p;
    loser.yielding = { winner, pocket: pYields ? a : b, original: loser.leg, dir: loser.dir, offset: loser.lateral, fx: loser.fx, fz: loser.fz };
    loser.avoid = null;
    winner.avoid = null;
    winner.priority = loser;
    statistics.walkYields++;
  }

  function plan(p, grid, clock) {
    const nominal = rightOffset(p.leg, p.dir);
    p.walkSpeed = p.speed;
    p.walkOffset = nominal;
    if (p.yielding || p.priority || p.pause > 0) return;
    grid.query(p.x, p.z, RANGE, nearby);
    const risk = threat(p, nearby, pose, nominal);
    const checked = clock >= (p.walkCheck ?? 0);
    const routeLimit = p.dir > 0 ? p.leg.length - p.s : p.s;
    if (p.avoid) {
      const q = p.avoid.blocker;
      const gap = q.leg === p.leg ? (q.s - p.s) * p.dir : (q.x - p.x) * p.fx + (q.z - p.z) * p.fz;
      if (!q.activeWalker || (clock >= p.avoid.until && (gap < -1.05
        || Math.hypot(q.x - p.x, q.z - p.z) > RANGE || (p.stuckFor > 1.15 && q.stuckFor > 0.8)))) p.avoid = null;
    }
    if (checked) {
      p.walkCheck = clock + 0.22 + (p.id % 7) * 0.017;
      statistics.walkPlans++;
      if (risk && !p.avoid) {
        const { q, headOn, lead, dot } = risk;
        const length = Math.min(routeLimit, Math.max(1, Math.min(4.5, headOn ? lead * 0.75 + 0.55 : lead + 0.85)));
        const limit = offsetLimit(p.leg);
        const coop = headOn && q.leg === p.leg && !q.avoid && !q.yielding && !q.priority && q.pause <= 0 ? q : null;
        // 迎面优先都靠右；同向超越优先左侧。在通过同一个人前不重新选边。
        const right = offsetsWithin(limit).map(o => -p.dir * o);
        const left = right.map(o => -o);
        const sides = headOn ? [...right, ...left] : [...left, ...right];
        for (const offset of sides) {
          if (length < 0.45) continue;
          if (!headOn && p.leg === q.leg && dot > 0.5 && Math.abs(offset - q.lateral) < WALK_GAP + 0.04) continue;
          if (coop) {
            const otherOffset = offset * p.dir * q.dir;
            grid.query(q.x, q.z, RANGE, candidates);
            const otherLength = Math.min(q.dir > 0 ? q.leg.length - q.s : q.s, length);
            if (!sideClear(q, otherOffset, otherLength, candidates, p, offset)
              || !sideClear(p, offset, length, nearby, q, otherOffset)) continue;
            q.avoid = { blocker: p, offset: otherOffset, until: clock + 0.85 };
          } else if (!sideClear(p, offset, length, nearby)) continue;
          p.avoid = { blocker: q, offset, until: clock + 0.85 };
          statistics.walkPasses++;
          break;
        }
        if (!p.avoid && headOn && q.leg === p.leg && lead > 0 && q.pause <= 0) reservePass(p, q, grid);
      }
      if (!p.avoid && !p.yielding && !p.staticPath && routeLimit > 0.45) {
        const look = pose(p.leg, p.s + p.dir * Math.min(1.2, routeLimit), nominal, {});
        const center = pose(p.leg, p.s + p.dir * Math.min(1.2, routeLimit), 0, {});
        if (!segment(p.leg, p, look)) {
          if (segment(p.leg, p, center)) p.centerUntil = clock + 0.36;
          else if (clock >= (p.staticCheck ?? 0)) {
            p.staticPath = aroundStatic(p, nominal);
            p.staticCheck = clock + 0.8;
            if (p.staticPath) statistics.walkDetours++;
          }
        }
      }
    }
    if (p.yielding || p.priority) return;
    if (p.avoid) p.walkOffset = p.avoid.offset;
    else if (p.staticPath?.length) {
      while (p.staticPath.length && (p.staticPath.at(-1).s - p.s) * p.dir < 0.045
        && Math.abs(p.staticPath.at(-1).offset - p.lateral) < 0.12) p.staticPath.pop();
      if (p.staticPath.length) {
        const waypoint = p.staticPath.at(-1);
        p.walkOffset = waypoint.offset;
        if (Math.abs(waypoint.offset - p.lateral) > 0.12) {
          p.walkSpeed = Math.min(p.walkSpeed, Math.max(0, (waypoint.s - p.s) * p.dir) * 4);
        }
      } else p.staticPath = null;
    } else if (p.centerUntil > clock) p.walkOffset = 0;
    if (!risk || (p.avoid && p.avoid.blocker === risk.q && Math.abs(p.lateral - p.walkOffset) < 0.18)) return;
    const { lead, qSpeed, dot, q } = risk;
    if (Math.abs(dot) <= 0.5 && p.id < q.id && lead > 1.3) return;
    const gap = Math.max(0, lead - WALK_GAP - (dot > 0.5 ? 0.16 : 0.25));
    p.walkSpeed = Math.min(p.speed, (dot > 0.5 ? qSpeed : 0) + gap * (dot > 0.5 ? 1.15 : 1.5));
  }

  function update(peds, grid, clock) {
    seen.clear();
    for (const p of peds) seen.add(p);
    for (const p of peds) {
      if (p.yielding && !seen.has(p.yielding.winner)) p.yielding.cleared = true;
      if (p.priority && (!seen.has(p.priority) || !p.priority.yielding || p.priority.yielding.cleared)) p.priority = null;
    }
    for (const p of peds) plan(p, grid, clock);
  }

  return { update };
}
