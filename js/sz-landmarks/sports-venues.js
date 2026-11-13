import { convexHull, polygonContains } from '../building-collision.js';
import { terrainHeight } from '../sz-terrain.js';
import { footprintParts, loftPart, roofPanelPart, spanPart } from './parts.js';

const TAU = 2 * Math.PI;
const SEGMENTS = 48;
const steps = n => Array.from({ length: n }, (_, i) => i);
const mix = (a, b, t) => a + (b - a) * t;
const between = (a, b, t) => ({ x: mix(a.x, b.x, t), z: mix(a.z, b.z, t) });
const yAt = (p, y) => ({ ...p, y });
const angle = i => TAU * i / SEGMENTS;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const venues = {
  chunjian: { sourceId: 'relation/9244350', pitchId: 'way/493390579', size: [68, 105], track: [41, 47, 6] },
  'szu-yuanping-stadium': { sourceId: 'relation/3110985', pitchId: 'way/231813499',
    size: [68, 105], track: [44, 44, 8], type: 'campus' },
  'university-town-stadium': { sourceId: 'relation/7664887', pitchId: 'way/533642877',
    size: [60, 105], track: [39, 44, 8], type: 'university',
    optionalSkipIds: ['overture/942fa2a3-318d-4a89-9356-11ad6315d4e6'] },
  'shenzhen-stadium': { sourceId: 'relation/3777627', pitchId: 'way/285020297',
    size: [68, 105], type: 'football', designHeight: 45.58 },
  'shenzhen-gymnasium': { sourceId: 'way/927162338', type: 'arena', designHeight: 47.185 }
};

function frameFor(ring) {
  const center = ring.reduce((c, p) => ({ x: c.x + p.x / ring.length, z: c.z + p.z / ring.length }), { x: 0, z: 0 });
  // 球场朝向取锁定足迹的长边。统一指向南，便于与图照方位和入口对照。
  const [a, b] = ring.map((p, i) => [p, ring[(i + 1) % ring.length]])
    .reduce((best, edge) => distance(...edge) > distance(...best) ? edge : best);
  const sign = b.z >= a.z ? 1 : -1;
  const len = distance(a, b);
  const along = { x: (b.x - a.x) * sign / len, z: (b.z - a.z) * sign / len };
  return {
    center,
    world: (u, v) => ({ x: center.x + along.z * u + along.x * v, z: center.z - along.x * u + along.z * v }),
    local: ({ x, z }) => ({ u: (x - center.x) * along.z - (z - center.z) * along.x,
      v: (x - center.x) * along.x + (z - center.z) * along.z })
  };
}

function rayBoundary(ring, frame, a) {
  const u = Math.cos(a), v = Math.sin(a);
  let hit = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = frame.local(ring[i]), q = frame.local(ring[(i + 1) % ring.length]);
    const du = q.u - p.u, dv = q.v - p.v;
    const den = u * dv - v * du;
    if (Math.abs(den) < 1e-8) continue;
    const t = (p.u * dv - p.v * du) / den;
    const s = (p.u * v - p.v * u) / den;
    if (t > 0 && s >= -1e-7 && s <= 1 + 1e-7) hit = Math.min(t, hit);
  }
  return frame.world(u * hit, v * hit);
}

function capsule(frame, radius, straight, n = 48) {
  // 每个半圆独立采样，两条直线平行球场长边。
  return [-1, 1].flatMap(side => steps(n / 2 + 1).map(i => {
    const a = (side === -1 ? Math.PI : 0) + Math.PI * i / (n / 2);
    return frame.world(radius * Math.cos(a), side * straight + radius * Math.sin(a));
  }));
}

const rect = (f, u0, v0, u1, v1) => [f(u0, v0), f(u1, v0), f(u1, v1), f(u0, v1)];

function ribbon(a, b, width) {
  const scale = width / (2 * distance(a, b));
  const x = (b.z - a.z) * scale, z = (a.x - b.x) * scale;
  return [{ x: a.x - x, z: a.z - z }, { x: b.x - x, z: b.z - z },
    { x: b.x + x, z: b.z + z }, { x: a.x + x, z: a.z + z }];
}

function addLines(patches, points, width, style, close = false) {
  for (let i = 0; i < points.length - Number(!close); i++) {
    patches.push({ ring: ribbon(points[i], points[(i + 1) % points.length], width), style });
  }
}

function box(parts, id, source, ring, low, high, style, instanced = false) {
  parts.push(...footprintParts({ ...source, polygons: [{ outer: ring, holes: [] }] }, low, style, {
    id, min: 0, max: high - low, derived: true
  }).map(part => ({ ...part, instanced })));
}

function beam(parts, id, source, a, b, width, depth, style) {
  parts.push({ ...spanPart(id, source, a, b, width, width, depth, style), instanced: true });
}

function panel(parts, id, source, quad, depth, style, options) {
  parts.push(roofPanelPart(id + ':0', source, [quad[0], quad[1], quad[2]], depth, style, options),
    roofPanelPart(id + ':1', source, [quad[0], quad[2], quad[3]], depth, style, options));
}

function lamp(parts, id, source, p, toward, ground, tall = false) {
  const y = ground(p.x, p.z);
  if (!Number.isFinite(y)) return;
  const h = tall ? 18 : 6, half = tall ? 0.26 : 0.09;
  const offset = (x, z) => ({ x: p.x + x, z: p.z + z });
  box(parts, id + ':pole', source, rect(offset, -half, -half, half, half), y - 0.05, y + h, 'sportsMetal', true);
  const f = between(p, toward, (tall ? 1.8 : 0.8) / distance(p, toward));
  beam(parts, id + ':arm', source, yAt(p, y + h), yAt(f, y + h), half * 2, half, 'sportsMetal');
  box(parts, id + ':head', source, rect((x, z) => ({ x: f.x + x, z: f.z + z }),
    tall ? -1.1 : -0.3, -0.19, tall ? 1.1 : 0.3, 0.19), y + h - 0.19, y + h + 0.08, 'sportsLamp', true);
}

function football(model, source, frame, size, ground) {
  const { parts, patches } = model, f = frame.world;
  const [w, l] = size.map(value => value / 2);
  const white = 'sportsPitchLine';
  // 草皮条带与线均贴在同一底层三角面，不用高于地面的盒子代表标线。
  for (let i = 0; i < 12; i++) {
    patches.push({ ring: rect(f, -w - 0.7, mix(-l - 2.4, l + 2.4, i / 12), w + 0.7,
      mix(-l - 2.4, l + 2.4, (i + 1) / 12)), style: i % 2 ? 'sportsTurfLight' : 'sportsTurf' });
  }
  addLines(patches, rect(f, -w, -l, w, l), 0.12, white, true);
  addLines(patches, [f(-w, 0), f(w, 0)], 0.12, white);
  addLines(patches, steps(40).map(i => f(9.15 * Math.cos(TAU * i / 40), 9.15 * Math.sin(TAU * i / 40))), 0.12, white, true);
  patches.push({ ring: rect(f, -0.13, -0.13, 0.13, 0.13), style: white });
  for (const side of [-1, 1]) {
    for (const [width, depth] of [[20.16, 16.5], [9.16, 5.5]]) {
      addLines(patches, [f(-width, side * l), f(-width, side * (l - depth)),
        f(width, side * (l - depth)), f(width, side * l)], 0.12, white);
    }
    const spot = side * (l - 11);
    patches.push({ ring: rect(f, -0.13, spot - 0.13, 0.13, spot + 0.13), style: white });
    const start = Math.asin(5.5 / 9.15);
    addLines(patches, steps(21).map(i => {
      const a = mix(start, Math.PI - start, i / 20);
      return f(9.15 * Math.cos(a), spot - side * 9.15 * Math.sin(a));
    }), 0.12, white);
    const postY = [-3.72, 3.72].map(u => {
      const p = f(u, side * l);
      return ground(p.x, p.z);
    });
    if (!postY.every(Number.isFinite)) continue;
    const barY = Math.max(...postY) + 2.56;
    const prefix = model.id + ':goal:' + side;
    for (const [i, u] of [-3.72, 3.72].entries()) {
      box(parts, prefix + ':post:' + i, source, rect(f, u - 0.06, side * l - 0.06, u + 0.06, side * l + 0.06),
        postY[i], barY, 'sportsGoal', true);
      const back = f(u, side * (l + 1.75)), base = ground(back.x, back.z);
      if (Number.isFinite(base)) beam(parts, prefix + ':brace:' + i, source,
        yAt(f(u, side * l), barY - 0.13), yAt(back, base + 0.12), 0.07, 0.07, 'sportsGoal');
    }
    beam(parts, prefix + ':crossbar', source, yAt(f(-3.72, side * l), barY), yAt(f(3.72, side * l), barY),
      0.12, 0.12, 'sportsGoal');
  }
}

function runningTrack(patches, frame, [radius, straight, lanes]) {
  const inner = capsule(frame, radius, straight);
  patches.push({ ring: inner, style: 'sportsInfield' });
  const outer = capsule(frame, radius + lanes * 1.22, straight);
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    patches.push({ ring: [inner[i], inner[j], outer[j], outer[i]], style: 'sportsTrack' });
  }
  for (let n = 0; n <= lanes; n++) {
    addLines(patches, capsule(frame, radius + n * 1.22, straight), 0.055, 'sportsTrackLine', true);
  }
  return outer;
}

function approach(model, source, frame, a, from, to, ground, road, neighbors) {
  if (distance(from, to) < 2) return;
  const halfWidth = 4.2;
  const plaza = ribbon(from, to, halfWidth * 2);
  const samples = plaza.flatMap((p, i) => {
    const q = plaza[(i + 1) % plaza.length];
    const n = Math.max(1, Math.ceil(distance(p, q) / 2));
    return steps(n).map(j => between(p, q, j / n));
  });
  const mid = between(from, to, 0.5);
  const clear = p => Number.isFinite(ground(p.x, p.z)) && road?.(p.x, p.z) == null && !neighbors.some(b =>
    b.polygons.some(poly => polygonContains(poly, p.x, p.z)));
  if (![...samples, mid].every(clear)) return;
  model.approaches.push({ from, to, halfWidth });
  model.patches.push({ ring: plaza, style: 'sportsApron' });
  for (const side of [-1, 1]) {
    const dir = { x: Math.cos(a + side * Math.PI / 2), z: Math.sin(a + side * Math.PI / 2) };
    const center = frame.local(between(from, to, 0.7));
    const p = frame.world(center.u + dir.x * 7, center.v + dir.z * 7);
    const bed = frame.world(center.u + dir.x * 9, center.v + dir.z * 9);
    const q = frame.local(bed);
    const lawn = rect(frame.world, q.u - 2.5, q.v - 3.1, q.u + 2.5, q.v + 3.1);
    if (lawn.every(clear) && clear(bed)) model.patches.push({ ring: lawn, style: 'sportsInfield' });
    if (clear(p)) lamp(model.parts, model.id + ':light:' + model.parts.length, source, p, mid, ground);
  }
}

function bowl(model, source, frame, spec, ground, road, neighbors) {
  const { parts, trim, id } = model;
  const { outer: sourceOuter, holes: [sourceInner] } = source.polygons[0];
  const city = spec.type === 'football';
  const campus = spec.type === 'campus';
  const base = ground(frame.center.x, frame.center.z);
  const outer = steps(SEGMENTS).map(i => rayBoundary(sourceOuter, frame, angle(i)));
  const inner = steps(SEGMENTS).map(i => {
    const a = angle(i);
    if (!city) return rayBoundary(sourceInner, frame, a);
    // 改造后的座席贴近场地，内圈保留近似矩形的四条边。
    const r = Math.min(43 / Math.abs(Math.cos(a)), 61.5 / Math.abs(Math.sin(a)));
    return frame.world(r * Math.cos(a), r * Math.sin(a));
  });
  if ([...outer, ...inner].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return;
  const isGate = i => [12, 36].some(n => i === n - 1 || i === n);
  const levels = city ? 12 : campus ? 5 : 8;
  const modelTop = city ? spec.designHeight : campus ? 12.5 : 24;
  for (let i = 0; i < SEGMENTS; i++) {
    const j = (i + 1) % SEGMENTS, a = angle(i + 0.5);
    const west = Math.cos(a) < -0.74;
    const rowAt = (k, f) => between(inner[k], outer[k], f);
    const grade = [inner[i], inner[j], outer[i], outer[j]].map(p => ground(p.x, p.z));
    if (!grade.every(Number.isFinite)) continue;
    const foot = Math.min(...grade) - 0.2;
    const high = city ? base + 30 : Math.max(...grade) + (west ? (campus ? 6.6 : 10) : (campus ? 2.7 : 4.7));
    if (!isGate(i)) {
      for (let tier = 0; tier < levels; tier++) {
        const t0 = tier / levels, t1 = (tier + 1) / levels;
        const a0 = rowAt(i, t0), a1 = rowAt(j, t0), b0 = rowAt(i, t1), b1 = rowAt(j, t1);
        const top = mix(Math.max(...grade) + 0.65, high, t1);
        const style = tier % 4 === 3 && !campus ? 'sportsConcrete' : campus ? 'sportsCampusSeats'
          : city ? 'sportsCitySeats' : 'sportsTownSeats';
        box(parts, id + ':tier:' + i + ':' + tier, source, [a0, a1, b1, b0], foot, top, style);
        if (style === 'sportsConcrete') continue;
        for (const f of [0.23, 0.5, 0.77]) {
          const p = between(between(a0, a1, f), between(b0, b1, f), 0.62);
          trim.push({ ...p, y: top + 0.17, size: [0.54, 0.34, 0.49],
            yaw: Math.atan2(a1.x - a0.x, a1.z - a0.z), style: city ? 'sportsCitySeat' : campus ? 'sportsCampusSeat' : 'sportsTownSeat' });
        }
      }
    } else if (city) {
      // 两端门洞保留净高，座席上部跨过入口，避免从街面看成贯穿整座场馆的缺口。
      const p = [rowAt(i, 0.18), rowAt(j, 0.18), outer[j], outer[i]];
      box(parts, id + ':gate-bridge:' + i, source, p, base + 5.2, base + 23, 'sportsConcrete');
    }
    if (city || west) {
      const roof = (k, t) => {
        const section = Math.cos(angle(k));
        const y = city ? base + modelTop - 6.0 * (1 - t) - 3.1 * Math.abs(section)
          : base + modelTop - (campus ? 1.6 : 3.5) * Math.abs(Math.sin(angle(k))) - 1.9 * t;
        return yAt(rowAt(k, city ? mix(-0.15, 1, t) : mix(-0.13, 1, t)), y);
      };
      panel(parts, id + ':canopy:' + i, source, [roof(i, 0), roof(j, 0), roof(j, 1), roof(i, 1)],
        city ? 1.1 : 0.52, 'sportsRoof', { heightSource: city ? 'design' : 'estimate' });
      if (i % (city ? 1 : 2) === 0 && !isGate(i)) {
        const p = rowAt(i, 0.94), y = ground(p.x, p.z);
        const q = roof(i, 1);
        const pos = frame.local(p);
        const width = city ? 0.76 : 0.31;
        if (Number.isFinite(y) && q.y > y + 1) {
          box(parts, id + ':column:' + i, source, rect(frame.world, pos.u - width, pos.v - width, pos.u + width, pos.v + width),
            y - 0.15, q.y, 'sportsMetal', true);
          beam(parts, id + ':rib:' + i, source, yAt(roof(i, 0), roof(i, 0).y - 0.5),
            yAt(q, q.y - 0.4), city ? 0.95 : 0.36, city ? 0.65 : 0.36, 'sportsMetal');
          if (city) {
            const skirt = (k, f, y) => {
              const at = between(outer[k], inner[k], f);
              return yAt(at, y);
            };
            // 银色罩棚与低层之间保留深色开口，立面用斜向重复构件读出。
            beam(parts, id + ':facade:' + i, source, skirt(i, 0.017, roof(i, 1).y - 0.8),
              skirt(j, 0.09, base + 11.2), 2.25, 1.0, 'sportsFin');
          }
        }
      }
    }
  }
  // 两个开口连到外侧场地；入口尺寸和通行方案为漫游估计。
  for (const i of [12, 36]) {
    const a = angle(i), p = frame.local(outer[i]), q = frame.local(inner[i]);
    const from = frame.world(q.u, q.v - Math.sin(a) * 1.5);
    const to = frame.world(p.u, p.v + Math.sin(a) * 12);
    approach(model, source, frame, a, from, to, ground, road, neighbors);
  }
  if (!city) for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const p = rayBoundary(sourceOuter, frame, Math.atan2(v, u));
    if (road?.(p.x, p.z) == null) lamp(parts, id + ':flood:' + u + ':' + v, source, p, frame.center, ground, true);
  }
}

function arena(model, source, spec, ground, road, neighbors) {
  const frame = {
    center: { x: source.cx, z: source.cz },
    world: (x, z) => ({ x: source.cx + x, z: source.cz + z }),
    local: p => ({ u: p.x - source.cx, v: p.z - source.cz })
  };
  const base = ground(source.cx, source.cz), height = spec.designHeight;
  if (!Number.isFinite(base)) return;
  const { parts, id } = model;
  const outline = source.polygons[0].outer;
  const edge = convexHull(outline);
  const ring = scale => edge.map(p => between(frame.center, p, scale));
  const options = { heightSource: 'design' };
  const vertical = (name, scale, min, max, style) => box(parts, id + ':' + name, source, ring(scale),
    base + min, base + max, style);
  vertical('podium', 0.86, -0.45, 5.5, 'sportsConcrete');
  vertical('glazing', 0.83, 5.5, 23, 'sportsGlass');
  // 收分外壳在最高点闭合；矩形开合缝以屋面色差表现。
  const profile = [[0.85, 8], [0.96, 16], [1, 28], [0.94, 37], [0.76, 43], [0.46, height - 0.55]];
  for (let k = 0; k < profile.length - 1; k++) {
    const [a, h0] = profile[k], [b, h1] = profile[k + 1];
    parts.push(loftPart(id + ':shell:' + k, source, ring(a), ring(b), base + h0, base + h1,
      k < 2 ? 'sportsGlass' : 'sportsRoof', { ...options, bottomFace: false, topFace: false, smoothSides: true }));
  }
  const top = ring(0.46);
  parts.push(loftPart(id + ':closed-roof', source, top, top, base + height - 0.55, base + height,
    'sportsRoof', { ...options, smoothSides: true }));
  for (let i = 0; i < edge.length; i++) {
    for (let k = 0; k < 4; k++) {
      const [s0, y0] = profile[k], [s1, y1] = profile[k + 1];
      const a = between(frame.center, edge[(i + k) % edge.length], s0 + 0.006);
      const b = between(frame.center, edge[(i + k + 1) % edge.length], s1 + 0.006);
      beam(parts, id + ':fin:' + i + ':' + k, source, yAt(a, base + y0), yAt(b, base + y1),
        k < 2 ? 1.4 : 1.15, 0.68, 'sportsFin');
    }
  }
  const seam = rect(frame.world, -23, -19, 23, 19);
  for (const [i, p] of seam.entries()) {
    const q = seam[(i + 1) % seam.length];
    beam(parts, id + ':roof-seam:' + i, source, yAt(p, base + height + 0.06),
      yAt(q, base + height + 0.06), 0.46, 0.08, 'sportsMetal');
  }
  for (const i of [12, 24]) {
    const a = angle(i), from = rayBoundary(outline, frame, a), to = frame.world(
      frame.local(from).u + Math.cos(a) * 25, frame.local(from).v + Math.sin(a) * 25);
    approach(model, source, frame, a, from, to, ground, road, neighbors);
  }
}

export function buildSportsVenue(id, buildings, terrain, { sites = {}, groundHeight, roadHeight } = {}) {
  const spec = venues[id], source = buildings.get(spec.sourceId);
  const model = { id, parts: [], patches: [], trim: [], approaches: [] };
  if (!source || source.polygons.length !== 1) return model;
  const ground = groundHeight ?? ((x, z) => terrainHeight(terrain, x, z));
  const neighbors = [...buildings.values()].filter(b => b.id !== source.id && Math.abs(b.cx - source.cx) < 220
    && Math.abs(b.cz - source.cz) < 220);
  if (spec.type === 'arena') {
    if (sites.arena?.osmId === spec.sourceId) arena(model, source, spec, ground, roadHeight, neighbors);
    return model;
  }
  const ring = sites.pitch?.osmId === spec.pitchId && sites.pitch.polygons[0]?.outer;
  if (!ring || ring.length < 4 || !source.polygons[0].holes.length) return model;
  const frame = frameFor(ring);
  if (!Number.isFinite(ground(frame.center.x, frame.center.z))) return model;
  const openField = spec.track ? runningTrack(model.patches, frame, spec.track)
    : rect(frame.world, -42.8, -61.3, 42.8, 61.3);
  const extent = [Math.min(...openField.map(p => p.x)), Math.max(...openField.map(p => p.x)),
    Math.min(...openField.map(p => p.z)), Math.max(...openField.map(p => p.z))];
  model.reservesField = (x, z) => x >= extent[0] && x <= extent[1] && z >= extent[2] && z <= extent[3]
    && polygonContains({ outer: openField, holes: [] }, x, z);
  if (spec.type === 'football') {
    model.patches.push({ ring: rect(frame.world, -42.8, -61.3, 42.8, 61.3), style: 'sportsApron' });
    model.patches.push({ ring: rect(frame.world, -37, -57, 37, 57), style: 'sportsInfield' });
  }
  football(model, source, frame, spec.size, ground);
  if (spec.type) {
    bowl(model, source, frame, spec, ground, roadHeight, neighbors);
    if (!model.parts.some(part => part.id.startsWith(id + ':tier:'))) model.parts.length = 0;
  } else {
    // 海之门保留原桥体；仅在内场东侧补估计灯位，避免在中央通路上放柱。
    for (const v of [-43, 43]) {
      lamp(model.parts, id + ':field-light:' + v, source, frame.world(43, v), frame.center, ground);
    }
  }
  return model;
}

export const sportsLandmarks = Object.entries(venues).filter(([id]) => id !== 'chunjian')
  .map(([id, { sourceId, optionalSkipIds }]) => ({ id, sourceIds: [sourceId], optionalSkipIds,
    build: (...args) => buildSportsVenue(id, ...args) }));
