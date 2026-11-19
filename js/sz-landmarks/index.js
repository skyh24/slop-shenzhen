import * as THREE from 'three/webgpu';
import { buildWheelMotion } from './wheel-motion.js';
import { planSzLandmarks } from './layout.js';
import { createLandmarkMaterial } from './materials.js';
import { partCollider } from './parts.js';
import { renderLandmark, renderLandmarkTrim } from './render.js';
import { addSportsGround } from './sports-ground.js';
import { landmarkSignMaterial } from './signs.js';

export function buildSzLandmarks(scene, { buildings, terrain, terrainSurface, sites = {}, heightAt, groundHeight, roadHeight, northRail, programEmission = null }) {
  const { plans, skipIds, buildingOverrides } = planSzLandmarks(buildings, terrain, sites, { heightAt, groundHeight, roadHeight, northRail });
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarks';
  const colliders = [];
  const surfaces = [];
  const heights = new Map();
  const approaches = plans.flatMap(plan => plan.approaches);
  const fields = plans.map(plan => plan.reservesField).filter(Boolean);
  const materials = new Map();
  const materialFor = style => {
    if (!materials.has(style)) materials.set(style, createLandmarkMaterial(style, programEmission));
    return materials.get(style);
  };
  let wheelMotion;
  for (const plan of plans) {
    let fixed = plan;
    if (plan.id === 'oh-bay-wheel') {
      wheelMotion = buildWheelMotion(plan.parts, materialFor);
      scene.add(wheelMotion.group);
      fixed = { ...plan, parts: plan.parts.filter(p => p.wheelMotion === undefined) };
    }
    const result = renderLandmark(fixed, materialFor);
    group.add(result.group);
    for (const sign of plan.signs) {
      if (!materials.has(sign.style)) materials.set(sign.style, landmarkSignMaterial(sign.style));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sign.width, sign.height), materials.get(sign.style));
      mesh.name = sign.style;
      mesh.position.set(sign.x, sign.y, sign.z);
      mesh.rotation.set(sign.pitch ?? 0, sign.yaw, 0, 'YXZ');
      result.group.add(mesh);
    }
    const trimStyles = new Map();
    for (const item of plan.trim) {
      const style = item.style ?? 'landmarkEdge';
      if (!trimStyles.has(style)) trimStyles.set(style, []);
      trimStyles.get(style).push(item);
    }
    for (const [style, items] of trimStyles) result.group.add(renderLandmarkTrim(items, materialFor(style)));
    addSportsGround(result.group, plan.patches, terrainSurface, materialFor);
    // 碰撞体仍是显示同源的 partCollider，只多带一个 landmarkId，供夜景灯带按专模分组。
    for (const part of fixed.parts) colliders.push({ ...partCollider(part), landmarkId: plan.id });
    surfaces.push(...result.surfaces);
    heights.set(plan.id, {
      base: Math.min(...plan.parts.map(part => part.minY)),
      roof: Math.max(...plan.parts.map(part => part.maxY))
    });
  }
  scene.add(group);
  // 只为已建的地标前场保留净通行带；不挪动有现场来源的树。
  const reservesApproach = (x, z, radius) => fields.some(reserves => reserves(x, z, radius)) || approaches.some(({ from, to, halfWidth }) => {
    const dx = to.x - from.x, dz = to.z - from.z;
    const t = Math.max(0, Math.min(1, ((x - from.x) * dx + (z - from.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - from.x - dx * t, z - from.z - dz * t) < halfWidth + radius;
  });
  return { group, buildingOverrides, trees: plans.flatMap(plan => plan.trees), wheelMotion, colliders, surfaces, skipIds, heights, reservesApproach, dispose() {
    if (wheelMotion) group.add(wheelMotion.group);
    group.traverse(o => {
      if (o.isInstancedMesh) o.dispose();
      if (o.isMesh) o.geometry.dispose();
    });
    for (const material of materials.values()) material.dispose();
    scene.remove(group);
  } };
}
