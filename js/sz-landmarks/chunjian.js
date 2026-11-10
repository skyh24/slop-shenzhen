import { baseAt, blend, footprintParts, loftPart, point, roofPanelPart, spanPart } from './parts.js';
import { polygonContains } from '../building-collision.js';
import { terrainHeight } from '../sz-terrain.js';

const poolId = 'way/665408866';
const gymId = 'way/665408865';
const concourseId = 'relation/9244351';
const stadiumId = 'relation/9244350';
export const sourceIds = [poolId, gymId, concourseId, stadiumId];
const siteId = 'way/542049855';

const shellRise = 42.3;
const ribSpacing = 7.4;
const ribWidth = 0.7;
const ribDepth = 0.45;
// 实腹壳面：公开资料记屋面为上层装饰铝板、中间铝板与玻璃防水层、吊顶铝板三层，
// 分格 4 m 级。这里用 10 m 三角面近似（与肋同数量级），面层低于肋顶 0.55 m，肋仍凸出成白色格线。
const panelGrid = 12;
const panelDrop = 0.55;
const panelDepth = 0.5;
// 地面 DSM 的屋面回波高于面层处不补面，否则地面会从壳面里穿出来。
const panelGroundMargin = 0.15;
// 看台：公开座位 19,930（2F 14,023 + 4F 5,907），三面环抱、东面是海之门开口；
// 座位排级在 2F/4F 两层基础上简化为 9 级台阶，层面尺寸为外观估计。
const standTiers = 9;
const standStart = 0.05;
const standEnd = 0.62;
const standBaseLift = 0.8;
const standRise = 1.0;
const standAisles = 5;
const standTreeColumns = 8;
const standGallery = 0.72; // 海之门一侧无看台的方向判据，沿用成交付版本的东侧开口范围
const standGalleryHalfZ = 51.5;
// 广场和绿化：沿四栋源建筑外廓向外三道环带，贴现有 DSM 地面；园区西、南、东侧地面低，
// 北侧和两馆之间是屋面回波（约 base+10~42），不铺装也不种草。
const apronWidth = 16;
const lawnWidth = 16;
const promenadeWidth = 12;
const plazaCell = 12;
const pavingLift = 0.3;
const lawnLift = 0.3;
const plazaGroundMax = 12;
const plazaGroundMin = -1.5;
const plazaSlopeMax = 2.2;
// 面层比 DSM 地面高 0.30 米：低于控制器 0.38 米的跨步上限，人能直接走上去；
// 只有面层在格子内与真实 DSM 三角面高差 ≤0.24 米的格子才铺，保证地面不会被面层穿出。
const plazaDeviationMax = 0.24;
const clamp01 = t => Math.min(1, Math.max(0, t));
const smooth = t => t * t * (3 - 2 * t);
const cross = (ax, az, bx, bz) => ax * bz - az * bx;
const mixPoint = (a, b, t) => point(blend(a.x, b.x, t), blend(a.z, b.z, t));
const ringEdges = ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);

// 模型卡和测试引用的生成参数；尺寸都是外观估计，单位米。
export const shellDetail = { panelGrid, panelDrop, panelDepth, groundMargin: panelGroundMargin };
export const standSpec = { tiers: standTiers, start: standStart, end: standEnd, baseLift: standBaseLift,
  rise: standRise, aisles: standAisles, treeColumns: standTreeColumns };
export const plazaDetail = { apron: apronWidth, lawn: lawnWidth, promenade: promenadeWidth, cell: plazaCell,
  lift: { paving: pavingLift, lawn: lawnLift }, groundMax: plazaGroundMax, groundMin: plazaGroundMin };

function ringCenter(ring) {
  return point((Math.min(...ring.map(p => p.x)) + Math.max(...ring.map(p => p.x))) / 2,
    (Math.min(...ring.map(p => p.z)) + Math.max(...ring.map(p => p.z))) / 2);
}

export function shellProfile(sources, base) {
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

// 肋间实腹面：在每个源的空壳多边形内按 10 m 网格补三角面，顶面低于肋顶、底面朝室内。
// 只补地形不低于面层的位置，DSM 屋面回波挡住的地方保持原状（见模型卡的缺口）。
function shellPanels(source, polygon, profile, terrain) {
  const parts = [];
  const rings = [polygon.outer, ...polygon.holes];
  const edges = rings.flatMap(ring => ringEdges(ring));
  const minX = Math.min(...polygon.outer.map(p => p.x)), maxX = Math.max(...polygon.outer.map(p => p.x));
  const stations = new Set(rings.flat().map(p => p.x));
  for (let x = Math.ceil(minX / panelGrid) * panelGrid; x < maxX; x += panelGrid) stations.add(x);
  const xs = [...stations].sort((a, b) => a - b);
  const edgeZ = ([a, b], x) => blend(a.z, b.z, (x - a.x) / (b.x - a.x));
  let index = 0;
  const push = triangle => {
    const corners = triangle.map(p => ({ ...point(Math.fround(p.x), Math.fround(p.z)) }));
    const area = (corners[1].x - corners[0].x) * (corners[2].z - corners[0].z)
      - (corners[1].z - corners[0].z) * (corners[2].x - corners[0].x);
    if (Math.abs(area) < 2) return;
    const tops = corners.map(p => profile(p.x, p.z) - panelDrop);
    for (const [n, corner] of corners.entries()) {
      const ground = terrainHeight(terrain, corner.x, corner.z);
      if (ground !== null && ground >= tops[n] - panelGroundMargin) return;
    }
    parts.push(roofPanelPart(`chunjian:shell:${source.id}:${index++}`, source,
      corners.map((p, n) => ({ ...p, y: tops[n] })), panelDepth, 'stadiumRoof',
      { baseSourceId: stadiumId, baseSource: 'dem-corner-samples' }));
  };
  for (let i = 1; i < xs.length; i++) {
    const x0 = xs[i - 1], x1 = xs[i], mid = (x0 + x1) / 2;
    if (x1 - x0 < 0.5) continue;
    const crossing = edges.filter(([a, b]) => mid > Math.min(a.x, b.x) && mid < Math.max(a.x, b.x))
      .sort((a, b) => edgeZ(a, mid) - edgeZ(b, mid));
    for (let j = 0; j + 1 < crossing.length; j += 2) {
      const near = crossing[j], far = crossing[j + 1];
      const strip = [point(x0, edgeZ(near, x0)), point(x1, edgeZ(near, x1)),
        point(x1, edgeZ(far, x1)), point(x0, edgeZ(far, x0))];
      const first = Math.floor(Math.min(...strip.map(p => p.z)) / panelGrid) * panelGrid;
      const last = Math.max(...strip.map(p => p.z));
      for (let z = first; z < last; z += panelGrid) {
        const cell = clipByZ(clipByZ(strip, z, 1), z + panelGrid, -1);
        for (let k = 1; k + 1 < cell.length; k++) push([cell[0], cell[k], cell[k + 1]]);
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

// 看台落在场心开孔与外廓之间：源开孔是场心，看台沿射线向外抬升；海之门一侧留空。
function seatingBowl(source, base, profile) {
  const polygon = source.polygons[0];
  const field = polygon.holes[0];
  const center = ringCenter(field);
  const perimeter = ringEdges(polygon.outer);
  const ends = field.map(p => outerRay(center, p, perimeter));
  const eastRadius = Math.max(...field.map(p => p.x)) - center.x;
  const isGallery = j => {
    const middle = mixPoint(field[j], ends[j], 0.5);
    return middle.x > center.x + eastRadius * standGallery && Math.abs(middle.z - center.z) < standGalleryHalfZ;
  };
  const flags = field.map((_, j) => isGallery(j));
  const firstGap = flags.indexOf(true);
  const gapCount = flags.filter(Boolean).length;
  const keep = [];
  if (gapCount === field.length) throw new Error('Chunjian seating has no stand directions');
  if (gapCount === 0) {
    for (let j = 0; j < field.length; j++) keep.push(j);
  } else {
    // 海之门开口在环上连续一段；从开口之后开始按环序取其余方向。
    let start = (firstGap + 1) % field.length;
    while (flags[start]) start = (start + 1) % field.length;
    for (let k = 0; k < field.length - gapCount; k++) keep.push((start + k) % field.length);
  }
  const ringAt = f => field.map((p, j) => mixPoint(p, ends[j], f));
  const built = [];
  const parts = [];
  const options = { baseSourceId: stadiumId };
  for (let tier = 1; tier <= standTiers; tier++) {
    const inner = ringAt(blend(standStart, standEnd, (tier - 1) / standTiers));
    const outer = ringAt(blend(standStart, standEnd, tier / standTiers));
    const bottom = built.length === 0 ? base : built.at(-1);
    // 屋面下留 2.2 m 净高；个别方向屋面压低时按屋面收住，不穿壳。
    const clearance = Math.min(...keep.flatMap(j => [profile(inner[j].x, inner[j].z), profile(outer[j].x, outer[j].z)])) - 2.2;
    const wanted = base + standBaseLift + tier * standRise;
    const top = Math.min(wanted, Math.max(clearance, bottom + 0.3));
    if (top - bottom < 0.3) continue;
    built.push(top);
    const band = [...keep.map(j => outer[j]), ...keep.map(j => inner[j]).reverse()];
    parts.push(...footprintParts({ ...source, polygons: [{ outer: band, holes: [] }] }, bottom, 'stadiumSeats', {
      id: `chunjian:stand:tier:${tier}`, min: 0, max: top - bottom, derived: true, baseSourceId: stadiumId
    }));
    // 走道：每级踏面沿射线方向压一条浅色梯级带，读作看台踏步。
    const fractions = [0.12, 0.32, 0.5, 0.68, 0.88].slice(0, standAisles);
    for (const [aisle, fraction] of fractions.entries()) {
      const k = keep[Math.round(fraction * (keep.length - 1))];
      const from = { ...inner[k], y: top + 0.1 }, to = { ...outer[k], y: top + 0.1 };
      parts.push(spanPart(`chunjian:stand:aisle:${aisle}:${tier}`, source, from, to, 2.4, 2.4, 0.3,
        'stadiumDeck', options));
    }
  }
  // 后缘栏板。
  const lastTop = built.at(-1);
  const back = ringAt(standEnd), beyond = ringAt(standEnd + 0.03);
  parts.push(...footprintParts({ ...source, polygons: [{ outer: [...keep.map(j => beyond[j]), ...keep.map(j => back[j]).reverse()], holes: [] }] },
    lastTop, 'stadiumDeck', { id: 'chunjian:stand:barrier', min: 0, max: 1.0, derived: true, baseSourceId: stadiumId }));
  // 西侧主看台的 8 根树形柱穿过看台顶到壳面（公开资料：Φ1500 钢管混凝土主干）。
  const west = keep.filter(j => field[j].x < center.x);
  for (let k = 0; k < standTreeColumns; k++) {
    const j = west[Math.round((k + 0.5) / standTreeColumns * (west.length - 1))];
    const at = mixPoint(field[j], ends[j], 0.3);
    const ring = Array.from({ length: 12 }, (_, n) => point(at.x + 0.75 * Math.cos(n * Math.PI / 6),
      at.z + 0.75 * Math.sin(n * Math.PI / 6)));
    parts.push(loftPart(`chunjian:stand:tree:${k}`, source, ring, ring, base,
      profile(at.x, at.z) - panelDrop + 0.05, 'stadiumDeck', options));
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

// 一个铺装/草坪格子：四角加中心做四个三角面。相邻格子共享边界顶点（同一个 DSM 采样），
// 所以面层在格子之间连续，不会出现 1 米级的台阶；中心点只影响格子内部、不影响边界折线。
function plazaShell(parts, source, index, terrain, style, lift, roofContact, corners, center) {
  const heights = [...corners, center].map(p => terrainHeight(terrain, p.x, p.z));
  if (heights.some(height => height === null)) return -1;
  // 边中点的地形高度与三角面直线插值之差：太大说明格子跨过 DSM 三角面的折棱，铺上就会被地面穿出。
  const mids = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => point(
    (corners[a].x + corners[b].x) / 2, (corners[a].z + corners[b].z) / 2));
  for (const [k, mid] of mids.entries()) {
    const height = terrainHeight(terrain, mid.x, mid.z);
    if (height === null) return -1;
    const [a, b] = [[0, 1], [1, 2], [2, 3], [3, 0]][k];
    const expected = (heights[a] + heights[b]) / 2;
    if (Math.abs(height - expected) > plazaDeviationMax) return -1;
  }
  let added = 0;
  for (const [a, b, c] of [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]) {
    const vertices = [a, b, c].map(n => ({ ...point(Math.fround((n === 4 ? center : corners[n]).x),
      Math.fround((n === 4 ? center : corners[n]).z)), y: heights[n] + lift }));
    parts.push(roofPanelPart(`chunjian:plaza:${style === 'stadiumLawn' ? 'lawn' : 'paving'}:${index + added}`, source,
      vertices, 0.5, style, { roofContact, baseSourceId: stadiumId, baseSource: 'dem-corner-samples' }));
    added++;
  }
  return added;
}

// 广场和绿化：沿四栋源建筑外廓的环带，顶面贴现有 DSM 地面（每条边只抬 0.14–0.18 m）。
// 屋面回波、过陡坡度、既有建筑足迹和园区界线以外都不铺，避免地面穿出铺装、铺装盖到别的楼。
// 西入口的铺装通道从园区界线直通环带，是"入口能走到"的实际路径。
function plazaParts(buildings, terrain, base, siteSource, sitePolygon, sources) {
  if (!sitePolygon) return [];
  const parts = [];
  const west = Math.min(...sources.map(s => s.minX)), east = Math.max(...sources.map(s => s.maxX));
  const north = Math.min(...sources.map(s => s.minZ)), south = Math.max(...sources.map(s => s.maxZ));
  const reach = apronWidth + lawnWidth + promenadeWidth;
  const siteRing = { outer: sitePolygon.outer, holes: sitePolygon.holes ?? [] };
  const near = [];
  for (const building of buildings.values()) {
    if (sources.includes(building) || !(building.height > 1.2)) continue;
    if (building.maxX < west - reach || building.minX > east + reach
      || building.maxZ < north - reach || building.minZ > south + reach) continue;
    near.push(building);
  }
  const inSource = (x, z) => sources.some(source => source.polygons
    .some(polygon => polygonContains({ outer: polygon.outer, holes: [] }, x, z)));
  const hitsBuilding = (x0, z0, x1, z1, cx, cz) => near.some(building => {
    if (building.maxX < x0 || building.minX > x1 || building.maxZ < z0 || building.minZ > z1) return false;
    return building.polygons.some(polygon => polygonContains(polygon, cx, cz)
      || [polygon.outer, ...polygon.holes].some(ring => ring.some(p => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1)));
  });
  let index = 0;
  for (let x = west - reach; x < east + reach; x += plazaCell) {
    for (let z = north - reach; z < south + reach; z += plazaCell) {
      const cx = x + plazaCell / 2, cz = z + plazaCell / 2;
      const distance = Math.hypot(Math.max(west - cx, 0, cx - east), Math.max(north - cz, 0, cz - south));
      if (distance > reach) continue;
      const corners = [[x, z], [x + plazaCell, z], [x + plazaCell, z + plazaCell], [x, z + plazaCell]];
      if (corners.some(([px, pz]) => !polygonContains(siteRing, px, pz) || inSource(px, pz))) continue;
      if (hitsBuilding(x, z, x + plazaCell, z + plazaCell, cx, cz)) continue;
      const samples = [...corners, [cx, cz]].map(([px, pz]) => terrainHeight(terrain, px, pz));
      if (samples.some(height => height === null)) continue;
      if (Math.min(...samples) < base + plazaGroundMin || Math.max(...samples) > base + plazaGroundMax) continue;
      if (Math.max(...samples) - Math.min(...samples) > plazaSlopeMax) continue;
      const lawn = distance >= apronWidth && distance < apronWidth + lawnWidth;
      const style = lawn ? 'stadiumLawn' : 'stadiumPaving';
      const lift = lawn ? lawnLift : pavingLift;
      const added = plazaShell(parts, siteSource, index, terrain, style, lift, !lawn,
        corners.map(([px, pz]) => point(px, pz)), point(cx, cz));
      if (added > 0) index += added;
    }
  }
  return parts;
}

// 广场入口门廊：立在西侧广场外缘，正对开阔地；两柱一梁，不是会徽也不是场馆本体入口。
function siteGate(terrain, base, siteSource, sources) {
  const parts = [];
  const west = Math.min(...sources.map(s => s.minX));
  const north = Math.min(...sources.map(s => s.minZ)), south = Math.max(...sources.map(s => s.maxZ));
  const gateZ = (north + south) / 2;
  const x = west - (apronWidth + lawnWidth + promenadeWidth) - 4;
  const ground = terrainHeight(terrain, x, gateZ) ?? base;
  const options = { baseSourceId: stadiumId, baseSource: 'dem-corner-samples' };
  for (const side of [-1, 1]) {
    const z = gateZ + side * 7;
    const local = terrainHeight(terrain, x, z) ?? ground;
    const ring = [point(x - 1.1, z - 1.1), point(x + 1.1, z - 1.1), point(x + 1.1, z + 1.1), point(x - 1.1, z + 1.1)];
    parts.push(loftPart(`chunjian:site-gate:pier:${side}`, siteSource, ring, ring, local - 0.5, ground + 6.4, 'stadiumDeck', options));
  }
  parts.push(spanPart('chunjian:site-gate:lintel', siteSource, { x, y: ground + 6.4, z: gateZ - 8.1 },
    { x, y: ground + 6.4, z: gateZ + 8.1 }, 2.6, 2.6, 0.8, 'stadiumDeck', options));
  parts.push(spanPart('chunjian:site-gate:sign', siteSource, { x: x - 1.35, y: ground + 5.1, z: gateZ - 6.6 },
    { x: x - 1.35, y: ground + 5.1, z: gateZ + 6.6 }, 0.22, 0.22, 0.55, 'stadiumRib', options));
  return parts;
}

export function build(buildings, terrain, context = {}) {
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
  const site = context?.sites?.site;
  const siteSource = { id: siteId, height: 0, heightSource: 'estimate', minHeight: 0, cx: stadium.cx, cz: stadium.cz };
  return [
    ...sources.flatMap((source, i) => latticeParts(source, lattice[i], profile, fieldCenter)),
    ...sources.flatMap((source, i) => shellPanels(source, lattice[i], profile, terrain)),
    ...perimeterRibs(sources, profile),
    ...poolDome.parts, ...gymDome.parts, ...stadiumRoof.parts,
    ...seatingBowl(stadium, base, profile), ...seaGate(stadium, base, profile),
    ...(site?.polygons?.[0] ? siteGate(terrain, base, siteSource, sources) : []),
    ...plazaParts(buildings, terrain, base, siteSource, site?.polygons?.[0], sources)
  ];
}
