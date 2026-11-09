import { polygonContains } from '../building-collision.js';
import { baseAt, blend, footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';

const platformId = 'relation/10837978';
const westWingId = 'relation/10837976';
const eastWingId = 'relation/10837977';
const roundTowerId = 'way/616988599';
const squareTowerId = 'way/616988601';
const westTipId = 'way/783584162';
const eastTipId = 'way/783584159';
const middleRoofId = 'way/783584168';
const roofIds = [
  westTipId, 'way/783584163', 'way/783584164', 'way/783584166', 'relation/8531208',
  middleRoofId, 'way/783584165', 'way/783584161', 'way/783584160', eastTipId
];
const glassIds = [
  westWingId, eastWingId,
  'way/781536965', 'way/781536966', 'way/781536968', 'way/781536969', 'way/781536970', 'way/781536971',
  'way/781536976', 'way/781536977', 'way/781536978', 'way/781536979'
];
const annexIds = ['way/781536981', 'way/781536982', 'way/781536983', 'way/781536984'];

export const sourceIds = [platformId, roundTowerId, squareTowerId, ...roofIds, ...glassIds, ...annexIds];
// 原始 Overture 条目注明来自 OSM，其多边形与父关系重合。
export const optionalSkipIds = ['overture/9b9ca793-5c25-4b18-a954-8762180c50ff'];

const roofGrid = 13;
const maxCanopyRise = 80;
const maxTowerRise = 84.7;
const clamp01 = t => Math.min(1, Math.max(0, t));
const smooth = t => t * t * (3 - 2 * t);
const centerZ = source => (source.minZ + source.maxZ) / 2;
const mixPoint = (a, b, t) => point(blend(a.x, b.x, t), blend(a.z, b.z, t));

function canopyProfile(buildings, base) {
  const middle = buildings.get(middleRoofId);
  const west = buildings.get(westTipId);
  const east = buildings.get(eastTipId);
  const station = (x, z) => {
    const tip = x < middle.cx ? west : east;
    const end = x < middle.cx ? tip.minX : tip.maxX;
    const u = clamp01((x - middle.cx) / (end - middle.cx));
    const zMid = blend(centerZ(middle), centerZ(tip), u);
    return { u, v: Math.min(1, Math.abs(z - zMid) / (63.7 + 14 * u * u)) };
  };
  const sample = (x, z) => {
    const { u, v } = station(x, z);
    const wing = smooth(clamp01(u / 0.7));
    const tip = clamp01((u - 0.7) / 0.3) ** 1.8;
    const eave = blend(68, 33.5, wing) + 14 * tip;
    const camber = (1 - v * v) * blend(maxCanopyRise - 68, 3.6, wing);
    return { y: base + eave + camber, depth: 2.25 + (1 - v * v) * blend(6.75, 1.9, wing) };
  };
  return { sample, station };
}

function clipByZ(ring, z, sign) {
  const clipped = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = sign * (a.z - z), db = sign * (b.z - z);
    if (da >= 0) clipped.push(a);
    if (da * db < 0) clipped.push(point(blend(a.x, b.x, da / (da - db)), z));
  }
  return clipped;
}

function roofTriangles(polygon) {
  // 在源轮廓各折点处分条，交点成对保留天井；横向格网限制曲面离散间距。
  const rings = [polygon.outer, ...polygon.holes];
  const edges = rings.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]));
  const stations = new Set(rings.flat().map(p => p.x));
  const minX = Math.min(...stations), maxX = Math.max(...stations);
  for (let x = Math.ceil(minX / roofGrid) * roofGrid; x < maxX; x += roofGrid) stations.add(x);
  const xs = [...stations].sort((a, b) => a - b);
  const triangles = [];
  const edgeZ = ([a, b], x) => blend(a.z, b.z, (x - a.x) / (b.x - a.x));
  for (let i = 1; i < xs.length; i++) {
    const x0 = xs[i - 1], x1 = xs[i], mid = (x0 + x1) / 2;
    const crossing = edges.filter(([a, b]) => mid > Math.min(a.x, b.x) && mid < Math.max(a.x, b.x))
      .sort((a, b) => edgeZ(a, mid) - edgeZ(b, mid));
    for (let j = 0; j + 1 < crossing.length; j += 2) {
      const near = crossing[j], far = crossing[j + 1];
      const strip = [point(x0, edgeZ(near, x0)), point(x1, edgeZ(near, x1)),
        point(x1, edgeZ(far, x1)), point(x0, edgeZ(far, x0))];
      const first = Math.floor(Math.min(...strip.map(p => p.z)) / roofGrid) * roofGrid;
      const last = Math.max(...strip.map(p => p.z));
      for (let z = first; z < last; z += roofGrid) {
        const cell = clipByZ(clipByZ(strip, z, 1), z + roofGrid, -1);
        for (let k = 1; k + 1 < cell.length; k++) {
          const [a, b, c] = [cell[0], cell[k], cell[k + 1]].map(p => point(Math.fround(p.x), Math.fround(p.z)));
          if (Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) > 1e-5) {
            triangles.push([a, b, c]);
          }
        }
      }
    }
  }
  return triangles;
}

function roofParts(sources, profile) {
  const roofPolygons = sources.flatMap(source => source.polygons);
  const parts = [];
  for (const source of sources) {
    for (const [p, polygon] of source.polygons.entries()) {
      for (const [i, triangle] of roofTriangles(polygon).entries()) {
        const section = triangle.map(vertex => profile.sample(vertex.x, vertex.z));
        parts.push(roofPanelPart(`civic-center:canopy:${source.id}:${p}:${i}`, source,
          triangle.map((vertex, j) => ({ ...vertex, y: section[j].y })), section.map(row => row.depth), 'civicRoofBlue',
          { baseSourceId: platformId }));
      }
      for (const [i, a] of polygon.outer.entries()) {
        const b = polygon.outer[(i + 1) % polygon.outer.length];
        const mid = mixPoint(a, b, 0.5);
        const { u, v } = profile.station(mid.x, mid.z);
        if (v < 0.85 && u < 0.97) continue;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const dx = (b.z - a.z) * 0.6 / length, dz = (a.x - b.x) * 0.6 / length;
        const inside = sign => roofPolygons.some(roof => polygonContains(roof, mid.x + sign * dx, mid.z + sign * dz));
        if (inside(1) === inside(-1)) continue;
        const count = Math.ceil(length / roofGrid);
        for (let j = 0; j < count; j++) {
          const at = t => {
            const position = mixPoint(a, b, t);
            return { ...position, y: profile.sample(position.x, position.z).y - 0.65 };
          };
          parts.push(spanPart(`civic-center:eave:${source.id}:${p}:${i}:${j}`, source,
            at(j / count), at((j + 1) / count), 0.23, 0.23, 0.24, 'civicTrim', { baseSourceId: platformId }));
        }
      }
    }
  }
  return parts;
}

function towerParts(source, terrain, canopyBase, west) {
  const baseY = baseAt(source, terrain) + source.minHeight;
  const min = west ? -source.maxX : source.minX;
  const max = west ? -source.minX : source.maxX;
  const topY = p => canopyBase + maxTowerRise - 16 * clamp01((max - (west ? -p.x : p.x)) / (max - min));
  const style = west ? 'civicTowerYellow' : 'civicTowerRed';
  return source.polygons.flatMap((polygon, p) => {
    const center = point(source.cx, source.cz);
    return polygon.outer.map((vertex, i, ring) => {
      const triangle = [center, vertex, ring[(i + 1) % ring.length]].map(q => ({ ...q, y: topY(q) }));
      return roofPanelPart(`civic-center:tower:${source.id}:${p}:${i}`, source, triangle,
        triangle.map(q => q.y - baseY), style, { baseSourceId: source.id });
    });
  });
}

function treeSupports(wing, terrain, profile, roofPolygons) {
  const parts = [];
  const wingY = baseAt(wing, terrain) + wing.height;
  for (const [i, u] of [0.12, 0.37, 0.63, 0.88].entries()) {
    for (const [j, v] of [0.08, 0.19, 0.72].entries()) {
      const x = blend(wing.minX, wing.maxX, u);
      const z = blend(wing.minZ, wing.maxZ, v);
      if (!wing.polygons.some(polygon => polygonContains(polygon, x, z))) continue;
      const section = profile.sample(x, z);
      const upperY = section.y - section.depth;
      if (upperY - wingY < 2.2) continue;
      const name = `civic-center:tree:${wing.id}:${i}:${j}`;
      const ring = Array.from({ length: 8 }, (_, k) => point(x + 0.53 * Math.cos(k * Math.PI / 4),
        z + 0.53 * Math.sin(k * Math.PI / 4)));
      const jointY = blend(wingY, upperY, 0.53);
      parts.push(loftPart(`${name}:stem`, wing, ring, ring, wingY, jointY, 'civicPillar'));
      for (const [k, [dx, dz]] of [[4.6, 2.8], [-4.6, 2.8], [0, -4.7]].entries()) {
        const a = { x, z, y: jointY };
        const b = { x: x + dx, z: z + dz };
        if (!roofPolygons.some(polygon => polygonContains(polygon, b.x, b.z))) continue;
        const top = profile.sample(b.x, b.z);
        parts.push(spanPart(`${name}:branch:${k}`, wing, a, { ...b, y: top.y - top.depth + 0.15 },
          0.69, 0.53, 0.69, 'civicPillar'));
      }
    }
  }
  return parts;
}

export function build(buildings, terrain) {
  const platform = buildings.get(platformId);
  const base = baseAt(platform, terrain);
  const profile = canopyProfile(buildings, base);
  const roofSources = roofIds.map(id => buildings.get(id));
  const roofPolygons = roofSources.flatMap(source => source.polygons);
  return [
    ...footprintParts(platform, base, 'civicStone', { roofContact: true }),
    ...glassIds.flatMap(id => {
      const source = buildings.get(id);
      return footprintParts(source, baseAt(source, terrain), 'civicGlass');
    }),
    ...annexIds.flatMap(id => {
      const source = buildings.get(id);
      return footprintParts(source, baseAt(source, terrain), 'civicStone');
    }),
    ...towerParts(buildings.get(roundTowerId), terrain, base, true),
    ...towerParts(buildings.get(squareTowerId), terrain, base, false),
    ...roofParts(roofSources, profile),
    ...treeSupports(buildings.get(westWingId), terrain, profile, roofPolygons),
    ...treeSupports(buildings.get(eastWingId), terrain, profile, roofPolygons)
  ];
}
