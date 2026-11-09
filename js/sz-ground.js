import * as THREE from 'three/webgpu';
import { unpackSurface, sampler, createGroundSurfaceSampler } from './sz-ground-surface.js';

export { createGroundSurfaceSampler };

const COLORS = [0xb5b0a2, 0x6f875a, 0x527858];

export function buildSzGround(scene, surface, options = {}) {
  const chunks = unpackSurface(surface);
  const palette = COLORS.map(value => new THREE.Color(value));
  const material = options.material ?? new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.96 });
  const group = new THREE.Group();
  group.name = 'shenzhen-ground';
  const meshes = [];
  for (const chunk of chunks.values()) {
    const colors = new Float32Array(chunk.kinds.length * 3);
    chunk.kinds.forEach((kind, i) => {
      const color = palette[kind];
      if (!color) throw new Error(`Unsupported ground kind: ${kind}`);
      color.toArray(colors, i * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain:${chunk.id}`;
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.receiveShadow = true;
    mesh.castShadow = options.castShadow ?? true;
    mesh.userData.terrainSurface = true;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return { group, meshes, groundHeight: sampler(surface, chunks),
    dispose() {
      scene.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      if (!options.material) material.dispose();
    } };
}
