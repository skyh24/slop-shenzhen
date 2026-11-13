import { buildingPlacement, buildingSeed } from '../sz-building-layout.js';
import { polygonContainsInclusive, signedRingArea } from '../sz-polygon.js';
import { STR } from '../sz-strings.js';
import { frame, railing, solid } from './kit.js';

const DISTRICT_STYLE = {
  sea: { walls: ['ivory', 'chalk', 'tan'], trim: 'blue', metal: 'silver', bays: 4.4 },
  oct: { walls: ['loft', 'brick', 'concrete', 'chalk'], trim: 'concrete', metal: 'steel', bays: 3.35 },
  nantou: { walls: ['oldBrick', 'tan', 'chalk', 'brick'], trim: 'granite', metal: 'green', bays: 2.55 }
};

function openShop(kit, building, f, u, y, w, d, kind, i, style) {
  const finish = kind === 'sea' ? ['blue', 'terra', 'green'][i % 3] : ['steel', 'terra', 'green'][i % 3];
  const floor = f.at(u, -d / 2);
  const board = f.at(u, 0.19);
  const frameAt = (p, lo, hi, width, depth, mat) => kit.box(p, y + lo, y + hi, width, depth, f, mat, building);
  kit.piece(floor, y - 0.035, w, 0.065, d, f, kind === 'sea' ? 'stone' : 'concrete', { detail: false });
  frameAt(f.at(u, 0.30), 2.89, 3.04, w + 0.4, 0.72, finish);
  kit.label(board, y + 2.7, w * 0.8, 0.35, f, STR.districts.shops[kind][i % 3]);
  kit.piece(f.at(u, -0.9), y + 2.86, w * 0.55, 0.075, 0.17, f, 'lamp');
  kit.lamp(f.at(u, -0.32), y + 2.55, 27, 8);
  const right = u + w * 0.28;
  frameAt(f.at(right, -d + 0.72), 0, 1.0, w * 0.41, 0.72, 'wood');
  kit.piece(f.at(right, -d + 0.72), y + 1.035, w * 0.44, 0.07, 0.79, f, 'stone');
  const left = u - w * 0.29;
  for (const [a, b] of [[0.28, 0.38], [0.78, 0.87], [1.33, 1.41]]) {
    frameAt(f.at(left, -d + 0.25), a, b, w * 0.40, 0.34, style.metal);
    for (let j = 0; j < 6; j++) {
      kit.piece(f.at(left + (j - 2.5) * w * 0.058, -d + 0.26), y + b + 0.12,
        0.12, 0.24, 0.20, f, ['terra', 'brass', 'green', 'ivory'][(i + j) % 4]);
    }
  }
  for (const side of [-1, 1]) {
    kit.piece(f.at(u + side * w / 2, 0.02), y + 1.40, 0.13, 2.8, 0.15, f, finish);
  }
}

export function restyleBlock(kit, building, terrain, heightAt, kind, options = {}) {
  const style = DISTRICT_STYLE[kind];
  const seed = buildingSeed(building.id);
  const wall = options.wall ?? style.walls[Math.floor(seed * style.walls.length)];
  const old = buildingPlacement(building, terrain);
  const base = old.baseY;
  // 设计层数只改没有层数、来源为通用估计的指定对象；其他对象保持源高度。
  const override = building.heightSource === 'estimate' && !(building.levels > 0) && options.floors > 0;
  const height = override ? options.floors * (kind === 'sea' ? 3.95 : 3.65) : building.height;
  const roof = base + height;
  const bottom = old.foundationBottomY ?? old.minY;
  for (const [i, poly] of building.polygons.entries()) {
    const id = `${building.id}:district:${i}`;
    const ring = poly.outer;
    const ordered = signedRingArea(ring) > 0 ? ring : [...ring].reverse();
    const levelCount = building.levels > 0 ? building.levels : override ? options.floors : Math.round(height / 3.55);
    const story = height / Math.max(1, levelCount);
    const baseFloor = 3.06;
    let opening;
    if (options.open && kind !== 'nantou' && building.minHeight === 0 && story >= baseFloor && height > baseFloor + 0.7) {
      const candidates = ordered.flatMap((b, j) => {
        const a = ordered[(j + 1) % ordered.length];
        const length = Math.hypot(a.x - b.x, a.z - b.z);
        if (length < 6.8) return [];
        const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
        const w = Math.min(5.2, length * 0.56), d = 2.55, u = length / 2;
        const entry = f.at(u, 0.8);
        const probes = [-w / 2, 0, w / 2].flatMap(x => [0.27, 1.2].map(v => f.at(u + x, v)));
        if (!options.front?.(entry) || !probes.every(p => {
          const h = heightAt(p.x, p.z);
          return Number.isFinite(h) && Math.abs(h - base) < 0.13 && options.entryClear(p, h, 2.6, building.id);
        }) || ![-w / 2, 0, w / 2].every(x => [-0.12, -d].every(v => {
          const p = f.at(u + x, v), h = heightAt(p.x, p.z);
          return polygonContainsInclusive(poly, p.x, p.z) && Number.isFinite(h) && Math.abs(h - base) < 0.13;
        }))) return [];
        return [{ j, f, u, w, d, length }];
      });
      candidates.sort((a, b) => b.length - a.length);
      opening = candidates[0];
    }
    const provenance = override ? 'scene-design-height' : 'osm-footprint';
    if (opening) {
      const { j, f, u, w, d } = opening;
      const right = u + w / 2, left = u - w / 2;
      const recess = ordered.flatMap((p, k) => j === k
        ? [p, f.at(right, 0), f.at(right, -d), f.at(left, -d), f.at(left, 0)] : [p]);
      kit.part(solid(`${id}:open-shop`, building, { outer: recess, holes: poly.holes }, bottom, base + baseFloor, wall));
      kit.part(solid(id, building, poly, base + baseFloor, roof, wall, provenance));
      openShop(kit, building, f, u, base, w, d, kind, Math.floor(seed * 24), style);
      options.registerShop?.({ id: building.id, mouth: f.at(u, 0), interior: f.at(u, -1.65),
        approach: f.at(u, 4.8) });
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
      kit.piece(f.at(length / 2, 0.035), roof - 0.22, length, 0.25, 0.13, f, style.trim, { detail: false });
      for (let k = 0; k < count; k++) {
        const u = (k + 0.5) * bay;
        const p = f.at(u, 0.12);
        const ground = heightAt(p.x, p.z);
        if (!Number.isFinite(ground)) continue;
        const shop = options.front?.(p) !== false && Math.abs(ground - base) < 0.6 && building.minHeight === 0;
        const row = (y, w, h, v, d, material, detail = true) =>
          kit.piece(f.at(u, v), y, w, h, d, f, material, { detail });
        for (let floor = 0; floor < levelCount; floor++) {
          if (floor === 0 && j === opening?.j && Math.abs(u - opening.u) < opening.w / 2 + bay * 0.47) continue;
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
  restyleBlock(kit, building, terrain, heightAt, 'oct', { floors: 3, wall: 'chalk', front: () => false });
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
