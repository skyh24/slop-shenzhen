import { createWalkSweep, routeAroundObstacles } from './sz-public-walk.js';

const PERSON_RADIUS = 0.48;

// 地表包已保留现有高程。此处只注册来源支持且通过场景扫掠的通行带和设施避让。
export function createUrbanPavingWalk(data, heightAt) {
  const routes = (data?.publicRoutes ?? []).map(route => {
    const points = route.pointsXZ.map(([x, z]) => ({ x, z }));
    const half = route.widthM / 2;
    const bounds = { minX: Math.min(...points.map(p => p.x)) - half,
      maxX: Math.max(...points.map(p => p.x)) + half,
      minZ: Math.min(...points.map(p => p.z)) - half,
      maxZ: Math.max(...points.map(p => p.z)) + half };
    function distance(x, z) {
      let nearest = Infinity;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const lengthSquared = dx * dx + dz * dz;
        const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)) : 0;
        nearest = Math.min(nearest, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
      }
      return nearest;
    }
    const reserves = (x, z, pad = 0) => x >= bounds.minX - pad && x <= bounds.maxX + pad
      && z >= bounds.minZ - pad && z <= bounds.maxZ + pad && distance(x, z) <= half + pad;
    const walkAt = (x, z) => reserves(x, z) && Number.isFinite(heightAt(x, z));
    return { points, bounds, reserves, walkAt, id: route.id, lateralM: route.lateralM,
      allows: (x, z, r) => distance(x, z) + r <= half && Number.isFinite(heightAt(x, z)), heightAt };
  });
  return {
    reserves: (x, z, pad) => routes.some(route => route.reserves(x, z, pad)),
    trees: (data?.trees ?? []).map(tree => ({ ...tree, positionSource: 'simulated-park' })),
    connect(colliders, carriageway) {
      return routes.flatMap(route => {
        const sweep = createWalkSweep(route, route.id, colliders, carriageway, route.bounds);
        const points = routeAroundObstacles(route.points, sweep, PERSON_RADIUS + route.lateralM);
        if (!points) return [];
        return [{ id: 'public-walk:' + route.id, points: points.map(p => ({ ...p, y: heightAt(p.x, p.z) })),
          walkAt: route.walkAt, reserve: route.reserves, lateralM: route.lateralM,
          singleFile: true, restSide: () => null,
          publicHeight: (x, z) => route.walkAt(x, z) ? heightAt(x, z) : null }];
      });
    }
  };
}
