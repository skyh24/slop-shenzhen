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

// 屋面细部尺寸除注明外都是照片/图纸判读的外形估计（EST），不当作实测值。
// 公开依据：大屋盖由网架和上封板组成、底侧封板约 6 万块平面单元板拼装（百度百科）；
// 上封板全部钢结构、最厚板 60 mm、结构最大跨度 64 m（中建二局承建者回顾）；
// 方塔轴线柱网 9 m、东西两组建筑物各自伸出 17 组树状支撑（《大鹏展翅》结构设计简介）。
// 单元板缝约 1 m 级，本模型按预算只表达结构肋和通长檐口，不表达全部板缝。
export const roofDetail = {
  longitudinalV: [0, -0.42, 0.42, -0.78, 0.78],
  ribWidth: 1.1,
  ribDepth: 0.6,
  ribLift: 0.06,
  transverseSpacing: 27,
  crossWidth: 0.9,
  crossDepth: 0.55,
  eaveWidth: 0.8,
  eaveDepth: 1.3,
  eaveDrop: 0.04
};

export const colonnadeSpec = {
  groupsPerWing: 17,
  rowFraction: 0.1,
  inset: 8,
  minClearance: 2.5,
  contact: 0.1,
  stemRadius: 0.6,
  branchOffsets: [[4.6, 2.8], [-4.6, 2.8], [0, -4.7]]
};

function canopyProfile(buildings, base) {
  const middle = buildings.get(middleRoofId);
  const west = buildings.get(westTipId);
  const east = buildings.get(eastTipId);
  // 长轴剖面：端部取翼端 minX/maxX，横向半宽随 u 增大，z 中线在翼端略作偏移。
  const axis = x => {
    const tip = x < middle.cx ? west : east;
    const end = x < middle.cx ? tip.minX : tip.maxX;
    const u = clamp01((x - middle.cx) / (end - middle.cx));
    return { u, zMid: blend(centerZ(middle), centerZ(tip), u), width: 63.7 + 14 * u * u };
  };
  const station = (x, z) => {
    const { u, zMid, width } = axis(x);
    return { u, v: Math.min(1, Math.abs(z - zMid) / width) };
  };
  const sample = (x, z) => {
    const { u, v } = station(x, z);
    const wing = smooth(clamp01(u / 0.7));
    const tip = clamp01((u - 0.7) / 0.3) ** 1.8;
    const eave = blend(68, 33.5, wing) + 14 * tip;
    const camber = (1 - v * v) * blend(maxCanopyRise - 68, 3.6, wing);
    return { y: base + eave + camber, depth: 2.25 + (1 - v * v) * blend(6.75, 1.9, wing) };
  };
  return { sample, station, axis };
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

// 屋盖顶/底高度查询：与渲染用的三角面完全同源，肋和柱顶都按这片面取高，避免另建代理面。
function surfaceAt(triangles, x, z) {
  for (const triangle of triangles) {
    if (x < triangle.minX || x > triangle.maxX || z < triangle.minZ || z > triangle.maxZ) continue;
    const [a, b, c] = triangle.points;
    const determinant = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(determinant) < 1e-10) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / determinant;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / determinant;
    const w = 1 - u - v;
    if (Math.min(u, v, w) < -1e-7) continue;
    return { top: u * a.y + v * b.y + w * c.y, bottom: u * a.bottom + v * b.bottom + w * c.bottom };
  }
  return null;
}

function roofParts(sources, profile) {
  const roofPolygons = sources.flatMap(source => source.polygons);
  const parts = [];
  const triangles = [];
  for (const source of sources) {
    for (const [p, polygon] of source.polygons.entries()) {
      for (const [i, triangle] of roofTriangles(polygon).entries()) {
        const section = triangle.map(vertex => profile.sample(vertex.x, vertex.z));
        const points = triangle.map((vertex, j) => ({ ...vertex, y: section[j].y }));
        parts.push(roofPanelPart(`civic-center:canopy:${source.id}:${p}:${i}`, source, points,
          section.map(row => row.depth), 'civicRoofBlue', { baseSourceId: platformId }));
        triangles.push({
          points: points.map((vertex, j) => ({ ...vertex, bottom: section[j].y - section[j].depth })),
          minX: Math.min(...points.map(vertex => vertex.x)), maxX: Math.max(...points.map(vertex => vertex.x)),
          minZ: Math.min(...points.map(vertex => vertex.z)), maxZ: Math.max(...points.map(vertex => vertex.z))
        });
      }
      // 通长檐口/收边：屋盖外轮廓和四处采光开口的边都压一道收边板，顶面略低于屋面。
      for (const [i, a] of polygon.outer.entries()) {
        const b = polygon.outer[(i + 1) % polygon.outer.length];
        const mid = mixPoint(a, b, 0.5);
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const dx = (b.z - a.z) * 0.6 / length, dz = (a.x - b.x) * 0.6 / length;
        const inside = sign => roofPolygons.some(roof => polygonContains(roof, mid.x + sign * dx, mid.z + sign * dz));
        if (inside(1) === inside(-1)) continue;
        const count = Math.ceil(length / roofGrid);
        for (let j = 0; j < count; j++) {
          const at = t => {
            const position = mixPoint(a, b, t);
            return { ...position, y: profile.sample(position.x, position.z).y - roofDetail.eaveDrop };
          };
          parts.push(spanPart(`civic-center:eave:${source.id}:${p}:${i}:${j}`, source,
            at(j / count), at((j + 1) / count), roofDetail.eaveWidth, roofDetail.eaveWidth,
            roofDetail.eaveDepth, 'civicTrim', { baseSourceId: platformId }));
        }
      }
    }
  }
  return { parts, triangles };
}

// 屋面结构肋：纵肋沿等 v 线通长，横肋沿长轴按结构柱网尺度分格。
// 肋顶只比屋面高 6 cm，屋盖最高点仍由曲面决定；端点按渲染曲面取高，肋贴着三角面走。
function roofRibs(source, profile, triangles) {
  const xs = triangles.flatMap(triangle => triangle.points.map(vertex => vertex.x));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const parts = [];
  const along = (from, to) => [0, 0.25, 0.5, 0.75, 1]
    .map(t => surfaceAt(triangles, blend(from.x, to.x, t), blend(from.z, to.z, t)));
  const rib = (id, from, to, width, depth) => {
    const hits = along(from, to);
    if (hits.some(hit => !hit)) return;
    const a = { ...from, y: hits[0].top + roofDetail.ribLift };
    const b = { ...to, y: hits[hits.length - 1].top + roofDetail.ribLift };
    parts.push(spanPart(id, source, a, b, width, width, depth, 'civicTrim', { baseSourceId: source.id }));
  };
  for (const v of roofDetail.longitudinalV) {
    for (let x0 = Math.ceil(minX / roofGrid) * roofGrid; x0 + roofGrid <= maxX; x0 += roofGrid) {
      const x1 = x0 + roofGrid;
      const axis0 = profile.axis(x0), axis1 = profile.axis(x1);
      rib(`civic-center:rib:long:${v}:${x0}`,
        point(x0, axis0.zMid + v * axis0.width), point(x1, axis1.zMid + v * axis1.width),
        roofDetail.ribWidth, roofDetail.ribDepth);
    }
  }
  for (let x = Math.ceil(minX / roofDetail.transverseSpacing) * roofDetail.transverseSpacing;
    x < maxX; x += roofDetail.transverseSpacing) {
    const { zMid, width } = profile.axis(x);
    const steps = Math.max(1, Math.ceil((2 * width) / roofGrid));
    for (let i = 0; i < steps; i++) {
      rib(`civic-center:rib:cross:${x}:${i}`,
        point(x, zMid + (-1 + (2 * i) / steps) * width),
        point(x, zMid + (-1 + (2 * (i + 1)) / steps) * width),
        roofDetail.crossWidth, roofDetail.crossDepth);
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

// 屋面支承柱廊：沿每翼北侧屋面一线立 17 组白色树状柱（公开数量），柱顶接到屋盖下皮。
// 柱位按实景判读布置在翼楼屋面之上、屋盖轮廓之下，断面与分枝为估计；中跨不设柱。
function colonnadeSupports(wing, terrain, profile, triangles) {
  const wingY = baseAt(wing, terrain) + wing.height;
  const inWing = (x, z) => wing.polygons.some(polygon => polygonContains(polygon, x, z));
  const underside = (x, z) => surfaceAt(triangles, x, z)?.bottom ?? null;
  const parts = [];
  const rowZ = blend(wing.minZ, wing.maxZ, colonnadeSpec.rowFraction);
  const count = colonnadeSpec.groupsPerWing;
  for (let k = 0; k < count; k++) {
    const x = blend(wing.minX + colonnadeSpec.inset, wing.maxX - colonnadeSpec.inset, k / (count - 1));
    if (!inWing(x, rowZ)) continue;
    const trunkTop = underside(x, rowZ);
    if (trunkTop === null || trunkTop - wingY < colonnadeSpec.minClearance) continue;
    const targets = colonnadeSpec.branchOffsets.map(([dx, dz], b) => {
      const bx = x + dx, bz = rowZ + dz;
      const bottom = underside(bx, bz);
      return bottom === null ? null : { x: bx, z: bz, y: bottom + colonnadeSpec.contact, b };
    }).filter(Boolean);
    if (targets.length < 2) continue;
    const jointY = wingY + (Math.min(...targets.map(target => target.y)) - wingY) * 0.5;
    const name = `civic-center:colonnade:${wing.id}:${k}`;
    const ring = radius => Array.from({ length: 8 }, (_, i) => point(
      x + radius * Math.cos(i * Math.PI / 4), rowZ + radius * Math.sin(i * Math.PI / 4)));
    parts.push(loftPart(`${name}:stem`, wing, ring(colonnadeSpec.stemRadius),
      ring(colonnadeSpec.stemRadius * 0.75), wingY, jointY, 'civicPillar', { baseSourceId: wing.id }));
    for (const target of targets) {
      parts.push(spanPart(`${name}:branch:${target.b}`, wing, { x, z: rowZ, y: jointY },
        target, 0.66, 0.5, 0.66, 'civicPillar', { baseSourceId: wing.id }));
    }
  }
  return parts;
}

export function build(buildings, terrain) {
  const platform = buildings.get(platformId);
  const base = baseAt(platform, terrain);
  const profile = canopyProfile(buildings, base);
  const roofSources = roofIds.map(id => buildings.get(id));
  const { parts: canopyParts, triangles } = roofParts(roofSources, profile);
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
    ...canopyParts,
    ...roofRibs(buildings.get(middleRoofId), profile, triangles),
    ...colonnadeSupports(buildings.get(westWingId), terrain, profile, triangles),
    ...colonnadeSupports(buildings.get(eastWingId), terrain, profile, triangles)
  ];
}
