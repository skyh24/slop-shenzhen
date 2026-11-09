import * as THREE from 'three/webgpu';
import { GeoBuilder, addFlatPolygon } from './sz-geometry.js';
import { createWaterMaterial } from './sz-materials.js';

export function buildSzSea(scene, surface) {
  if (!surface) return null;
  const batch = new GeoBuilder();
  for (const { outer, holes } of surface.polygons) {
    const rings = [outer, ...holes].map(ring => ring.flatMap(({ x, z }) => [x, z]));
    addFlatPolygon(batch, rings, surface.heightM);
  }
  const geometry = batch.build();
  const material = createWaterMaterial({ coastal: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'shenzhen-sea';
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
