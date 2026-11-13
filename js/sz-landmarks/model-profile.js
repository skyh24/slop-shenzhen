import { footprintParts, loftPart, point } from './parts.js';

// 沿源足迹长边建局部轴。u 顺着边，v 逆时针转 90°，不把地标强制对齐世界轴。
export function frameAt(origin, a, b) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
  return (u, v) => point(origin.x + dx * u - dz * v, origin.z + dz * u + dx * v);
}

export function longestEdge(ring) {
  return ring.reduce((best, a, i) => {
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return length > best.length ? { a, b, length } : best;
  }, { length: 0 });
}

export function rect(at, u, v, w, d) {
  return [at(u - w / 2, v - d / 2), at(u + w / 2, v - d / 2),
    at(u + w / 2, v + d / 2), at(u - w / 2, v + d / 2)];
}

export function ellipse(at, u, v, rx, rz, sides = 12) {
  return Array.from({ length: sides }, (_, i) => {
    const a = i * Math.PI * 2 / sides;
    return at(u + Math.cos(a) * rx, v + Math.sin(a) * rz);
  });
}

export function volume(id, source, ring, bottom, top, style, options = {}) {
  return footprintParts({ ...source, polygons: [{ outer: ring, holes: [] }] }, 0, style,
    { id, min: bottom, max: top, derived: true, ...options })[0];
}

export function column(id, source, center, radius, bottom, top, style) {
  const at = (u, v) => point(center.x + u, center.z + v);
  return volume(id, source, ellipse(at, 0, 0, radius, radius, 10), bottom, top, style);
}

// 连续截面共享边界，不提交藏在体块内部的重叠顶/底面。
export function stackedLofts(id, source, base, sections, { heightSource, smoothSides = false } = {}) {
  return sections.slice(0, -1).map(({ y, ring, style }, i) => {
    const next = sections[i + 1];
    const last = i === sections.length - 2;
    return loftPart(`${id}:${i}`, source, ring, next.ring, base + y, base + next.y, style, {
      heightSource: last ? heightSource : 'estimate', uvOriginY: base, smoothSides, bottomFace: i === 0, topFace: last
    });
  });
}

export function approach(from, to, halfWidth) {
  return { from, to, halfWidth };
}
