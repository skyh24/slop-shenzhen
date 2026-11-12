import { createDroneFormations, FLEET_SIZE } from './sz-drone-formations.js';

export const DRONE_CLEARANCE_M = 3.2;
export const DRONE_SPEED_MPS = 16;
export const DRONE_ACCEL_MPS2 = 7;
const LAYER_M = 4;
const DISTANCE_EPSILON = 1e-8;
const quintic = t => t * t * t * (10 + t * (-15 + 6 * t));
const mix = (a, b, t) => a + (b - a) * t;
const dot = (a, b) => a.u * b.u + a.v * b.v + a.d * b.d;
const sub = (a, b) => ({ u: a.u - b.u, v: a.v - b.v, d: a.d - b.d });
const norm = p => Math.hypot(p.u, p.v, p.d);

function shortestRelativeDistance(a, b, c, d) {
  const start = sub(a, b), end = sub(c, d), delta = sub(end, start);
  const p = Math.max(0, Math.min(1, -dot(start, delta) / Math.max(DISTANCE_EPSILON, dot(delta, delta))));
  return Math.hypot(start.u + p * delta.u, start.v + p * delta.v, start.d + p * delta.d);
}

// 一对一最小代价匹配；先减少远距离换位，再以保守间距约束处理交叉。
function match(from, to) {
  const n = from.length;
  const weights = from.map(a => Float64Array.from(to, b => (a.u - b.u) ** 2 + (a.v - b.v) ** 2));
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const distance = new Float64Array(n + 1).fill(Infinity);
    const seen = new Uint8Array(n + 1);
    do {
      seen[j0] = 1;
      const row = weights[p[j0] - 1], base = u[p[j0]];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (seen[j]) continue;
        const cost = row[j - 1] - base - v[j];
        if (cost < distance[j]) { distance[j] = cost; way[j] = j0; }
        if (distance[j] < delta) { delta = distance[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (seen[j]) { u[p[j]] += delta; v[j] -= delta; }
        else distance[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const previous = way[j0];
      p[j0] = p[previous];
      j0 = previous;
    } while (j0 !== 0);
  }
  const result = new Array(n);
  for (let j = 1; j <= n; j++) result[p[j] - 1] = to[j - 1];
  return result;
}

function durationFor(from, to, seconds) {
  const length = Math.max(...from.map((p, i) => norm(sub(to[i], p))));
  const duration = Math.max(seconds, 1.875 * length / DRONE_SPEED_MPS,
    Math.sqrt((10 / Math.sqrt(3)) * length / DRONE_ACCEL_MPS2));
  return { length, duration };
}

const withDepth = (p, d) => ({ ...p, d });
const lifted = (p, v) => ({ ...p, v: p.v + v });

function transition(from, to) {
  // 先在原格位展开深度，再沿屏幕平面换形，最后在新格位归层。
  // 同层两机的相对位移是线段，可解析求整个阶段的最近点，含所有中间时刻。
  const planar = p => withDepth(p, 0);
  const a = from.map(planar), b = to.map(planar);
  const neighbours = a.map(() => []);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < i; j++) {
    if (shortestRelativeDistance(a[i], a[j], b[i], b[j]) < DRONE_CLEARANCE_M + 1e-5) {
      neighbours[i].push(j);
      neighbours[j].push(i);
    }
  }
  const colors = a.map(() => -1);
  const order = a.map((_, i) => i).sort((i, j) => neighbours[j].length - neighbours[i].length || i - j);
  for (const i of order) {
    const forbidden = new Set(neighbours[i].map(j => colors[j]));
    let layer = 0;
    while (forbidden.has(layer)) layer++;
    colors[i] = layer;
  }
  const middle = Math.max(...colors) / 2;
  const lanes = colors.map(layer => (layer - middle) * LAYER_M);
  const startDepth = from[0].d, endDepth = to[0].d;
  return [from, from.map((p, i) => withDepth(p, startDepth + lanes[i])),
    to.map((p, i) => withDepth(p, endDepth + lanes[i])), to];
}

export function planDroneChoreography() {
  const cues = createDroneFormations();
  const stages = [];
  let time = 0;
  let minSpacing = Infinity, peakSpeed = 0, peakAcceleration = 0;
  const dock = cues[0].points.map(p => ({ ...lifted(p, cues[0].v), d: cues[0].depth }));
  let frame = dock;

  function add(from, to, seconds, cue, { changing = false } = {}) {
    // 五次缓入缓出，两端速度与加速度为零；解析导数极值决定时长。
    const { length, duration } = durationFor(from, to, seconds);
    if (!duration) return;
    peakSpeed = Math.max(peakSpeed, 1.875 * length / duration);
    peakAcceleration = Math.max(peakAcceleration, (10 / Math.sqrt(3)) * length / duration ** 2);
    for (let i = 0; i < FLEET_SIZE; i++) for (let j = 0; j < i; j++) {
      minSpacing = Math.min(minSpacing, shortestRelativeDistance(from[i], from[j], to[i], to[j]));
    }
    stages.push({ start: time, end: time + duration, cue, from, to, changing });
    time += duration;
  }

  for (let cue = 0; cue < cues.length; cue++) {
    const row = cues[cue];
    if (cue > 0) {
      const points = row.points.map(p => ({ ...lifted(p, row.v ?? 0), d: row.depth ?? 0 }));
      // 回到与开场完全相同的机位和身份，循环边界不会重新编号或跳位。
      const target = cue === cues.length - 1 ? dock : match(frame, points);
      const path = transition(frame, target);
      for (let i = 1; i < path.length; i++) add(path[i - 1], path[i], i === 2 ? 7 : 0, cue, { changing: true });
      frame = target;
    }
    const held = row.motion ? frame.map(p => lifted(p, row.motion)) : frame;
    add(frame, held, row.hold, cue);
    frame = held;
  }

  if (minSpacing < DRONE_CLEARANCE_M) throw new Error(`Drone choreography spacing: ${minSpacing}`);
  const envelope = { u: [Infinity, -Infinity], v: [Infinity, -Infinity], d: [Infinity, -Infinity] };
  for (const stage of stages) for (const p of [...stage.from, ...stage.to]) {
    for (const key of ['u', 'v', 'd']) {
      envelope[key][0] = Math.min(envelope[key][0], p[key]);
      envelope[key][1] = Math.max(envelope[key][1], p[key]);
    }
  }
  // 重播在下一个完整阵型开始处申请回收，利用同一分层算法返回原机位。
  const replays = new Map();
  for (const stage of stages.filter(row => !row.changing)) {
    const path = transition(stage.from, dock);
    let duration = 0;
    const rows = [];
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1], to = path[i];
      const { duration: dt } = durationFor(from, to, i === 2 ? 3 : 0);
      for (const p of [...from, ...to]) {
        for (const key of ['u', 'v', 'd']) {
          envelope[key][0] = Math.min(envelope[key][0], p[key]);
          envelope[key][1] = Math.max(envelope[key][1], p[key]);
        }
      }
      if (dt > 0) rows.push({ from, to, start: duration, end: duration + dt, cue: cues.length - 1, changing: true });
      duration += dt;
    }
    replays.set(stage.start, { stages: rows, duration });
  }
  return { stages, replays, cues: cues.map(row => row.id), duration: time, minSpacing, peakSpeed, peakAcceleration, envelope };
}

export function sampleDroneChoreography(plan, seconds, poses) {
  const time = ((seconds % plan.duration) + plan.duration) % plan.duration;
  const stage = plan.stages.find(row => time < row.end) ?? plan.stages.at(-1);
  const t = quintic((time - stage.start) / (stage.end - stage.start));
  for (let i = 0; i < FLEET_SIZE; i++) {
    const a = stage.from[i], b = stage.to[i], p = poses[i];
    p.u = mix(a.u, b.u, t);
    p.v = mix(a.v, b.v, t);
    p.d = mix(a.d, b.d, t);
    const pulse = 0.84 + 0.16 * Math.sin(i * 0.17 + seconds * 2);
    p.r = mix(a.tint[0], b.tint[0], t) * pulse;
    p.g = mix(a.tint[1], b.tint[1], t) * pulse;
    p.b = mix(a.tint[2], b.tint[2], t) * pulse;
  }
  return stage;
}
