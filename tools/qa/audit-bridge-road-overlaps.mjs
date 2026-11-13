// 离线审计：桥板/护栏与地面道路的空间交叠，输出候选清单，不修改场景或数据。
// 用法：node tools/qa/audit-bridge-road-overlaps.mjs [city.json.gz] [out.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeCityPayload } from '../../js/sz-data-format.js';

// 3.6 m 是沙河白石立交公开限高；低于它才是明确的机动车净空不足候选。
const ROAD_CLEARANCE_M = 3.6;
const FLUSH_TOP_M = 0.05;
const CONTACT_EPSILON_M = 1e-3;

const three = process.env.SZ_THREE_PACKAGE_DIR
  ? pathToFileURL(resolve(process.env.SZ_THREE_PACKAGE_DIR) + '/')
  : new URL('../../.agents/three-0.187.0/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', three)));
if (pkg.version !== '0.187.0') throw new Error('Bridge audit requires Three.js 0.187.0');
const aliases = { three: 'build/three.webgpu.js', 'three/webgpu': 'build/three.webgpu.js',
  'three/tsl': 'build/three.tsl.js' };
const hook = registerHooks({ resolve(specifier, context, next) {
  const file = aliases[specifier] ?? (specifier.startsWith('three/addons/') ? `examples/jsm/${specifier.slice(13)}` : null);
  return next(file ? new URL(file, three).href : specifier, context);
} });
try {
  const { Group } = await import('three/webgpu');
  const { planElevatedRoads } = await import('../../js/sz-elevated-roads.js');
  const { buildSzRoadStructures, graphWithRoadStructures } = await import('../../js/sz-road-structures.js');
  const { createGroundSurfaceSampler } = await import('../../js/sz-ground-surface.js');
  const { createCitySpatial } = await import('../../js/sz-spatial.js');
  const { isGroundRoad, roadLinkPoints } = await import('../../js/sz-roads.js');
  const { northBridgeProfile } = await import('../../js/sz-rail/geometry.js');
  const { polygonContains } = await import('../../js/sz-polygon.js');
  const { polygonContact, roofPanelContactPolygon, spanContactPolygon } = await import('../../js/building-collision.js');
  const packed = readFileSync(process.argv[2] ?? new URL('../../js/sz-city.json.gz', import.meta.url));
  const { geo } = decodeCityPayload(JSON.parse(gunzipSync(packed)));
  const graph = graphWithRoadStructures(geo.roadGraph, geo.roadStructures);
  const exclude = new Set(geo.roadStructures?.records.map(row => row.index));
  const elevated = planElevatedRoads(graph, geo.terrainSurface, { exclude, waterfront: geo.waterfront,
    extraCrossing: northBridgeProfile(geo.shenzhenNorthRail), water: geo.water, isWater: createCitySpatial(geo).isWater });
  const structures = buildSzRoadStructures(new Group(), graph, geo.roadStructures);
  const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);

  const deckTop = (collider, x, z) => {
    if (collider.verticalSpan) {
      // 与 spanContactPolygon 相同的四边形参数化：外环 a→b 为 0→1。
      const [a, b, c, d] = collider.polygon.outer;
      const across = (p, q) => {
        const dx = q.x - p.x, dz = q.z - p.z;
        const length2 = dx * dx + dz * dz;
        return length2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / length2)) : 0;
      };
      const t = (across(a, b) + across(d, c)) / 2;
      return collider.verticalSpan[2] + (collider.verticalSpan[3] - collider.verticalSpan[2]) * t;
    }
    if (collider.roofPanel) {
      const { outer, top } = collider.roofPanel;
      const height = (p, q, r) => {
        const det = (q.z - r.z) * (p.x - r.x) + (r.x - q.x) * (p.z - r.z);
        if (Math.abs(det) < 1e-10) return null;
        const u = ((q.z - r.z) * (x - r.x) + (r.x - q.x) * (z - r.z)) / det;
        const v = ((r.z - p.z) * (x - r.x) + (p.x - r.x) * (z - r.z)) / det;
        const w = 1 - u - v;
        return Math.min(u, v, w) < -1e-7 ? null : p.y + (q.y - p.y) * v + (r.y - p.y) * w;
      };
      const p = outer.map((point, i) => ({ ...point, y: top[i] }));
      return height(p[0], p[1], p[2]) ?? height(p[0], p[2], p[3]);
    }
    return collider.maxY;
  };
  const deckBottom = (collider, x, z) => {
    if (collider.verticalSpan) {
      const [a, b, c, d] = collider.polygon.outer;
      const across = (p, q) => {
        const dx = q.x - p.x, dz = q.z - p.z;
        const length2 = dx * dx + dz * dz;
        return length2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / length2)) : 0;
      };
      const t = (across(a, b) + across(d, c)) / 2;
      return collider.verticalSpan[0] + (collider.verticalSpan[1] - collider.verticalSpan[0]) * t;
    }
    if (collider.roofPanel) {
      const { outer, bottom } = collider.roofPanel;
      const height = (p, q, r) => {
        const det = (q.z - r.z) * (p.x - r.x) + (r.x - q.x) * (p.z - r.z);
        if (Math.abs(det) < 1e-10) return null;
        const u = ((q.z - r.z) * (x - r.x) + (r.x - q.x) * (z - r.z)) / det;
        const v = ((r.z - p.z) * (x - r.x) + (p.x - r.x) * (z - r.z)) / det;
        const w = 1 - u - v;
        return Math.min(u, v, w) < -1e-7 ? null : p.y + (q.y - p.y) * v + (r.y - p.y) * w;
      };
      const p = outer.map((point, i) => ({ ...point, y: bottom[i] }));
      return height(p[0], p[1], p[2]) ?? height(p[0], p[2], p[3]) ?? collider.minY;
    }
    return collider.minY;
  };

  const body = { car: true, hx: 0.86, hz: 2.18, cos: 1, sin: 0, bottom: 0, top: 1.8,
    extX: 0.86, extZ: 2.18, mode: 'car' };
  const phantomContact = (collider, x, y, z) => {
    body.supportedSlabs = new Set(['terrain']);
    if (y + body.bottom >= collider.maxY - CONTACT_EPSILON_M) return false;
    if (y + body.top <= collider.minY + CONTACT_EPSILON_M) return false;
    let polygon = collider.polygon;
    if (collider.roofPanel) polygon = roofPanelContactPolygon(collider.roofPanel, y, y + body.top);
    else if (collider.verticalSpan) polygon = spanContactPolygon(polygon, collider.verticalSpan, y, y + body.top);
    return polygon !== null && polygonContact(polygon, x, z, body);
  };

  const slabs = [...elevated.colliders, ...structures.colliders]
    .filter(c => c.type === 'elevated-slab' || c.type === 'bridge-slab');
  const barriers = [...elevated.colliders, ...structures.colliders]
    .filter(c => c.type === 'elevated-barrier' || c.type === 'bridge-barrier');
  // 以 48 m 网格索引桥板，避免每个地面采样点扫描全城碰撞体。
  const CELL = 48;
  const cellKey = (ix, iz) => `${ix},${iz}`;
  const addToGrid = (collider, list) => {
    for (let ix = Math.floor(collider.minX / CELL); ix <= Math.floor(collider.maxX / CELL); ix++) {
      for (let iz = Math.floor(collider.minZ / CELL); iz <= Math.floor(collider.maxZ / CELL); iz++) {
        const key = cellKey(ix, iz);
        if (!list.has(key)) list.set(key, []);
        list.get(key).push(collider);
      }
    }
  };
  const slabGrid = new Map();
  for (const collider of slabs) addToGrid(collider, slabGrid);
  const barrierGrid = new Map();
  for (const collider of barriers) if (collider.polygon) addToGrid(collider, barrierGrid);
  const nearby = (list, x, z) => list.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
  const bySource = new Map();
  const add = (key, row) => {
    const entry = bySource.get(key) ?? { type: row.type, name: row.name, sourceId: row.sourceId,
      road: row.road, samples: 0, worstClearance: Infinity, worstTop: -Infinity,
      phantomPoints: 0, point: null };
    entry.samples++;
    entry.worstClearance = Math.min(entry.worstClearance, row.clearance);
    entry.worstTop = Math.max(entry.worstTop, row.topClearance);
    if (row.phantom) entry.phantomPoints++;
    if (!entry.point) entry.point = { x: row.x, z: row.z };
    bySource.set(key, entry);
  };

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || !isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, graph.links[index]);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d <= length; d += 1) {
        const t = length > 0 ? d / length : 0;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const g = groundHeight(x, z);
        if (!Number.isFinite(g)) continue;
        for (const collider of nearby(slabGrid, x, z)) {
          if (!polygonContains(collider.polygon, x, z)) continue;
          const top = deckTop(collider, x, z);
          if (!Number.isFinite(top)) continue;
          const bottom = deckBottom(collider, x, z);
          add(`${collider.type}|${collider.name}|${collider.sourceId ?? ''}|road:${metadata.osmId}`, {
            type: collider.type, name: collider.name, sourceId: collider.sourceId ?? null,
            road: metadata.osmId, x, z, ground: g, top, bottom,
            clearance: bottom - g, topClearance: top - g,
            phantom: phantomContact(collider, x, g, z)
          });
        }
      }
    }
  }

  // 护栏：只报离地低且与地面道路中心线水平净距小于一个车身半宽的候选，避免把高架护栏算成封路。
  const barrierHits = new Map();
  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!metadata || !isGroundRoad(metadata)) continue;
    const points = roadLinkPoints(graph, graph.links[index]);
    for (const p of points) {
      const g = groundHeight(p.x, p.z);
      if (!Number.isFinite(g)) continue;
      for (const barrier of nearby(barrierGrid, p.x, p.z)) {
        if (barrier.maxY - g > 1.5 || barrier.minY - g > 0.5) continue;
        if (!polygonContains(barrier.polygon, p.x, p.z)) continue;
        const key = `${barrier.type}|${barrier.name}|${barrier.sourceId ?? ''}|road:${metadata.osmId}`;
        const entry = barrierHits.get(key) ?? { type: barrier.type, name: barrier.name,
          sourceId: barrier.sourceId ?? null, road: metadata.osmId, ground: g,
          barrierBottom: barrier.minY, barrierTop: barrier.maxY, samples: 0, point: { x: p.x, z: p.z } };
        entry.samples++;
        barrierHits.set(key, entry);
      }
    }
  }

  const groups = [];
  for (const row of bySource.values()) {
    let kind = 'clearance-ok';
    if (row.phantomPoints > 0 && row.worstTop <= FLUSH_TOP_M) kind = 'phantom-side-contact';
    else if (row.worstClearance < 0 && row.worstTop <= FLUSH_TOP_M) kind = 'at-grade-or-embedded-deck';
    else if (row.worstClearance < 0 && row.worstTop <= 0.28) kind = 'portal-lip';
    else if (row.worstClearance < ROAD_CLEARANCE_M) kind = 'insufficient-clearance';
    const existing = groups.find(group => group.type === row.type && group.name === row.name
      && group.road === row.road);
    const entry = existing ?? { type: row.type, name: row.name, sourceId: row.sourceId,
      road: row.road, samples: 0, phantomPoints: 0, worstClearance: Infinity,
      worstTop: -Infinity, point: row.point, kind: 'clearance-ok' };
    entry.samples += row.samples;
    entry.phantomPoints += row.phantomPoints;
    entry.worstClearance = Math.min(entry.worstClearance, row.worstClearance);
    entry.worstTop = Math.max(entry.worstTop, row.worstTop);
    if (kind !== 'clearance-ok') entry.kind = kind;
    if (!existing) groups.push(entry);
  }
  groups.sort((a, b) => a.kind.localeCompare(b.kind) || a.worstClearance - b.worstClearance);
  const summary = {};
  for (const group of groups) summary[group.kind] = (summary[group.kind] ?? 0) + 1;
  const output = {
    packageSha256: createHash('sha256').update(packed).digest('hex'),
    thresholds: { roadClearanceM: ROAD_CLEARANCE_M, flushTopM: FLUSH_TOP_M, contactEpsilonM: CONTACT_EPSILON_M },
    counts: { slabGroups: groups.length, barrierGroups: barrierHits.size, ...summary },
    groups,
    barriers: [...barrierHits.values()]
  };
  const out = process.argv[3] ? resolve(process.argv[3]) : null;
  if (out) writeFileSync(out, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ counts: output.counts, worst: groups.slice(0, 20) }, null, 2));
} finally {
  hook.deregister();
}
