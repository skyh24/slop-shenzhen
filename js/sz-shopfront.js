import { polygonBoxOverlaps } from './building-collision.js';
import { polygonContainsInclusive } from './sz-polygon.js';

export function frame(x, z, dx, dz) {
  const n = Math.hypot(dx, dz);
  const c = dx / n, s = dz / n;
  return { c, s, at: (u, v) => ({ x: x + c * u - s * v, z: z + s * u + c * v }) };
}

export function shopOpenings(building, poly, ordered, base, heightAt, { front, entryClear, spacing, depth, minLength }) {
  const openings = new Map();
  const outline = [poly.outer, ...poly.holes].flatMap(ring => ring.map((a, i) =>
    ({ outer: [a, ring[(i + 1) % ring.length]], holes: [] })));
  const cuts = [];
  const level = h => Number.isFinite(h) && Math.abs(h - base) < 0.13;
  for (let edge = 0; edge < ordered.length; edge++) {
    const a = ordered[(edge + 1) % ordered.length], b = ordered[edge];
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    if (length < minLength) continue;
    const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
    const count = Math.max(1, Math.round(length / spacing));
    const bay = length / count;
    const w = Math.min(5.2, bay * 0.76), d = depth;
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) * bay;
      if (!front(f.at(u, 0.8), f)) continue;
      const sides = [-w / 2, 0, w / 2];
      const probes = sides.flatMap(offset => [0.27, 1.2].map(v => f.at(u + offset, v)));
      if (!probes.every(p => {
        const y = heightAt(p.x, p.z);
        return level(y) && entryClear(p, y, 2.6, building.id);
      })) continue;
      const interior = sides.flatMap(offset => [-0.12, -d].map(v => f.at(u + offset, v)));
      if (!interior.every(p => polygonContainsInclusive(poly, p.x, p.z) && level(heightAt(p.x, p.z)))) continue;
      // 拐角、内院或不规则外墙可能从铺面内部切过。除临街开口外，凹槽须完整落在源轮廓内。
      const center = f.at(u, -(d + 0.06) / 2);
      if (!polygonContainsInclusive(poly, center.x, center.z)
        || [...outline, ...cuts].some(p => polygonBoxOverlaps(p, center.x, center.z, w / 2, (d - 0.06) / 2, f.c, -f.s))) continue;
      const clearApproach = v => {
        const p = f.at(u, v);
        const y = heightAt(p.x, p.z);
        return level(y) && entryClear(p, y, 1.9, building.id, 0.55);
      };
      let step = 3;
      while (step <= 12 && clearApproach(step * 0.4)) step++;
      if (step <= 4) continue;
      const floorRing = [f.at(u + w / 2, 0), f.at(u + w / 2, -d), f.at(u - w / 2, -d), f.at(u - w / 2, 0)];
      const opening = { f, u, w, d, floorRing, approach: (step - 1) * 0.4 };
      if (!openings.has(edge)) openings.set(edge, []);
      openings.get(edge).push(opening);
      cuts.push({ outer: floorRing, holes: [] });
    }
  }
  return openings;
}

export function recessedShopRing(ordered, openings) {
  return ordered.flatMap((p, edge) => {
    const bays = openings.get(edge) ?? [];
    return [p, ...bays.slice().reverse().flatMap(bay => bay.floorRing)];
  });
}

// 海上世界同款布局。货架、柜台靠两侧后墙，门口至柜台之间留空。
export function shopFurniture(w, d, i, metal, solid, detail) {
  const right = w * 0.34, left = -w * 0.32;
  solid(right, -d + 0.55, 0, 1.0, w * 0.27, 0.60, 'wood');
  detail(right, -d + 0.55, 1.035, w * 0.30, 0.07, 0.67, 'stone');
  for (const [a, b] of [[0.28, 0.38], [0.78, 0.87], [1.33, 1.41]]) {
    solid(left, -d + 0.20, a, b, w * 0.33, 0.29, metal);
    for (let j = 0; j < 6; j++) {
      detail(left + (j - 2.5) * w * 0.048, -d + 0.20, b + 0.12,
        0.12, 0.24, 0.20, ['terra', 'brass', 'green', 'ivory'][(i + j) % 4]);
    }
  }
}
