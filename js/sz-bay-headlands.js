import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, sin } from 'three/tsl';
import source from '../data/source/bay-headlands.json' with { type: 'json' };
import { createBayPathLookup, bayFixtureCollider } from './sz-bay-waterfront.js';
import { planBench, createFixtureBatches } from './sz-site-fixtures.js';
import { polygonContains, distanceToRing } from './sz-polygon.js';
import { URBAN_LAWN_KIND } from './sz-ground-surface.js';
import { createPavingMaterial } from './sz-paving.js';
import { addSportsGround } from './sz-landmarks/sports-ground.js';

const toPoint = ([x, z]) => ({ x, z });
const WEST = 'way/571629092', EAST = 'way/571629093';
const shoreWalkId = 'way/357765496';

// 沿南北断面取折线最靠海的交点。海韵内园路折返，不能只取第一个交点。
function seawardZ(points, x) {
  let z = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    if (x < Math.min(ax, bx) || x > Math.max(ax, bx) || ax === bx) continue;
    z = Math.max(z, az + (bz - az) * (x - ax) / (bx - ax));
  }
  return z;
}

function ribbon(points, width) {
  const sides = points.map(([x, z], i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(i + 1, points.length - 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], k = width / (2 * Math.hypot(dx, dz));
    return [{ x: x - dz * k, z: z + dx * k }, { x: x + dz * k, z: z - dx * k }];
  });
  return [...sides.map(s => s[0]), ...sides.reverse().map(s => s[1])];
}

export function planBayHeadlands(geo) {
  const park = geo.parks?.find(p => p.osmId === 'relation/8133384');
  const pathNetwork = geo.waterfront?.parkNetwork?.bayPaths ?? [];
  const shore = pathNetwork.find(p => p.osmId === shoreWalkId);
  if (!park || !shore) return [];
  const coastPaths = pathNetwork.filter(p => p.osmId === shoreWalkId || p.osmId === 'way/565275073');
  const existingPaths = createBayPathLookup([...coastPaths, ...[source.egretWalk, source.seaWalk, source.innerCycle]
    .map(path => ({ ...path, mode: 'shared', widthM: 3.5 }))]);
  const gardens = [];
  for (const osmId of [WEST, EAST]) {
    const area = park.areas.find(a => a.osmId === osmId);
    if (!area) continue;
    const west = osmId === WEST;
    const patches = [], paths = [], seats = [], trees = [];
    const inner = west ? source.egretWalk : source.seaWalk;
    const atShore = x => seawardZ(shore.points, x);
    const atBack = x => Math.max(seawardZ(inner.points, x), seawardZ(source.innerCycle.points, x));
    const addWalk = (points, widthM) => {
      paths.push({ points, widthM, mode: 'walk' });
      patches.push({ style: 'gravel', ring: ribbon(points, widthM) });
    };
    if (west) {
      // 扇形草甸使用已核草地边界。弧形支路从海堤内侧分出，绕过既有建筑后接回。
      patches.push({ style: 'lawn', ring: source.egretLawn.points.map(toPoint) });
      const arc = Array.from({ length: 33 }, (_, i) => {
        const t = i / 32, x = -9050 + 147 * t;
        return [x, atShore(x) - 32 * Math.sin(Math.PI * t)];
      });
      addWalk(arc, 3.2);
    } else {
      // 两片透镜形草甸沿弯岸收尖，在原有横向园路两旁留出进出海堤的开口。
      for (const [from, to] of [[-8290, -8019], [-7996, -7854]]) {
        const near = [], far = [];
        for (let i = 0; i <= 36; i++) {
          const t = i / 36, x = from + (to - from) * t;
          const back = atBack(x) + 4, front = atShore(x) - 4.5;
          const middle = back + (front - back) * (0.51 + 0.07 * Math.sin(t * Math.PI * 2));
          const half = (front - back) * 0.46 * Math.sin(Math.PI * t) ** 0.58;
          near.push({ x, z: middle - half });
          if (i > 0 && i < 36) far.push({ x, z: middle + half });
        }
        patches.push({ style: 'lawn', ring: [...near, ...far.reverse()] });
      }
      // 截取原内园路从海边支路交点至西侧海堤的段，三条步道在原节点相接。
      const [junctionX, junctionZ] = source.seaSpur.points[0];
      const junction = inner.points.findIndex(([x, z]) => x === junctionX && z === junctionZ);
      if (junction >= 0) addWalk(inner.points.slice(junction), 3.2);
      addWalk(source.seaSpur.points, 3.2);
      const cross = Array.from({ length: 17 }, (_, i) => {
        const t = i / 16, x = -8186 + 21 * t + 4.5 * Math.sin(t * 2 * Math.PI);
        return [x, (1 - t) * atBack(-8186) + t * atShore(-8165)];
      });
      addWalk(cross, 3.5);
    }

    // 半月形休息区的直边贴向现有步道，座椅沿后弧朝海，不占人行及骑行面。
    const centerX = west ? -8971 : -8049;
    const slope = (atShore(centerX + 2) - atShore(centerX - 2)) / 4;
    const dx = 1 / Math.hypot(1, slope), dz = slope * dx;
    const atCourt = (along, inland) => {
      const x = centerX + dx * along + dz * inland;
      return { x, z: atShore(centerX) + dz * along - dx * inland };
    };
    const court = Array.from({ length: 27 }, (_, i) => {
      const a = i * Math.PI / 26;
      return atCourt((west ? 13 : 19) * Math.cos(a), 1.35 + (west ? 7.8 : 10) * Math.sin(a));
    });
    patches.push({ style: 'court', ring: court });
    for (const offset of (west ? [-5.5, 5.5] : [-10, 0, 10])) {
      seats.push({ ...atCourt(offset, west ? 6 : 7.4), dx, dz });
    }
    const localPaths = createBayPathLookup(paths);
    const reserve = (x, z, pad = 0) => localPaths(x, z, pad).length > 0
      || polygonContains({ outer: court }, x, z) || distanceToRing(court, x, z) <= pad;
    // 用低矮的花境勾出草坪边缘。色带越过园路时断开，观海平台前留空。
    const beds = west ? [[-9052, -9021], [-8954, -8917]] : [[-8244, -8204], [-8133, -8090], [-7951, -7901]];
    for (const [from, to] of beds) {
      const left = [], right = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, x = from + (to - from) * t;
        const z = atShore(x) - (west ? 9 : 11) - 2.3 * Math.sin(Math.PI * t);
        const width = (west ? 2.2 : 3.1) * Math.sin(Math.PI * t) ** 0.7;
        left.push({ x, z: z - width });
        if (i && i < 20) right.push({ x, z: z + width });
      }
      patches.push({ style: west ? 'sage' : 'gold', ring: [...left, ...right.reverse()] });
    }
    // 榕树和香樟组成背海的树丛；开口处用较矮的紫荆，保留草坪中央的通透感。
    const groups = west ? [-9118, -9094, -9067, -9034, -8925, -8894, -8862]
      : [-8282, -8250, -8210, -8180, -8149, -8120, -8082, -8044, -7974, -7944, -7906, -7873];
    groups.forEach((gx, g) => {
      for (let j = 0; j < 9; j++) {
        const x = gx + (j % 3 - 1) * 6.5 + 2.4 * Math.sin(g + j);
        const z = atBack(x) + (west && g % 3 === 0 ? -1 : 1) * (6 + 6.2 * Math.floor(j / 3) + 2 * Math.cos(g + j));
        const crown = 5.5 + 1.5 * Math.cos(g + 1.6 * j);
        if (!Number.isFinite(z) || !polygonContains(area.polygon, x, z) || distanceToRing(area.polygon.outer, x, z) < crown / 2
          || existingPaths(x, z, crown / 2 + 0.6).length || reserve(x, z, crown / 2 + 0.6)
          || z > atShore(x) - 6 || Math.abs(x - centerX) < 14) continue;
        trees.push({ id: `bay-headland:${osmId}:${g}:${j}`, x, z, crown, height: 6.5 + 2 * Math.sin(g + 2 * j),
          speciesName: ['ficus', 'camphor', 'bauhinia'][g % 3], positionSource: 'simulated-park', appearanceSource: 'visual-estimate' });
      }
    });
    const bounds = area.polygon.outer;
    const x0 = Math.min(...bounds.map(p => p.x)), x1 = Math.max(...bounds.map(p => p.x));
    const z0 = Math.min(...bounds.map(p => p.z)), z1 = Math.max(...bounds.map(p => p.z));
    gardens.push({ osmId, patches, paths, seats, trees, reserves: (x, z, r = 0) =>
      x >= x0 - r && x <= x1 + r && z >= z0 - r && z <= z1 + r && reserve(x, z, r) });
  }
  return gardens;
}

// 所有铺装共用已渲染地面三角面，岸线、骑行面及既有广场保持源断面。
export function buildBayHeadlands(scene, geo, site) {
  const gardens = planBayHeadlands(geo);
  const group = new THREE.Group();
  group.name = 'shenzhen-bay-headlands';
  const lawn = createPavingMaterial('park-gravel');
  const tint = sin(positionWorld.x.mul(0.09).add(sin(positionWorld.z.mul(0.13))))
    .mul(sin(positionWorld.z.mul(0.068))).mul(0.5).add(0.5);
  lawn.colorNode = mix(color(0x46753c), color(0x729849), tint);
  const materials = { lawn, gravel: createPavingMaterial('park-gravel', { color: 0xbba888, depthBias: -5 }),
    court: createPavingMaterial('light-stone', { color: 0xd0bf9f, tileSizeM: 0.82, depthBias: -7 }) };
  for (const [name, foliage, blossom] of [['sage', 0x406b54, 0xafa7c6], ['gold', 0x687442, 0xd1a65e]]) {
    const material = createPavingMaterial('park-gravel', { depthBias: -3 });
    const speckle = sin(positionWorld.x.mul(3.1)).mul(sin(positionWorld.z.mul(4.3)));
    material.colorNode = mix(color(foliage), color(blossom), tint.mul(0.60).add(speckle.mul(0.18)).clamp());
    materials[name] = material;
  }
  const wood = [], steel = [], colliders = [];
  const fixtures = createFixtureBatches(group, 'bay', 'z');
  for (const garden of gardens) {
    const ground = new THREE.Group();
    ground.name = garden.osmId;
    group.add(ground);
    addSportsGround(ground, garden.patches, site.terrainSurface, style => materials[style],
      kind => kind <= 2 || kind === URBAN_LAWN_KIND);
    for (const seat of garden.seats) {
      const y = site.heightAt(seat.x, seat.z);
      if (!Number.isFinite(y)) continue;
      const bench = planBench({ ...seat, y }, seat.dx, seat.dz, { halfLengthM: 1.55, seatHeightM: 0.47,
        seatWidthM: 0.56, legBottomM: 0, legTopM: 0.46, legWidthM: 0.1, legDepthM: 0.39,
        back: { heightM: 0.82, offsetM: -0.22 } });
      wood.push(...bench.wood);
      steel.push(...bench.steel);
    }
  }
  fixtures.build(wood, 'wood', 'bay-headland-seats');
  fixtures.build(steel, 'steel', 'bay-headland-seat-legs');
  for (const beam of [...wood, ...steel]) colliders.push(bayFixtureCollider(beam, 'park-bench'));
  scene.add(group);
  return { trees: gardens.flatMap(g => g.trees), colliders, reserves: (x, z, r) => gardens.some(g => g.reserves(x, z, r)),
    dispose() {
      fixtures.dispose();
      group.traverse(item => item.geometry?.dispose());
      for (const material of Object.values(materials)) material.dispose();
      group.removeFromParent();
    } };
}
