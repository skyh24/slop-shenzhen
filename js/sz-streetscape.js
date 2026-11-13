import * as THREE from 'three/webgpu';
import { createPavingMaterial } from './sz-paving.js';
import { polygonBoxOverlaps } from './building-collision.js';
import { buildSzRoads } from './sz-roads.js';
import { buildSzGolfCourse } from './sz-golf-course.js';

const PATH_STYLE = {
  footway: { color: 0x989087, tileSizeM: 0.58, depthBias: -2 },
  cycleway: { color: 0x686b65, tileSizeM: 0.46, depthBias: -1 }
};

function pathGraph(paths) {
  const graph = { nodes: [], links: [], metadata: [], names: [''] };
  const nodeIndices = new Map();
  function node(id, point) {
    const key = id ?? `clip:${point.join(',')}`;
    if (!nodeIndices.has(key)) {
      nodeIndices.set(key, graph.nodes.length / 2);
      graph.nodes.push(...point);
    }
    return nodeIndices.get(key);
  }
  for (const path of paths) {
    for (const { points, nodeIds } of path.segments) {
      const a = node(nodeIds[0], points[0]);
      const b = node(nodeIds.at(-1), points.at(-1));
      if (a === b) continue;
      graph.links.push([a, b, 0, path.widthM, 0, 0, points.slice(1, -1).flat()]);
      graph.metadata.push({ ...path.tags, osmId: path.osmId, highway: path.kind, bridge: false, tunnel: false, layer: 0,
        widthSource: path.widthSource, heightSource: path.heightSource });
    }
  }
  return graph;
}

function buildPaving(group, kind, paths, terrain) {
  const style = PATH_STYLE[kind];
  // 宽度与拼缝只作外观估计。铺装与可走地面完全共面。
  const material = createPavingMaterial('concrete', {
    roughness: 0.94, groutStrength: 0.18, groutFade: [0.1, 0.5], groutWidth: [0.01, 0.03], ...style
  });
  const layer = buildSzRoads(group, pathGraph(paths), terrain, { material, batch: false });
  layer.group.name = `shenzhen-pilot-${kind}`;
  return { ...layer, material };
}

function nearbyBuilding(colliders, x, y, z, reach, height) {
  return colliders.some(c => c.minY < y + height && c.maxY > y && c.minX < x + reach && c.maxX > x - reach
    && c.minZ < z + reach && c.maxZ > z - reach && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, reach, reach)));
}

function findPathArrival(paths, sourceId, layer, obstacles) {
  const path = paths.find(path => path.osmId === sourceId && path.kind === 'footway' && path.tags.foot !== 'no');
  if (!path || !layer) return null;
  for (const { points } of path.segments) {
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1], [bx, bz] = points[i];
      const dx = bx - ax, dz = bz - az;
      if (Math.hypot(dx, dz) < 12) continue;
      const x = ax + dx * 0.25, z = az + dz * 0.25;
      const y = layer.roadHeight(x, z);
      if (y !== null && !nearbyBuilding(obstacles, x, y, z, 0.6, 2.2)) {
        return { x, z, heading: Math.atan2(dx, dz), sourcePathId: path.osmId };
      }
    }
  }
  return null;
}

export function buildSzStreetscape(scene, source, terrain, { colliders: buildings, golfCourse }) {
  if (!source) {
    const golf = buildSzGolfCourse(scene, golfCourse, terrain);
    return { group: golf?.group ?? null, observedTrees: [], findArrival: () => null, statistics: null,
      pathAt: (x, z) => golf?.pathAt(x, z) ? ['garden-path'] : [], dispose: () => golf?.dispose() };
  }
  const group = new THREE.Group();
  group.name = 'shenzhen-pilot-streetscape';
  const layers = Object.fromEntries(Object.keys(PATH_STYLE).map(kind => {
    const paths = source.paths.filter(path => path.kind === kind);
    return [kind, paths.length ? buildPaving(group, kind, paths, terrain) : null];
  }));
  const golf = buildSzGolfCourse(group, golfCourse, terrain);
  const pathAt = (x, z) => golf?.pathAt(x, z) ? ['garden-path']
    : Object.keys(layers).filter(kind => layers[kind]?.roadHeight(x, z) != null);
  const observedTrees = source.trees.map(({ osmId, x, z, positionSource, appearanceSource }) =>
    ({ id: osmId, x, z, positionSource, appearanceSource }));
  const observedIds = new Set(observedTrees.map(tree => tree.id));
  const findArrival = (treeColliders = []) => findPathArrival(source.paths, source.arrivalWayId, layers.footway,
    [...buildings, ...treeColliders.filter(tree => observedIds.has(tree.sourceId))]);
  const statistics = { paths: source.paths.map(path => ({ osmId: path.osmId, kind: path.kind, widthSource: path.widthSource })),
    paving: Object.fromEntries(Object.entries(layers).map(([kind, layer]) => [kind, layer?.statistics ?? null])),
    observedTrees: observedTrees.length };
  scene.add(group);
  return { group, observedTrees, findArrival, statistics, pathAt,
    dispose() {
      golf?.dispose();
      group.removeFromParent();
      for (const layer of Object.values(layers)) {
        layer?.dispose();
        layer?.material.dispose();
      }
    }
  };
}
