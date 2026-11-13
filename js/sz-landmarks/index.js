import * as THREE from 'three/webgpu';
import { planSzLandmarks } from './layout.js';
import { createLandmarkMaterial } from './materials.js';
import { partCollider } from './parts.js';
import { renderLandmark, renderLandmarkTrim } from './render.js';

export function buildSzLandmarks(scene, { buildings, terrain, sites = {}, heightAt, groundHeight, programEmission = null }) {
  const { plans, skipIds } = planSzLandmarks(buildings, terrain, sites, { heightAt, groundHeight });
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarks';
  const colliders = [];
  const surfaces = [];
  const heights = new Map();
  const approaches = plans.flatMap(plan => plan.approaches);
  const materials = new Map();
  const materialFor = style => {
    if (!materials.has(style)) materials.set(style, createLandmarkMaterial(style, programEmission));
    return materials.get(style);
  };
  for (const plan of plans) {
    const result = renderLandmark(plan, materialFor);
    group.add(result.group);
    const trim = plan.trim.length ? renderLandmarkTrim(plan.trim, materialFor('landmarkEdge')) : null;
    if (trim) result.group.add(trim);
    for (const part of plan.parts) colliders.push(partCollider(part));
    surfaces.push(...result.surfaces);
    heights.set(plan.id, {
      base: Math.min(...plan.parts.map(part => part.minY)),
      roof: Math.max(...plan.parts.map(part => part.maxY))
    });
  }
  scene.add(group);
  // 只为已建的地标前场保留净通行带；不挪动有现场来源的树。
  const reservesApproach = (x, z, radius) => approaches.some(({ from, to, halfWidth }) => {
    const dx = to.x - from.x, dz = to.z - from.z;
    const t = Math.max(0, Math.min(1, ((x - from.x) * dx + (z - from.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - from.x - dx * t, z - from.z - dz * t) < halfWidth + radius;
  });
  return { group, colliders, surfaces, skipIds, heights, reservesApproach, dispose() {
    group.traverse(o => {
      if (o.isInstancedMesh) o.dispose();
      if (o.isMesh) o.geometry.dispose();
    });
    for (const material of materials.values()) material.dispose();
    scene.remove(group);
  } };
}
