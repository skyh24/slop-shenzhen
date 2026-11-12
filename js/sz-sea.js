import * as THREE from 'three/webgpu';
import { GeoBuilder, addFlatPolygon } from './sz-geometry.js';
import { createSzWaterMaterial } from './sz-water-material.js';

export function buildSzSea(scene, surface, { name = 'shenzhen-sea', coastal = true } = {}) {
  if (!surface) return null;
  const batch = new GeoBuilder();
  for (const { outer, holes } of surface.polygons) {
    const rings = [outer, ...holes].map(ring => ring.flatMap(({ x, z }) => [x, z]));
    addFlatPolygon(batch, rings, surface.heightM);
  }
  const geometry = batch.build();
  const material = createSzWaterMaterial({ coastal });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.source = surface.source;
  scene.add(mesh);
  return {
    mesh, heightM: surface.heightM, triangles: geometry.index.count / 3,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    }
  };
}
