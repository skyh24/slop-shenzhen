// 福田中心区夜景灯光秀：只给共享包里已建成的普通高层加 LED 轮廓灯带，不用官方会徽/图案。
// 灯光颜色、节奏为展示参数（estimate）；不改变建筑体量，也不新增可碰撞体。
import * as THREE from 'three/webgpu';
import { color, mix, sin, smoothstep, time } from 'three/tsl';
import { sceneUniforms } from './sz-materials.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';
import { ringArea } from './sz-polygon.js';

export const SHOW_MIN_HEIGHT_M = 150;
export const SHOW_STRIPS_PER_TOWER = 6;
export const SHOW_STRIP_WIDTH_M = 0.42;
export const SHOW_BUCKETS = 6;
// 福田中心区范围：市民中心、深南、益田路、滨河一带；超总/后海按各自模型处理。
export const SHOW_AREA = Object.freeze({ minX: -3000, maxX: 3000, minZ: -1500, maxZ: 2500 });

function centroid(ring) {
  let cx = 0, cz = 0;
  for (const point of ring) { cx += point.x; cz += point.z; }
  return { x: cx / ring.length, z: cz / ring.length };
}

/** 解析：挑选福田中心区夜景灯光秀的楼栋（纯计划，不建几何）。
 *  输入：REAL_BUILDINGS 与地形；范围 x∈[-3000,3000]、z∈[-1500,2500] 且高度≥150 m。
 *  输出：每栋楼的灯带位置（最多 6 条竖向）、塔顶轮廓与材质桶；确定性排序。
 *  说明：灯带样式/颜色是展示估计，不改变建筑高度来源。 */
export function planLightShow(buildings, terrain) {
  const towers = [];
  for (const building of buildings) {
    if (building.height < SHOW_MIN_HEIGHT_M) continue;
    const polygon = building.polygons?.[0];
    if (!polygon || polygon.outer.length < 3) continue;
    const ring = polygon.outer;
    const center = centroid(ring);
    if (center.x < SHOW_AREA.minX || center.x > SHOW_AREA.maxX
      || center.z < SHOW_AREA.minZ || center.z > SHOW_AREA.maxZ) continue;
    const placement = buildingPlacement(building, terrain);
    const top = placement.maxY;
    const bottom = placement.minY + Math.min(3, building.height * 0.05);
    if (!(top - bottom > 20)) continue;
    const count = Math.min(SHOW_STRIPS_PER_TOWER, ring.length);
    const step = ring.length / count;
    const strips = [];
    for (let index = 0; index < count; index++) {
      const point = ring[Math.floor(index * step) % ring.length];
      const dx = point.x - center.x, dz = point.z - center.z;
      const length = Math.hypot(dx, dz) || 1;
      // 灯带贴在外立面外 0.3 m，避免和墙面 z-fighting。
      const x = point.x + dx / length * 0.3;
      const z = point.z + dz / length * 0.3;
      strips.push({ x, z, bottom, top, height: top - bottom, angle: Math.atan2(dx, dz) });
    }
    // 顶部一圈水平灯带：用足迹包围盒四条边，让塔顶在夜景里勾出轮廓。
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const point of ring) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    }
    const crownY = top - 1.4;
    const crown = [
      { x: (minX + maxX) / 2, z: minZ, widthX: maxX - minX, widthZ: SHOW_STRIP_WIDTH_M, y: crownY },
      { x: (minX + maxX) / 2, z: maxZ, widthX: maxX - minX, widthZ: SHOW_STRIP_WIDTH_M, y: crownY },
      { x: minX, z: (minZ + maxZ) / 2, widthX: SHOW_STRIP_WIDTH_M, widthZ: maxZ - minZ, y: crownY },
      { x: maxX, z: (minZ + maxZ) / 2, widthX: SHOW_STRIP_WIDTH_M, widthZ: maxZ - minZ, y: crownY }
    ];
    towers.push({
      id: building.id, height: building.height, bucket: Math.floor(buildingSeed(building.id) * SHOW_BUCKETS) % SHOW_BUCKETS,
      center, strips, crown, areaM2: Math.round(ringArea(ring)), heightSource: 'estimate'
    });
  }
  towers.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    towers,
    totals: {
      towers: towers.length,
      strips: towers.reduce((sum, tower) => sum + tower.strips.length, 0),
      crownSegments: towers.reduce((sum, tower) => sum + tower.crown.length, 0),
      buckets: SHOW_BUCKETS,
      minHeightM: SHOW_MIN_HEIGHT_M
    }
  };
}

/** 解析：灯光秀材质——TSL 时间驱动青/品红/暖金呼吸循环，按夜景系数渐入。
 *  输入：材质桶编号（按建筑 id 固定分桶，0–5）。
 *  输出：MeshBasicNodeMaterial；白天亮度归零，`buildSzLightShow` 会整组隐藏。 */
function createShowMaterial(bucket) {
  const phase = bucket * 1.13;
  // 三色循环：青、品红、暖金；亮度按夜景系数渐入，白天不可见。
  const breathe = sin(time.mul(0.55).add(phase)).mul(0.5).add(0.5);
  const tint = mix(color(0x1fd6ff), color(0xff2f9e), breathe);
  const pulse = sin(time.mul(1.9).add(phase * 2.3)).mul(0.18).add(0.82);
  const fade = smoothstep(0.32, 0.68, sceneUniforms.night);
  const material = new THREE.MeshBasicNodeMaterial({
    colorNode: mix(tint, color(0xffd34d), sin(time.mul(0.27).add(phase)).mul(0.5).add(0.5).mul(0.35))
      .mul(pulse).mul(fade),
    transparent: false,
    fog: false
  });
  material.name = `shenzhen-light-show:${bucket}`;
  return material;
}

/** 解析：把灯光秀计划实例化到场景。
 *  输入：REAL_BUILDINGS、地形。
 *  输出：{ group, statistics, towers, update, dispose }；6 个材质桶 → 6 个 InstancedMesh。
 *  约束：只做显示，不加碰撞体、不改建筑体量；白天隐藏、不占 draw call。 */
export function buildSzLightShow(scene, { buildings = [], terrain = null } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Light show requires a scene');
  const plan = planLightShow(buildings, terrain);
  const group = new THREE.Group();
  group.name = 'shenzhen-light-show';
  scene.add(group);
  const statistics = { ...plan.totals, drawCallsEstimate: plan.totals.towers > 0 ? SHOW_BUCKETS * 2 : 0,
    visible: false, colorSource: 'display-estimate', heightSource: 'estimate' };
  if (plan.towers.length === 0) {
    return { group, statistics, towers: [], update() {}, dispose() { scene.remove(group); } };
  }
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = Array.from({ length: SHOW_BUCKETS }, (_, bucket) => createShowMaterial(bucket));
  const buckets = materials.map(() => []);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const tower of plan.towers) {
    for (const strip of tower.strips) {
      matrix.compose(new THREE.Vector3(strip.x, (strip.bottom + strip.top) / 2, strip.z), quaternion,
        new THREE.Vector3(SHOW_STRIP_WIDTH_M, strip.height, SHOW_STRIP_WIDTH_M));
      buckets[tower.bucket].push(matrix.clone());
    }
    for (const segment of tower.crown) {
      matrix.compose(new THREE.Vector3(segment.x, segment.y, segment.z), quaternion,
        new THREE.Vector3(segment.widthX, SHOW_STRIP_WIDTH_M, segment.widthZ));
      buckets[tower.bucket].push(matrix.clone());
    }
  }
  const meshes = [];
  buckets.forEach((matrices, bucket) => {
    if (matrices.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, materials[bucket], matrices.length);
    mesh.name = `shenzhen-light-show:${bucket}`;
    matrices.forEach((entry, index) => mesh.setMatrixAt(index, entry));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    meshes.push(mesh);
  });
  statistics.instances = meshes.reduce((sum, mesh) => sum + mesh.count, 0);
  statistics.meshes = meshes.length;
  return {
    group,
    statistics,
    towers: plan.towers,
    update() {},
    dispose() {
      scene.remove(group);
      geometry.dispose();
      for (const material of materials) material.dispose();
    }
  };
}
