import { convexHull } from '../building-collision.js';
import { buildingPlacement } from '../sz-building-layout.js';

export const point = (x, z) => ({ x, z });
export const blend = (a, b, t) => a + (b - a) * t;

export function baseAt(building, terrain) {
  return buildingPlacement(building, terrain).baseY;
}

function part({ id, source, polygon, bottom, top, style, derived = false, roofContact = false,
  heightSource = source.heightSource, baseSource = 'dem-footprint-bounds-center', baseSourceId = source.id }) {
  const bounds = {
    minX: Math.min(...polygon.outer.map(p => p.x)), maxX: Math.max(...polygon.outer.map(p => p.x)),
    minZ: Math.min(...polygon.outer.map(p => p.z)), maxZ: Math.max(...polygon.outer.map(p => p.z)),
    minY: Math.fround(Array.isArray(bottom) ? Math.min(...bottom) : bottom),
    maxY: Math.fround(Array.isArray(top) ? Math.max(...top) : top)
  };
  return {
    id, sourceId: source.id, sourceHeight: source.height, sourceHeightSource: source.heightSource, heightSource,
    baseSource, baseSourceId, layoutSource: derived ? 'derived' : 'osm-footprint',
    polygon, bottom, top, style, roofContact, ...bounds
  };
}

export function footprintParts(source, baseY, style, {
  id = source.id, min = source.minHeight, max = source.height, derived = false, roofContact = false, baseSourceId = source.id,
  heightSource = derived ? 'estimate' : source.heightSource, topFace = true, bottomFace = true
} = {}) {
  return source.polygons.map((polygon, index) => ({ ...part({
    id: `${id}:${index}`, source, polygon, bottom: baseY + min, top: baseY + max, style, derived, roofContact, baseSourceId,
    heightSource
  }), topFace, bottomFace }));
}

export function spanPart(id, source, a, b, widthA, widthB, depth, style, {
  roofContact = false, climbableFromGround = false, heightSource = 'estimate', baseSourceId = source.id
} = {}) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-4) throw new Error(`Invalid landmark span: ${id}`);
  const nx = dz / length;
  const nz = -dx / length;
  const edge = (center, width, sign) => point(center.x + nx * sign * width / 2, center.z + nz * sign * width / 2);
  const polygon = { outer: [edge(a, widthA, -1), edge(b, widthB, -1), edge(b, widthB, 1), edge(a, widthA, 1)], holes: [] };
  const top = [a.y, b.y, b.y, a.y];
  return { ...part({ id, source, polygon, top, bottom: top.map(y => y - depth), style, derived: true, roofContact, heightSource, baseSourceId }),
    climbableFromGround };
}

export function loftPart(id, source, lower, upper, bottom, top, style, {
  roofContact = false, heightSource = 'estimate', baseSourceId = source.id, uvOriginY = bottom, smoothSides = false,
  topFace = true, bottomFace = true
} = {}) {
  if (lower.length < 3 || upper.length !== lower.length || !(top > bottom)) {
    throw new Error(`Invalid landmark loft: ${id}`);
  }
  // 截面在 x–z 平面为凸多边形，各对应边平行。两环之间用平面连接，碰撞可准确切片。
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    const k = (i + 2) % lower.length;
    const dx = lower[j].x - lower[i].x, dz = lower[j].z - lower[i].z;
    const ex = upper[j].x - upper[i].x, ez = upper[j].z - upper[i].z;
    if (dx * (lower[k].z - lower[j].z) - dz * (lower[k].x - lower[j].x) <= 0
      || dx * ex + dz * ez <= 0 || Math.abs(dx * ez - dz * ex) > Math.hypot(dx, dz) * Math.hypot(ex, ez) * 1e-6) {
      throw new Error(`Non-planar or concave landmark loft: ${id}`);
    }
  }
  const roundRing = ring => ring.map(p => point(Math.fround(p.x), Math.fround(p.z)));
  const rings = { lower: roundRing(lower), upper: roundRing(upper) };
  const polygon = { outer: convexHull([...rings.lower, ...rings.upper]), holes: [] };
  const volume = part({ id, source, polygon, bottom, top, style, derived: true, roofContact, heightSource, baseSourceId });
  return { ...volume, loft: { ...rings, minY: volume.minY, maxY: volume.maxY }, uvOriginY, smoothSides, topFace, bottomFace };
}

export function roofPanelPart(id, source, triangle, depth, style, {
  roofContact = false, heightSource = 'estimate', baseSource, baseSourceId = source.id
} = {}) {
  const depths = Array.isArray(depth) ? depth : [depth, depth, depth];
  if (triangle.length !== 3 || !triangle.every(p => [p.x, p.y, p.z].every(Number.isFinite))
    || depths.length !== 3 || !depths.every(d => Number.isFinite(d) && d > 0)) throw new Error(`Invalid landmark roof panel: ${id}`);
  const vertices = triangle.map((p, i) => ({ x: Math.fround(p.x), top: Math.fround(p.y), bottom: Math.fround(p.y - depths[i]), z: Math.fround(p.z) }));
  const [a, b, c] = vertices;
  const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  if (Math.abs(area) < 1e-5) throw new Error(`Degenerate landmark roof panel: ${id}`);
  if (area < 0) vertices.reverse();
  const outer = vertices.map(p => point(p.x, p.z));
  const top = vertices.map(p => p.top);
  const bottom = vertices.map(p => p.bottom);
  const panel = part({ id, source, polygon: { outer, holes: [] }, bottom, top, style, derived: true, roofContact,
    heightSource, baseSource, baseSourceId });
  return { ...panel, roofPanel: { outer, bottom, top } };
}

export function partCollider(part) {
  const { id, sourceId, polygon, bottom, top, loft, roofPanel, heightSource, baseSource, baseSourceId, layoutSource,
    minX, maxX, minZ, maxZ, minY, maxY } = part;
  const verticalSpan = Array.isArray(top) && !roofPanel ? [bottom[0], bottom[1], top[0], top[1]].map(Math.fround) : null;
  return { type: 'building', name: id, sourceId, polygon, verticalSpan, loft, roofPanel, heightSource, baseSource, baseSourceId, layoutSource,
    minX, maxX, minZ, maxZ, minY, maxY };
}
