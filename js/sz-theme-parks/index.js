import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { sceneUniforms } from '../sz-materials.js';
import { buildFenceMetal, buildPathPools, createParkPoolMaterial, parkNight, planPathLamps, planPerimeter } from './ambience.js';
import { buildingPlacement } from '../sz-building-layout.js';
import { partCollider } from '../sz-landmarks/parts.js';
import { renderLandmark } from '../sz-landmarks/render.js';
import { createCarriagewayBarrier } from '../sz-pedestrian-tracks.js';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { createRoadPolygonLayout } from '../sz-roads.js';
import { createPavingMaterial, pavingMesh } from '../sz-paving.js';
import { buildParkFireworks } from '../sz-park-fireworks.js';
import { colosseum, COLOSSEUM, eiffelTower, EIFFEL, forbiddenCity, greatWall, leaningTower, octagonalPavilion, potalaPalace, pyramid, PYRAMIDS, shaolinTemple } from './miniatures.js';
import { disk, rectangle, sampleFootprint } from './parts.js';
import { dropTower, rollerCoaster, waterSlide } from './rides.js';
import { addFlowerCrowns, chinaFlowerBed, createFlowerCrown, planExpoFlowerBeds } from './flowers.js';
import { EDGE_OPENINGS, FIREWORK_SITE, LAWNS, PARK_IDS, TREES, VALLEY_BOUNDARY, WALKS } from './sites.js';

const COLORS = {
  iron: 0x51453c, brass: 0xe2a444, basalt: 0x766d68, sandstone: 0xc9a378, sandcap: 0xe7cb9e,
  limestone: 0xe5d9c6, recess: 0x574742, wallstone: 0xb9a58f, wallcap: 0xd0bca1,
  courtyard: 0xc0a898, vermilion: 0x9b392d, tilegold: 0xd7a326, rock: 0x806c5e,
  rideblue: 0x34547e, railred: 0xd84d46,
  perimeterSand: 0xa48a72, perimeterRed: 0x8c4d40, perimeterBlue: 0x586a76, perimeterCap: 0x9b9282,
  lampSteel: 0x414749, lampGlass: 0xb3a590, arenaStone: 0xc7a184, arenaTrim: 0xa2785d,
  templeTile: 0x576b60, slideTurquoise: 0x27aab3, slideYellow: 0xf6bf46, poolDeck: 0x92b6ad, slideWater: 0x267f9d,
  flowerStone: 0x9a8476, flowerSoil: 0x374e31, flowerFoliage: 0x396343
};
// 柔和泛光给主体留轮廓，较亮的压顶、座舱和灯罩形成局部光点。
const NIGHT_FINISH = {
  iron: [0xe4a762, 0.36], brass: [0xffb13f, 1.35], sandstone: [0xe8a25d, 0.36], sandcap: [0xffcb8d, 0.53],
  limestone: [0xffd4a2, 0.34], wallstone: [0xf3ba81, 0.26], wallcap: [0xffd195, 0.44],
  vermilion: [0xe95a36, 0.27], tilegold: [0xffb84c, 0.65], rideblue: [0x5990ff, 0.33], railred: [0xff5639, 0.85],
  lampGlass: [0xffce84, 3.2], arenaStone: [0xffae72, 0.23], arenaTrim: [0xffb26f, 0.46],
  templeTile: [0x7cc0a6, 0.29], slideTurquoise: [0x42d0ea, 0.53], slideYellow: [0xffc25a, 0.62], slideWater: [0x3d91b4, 0.21]
};
const PARK_BOUNDS = { minX: -9430, maxX: -6540, minZ: -225, maxZ: 1740 };

function strip(line, halfWidth) {
  const normal = ([ax, az], [bx, bz]) => {
    const length = Math.hypot(bx - ax, bz - az);
    return [(bz - az) / length, (ax - bx) / length];
  };
  const rows = line.map(([x, z], i) => {
    const a = normal(line[Math.max(0, i - 1)], line[Math.max(1, i)]);
    const b = normal(line[Math.min(i, line.length - 2)], line[Math.min(i + 1, line.length - 1)]);
    const m = halfWidth / (1 + a[0] * b[0] + a[1] * b[1]);
    return [-1, 1].map(s => ({ x: x + s * m * (a[0] + b[0]), z: z + s * m * (a[1] + b[1]) }));
  });
  return [...rows.map(row => row[0]), ...rows.reverse().map(row => row[1])];
}

export function planThemeParks(site) {
  const { buildings, terrain, mapRegions, groundHeight, roadGraph, isWater } = site;
  const barrier = createCarriagewayBarrier(roadGraph, { bounds: { ...PARK_BOUNDS, maxX: -5870 } });
  const sourceIds = new Set([EIFFEL, COLOSSEUM, ...PYRAMIDS.map(([id]) => id)]);
  const byId = new Map(buildings.filter(row => sourceIds.has(row.id)).map(row => [row.id, row]));
  const localBuildings = buildings.filter(b => b.maxX > PARK_BOUNDS.minX && b.minX < PARK_BOUNDS.maxX
    && b.maxZ > PARK_BOUNDS.minZ && b.minZ < PARK_BOUNDS.maxZ);
  const existing = localBuildings.flatMap(b => buildingPlacement(b, terrain).colliders);
  const parks = [];
  const rejected = [];
  const skipIds = new Set();
  const sceneryOmissions = new Set();
  for (const [key, id] of Object.entries(PARK_IDS)) {
    const boundary = mapRegions?.regions.find(row => row.id === `osm:${id}`)?.polygons[0]
      ?? (key === 'valley' ? { outer: VALLEY_BOUNDARY, holes: [] } : null);
    if (!boundary) continue;
    const park = { key, id, boundary, plans: [], walks: [], lawns: [], trees: [], launch: null, omittedSmallBuildings: 0 };
    // 只隐藏完全在园内的小型无名预测体块；保留 OSM 楼、具名场馆、近边界和入口对象。
    for (const b of localBuildings) {
      if (sourceIds.has(b.id) || b.name || b.height > 18 || !/^(globfp|overture)\//.test(b.id)
        || (b.maxX - b.minX) * (b.maxZ - b.minZ) > 2000
        || !polygonContainsInclusive(boundary, b.cx, b.cz)
        || EDGE_OPENINGS[key].some(([x, z, r]) => Math.hypot(x - b.cx, z - b.cz) < r + 22)) continue;
      if (b.polygons.every(p => p.outer.every(({ x, z }) => polygonContainsInclusive(boundary, x, z)
        && distanceToRing(boundary.outer, x, z) > 13 && !barrier.contains(x, z, 2)))) {
        park.omittedSmallBuildings++;
        sceneryOmissions.add(b.id);
        skipIds.add(b.id);
      }
    }
    const solids = [];
    const retained = existing.filter(b => !sceneryOmissions.has(b.sourceId));
    const canPlace = (ring, low, high, grounded = false, ignore = [], clearance = 0.35, roadMargin = 0.4) => {
      const candidates = [...retained, ...solids].filter(b => !ignore.includes(b.sourceId)
        && b.minY < high + clearance && b.maxY > low - clearance
        && !ring.every(p => p.x < b.minX) && !ring.every(p => p.x > b.maxX)
        && !ring.every(p => p.z < b.minZ) && !ring.every(p => p.z > b.maxZ));
      return sampleFootprint(ring, (x, z) => {
        const y = groundHeight(x, z);
        return Number.isFinite(y) && polygonContainsInclusive(boundary, x, z)
          && !barrier.contains(x, z, roadMargin) && !isWater(x, z)
          && !candidates.some(b => (!grounded || y + 2.15 > b.minY)
            && polygonContainsInclusive(b.polygon, x, z));
      }, 1.5);
    };
    const add = plan => {
      if (!plan) return;
      const conflict = plan.parts.find(p => !canPlace(p.polygon.outer, p.minY, p.maxY, false, plan.skipIds));
      if (conflict) {
        rejected.push(conflict.id);
        return;
      }
      park.plans.push(plan);
      solids.push(...plan.parts.map(partCollider));
      for (const id of plan.skipIds ?? []) skipIds.add(id);
    };
    if (key === 'world') {
      if (byId.has(EIFFEL)) add(eiffelTower(byId.get(EIFFEL), groundHeight));
      for (const [id, ...layout] of PYRAMIDS) if (byId.has(id)) add(pyramid(byId.get(id), groundHeight, ...layout));
      if (byId.has(COLOSSEUM)) add(colosseum(byId.get(COLOSSEUM), groundHeight));
      add(leaningTower(groundHeight));
    } else if (key === 'china') {
      add(greatWall(groundHeight));
      add(forbiddenCity(groundHeight));
      add(potalaPalace(groundHeight));
      add(shaolinTemple(groundHeight));
      add(octagonalPavilion(groundHeight));
      add(chinaFlowerBed(groundHeight));
    } else {
      add(rollerCoaster(groundHeight, canPlace));
      add(dropTower(groundHeight));
      add(waterSlide(groundHeight));
    }
    for (const [i, line] of WALKS[key].entries()) {
      const halfWidth = key === 'world' ? 2.15 : 1.7;
      const ring = strip(line, halfWidth);
      if (!canPlace(ring, -Infinity, Infinity, true, [...skipIds])) {
        rejected.push(`${key}:walk:${i}`);
        continue;
      }
      park.walks.push({ id: `theme-${key}-walk:${i}`, ring, line, halfWidth });
    }
    for (const [i, [x, z, w, d]] of LAWNS[key].entries()) {
      const ring = rectangle(x, z, w, d, 0.18);
      if (canPlace(ring, -Infinity, Infinity, true, [...skipIds])) park.lawns.push({ id: `theme-${key}-lawn:${i}`, ring });
    }
    const walkAt = (x, z, r = 0) => park.walks.some(({ ring }) =>
      polygonContainsInclusive({ outer: ring }, x, z) || (r > 0 && distanceToRing(ring, x, z) < r));
    const fits = (ring, low, high, clearance, margin) =>
      canPlace(ring, low, high, false, [...skipIds], clearance, margin);
    park.perimeter = planPerimeter(key, boundary, groundHeight, fits, walkAt);
    solids.push(...park.perimeter.parts.map(partCollider));
    park.lanterns = planPathLamps(key, park.walks, groundHeight, fits, walkAt);
    solids.push(...park.lanterns.parts.map(partCollider));
    for (const [i, [x, z]] of TREES[key].entries()) {
      const y = groundHeight(x, z), height = 3.6 + i % 3 * 0.6;
      if (!walkAt(x, z, 2.3) && canPlace(disk(x, z, 2, 8), y, y + height, true, [...skipIds])) {
        park.trees.push({ id: `theme-${key}-tree:${i}`, x, z, height, crown: 2.9 + i % 3 * 0.35,
          speciesName: 'camphor', positionSource: 'simulated-theme-park', appearanceSource: 'visual-estimate' });
      }
    }
    if (key === 'world') {
      const [x, z] = FIREWORK_SITE;
      const y = groundHeight(x, z);
      if (!walkAt(x, z, 12) && canPlace(disk(x, z, 10), y, y + 80, false, [...skipIds])) park.launch = { x, y, z };
      else rejected.push('world:fireworks');
    }
    parks.push(park);
  }
  const expoBuildings = buildings.filter(b => b.maxX > -6000 && b.minX < -5880 && b.maxZ > 1015 && b.minZ < 1160)
    .flatMap(b => buildingPlacement(b, terrain).colliders);
  const expo = planExpoFlowerBeds(site, expoBuildings, barrier);
  rejected.push(...expo.rejected);
  return { parks, skipIds, rejected, sceneryOmissions, expoBeds: expo.beds };
}

export function buildThemeParks(scene, site) {
  const { parks, skipIds, rejected, sceneryOmissions, expoBeds } = planThemeParks(site);
  const group = new THREE.Group();
  group.name = 'ShenzhenThemeParks';
  const surfaces = [], colliders = [], paths = [], trees = [], details = [];
  const materials = new Map();
  const poolMaterial = createParkPoolMaterial();
  const pools = [], fenceResources = [];
  const lawnMat = createPavingMaterial('park-gravel', { color: 0x81965c, depthBias: -1 });
  const pathMat = createPavingMaterial('park-gravel', { color: 0xc6b398, depthBias: -3 });
  const materialFor = style => {
    if (!materials.has(style)) {
      const material = new THREE.MeshStandardNodeMaterial({
        color: COLORS[style], roughness: style === 'iron' || style === 'railred' ? 0.63 : 0.88
      });
      const finish = NIGHT_FINISH[style];
      if (finish) material.emissiveNode = color(finish[0]).mul(parkNight).mul(finish[1]);
      materials.set(style, material);
    }
    return materials.get(style);
  };
  const flowerGeometry = createFlowerCrown();
  const flowerMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.9,
    emissiveNode: color(0xffddbd).mul(0.035) });
  const flowerBeds = [...expoBeds, ...parks.flatMap(park => park.plans.filter(plan => plan.blooms))];
  for (const bed of flowerBeds) addFlowerCrowns(group, bed, flowerGeometry, flowerMaterial);
  for (const bed of expoBeds) {
    const result = renderLandmark(bed, materialFor);
    group.add(result.group);
    colliders.push(...bed.parts.map(partCollider));
    surfaces.push(...result.surfaces);
  }
  let fireworks;
  for (const park of parks) {
    for (const plan of [...park.plans, park.perimeter, park.lanterns]) {
      const core = renderLandmark({ ...plan, parts: plan.parts.filter(part => !part.nearDetail && !part.collisionOnly) }, materialFor);
      group.add(core.group);
      colliders.push(...plan.parts.map(partCollider));
      surfaces.push(...core.surfaces);
      const extras = plan.parts.filter(part => part.nearDetail);
      if (extras.length) {
        const detail = renderLandmark({ id: `${plan.id}:detail`, parts: extras }, materialFor);
        group.add(detail.group);
        surfaces.push(...detail.surfaces);
        const bounds = new THREE.Box3().setFromObject(detail.group);
        details.push({ group: detail.group, center: bounds.getCenter(new THREE.Vector3()) });
      }
    }
    for (const area of [...park.lawns, ...park.walks]) {
      const vector = area.ring.map(p => new THREE.Vector2(p.x, p.z));
      const trianglesXZ = THREE.ShapeUtils.triangulateShape(vector, [])
        .flatMap(face => face.flatMap(i => [vector[i].x, vector[i].y]));
      const { chunks } = createRoadPolygonLayout({ id: area.id, trianglesXZ, sourceIds: [park.id] }, site.terrainSurface);
      const isWalk = park.walks.includes(area);
      for (const chunk of chunks) group.add(pavingMesh(chunk.positions, chunk.origin, isWalk ? pathMat : lawnMat, area.id));
      if (isWalk && chunks.length) paths.push({ outer: area.ring, holes: [] });
    }
    fenceResources.push(buildFenceMetal(group, park));
    const pool = buildPathPools(park, site.terrainSurface, poolMaterial);
    if (pool) {
      pool.visible = false;
      group.add(pool);
      pools.push(pool);
    }
    trees.push(...park.trees);
    if (park.launch) fireworks = buildParkFireworks(scene, park.launch);
  }
  scene.add(group);
  const launch = parks.find(park => park.launch)?.launch;
  const reserved = (x, z, radius) => Boolean(launch && (x - launch.x) ** 2 + (z - launch.z) ** 2 < (10 + radius) ** 2)
    || flowerBeds.some(({ parts: [bed] }) => x >= bed.minX - radius && x <= bed.maxX + radius
      && z >= bed.minZ - radius && z <= bed.maxZ + radius
      && (polygonContainsInclusive(bed.polygon, x, z) || distanceToRing(bed.polygon.outer, x, z) < radius));
  const onPath = (x, z) => x >= PARK_BOUNDS.minX && x <= PARK_BOUNDS.maxX
    && z >= PARK_BOUNDS.minZ && z <= PARK_BOUNDS.maxZ && paths.some(path => polygonContainsInclusive(path, x, z));
  return {
    group, skipIds, colliders, surfaces, trees, reserved,
    pathAt: (x, z) => onPath(x, z) ? ['theme-park-path'] : [],
    update(now, night, camera) {
      for (const detail of details) detail.group.visible = camera.distanceToSquared(detail.center) < 500 ** 2;
      for (const pool of pools) pool.visible = sceneUniforms.night.value > 0.10;
      fireworks?.update(now, night, camera);
    },
    snapshot: () => ({ rejected, flowerBeds: flowerBeds.map(bed => bed.id), omittedSmallBuildings: sceneryOmissions.size, parks: parks.map(p => ({ id: p.id, models: p.plans.map(plan => plan.id),
      walks: p.walks.length, trees: p.trees.length, lamps: p.lanterns.lamps.length,
      omittedSmallBuildings: p.omittedSmallBuildings, wallSegments: p.perimeter.segments, wallLengthM: Math.round(p.perimeter.lengthM) })),
    lightPoolsVisible: pools.some(pool => pool.visible), fireworks: fireworks?.snapshot() }),
    dispose() {
      fireworks?.dispose();
      const geometries = new Set([flowerGeometry, ...fenceResources.map(r => r.geometry)]);
      group.traverse(o => {
        if (o.isInstancedMesh) o.dispose();
        if (o.isMesh) geometries.add(o.geometry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const { material } of fenceResources) material.dispose();
      for (const material of [...materials.values(), lawnMat, pathMat, poolMaterial, flowerMaterial]) material.dispose();
      scene.remove(group);
    }
  };
}
