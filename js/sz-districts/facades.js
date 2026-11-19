import { buildingPlacement, buildingSeed } from '../sz-building-layout.js';
import { polygonBoxOverlaps } from '../building-collision.js';
import { polygonContainsInclusive, signedRingArea } from '../sz-polygon.js';
import { recessedShopRing, shopFurniture, shopOpenings } from '../sz-shopfront.js';
import { STR } from '../sz-strings.js';
import { frame, railing, solid } from './kit.js';

const DISTRICT_STYLE = {
  sea: { walls: ['ivory', 'chalk', 'tan'], trim: 'blue', metal: 'silver', bays: 4.4 },
  oct: { walls: ['loft', 'brick', 'concrete', 'chalk'], trim: 'concrete', metal: 'steel', bays: 3.35 },
  nantou: { walls: ['oldBrick', 'tan', 'chalk', 'brick'], trim: 'granite', metal: 'green', bays: 2.55 }
};

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
  shopFurniture(w, d, i, style.metal,
    (du, v, lo, hi, width, depth, mat) => frameAt(f.at(u + du, v), lo, hi, width, depth, mat),
    (du, v, h, width, tall, depth, mat) => kit.piece(f.at(u + du, v), y + h, width, tall, depth, f, mat));
  for (const side of [-1, 1]) {
    kit.piece(f.at(u + side * w / 2, 0.02), y + (top - 0.2) / 2, 0.13, top - 0.2, 0.15, f, finish);
  }
}

function addDisplayWindow(kit, f, u, y, width, trim) {
  // 展示窗均抬离地面，原墙内留实；横向卷帘箱、侧槽和窗台用浅体量表现。
  kit.piece(f.at(u, 0.026), y + 1.55, width + 0.16, 2.1, 0.08, f, 'steel');
  for (const side of [-1, 1]) {
    kit.piece(f.at(u + side * width / 4, 0.071), y + 1.52, width / 2 - 0.075, 1.76, 0.046, f, 'glass');
    kit.piece(f.at(u + side * width / 2, 0.10), y + 1.55, 0.07, 2.01, 0.12, f, trim);
  }
  kit.piece(f.at(u, 0.092), y + 1.52, 0.065, 1.78, 0.082, f, 'steel');
  kit.piece(f.at(u, 0.107), y + 2.58, width + 0.20, 0.21, 0.22, f, 'silver');
  kit.piece(f.at(u, 0.11), y + 0.56, width + 0.19, 0.12, 0.24, f, 'stone');
}

export function restyleBlock(kit, building, terrain, heightAt, kind, options = {}) {
  const style = DISTRICT_STYLE[kind];
  const seed = buildingSeed(building.id);
  const wall = options.wall ?? style.walls[Math.floor(seed * style.walls.length)];
  // 街区专模的门槛和首层净空沿用已校核的基准。
  const old = buildingPlacement(building, terrain, { useFootprintCorners: false });
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
    const rowHouse = kind === 'oct' && override;
    const baseFloor = rowHouse ? 3.44 : 3.06;
    const openings = options.open && building.minHeight === 0 && story >= baseFloor && height > baseFloor + 0.7
      ? shopOpenings(building, poly, ordered, base, heightAt, {
        front: options.entryFront ?? options.front, entryClear: options.entryClear,
        spacing: kind === 'sea' ? 6.7 : kind === 'oct' ? 6 : 5.1,
        depth: kind === 'nantou' ? 2.35 : 2.55, minLength: kind === 'nantou' ? 4.5 : 5.5
      }) : new Map();
    const provenance = override ? 'scene-design-height' : 'osm-footprint';
    if (openings.size) {
      const recess = recessedShopRing(ordered, openings);
      kit.part(solid(`${id}:open-shop`, building, { outer: recess, holes: poly.holes }, bottom, base + baseFloor, wall));
      kit.part(solid(id, building, poly, base + baseFloor, roof, wall, provenance));
      let shopIndex = Math.floor(seed * 24);
      for (const bays of openings.values()) {
        for (const { f, u, w, d, approach, floorRing } of bays) {
          openShop(kit, building, f, u, base, w, d, baseFloor, kind, shopIndex++, style);
          options.registerShop?.({ id: building.id, floorRing, mouth: f.at(u, 0), interior: f.at(u, -1.55),
            approach: f.at(u, approach) });
        }
      }
    } else kit.part(solid(id, building, poly, bottom, roof, wall, provenance));
    for (let j = 0; j < ordered.length; j++) {
      const a = ordered[(j + 1) % ordered.length], b = ordered[j];
      const length = Math.hypot(a.x - b.x, a.z - b.z);
      if (length < 2.3) continue;
      const f = frame(a.x, a.z, b.x - a.x, b.z - a.z);
      const canProject = (u, depth, y, w, h) => {
        const center = f.at(u, (depth + 0.01) / 2);
        // 排除折回的源外墙或同栋另一个体块。留出 1 cm 避免把本墙的接缝计作相交。
        if (building.polygons.some(footprint => polygonBoxOverlaps(footprint, center.x, center.z,
          w / 2, (depth - 0.01) / 2, f.c, -f.s))) return false;
        return [-w / 2, 0, w / 2].every(d =>
          [0.15, depth].every(v => options.clear?.(f.at(u + d, v), y, h, building.id) !== false));
      };
      const count = Math.max(1, Math.round(length / style.bays));
      const bay = length / count;
      const shopBays = openings.get(j) ?? [];
      kit.piece(f.at(length / 2, 0.035), roof - 0.22, length, 0.25, 0.13, f, rowHouse ? 'blue' : style.trim, { detail: false });
      if (kind === 'oct' && override && shopBays.length) {
        // 联排铺面按开间分段；浅色墙面的分缝延续到屋檐，仍使用原建筑轮廓。
        for (const { u, w } of shopBays) {
          const upper = height - baseFloor - 0.45;
          const x = u - w / 2 - 0.10;
          kit.piece(f.at(x, 0.055), base + baseFloor + upper / 2, 0.22, upper, 0.16, f, style.trim);
          kit.piece(f.at(u, 0.07), roof - 0.42, w + 0.34, 0.24, 0.19, f, 'blue');
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
          if (floor === 0 && building.minHeight === 0 && story >= 3.0 && Math.abs(ground - y) < 0.13
            && options.displayFront?.(p, f) && canProject(u, 0.24, y + 0.5, bay * 0.78 + 0.20, 2.2)) {
            addDisplayWindow(kit, f, u, y, bay * 0.78, style.trim);
            continue;
          }
          const window = bay * (rowHouse || (floor === 0 && shop) ? 0.83 : 0.62);
          const h = Math.min(story * (floor === 0 && shop ? 0.63 : 0.51), 2.6);
          if (y + h + 0.7 > roof) continue;
          const cy = y + (floor === 0 && shop ? h / 2 + 0.19 : story * 0.53);
          const depth = kind === 'oct' && floor === 1 ? 1.72 : kind === 'nantou' ? 0.73 : 1.12;
          const width = Math.min(bay - 0.22, window + (kind === 'oct' ? 1.1 : 0.38));
          const balcony = options.balconies && shop && floor > 0 && floor < 4 && levelCount <= 6
            && (k + j + Math.floor(seed * 8)) % (kind === 'nantou' ? 5 : 3) === 0
            && canProject(u, depth, y - 0.24, width, 1.34);
          const glass = floor === 0 || (k + j + floor) % 4 === 0 ? 'glass' : 'darkGlass';
          if (balcony) {
            // 左扇保留窗台，右侧落地门与板面共用门槛；整组框、玻璃与栏板沿同一开间排布。
            const doorHeight = cy + h / 2 - y;
            const pane = window / 2;
            for (const [du, centerY, paneHeight] of [[-pane / 2, cy, h], [pane / 2, y + doorHeight / 2, doorHeight]]) {
              kit.piece(f.at(u + du, 0.028), centerY, pane, paneHeight + 0.08, 0.14, f, style.trim);
              kit.piece(f.at(u + du, 0.108), centerY, pane - 0.10, paneHeight - 0.08, 0.065, f, glass);
            }
          } else {
            row(cy, window + 0.17, h + 0.14, 0.026, 0.14, floor === 0 && shop ? style.metal : style.trim);
            row(cy, window, h, 0.108, 0.065, glass, levelCount < 9);
            for (const side of [-1, 1]) {
              kit.piece(f.at(u + side * window / 6, 0.147), cy, 0.045, h, 0.06, f, style.metal);
            }
          }
          if (!floor && shop) {
            row(cy + h / 2 + 0.22, window, 0.23, 0.15, 0.11, ['terra', 'green', 'blue', 'wood'][(k + j) % 4]);
            if ((k + j) % 2 === 0 && canProject(u, 0.88, y + 2.7, window + 0.25, 0.3)) {
              row(y + 2.75, window + 0.36, 0.14, 0.48, 0.96, k % 3 === 0 ? style.trim : style.metal);
              row(y + 2.62, window + 0.34, 0.10, 0.94, 0.075, 'lamp');
            }
          }
          if (!balcony) continue;
          kit.box(f.at(u, depth / 2), y - 0.23, y, width, depth + 0.06, f, style.trim, building);
          railing(kit, f, y, u - width / 2, u + width / 2, depth, style.metal);
          for (const side of [-1, 1]) {
            const q = f.at(u + side * width / 2, 0);
            const sideFrame = frame(q.x, q.z, -f.s, f.c);
            railing(kit, sideFrame, y, 0, depth, 0, style.metal);
          }
          const planter = f.at(u - width * 0.28, depth - 0.24);
          kit.piece(planter, y + 0.30, 0.48, 0.37, 0.42, f, 'terra');
          kit.piece(planter, y + 0.63, 0.49, 0.50, 0.44, f, 'leaf');
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

export function buildB10(kit, building, terrain, clear) {
  const placement = buildingPlacement(building, terrain);
  const y = placement.baseY;
  const estimatedHeight = building.heightSource === 'estimate' && !(building.levels > 0);
  const height = estimatedHeight ? 10.95 : building.height;
  const roof = y + height;
  const screenBase = y + height * 0.61;
  const provenance = estimatedHeight ? 'scene-design-height' : 'osm-footprint';
  const poly = building.polygons[0];
  const ring = signedRingArea(poly.outer) < 0 ? poly.outer : [...poly.outer].reverse();
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { f: frame(a.x, a.z, b.x - a.x, b.z - a.z), length: Math.hypot(b.x - a.x, b.z - a.z) };
  });

  // 都市实践照片中的原厂房白墙与上部拉伸网。尺寸为视觉估计，场景仍以闭合实体表达未开放空间。
  const whiteBox = solid('oct-b10:white-box', building, poly, placement.foundationBottomY ?? placement.minY,
    screenBase, 'chalk', provenance);
  kit.part({ ...whiteBox, topFace: false });
  const screen = solid('oct-b10:screen', building, poly, screenBase, roof, 'b10Screen', provenance);
  kit.part({ ...screen, bottomFace: false });

  for (const { f, length } of edges) {
    const south = f.c > 0.7;
    const west = f.s > 0.7;
    const portal = south ? length * 0.56 : length * 0.48;
    const portalWidth = south ? 6.6 : 4.4;
    const bays = Math.max(1, Math.round(length / 4.9));
    const depth = south ? 2.15 : 1.45;
    const width = portalWidth + (south ? 3.7 : 0.8);
    const canopyY = y + (south ? 3.48 : 3.27);
    const canProject = (south || west) && [-width / 2, 0, width / 2].every(offset =>
      [0.15, depth].every(v => clear(f.at(portal + offset, v), canopyY, south ? 1.42 : 0.22, building.id)));
    const balconyBay = south && canProject ? Math.floor(portal / length * bays) : -1;
    for (let i = 0; i < bays; i++) {
      const u = (i + 0.5) * length / bays;
      const w = Math.min(2.15, length / bays * 0.57);
      for (const [j, h] of [[0, 1.65], [1, 1.3]]) {
        if ((south || west) && !j && Math.abs(u - portal) < (portalWidth + w) / 2 + 0.5) continue;
        const cy = y + 1.90 + j * 3.28;
        if (cy + h / 2 + 0.25 > screenBase) continue;
        const lite = south && j === 1 && Math.abs(u - portal) < 5.3;
        if (j === 1 && i === balconyBay) {
          const threshold = canopyY + 0.23;
          const top = cy + h / 2;
          kit.piece(f.at(u, 0.033), (threshold + top) / 2, w, top - threshold, 0.078, f, 'glass');
          continue;
        }
        kit.piece(f.at(u, 0.033), cy, w, h, 0.078, f, lite ? 'glass' : 'b10Reveal');
        // 浅凹窗通过暗侧边、浅色封板和薄窗台产生，沿源墙线摆放。
        if (!lite) kit.piece(f.at(u + 0.045, 0.079), cy - 0.045, w - 0.18, h - 0.18, 0.035, f, 'loft');
        kit.piece(f.at(u, 0.091), cy - h / 2, w + 0.13, 0.085, 0.15, f, 'chalk');
      }
    }
    if (!south && !west) continue;
    kit.piece(f.at(portal, 0.061), y + 1.51, portalWidth, 2.96, 0.14, f, 'darkGlass', { detail: false });
    for (const side of [-1, 0, 1]) {
      kit.piece(f.at(portal + side * portalWidth / 2.03, 0.14), y + 1.51, 0.075, 2.98, 0.11, f, 'silver');
    }
    if (canProject) {
      kit.box(f.at(portal, depth / 2), canopyY, canopyY + 0.23, width, depth, f, 'white', building,
        `oct-b10:${south ? 'south-balcony' : 'west-canopy'}`);
      if (south) {
        railing(kit, f, canopyY + 0.23, portal - width / 2, portal + width / 2, depth - 0.05, 'silver');
        for (const side of [-1, 1]) {
          const end = f.at(portal + side * width / 2, 0);
          railing(kit, frame(end.x, end.z, -f.s, f.c), canopyY + 0.23, 0, depth - 0.05, 0, 'silver');
        }
      }
      kit.piece(f.at(portal, depth * 0.65), canopyY - 0.032, portalWidth * 0.58, 0.058, 0.085, f, 'lamp');
      kit.lamp(f.at(portal, depth * 0.68), canopyY - 0.28, 35, 8);
    }
    if (south) kit.label(f.at(length * 0.49, 0.031), screenBase + (roof - screenBase) * 0.57,
      7.4, 1.38, f, STR.districts.b10, '#f3eee4', '#8e938e');
  }
  return { base: y, roof };
}
