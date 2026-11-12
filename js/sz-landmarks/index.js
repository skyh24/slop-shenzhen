import * as THREE from 'three/webgpu';
import { planSzLandmarks } from './layout.js';
import { createLandmarkMaterial } from './materials.js';
import { partCollider } from './parts.js';
import { renderLandmark } from './render.js';

export function buildSzLandmarks(scene, { buildings, terrain, sites = {}, groundHeight }) {
  const { plans, skipIds } = planSzLandmarks(buildings, terrain, sites, groundHeight);
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarks';
  const colliders = [];
  const surfaces = [];
  const materials = new Map();
  const materialFor = style => {
    if (!materials.has(style)) materials.set(style, createLandmarkMaterial(style));
    return materials.get(style);
  };
  for (const plan of plans) {
    const result = renderLandmark(plan, materialFor);
    group.add(result.group);
    for (const part of plan.parts) colliders.push(partCollider(part));
    surfaces.push(...result.surfaces);
  }
  scene.add(group);
  return { group, colliders, surfaces, skipIds, dispose() {
    group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    for (const material of materials.values()) material.dispose();
    scene.remove(group);
  } };
}
