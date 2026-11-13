import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { disk, parkParts, rectangle } from './parts.js';

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
  const track = new CatmullRomCurve3(TRACK_LAYOUT.map(([x, z, h]) => new Vector3(x, 8 + h, z)), true);
  const samples = 144;
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
  const p = parkParts(id, ground);
  // 太空梭 node/6942405222；塔高和座舱是静态示意。
  const [x, z] = [-7970, 421.4];
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
