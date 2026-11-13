import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { sceneUniforms } from './sz-materials.js';

const palette = {
  bay: {
    lamp: { color: 0x64605b, roughness: 0.45, glow: 0xffdb9f, strength: 2.4 }
  },
  common: {
    steel: { color: 0x506169, roughness: 0.66, metalness: 0.21 }, wood: { color: 0x855e40, roughness: 0.81 }
  },
  park: {
    lamp: { color: 0xc7b390, roughness: 0.49, glow: 0xffcf91, strength: 1.65 },
    stone: { color: 0x777669, roughness: 0.96 }
  }
};
const geometryPool = { geometry: null, users: 0 };
const materials = new Map();
const X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);

const atHeight = (p, h) => ({ ...p, y: p.y + h });
const beam = (a, b, width, height) => ({ a, b, width, height });
export const planRail = (a, b, bars) => bars.map(([h, width, height]) => beam(atHeight(a, h), atHeight(b, h), width, height));

export function planBench(p, dx, dz, { halfLengthM, seatHeightM, seatWidthM, legBottomM, legTopM,
  legWidthM, legDepthM, back }) {
  const ends = (h, offset = 0) => [-halfLengthM, halfLengthM].map(d => ({
    x: p.x + d * dx - offset * dz, y: p.y + h, z: p.z + d * dz + offset * dx
  }));
  const seat = ends(seatHeightM);
  const wood = [beam(...seat, seatWidthM, 0.12)];
  if (back) wood.push(beam(...ends(back.heightM, back.offsetM), 0.085, 0.39));
  const steel = ends(0).map(end => beam(atHeight(end, legBottomM), atHeight(end, legTopM), legWidthM, legDepthM));
  return { wood, steel };
}

export function planLantern(p, { poleBottomM, poleTopM, headBottomM, headTopM, headWidthM }) {
  return { pole: beam(atHeight(p, poleBottomM), atHeight(p, poleTopM), 0.14, 0.14),
    lamp: beam(atHeight(p, headBottomM), atHeight(p, headTopM), headWidthM, headWidthM) };
}

// 分块只拥有实例，释放实例不回收别处仍引用的几何和材质。
export function createFixtureBatches(group, preset, axis = 'x') {
  if (!Object.hasOwn(palette, preset) || preset === 'common') throw new Error(`Unknown site fixture preset: ${preset}`);
  const ownedMaterials = new Set();
  const meshes = new Set();
  let acquired = false;
  let disposed = false;
  function build(rows, finish, name) {
    if (disposed) throw new Error('Site fixtures have been disposed');
    if (!rows.length) return null;
    const owner = Object.hasOwn(palette[preset], finish) ? preset : 'common';
    const key = `${owner}:${finish}`;
    const style = Object.hasOwn(palette[owner], finish) && palette[owner][finish];
    if (!style) throw new Error(`Unknown site fixture material: ${key}`);
    if (!acquired) {
      geometryPool.geometry ??= new THREE.BoxGeometry(1, 1, 1);
      geometryPool.users++;
      acquired = true;
    }
    if (!materials.has(key)) {
      const { glow, strength, ...params } = style;
      const material = new THREE.MeshStandardNodeMaterial(params);
      if (glow !== undefined) material.emissiveNode = color(glow).mul(sceneUniforms.night).mul(strength);
      materials.set(key, { material, users: 0 });
    }
    const entry = materials.get(key);
    if (!ownedMaterials.has(key)) {
      entry.users++;
      ownedMaterials.add(key);
    }
    const mesh = new THREE.InstancedMesh(geometryPool.geometry, entry.material, rows.length);
    mesh.name = name;
    mesh.receiveShadow = true;
    const pose = new THREE.Object3D();
    const direction = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    for (const [i, { a, b, width, height }] of rows.entries()) {
      direction.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const length = direction.length();
      pose.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      if (axis === 'x') {
        pose.scale.set(length, height, width);
        pose.quaternion.setFromUnitVectors(X, direction.normalize());
      } else if (Math.hypot(direction.x, direction.z) < 0.001) {
        pose.scale.set(width, Math.abs(direction.y), height);
        pose.quaternion.identity();
      } else {
        direction.normalize();
        right.crossVectors(UP, direction).normalize();
        up.crossVectors(direction, right);
        pose.scale.set(width, height, length);
        pose.quaternion.setFromRotationMatrix(basis.makeBasis(right, up, direction));
      }
      pose.updateMatrix();
      mesh.setMatrixAt(i, pose.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    meshes.add(mesh);
    return mesh;
  }
  return { build, dispose() {
    if (disposed) return;
    disposed = true;
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const key of ownedMaterials) {
      const entry = materials.get(key);
      if (--entry.users === 0) {
        entry.material.dispose();
        materials.delete(key);
      }
    }
    if (acquired && --geometryPool.users === 0) {
      geometryPool.geometry.dispose();
      geometryPool.geometry = null;
    }
  } };
}
