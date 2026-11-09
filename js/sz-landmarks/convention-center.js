import { blend, footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';
import { terrainHeight } from '../sz-terrain.js';

const exhibitionId = 'way/146862823';
const congressId = 'way/780197214';
const westEntryId = 'way/781193993';
const eastEntryId = 'way/781193995';
export const sourceIds = [exhibitionId, congressId, westEntryId, eastEntryId];

const concourseLevel = 7.5;
const spineHalfWidth = 22.5;
const hallEave = 13;
const roofBay = 30;
const glazingBand = [6.4, 13.8];
const clamp01 = t => Math.min(1, Math.max(0, t));
const ringEdges = ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);
const rectangle = (x0, x1, z0, z1) => [point(x0, z0), point(x1, z0), point(x1, z1), point(x0, z1)];

function localFrame(exhibition, congress) {
  const axis = ringEdges(congress.polygons[0].outer).map(([a, b]) => {
    const sign = b.x < a.x ? -1 : 1;
    const x = (b.x - a.x) * sign, z = (b.z - a.z) * sign;
    return { x, z, length: Math.hypot(x, z) };
  }).sort((a, b) => b.length - a.length)[0];
  const ex = axis.x / axis.length, ez = axis.z / axis.length;
  const local = p => {
    const x = p.x - exhibition.cx, z = p.z - exhibition.cz;
    return point(x * ex + z * ez, z * ex - x * ez);
  };
  const world = (x, z) => point(exhibition.cx + x * ex - z * ez, exhibition.cz + x * ez + z * ex);
  return { local, world };
}

function bounds(ring) {
  return { minX: Math.min(...ring.map(p => p.x)), maxX: Math.max(...ring.map(p => p.x)),
    minZ: Math.min(...ring.map(p => p.z)), maxZ: Math.max(...ring.map(p => p.z)) };
}

function clip(ring, key, at, sign) {
  const result = [];
  for (const [a, b] of ringEdges(ring)) {
    const da = (a[key] - at) * sign, db = (b[key] - at) * sign;
    if (da >= 0) result.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      result.push(key === 'x' ? point(at, blend(a.z, b.z, t)) : point(blend(a.x, b.x, t), at));
    }
  }
  return result;
}

function cut(ring, x0, x1, z0, z1) {
  return clip(clip(clip(clip(ring, 'x', x0, 1), 'x', x1, -1), 'z', z0, 1), 'z', z1, -1);
}

function solid(id, source, frame, ring, base, min, max, style, options = {}) {
  if (ring.length < 3) return [];
  return footprintParts({ ...source, polygons: [{ outer: ring.map(p => frame.world(p.x, p.z)), holes: [] }] },
    base, style, { id, min, max, derived: true, baseSourceId: exhibitionId, ...options });
}

function roofPatch(id, source, frame, ring, height, depth, style) {
  const parts = [];
  for (let i = 1; i + 1 < ring.length; i++) {
    const corners = [ring[0], ring[i], ring[i + 1]].map(p => {
      const { x, z } = frame.world(p.x, p.z);
      return { x: Math.fround(x), y: height(p), z: Math.fround(z) };
    });
    const [a, b, c] = corners;
    if (Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) < 1e-5) continue;
    parts.push(roofPanelPart(`${id}:${i}`, source, corners, typeof depth === 'function' ? corners.map(depth) : depth,
      style, { baseSourceId: exhibitionId }));
  }
  return parts;
}

function panelledRoof(id, source, frame, ring, height, depth, glazing = false) {
  if (ring.length < 3) return [];
  const { minX, maxX, minZ, maxZ } = bounds(ring);
  const columns = Math.ceil((maxX - minX) / 15);
  const rows = Math.ceil((maxZ - minZ) / 11);
  const xs = new Set(ring.map(p => p.x));
  if (glazing) {
    // 采光带随弧面连续跨向展开，位置按 30 米钢肋节奏和设计方照片近似。
    for (let x = Math.floor(minX / roofBay) * roofBay; x < maxX; x += roofBay) {
      for (const offset of glazingBand) if (x + offset > minX && x + offset < maxX) xs.add(x + offset);
    }
  } else {
    for (let i = 0; i <= columns; i++) xs.add(blend(minX, maxX, i / columns));
  }
  const stations = [...xs].sort((a, b) => a - b);
  const edges = ringEdges(ring);
  const sectionZ = ([a, b], x) => blend(a.z, b.z, (x - a.x) / (b.x - a.x));
  const parts = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i], middle = (a + b) / 2;
    if (b - a < 1e-5) continue;
    const bay = middle - Math.floor(middle / roofBay) * roofBay;
    const style = glazing && bay > glazingBand[0] && bay < glazingBand[1] ? 'conventionSkylight' : 'conventionRoof';
    const hits = edges.filter(([p, q]) => middle > Math.min(p.x, q.x) && middle < Math.max(p.x, q.x))
      .sort((p, q) => sectionZ(p, middle) - sectionZ(q, middle));
    for (let k = 1; k < hits.length; k += 2) {
      const near = hits[k - 1], far = hits[k];
      const strip = [point(a, sectionZ(near, a)), point(b, sectionZ(near, b)),
        point(b, sectionZ(far, b)), point(a, sectionZ(far, a))];
      for (let j = 0; j < rows; j++) {
        const z0 = blend(minZ, maxZ, j / rows), z1 = blend(minZ, maxZ, (j + 1) / rows);
        const cell = clip(clip(strip, 'z', z0, 1), 'z', z1, -1);
        parts.push(...roofPatch(`${id}:${i}:${k}:${j}`, source, frame, cell, height, depth, style));
      }
    }
  }
  return parts;
}

function skirtFaces(id, source, frame, ring, base, lower, profile) {
  const parts = [];
  // 贴外边缘加实体玻璃围护，屋顶的跨间净空由薄屋面和墙体分别表达。
  for (const [i, [a, b]] of ringEdges(ring).entries()) {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 0.05) continue;
    const nx = (b.z - a.z) * 0.3 / length, nz = (a.x - b.x) * 0.3 / length;
    const count = Math.ceil(length / 14);
    for (let j = 0; j < count; j++) {
      const x0 = blend(a.x, b.x, j / count), z0 = blend(a.z, b.z, j / count);
      const x1 = blend(a.x, b.x, (j + 1) / count), z1 = blend(a.z, b.z, (j + 1) / count);
      const wall = [point(x0 - nx, z0 - nz), point(x1 - nx, z1 - nz),
        point(x1 + nx, z1 + nz), point(x0 + nx, z0 + nz)];
      parts.push(...roofPatch(`${id}:wall:${i}:${j}`, source, frame, wall,
        p => Math.max(base + lower + 0.08, profile(p) - 0.32), p => p.y - (base + lower), 'conventionGlass'));
    }
  }
  return parts;
}

function roofRibs(id, source, frame, ring, outer, inner, profile) {
  const { minX, maxX, minZ, maxZ } = bounds(ring);
  const parts = [];
  const at = (x, z, offset = 0) => ({ ...frame.world(x, z), y: profile(point(x, z)) + offset });
  const start = Math.ceil((minX + 0.75) / 30) * 30;
  for (let x = start; x < maxX - 0.75; x += 30) {
    const z0 = outer < inner ? minZ + 0.8 : maxZ - 0.8;
    const z1 = outer < inner ? maxZ - 0.8 : minZ + 0.8;
    for (const dx of [-0.48, 0.48]) {
      const xx = x + dx;
      const n = 10;
      for (let i = 0; i < n; i++) {
        const a = at(xx, blend(z0, z1, i / n), 0.16);
        const b = at(xx, blend(z0, z1, (i + 1) / n), 0.16);
        parts.push(spanPart(`${id}:rib:${x}:${dx}:${i}`, source, a, b, 0.54, 0.54, 0.38,
          'conventionRib', { baseSourceId: exhibitionId }));
      }
      const eave = at(xx, z0, 0.11);
      const footZ = z0 + Math.sign(z1 - z0) * 2.1;
      const foot = { ...frame.world(xx, footZ), y: profile(point(xx, outer)) - hallEave + 0.6 };
      parts.push(spanPart(`${id}:leg:${x}:${dx}`, source, eave, foot, 0.74, 1.02, 0.72,
        'conventionRib', { baseSourceId: exhibitionId }));
    }
  }
  return parts;
}

function exhibitionHall(source, frame, outline, base, number, x0, x1, z0, z1, outer, inner) {
  const ring = cut(outline, x0, x1, z0, z1);
  if (ring.length < 3) return [];
  const id = `convention-center:hall:${number}`;
  const profile = p => {
    const span = clamp01((p.z - outer) / (inner - outer));
    return base + blend(hallEave, source.height, Math.sin(span * Math.PI / 2));
  };
  return [
    ...solid(id, source, frame, ring, base, 0, hallEave - 0.5, 'conventionHall'),
    ...panelledRoof(`${id}:cover`, source, frame, ring, profile, 0.58, true),
    ...skirtFaces(id, source, frame, ring, base, hallEave - 0.5, profile),
    ...roofRibs(id, source, frame, ring, outer, inner, profile)
  ];
}

function congressVolume(source, frame, base) {
  const ring = source.polygons[0].outer.map(frame.local);
  const winding = ringEdges(ring).reduce((area, [a, b]) => area + a.x * b.z - b.x * a.z, 0);
  if (winding < 0) ring.reverse();
  const { minX, maxX, minZ, maxZ } = bounds(ring);
  const midZ = (minZ + maxZ) / 2;
  const roof = p => base + source.height - 2.8 * ((p.z - midZ) / ((maxZ - minZ) / 2)) ** 2;
  const slabBottom = ring.map(p => frame.world(blend(p.x, (minX + maxX) / 2, 0.04), blend(p.z, midZ, 0.04)));
  const deck = loftPart('convention-center:congress-deck', source, slabBottom, ring.map(p => frame.world(p.x, p.z)),
    base + 42.8, base + 45, 'conventionStone', { baseSourceId: exhibitionId });
  const parts = [
    deck, ...solid('convention-center:congress-glass', source, frame, ring, base, 45, source.height - 3, 'conventionGlass'),
    ...panelledRoof('convention-center:congress-roof', source, frame, ring, roof, p => p.y - (base + source.height - 3))
  ];
  for (let x = minX + 14; x <= maxX - 10; x += 30) {
    for (const sign of [-1, 1]) {
      const z = midZ + sign * 14.6;
      parts.push(...solid(`convention-center:congress-support:${x}:${sign}`, source, frame,
        rectangle(x - 1.9, x + 1.9, z - 1.7, z + 1.7), base, 0, 43.1, 'conventionStone'));
      const fascia = { ...frame.world(x, midZ + sign * 28.4), y: base + 46.3 };
      const anchor = { ...frame.world(x, z), y: base + 39.3 };
      parts.push(spanPart(`convention-center:congress-knee:${x}:${sign}`, source, anchor, fascia, 2.9, 1.2, 1.0,
        'conventionRib', { baseSourceId: exhibitionId }));
    }
  }
  return parts;
}

function entryParts(source, frame, base, opening, northSpine) {
  const parts = [];
  const x = (opening.minX + opening.maxX) / 2;
  const back = opening.maxZ;
  const stairsWidth = (opening.maxX - opening.minX) * 0.43;
  const top = (id, z0, z1, y, depth) => solid(id, source, frame,
    rectangle(x - stairsWidth / 2, x + stairsWidth / 2, z0, z1), base,
    y - depth, y, 'conventionStone', { roofContact: true });
  // 运营方二层图给出 +7.5m 和三段阶梯，踏步与平台宽深为图面比例估计。
  const north = back - 45;
  const count = 42;
  for (let i = 0; i < count; i++) {
    const flight = Math.floor(i / 14);
    const z = north + i * 0.64 + flight * 4.6;
    const y = concourseLevel * (i + 1) / count;
    const length = 0.64 + (i % 14 === 13 ? 4.6 : 0);
    parts.push(...top(`convention-center:north-step:${i}`, z, z + length, y, y));
  }
  parts.push(...top('convention-center:north-landing', north + count * 0.64 + 13.8, back + 4, concourseLevel, 0.9));
  parts.push(...solid('convention-center:north-entry-hall', source, frame,
    rectangle(opening.minX, opening.maxX, back + 3.8, northSpine), base,
    concourseLevel, 30.4, 'conventionGlass'));
  return parts;
}

export function build(buildings, terrain) {
  const [exhibition, congress, westEntry, eastEntry] = sourceIds.map(id => buildings.get(id));
  if (![exhibition, congress, westEntry, eastEntry].every(source => source?.polygons.length === 1)
    || congress.polygons[0].outer.length !== 4) return [];
  const frame = localFrame(exhibition, congress);
  const outline = exhibition.polygons[0].outer.map(frame.local);
  const main = bounds(outline);
  const upper = bounds(congress.polygons[0].outer.map(frame.local));
  const middle = (upper.minZ + upper.maxZ) / 2;
  const north = middle - spineHalfWidth, south = middle + spineHalfWidth;
  const width = main.maxX - main.minX;
  const openingVertices = outline.filter(p => Math.abs(p.x) < width * 0.16 && p.z > main.minZ + 45 && p.z < north - 15);
  if (openingVertices.length < 2) return [];
  const opening = bounds(openingVertices);
  // 用北广场外露中轴点采样 DSM，两个建筑轮廓中心落在屋盖回波上。
  const anchor = frame.world((opening.minX + opening.maxX) / 2, main.minZ + 13);
  const base = terrainHeight(terrain, anchor.x, anchor.z);
  if (base === null) return [];
  const station = m => main.minX + width * m / 540;
  const westA = station(120), westB = station(150), eastA = station(390), eastB = station(420);
  const northHalls = [[3, main.minX, station(60)], [4, station(60), westA],
    [5, westB, opening.minX], [6, opening.maxX, eastA], [7, eastB, station(480)], [8, station(480), main.maxX]];
  const southHalls = [[2, main.minX, westA], [1, westB, eastA], [9, eastB, main.maxX]];
  const parts = [
    ...northHalls.flatMap(([n, x0, x1]) => exhibitionHall(exhibition, frame, outline, base,
      n, x0, x1, main.minZ, north, main.minZ, north)),
    ...southHalls.flatMap(([n, x0, x1]) => exhibitionHall(exhibition, frame, outline, base,
      n, x0, x1, south, main.maxZ, main.maxZ, south)),
    ...entryParts(exhibition, frame, base, opening, north),
    ...congressVolume(congress, frame, base)
  ];
  for (const [i, [x0, x1]] of [[main.minX, westA], [westB, eastA], [eastB, main.maxX]].entries()) {
    parts.push(...solid(`convention-center:spine:${i}`, exhibition, frame,
      cut(outline, x0, x1, north, south), base, 0, exhibition.height - 0.8, 'conventionGlass'));
  }
  for (const [i, [x0, x1]] of [[westA, westB], [eastA, eastB]].entries()) {
    // 横向公共廊在首层消防通道上架空，保持上下两个空间层次。
    const ring = rectangle(x0, x1, north, south);
    parts.push(...solid(`convention-center:lane-bridge:${i}`, exhibition, frame, ring, base,
      concourseLevel - 0.85, concourseLevel + 5, 'conventionGlass'));
  }
  for (const entry of [westEntry, eastEntry]) {
    parts.push(...footprintParts(entry, base, 'conventionGlass', {
      id: `convention-center:side-entry:${entry.id}`, min: concourseLevel, max: 13.3, derived: true, baseSourceId: exhibitionId
    }));
  }
  return parts.map(part => ({ ...part, baseSource: 'dem-north-plaza-sample', baseSample: anchor }));
}
