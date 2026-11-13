import * as THREE from 'three/webgpu';
import { polygonBoxOverlaps } from './building-collision.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';
import { createFixtureBatches, planLantern, planRail } from './sz-site-fixtures.js';
import { buildSzSea } from './sz-sea.js';

const DETAIL_CELL = 95;
const SUPPORT_CLEARANCE = 1.9;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = ([x, y, z]) => ({ x, y, z });

export function createWaterfrontPaths(source) {
  const routes = source?.routes ?? [];
  const paths = routes.flatMap(route => route.paths);
  const lookup = createBayPathLookup(paths);
  const groundPaths = createBayPathLookup(paths.filter(path => !path.bridge));
  const bankPaths = createBayPathLookup(routes.filter(r => r.id.endsWith('-bank')).flatMap(r => r.paths));
  const lower = source?.bayLower;
  const bay = createBayPathLookup(lower ? [{ mode: 'walk', widthM: lower.widthM ?? 4.2,
    points: lower.points.map(([x, , z]) => [x, z]) }] : []);
  return { lookup, paths, routes,
    reserves: (x, z, pad = 0) => lookup(x, z, pad).length > 0 || bay(x, z, pad).length > 0,
    groundIdentity(x, z) {
      if (bay(x, z).length) return 'waterfront:bay-lower';
      if (bankPaths(x, z).length) return 'waterfront:river-bank';
      return groundPaths(x, z).length ? 'waterfront:lake-path' : 'terrain';
    }
  };
}

function beamCollider({ a, b, width, height }, type) {
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

export function buildSzWaterfront(scene, source, { water, network, elevated, heightAt, obstacles }) {
  const group = new THREE.Group();
  group.name = 'shenzhen-waterfront-samples';
  const waters = (source?.waters ?? []).map(row => buildSzSea(group, {
    polygons: [water[row.waterIndex]], heightM: row.heightM, source: row.id
  }, { name: `waterfront-water:${row.id}`, coastal: false, cityReflection: false }));
  const colliders = [];
  const buckets = new Map();
  function add(row, material, type) {
    const ix = Math.floor(row.a.x / DETAIL_CELL), iz = Math.floor(row.a.z / DETAIL_CELL);
    const key = `${ix},${iz}`;
    if (!buckets.has(key)) buckets.set(key, { key, x: (ix + 0.5) * DETAIL_CELL, z: (iz + 0.5) * DETAIL_CELL,
      steel: [], lamp: [], live: null });
    buckets.get(key)[material].push(row);
    if (type) colliders.push(beamCollider(row, type));
  }
  for (const rail of source?.rails ?? []) {
    let previous = null;
    for (const entry of rail.stations) {
      if (!entry) { previous = null; continue; }
      const p = point(entry);
      add({ a: p, b: { ...p, y: p.y + 1.08 }, width: 0.08, height: 0.08 }, 'steel', 'waterfront-post');
      add({ a: p, b: { ...p, y: p.y + 0.11 }, width: 0.18, height: 0.18 }, 'steel', 'waterfront-rail-base');
      if (previous && distance(previous, p) > 0.05) {
        for (const bar of planRail(previous, p, [[0.49, 0.07, 0.07], [1.03, 0.085, 0.075]])) {
          add(bar, 'steel', 'waterfront-rail');
        }
      }
      previous = p;
    }
  }

  const bridgeHeight = createSurfaceHeightAt(elevated.surfaces.filter(s => s.id.startsWith('waterfront-bridge:')));
  const fixtureBlocked = (x, y, z, radius, height) => obstacles.some(c => c.minY < y + height && c.maxY > y
    && c.minX < x + radius && c.maxX > x - radius && c.minZ < z + radius && c.maxZ > z - radius
    && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, radius, radius)));
  for (const route of network.routes.filter(r => ['lychee-loop', 'west-bank', 'east-bank'].includes(r.id))) {
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

  const obstaclesByCell = new Map();
  const cellKey = (x, z) => `${x},${z}`;
  const size = 32;
  for (const c of [...colliders, ...obstacles]) {
    for (let ix = Math.floor((c.minX - 0.4) / size); ix <= Math.floor((c.maxX + 0.4) / size); ix++) {
      for (let iz = Math.floor((c.minZ - 0.4) / size); iz <= Math.floor((c.maxZ + 0.4) / size); iz++) {
        const key = cellKey(ix, iz);
        if (!obstaclesByCell.has(key)) obstaclesByCell.set(key, []);
        obstaclesByCell.get(key).push(c);
      }
    }
  }
  const nearObstacles = (x, z) => obstaclesByCell.get(cellKey(Math.floor(x / size), Math.floor(z / size))) ?? [];
  const publicRoutes = network.routes.flatMap(route => {
    // 桥与岸路分别取实际三角面。同一 XZ 上的桥面不会把桥下人物抬起。
    return route.paths.map((path, index) => {
      const near = createBayPathLookup([path]);
      const surfaceId = path.bridge ? `waterfront-bridge:${path.osmId}` : null;
      const support = surfaceId ? (x, z) => bridgeHeight(x, z, surfaceId) : heightAt;
      const publicHeight = (x, z) => {
        if (!near(x, z, -0.45).length) return null;
        const y = support(x, z);
        return Number.isFinite(y) && !nearObstacles(x, z).some(c => c.minX < x + 0.38 && c.maxX > x - 0.38
          && c.minZ < z + 0.38 && c.maxZ > z - 0.38 && c.minY < y + SUPPORT_CLEARANCE && c.maxY > y + 0.05
          && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, 0.38, 0.38))) ? y : null;
      };
      const points = path.points.map(([x, z]) => ({ x, y: support(x, z), z }));
      return points.every(p => Number.isFinite(p.y)) && points.some(p => publicHeight(p.x, p.z) !== null)
        ? { id: `waterfront:${route.id}:${index}`, points, publicHeight, jogSpeed: 2.15,
          surfaceId, restSide: () => undefined, reserve: (x, z) => near(x, z, 0.5).length > 0 }
        : null;
    }).filter(Boolean);
  });
  scene.add(group);
  const statistics = { fixtureChunks: buckets.size, activeFixtureChunks: 0, colliders: colliders.length };
  let disposed = false;
  return {
    group, colliders, publicRoutes, statistics,
    update({ x, z }) {
      if (disposed) return;
      for (const batch of buckets.values()) {
        const d = Math.hypot(batch.x - x, batch.z - z);
        if (batch.live && d > 335) {
          batch.live.dispose();
          batch.live = null;
          statistics.activeFixtureChunks--;
        } else if (!batch.live && d < 275) {
          batch.live = createFixtureBatches(group, 'bay', 'z');
          batch.live.build(batch.steel, 'steel', `waterfront-steel:${batch.key}`);
          batch.live.build(batch.lamp, 'lamp', `waterfront-lamps:${batch.key}`);
          statistics.activeFixtureChunks++;
        }
      }
    },
    allowsGroundMode(mode, x, z, surface) {
      if (mode === 'person' || surface?.surfaceId.startsWith('sz-elevated-road:')) return true;
      if (surface?.surfaceId.startsWith('waterfront-bridge:')) {
        const bridge = source.footbridges.find(b => `waterfront-bridge:${b.id}` === surface.surfaceId);
        return mode === 'cyclist' && bridge?.mode === 'shared';
      }
      const modes = network.lookup(x, z);
      return mode === 'car' ? !modes.length : !modes.includes('walk') || modes.includes('shared');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of buckets.values()) batch.live?.dispose();
      for (const water of waters) water.dispose();
      group.removeFromParent();
    }
  };
}
