import source from '../data/source/vegetation-pilots.json' with { type: 'json' };
import { polygonContains, distanceToRing, ringArea } from './sz-polygon.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';
import { createColliderIndex } from './sz-trees.js';
import { terrainHeight } from './sz-terrain.js';

const TAU = Math.PI * 2;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export function vegetationRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}

const decode = ([outer, ...holes]) => {
  const ring = points => points.map(([x, z]) => ({ x, z }));
  return { outer: ring(outer), holes: holes.map(ring) };
};
const polygons = feature => feature.polygons.map(decode);
const boundaryDistance = ({ outer, holes }, x, z) =>
  Math.min(distanceToRing(outer, x, z), ...holes.map(ring => distanceToRing(ring, x, z)));
const inside = (polygon, x, z, pad = 0) =>
  polygonContains(polygon, x, z) && boundaryDistance(polygon, x, z) >= pad;

function bounds({ outer }) {
  const xs = outer.map(p => p.x), zs = outer.map(p => p.z);
  return { minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs) };
}

function samplePatches(mask, { spread, width, ratio, heading }, random) {
  const { minX, maxX, minZ, maxZ } = bounds(mask);
  const patchCount = Math.ceil((ringArea(mask.outer) - mask.holes.reduce((sum, hole) =>
    sum + ringArea(hole), 0)) / spread ** 2);
  const patches = [];
  for (let i = 0; i < patchCount * 16 && patches.length < patchCount; i++) {
    const x = minX + random() * (maxX - minX);
    const z = minZ + random() * (maxZ - minZ);
    if (!polygonContains(mask, x, z) || patches.some(p => Math.hypot(p.x - x, p.z - z) < spread * 0.45)) continue;
    const angle = heading + (random() - 0.5) * (ratio < 0.55 ? 0.48 : TAU);
    patches.push({ x, z, radius: width * (0.63 + random() * 0.56), ratio, cos: Math.cos(angle),
      sin: Math.sin(angle), phase: random() * TAU, density: 0.55 + random() * 0.45 });
  }
  return patches;
}

function patchPoint(patch, random) {
  const angle = TAU * random(), distance = Math.sqrt(random());
  // 同一斑块的边缘共享角向扰动。离心越远，空隙越多。
  const edge = 0.88 + 0.17 * Math.sin(3 * angle + patch.phase) + 0.10 * Math.cos(5 * angle - patch.phase);
  const r = patch.radius * distance * edge;
  const x = r * Math.cos(angle), z = r * Math.sin(angle) * patch.ratio;
  return { x: patch.x + x * patch.cos - z * patch.sin, z: patch.z + x * patch.sin + z * patch.cos,
    density: patch.density * clamp((1 - distance) * 2.6, 0, 1) };
}

const PROFILES = {
  hill: { spread: 25, width: 26, ratio: 0.76, heading: 0.2, attempts: [14, 12, 5] },
  bay: { spread: 16, width: 18, ratio: 0.66, heading: -0.25, attempts: [11, 15, 0] },
  mangrove: { spread: 13, width: 21, ratio: 0.43, heading: -0.48, attempts: [17, 0, 0] }
};

function dimensions(site, kind, random) {
  const size = random(), variation = random();
  if (kind === 'shrub') return { radius: 0.46 + size * 1.03, height: 0.38 + size * 1.05, shape: 0 };
  if (kind === 'rock') return { radius: 0.28 + size ** 2 * 1.4, height: 0.28 + size ** 2 * 1.21, shape: Number(variation > 0.5) };
  if (site === 'mangrove') return { radius: 0.9 + 1.9 * size, height: 2.3 + 3.6 * size, shape: 2 };
  const large = size > 0.23;
  return { radius: large ? 2.15 + size * 3.0 : 1.05 + variation * 1.4,
    height: large ? (site === 'hill' ? 5.2 : 4.5) + size * 6.7 : 2.4 + variation * 3.2,
    shape: Number(variation > 0.54) };
}

function createSpacing() {
  const cells = new Map();
  const step = 5;
  const key = (x, z) => `${x},${z}`;
  return item => {
    const ix = Math.floor(item.x / step), iz = Math.floor(item.z / step);
    for (let a = ix - 1; a <= ix + 1; a++) for (let b = iz - 1; b <= iz + 1; b++) {
      for (const other of cells.get(key(a, b)) ?? []) {
        const spacing = item.kind === 'tree' && other.kind === 'tree'
          ? Math.max(2.0, (item.radius + other.radius) * 0.47)
          : Math.min(4.9, (item.kind === 'tree' || other.kind === 'tree')
            ? 0.48 + (item.kind === 'tree' ? other.radius : item.radius) : (item.radius + other.radius) * 0.85);
        if ((item.x - other.x) ** 2 + (item.z - other.z) ** 2 < spacing ** 2) return false;
      }
    }
    const id = key(ix, iz);
    if (!cells.has(id)) cells.set(id, []);
    cells.get(id).push(item);
    return true;
  };
}

// 高程以场景海面为零点。DSM 只用于浅滩内相对起伏，岸边收敛到同一水位。
export function createIntertidalBeds(sea, terrain, isWater, waterBodies = []) {
  if (!Number.isFinite(sea?.heightM) || !sea.source?.excludedWetlandIds?.includes(source.wetland.osmId)) return [];
  return polygons(source.wetland).map(mask => ({
    mask, sourceId: source.wetland.osmId, waterY: sea.heightM,
    accepts: (x, z) => isWater(x, z) === true && !waterBodies.some(p => polygonContains(p, x, z)),
    heightAt(x, z) {
      const edge = boundaryDistance(mask, x, z);
      const t = clamp(edge / 16, 0, 1);
      const ground = terrainHeight(terrain, x, z) ?? sea.heightM;
      const relief = clamp((ground - sea.heightM) * 0.46 - 0.43, -0.65, 0.77);
      const ripple = Math.sin(x * 0.084 + z * 0.137) * Math.cos(z * 0.098 - x * 0.024) * 0.22;
      return sea.heightM - 0.06 + t * (relief + ripple);
    }
  }));
}

function footprintGround(groundHeight, x, z, reach) {
  const a = groundHeight(x - reach, z), b = groundHeight(x + reach, z);
  const c = groundHeight(x, z - reach), d = groundHeight(x, z + reach);
  const y = groundHeight(x, z);
  if (![a, b, c, d, y].every(Number.isFinite)) return null;
  return { y, low: Math.min(a, b, c, d, y), high: Math.max(a, b, c, d, y),
    slope: Math.hypot(a - b, c - d) / (2 * reach) };
}

export function planVegetationPilots(geo, site, beds, existingTrees) {
  const extraPaths = createBayPathLookup(source.paths);
  const plazas = source.hill.plazas.flatMap(polygons);
  const hillPark = geo.parks.find(park => park.osmId === source.hill.parkOsmId);
  const obstacles = createColliderIndex(site.colliders);
  const trees = createColliderIndex(existingTrees);
  const fitsSpacing = createSpacing();
  const placed = [];
  const parkNetwork = geo.waterfront?.parkNetwork;
  const coastalCycle = createBayPathLookup((parkNetwork?.bayPaths ?? [])
    .filter(path => !path.bridge && path.mode !== 'walk'));
  // 先保留规划的陆侧树列，再在间隙放灌木和公园林地。
  const random = vegetationRandom(732841);
  for (const [kind, sites] of [['tree', parkNetwork?.bayTrees], ['shrub', parkNetwork?.bayPlants]]) {
    for (const [i, [x, y, z]] of (sites ?? []).entries()) {
      const size = random();
      const radius = kind === 'tree' ? 1.65 + size * 0.72 : 1.05 + size * 0.42;
      const height = kind === 'tree' ? 4.6 + size * 2.7 : 0.82 + size * 0.67;
      const item = { id: `vegetation:bay-shore:${kind}:${i}`, siteId: 'bay', sourceId: 'relation/7289235',
        kind, x, y: y - 0.08, z, supportY: y, radius, height, shape: i % 2, turn: TAU * random(), tint: random() };
      if (site.isWater(x, z) !== false || site.reserveWalk(x, z, radius + 0.25)
        || site.carriagewayOccupied(x, z, radius) || site.deckOccupied(x, z, y, y + height)
        || trees(x, z, kind === 'tree' ? 2.1 : radius, y, y + height)
        || obstacles(x, z, radius, y, y + height) || !fitsSpacing(item)) continue;
      placed.push(item);
    }
  }
  const landAreas = [
    ...(hillPark ? [{ siteId: 'hill', feature: source.hill.forest }] : []),
    ...(geo.shenzhenBay?.areaOsmId === source.bay.areaOsmId ? source.bay.groves : [])
      .map(feature => ({ siteId: 'bay', feature }))
  ];
  const areas = landAreas.flatMap(({ siteId, feature }) =>
    polygons(feature).map(mask => ({ siteId, sourceId: feature.osmId, mask })));
  areas.push(...beds.map(bed => ({ siteId: 'mangrove', sourceId: bed.sourceId, mask: bed.mask, bed })));
  for (const [areaIndex, { siteId, sourceId, mask, bed }] of areas.entries()) {
    const profile = PROFILES[siteId];
    const random = vegetationRandom(841227 + areaIndex * 5759);
    const patches = samplePatches(mask, profile, random);
    for (const [kindIndex, kind] of ['tree', 'shrub', 'rock'].entries()) {
      if (kind === 'tree' && sourceId === 'way/1347580483') continue;
      for (const [patchIndex, patch] of patches.entries()) {
        for (let i = 0; i < profile.attempts[kindIndex]; i++) {
          const { x, z, density } = patchPoint(patch, random);
          const { radius, height, shape } = dimensions(siteId, kind, random);
          const choice = random(), turn = TAU * random(), tint = random(), root = random();
          const item = { x, z, radius, height, shape, turn, tint, kind, sourceId, siteId,
            id: `vegetation:${siteId}:${areaIndex}:${patchIndex}:${kind}:${i}` };
          const pad = radius + (siteId === 'bay' ? 0.85 : 0.55);
          if (density < choice * 0.87 || !inside(mask, x, z, pad)) continue;
          if (bed) {
            if (!bed.accepts(x, z)) continue;
            const grade = bed.heightAt(x, z);
            if (!Number.isFinite(grade) || grade < bed.waterY - 0.74 || grade > bed.waterY + 0.82) continue;
            item.y = grade - 0.16;
            item.roots = root < 0.30;
            item.supportY = grade;
          } else {
            if (site.isWater(x, z) !== false
              || site.pathAt(x, z).length || site.reserveWalk(x, z, pad)
              || extraPaths(x, z, pad).length || (siteId === 'bay' && coastalCycle(x, z, 14).length)
              || site.carriagewayOccupied(x, z, pad)
              || site.excludedSite?.(x, z, pad) || site.pavedAt(x, z) !== null
              || site.simulatedPathAt?.(x, z)
              || site.nearRoads(x, z, pad + 8).some(({ road, distance }) =>
                !road.bridge && !road.tunnel && distance <= road.w / 2 + pad)
              || (siteId === 'hill' && (!hillPark.areas.some(a => inside(a.polygon, x, z, pad))
                || plazas.some(p => polygonContains(p, x, z) || boundaryDistance(p, x, z) < pad + 2)))) continue;
            const ground = footprintGround(site.groundHeight, x, z, kind === 'tree' ? 2 : radius * 0.56);
            if (!ground) continue;
            const { y, slope, low, high } = ground;
            if (kind === 'rock') {
              const trailside = extraPaths(x, z, 9 + radius).includes('steps');
              if (!trailside && (slope < 0.28 || choice < 0.29)) continue;
              // 扁石略埋入最低接地点，过陡的坡面放弃该石，保留露出部分。
              item.y = Math.min(y - height * 0.17, low + height * 0.19);
              if (high > item.y + height * 0.84) continue;
            } else {
              const limit = kind === 'tree' ? 0.83 : 0.70;
              if (slope > limit || (slope > 0.32 && choice > clamp((limit - slope) / (limit - 0.32), 0, 1))) continue;
              item.y = y - (kind === 'tree' ? 0.14 + slope * 0.22 : 0.14 + (y - low) * 0.72);
            }
            item.supportY = y;
            if (site.deckOccupied(x, z, item.y, item.y + height)) continue;
          }
          if (obstacles(x, z, pad, item.y - 0.3, item.y + height)
            || trees(x, z, kind === 'tree' ? Math.max(2.8, radius * 0.78) : pad, item.y - 0.6, item.y + height)
            || !fitsSpacing(item)) continue;
          placed.push(item);
        }
      }
    }
  }
  return placed;
}
