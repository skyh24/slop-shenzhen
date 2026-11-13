import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const three = process.env.SZ_THREE_PACKAGE_DIR
  ? pathToFileURL(resolve(process.env.SZ_THREE_PACKAGE_DIR) + '/')
  : new URL('../../.agents/three-0.187.0/', import.meta.url);
if (JSON.parse(readFileSync(new URL('package.json', three))).version !== '0.187.0') {
  throw new Error('Regional scene planning requires Three.js 0.187.0');
}
const aliases = { three: 'build/three.webgpu.js', 'three/webgpu': 'build/three.webgpu.js', 'three/tsl': 'build/three.tsl.js' };
const dependencies = new Set([fileURLToPath(import.meta.url)]);
registerHooks({ resolve(specifier, context, next) {
  const file = aliases[specifier] ?? (specifier.startsWith('three/addons/') ? `examples/jsm/${specifier.slice(13)}` : null);
  const result = next(file ? new URL(file, three).href : specifier, context);
  if (['../../js/', '../../data/source/'].some(dir => result.url.startsWith(new URL(dir, import.meta.url).href))) {
    dependencies.add(fileURLToPath(result.url));
  }
  return result;
} });

// 直接注入本次构建的城市包。共享场地生成器中的少量画布只产生贴图，不影响选址。
const raw = readFileSync(process.argv[2]);
globalThis.fetch = async () => new Response(raw);
const noop = () => {};
const context = new Proxy({ measureText: text => ({ width: String(text).length * 12 }),
  createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }, {
  get: (target, key) => target[key] ?? noop
});
globalThis.document = { createElement: () => ({ getContext: () => context }), addEventListener: noop };

const { Scene } = await import('three/webgpu');
const { GEO } = await import('../../js/sz-geodata.js');
const { prepareSceneSite } = await import('../../js/sz-scene-site.js');
const { planBayWaterfront } = await import('../../js/sz-bay-waterfront.js');
const { planWaterfront } = await import('../../js/sz-waterfront.js');
const { planMetroPlacement, metroEntranceCollider } = await import('../../js/sz-metro-entrances.js');
const { planSceneDroneFlights, droneStationColliders } = await import('../../js/sz-drone-routes.js');
const { spatialIndex } = await import('../../js/sz-spatial.js');
const { REGIONAL_SCENE_VERSION } = await import('../../js/sz-regional-format.js');
const run = (_, build) => build();
const scene = new Scene();
const { site, bayPaths, waterfrontPaths, talentPark, elevatedRoads, trees, vegetation, colliders } = await prepareSceneSite(scene, {
  qa: { stage: run, measureBuild: run }, showLoadingStage: noop, markInit: noop, startup: {}, offline: true
});

const corners = ({ minX, minZ, maxX, maxZ }) => [{ x: minX, z: minZ }, { x: maxX, z: maxZ }];
const nearBuildings = spatialIndex(site.colliders, corners);
const metro = planMetroPlacement(GEO.metro, { ...site, nearObstacles: nearBuildings });
colliders.push(...metro.placed.map(metroEntranceCollider));
const flight = planSceneDroneFlights(GEO.air, site, colliders,
  bounds => [...trees.flightObstacles(bounds), ...vegetation.flightObstacles(bounds)]);
for (const station of flight.stations) if (station.available) colliders.push(...droneStationColliders(station));
const nearBase = spatialIndex(colliders, corners);
const bay = planBayWaterfront(GEO.shenzhenBay, { ...site, pathsNear: bayPaths, nearObstacles: nearBase });
const nearBay = spatialIndex(bay.colliders, corners);
const shore = planWaterfront(GEO.waterfront, { network: waterfrontPaths, elevated: elevatedRoads,
  heightAt: site.heightAt, nearObstacles: (x, z, r) => [...nearBase(x, z, r), ...nearBay(x, z, r)] });

const cells = [];
const data = {};
function boundsOf(points) {
  return [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.z)),
    Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.z))];
}

function cell(kind, points, payload, count, { safety, routeId } = {}) {
  const id = `${kind}-${cells.length}`;
  const row = { id, kind, bounds: boundsOf(points), count };
  if (safety?.length) {
    row.safety = boundsOf(safety.flatMap(corners));
    row.safetyY = [Math.min(...safety.map(c => c.minY)), Math.max(...safety.map(c => c.maxY))];
  }
  if (routeId) row.routeId = routeId;
  cells.push(row);
  data[id] = payload;
}

// 碰撞体保留原多边形和高度，视觉实例使用端点方向。坐标精度保留至 1 毫米。
function packFixtures(rows) {
  return rows.map(({ a, b, width, height }) => [a.x, a.y, a.z, b.x, b.y, b.z, width, height].map(round));
}
const round = value => Math.round(value * 1000) / 1000;
const packPoints = points => points.map(({ x, y, z }) => [round(x), round(y), round(z)]);

const metroCells = new Map();
for (const entrance of metro.placed) {
  const key = `${Math.floor(entrance.x / 500)},${Math.floor(entrance.z / 500)}`;
  if (!metroCells.has(key)) metroCells.set(key, []);
  metroCells.get(key).push(entrance);
}
for (const placed of metroCells.values()) {
  // 限制单块图集与实例批次，密集枢纽也可跨帧构建。
  for (let offset = 0; offset < placed.length; offset += 20) {
    const entrances = placed.slice(offset, offset + 20).map(({ id, x, y, z, yaw, stationId, stationName, ref, lineRefs, colours, facingSource }) =>
      ({ id, x, y, z, yaw, stationId, stationName, ref, lineRefs, colours, facingSource }));
    cell('metro', entrances, entrances, entrances.length, { safety: entrances.map(metroEntranceCollider) });
  }
}

function fixtureCells(plan, kind, finishes) {
  for (const { colliders = [], ...batch } of plan.batches) {
    for (const finish of finishes) batch[finish] = packFixtures(batch[finish]);
    for (const field of ['positions', 'colors', 'poolPositions', 'poolUvs']) {
      if (batch[field]) batch[field] = batch[field].map(round);
    }
    cell(kind, [{ x: batch.x, z: batch.z }, ...colliders.flatMap(corners)], { batch, colliders },
      finishes.reduce((n, finish) => n + batch[finish].length, 0), { safety: colliders });
  }
}
fixtureCells(bay, 'bay', ['metal', 'wood', 'light']);
fixtureCells(shore, 'shore', ['steel', 'lamp']);
if (bay.routePoints.length) cell('bay-walk', bay.routePoints, { points: bay.routePoints, restSpots: bay.restSpots }, 1);
for (const route of shore.publicRoutes) cell('shore-walk', route.points, route, 1);
for (const row of ['waters', 'extensionWaters', 'bridgeWaters'].flatMap(key => GEO.waterfront?.[key] ?? [])) {
  cell('shore-water', GEO.water[row.waterIndex].outer, row, 1);
}

let talent = null;
if (talentPark.plan) {
  const { surfaces, pilotTrees, colliders: local, ...visuals } = talentPark.plan;
  talent = { surfaces, pilotTrees };
  const { extent } = talentPark.waterfront;
  for (const finish of ['steel', 'wall', 'timber', 'lamps']) visuals[finish] = packFixtures(visuals[finish]);
  cell('talent', corners(extent), { ...visuals, colliders: local },
    visuals.steel.length + visuals.lamps.length + visuals.timber.length + visuals.wall.length + visuals.risers.length, { safety: local });
}

const routes = flight.routes.map(({ path, from, to, ...route }) => {
  const { points, legs, runHeadings, ...motion } = path;
  if (points) {
    const motionBounds = points.filter((_, i) => i === 0 || i % 8 === 0 || i === points.length - 1);
    // 用低密度折线做全图和接近查询；运动始终用完整的离线采样。
    const overview = motionBounds.map(({ x, z }) => ({ x: round(x), z: round(z) }));
    cell('flight', points, { ...motion, runHeadings, legs: legs.map(({ segment, ...leg }) =>
      ({ ...leg, segment: segment.map(({ x, y, z }) => [x, y, z]) })) }, legs.length, { routeId: route.id });
    for (let start = 0; start < points.length - 1; start += 24) {
      const section = points.slice(start, start + 25);
      cell('flight-line', section, packPoints(section), 1, { routeId: route.id });
    }
    return { ...route, path: { ...motion, points: overview } };
  }
  return { ...route, path: motion };
});
for (const station of flight.stations) {
  if (station.available) cell('drone-station', [station], station.id, 1, { safety: droneStationColliders(station) });
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rules = Object.fromEntries([...dependencies].sort().map(path => [relative(root, path), sha(readFileSync(path))]));
const fingerprint = sha(JSON.stringify({ inputs: sha(raw), rules, version: REGIONAL_SCENE_VERSION }));
const manifest = { version: REGIONAL_SCENE_VERSION, fingerprint, talent, drone: { stations: flight.stations, routes }, cells };
writeFileSync(process.argv[3], JSON.stringify({ manifest, data, rules,
  audit: { metro: { ...metro.baseStatistics, rejected: metro.skippedEntrances }, bay: bay.statistics,
    shore: { walkRoutes: shore.publicRoutes.length, colliders: shore.colliders.length },
    drone: routes.map(({ id, path }) => ({ id, reason: path.reason, cruiseY: path.cruiseY, detour: path.detour })) } }));
