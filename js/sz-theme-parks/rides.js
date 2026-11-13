import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { disk, parkParts, rectangle, scaledParkParts } from './parts.js';

// 雪域雄鹰片区参考 way/936620421、way/1426564269–272；闭合线和高程为避楼设计。
const TRACK_LAYOUT = [
  [-8008, -48, 6], [-7992, -48, 6], [-7971, -49, 10], [-7954, -67, 28], [-7942, -100, 53],
  [-7948, -125, 40], [-7971, -138, 15], [-7999, -126, 13], [-8028, -101, 23], [-8040, -67, 24],
  [-8050, -35, 16], [-8066, -9, 12], [-8046, 18, 21], [-8016, 26, 29], [-7985, 22, 45],
  [-7953, 8, 40], [-7940, -15, 30], [-7953, -33, 19], [-7978, -28, 14], [-8019, -24, 11],
  [-8035, -34, 8], [-8016, -43, 6]
];

export function rollerCoaster(ground, canPlace) {
  const id = 'theme-coaster';
  const p = parkParts(id, ground);
  const track = new CatmullRomCurve3(TRACK_LAYOUT.map(([x, z, h]) => new Vector3(x, 8 + (h <= 6 ? h : 6 + (h - 6) * 1.40), z)), true);
  const samples = 160;
  const rings = Array.from({ length: samples }, (_, i) => {
    const t = i / samples;
    const c = track.getPointAt(t), tangent = track.getTangentAt(t);
    const length = Math.hypot(tangent.x, tangent.z);
    return [0, -0.94, 0.94].map(side => ({
      x: c.x + tangent.z / length * side, z: c.z - tangent.x / length * side, y: c.y
    }));
  });
  function rail(a, b, w, depth, style) {
    // 每段略伸入接头，闭环首尾沿用同一采样截面。
    const overlap = 0.22 / Math.hypot(b.x - a.x, b.z - a.z);
    const endpoint = (from, to) => ({
      x: from.x + (from.x - to.x) * overlap,
      y: from.y + (from.y - to.y) * overlap,
      z: from.z + (from.z - to.z) * overlap
    });
    p.span(endpoint(a, b), endpoint(b, a), w, depth, style);
  }
  for (let i = 0; i < samples; i++) {
    const [spine, left, right] = rings[i];
    const next = rings[(i + 1) % samples];
    rail({ ...spine, y: spine.y - 0.42 }, { ...next[0], y: next[0].y - 0.42 }, 0.84, 0.58, 'rideblue');
    rail(left, next[1], 0.36, 0.42, 'railred');
    rail(right, next[2], 0.36, 0.42, 'railred');
    if (i % 2 === 0) p.span(left, right, 0.41, 0.37, 'railred');
    if (i % 4 !== 0 || (spine.x > -8018 && spine.x < -7984 && Math.abs(spine.z + 48) < 1.4)) continue;
    const { x, y, z } = spine;
    const pad = disk(x, z, 1.64, 8);
    if (!canPlace(pad, -Infinity, y - 1)) continue;
    const base = p.footing(pad, 0.24, 'basalt');
    p.loft(disk(x, z, 0.9, 8), disk(x, z, 0.68, 8), base, y - 0.65, 'rideblue');
  }
  const base = p.footing(rectangle(-7998, -48, 34, 7.8), 0.34, 'courtyard');
  for (const dx of [-14.8, 0, 14.8]) for (const dz of [-3.25, 3.25]) {
    p.box(-7998 + dx, -48 + dz, 0.54, 0.54, base, 16.05, 'rideblue');
  }
  p.box(-7998, -48, 33.4, 7.7, 16, 16.58, 'railred');
  p.loft(rectangle(-7998, -48, 33.4, 7.7), rectangle(-7998, -48, 32.6, 1.2), 16.58, 18.1, 'rideblue');
  return { id, parts: p.parts, track, rings };
}

export function dropTower(ground) {
  const id = 'theme-drop-tower';
  // 太空梭 node/6942405222；塔高和座舱是静态示意。
  const [x, z] = [-7970, 428.4];
  const p = scaledParkParts(id, ground, x, z, 1.42);
  const base = p.footing(rectangle(x, z, 12, 12), 0.32, 'courtyard');
  const corners = rectangle(x, z, 4.2, 4.2);
  for (let i = 0; i < corners.length; i++) {
    const { x, z } = corners[i];
    p.box(x, z, 0.85, 0.85, base, base + 55.9, 'rideblue');
    for (let h = 2; h < 53; h += 5.4) {
      const a = corners[i], b = corners[(i + 1) % 4];
      p.span({ ...a, y: base + h }, { ...b, y: base + h }, 0.42, 0.4, 'rideblue');
      p.span({ ...a, y: base + h }, { ...b, y: base + h + 5.4 }, 0.36, 0.4, 'rideblue');
    }
  }
  p.box(x, z, 6.8, 6.8, base + 55, base + 56.5, 'railred');
  p.loft(rectangle(x, z, 6.8, 6.8), rectangle(x, z, 2.8, 2.8), base + 56.5, base + 60, 'brass');
  p.box(x, z, 6.2, 6.2, base + 12.6, base + 13.3, 'railred');
  for (let side = 0; side < 4; side++) {
    const a = side * Math.PI / 2;
    for (const i of [-1, 0, 1]) {
      const cx = x + 3.07 * Math.cos(a) - i * 1.26 * Math.sin(a);
      const cz = z + 3.07 * Math.sin(a) + i * 1.26 * Math.cos(a);
      p.box(cx, cz, 0.86, 0.95, base + 13.24, base + 14.48, 'brass', a);
    }
  }
  return { id, parts: p.parts };
}

export function waterSlide(ground) {
  const id = 'theme-water-slide';
  // 玛雅水公园片区参考 way/1564674154。加宽三条滑槽和终点池，向北延伸起滑平台。
  const x = -8190, z = 149;
  const p = scaledParkParts(id, ground, x, z, 1.38);
  const base = p.footing(rectangle(x, z, 20, 13), 0.26, 'courtyard');
  const h = base + 22;
  for (const dx of [-7.8, 7.8]) for (const dz of [-4.4, 4.4]) {
    const pad = disk(x + dx, z + dz, 1.1, 8);
    const foot = p.footing(pad, 0.18, 'basalt');
    p.loft(disk(x + dx, z + dz, 0.63, 8), disk(x + dx, z + dz, 0.47, 8), foot, h, 'rideblue');
  }
  for (const dx of [-7.8, 7.8]) {
    p.span({ x: x + dx, z: z - 4.4, y: base + 6 }, { x: x + dx, z: z + 4.4, y: h }, 0.45, 0.43, 'rideblue');
  }
  p.box(x, z, 18, 10.8, h - 0.6, h, 'slideTurquoise');
  p.box(x, z - 5.2, 18, 0.22, h, h + 1.2, 'rideblue');
  const end = z + 81;
  const poolX = x + 10, poolZ = end + 9;
  const poolBase = p.footing(rectangle(poolX, poolZ, 36, 27), 0.31, 'poolDeck');
  p.box(poolX, poolZ, 32, 23, poolBase, poolBase + 0.1, 'slideWater');
  for (const [lane, style] of [[-1, 'slideTurquoise'], [0, 'slideYellow'], [1, 'railred']]) {
    const path = new CatmullRomCurve3([[x + lane * 4.7, h, z + 5.3],
      [x + lane * 4.7, h - 3.4, z + 18], [x + lane * 4.7 + 8, h - 9.4, z + 32],
      [x + lane * 4.7 + 14, h - 12.4, z + 48], [x + lane * 4.7 + 11, h - 16, z + 62],
      [poolX + lane * 4.7, poolBase + 0.42, end]].map(v => new Vector3(...v)));
    const n = 26;
    const points = Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, a = path.getPoint(t), b = path.getTangent(t);
      const l = Math.hypot(b.x, b.z);
      return { x: a.x, z: a.z, y: a.y, dx: b.z / l, dz: -b.x / l };
    });
    for (let i = 1; i <= n; i++) {
      const a = points[i - 1], b = points[i];
      const join = (a, b, w, depth) => {
        const f = 0.10 / Math.hypot(b.x - a.x, b.z - a.z);
        const extend = (u, v, overlap) => ({
          x: u.x + (u.x - v.x) * overlap, z: u.z + (u.z - v.z) * overlap, y: u.y + (u.y - v.y) * overlap
        });
        p.span(extend(a, b, f), extend(b, a, f), w, depth, style);
      };
      join(a, b, 3.1, 0.46);
      for (const side of [-1.43, 1.43]) {
        const edge = q => ({ x: q.x + q.dx * side, z: q.z + q.dz * side, y: q.y + 0.63 });
        join(edge(a), edge(b), 0.32, 0.73);
      }
      if (i % 5 === 0 && i < 24) {
        const pad = disk(b.x, b.z, 0.76, 8);
        const foot = p.footing(pad, 0.18, 'basalt');
        if (foot < b.y - 0.4) p.loft(disk(b.x, b.z, 0.45, 8), disk(b.x, b.z, 0.33, 8), foot, b.y - 0.4, 'rideblue');
      }
    }
  }
  return { id, parts: p.parts };
}
