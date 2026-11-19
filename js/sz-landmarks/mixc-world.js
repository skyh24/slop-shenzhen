import { baseAt, spanPart } from './parts.js';
import { rect, volume } from './model-profile.js';
import { elephantParts, trunkOpening } from './mixc-elephant.js';
import { distanceToRing, signedRingArea } from '../sz-polygon.js';
import { terrainHeight } from '../sz-terrain.js';
import { recessedShopRing, shopFurniture, shopOpenings } from '../sz-shopfront.js';
import { cutRing } from './retail-sections.js';

export const sourceIds = ['way/533679847', 'way/1268947103', 'way/1268947086'];

// 两幅桥中线、宽度取锁定 OSM 四角。桥端略搭上楼板，栏板只沿长边布置。
const links = [
  { id: '1268947093', from: [-10581.1, 109.05], to: [-10574.0, 109.05], width: 3.3 },
  { id: '1268947084', from: [-10584, 134.9], to: [-10584, 153.0], width: 3.6 }
];

// 对着高街、两楼之间的巷道及水广场开门。中楼南侧让开外梯和上口平台。
const streetFaces = {
  middle: (p, f) => (f.c > 0.9 && (p.x < -10640 || p.x > -10602)) || -f.s > 0.9,
  east: (p, f) => f.c > 0.9 || f.s > 0.9 || (-f.s > 0.9 && p.z > 113),
  south: (_p, f) => f.c < -0.9
};

const fixtureStyles = { wood: 'operaCopper', stone: 'shoppingParkStone', metal: 'tencentRoof',
  terra: 'operaCopper', brass: 'shoppingParkStone', green: 'bayCabinGlass', ivory: 'elephantPearl' };
const shopSigns = ['mixcBooks', 'mixcCafe', 'mixcDesign'];

// 南楼与较大的商场裙房共用北侧折角的三点。沿南楼其余外墙回切裙房，
// 让普通楼、碰撞和屋顶细节继续使用同一个剩余轮廓及原楼高。
const annexId = 'overture/f206ddd9-8a24-4a4e-9d1f-fe22dce27417';
function mallRemainder(annex, south) {
  if (!annex || annex.polygons.length !== 1 || south.polygons.length !== 1) return null;
  const shell = annex.polygons[0], storefront = south.polygons[0];
  if (shell.holes.length || storefront.holes.length) return null;
  const ccw = ring => signedRingArea(ring) > 0 ? ring : [...ring].reverse();
  const outer = ccw(shell.outer), inner = ccw(storefront.outer);
  const same = (a, b) => a.x === b.x && a.z === b.z;
  const rotate = (ring, i) => ring.slice(i).concat(ring.slice(0, i));
  for (const [i, p] of outer.entries()) {
    const j = inner.findIndex(q => same(p, q));
    if (j < 0) continue;
    const a = rotate(outer, i), b = rotate(inner, j);
    if (!same(a[1], b[1]) || !same(a[2], b[2])) continue;
    const cut = b.slice(3).reverse();
    if (distanceToRing([a.at(-1), a[0]], cut[0].x, cut[0].z) > 0.12
      || distanceToRing([a[2], a[3]], cut.at(-1).x, cut.at(-1).z) > 0.12) continue;
    const remaining = [...cut, ...a.slice(3)];
    const xs = remaining.map(q => q.x), zs = remaining.map(q => q.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    return { ...annex, polygons: [{ outer: remaining, holes: [] }], minX, maxX, minZ, maxZ,
      cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  }
  return null;
}

function groundShops(building, ring, label, floor, ceiling, heightAt, roadHeight, model) {
  const ordered = signedRingArea(ring) > 0 ? ring : [...ring].reverse();
  const openings = shopOpenings(building, { outer: ring, holes: [] }, ordered, floor, heightAt, {
    front: streetFaces[label], spacing: 8.4, minLength: 7, depth: 3.2,
    entryClear: p => !Number.isFinite(roadHeight?.(p.x, p.z))
  });
  let index = 0;
  for (const { f, u, w, d, approach, floorRing } of Array.from(openings.values()).flat()) {
    const id = `mixc:${label}:entry:${index}`;
    const yaw = -Math.atan2(f.s, f.c);
    const box = (du, v, lo, hi, width, depth, style, name) => model.parts.push(volume(id + ':' + name,
      building, rect(f.at, u + du, v, width, depth), floor + lo, floor + hi, style));
    const detail = (du, v, y, width, height, depth, style) => model.trim.push({
      ...f.at(u + du, v), y: floor + y, yaw, size: [width, height, depth], style });
    const h = ceiling - floor;
    const finish = index % 2 ? 'operaCopper' : 'tencentRoof';
    box(0, 0.22, h - 0.30, h, w + 0.35, 0.64, finish, 'canopy');
    for (const side of [-1, 1]) detail(side * w / 2, 0, (h - 0.3) / 2, 0.14, h - 0.3, 0.16, finish);
    detail(0, -d + 0.025, h / 2, w - 0.06, h - 0.04, 0.05, 'shoppingParkStone');
    model.signs.push({ ...f.at(u, 0.10), y: ceiling - 0.56, width: w * 0.72, height: 0.45,
      style: shopSigns[index % shopSigns.length], yaw });
    model.patches.push({ style: 'sportsApron', ring: floorRing });
    let fixtureIndex = 0;
    shopFurniture(w, d, index, 'metal',
      (du, v, lo, hi, width, depth, mat) => box(du, v, lo, hi, width, depth, fixtureStyles[mat], 'fixture:' + fixtureIndex++),
      (du, v, y, width, height, depth, mat) => detail(du, v, y, width, height, depth, fixtureStyles[mat]));
    model.approaches.push({ from: f.at(u, -1.55), to: f.at(u, approach), halfWidth: 1.05 });
    index++;
  }
  return recessedShopRing(ordered, openings);
}

export function build(source, terrain, { groundHeight, roadHeight } = {}) {
  const [middle, east, south] = sourceIds.map(id => source.get(id));
  const model = { parts: [], patches: [], trim: [], signs: [], approaches: [] };
  const { parts } = model;
  const heightAt = groundHeight ?? ((x, z) => terrainHeight(terrain, x, z));
  const base = baseAt(middle, terrain), deckY = base + 10.5;
  const rail = (id, building, a, b, y) => {
    parts.push(spanPart(id, building, { ...a, y: y + 1.10 }, { ...b, y: y + 1.10 },
      0.13, 0.13, 1.10, 'mixcBalustrade'));
  };
  function shops(building, upper, label, ring = building.polygons[0].outer) {
    const floor = baseAt(building, terrain);
    const id = 'mixc:' + label;
    const recessed = groundShops(building, ring, label, floor, base + 4.9, heightAt, roadHeight, model);
    parts.push(volume(id + ':windows', building, recessed, floor, base + 4.9, 'shoppingParkStorefront'),
      volume(id + ':lintel', building, ring, base + 4.9, base + 5.3, 'shoppingParkStone'),
      volume(id + ':second', building, ring, base + 5.3, deckY - 0.45, 'shoppingParkGlass'),
      volume(id + ':gallery', building, ring, deckY - 0.45, deckY, 'shoppingParkStone', { roofContact: true }),
      volume(id + ':shops', building, upper, deckY, floor + building.height - 0.45, 'shoppingParkBase'),
      volume(id + ':cornice', building, upper, floor + building.height - 0.45, floor + building.height,
        'operaPearl', { heightSource: building.heightSource }));
  }
  const middleTop = cutRing(middle.polygons[0].outer, 'x', -10585.5, false);
  shops(middle, cutRing(middleTop, 'z', 127.5, false), 'middle');
  // 橱窗和店间墙分开，六间店各留 1.8 米入口。上方连续雨棚承接退进的上层店面。
  const at = (x, z) => ({ x, z });
  const canopy = cutRing(cutRing(middleTop, 'z', 127.5, true), 'z', 131.8, false);
  const roofY = base + middle.height;
  parts.push(volume('mixc:shop-canopy', middle, canopy, roofY - 0.55, roofY, 'operaPearl'));
  for (let i = 0; i < 6; i++) {
    const left = -10646.65 + i * 10.15;
    parts.push(volume('mixc:party-wall:' + i, middle, rect(at, left, 129.25, 0.3, 3.5),
      deckY, roofY - 0.55, 'shoppingParkStone'));
    const style = i % 2 ? 'shoppingParkGlass' : 'shoppingParkStorefront';
    parts.push(volume('mixc:display:' + i, middle, rect(at, left + 4.23, 130.9, 8.16, 0.22),
      deckY, roofY - 0.95, style));
    parts.push(volume('mixc:fascia:' + i, middle, rect(at, left + 5.1, 131.04, 9.9, 0.36),
      roofY - 0.95, roofY - 0.55, i % 2 ? 'shoppingParkStone' : 'operaCopper'));
  }
  const eastOutline = trunkOpening(east.polygons[0].outer);
  const eastUpper = cutRing(eastOutline, 'x', -10569.4, true);
  const terrace = cutRing(eastUpper, 'x', -10526.5, true);
  const seat = deckY + 5.5;
  shops(east, cutRing(eastUpper, 'x', -10526.5, false), 'east', eastOutline);
  parts.push(volume('mixc:water-plaza-front', east, terrace, deckY, seat - 0.35, 'mixcWaterFacade'),
    volume('mixc:elephant-terrace', east, terrace, seat - 0.35, seat, 'shoppingParkStone', { roofContact: true }),
    ...elephantParts(east, base, seat));
  rail('mixc:elephant-parapet:south', east, { x: -10513.32, z: 108.75 }, { x: -10513.12, z: 134.0 }, seat);
  rail('mixc:elephant-parapet:north', east, { x: -10513.40, z: 103.0 }, { x: -10513.36, z: 105.75 }, seat);
  shops(south, cutRing(south.polygons[0].outer, 'z', 157.6, true), 'south');
  for (const { id, from, to, width } of links) {
    const a = { x: from[0], z: from[1], y: deckY }, b = { x: to[0], z: to[1], y: deckY };
    parts.push(spanPart('mixc:bridge:' + id, middle, a, b, width, width, 0.45, 'shoppingParkStone', { roofContact: true }));
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (const side of [-1, 1]) {
      const dx = (b.z - a.z) / length * (width / 2 - 0.07) * side;
      const dz = (a.x - b.x) / length * (width / 2 - 0.07) * side;
      rail(`mixc:rail:${id}:${side}`, middle, { x: a.x + dx, z: a.z + dz }, { x: b.x + dx, z: b.z + dz }, deckY);
    }
  }
  // 外廊临空栏板让开两处真实桥口和南侧模型楼梯的上口。
  const edges = [
    [middle, -10581.0, 111.0, -10580.85, 134.95], [middle, -10586.0, 135.0, -10605.1, 135.2],
    [middle, -10610.0, 135.2, -10647.0, 135.4], [east, -10574.1, 111.0, -10574.0, 134.5],
    [south, -10585.95, 152.9, -10638.65, 153.25], [south, -10582.05, 152.9, -10578.5, 152.85]
  ];
  for (const [i, [building, ax, az, bx, bz]] of edges.entries()) {
    rail('mixc:gallery-rail:' + i, building, { x: ax, z: az }, { x: bx, z: bz }, deckY);
  }
  // 外梯使用连续斜面承托，踏步前缘为同坡的可见分缝；顶平台直接搭接三层回廊。
  const foot = { x: -10636.0, z: 138.0 }, head = { x: -10608.1, z: 138.0 };
  const ground = groundHeight?.(foot.x, foot.z);
  const footY = Number.isFinite(ground) ? ground : base;
  const flight = spanPart('mixc:stair', middle, { ...foot, y: footY + 0.04 }, { ...head, y: deckY },
    2.8, 2.8, 0.35, 'mixcStair', { roofContact: true, climbableFromGround: true });
  parts.push(flight, spanPart('mixc:stair-landing', middle, { x: head.x + 1.4, z: 139.4, y: deckY },
    { x: head.x + 1.4, z: 134.9, y: deckY }, 2.8, 2.8, 0.45, 'shoppingParkStone', { roofContact: true }));
  for (const side of [-1, 1]) {
    parts.push(spanPart('mixc:stair-rail:' + side, middle, { ...foot, z: foot.z + side * 1.34, y: footY + 1.05 },
      { ...head, z: head.z + side * 1.34, y: deckY + 1.05 }, 0.1, 0.1, 1.05, 'mixcBalustrade'));
  }
  const remainder = mallRemainder(source.get(annexId), south);
  if (remainder) model.buildingOverrides = [remainder];
  return model;
}
