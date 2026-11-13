import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps } from './building-collision.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';
import { addGreenwayLightPool, buildGreenwayLightPool, createFixtureBatches, createGreenwayLightMaterial,
  GREENWAY_LAMP, GREENWAY_RAIL, planLantern, planRail } from './sz-site-fixtures.js';
import { sceneUniforms } from './sz-materials.js';
import { spatialIndex } from './sz-spatial.js';
import { buildSzSea } from './sz-sea.js';

const DETAIL_CELL = 95;
const SUPPORT_CLEARANCE = 1.9;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = ([x, y, z]) => ({ x, y, z });
// 日历按深圳当地日期判定，与画面选用的昼夜时段无关。
const SHENZHEN_OFFSET_MS = 8 * 3600000;

export function relocatedBayPathIds(network) {
  return new Set((network?.bayPaths ?? []).filter(path => path.sourcePoints).map(path => path.osmId));
}

export function createParkGroundAccess({ inPark, inWetland, onRoad, roadDecks }) {
  return (mode, x, z, surface) => {
    if (mode !== 'car' && mode !== 'cyclist') return true;
    const terrain = !surface?.surfaceId || surface.surfaceId === 'terrain' || surface.heightSource === 'terrain';
    if (roadDecks.has(surface?.surfaceId) && !terrain) return true;
    if (terrain && inWetland(x, z)) return false;
    return mode !== 'car' || !inPark(x, z) || (terrain && onRoad(x, z));
  };
}

export function createWaterfrontAccess(source, network, now = Date.now) {
  const paths = network.routes.filter(route => !source?.parkNetwork || route.id !== 'central-bay-cycleway'
    && route.id !== 'central-bay-promenade').flatMap(route => route.paths.filter(path => !path.bridge).map(path => ({
    ...path, mode: route.bank === 'west' || route.id === 'west-bank' ? `west:${path.mode}`
      : route.bank === 'east' || route.id === 'east-bank' ? `east:${path.mode}`
        : route.openingHours === '06:00–23:00' ? `park:${path.mode}` : path.mode
  })));
  paths.push(...(source?.parkNetwork?.bayPaths ?? []).filter(path => !path.bridge)
    .map(path => ({ ...path, mode: 'park:' + path.mode })));
  paths.push(...(source?.parkNetwork?.lakePaths ?? []).map(path => ({ ...path, mode: 'walk' })));
  const accessAt = createBayPathLookup(paths);
  const bridges = new Map((source?.footbridges ?? []).map(bridge => [`waterfront-bridge:${bridge.id}`, bridge]));
  let lastMinute, parkOpen;
  return { allowsGroundMode(mode, x, z, surface) {
    // 单车按实际铺装与桥面承托通行，步行标签和开放时段不阻断游戏骑行。
    if (mode === 'cyclist') return true;
    const id = surface?.surfaceId;
    const bridge = bridges.get(id);
    const modes = bridge ? [bridge.bank ? `${bridge.bank}:${bridge.mode}` : bridge.coastal ? 'park:' + bridge.mode
      : bridge.waterIndex === source.waters?.[1]?.waterIndex ? 'west:' + bridge.mode : bridge.mode]
      : !id || surface?.heightSource === 'terrain' || id === 'terrain' ? accessAt(x, z) : [];
    if (surface?.surfaceId === 'waterfront:bay-lower' && mode !== 'person') return false;
    if (!modes.length) return true;
    if (mode === 'car') return false;
    const minute = Math.floor((now() + SHENZHEN_OFFSET_MS) / 60000);
    if (minute !== lastMinute) {
      const date = new Date(minute * 60000);
      parkOpen = date.getUTCHours() >= 6 && date.getUTCHours() < 23;
      lastMinute = minute;
    }
    return modes.some(entry => {
      const [area, usage] = entry.includes(':') ? entry.split(':') : [null, entry];
      if (area && !parkOpen) return false;
      return usage !== 'cycle';
    });
  } };
}

export function createWaterfrontPaths(source) {
  const relocated = relocatedBayPathIds(source?.parkNetwork);
  const activeRoutes = routes => routes.map(route => ({ ...route, paths: route.paths.filter(p => !relocated.has(p.osmId)) }));
  const extended = activeRoutes(source?.extensions ?? []);
  const routes = [...activeRoutes(source?.routes ?? []), ...extended, ...(source?.dasha?.routes ?? [])];
  const paths = [...routes.flatMap(route => route.paths), ...(source?.parkNetwork?.lakePaths ?? [])];
  const lookup = createBayPathLookup(paths);
  const groundPaths = createBayPathLookup(paths.filter(path => !path.bridge));
  const bankPaths = createBayPathLookup(routes.filter(r => r.bank || r.id.endsWith('-bank')).flatMap(r => r.paths));
  const extensions = createBayPathLookup(extended.flatMap(route => route.paths));
  const lower = source?.bayLower;
  const bay = createBayPathLookup(lower ? [{ mode: 'walk', widthM: lower.widthM ?? 4.2,
    points: lower.points.map(([x, , z]) => [x, z]) }] : []);
  return { lookup, groundPaths, paths, routes,
    reserves: (x, z, pad = 0) => lookup(x, z, pad).length > 0 || bay(x, z, pad).length > 0,
    groundIdentity(x, z) {
      if (bay(x, z).length) return 'waterfront:bay-lower';
      if (bankPaths(x, z).length) return 'waterfront:river-bank';
      if (extensions(x, z).length) return 'waterfront:shore-path';
      return groundPaths(x, z).length ? 'waterfront:lake-path' : 'terrain';
    }
  };
}

export function findWaterfrontWalkPoint(paths, x, z, heading, maxDistance = 4) {
  let best = null;
  let distance = maxDistance;
  for (const path of paths) {
    if (path.bridge || path.mode === 'cycle' || path.kind === 'steps') continue;
    for (let i = 1; i < path.points.length; i++) {
      const [ax, az] = path.points[i - 1], [bx, bz] = path.points[i];
      const dx = bx - ax, dz = bz - az;
      const length2 = dx * dx + dz * dz;
      if (!length2) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
      const px = ax + t * dx, pz = az + t * dz;
      const gap = Math.hypot(x - px, z - pz);
      if (gap >= distance) continue;
      const sign = dx * Math.sin(heading) + dz * Math.cos(heading) < 0 ? -1 : 1;
      best = { x: px, z: pz, heading: Math.atan2(sign * dx, sign * dz) };
      distance = gap;
    }
  }
  return best;
}

export function waterfrontFixtureCollider({ a, b, width, height }, type) {
  const length = distance(a, b);
  const outer = length > 0.001
    ? [[a, 1], [b, 1], [b, -1], [a, -1]].map(([p, s]) =>
      ({ x: p.x + s * (b.z - a.z) / length * width / 2, z: p.z - s * (b.x - a.x) / length * width / 2 }))
    : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) =>
      ({ x: a.x + x * width / 2, z: a.z + z * height / 2 }));
  const verticalPad = length > 0.001 ? height / 2 : 0;
  return { type, polygon: { outer, holes: [] }, minX: Math.min(...outer.map(p => p.x)),
    maxX: Math.max(...outer.map(p => p.x)), minZ: Math.min(...outer.map(p => p.z)),
    maxZ: Math.max(...outer.map(p => p.z)), minY: Math.min(a.y, b.y) - verticalPad, maxY: Math.max(a.y, b.y) + verticalPad };
}

function walkBlocked(obstacles, x, z, y) {
  return [...obstacles].some(c => c.minX < x + 0.38 && c.maxX > x - 0.38
    && c.minZ < z + 0.38 && c.maxZ > z - 0.38 && c.minY < y + SUPPORT_CLEARANCE && c.maxY > y + 0.05
    && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, 0.38, 0.38)));
}

export function planWaterfront(source, { network, elevated, heightAt, nearObstacles,
  deckOccupied = () => false, carriagewayOccupied = () => false }) {
  const colliders = [];
  const buckets = new Map();
  function fixtureBucket(x, z) {
    const ix = Math.floor(x / DETAIL_CELL), iz = Math.floor(z / DETAIL_CELL);
    const key = `${ix},${iz}`;
    if (!buckets.has(key)) buckets.set(key, { key, x: (ix + 0.5) * DETAIL_CELL, z: (iz + 0.5) * DETAIL_CELL,
      steel: [], lamp: [], poolPositions: [], poolUvs: [], colliders: [] });
    return buckets.get(key);
  }
  function add(row, material, type) {
    const batch = fixtureBucket(row.a.x, row.a.z);
    batch[material].push({ ...row, colliderType: type });
    if (type) {
      const collider = waterfrontFixtureCollider(row, type);
      batch.colliders.push(collider);
      colliders.push(collider);
    }
  }
  const fixtureBlocked = (x, y, z, radius, height) => [...nearObstacles(x, z, radius)].some(c => c.minY < y + height && c.maxY > y
    && c.minX < x + radius && c.maxX > x - radius && c.minZ < z + radius && c.maxZ > z - radius
    && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, radius, radius)));
  for (const rail of [...(source?.rails ?? []), ...(source?.dasha?.rails ?? [])]) {
    const isGreenway = rail.id.startsWith('dasha-rail:');
    let previous = null;
    for (const entry of rail.stations) {
      if (!entry) { previous = null; continue; }
      const p = point(entry);
      if (network.groundPaths(p.x, p.z, 0.1).length || isGreenway
        && (carriagewayOccupied(p.x, p.z, 0.32) || fixtureBlocked(p.x, p.y, p.z, 0.12, 1.12))) {
        previous = null;
        continue;
      }
      add({ a: p, b: { ...p, y: p.y + 1.12 }, width: 0.09, height: 0.09 }, 'steel', 'waterfront-post');
      if (!isGreenway) add({ a: p, b: { ...p, y: p.y + 0.11 }, width: 0.18, height: 0.18 }, 'steel', 'waterfront-rail-base');
      const span = previous ? distance(previous, p) : 0;
      const samples = Math.ceil(span / 0.3);
      if (span > 0.05 && (!isGreenway || Math.abs(p.y - previous.y) < 0.5)
        && !Array.from({ length: samples }, (_, i) => (i + 0.5) / samples).some(t => {
          const x = previous.x + (p.x - previous.x) * t, z = previous.z + (p.z - previous.z) * t;
          return network.groundPaths(x, z, 0.18).length || isGreenway && carriagewayOccupied(x, z, 0.30);
        })) {
        for (const bar of planRail(previous, p, GREENWAY_RAIL)) {
          add(bar, 'steel', 'waterfront-rail');
        }
      }
      previous = p;
    }
  }

  const bridgeHeight = createSurfaceHeightAt(elevated.surfaces.filter(s => s.id.startsWith('waterfront-bridge:')));
  for (const route of network.routes.filter(r => !source?.dasha && ['west-bank', 'east-bank'].includes(r.id)
    || !source?.parkNetwork && r.id === 'lychee-loop')) {
    let length = 0, last = 12;
    const points = route.points.map(point);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], run = distance(a, b);
      length += run;
      if (run < 0.1 || length - last < 28) continue;
      for (const side of [1, -1]) {
        const x = b.x + side * (b.z - a.z) / run * 2.9;
        const z = b.z - side * (b.x - a.x) / run * 2.9;
        const y = heightAt(x, z);
        if (!Number.isFinite(y) || network.reserves(x, z, 0.58)
          || fixtureBlocked(x, y, z, 0.75, 3.25)
          || elevated.surfaces.some(s => s.id.startsWith('waterfront-bridge:')
            && Number.isFinite(bridgeHeight(x, z, s.id)))
          || (route.id.endsWith('-bank') && b.y < 5.2)) continue;
        const { pole, lamp } = planLantern({ x, y, z }, {
          poleBottomM: 0, poleTopM: 3.05, headBottomM: 3.03, headTopM: 3.19, headWidthM: 0.25
        });
        add(pole, 'steel', 'waterfront-lamp');
        add(lamp, 'lamp');
        last = length;
        break;
      }
    }
  }

  for (const [x, y, z, pathX, pathZ] of source?.dasha?.lamps ?? []) {
    if (network.reserves(x, z, 0.55) || carriagewayOccupied(x, z, 0.55)
      || fixtureBlocked(x, y, z, 0.55, 4.2) || deckOccupied(x, z, y, y + 4.2)) continue;
    const { pole, lamp } = planLantern({ x, y, z }, GREENWAY_LAMP);
    add(pole, 'steel', 'waterfront-lamp');
    add(lamp, 'lamp');
    addGreenwayLightPool(fixtureBucket(x, z), { x: pathX, z: pathZ }, heightAt);
  }

  for (const route of source?.parkNetwork?.lakeLamps ?? []) {
    for (const { x, z, side, dx, dz } of planLakeLamps(route)) {
      for (const setback of [1.1, 1.8, 2.65]) {
        const offset = (route.widthM / 2 + setback) * side;
        const px = x + dz * offset, pz = z - dx * offset;
        const y = heightAt(px, pz);
        if (!Number.isFinite(y) || network.reserves(px, pz, 0.55)
          || fixtureBlocked(px, y, pz, 0.64, 3.25)) continue;
        const { pole, lamp } = planLantern({ x: px, y, z: pz }, {
          poleBottomM: -0.04, poleTopM: 3.05, headBottomM: 3.01, headTopM: 3.20, headWidthM: 0.27
        });
        add(pole, 'steel', 'waterfront-lamp');
        add(lamp, 'lamp');
        break;
      }
    }
  }

  const nearFixtures = spatialIndex(colliders, c => c.polygon.outer);
  const publicRoutes = network.routes.flatMap(route => {
    // 桥与岸路分别取实际三角面。同一 XZ 上的桥面不会把桥下人物抬起。
    return route.paths.map((path, index) => {
      if (path.mode === 'cycle') return null;
      const near = createBayPathLookup([path]);
      const surfaceId = path.bridge ? `waterfront-bridge:${path.osmId}` : null;
      const support = surfaceId ? (x, z) => bridgeHeight(x, z, surfaceId) : heightAt;
      const publicHeight = (x, z) => {
        if (!near(x, z, -0.45).length) return null;
        const y = support(x, z);
        return Number.isFinite(y) && !walkBlocked([...nearObstacles(x, z, 0.4), ...nearFixtures(x, z, 0.4)], x, z, y) ? y : null;
      };
      const points = path.points.map(([x, z]) => ({ x, y: support(x, z), z }));
      const clear = points.map(p => Number.isFinite(p.y) && publicHeight(p.x, p.z) !== null);
      return points.every(p => Number.isFinite(p.y)) && clear.some(Boolean)
        ? { id: `waterfront:${route.id}:${index}`, sourceRouteId: route.id, sourcePathIndex: index, points, clear, widthM: path.widthM,
          surfaceId, mode: path.mode }
        : null;
    }).filter(Boolean);
  });
  return { batches: [...buckets.values()], colliders, publicRoutes };
}

export function createWaterfrontPublicRoutes(routes, heightAt, surfaces, nearObstacles) {
  if (!routes.length) return [];
  const bridgeHeight = createSurfaceHeightAt(surfaces.filter(s => s.id.startsWith('waterfront-bridge:')));
  return routes.map(({ widthM, mode, clear, ...route }) => {
    const near = createBayPathLookup([{ widthM, mode, points: route.points.map(({ x, z }) => [x, z]) }]);
    // 玩家和行人继续贴合对应的实际三角面，区域步行碰撞用同一份障碍数据。
    return { ...route, clear, jogSpeed: 2.15,
      publicHeight(x, z) {
        if (!near(x, z, -0.45).length) return null;
        const y = route.surfaceId ? bridgeHeight(x, z, route.surfaceId) : heightAt(x, z);
        return Number.isFinite(y) && (!nearObstacles || !walkBlocked(nearObstacles(x, z, 0.4), x, z, y)) ? y : null;
      },
      reserve: (x, z) => near(x, z, 0.5).length > 0 };
  });
}

export function mountWaterfrontBatch(group, batch, poolMaterial) {
  const fixtures = createFixtureBatches(group, 'bay', 'z');
  fixtures.build(batch.steel, 'steel', `waterfront-steel:${batch.key}`);
  fixtures.build(batch.lamp, 'lamp', `waterfront-lamps:${batch.key}`);
  const pool = poolMaterial && batch.poolPositions?.length
    ? buildGreenwayLightPool(batch, poolMaterial, `waterfront-path-light:${batch.key}`) : null;
  if (pool) group.add(pool);
  return { update() { if (pool) pool.visible = sceneUniforms.night.value > 0.025; }, dispose() {
    fixtures.dispose();
    pool?.removeFromParent();
    pool?.geometry.dispose();
  } };
}

export function waterfrontWaterRows(source) {
  return [...(source?.waters ?? []), ...(source?.extensionWaters ?? []), ...(source?.bridgeWaters ?? []),
    ...(source?.parkNetwork?.waters ?? []), ...(source?.dasha?.waters ?? [])];
}

export function mountWaterfrontBank(group, { stations, heightM, waterId }) {
  const positions = [];
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    const toeA = [a[3], heightM, a[4]], toeB = [b[3], heightM, b[4]];
    positions.push(...a.slice(0, 3), ...b.slice(0, 3), ...toeA, ...toeA, ...b.slice(0, 3), ...toeB);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x89857b, roughness: 0.96, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `dasha-bank:${waterId}`;
  mesh.receiveShadow = true;
  group.add(mesh);
  mesh.updateMatrixWorld(true);
  return { dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose(); } };
}

export function buildSzWaterfront(scene, source, { water, network, elevated, heightAt, obstacles, deckOccupied, carriagewayOccupied }) {
  const group = new THREE.Group();
  group.name = 'shenzhen-waterfront-samples';
  const waters = waterfrontWaterRows(source).map(row => buildSzSea(group, {
    polygons: [water[row.waterIndex]], heightM: row.heightM, source: row.id
  }, { name: `waterfront-water:${row.id}`, coastal: false, cityReflection: false }));
  const poolMaterial = source?.dasha ? createGreenwayLightMaterial() : null;
  const banks = (source?.dasha?.banks ?? []).filter(row => row.stations.length > 1)
    .map(row => mountWaterfrontBank(group, row));
  const nearObstacles = spatialIndex(obstacles, c => [{ x: c.minX, z: c.minZ }, { x: c.maxX, z: c.maxZ }]);
  const { batches, colliders, publicRoutes } = planWaterfront(source, { network, elevated, heightAt, nearObstacles, deckOccupied, carriagewayOccupied });
  const nearFixtures = spatialIndex(colliders, c => c.polygon.outer);
  for (const batch of batches) batch.live = null;
  scene.add(group);
  const statistics = { fixtureChunks: batches.length, activeFixtureChunks: 0, colliders: colliders.length };
  let disposed = false;
  return {
    group, colliders, publicRoutes: createWaterfrontPublicRoutes(publicRoutes, heightAt, elevated.surfaces,
      (x, z, radius) => [...nearObstacles(x, z, radius), ...nearFixtures(x, z, radius)]), statistics,
    ...createWaterfrontAccess(source, network),
    update({ x, z }) {
      if (disposed) return;
      for (const batch of batches) {
        const d = Math.hypot(batch.x - x, batch.z - z);
        if (batch.live && d > 335) {
          batch.live.dispose();
          batch.live = null;
          statistics.activeFixtureChunks--;
        } else if (!batch.live && d < 275) {
          batch.live = mountWaterfrontBatch(group, batch, poolMaterial);
          statistics.activeFixtureChunks++;
        }
        batch.live?.update();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of batches) batch.live?.dispose();
      for (const water of waters) water.dispose();
      for (const bank of banks) bank.dispose();
      poolMaterial?.dispose();
      group.removeFromParent();
    }
  };
}

export function planLakeLamps({ points, spacingM }) {
  const stations = [];
  let along = 0;
  let next = spacingM * 0.5;
  for (let i = 1; i < points.length; i++) {
    const [x, , z] = points[i - 1], [nx, , nz] = points[i];
    const run = Math.hypot(nx - x, nz - z);
    if (run < 0.001) continue;
    const dx = (nx - x) / run, dz = (nz - z) / run;
    while (next < along + run) {
      const step = next - along;
      stations.push({ x: x + dx * step, z: z + dz * step, dx, dz, side: stations.length % 2 ? -1 : 1 });
      next += spacingM;
    }
    along += run;
  }
  return stations;
}
