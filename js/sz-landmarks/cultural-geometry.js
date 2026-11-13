import { footprintParts, loftPart, roofPanelPart } from './parts.js';

export const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
export const points = pairs => pairs.map(([x, z]) => ({ x, z }));

export function solid(id, source, outer, base, min, max, style, { holes = [], ...options } = {}) {
  return footprintParts({ ...source, polygons: [{ outer, holes }] }, base, style,
    { id, min, max, derived: true, ...options })[0];
}

// 折面板的显示、碰撞和可站面共用三角面；相邻面不再绘制内部竖墙。
export function panelStrip(id, source, sections, style, { roofContact = false, heightSource = 'estimate' } = {}) {
  const parts = [];
  for (let i = 1; i < sections.length; i++) {
    const [a, b] = sections[i - 1], [c, d] = sections[i];
    const rows = [[a, b, d], [a, d, c]];
    for (const [side, corners] of rows.entries()) {
      const open = side === 0 ? [[a, d], ...(i > 1 ? [[a, b]] : [])] : [[a, d], ...(i < sections.length - 1 ? [[c, d]] : [])];
      const part = roofPanelPart(`${id}:${i}:${side}`, source, corners, corners.map(v => v.depth), style,
        { roofContact, heightSource });
      const same = (p, q) => p.x === Math.fround(q.x) && p.z === Math.fround(q.z);
      const walls = part.polygon.outer.map((p, j, ring) => !open.some(([x, y]) => {
        const q = ring[(j + 1) % ring.length];
        return (same(p, x) && same(q, y)) || (same(p, y) && same(q, x));
      }));
      // 省略内部竖墙时保留真实面法线；三角折线在远处仍可辨。
      const [p, q, s] = part.roofPanel.outer;
      const [py, qy, sy] = part.top;
      const dx = q.x - p.x, dy = qy - py, dz = q.z - p.z;
      const ex = s.x - p.x, ey = sy - py, ez = s.z - p.z;
      const nx = dz * ey - dy * ez, ny = dx * ez - dz * ex, nz = dy * ex - dx * ey;
      const length = Math.hypot(nx, ny, nz);
      const n = { x: nx / length, y: ny / length, z: nz / length };
      parts.push({ ...part, roofSkin: { walls, normals: [n, n, n], uv: part.polygon.outer.map(v => [v.x, v.z]) } });
    }
  }
  return parts;
}

export function fittedRing(shape, x, z, scale) {
  return shape.map(p => ({ x: x + p.x * scale, z: z + p.z * scale }));
}

export function towerSegment(id, source, shape, base, low, high, style, options) {
  const ring = ([, scale, x, z]) => fittedRing(shape, x, z, scale);
  return loftPart(id, source, ring(low), ring(high), base + low[0], base + high[0], style, options);
}
