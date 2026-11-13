import * as THREE from 'three/webgpu';
import { GeoBuilder, addFlatPolygon } from './sz-geometry.js';
import { createSzWaterMaterial } from './sz-water-material.js';

export function buildSzSea(scene, surface, { name = 'shenzhen-sea', coastal = true, cityReflection = true } = {}) {
  if (!surface) return null;
  const batch = new GeoBuilder();
  for (const { outer, holes } of surface.polygons) {
    const rings = [outer, ...holes].map(ring => ring.flatMap(({ x, z }) => [x, z]));
    addFlatPolygon(batch, rings, surface.heightM);
  }
  const geometry = batch.build();
  // 水材质从共用缓存借用，销毁单个水体时只回收其几何。
  const material = cityReflection ? createSzWaterMaterial({ coastal }) : createSzWaterMaterial({ coastal, cityReflection });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.source = surface.source;
  scene.add(mesh);
  return {
    mesh, heightM: surface.heightM, triangles: geometry.index.count / 3,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
    }
  };
}
