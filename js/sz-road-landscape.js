import * as THREE from 'three/webgpu';
import { pavingMesh } from './sz-paving.js';
import { createRoadHeightSampler, createRoadPolygonLayout } from './sz-roads.js';
import { createBayPathLookup } from './sz-bay-waterfront.js';

const COLORS = { grass: 0x607d3e, flowers: 0xad535a, path: 0xa39983 };

export function buildRoadLandscape(scene, landscape, terrainSurface, groundHeight) {
  const group = new THREE.Group();
  group.name = 'shenzhen-road-landscape';
  const path = landscape?.publicPath;
  const walkAt = createBayPathLookup(path ? [path] : []);
  const routes = [];
  let pathHeight = () => null;
  const materials = new Map();
  for (const patch of landscape?.patches ?? []) {
    const layout = createRoadPolygonLayout(patch, terrainSurface);
    if (!materials.has(patch.color)) {
      materials.set(patch.color, new THREE.MeshStandardNodeMaterial({ color: COLORS[patch.color], roughness: 0.96,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    }
    for (const chunk of layout.chunks) {
      for (let i = 1; i < chunk.positions.length; i += 3) chunk.positions[i] += patch.offsetM;
      const mesh = pavingMesh(chunk.positions, chunk.origin, materials.get(patch.color), chunk.id);
      mesh.userData.sourceIds = patch.sourceIds;
      group.add(mesh);
    }
    if (patch.id === path?.id) pathHeight = createRoadHeightSampler(layout.chunks, terrainSurface.grid);
  }
  if (path) {
    const points = path.points.map(([x, z]) => ({ x, z, y: pathHeight(x, z) ?? groundHeight(x, z) }));
    if (points.every(point => Number.isFinite(point.y))) routes.push({ points, id: path.id, walkAt: pathHeight, reserve: (x, z, radius) => walkAt(x, z, radius).length > 0 });
  }
  scene.add(group);
  return { group, routes, trees: landscape?.trees ?? [], walkAt, pathHeight,
    dispose() {
      group.removeFromParent();
      group.traverse(node => node.geometry?.dispose());
      for (const material of materials.values()) material.dispose();
    } };
}
