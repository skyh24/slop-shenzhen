import * as THREE from 'three/webgpu';
import { color, fract, fwidth, max, min, positionWorld, smoothstep } from 'three/tsl';
import { polygonBoxOverlaps } from './building-collision.js';
import { buildingSeed } from './sz-building-layout.js';
import { buildSzRoads } from './sz-roads.js';

const PATH_STYLE = {
  footway: { color: 0x989087, jointM: 0.58, depthBias: -2 },
  cycleway: { color: 0x686b65, jointM: 0.46, depthBias: -1 }
};
const TRUNK_SIDES = 10;
const LOBES = [
  [-1.05, 3.5, 0.13, 1.45, 1.14, 1.33], [0.94, 3.67, -0.53, 1.38, 1.22, 1.27],
  [-0.10, 3.78, 0.97, 1.35, 1.22, 1.28], [-0.13, 3.85, -0.82, 1.32, 1.27, 1.25],
  [0.18, 4.48, 0.03, 1.36, 1.42, 1.44]
];

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
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, polygonOffset: true,
    polygonOffsetFactor: style.depthBias, polygonOffsetUnits: style.depthBias });
  // 宽度与拼缝只作外观近似。铺装与可走地面完全共面。
  const grid = positionWorld.xz.div(style.jointM);
  const tile = fract(grid);
  const pixel = max(fwidth(grid.x), fwidth(grid.y));
  const joint = min(min(tile.x, tile.x.oneMinus()), min(tile.y, tile.y.oneMinus()));
  const grout = smoothstep(0.01, max(0.03, pixel), joint).oneMinus().mul(smoothstep(0.1, 0.5, pixel).oneMinus());
  material.colorNode = color(style.color).mul(grout.mul(-0.18).add(1));
  const layer = buildSzRoads(group, pathGraph(paths), terrain, { material });
  layer.group.name = `shenzhen-pilot-${kind}`;
  return { ...layer, material };
}

function nearbyBuilding(colliders, x, y, z, reach, height) {
  return colliders.some(c => c.minY < y + height && c.maxY > y && c.minX < x + reach && c.maxX > x - reach
    && c.minZ < z + reach && c.maxZ > z - reach && (!c.polygon || polygonBoxOverlaps(c.polygon, x, z, reach, reach)));
}

function pose(mesh, index, x, y, z, sx, sy, sz, colorValue = null) {
  mesh.setMatrixAt(index, new THREE.Matrix4().makeScale(sx, sy, sz).setPosition(x, y, z));
  if (colorValue) mesh.setColorAt(index, colorValue);
}

function treeMeshes(group, sites, trunkGeometry, ring, colliders) {
  const trunkMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x645343, roughness: 0.96 });
  const leafMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.87 });
  const nearGeometry = new THREE.IcosahedronGeometry(1, 2);
  const farGeometry = new THREE.IcosahedronGeometry(1, 1);
  const centers = [];
  for (const [areaId, trees] of sites) {
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
    const near = new THREE.InstancedMesh(nearGeometry, leafMaterial, trees.length * LOBES.length);
    const far = new THREE.InstancedMesh(farGeometry, leafMaterial, trees.length);
    trunks.name = `tree-trunks:${areaId}`;
    near.name = `tree-crowns-near:${areaId}`;
    far.name = `tree-crowns-far:${areaId}`;
    trunks.userData.sources = trees.map(tree => tree.osmId);
    trees.forEach(({ x, y, z, scale, osmId }, index) => {
      pose(trunks, index, x, y, z, scale, scale, scale);
      const matrix = new THREE.Matrix4();
      trunks.getMatrixAt(index, matrix);
      const outer = ring.map(([dx, dz]) => {
        const point = new THREE.Vector3(dx, 0, dz).applyMatrix4(matrix);
        return { x: point.x, z: point.z };
      });
      const low = new THREE.Vector3(0, trunkGeometry.boundingBox.min.y, 0).applyMatrix4(matrix).y;
      const high = new THREE.Vector3(0, trunkGeometry.boundingBox.max.y, 0).applyMatrix4(matrix).y;
      colliders.push({ type: 'tree', name: osmId, sourceId: osmId, polygon: { outer, holes: [] }, minY: low, maxY: high,
        minX: Math.min(...outer.map(point => point.x)), maxX: Math.max(...outer.map(point => point.x)),
        minZ: Math.min(...outer.map(point => point.z)), maxZ: Math.max(...outer.map(point => point.z)) });

      const tint = new THREE.Color(0x3c562f).lerp(new THREE.Color(0x607649), buildingSeed(`${osmId}:crown`));
      const angle = buildingSeed(`${osmId}:azimuth`) * Math.PI * 2;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      LOBES.forEach(([dx, dy, dz, sx, sy, sz], i) => {
        pose(near, index * LOBES.length + i, x + (cos * dx - sin * dz) * scale, y + dy * scale,
          z + (sin * dx + cos * dz) * scale, sx * scale, sy * scale, sz * scale, tint.clone().multiplyScalar(0.92 + i * 0.045));
      });
      pose(far, index, x, y + 4.06 * scale, z, 2.38 * scale, 1.77 * scale, 2.23 * scale, tint);
    });
    for (const mesh of [trunks, near, far]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    centers.push({ near, far, center: near.boundingSphere.center, full: true });
  }
  return {
    update(position) {
      for (const entry of centers) {
        const distance = position.distanceTo(entry.center);
        entry.full = distance < (entry.full ? 174 : 156);
        entry.near.visible = entry.full;
        entry.far.visible = !entry.full;
      }
    },
    dispose() {
      trunkGeometry.dispose();
      nearGeometry.dispose();
      farGeometry.dispose();
      trunkMaterial.dispose();
      leafMaterial.dispose();
    }
  };
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

export function buildSzStreetscape(scene, source, terrain, { groundHeight, roadHeight, colliders: buildings }) {
  if (!source) return { group: null, colliders: [], arrival: null, statistics: null, update() {}, pathAt: () => [] };
  const group = new THREE.Group();
  group.name = 'shenzhen-pilot-streetscape';
  const layers = Object.fromEntries(Object.keys(PATH_STYLE).map(kind => {
    const paths = source.paths.filter(path => path.kind === kind);
    return [kind, paths.length ? buildPaving(group, kind, paths, terrain) : null];
  }));
  const pathAt = (x, z) => Object.keys(layers).filter(kind => layers[kind]?.roadHeight(x, z) != null);
  const trunkGeometry = new THREE.CylinderGeometry(0.19, 0.19, 3.4, TRUNK_SIDES).translate(0, 1.7, 0);
  trunkGeometry.computeBoundingBox();
  const vertices = trunkGeometry.attributes.position;
  const ring = Array.from({ length: TRUNK_SIDES }, (_, i) => [vertices.getX(i), vertices.getZ(i)]);
  const sites = new Map();
  const excludedTrees = [];
  for (const tree of source.trees) {
    const { x, z } = tree;
    const scale = 0.84 + buildingSeed(tree.osmId) * 0.36;
    const probes = [[0, 0], ...ring].map(([dx, dz]) => [x + dx * scale * 1.25, z + dz * scale * 1.25]);
    const heights = probes.map(([px, pz]) => groundHeight(px, pz));
    let reason = null;
    if (!heights.every(Number.isFinite)) reason = 'unsupported-ground';
    else if (probes.some(([px, pz]) => roadHeight(px, pz) !== null || pathAt(px, pz).length)) reason = 'paving-conflict';
    else if (nearbyBuilding(buildings, x, Math.min(...heights), z, 2.6 * scale, 6 * scale)) reason = 'building-conflict';
    if (reason) {
      excludedTrees.push({ osmId: tree.osmId, reason });
      continue;
    }
    if (!sites.has(tree.areaOsmId)) sites.set(tree.areaOsmId, []);
    sites.get(tree.areaOsmId).push({ ...tree, y: Math.min(...heights), scale });
  }
  const colliders = [];
  const trees = treeMeshes(group, sites, trunkGeometry, ring, colliders);
  const arrival = findPathArrival(source.paths, source.arrivalWayId, layers.footway, [...buildings, ...colliders]);
  const statistics = { paths: source.paths.map(path => ({ osmId: path.osmId, kind: path.kind, widthSource: path.widthSource })),
    paving: Object.fromEntries(Object.entries(layers).map(([kind, layer]) => [kind, layer?.statistics ?? null])),
    trees: colliders.length, excludedTrees, appearanceSource: 'visual-estimate' };
  scene.add(group);
  return { group, colliders, arrival, statistics, pathAt, update: trees.update,
    dispose() {
      group.removeFromParent();
      for (const layer of Object.values(layers)) {
        layer?.dispose();
        layer?.material.dispose();
      }
      trees.dispose();
    }
  };
}
