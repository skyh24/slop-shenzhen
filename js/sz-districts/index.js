import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps } from '../building-collision.js';
import { buildingPlacement } from '../sz-building-layout.js';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { STR } from '../sz-strings.js';
import { buildB10, restyleBlock } from './facades.js';
import { addBasin, addFixtures, addLowFence, addWalkLamps, buildDistrictGround, DISTRICT_FOCUS } from './ground.js';
import { createDistrictKit, frame } from './kit.js';
import { buildMinghua, MINGHUA_ID } from './minghua.js';
import { buildSouthGate, buildSouthPaifang, SOUTH_GATE_ID } from './nantou.js';

const B10 = 'way/435827468';
// 以核对过的对象为白名单，保留未核实邻楼、原有高楼及车行路线。
const OCT_BLOCKS = [
  ['way/333871652', 'brick', null, true], ['way/435827465', 'loft', null, false],
  ['way/435827461', 'brick', 4, true], ['way/435827469', 'loft', 3, true],
  ['way/532810249', 'concrete', 2, true], ['way/532810260', 'loft', null, true],
  ['way/435827467', 'concrete', 4, false], ['way/435827466', 'chalk', null, false],
  ['way/532810264', 'brick', 3, true], ['way/532810266', 'chalk', null, true],
  ['way/532810267', 'loft', 4, true]
];
const SEA_BLOCKS = [
  ['way/135951438', 'ivory', 3, true], ['way/135951443', 'chalk', 3, true],
  ['way/492141833', 'ivory', 2, true], ['way/492141834', 'tan', 3, true],
  ['way/492613720', 'chalk', 2, true], ['way/492613721', 'ivory', null, true],
  ['way/543176168', 'ivory', 3, true], ['way/543176178', 'chalk', 2, true],
  ['way/740022039', 'chalk', 3, true],
  ['way/543176179', 'chalk', 2, true], ['way/543176180', 'ivory', 2, true],
  ['way/543176181', 'tan', 2, true], ['way/543176182', 'ivory', 2, true]
];
const NANTOU_BLOCKS = [
  ['way/533923392', 'oldBrick', null, false], ['way/1160015756', 'oldBrick', 3, true],
  ['way/1445314874', 'chalk', 3, true], ['way/1445314875', 'brick', 4, false],
  ['overture/a9079a76-1aeb-43a8-8cc8-d3ac374b2e08', 'tan', null, true],
  ['overture/098849e1-04ec-4cb6-9fd6-9b5716df3675', 'chalk', null, true],
  ['overture/863945ce-6aef-48e5-a52e-0b818f05eac5', 'brick', 4, true],
  ['overture/40211e5c-abc9-4e8a-9a59-511c056cab90', 'oldBrick', 3, false]
];

const FIXTURES = {
  sea: [[-14800, 6591, 'lamp'], [-14789, 6618, 'bench', -0.58], [-14758, 6589, 'bench', 0.30],
    [-14614, 6554, 'lamp'], [-14596, 6660, 'lamp'], [-14608, 6687, 'bench', -0.72],
    [-14620, 6695, 'bench', -0.55], [-14627, 6781, 'lamp'], [-14718, 6741, 'lamp'],
    [-14712, 6721, 'bench', 0.78], [-14706, 6633, 'bench', 0.65], [-14764, 6611, 'lamp'],
    [-14790, 6578, 'flowers', 0.43], [-14612, 6700, 'flowers', -0.55], [-14709, 6723, 'flowers', 0.76],
    [-14787, 6573, 'table', 0.43], [-14781, 6575, 'table', 0.43], [-14608, 6694, 'table', -0.55]],
  oct: [[-6820, 426, 'lamp'], [-6834, 427.1, 'bench', -0.08], [-6845, 425, 'art', -0.08],
    [-6861, 426.4, 'bench', -0.08], [-6879, 434.1, 'bench', -0.08],
    [-6891, 426, 'lamp'], [-6817.8, 501, 'lamp'], [-6818.0, 522, 'bench', 1.45],
    [-6853, 426.5, 'flowers', -0.08], [-6883, 434.2, 'flowers', -0.08]],
  nantou: [[-14283, 288, 'lamp'], [-14267, 269, 'bench', 1.5], [-14282, 251, 'bench', 1.5],
    [-14286, 218, 'lamp'], [-14291, 199, 'bench', -0.08], [-14262, 200, 'lamp'],
    [-14268, 186, 'bench', -0.2], [-14274, 113, 'lamp'], [-14275, 44, 'bench', -0.05],
    [-14289, 237, 'flowers', 0.15], [-14256, 233, 'flowers', -0.12], [-14264, 191, 'flowers', -0.12]]
};
// 栏杆只接选中的种植边，通道、树池出入口及广场四周仍保留开口。
const GREEN_EDGES = {
  sea: [[[-14617, 6691], [-14610, 6684]], [[-14622, 6696], [-14629, 6702]],
    [[-14796, 6581], [-14786, 6586]]],
  oct: [[[-6859, 424.4], [-6850, 424.8]], [[-6878, 425.1], [-6868, 425.7]],
    [[-6892, 434.1], [-6884, 434.7]]],
  nantou: [[[-14281, 242], [-14281, 220]], [[-14265, 242], [-14265, 220]],
    [[-14298, 218], [-14283, 218]], [[-14263, 217], [-14252, 216]]]
};
const TREE_SITES = {
  sea: [[-14791, 6584], [-14804, 6616], [-14631, 6552], [-14619, 6699], [-14613, 6687]],
  oct: [[-6854, 425.6], [-6872, 425.5], [-6889, 434.3], [-6819, 415], [-6817, 509]],
  nantou: [[-14289, 280], [-14283, 258], [-14292, 210], [-14262, 195], [-14294, 189]]
};
const ARRIVALS = {
  sea: ['sea-world-quay', STR.districts.seaWalk, -14803, 6570, 0.995],
  oct: ['oct-loft-court', STR.districts.octWalk, -6816, 397, 0.06],
  nantou: ['nantou-south-axis', STR.districts.nantouWalk, -14273.06, 289.2, Math.PI]
};
const LANDMARK_IDS = { sea: 'sea-world', oct: 'oct-loft', nantou: 'nantou-ancient-city' };

function addRetailCanopy(kit, building, terrain) {
  const y = buildingPlacement(building, terrain).baseY;
  for (const [i, polygon] of building.polygons.entries()) {
    kit.part({ id: `sea-world:retail-canopy:${i}`, sourceId: building.id, polygon,
      minY: y + 3.6, maxY: y + 3.95, heightSource: 'estimate', layoutSource: 'osm-footprint',
      minX: building.minX, maxX: building.maxX, minZ: building.minZ, maxZ: building.maxZ, style: 'silver' });
  }
}

function addLoftStairs(kit, source, heightAt, clear) {
  // A3+ 外廊旁的楼梯仅作设计展示，底部有闭合栏门。没有开放高程资料，不注册可行走屋面。
  const f = frame(-6841, 482.9, -0.996, 0.087);
  const base = heightAt(-6841, 482.9);
  if (!Number.isFinite(base) || ![0, 3, 6].every(u => clear(f.at(u, -0.7), base, 4.5, source.id, 0.55))) return;
  for (let i = 0; i < 15; i++) {
    kit.box(f.at(0.37 + i * 0.38, -0.66), base + i * 0.21, base + (i + 1) * 0.21,
      0.40, 1.18, f, 'steel', source);
    for (const v of [-1.29, -0.04]) kit.piece(f.at(0.37 + i * 0.38, v),
      base + (i + 1) * 0.21 + 0.5, 0.05, 1.0, 0.05, f, 'steel');
  }
  for (const v of [-1.29, -0.04]) {
    kit.piece(f.at(3.02, v), base + 2.64, 6.34, 0.06, 0.07, f, 'steel', { roll: 0.50 });
  }
  const p = f.at(0.12, -0.66);
  const gate = frame(p.x, p.z, -f.s, f.c);
  kit.box(p, base, base + 1.25, 1.32, 0.12, gate, 'steel', source, 'oct-loft:closed-stair-gate');
  kit.label(gate.at(0, 0.073), base + 1.04, 0.91, 0.22, gate, STR.districts.closed);
  kit.box(f.at(5.95, -0.66), base + 2.95, base + 3.15, 0.94, 1.35, f, 'steel', source);
}

export function buildSzDistricts(scene, site, { water, roads, carriagewayOccupied }) {
  const group = new THREE.Group();
  group.name = 'shenzhen-three-districts';
  const kit = createDistrictKit(group);
  const byId = new Map(site.buildings.map(building => [building.id, building]));
  const minghua = byId.get(MINGHUA_ID);
  // 生产水域由同一 OSM basin 裁切，匹配两个位于池内的点；岸线缺失时不接管源船。
  const basin = minghua && water.find(poly => polygonContainsInclusive(poly, minghua.cx, minghua.cz)
    && polygonContainsInclusive(poly, -14664, 6725));
  const active = [basin && 'sea', byId.has(B10) && 'oct', byId.has(SOUTH_GATE_ID) && 'nantou'].filter(Boolean);
  const ground = buildDistrictGround(group, site, active, roads, basin);
  const colliders = [], skipIds = new Set(), heights = new Map(), trees = [], arrivals = {}, shops = [];
  const reserveEntries = (x, z, radius = 0) => shops.some(shop =>
    distanceToRing([shop.approach, shop.mouth], x, z) < 1.05 + radius);
  for (const kind of active) {
    const focus = DISTRICT_FOCUS[kind];
    const view = kit.district(LANDMARK_IDS[kind], focus);
    const nearby = site.buildings.filter(b => b.minX <= focus.x + 240 && b.maxX >= focus.x - 240
      && b.minZ <= focus.z + 240 && b.maxZ >= focus.z - (kind === 'nantou' ? 170 : 240))
      .flatMap(b => buildingPlacement(b, site.terrain).colliders);
    const allowed = (p, y, height, owner, radius = 0.2) => Number.isFinite(y)
      && !carriagewayOccupied(p.x, p.z, radius)
      && (!basin || kind !== 'sea' || !polygonBoxOverlaps(basin, p.x, p.z, radius, radius))
      && ![...nearby, ...view.colliders].some(b => b.sourceId !== owner && b.maxX >= p.x - radius
        && b.minX <= p.x + radius && b.maxZ >= p.z - radius && b.minZ <= p.z + radius
        && b.maxY > y && b.minY < y + height && polygonBoxOverlaps(b.polygon, p.x, p.z, radius, radius));
    const nonBlocking = (p, y, h, owner, r = 0.24) => !ground.reserves(p.x, p.z, r)
      && !reserveEntries(p.x, p.z, r) && allowed(p, y, h, owner, r);
    const front = p => Number.isFinite(ground.heightAt(p.x, p.z)) || ground.reserves(p.x, p.z, kind === 'oct' ? 10.5 : 5.5);
    const selections = kind === 'sea' ? SEA_BLOCKS : kind === 'oct' ? OCT_BLOCKS : NANTOU_BLOCKS;
    for (const [id, wall, floors, balconies] of selections) {
      const building = byId.get(id);
      if (!building) continue;
      restyleBlock(view, building, site.terrain, site.heightAt, kind, {
        wall, floors, balconies, front, clear: nonBlocking, entryClear: allowed, open: kind !== 'nantou',
        registerShop: shop => shops.push({ ...shop, district: kind }),
        terrace: (kind === 'oct' && id === 'way/435827461') || (kind === 'sea' && id === 'way/492141834')
      });
      skipIds.add(id);
    }
    if (kind === 'sea') {
      const waterY = 6.91;
      addBasin(view, basin, minghua, waterY, site.groundHeight);
      heights.set('sea-world', buildMinghua(view, minghua, waterY, site.heightAt));
      skipIds.add(MINGHUA_ID);
      const canopy = byId.get('way/543176183');
      if (canopy) { addRetailCanopy(view, canopy, site.terrain); skipIds.add(canopy.id); }
    } else if (kind === 'oct') {
      const b10 = byId.get(B10);
      heights.set('oct-loft', buildB10(view, b10, site.terrain, site.heightAt, nonBlocking));
      skipIds.add(B10);
      const a3Plus = byId.get('way/532810249');
      if (a3Plus) addLoftStairs(view, a3Plus, site.heightAt, nonBlocking);
      const sign = frame(-6850, 421.7, 0.998, -0.058);
      view.box(sign.at(0, 0), 8, 10.05, 0.14, 0.14, sign, 'steel', b10);
      view.label(sign.at(0, 0.085), 9.92, 3.45, 0.50, sign, STR.districts.octLoft);
    } else {
      heights.set('nantou-ancient-city', buildSouthGate(view, byId.get(SOUTH_GATE_ID), site.heightAt));
      skipIds.add(SOUTH_GATE_ID);
      buildSouthPaifang(view, site.heightAt, (p, y, h) => nonBlocking(p, y, h, null, 0.75));
    }
    const source = { id: `design:${kind}-fixtures`, heightSource: 'estimate' };
    const metal = kind === 'sea' ? 'blue' : kind === 'oct' ? 'steel' : 'granite';
    addFixtures(view, source, metal, FIXTURES[kind], site.heightAt, nonBlocking);
    addWalkLamps(view, source, metal, ground.routes[kind], site.heightAt, nonBlocking);
    addLowFence(view, { id: `design:${kind}-green-edge`, heightSource: 'estimate' },
      GREEN_EDGES[kind], site.heightAt, nonBlocking);
    for (const [i, [x, z]] of TREE_SITES[kind].entries()) {
      if (!nonBlocking({ x, z }, site.heightAt(x, z), 5, null, 0.65)) continue;
      trees.push({ id: `design:${kind}-tree-${i}`, x, z, speciesName: kind === 'nantou' ? 'camphor' : 'ficus',
        height: 5.7 + (i % 3) * 0.7, crown: 4.0 + (i % 3) * 0.55,
        positionSource: 'simulated-district', appearanceSource: 'species-estimate' });
    }
    const [arrival, name, x, z, heading] = ARRIVALS[kind];
    if (allowed({ x, z }, site.heightAt(x, z), 1.9, null, 0.59)) {
      arrivals[arrival] = { name, x, z, heading, exact: true, walkOnly: true };
    }
    colliders.push(...view.colliders);
    view.finish();
  }
  scene.add(group);
  return { group, colliders, skipIds, heights, trees, arrivals, shops, ...ground,
    reserves: (x, z, radius) => ground.reserves(x, z, radius) || reserveEntries(x, z, radius), update: kit.update,
    dispose() { kit.dispose(); ground.dispose(); } };
}
