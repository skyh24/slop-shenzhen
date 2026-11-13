import * as THREE from 'three/webgpu';
import { color, floor, fract, fwidth, max, min, mix, positionWorld, smoothstep } from 'three/tsl';
import { sceneUniforms } from './sz-materials.js';
import { SURFACE_STYLES } from './sz-scene-style.js';

// 全局米制坐标保持相邻块的拼缝对齐。标高、边界与权限由各场地自己的表面提供。
export function createPavingMaterial(preset, overrides = {}) {
  if (!Object.hasOwn(SURFACE_STYLES, preset)) throw new Error(`Unknown paving preset: ${preset}`);
  const { color: tint, variation, jointColor, tileSizeM, roughness = 0.9, metalness = 0, depthBias = 0,
    nightColor, nightStrength, groutStrength = 0.22, groutFade = [0.12, 0.42],
    groutWidth = [0.011, 0.026] } = { ...SURFACE_STYLES[preset], ...overrides };
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, roughness, metalness,
    polygonOffset: depthBias !== 0, polygonOffsetFactor: depthBias, polygonOffsetUnits: depthBias });
  if (tileSizeM) {
    const grid = positionWorld.xz.div(tileSizeM);
    const tile = fract(grid);
    const pixel = max(fwidth(grid.x), fwidth(grid.y));
    const joint = min(min(tile.x, tile.x.oneMinus()), min(tile.y, tile.y.oneMinus()));
    const filled = smoothstep(groutWidth[0], max(groutWidth[1], pixel), joint);
    if (jointColor !== undefined) {
      const seed = fract(floor(grid.x).mul(0.318).add(floor(grid.y).mul(0.753)));
      material.colorNode = mix(color(jointColor), mix(color(tint), color(variation ?? tint), seed), filled);
    } else {
      const grout = filled.oneMinus().mul(smoothstep(groutFade[0], groutFade[1], pixel).oneMinus());
      material.colorNode = color(tint).mul(grout.mul(-groutStrength).add(1));
    }
  }
  if (nightColor !== undefined) material.emissiveNode = color(nightColor).mul(sceneUniforms.night).mul(nightStrength);
  return material;
}

export function pavingMesh(positions, origin, material, id) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(
    positions instanceof Float32Array ? positions : new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = id;
  mesh.position.set(origin[0], 0, origin[1]);
  mesh.receiveShadow = true;
  return mesh;
}
