import { loftPart, spanPart, footprintParts } from '../sz-landmarks/parts.js';
import { orientedBoxRing, polygonContainsInclusive } from '../sz-polygon.js';

export const rectangle = (x, z, w, d, a = 0) => orientedBoxRing(x, z, w, d, Math.cos(a), Math.sin(a));
export const disk = (x, z, r, n = 12) => Array.from({ length: n }, (_, i) => {
  const a = i * 2 * Math.PI / n;
  return { x: x + Math.cos(a) * r, z: z + Math.sin(a) * r };
});

export function sampleFootprint(ring, visit, step = 2) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step);
    for (let j = 0; j < n; j++) if (!visit(a.x + (b.x - a.x) * j / n, a.z + (b.z - a.z) * j / n)) return false;
  }
  const polygon = { outer: ring, holes: [] };
  const xs = ring.map(p => p.x), zs = ring.map(p => p.z);
  const x0 = Math.min(...xs), z0 = Math.min(...zs);
  for (let x = x0 + step / 2; x < Math.max(...xs); x += step) {
    for (let z = z0 + step / 2; z < Math.max(...zs); z += step) {
      if (polygonContainsInclusive(polygon, x, z) && !visit(x, z)) return false;
    }
  }
  return true;
}

export function parkParts(id, ground, parts = [], heightSource = 'estimate') {
  const source = { id, heightSource };
  const next = () => `${id}:${parts.length}`;
  const add = part => parts.push({ ...part, baseSource: 'rendered-terrain' });
  function limits(ring) {
    let bottom = Infinity, top = -Infinity;
    sampleFootprint(ring, (x, z) => {
      const y = ground(x, z);
      if (!Number.isFinite(y)) throw new Error(`Unsupported park ground: ${id}`);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
      return true;
    });
    return [bottom, top];
  }
  function solid(ring, bottom, top, style) {
    add(footprintParts({ ...source, polygons: [{ outer: ring, holes: [] }] }, 0, style, {
      id: next(), min: bottom, max: top, derived: true
    })[0]);
  }
  const box = (x, z, w, d, bottom, top, style, a = 0) => solid(rectangle(x, z, w, d, a), bottom, top, style);
  const loft = (lower, upper, bottom, top, style) =>
    add(loftPart(next(), source, lower, upper, bottom, top, style, { heightSource }));
  function span(a, b, width, depth, style, widthB = width) {
    add(spanPart(next(), source, a, b, width, widthB, depth, style, { heightSource }));
  }
  function footing(ring, rise, style) {
    const [low, high] = limits(ring);
    const top = high + rise;
    solid(ring, low - 0.25, top, style);
    return top;
  }
  return { parts, box, solid, loft, span, limits, footing };
}
