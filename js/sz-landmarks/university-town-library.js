import { baseAt, spanPart } from './parts.js';
import { approach, column, frameAt, longestEdge, rect, stackedLofts, volume } from './model-profile.js';

export const sourceIds = ['way/319515324'];

function geometry(source) {
  const { a, b, length } = longestEdge(source.polygons[0].outer);
  const north = a.z < b.z ? a : b;
  const south = a.z < b.z ? b : a;
  const atEdge = frameAt(north, north, south);
  // 源长边的另一侧距约 43 米；以跨河主轴而非 POI 中心对齐。
  const offsets = source.polygons[0].outer.map(p => (-(p.x - south.x) * (south.z - north.z)
    + (p.z - south.z) * (south.x - north.x)) / length);
  const v = Math.min(...offsets) + Math.max(...offsets);
  return { at: frameAt(atEdge(0, v / 2), north, south), length };
}

export function build(sources, terrain, { heightAt } = {}) {
  const source = sources.get(sourceIds[0]);
  const { at, length } = geometry(source);
  const north = at(3, 0), south = at(length - 3, 0);
  const base = heightAt?.(north.x, north.z) ?? baseAt(source, terrain);
  const southY = heightAt?.(south.x, south.z) ?? base;
  const p = (u, v, y) => ({ ...at(u, v), y });
  const deck = (id, u0, u1, v, y0, y1, w0, w1, depth = 0.58) => spanPart(id, source, p(u0, v, y0), p(u1, v, y1),
    w0, w1, depth, 'libraryDeck', { roofContact: true, climbableFromGround: true });
  const parts = [
    deck('library:north-forecourt', -14, 3, 0, base + 0.08, base + 0.08, 30, 30),
    ...[-1, 1].map(side => deck(`library:north-ramp:${side}`, 3, 57, 10 * side, base + 0.08, base + 6.2, 4, 4)),
    deck('library:approach-deck', 57, 112, 0, base + 6.2, base + 7.6, 24, 25),
    deck('library:river-deck', 112, 188, 0, base + 7.6, base + 10.2, 25, 24),
    deck('library:road-deck', 188, 245, 0, base + 10.2, base + 8.2, 24, 24),
    deck('library:south-deck', 245, length - 63, 0, base + 8.2, southY + 6.0, 24, 24),
    deck('library:south-ramp', length - 63, length - 3, 0, southY + 6.0, southY + 0.08, 24, 13)
  ];
  // 入口中轴是宽台阶，两侧坡道与上平台同高；台阶上表面直接作为接触面。
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    const start = 16 + 41 * i / steps, end = 16 + 41 * (i + 1) / steps;
    const top = base + 0.08 + (6.2 - 0.08) * (i + 1) / steps;
    parts.push(deck(`library:north-step:${i}`, start, end, 0, top, top, 15.5, 15.5, top - base + 0.35));
  }
  for (const side of [-1, 1]) {
    const points = [[1, 17, 0.10], [21, 27, 1.75], [47, 28, 4.75], [76, 21, 6.8], [103, 13, 7.4]];
    for (let i = 1; i < points.length; i++) {
      const [u0, v0, y0] = points[i - 1];
      const [u1, v1, y1] = points[i];
      parts.push(spanPart(`library:side-ribbon:${side}:${i}`, source, p(u0, side * v0, base + y0),
        p(u1, side * v1, base + y1), 3.3, 3.3, 0.46, 'libraryShell'));
    }
  }
  // 北端是卷起的银色外壳。收窄的下腹、深色窗带、上层后退玻璃和挑出的薄檐按实景拟合。
  const capsule = [
    [9.4, 51, 20, 'libraryShell'], [11.5, 61, 33, 'libraryShell'],
    [15.8, 70, 41, 'libraryRibbon'], [19.3, 71, 41.6, 'libraryShell'],
    [23.6, 66, 37.8, 'libraryShell'], [26.4, 59, 28, 'libraryShell'], [27, 55, 23, null]
  ];
  // 宽深变化不同的截面，用相同长度的切角保证斜边方向一致。
  const capsuleRing = (l, w) => {
    const u = l / 2, v = w / 2, c = 6;
    return [[-u + c, -v], [u - c, -v], [u, -v + c], [u, v - c],
      [u - c, v], [-u + c, v], [-u, v - c], [-u, -v + c]].map(([x, z]) => at(63 + x, z));
  };
  parts.push(...stackedLofts('library:rolled-shell', source, base,
    capsule.map(([y, l, w, style]) => ({ y, ring: capsuleRing(l, w), style })),
    { heightSource: 'design', smoothSides: true }));
  parts.push(volume('library:recessed-lobby', source, rect(at, 79, 0, 34, 19), base - 0.45, base + 10.3, 'landmarkLobby'));
  for (const u of [47, 62, 86, 103, 113, 181, 197, 243, 261, 282]) {
    for (const v of [-10.8, 10.8]) {
      const q = at(u, v);
      const y = heightAt?.(q.x, q.z) ?? base;
      parts.push(column(`library:pier:${u}:${v}`, source, q, 0.62, y - 0.35, base + (u < 100 ? 10.0 : 8.3), 'landmarkEdge'));
    }
  }
  // 长卷盖板起伏，桥中段保留开敞柱间和中轴步行；南翼低体块不占学苑大道净空。
  const wave = [[96, 16.4, 32], [126, 14.7, 24], [159, 14.8, 23], [191, 17.8, 27], [226, 20.4, 35],
    [263, 18.3, 34], [295, 18.1, 34], [342, 19.8, 37], [395, 17.9, 35], [447, 15.6, 28], [length - 33, 13.4, 17]];
  for (let i = 1; i < wave.length; i++) {
    const [u0, y0, w0] = wave[i - 1], [u1, y1, w1] = wave[i];
    for (const sign of [-1, 1]) {
      parts.push(spanPart(`library:roof:${i}:${sign}`, source,
        p(u0, sign * (w0 * 0.26), base + y0), p(u1, sign * (w1 * 0.26), base + y1),
        w0 * 0.45, w1 * 0.45, 0.82, 'libraryShell'));
    }
  }
  for (const u of [256, 301, 347, 393, 437]) {
    for (const side of [-1, 1]) {
      const q = at(u, side * 9.8);
      const y = heightAt?.(q.x, q.z) ?? base;
      parts.push(column(`library:south-pier:${u}:${side}`, source, q, 0.57, y - 0.35, base + 15.1, 'landmarkEdge'));
    }
  }
  for (const [u, l, y] of [[267, 42, 15.7], [321, 66, 16.6], [391, 71, 16.2], [446, 36, 14.0]]) {
    parts.push(volume(`library:south-gallery:${u}`, source, rect(at, u, 0, l, 15),
      base + 8.5, base + y, 'libraryRibbon'));
  }
  for (const u of [114, 130, 146, 162, 178, 194, 210, 226]) {
    for (const side of [-1, 1]) {
      // 两侧交替斜撑，独立实体只占廊道边缘，不封闭跨河通道。
      const a = p(u - 5, side * 10.8, base + 9.5);
      const b = p(u + 5, side * 10.8, base + 15.2 + 2.8 * Math.max(0, (u - 163) / 63));
      parts.push(spanPart(`library:brace:${u}:${side}`, source, a, b, 0.38, 0.38, 0.44, 'landmarkEdge'));
    }
  }
  return parts;
}

export function approaches(sources) {
  const { at, length } = geometry(sources.get(sourceIds[0]));
  return [approach(at(-14, 0), at(58, 0), 11), approach(at(length - 58, 0), at(length + 9, 0), 6)];
}

export function trim(parts, sources) {
  const { at } = geometry(sources.get(sourceIds[0]));
  const y = parts.find(part => part.id === 'library:north-forecourt').maxY;
  const direction = at(1, 0);
  const origin = at(0, 0);
  const yaw = Math.atan2(direction.x - origin.x, direction.z - origin.z);
  return [-5.05, 5.05].flatMap(v => Array.from({ length: 12 }, (_, i) => {
    const u = 16.6 + i * 3.4;
    const floor = y + 6.12 * (Math.floor((u - 16) * 36 / 41) + 1) / 36;
    return { ...at(u, v), y: floor + 0.45, yaw, size: [0.055, 0.9, 0.055] };
  }));
}
