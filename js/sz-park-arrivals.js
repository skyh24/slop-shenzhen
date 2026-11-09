import { polygonContains } from './building-collision.js';

const OFFSETS = [[0, 0], ...[2, 4, 8, 16].flatMap(distance => Array.from({ length: 12 }, (_, index) => {
  const angle = index * Math.PI / 6;
  return [Math.cos(angle) * distance, Math.sin(angle) * distance];
}))];

export function parkAt(parks, x, z) {
  for (const park of parks) {
    const areas = park.areas.filter(area => polygonContains(area.polygon, x, z));
    if (areas.length > 0) return { ...park, areas };
  }
  return null;
}

export function findParkArrival(target, park, radius, isClear) {
  const candidates = [];
  for (const area of park.areas) {
    if (polygonContains(area.polygon, target.x, target.z)) {
      candidates.push({ x: target.x, z: target.z, area, distance: 0 });
    }
    for (const [x, z] of area.arrivals) {
      candidates.push({ x, z, area, distance: Math.hypot(x - target.x, z - target.z) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.area.osmId.localeCompare(b.area.osmId));

  // 候选偏移只用于避开即时碰撞，整个步行脚印必须仍在同一已确认的公园成员面内。
  const span = [-radius, 0, radius];
  for (const { x, z, area } of candidates) {
    for (const [dx, dz] of OFFSETS) {
      const point = { x: x + dx, z: z + dz, parkAreaId: area.osmId };
      const inside = span.every(u => span.every(v => polygonContains(area.polygon, point.x + u, point.z + v)));
      if (inside && isClear(point)) return point;
    }
  }
  return null;
}
