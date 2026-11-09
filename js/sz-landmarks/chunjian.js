import { baseAt, blend, footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';
import { polygonContains } from '../building-collision.js';

const poolId = 'way/665408866';
const gymId = 'way/665408865';
const concourseId = 'relation/9244351';
const stadiumId = 'relation/9244350';
export const sourceIds = [poolId, gymId, concourseId, stadiumId];

const shellRise = 42.3;
const ribSpacing = 7.4;
const ribWidth = 0.7;
const ribDepth = 0.45;
const clamp01 = t => Math.min(1, Math.max(0, t));
const smooth = t => t * t * (3 - 2 * t);
const cross = (ax, az, bx, bz) => ax * bz - az * bx;
const mixPoint = (a, b, t) => point(blend(a.x, b.x, t), blend(a.z, b.z, t));
const ringEdges = ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);

function ringCenter(ring) {
  return point((Math.min(...ring.map(p => p.x)) + Math.max(...ring.map(p => p.x))) / 2,
    (Math.min(...ring.map(p => p.z)) + Math.max(...ring.map(p => p.z))) / 2);
}

function shellProfile(sources, base) {
  const [pool, gym, concourse, stadium] = sources;
  const edges = sources.flatMap(source => source.polygons.flatMap(polygon => ringEdges(polygon.outer)));
  const field = stadium.polygons[0].holes[0];
  const tree = concourse.polygons[0].holes[0];
  const treeCenter = ringCenter(tree);
  const treeRadius = (Math.max(...tree.map(p => p.x)) - Math.min(...tree.map(p => p.x))) / 2;
  const crown = [
    [pool.minX, 24], [pool.cx, 36.5], [gym.cx, Math.min(gym.height, shellRise)], [treeCenter.x, 35],
    [Math.min(...field.map(p => p.x)) - 13, shellRise], [stadium.cx, 35.5],
    [stadium.maxX - 7, shellRise], [stadium.maxX, shellRise]
  ];
  function section(x) {
    let near = Infinity, far = -Infinity;
    for (const [a, b] of edges) {
      if (x < Math.min(a.x, b.x) - 1e-7 || x > Math.max(a.x, b.x) + 1e-7) continue;
      if (Math.abs(b.x - a.x) < 1e-7) {
        near = Math.min(near, a.z, b.z);
        far = Math.max(far, a.z, b.z);
        continue;
      }
      const z = blend(a.z, b.z, clamp01((x - a.x) / (b.x - a.x)));
      near = Math.min(near, z);
      far = Math.max(far, z);
    }
    return { near, far };
  }
  function sample(x, z) {
    const { near, far } = section(x);
    const middle = (near + far) / 2;
    const v = far > near ? clamp01(Math.abs(z - middle) * 2 / (far - near)) : 1;
    const j = crown.findIndex(([at]) => x <= at);
    const [left, right] = j > 0 ? [crown[j - 1], crown[j]] : j === 0 ? [crown[0], crown[1]] : crown.slice(-2);
    const ridge = blend(left[1], right[1], smooth(clamp01((x - left[0]) / (right[0] - left[0]))));
    const skirt = 4.2 + 12 * Math.exp(-(((x - treeCenter.x) / 49) ** 2));
    const rolled = blend(skirt, ridge, (1 - v * v) ** 0.43);
    const radius = Math.hypot(x - treeCenter.x, z - treeCenter.z);
    // 大树广场的网壳向中央通天孔收至落脚环。
    const funnel = smooth(clamp01((radius - treeRadius) / 32));
    return base + blend(1.8, rolled, funnel);
  }
  return sample;
}

function latticeParts(source, polygon, profile, center) {
  const parts = [];
  const rings = [polygon.outer, ...polygon.holes];
  const factor = Math.SQRT1_2;
  for (const sign of [-1, 1]) {
    const grid = p => {
      const x = p.x - center.x, z = (p.z - center.z) * sign;
      return { along: (x + z) * factor, across: (x - z) * factor };
    };
    const edges = rings.flatMap(ring => ringEdges(ring.map(grid)));
    const positions = polygon.outer.map(grid).map(p => p.across);
    const first = Math.ceil(Math.min(...positions) / ribSpacing);
    const last = Math.floor(Math.max(...positions) / ribSpacing);
    for (let line = first; line <= last; line++) {
      const across = line * ribSpacing;
      const cuts = [];
      for (const [a, b] of edges) {
        if ((a.across > across) === (b.across > across)) continue;
        cuts.push(blend(a.along, b.along, (across - a.across) / (b.across - a.across)));
      }
      cuts.sort((a, b) => a - b);
      const vertex = along => {
        const x = center.x + (along + across) * factor;
        const z = center.z + (along - across) * factor * sign;
        return { x, y: profile(x, z), z };
      };
      for (let i = 1; i < cuts.length; i += 2) {
        const low = cuts[i - 1], high = cuts[i];
        const joints = [low];
        for (let at = (Math.floor(low / ribSpacing) + 1) * ribSpacing; at < high; at += ribSpacing) joints.push(at);
        joints.push(high);
        for (let j = 1; j < joints.length; j++) {
          const a = joints[j - 1], b = joints[j];
          if (b - a < 0.04) continue;
          parts.push(spanPart(`chunjian:rib:${source.id}:${sign}:${line}:${i}:${j}`, source, vertex(a), vertex(b),
            ribWidth, ribWidth, ribDepth, 'stadiumRib', { baseSourceId: stadiumId }));
        }
      }
    }
  }
  return parts;
}

function panel(parts, id, source, corners, height, bottom, style) {
  // 同一个三角棱柱供显示和碰撞使用，斜屋面按每个顶点的真实体段切片。
  const [a, b, c] = corners.map(p => {
    const corner = point(Math.fround(p.x), Math.fround(p.z));
    return { ...corner, y: height(corner) };
  });
  if (Math.abs(cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z)) < 1e-5) return;
  const triangle = [a, b, c];
  parts.push(roofPanelPart(id, source, triangle, triangle.map(p => p.y - bottom(p)), style, { baseSourceId: stadiumId }));
}

function panelBand(parts, id, source, inner, outer, height, bottom, style) {
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    panel(parts, `${id}:${i}:a`, source, [inner[i], outer[i], outer[j]], height, bottom, style);
    panel(parts, `${id}:${i}:b`, source, [inner[i], outer[j], inner[j]], height, bottom, style);
  }
}

function dome(source, base, profile) {
  const west = source.id === poolId;
  const width = source.maxX - source.minX;
  const center = point(source.cx + (west ? width * 0.07 : 0), source.cz);
  const rx = width * (west ? 0.325 : 0.4);
  const rz = (source.maxZ - source.minZ) * 0.4;
  const outer = Array.from({ length: 36 }, (_, i) => {
    const angle = 2 * Math.PI * i / 36;
    return point(center.x + rx * Math.cos(angle), center.z + rz * Math.sin(angle));
  });
  const topOfGlass = Math.min(...outer.map(p => profile(p.x, p.z))) - 1.2;
  const parts = footprintParts({ ...source, polygons: [{ outer, holes: [] }] }, base, 'stadiumGlazing', {
    id: `chunjian:hull:${source.id}`, max: topOfGlass - base, derived: true, baseSourceId: stadiumId
  });
  let inner = outer.map(() => center);
  for (const [i, t] of [0.24, 0.49, 0.74, 1].entries()) {
    const ring = outer.map(p => mixPoint(center, p, t));
    panelBand(parts, `chunjian:dome:${source.id}:${i}`, source, inner, ring,
      p => profile(p.x, p.z), () => topOfGlass, 'stadiumRoof');
    inner = ring;
  }
  return { parts, outer };
}

function outerRay(center, inside, outsideEdges) {
  const dx = inside.x - center.x, dz = inside.z - center.z;
  let exit = Infinity;
  for (const [a, b] of outsideEdges) {
    const ex = b.x - a.x, ez = b.z - a.z;
    const determinant = cross(dx, dz, ex, ez);
    if (Math.abs(determinant) < 1e-6) continue;
    const tx = a.x - center.x, tz = a.z - center.z;
    const radial = cross(tx, tz, ex, ez) / determinant;
    const edge = cross(tx, tz, dx, dz) / determinant;
    if (radial >= 1 && edge >= -1e-7 && edge <= 1 + 1e-7) exit = Math.min(exit, radial);
  }
  if (!Number.isFinite(exit)) throw new Error('Missing stadium roof ring exit');
  return point(center.x + exit * dx, center.z + exit * dz);
}

function fieldRoof(source, profile) {
  const polygon = source.polygons[0];
  const field = polygon.holes[0];
  const center = ringCenter(field);
  const perimeter = ringEdges(polygon.outer);
  const rayEnds = field.map(p => outerRay(center, p, perimeter));
  const parts = [];
  let inner = field;
  for (const [i, t] of [0.14, 0.28, 0.43].entries()) {
    const outer = field.map((p, j) => mixPoint(p, rayEnds[j], t));
    const top = p => profile(p.x, p.z);
    panelBand(parts, `chunjian:stadium-roof:${i}`, source, inner, outer, top, p => top(p) - 0.7, 'stadiumRoof');
    inner = outer;
  }
  return { parts, outer: inner };
}

function seatingBowl(source, base) {
  const field = source.polygons[0].holes[0];
  const center = ringCenter(field);
  const eastRadius = Math.max(...field.map(p => p.x)) - center.x;
  const parts = [];
  let outer = field;
  for (const [row, t] of [0.08, 0.16, 0.24, 0.32].entries()) {
    const inner = field.map(p => mixPoint(p, center, t));
    for (let i = 0; i < field.length; i++) {
      const j = (i + 1) % field.length;
      const mid = mixPoint(field[i], field[j], 0.5);
      // 海之门东段不设满圈看台，主要看台沿西侧抬升。
      if (mid.x > center.x + eastRadius * 0.72 && Math.abs(mid.z - center.z) < 51.5) continue;
      const west = clamp01((center.x + eastRadius - mid.x) / (2 * eastRadius));
      const y = base + (8 + 13 * west) * (1 - row * 0.21);
      const id = `chunjian:seats:${row}:${i}`;
      panel(parts, `${id}:a`, source, [inner[i], outer[i], outer[j]], () => y, () => base, 'stadiumSeats');
      panel(parts, `${id}:b`, source, [inner[i], outer[j], inner[j]], () => y, () => base, 'stadiumSeats');
    }
    outer = inner;
  }
  return parts;
}

function seaGate(source, base, profile) {
  const center = ringCenter(source.polygons[0].holes[0]);
  const parts = [];
  const options = { baseSourceId: stadiumId };
  const count = 14;
  const x = source.maxX - 5.8;
  const node = i => {
    const t = i / count;
    const z = center.z + (t - 0.5) * 108;
    const topY = profile(x, z);
    const y = Math.min(base + 25.4 + 5 * Math.sin(Math.PI * t), topY - 11.2);
    return { deck: { x, y, z }, truss: { x, y: topY, z } };
  };
  for (let i = 0; i < count; i++) {
    const a = node(i), b = node(i + 1);
    const mid = { ...mixPoint(a.deck, b.deck, 0.5), y: blend(a.deck.y, b.deck.y, 0.5) };
    parts.push(spanPart(`chunjian:sea-gate-deck:${i}`, source, a.deck, b.deck, 5.2, 5.2, 0.9, 'stadiumDeck',
      { ...options, roofContact: true }));
    parts.push(spanPart(`chunjian:sea-gate-chord:${i}`, source, a.truss, b.truss, 3.4, 3.4, 0.85, 'stadiumRib', options));
    for (const [j, end] of [a.truss, b.truss].entries()) {
      parts.push(spanPart(`chunjian:sea-gate-web:${i}:${j}`, source, mid, end, 0.56, 0.56, 0.68, 'stadiumRib', options));
    }
  }
  for (const i of [0, count]) {
    const { deck, truss } = node(i);
    const ring = [point(x - 2.8, deck.z - 2.5), point(x + 2.8, deck.z - 2.5),
      point(x + 2.8, deck.z + 2.5), point(x - 2.8, deck.z + 2.5)];
    parts.push(loftPart(`chunjian:sea-gate-pier:${i}`, source, ring, ring, base, truss.y, 'stadiumDeck', options));
  }
  return parts;
}

function perimeterRibs(sources, profile) {
  const polygons = sources.map(source => source.polygons[0]);
  const parts = [];
  for (const [s, source] of sources.entries()) {
    for (const [i, [a, b]] of ringEdges(polygons[s].outer).entries()) {
      const middle = mixPoint(a, b, 0.5);
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.z - a.z) * 0.65 / length, dz = (a.x - b.x) * 0.65 / length;
      const inside = sign => polygons.some(polygon => polygonContains(polygon, middle.x + sign * dx, middle.z + sign * dz));
      if (inside(1) === inside(-1)) continue;
      const count = Math.ceil(length / ribSpacing);
      const at = j => {
        const p = mixPoint(a, b, j / count);
        return { ...p, y: profile(p.x, p.z) };
      };
      for (let j = 0; j < count; j++) {
        parts.push(spanPart(`chunjian:eave:${source.id}:${i}:${j}`, source, at(j), at(j + 1),
          1.0, 1.0, 0.7, 'stadiumRib', { baseSourceId: stadiumId }));
      }
    }
  }
  return parts;
}

export function build(buildings, terrain) {
  const sources = sourceIds.map(id => buildings.get(id));
  // 缺少场心或广场的内环时保留现有通用建筑，以免替换成封死的外壳。
  if (!sources.every((source, i) => source?.polygons.length === 1 && source.polygons[0].holes.length === (i < 2 ? 0 : 1))) {
    return [];
  }
  const [pool, gym, concourse, stadium] = sources;
  // 体育场包围盒中心位于露天内场，避免用两座室内馆屋顶的 DSM 回波当作基础标高。
  const base = baseAt(stadium, terrain);
  const fieldCenter = ringCenter(stadium.polygons[0].holes[0]);
  const profile = shellProfile(sources, base);
  const poolDome = dome(pool, base, profile);
  const gymDome = dome(gym, base, profile);
  const stadiumRoof = fieldRoof(stadium, profile);
  const lattice = [
    { ...pool.polygons[0], holes: [poolDome.outer] },
    { ...gym.polygons[0], holes: [gymDome.outer] },
    concourse.polygons[0],
    { ...stadium.polygons[0], holes: [stadiumRoof.outer] }
  ];
  return [
    ...sources.flatMap((source, i) => latticeParts(source, lattice[i], profile, fieldCenter)),
    ...perimeterRibs(sources, profile),
    ...poolDome.parts, ...gymDome.parts, ...stadiumRoof.parts,
    ...seatingBowl(stadium, base), ...seaGate(stadium, base, profile)
  ];
}
