import { createGroundSurfaceSampler } from './sz-ground-surface.js';

const CELL = 250;
const key = (x, z) => `${x},${z}`;

export function ringContains(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (x - a.x) * (b.z - a.z) - (z - a.z) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)
      && z >= Math.min(a.z, b.z) && z <= Math.max(a.z, b.z)) return true;
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonContains(shape, x, z) {
  return ringContains(shape.outer, x, z) && !shape.holes.some(ring => ringContains(ring, x, z));
}

function spatialIndex(items, pointsOf) {
  const cells = new Map();
  for (const item of items) {
    const points = pointsOf(item);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) {
      for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) {
        const cell = key(x, z);
        if (!cells.has(cell)) cells.set(cell, []);
        cells.get(cell).push(item);
      }
    }
  }
  return (x, z, radius = 0) => {
    const found = new Set();
    for (let i = Math.floor((x - radius) / CELL); i <= Math.floor((x + radius) / CELL); i++) {
      for (let j = Math.floor((z - radius) / CELL); j <= Math.floor((z + radius) / CELL); j++) {
        for (const item of cells.get(key(i, j)) || []) found.add(item);
      }
    }
    return found;
  };
}

export function createCitySpatial(geo) {
  const surfaceHeight = createGroundSurfaceSampler(geo.terrainSurface);
  const coverage = spatialIndex(geo.coverage, p => p.outer);
  const land = spatialIndex(geo.land, p => p.outer);
  const water = spatialIndex(geo.water, p => p.outer);
  const contains = (index, x, z) => [...index(x, z)].some(p => polygonContains(p, x, z));
  const inBounds = (x, z) => Number.isFinite(x) && Number.isFinite(z)
    && x >= geo.bounds[0] && x <= geo.bounds[2] && z >= geo.bounds[1] && z <= geo.bounds[3]
    && contains(coverage, x, z);
  const isOnLand = (x, z) => inBounds(x, z) && contains(land, x, z) && !contains(water, x, z);
  const graph = geo.roadGraph;
  const roads = graph.links.map(([a, b, name, width, lanes, direction, inner], i) => {
    const pts = [{ x: graph.nodes[a * 2], z: graph.nodes[a * 2 + 1] }];
    for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
    pts.push({ x: graph.nodes[b * 2], z: graph.nodes[b * 2 + 1] });
    return { id: i, name: graph.names[name], w: width, lanes, dir: direction, pts, ...graph.metadata[i] };
  });
  const roadIndex = spatialIndex(roads, r => r.pts);
  function nearestRoads(x, z, radius = 160) {
    if (!inBounds(x, z) || !Number.isFinite(radius) || radius < 0) return [];
    const found = [];
    for (const road of roadIndex(x, z, radius)) {
      let best = null;
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1], b = road.pts[i];
        const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
        if (!length2) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
        const px = a.x + dx * t, pz = a.z + dz * t;
        const distance = Math.hypot(x - px, z - pz);
        if (distance <= radius && (!best || distance < best.distance)) {
          best = { road, distance, x: px, z: pz, horizontal: Math.abs(dx) > Math.abs(dz),
            heading: Math.atan2(dx, dz) };
        }
      }
      if (best) found.push(best);
    }
    return found.sort((a, b) => a.distance - b.distance || a.road.id - b.road.id);
  }
  return { roads, inBounds, isOnLand,
    // 范围外没有海岸数据，返回未知；桥面高度也不能从 layer 或地面高程猜测。
    isWater: (x, z) => inBounds(x, z) ? !isOnLand(x, z) : null,
    groundHeight: (x, z) => isOnLand(x, z) ? surfaceHeight(x, z) : null,
    nearestRoads };
}
