import * as THREE from 'three/webgpu';
import { planSzLandmarks } from './layout.js';
import { createLandmarkMaterial } from './materials.js';
import { partCollider } from './parts.js';
import { renderLandmark } from './render.js';

export function buildSzLandmarks(scene, { buildings, terrain, sites = {} }) {
  const { plans, skipIds } = planSzLandmarks(buildings, terrain, sites);
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarks';
  const colliders = [];
  const surfaces = [];
  const heights = new Map();
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
    heights.set(plan.id, {
      base: Math.min(...plan.parts.map(part => part.minY)),
      roof: Math.max(...plan.parts.map(part => part.maxY))
    });
  }
  scene.add(group);
  return { group, colliders, surfaces, skipIds, heights, dispose() {
    group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    for (const material of materials.values()) material.dispose();
    scene.remove(group);
  } };
}
