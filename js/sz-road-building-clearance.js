import { polygonSegmentFraction } from './building-collision.js';
import { isGroundRoad, roadTravelPoints } from './sz-roads.js';

const CELL_M = 64;
const VEHICLE_CLEARANCE_M = 4.5;
const GIRDER_DEPTH_M = 0.35;
const MIN_CONFLICT_M = 2.5;

function heightOverlap(a, b, minY, maxY, depth) {
  const rise = b.y - a.y;
  const bottom = minY - VEHICLE_CLEARANCE_M;
  const top = maxY + depth;
  if (!rise) return a.y > bottom && a.y < top ? [0, 1] : null;
  const from = (bottom - a.y) / rise, to = (top - a.y) / rise;
  const enter = Math.max(0, Math.min(from, to)), exit = Math.min(1, Math.max(from, to));
  return enter < exit ? [enter, exit] : null;
}

// 用道路中部的车行轨迹判定补充轮廓是否占道，避免因估计路缘擦到临街楼而整栋撤出。
// 桥面轨迹和标高从桥面断面读取，地面轨迹用实际铺装的采样高度。
export function createRoadBuildingClearance(graph, roadHeight, decks = []) {
  const cells = new Map();
  const cell = coordinate => Math.floor(coordinate / CELL_M);
  function indexTrack(points, key, elevated) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const bounds = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
      const segment = { a, b, dx, dz, length, key, bounds, elevated };
      for (let x = cell(bounds.minX); x <= cell(bounds.maxX); x++) {
        for (let z = cell(bounds.minZ); z <= cell(bounds.maxZ); z++) {
          const cellKey = `${x},${z}`;
          if (!cells.has(cellKey)) cells.set(cellKey, []);
          cells.get(cellKey).push(segment);
        }
      }
    }
  }
  for (const [index, link] of graph.links.entries()) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata) || metadata.highway === 'pedestrian') continue;
    const points = roadTravelPoints(graph, link, metadata);
    if (points.length < 2) continue;
    const track = [{ ...points[0] }];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const steps = Math.ceil(Math.hypot(dx, dz) / 8);
      for (let n = 1; n <= steps; n++) {
        const x = a.x + dx * n / steps, z = a.z + dz * n / steps;
        track.push({ x, z });
      }
    }
    indexTrack(track, `ground:${metadata.osmId ?? index}`, false);
  }
  for (const deck of decks) {
    const offsets = deck.width >= 8 ? [0.25, 0.5, 0.75] : [0.5];
    for (const t of offsets) {
      const track = deck.frames.map(({ left, right, y }) => ({
        x: left.x + (right.x - left.x) * t, z: left.z + (right.z - left.z) * t, y
      }));
      indexTrack(track, `${deck.surfaceId}:${t}`, true);
    }
  }

  return function conflicts(polygon, bounds, minY, maxY, elevatedOnly = false) {
    const seen = new Set(), lengths = new Map();
    for (let x = cell(bounds.minX); x <= cell(bounds.maxX); x++) {
      for (let z = cell(bounds.minZ); z <= cell(bounds.maxZ); z++) {
        for (const segment of cells.get(`${x},${z}`) ?? []) {
          const { a, b, dx, dz, length, key, bounds: road, elevated } = segment;
          if ((elevatedOnly && !elevated) || seen.has(segment)
            || road.minX > bounds.maxX || road.maxX < bounds.minX
            || road.minZ > bounds.maxZ || road.maxZ < bounds.minZ) continue;
          seen.add(segment);
          if (!Object.hasOwn(a, 'y')) a.y = roadHeight(a.x, a.z);
          if (!Object.hasOwn(b, 'y')) b.y = roadHeight(b.x, b.z);
          if (!Number.isFinite(a.y) || !Number.isFinite(b.y)) continue;
          const span = heightOverlap(a, b, minY, maxY, elevated ? GIRDER_DEPTH_M : 0);
          if (!span) continue;
          const [enter, exit] = span;
          const inside = polygonSegmentFraction(polygon, a.x, a.z, dx, dz, enter, exit) * length;
          if (inside <= 0) continue;
          const total = (lengths.get(key) ?? 0) + inside;
          if (total >= MIN_CONFLICT_M) return key;
          lengths.set(key, total);
        }
      }
    }
    return null;
  };
}
