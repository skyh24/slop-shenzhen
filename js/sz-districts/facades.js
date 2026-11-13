import { buildingPlacement, buildingSeed } from '../sz-building-layout.js';
import { polygonBoxOverlaps } from '../building-collision.js';
import { polygonContainsInclusive, signedRingArea } from '../sz-polygon.js';
import { STR } from '../sz-strings.js';
import { frame, railing, solid } from './kit.js';

const DISTRICT_STYLE = {
  sea: { walls: ['ivory', 'chalk', 'tan'], trim: 'blue', metal: 'silver', bays: 4.4 },
  oct: { walls: ['loft', 'brick', 'concrete', 'chalk'], trim: 'concrete', metal: 'steel', bays: 3.35 },
  nantou: { walls: ['oldBrick', 'tan', 'chalk', 'brick'], trim: 'granite', metal: 'green', bays: 2.55 }
};

function shopOpenings(building, poly, ordered, base, heightAt, kind, { front, entryClear }) {
  const openings = new Map();
  const outline = [poly.outer, ...poly.holes].flatMap(ring => ring.map((a, i) =>
    ({ outer: [a, ring[(i + 1) % ring.length]], holes: [] })));
  const cuts = [];
  const level = h => Number.isFinite(h) && Math.abs(h - base) < 0.13;
  for (let edge = 0; edge < ordered.length; edge++) {
    const a = ordered[(edge + 1) % ordered.length], b = ordered[edge];
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    if (length < (kind === 'nantou' ? 4.5 : 5.5)) continue;
    const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
    const count = Math.max(1, Math.round(length / (kind === 'sea' ? 6.7 : kind === 'oct' ? 6.0 : 5.1)));
    const bay = length / count;
    const w = Math.min(5.2, bay * 0.76), d = kind === 'nantou' ? 2.35 : 2.55;
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) * bay;
      if (!front(f.at(u, 0.8))) continue;
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
      const opening = { f, u, w, d, approach: (step - 1) * 0.4 };
      if (!openings.has(edge)) openings.set(edge, []);
      openings.get(edge).push(opening);
      cuts.push({ outer: [f.at(u + w / 2, 0), f.at(u + w / 2, -d), f.at(u - w / 2, -d), f.at(u - w / 2, 0)], holes: [] });
    }
  }
  return openings;
}

function openShop(kit, building, f, u, y, w, d, top, kind, i, style) {
  const finish = kind === 'sea' ? ['blue', 'terra', 'green'][i % 3]
    : kind === 'oct' ? ['steel', 'terra', 'green'][i % 3] : ['wood', 'green', 'oldBrick'][i % 3];
  const board = f.at(u, 0.19);
  const frameAt = (p, lo, hi, width, depth, mat) => kit.box(p, y + lo, y + hi, width, depth, f, mat, building);
  frameAt(f.at(u, 0.31), top - 0.22, top - 0.035, w + 0.4, 0.78, finish);
  kit.label(board, y + top - 0.44, w * 0.68, 0.34, f, STR.districts.shops[kind][i % 3], '#eee5d0',
    kind === 'sea' ? '#335263' : kind === 'oct' ? '#3a4443' : '#53423a', true);
  kit.piece(f.at(u, -0.9), y + top - 0.20, w * 0.55, 0.075, 0.17, f, 'lamp');
  kit.lamp(f.at(u, -0.32), y + top - 0.54, 27, 8);
  kit.piece(f.at(u, -d + 0.014), y + (top + 0.05) / 2, w - 0.04, top - 0.15, 0.028, f,
    kind === 'sea' ? 'loft' : kind === 'oct' ? 'concrete' : 'tan');
  const right = u + w * 0.34;
  frameAt(f.at(right, -d + 0.55), 0, 1.0, w * 0.27, 0.60, 'wood');
  kit.piece(f.at(right, -d + 0.55), y + 1.035, w * 0.30, 0.07, 0.67, f, 'stone');
  const left = u - w * 0.32;
  for (const [a, b] of [[0.28, 0.38], [0.78, 0.87], [1.33, 1.41]]) {
    frameAt(f.at(left, -d + 0.20), a, b, w * 0.33, 0.29, style.metal);
    for (let j = 0; j < 6; j++) {
      kit.piece(f.at(left + (j - 2.5) * w * 0.048, -d + 0.20), y + b + 0.12,
        0.12, 0.24, 0.20, f, ['terra', 'brass', 'green', 'ivory'][(i + j) % 4]);
    }
  }
  for (const side of [-1, 1]) {
    kit.piece(f.at(u + side * w / 2, 0.02), y + (top - 0.2) / 2, 0.13, top - 0.2, 0.15, f, finish);
  }
}

export function restyleBlock(kit, building, terrain, heightAt, kind, options = {}) {
  const style = DISTRICT_STYLE[kind];
  const seed = buildingSeed(building.id);
  const wall = options.wall ?? style.walls[Math.floor(seed * style.walls.length)];
  const old = buildingPlacement(building, terrain);
  // 这一处缓坡沿街的设计铺面以街面标高为准，原轮廓和总高不变。
  const grade = options.shopGrade && heightAt(options.shopGrade.x, options.shopGrade.z);
  const base = Number.isFinite(grade) && Math.abs(old.baseY - grade) < 0.3 ? grade : old.baseY;
  // 设计层数只改没有层数、来源为通用估计的指定对象；其他对象保持源高度。
  const override = building.heightSource === 'estimate' && !(building.levels > 0) && options.floors > 0;
  const height = override ? options.floors * (options.floorHeight ?? (kind === 'sea' ? 3.95 : kind === 'oct' ? 4.05 : 3.65)) : building.height;
  const roof = base + height;
  const bottom = Math.min(old.foundationBottomY ?? old.minY, base + building.minHeight);
  for (const [i, poly] of building.polygons.entries()) {
    const id = `${building.id}:district:${i}`;
    const ring = poly.outer;
    const ordered = signedRingArea(ring) > 0 ? ring : [...ring].reverse();
    const levelCount = building.levels > 0 ? building.levels : override ? options.floors : Math.round(height / 3.55);
    const story = height / Math.max(1, levelCount);
    const baseFloor = kind === 'oct' && override ? 3.44 : 3.06;
    const openings = options.open && building.minHeight === 0 && story >= baseFloor && height > baseFloor + 0.7
      ? shopOpenings(building, poly, ordered, base, heightAt, kind, options) : new Map();
    const provenance = override ? 'scene-design-height' : 'osm-footprint';
    if (openings.size) {
      const recess = ordered.flatMap((p, edge) => {
        const bays = openings.get(edge) ?? [];
        return [p, ...bays.slice().reverse().flatMap(({ f, u, w, d }) => {
          const right = u + w / 2, left = u - w / 2;
          return [f.at(right, 0), f.at(right, -d), f.at(left, -d), f.at(left, 0)];
        })];
      });
      kit.part(solid(`${id}:open-shop`, building, { outer: recess, holes: poly.holes }, bottom, base + baseFloor, wall));
      kit.part(solid(id, building, poly, base + baseFloor, roof, wall, provenance));
      let shopIndex = Math.floor(seed * 24);
      for (const bays of openings.values()) {
        for (const { f, u, w, d, approach } of bays) {
          openShop(kit, building, f, u, base, w, d, baseFloor, kind, shopIndex++, style);
          options.registerShop?.({ id: building.id, mouth: f.at(u, 0), interior: f.at(u, -1.55),
            approach: f.at(u, approach) });
        }
      }
    } else kit.part(solid(id, building, poly, bottom, roof, wall, provenance));
    for (let j = 0; j < ordered.length; j++) {
      const a = ordered[(j + 1) % ordered.length], b = ordered[j];
      const length = Math.hypot(a.x - b.x, a.z - b.z);
      if (length < 2.3) continue;
      const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
      const canProject = (u, depth, y, w, h) => [-w / 2, 0, w / 2].every(d =>
        [0.15, depth].every(v => options.clear?.(f.at(u + d, v), y, h, building.id) !== false));
      const count = Math.max(1, Math.round(length / style.bays));
      const bay = length / count;
      const shopBays = openings.get(j) ?? [];
      kit.piece(f.at(length / 2, 0.035), roof - 0.22, length, 0.25, 0.13, f, style.trim, { detail: false });
      if (kind === 'oct' && override && shopBays.length) {
        // 三层联排按开间分段；砖与灰墙的分缝延续到屋檐，仍使用原建筑轮廓。
        for (const { u, w } of shopBays) {
          const upper = height - baseFloor - 0.45;
          const x = u - w / 2 - 0.10;
          kit.piece(f.at(x, 0.055), base + baseFloor + upper / 2, 0.22, upper, 0.16, f, style.trim);
          kit.piece(f.at(u, 0.07), roof - 0.42, w + 0.34, 0.24, 0.19, f, wall === 'brick' ? 'loft' : 'brick');
        }
      }
      for (let k = 0; k < count; k++) {
        const u = (k + 0.5) * bay;
        const p = f.at(u, 0.12);
        const ground = heightAt(p.x, p.z);
        if (!Number.isFinite(ground)) continue;
        const shop = options.front?.(p) !== false && Math.abs(ground - base) < 0.6 && building.minHeight === 0;
        const row = (y, w, h, v, d, material, detail = true) =>
          kit.piece(f.at(u, v), y, w, h, d, f, material, { detail });
        for (let floor = 0; floor < levelCount; floor++) {
          if (floor === 0 && shopBays.some(opening => Math.abs(u - opening.u) < opening.w / 2 + bay * 0.47)) continue;
          const y = base + building.minHeight + floor * story;
          const window = bay * (floor === 0 && shop ? 0.83 : 0.62);
          const h = Math.min(story * (floor === 0 && shop ? 0.63 : 0.51), 2.6);
          if (y + h + 0.7 > roof) continue;
          const cy = y + (floor === 0 && shop ? h / 2 + 0.19 : story * 0.53);
          row(cy, window + 0.17, h + 0.14, 0.026, 0.14, floor === 0 && shop ? style.metal : style.trim);
          row(cy, window, h, 0.108, 0.065, floor === 0 || (k + j + floor) % 4 === 0 ? 'glass' : 'darkGlass', levelCount < 9);
          for (const side of [-1, 1]) {
            kit.piece(f.at(u + side * window / 6, 0.147), cy, 0.045, h, 0.06, f, style.metal);
          }
          if (!floor && shop) {
            row(cy + h / 2 + 0.22, window, 0.23, 0.15, 0.11, ['terra', 'green', 'blue', 'wood'][(k + j) % 4]);
            if ((k + j) % 2 === 0 && canProject(u, 0.88, y + 2.7, window + 0.25, 0.3)) {
              row(y + 2.75, window + 0.36, 0.14, 0.48, 0.96, k % 3 === 0 ? style.trim : style.metal);
              row(y + 2.62, window + 0.34, 0.10, 0.94, 0.075, 'lamp');
            }
          }
          const balcony = floor > 0 && floor < 4 && levelCount <= 6 && shop && options.balconies
            && (k + j + Math.floor(seed * 8)) % (kind === 'nantou' ? 5 : 3) === 0;
          const depth = kind === 'oct' && floor === 1 ? 1.72 : kind === 'nantou' ? 0.73 : 1.12;
          const width = Math.min(bay - 0.22, window + (kind === 'oct' ? 1.1 : 0.38));
          if (!balcony || !canProject(u, depth, y - 0.24, width, 1.34)) continue;
          kit.box(f.at(u, depth / 2), y - 0.23, y, width, depth + 0.06, f, style.trim, building);
          railing(kit, f, y, u - width / 2, u + width / 2, depth, style.metal);
          for (const side of [-1, 1]) {
            const q = f.at(u + side * width / 2, 0);
            const sideFrame = frame(q.x, q.z, -f.s, f.c);
            railing(kit, sideFrame, y, 0, depth, 0, style.metal);
          }
          row(y + 0.30, 0.48, 0.37, depth - 0.24, 0.42, 'terra');
          row(y + 0.63, 0.49, 0.50, depth - 0.24, 0.44, 'leaf');
        }
      }
      if (options.terrace && length > 9) railing(kit, f, roof, 0, length, -0.06, style.metal);
    }
    if (options.terrace && i === 0 && polygonContainsInclusive(poly, building.cx, building.cz)) {
      kit.box({ x: building.cx, z: building.cz }, roof, roof + 2.55, 4.2, 3.2,
        frame(0, 0, 1, 0), 'loft', building);
      kit.piece({ x: building.cx, z: building.cz }, roof + 2.61, 4.45, 0.18, 3.5,
        frame(0, 0, 1, 0), 'steel', { detail: false });
    }
  }
}

export function buildB10(kit, building, terrain, heightAt, clear) {
  restyleBlock(kit, building, terrain, heightAt, 'oct', { floors: 3, floorHeight: 3.65, wall: 'chalk', front: () => false });
  const y = buildingPlacement(building, terrain).baseY;
  // 南立面圆盘与筛网参考都市实践的改造照片；网格/入口比例为视觉估计，室内不开放。
  const f = frame(-6803.43, 438.82, 54.73, -4.1);
  const screen = f.at(27, 0.25);
  kit.box(screen, y + 5.3, y + 10.5, 51, 0.32, f, 'silver', building, 'oct-b10:screen');
  for (let x = 2.5; x < 53; x += 1.25) {
    kit.piece(f.at(x, 0.43), y + 7.9, 0.047, 5.1, 0.065, f, 'chalk');
  }
  for (let x = 5.4; x < 53; x += 7.05) {
    const d = x % 3 > 1.5 ? 2.62 : 1.84;
    kit.piece(f.at(x, 0.475), y + 7.7 + 0.25 * (x % 2), d, d, 0.18, f, 'glass', { shape: 'disc', detail: false });
    kit.piece(f.at(x, 0.60), y + 7.7 + 0.25 * (x % 2), d * 0.68, d * 0.68, 0.09, f, 'chalk', { shape: 'disc' });
  }
  kit.label(f.at(27, 0.72), y + 9.5, 13.1, 1.65, f, STR.districts.b10, '#f3eee4', '#5c6c68');
  const entry = f.at(31, 1.15);
  if (clear(entry, y, 4.6, building.id)) {
    kit.box(entry, y + 3.44, y + 3.71, 10.8, 2.35, f, 'white', building, 'oct-b10:entry-canopy');
    kit.piece(f.at(31, 0.18), y + 1.56, 6.9, 2.93, 0.28, f, 'glass', { detail: false });
    for (const u of [27.1, 34.9]) {
      kit.piece(f.at(u, 1.25), y + 3.41, 1.45, 0.06, 0.17, f, 'lamp');
      kit.lamp(f.at(u, 1.3), y + 3.18, 43, 10);
    }
    for (const u of [26.2, 35.8]) kit.box(f.at(u, 2.10), y, y + 3.46, 0.24, 0.24, f, 'silver', building);
  }
  return { base: y, roof: y + 10.95 };
}
