import * as THREE from 'three/webgpu';
import { buildingPlacement } from '../sz-building-layout.js';
import { partCollider } from '../sz-landmarks/parts.js';
import { renderLandmark } from '../sz-landmarks/render.js';
import { createCarriagewayBarrier } from '../sz-pedestrian-tracks.js';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { createRoadPolygonLayout } from '../sz-roads.js';
import { createPavingMaterial, pavingMesh } from '../sz-paving.js';
import { buildParkFireworks } from '../sz-park-fireworks.js';
import { eiffelTower, EIFFEL, forbiddenCity, greatWall, leaningTower, potalaPalace, pyramid, PYRAMIDS } from './miniatures.js';
import { disk, rectangle, sampleFootprint } from './parts.js';
import { dropTower, rollerCoaster } from './rides.js';
import { FIREWORK_SITE, LAWNS, PARK_IDS, TREES, VALLEY_BOUNDARY, WALKS } from './sites.js';

const COLORS = {
  iron: 0x51453c, brass: 0xe2a444, basalt: 0x766d68, sandstone: 0xc9a378, sandcap: 0xe7cb9e,
  limestone: 0xe5d9c6, recess: 0x574742, wallstone: 0xb9a58f, wallcap: 0xd0bca1,
  courtyard: 0xc0a898, vermilion: 0x9b392d, tilegold: 0xd7a326, rock: 0x806c5e,
  rideblue: 0x34547e, railred: 0xd84d46
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

export function planThemeParks({ buildings, terrain, mapRegions, groundHeight, roadGraph, isWater }) {
  const barrier = createCarriagewayBarrier(roadGraph, { bounds: PARK_BOUNDS });
  const sourceIds = new Set([EIFFEL, ...PYRAMIDS.map(([id]) => id)]);
  const byId = new Map(buildings.filter(row => sourceIds.has(row.id)).map(row => [row.id, row]));
  const existing = buildings.filter(b => b.maxX > PARK_BOUNDS.minX && b.minX < PARK_BOUNDS.maxX
    && b.maxZ > PARK_BOUNDS.minZ && b.minZ < PARK_BOUNDS.maxZ)
    .flatMap(b => buildingPlacement(b, terrain).colliders);
  const parks = [];
  const rejected = [];
  const skipIds = new Set();
  for (const [key, id] of Object.entries(PARK_IDS)) {
    const boundary = mapRegions?.regions.find(row => row.id === `osm:${id}`)?.polygons[0]
      ?? (key === 'valley' ? { outer: VALLEY_BOUNDARY, holes: [] } : null);
    if (!boundary) continue;
    const park = { key, id, boundary, plans: [], walks: [], lawns: [], trees: [], launch: null };
    const solids = [];
    const canPlace = (ring, low, high, grounded = false, ignore = [], clearance = 0.35) => {
      const candidates = [...existing, ...solids].filter(b => !ignore.includes(b.sourceId)
        && b.minY < high + clearance && b.maxY > low - clearance
        && !ring.every(p => p.x < b.minX) && !ring.every(p => p.x > b.maxX)
        && !ring.every(p => p.z < b.minZ) && !ring.every(p => p.z > b.maxZ));
      return sampleFootprint(ring, (x, z) => {
        const y = groundHeight(x, z);
        return Number.isFinite(y) && polygonContainsInclusive(boundary, x, z)
          && !barrier.contains(x, z, 0.4) && !isWater(x, z)
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
      for (const [id, h] of PYRAMIDS) if (byId.has(id)) add(pyramid(byId.get(id), groundHeight, h));
      add(leaningTower(groundHeight));
    } else if (key === 'china') {
      add(greatWall(groundHeight));
      add(forbiddenCity(groundHeight));
      add(potalaPalace(groundHeight));
    } else {
      add(rollerCoaster(groundHeight, canPlace));
      add(dropTower(groundHeight));
    }
    for (const [i, line] of WALKS[key].entries()) {
      const ring = strip(line, key === 'world' ? 2.15 : 1.7);
      if (!canPlace(ring, -Infinity, Infinity, true, [...skipIds])) {
        rejected.push(`${key}:walk:${i}`);
        continue;
      }
      park.walks.push({ id: `theme-${key}-walk:${i}`, ring });
    }
    for (const [i, [x, z, w, d]] of LAWNS[key].entries()) {
      const ring = rectangle(x, z, w, d, 0.18);
      if (canPlace(ring, -Infinity, Infinity, true, [...skipIds])) park.lawns.push({ id: `theme-${key}-lawn:${i}`, ring });
    }
    const walkAt = (x, z, r = 0) => park.walks.some(({ ring }) =>
      polygonContainsInclusive({ outer: ring }, x, z) || (r > 0 && distanceToRing(ring, x, z) < r));
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
  return { parks, skipIds, rejected };
}

export function buildThemeParks(scene, site) {
  const { parks, skipIds, rejected } = planThemeParks(site);
  const group = new THREE.Group();
  group.name = 'ShenzhenThemeParks';
  const surfaces = [], colliders = [], paths = [], trees = [], details = [];
  const materials = new Map();
  const lawnMat = createPavingMaterial('park-gravel', { color: 0x81965c, depthBias: -1 });
  const pathMat = createPavingMaterial('park-gravel', { color: 0xc6b398, depthBias: -3 });
  const materialFor = style => {
    if (!materials.has(style)) materials.set(style, new THREE.MeshStandardNodeMaterial({
      color: COLORS[style], roughness: style === 'iron' || style === 'railred' ? 0.63 : 0.88
    }));
    return materials.get(style);
  };
  let fireworks;
  for (const park of parks) {
    for (const plan of park.plans) {
      const core = renderLandmark({ ...plan, parts: plan.parts.filter(part => !part.nearDetail) }, materialFor);
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
    trees.push(...park.trees);
    if (park.launch) fireworks = buildParkFireworks(scene, park.launch);
  }
  scene.add(group);
  const launch = parks.find(park => park.launch)?.launch;
  const reserved = (x, z, radius) => Boolean(launch && (x - launch.x) ** 2 + (z - launch.z) ** 2 < (10 + radius) ** 2);
  const onPath = (x, z) => x >= PARK_BOUNDS.minX && x <= PARK_BOUNDS.maxX
    && z >= PARK_BOUNDS.minZ && z <= PARK_BOUNDS.maxZ && paths.some(path => polygonContainsInclusive(path, x, z));
  return {
    group, skipIds, colliders, surfaces, trees, reserved,
    pathAt: (x, z) => onPath(x, z) ? ['theme-park-path'] : [],
    update(now, night, camera) {
      for (const detail of details) detail.group.visible = camera.distanceToSquared(detail.center) < 500 ** 2;
      fireworks?.update(now, night, camera);
    },
    snapshot: () => ({ rejected, parks: parks.map(p => ({ id: p.id, models: p.plans.map(plan => plan.id),
      walks: p.walks.length, trees: p.trees.length })), fireworks: fireworks?.snapshot() }),
    dispose() {
      fireworks?.dispose();
      group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      for (const material of [...materials.values(), lawnMat, pathMat]) material.dispose();
      scene.remove(group);
    }
  };
}
