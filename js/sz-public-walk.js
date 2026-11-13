import * as THREE from 'three/webgpu';
import { createRoadHeightSampler, createRoadPolygonLayout } from './sz-roads.js';
import { createPavingMaterial, pavingMesh } from './sz-paving.js';
import { distanceToRing, polygonContainsInclusive } from './sz-polygon.js';
import { polygonBoxOverlaps } from './building-collision.js';

const SWEEP_STEP_M = 0.2;
const PERSON_HEIGHT_M = 1.9;
const MAX_GRADE = 0.35;
const PAVING = { sidewalk: 0x9a978e, green: 0x6f875a,
  'tree-pit': 0x6a5744, driveway: 0x85847d };

function boundsOf(points) {
  return points.reduce((b, { x, z }) => ({ minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x),
    minZ: Math.min(b.minZ, z), maxZ: Math.max(b.maxZ, z) }),
  { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function inBounds(bounds, x, z, pad = 0) {
  return x >= bounds.minX - pad && x <= bounds.maxX + pad && z >= bounds.minZ - pad && z <= bounds.maxZ + pad;
}

function edgeKey(a, b) {
  return [`${a.x},${a.z}`, `${b.x},${b.z}`].sort().join(':');
}

export function buildPublicWalk(scene, terrain, areas, style) {
  const group = new THREE.Group();
  group.name = 'shenzhen-public-walk';
  const materials = new Map();
  const surfaces = areas.map(area => {
    const { polygon, kind, id, sourceIds } = area;
    const rings = [polygon.outer, ...polygon.holes];
    const bounds = boundsOf(polygon.outer);
    if (kind !== 'frontage' && !Object.hasOwn(PAVING, kind)) return { ...area, bounds, heightAt: () => null };
    const [outer, ...holes] = rings.map(ring => ring.map(p => new THREE.Vector2(p.x, p.z)));
    const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    const vertices = outer.concat(...holes);
    const trianglesXZ = faces.flatMap(face => face.flatMap(i => [vertices[i].x, vertices[i].y]));
    const { chunks } = createRoadPolygonLayout({ id, trianglesXZ, sourceIds }, terrain);
    const fallback = kind === 'frontage' ? 'warm-stone' : 'concrete';
    const x = (bounds.minX + bounds.maxX) / 2, z = (bounds.minZ + bounds.maxZ) / 2;
    const preset = kind === 'frontage'
      ? (style?.resolve({ surfaceStyle: fallback }, { x, z, regionId: area.regionId })?.surfaceStyle ?? fallback)
      : fallback;
    const key = `${kind}:${preset}`;
    if (!materials.has(key)) materials.set(key, kind === 'frontage' ? createPavingMaterial(preset)
      : createPavingMaterial(preset, { color: PAVING[kind], tileSizeM: null, roughness: 0.94 }));
    for (const chunk of chunks) group.add(pavingMesh(chunk.positions, chunk.origin, materials.get(key), id));
    return { ...area, bounds, heightAt: createRoadHeightSampler(chunks, terrain.grid) };
  });
  scene.add(group);

  const publicSurfaces = surfaces.filter(area => area.access === 'public' && area.network);
  const boundaryByNetwork = new Map();
  for (const area of publicSurfaces) {
    let edges = boundaryByNetwork.get(area.network);
    if (!edges) boundaryByNetwork.set(area.network, edges = new Map());
    for (const ring of [area.polygon.outer, ...area.polygon.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], key = edgeKey(a, b);
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      }
    }
  }

  const areaAt = (x, z) => surfaces.find(area => inBounds(area.bounds, x, z)
    && polygonContainsInclusive(area.polygon, x, z)) ?? null;

  function heightAt(x, z) {
    return areaAt(x, z)?.heightAt(x, z) ?? null;
  }

  function allows(x, z, radius, network) {
    const area = areaAt(x, z);
    if (!network || area?.access !== 'public' || area.network !== network
      || !Number.isFinite(area.heightAt(x, z))) return false;
    for (const edge of boundaryByNetwork.get(network).values()) {
      if (distanceToRing(edge, x, z) < radius) return false;
    }
    return true;
  }

  let disposed = false;
  return { group, surfaces, areaAt, heightAt, allows, dispose() {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    const used = new Set(materials.values());
    for (const mesh of [...group.children]) {
      mesh.geometry.dispose();
      for (const material of [].concat(mesh.material)) used.add(material);
      mesh.removeFromParent();
    }
    for (const material of used) material.dispose();
  } };
}

// 每对样点之间也计入半个步长的包络。靠右偏移的整条扫掠由调用方计入 radius。
export function createWalkSweep(walk, network, colliders, barrier, bounds) {
  const obstacles = colliders.filter(item => item.polygon && item.maxX >= bounds.minX
    && item.minX <= bounds.maxX && item.maxZ >= bounds.minZ && item.minZ <= bounds.maxZ);
  return (a, b, radius) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const count = Math.max(1, Math.ceil(length / SWEEP_STEP_M));
    const step = length / count;
    const reach = radius + step / 2;
    let previousY = null;
    for (let i = 0; i <= count; i++) {
      const x = a.x + dx * i / count, z = a.z + dz * i / count;
      if (!walk.allows(x, z, reach, network) || barrier?.contains(x, z, reach)) return false;
      const y = walk.heightAt(x, z);
      if (previousY !== null && Math.abs(y - previousY) > step * MAX_GRADE + 0.025) return false;
      const bottom = y - step * MAX_GRADE, top = y + PERSON_HEIGHT_M + step * MAX_GRADE;
      if (obstacles.some(item => item.maxY > bottom && item.minY < top && inBounds(item, x, z, reach)
        && polygonBoxOverlaps(item.polygon, x, z, reach, reach))) return false;
      previousY = y;
    }
    return true;
  };
}

// 沿既有步行方向搜索少量横向候选；每条边都必须落在同一个公共步行网络内。
export function routeAroundObstacles(anchors, clear, radius) {
  if (anchors.slice(1).every((point, i) => clear(anchors[i], point, radius))) return anchors;
  const stations = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    const count = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.2);
    for (let j = 1; j <= count; j++) stations.push({ x: a.x + (b.x - a.x) * j / count,
      z: a.z + (b.z - a.z) * j / count });
  }
  let previous = [{ point: stations[0], cost: 0, parent: null }];
  for (let i = 1; i < stations.length; i++) {
    const p = stations[i], a = stations[i - 1], b = stations[i + 1] ?? p;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const offsets = i === stations.length - 1 ? [0]
      : [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1, 1.25, -1.25, 1.5, -1.5];
    const row = [];
    for (const offset of offsets) {
      const point = { x: p.x + (b.z - a.z) / length * offset, z: p.z - (b.x - a.x) / length * offset };
      let best = null;
      for (const candidate of previous) {
        const distance = Math.hypot(point.x - candidate.point.x, point.z - candidate.point.z);
        const cost = candidate.cost + distance + Math.abs(offset) * 0.12;
        if (distance > 2 || cost >= (best?.cost ?? Infinity) || !clear(candidate.point, point, radius)) continue;
        best = { point, cost, parent: candidate };
      }
      if (best) row.push(best);
    }
    if (!row.length) return null;
    previous = row;
  }
  const path = [];
  for (let node = previous[0]; node; node = node.parent) path.push(node.point);
  path.reverse();
  const result = [path[0]];
  for (let i = 0; i < path.length - 1;) {
    let next = Math.min(path.length - 1, i + 12);
    while (next > i + 1 && !clear(path[i], path[next], radius)) next--;
    result.push(path[next]);
    i = next;
  }
  return result;
}
