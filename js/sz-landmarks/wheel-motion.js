import * as THREE from 'three/webgpu';
import { convexHull } from '../building-collision.js';
import { renderLandmark } from './render.js';

// 保存原实体的上下两圈及其棱线。旋转后的碰撞截面和画面使用同一刚体变换。
function movingCollider(part, transform) {
  const lower = part.loft?.lower ?? part.polygon.outer;
  const upper = part.loft?.upper ?? lower;
  const n = lower.length;
  const ring = (points, y) => points.map((p, i) => new THREE.Vector3(p.x, Array.isArray(y) ? y[i] : y, p.z));
  const rest = [...ring(lower, part.bottom), ...ring(upper, part.top)];
  const box = new THREE.Box3().setFromPoints(rest), bounds = new THREE.Box3();
  const edges = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push([i, j], [i + n, j + n], [i, i + n]);
  }
  let lastPose = -1, cached;
  return (x, z, r, version) => {
    if (lastPose !== version) {
      bounds.copy(box).applyMatrix4(transform);
      lastPose = version;
      cached = null;
    }
    if (bounds.max.x < x - r || bounds.min.x > x + r || bounds.max.z < z - r || bounds.min.z > z + r) return null;
    if (cached) return cached;
    const vertices = rest.map(v => v.clone().applyMatrix4(transform));
    let projection;
    cached = {
      type: 'building', name: part.id, sourceId: part.sourceId, landmarkId: 'oh-bay-wheel',
      minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z,
      minY: bounds.min.y, maxY: bounds.max.y,
      get polygon() { return projection ??= { outer: convexHull(vertices), holes: [] }; },
      sectionAt(bottom, top) {
        const points = vertices.filter(v => v.y >= bottom && v.y <= top);
        for (const [i, j] of edges) {
          const a = vertices[i], b = vertices[j];
          for (const y of [bottom, top]) {
            if ((a.y < y) === (b.y < y)) continue;
            const t = (y - a.y) / (b.y - a.y);
            points.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
          }
        }
        const outer = convexHull(points);
        return outer.length >= 3 ? { outer, holes: [] } : null;
      }
    };
    return cached;
  };
}

export function buildWheelMotion(parts, materialFor) {
  const group = new THREE.Group();
  group.name = 'BayGloryMotion';
  const axle = parts.find(p => p.id === 'oh-bay:axle');
  const center = new THREE.Vector3((axle.minX + axle.maxX) / 2, (axle.minY + axle.maxY) / 2, (axle.minZ + axle.maxZ) / 2);
  const axis = new THREE.Vector3(-0.6, 0, 0.8);
  const moving = parts.filter(p => p.wheelMotion !== undefined);
  const wheel = renderLandmark({ id: 'bay-glory-rim', parts: moving.filter(p => p.wheelMotion === 'rim') }, materialFor).group;
  for (const mesh of wheel.children) mesh.geometry.translate(-center.x, -center.y, -center.z);
  wheel.position.copy(center);
  group.add(wheel);
  const cabins = moving.filter(p => p.style === 'bayCabinGlass');
  const anchors = cabins.map(p => new THREE.Vector3((p.minX + p.maxX) / 2, (p.minY + p.maxY) / 2, (p.minZ + p.maxZ) / 2));
  const sample = renderLandmark({ id: 'bay-glory-cabin', parts: moving.filter(p => p.wheelMotion === 0) }, materialFor);
  const cabinMeshes = sample.group.children.map(prototype => {
    const anchor = anchors[0];
    const geometry = prototype.geometry.translate(-anchor.x, -anchor.y, -anchor.z);
    const mesh = new THREE.InstancedMesh(geometry, prototype.material, cabins.length);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.copy(center);
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), anchors[0].distanceTo(center) + 5);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
    return mesh;
  });
  const worldRotation = new THREE.Matrix4(), origin = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  const offsets = cabins.map(() => new THREE.Matrix4());
  const queries = moving.map(p => movingCollider(p, p.wheelMotion === 'rim' ? worldRotation : offsets[p.wheelMotion]));
  const offset = new THREE.Vector3(), instance = new THREE.Matrix4();
  let angle = 0, version = 0;
  function pose() {
    version++;
    wheel.quaternion.setFromAxisAngle(axis, angle);
    worldRotation.makeRotationFromQuaternion(wheel.quaternion).setPosition(center).multiply(origin);
    for (let i = 0; i < cabins.length; i++) {
      offset.copy(anchors[i]).sub(center).applyQuaternion(wheel.quaternion);
      instance.makeTranslation(offset);
      for (const mesh of cabinMeshes) mesh.setMatrixAt(i, instance);
      offsets[i].makeTranslation(offset.add(center).sub(anchors[i]));
    }
    for (const mesh of cabinMeshes) mesh.instanceMatrix.needsUpdate = true;
    group.updateMatrixWorld(true);
  }
  pose();
  const near = p => p && center.distanceToSquared(p) < 420 ** 2;
  return { group,
    update(dt, camera, player) {
      if (!(dt > 0) || !(near(camera) || near(player))) return;
      angle = (angle + dt * Math.PI * 2 / 720) % (Math.PI * 2);
      pose();
    },
    appendColliders(out, x, z, radius) {
      if (Math.abs(x - center.x) > radius + 62 || Math.abs(z - center.z) > radius + 62) return out;
      for (const query of queries) {
        const collider = query(x, z, radius, version);
        if (collider) out.push(collider);
      }
      return out;
    }
  };
}
