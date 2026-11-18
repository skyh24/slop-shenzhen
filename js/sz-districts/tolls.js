import { polygonBoxOverlaps, polygonSegmentFraction } from '../building-collision.js';
import { buildingPlacement } from '../sz-building-layout.js';
import { createSurfaceHeightAt } from '../sz-controller-surfaces.js';
import { orientedBoxRing, polygonContainsInclusive } from '../sz-polygon.js';
import { getRoadSection } from '../sz-road-section.js';
import { isGroundRoad, roadSectionPoints } from '../sz-roads.js';
import { STR } from '../sz-strings.js';
import { frame, solid } from './kit.js';

// 来源快照中的收费棚与现有承载道路。逐棚绑定，收费站办公楼和隔声罩不参与替换。
const TOLL_ROADS = new Map([
  [482234119, [1212748040, 1212748041, 1212748042, 1212748043]],
  [246141483, [478737781]], [246141488, [478220562]],
  [482249528, [40932653]], [482249530, [40933471]],
  [482249531, [25588751]], [482249533, [160220799]],
  [589579569, [712599066]], [589579570, [712599068]],
  [589579571, [264599758]], [589579573, [25421068]],
  [589579574, [1228037660]], [1081081978, [25481858]]
].map(([id, roads]) => [`way/${id}`, roads.map(road => `way/${road}`)]));
const CLEARANCE_M = 5.6;
const ROOF_M = 0.85;

function roadTracks(graph, decks, roadHeight, sources) {
  const tracks = new Map();
  const add = (id, track) => {
    if (!tracks.has(id)) tracks.set(id, []);
    tracks.get(id).push(track);
  };
  graph.metadata.forEach((road, i) => {
    if (!sources.has(road.osmId) || !isGroundRoad(road)) return;
    add(road.osmId, { points: roadSectionPoints(graph, graph.links[i], road),
      halfWidth: getRoadSection(graph, i).pavementWidthM / 2, heightAt: roadHeight });
  });
  for (const deck of decks) {
    if (!sources.has(deck.osmId) || !deck.topTriangles?.length) continue;
    const heightAt = createSurfaceHeightAt([{ id: deck.surfaceId, triangles: deck.topTriangles }]);
    add(deck.osmId, { points: deck.frames, halfWidth: deck.width / 2, barriers: deck.barrierColliders,
      heightAt: (x, z) => heightAt(x, z, deck.surfaceId), elevated: true });
  }
  return tracks;
}

function coverage(polygon, tracks) {
  let highest = -Infinity;
  let axis = null;
  const elevated = [];
  for (const track of tracks) {
    if (track.elevated) elevated.push(track);
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1], b = track.points[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;
      const inside = polygonSegmentFraction(polygon, a.x, a.z, dx, dz, 0, 1) * length;
      if (inside > 1 && (!axis || inside > axis.inside)) axis = { dx, dz, inside };
      const alongSteps = Math.ceil(length / 2);
      const acrossSteps = Math.max(1, Math.ceil(track.halfWidth / 2));
      for (let j = 0; j <= alongSteps; j++) {
        const x = a.x + dx * j / alongSteps, z = a.z + dz * j / alongSteps;
        for (let k = -acrossSteps; k <= acrossSteps; k++) {
          const offset = track.halfWidth * k / acrossSteps;
          const sx = x - dz / length * offset, sz = z + dx / length * offset;
          if (!polygonContainsInclusive(polygon, sx, sz)) continue;
          const y = track.heightAt(sx, sz);
          if (Number.isFinite(y)) highest = Math.max(highest, y);
        }
      }
    }
  }
  return axis && Number.isFinite(highest) ? { ...axis, highest, elevated } : null;
}

function addDeckColumns(view, source, polygon, section, roofY) {
  const added = [];
  for (const track of section.elevated) {
    for (const barrier of track.barriers ?? []) {
      const [a, b, c, d] = barrier.polygon.outer;
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.6) continue;
      const p = { x: (a.x + b.x + c.x + d.x) / 4, z: (a.z + b.z + c.z + d.z) / 4 };
      if (added.some(q => Math.hypot(p.x - q.x, p.z - q.z) < 6)) continue;
      const f = frame(p.x, p.z, b.x - a.x, b.z - a.z);
      const ring = orientedBoxRing(p.x, p.z, 0.48, 0.23, f.c, f.s);
      if (!ring.every(q => polygonContainsInclusive(polygon, q.x, q.z)
        && polygonContainsInclusive(barrier.polygon, q.x, q.z))) continue;
      const y = track.heightAt(p.x, p.z);
      if (!Number.isFinite(y) || section.elevated.some(other => {
        const otherY = other === track ? null : other.heightAt(p.x, p.z);
        return otherY !== null && otherY > y - 4.5 && otherY < roofY;
      })) continue;
      view.box(p, y, roofY, 0.48, 0.23, f, 'white', source, `toll:${source.id}:deck-column:${added.length}`);
      added.push(p);
    }
  }
}

function addCanopy(view, source, polygon, section, site, carriagewayOccupied, nearby) {
  const f = frame(source.cx, source.cz, section.dz, -section.dx);
  const uv = polygon.outer.map(p => [
    (p.x - source.cx) * f.c + (p.z - source.cz) * f.s,
    (p.z - source.cz) * f.c - (p.x - source.cx) * f.s
  ]);
  const left = Math.min(...uv.map(p => p[0])), right = Math.max(...uv.map(p => p[0]));
  const front = Math.min(...uv.map(p => p[1])), back = Math.max(...uv.map(p => p[1]));
  const roofY = Math.fround(section.highest + CLEARANCE_M);
  const id = `toll:${source.id}`;
  const roof = solid(`${id}:roof`, source, polygon, roofY, roofY + ROOF_M, 'silver', 'source-roof-outline');
  const fascia = solid(`${id}:fascia`, source, polygon, roof.maxY, roof.maxY + 0.34, 'blue', 'source-roof-outline');
  view.part({ ...roof, topFace: false });
  view.part({ ...fascia, bottomFace: false });

  const fits = (p, width, depth) => {
    const radius = Math.hypot(width, depth) / 2 + 0.25;
    return orientedBoxRing(p.x, p.z, width, depth, f.c, f.s).every(q => polygonContainsInclusive(polygon, q.x, q.z))
      && !carriagewayOccupied(p.x, p.z, radius)
      && ![p, ...orientedBoxRing(p.x, p.z, 2 * radius, 2 * radius, f.c, f.s)].some(q =>
        section.elevated.some(track => Number.isFinite(track.heightAt(q.x, q.z))))
      && !nearby.some(row => polygonBoxOverlaps(row, p.x, p.z, radius, radius));
  };
  // 柱和收费亭沿横向搜寻完整落在棚内的空位，避开所有地面车道及此棚所跨桥面。
  for (const side of [-1, 1]) {
    const edge = side < 0 ? left : right;
    const span = (right - left) * 0.4;
    for (const depth of [0.26, 0.74]) {
      const v = front + (back - front) * depth;
      for (let inset = 0.8; inset <= span; inset += 0.75) {
        const p = f.at(edge - side * inset, v);
        const y = site.groundHeight(p.x, p.z);
        if (!Number.isFinite(y) || y > roofY - 2.8 || !fits(p, 0.68, 0.68)) continue;
        view.box(p, y, roofY, 0.68, 0.68, f, 'white', source, `${id}:column:${side}:${depth}`);
        break;
      }
    }
    if (section.elevated.length) continue;
    // 收费亭靠现有车道边布置，和前后两排支撑柱错开。
    const mid = (front + back) / 2;
    for (let offset = 2.5; offset < (right - left) * 0.45; offset += 0.5) {
      const p = f.at(side * offset, mid);
      const y = site.groundHeight(p.x, p.z);
      if (!Number.isFinite(y) || y > roofY - 2.6 || !fits(p, 1.65, 2.65)) continue;
      view.box(p, y, y + 2.45, 1.65, 2.65, f, 'ivory', source, `${id}:booth:${side}`);
      view.piece(p, y + 2.31, 1.69, 0.24, 2.69, f, 'blue');
      for (const face of [-1, 1]) {
        const end = { x: p.x - f.s * 1.33 * face, z: p.z + f.c * 1.33 * face };
        const service = { x: p.x + f.c * 0.83 * face, z: p.z + f.s * 0.83 * face };
        view.piece(end, y + 1.61, 1.38, 0.89, 0.045, f, 'glass');
        const sideFrame = frame(service.x, service.z, -f.s, f.c);
        view.piece(service, y + 1.61, 2.1, 0.89, 0.045, sideFrame, 'glass');
      }
      break;
    }
  }
  addDeckColumns(view, source, polygon, section, roofY);
  // 牌面挂在两条横向棚边，随实际源墙转角摆放，避免悬在弧形棚外。
  for (const side of [-1, 1]) {
    const edges = polygon.outer.map((a, i) => {
      const b = polygon.outer[(i + 1) % polygon.outer.length];
      const sign = frame((a.x + b.x) / 2, (a.z + b.z) / 2, b.x - a.x, b.z - a.z);
      const width = Math.hypot(b.x - a.x, b.z - a.z);
      return { sign, width, score: side * (sign.c * f.c + sign.s * f.s) * width };
    }).sort((a, b) => b.score - a.score);
    const { sign, width, score } = edges[0];
    if (score <= 4) continue;
    const probe = sign.at(0, 0.05);
    const outside = polygonContainsInclusive(polygon, probe.x, probe.z) ? -1 : 1;
    const p = sign.at(0, outside * 0.055);
    const facing = outside > 0 ? sign : frame(p.x, p.z, -sign.c, -sign.s);
    view.label(p, roofY + 0.63, Math.min(9.5, width * 0.8), 0.9, facing,
      source.name || STR.tollStation, '#fffdf2', '#245875');
  }
}

export function buildTollCanopies(kit, site, byId, carriagewayOccupied, decks = []) {
  const skipIds = new Set(), colliders = [];
  if (!site.roadGraph || !site.roadHeight) return { skipIds, colliders };
  const tracks = roadTracks(site.roadGraph, decks, site.roadHeight, new Set([...TOLL_ROADS.values()].flat()));
  for (const [id, roads] of TOLL_ROADS) {
    const source = byId.get(id);
    if (!source || source.polygons.length !== 1 || !roads.every(road => tracks.has(road))) continue;
    const polygon = source.polygons[0];
    const section = coverage(polygon, roads.flatMap(road => tracks.get(road)));
    if (!section) continue;
    const nearby = site.buildings.filter(b => b.id !== id && b.minX <= source.maxX && b.maxX >= source.minX
      && b.minZ <= source.maxZ && b.maxZ >= source.minZ).flatMap(b => b.polygons);
    const view = kit.district(`ShenzhenToll:${id}`, { x: source.cx, y: section.highest, z: source.cz });
    addCanopy(view, source, polygon, section, site, carriagewayOccupied, nearby);
    view.finish();
    colliders.push(...view.colliders);
    skipIds.add(id);
  }
  return { skipIds, colliders };
}
