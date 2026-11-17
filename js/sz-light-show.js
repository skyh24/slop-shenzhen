// 福田中心区夜景灯光秀：只给共享包里已建成的普通高层加 LED 轮廓灯带，不用官方会徽/图案。
// 灯光颜色、节奏为展示参数（estimate）；不改变建筑体量，也不新增可碰撞体。
import * as THREE from 'three/webgpu';
import { clamp, color, mix, positionWorld, sin, smoothstep, time } from 'three/tsl';
import { sceneUniforms } from './sz-materials.js';
import { dayPhase } from './sz-day-phase.js';
import { buildingPlacement, buildingSeed } from './sz-building-layout.js';
import { ringArea } from './sz-polygon.js';

export const SHOW_MIN_HEIGHT_M = 150;
export const SHOW_STRIPS_PER_TOWER = 6;
export const SHOW_STRIP_WIDTH_M = 0.42;
export const SHOW_BUCKETS = 6;
// 福田中心区范围：市民中心、深南、益田路、滨河一带；超总/后海按各自模型处理。
export const SHOW_AREA = Object.freeze({ minX: -3000, maxX: 3000, minZ: -1500, maxZ: 2500 });
// 专模 loft 边灯带：只给总高≥120 m 的地标，每栋按最高的 4 段收分截面取边，全城上限 480 条。
export const LANDMARK_EDGE_MIN_HEIGHT_M = 120;
export const LANDMARK_EDGE_SEGMENTS = 4;
export const LANDMARK_EDGE_BANDS_PER_LANDMARK = 8;
export const LANDMARK_EDGE_BANDS_CITY_LIMIT = 480;
// 灯带沿“环心→顶点”方向外移 0.28 m：贴住收分轮廓，又不和墙面 z-fighting。
export const LANDMARK_EDGE_OFFSET_M = 0.28;

function centroid(ring) {
  let cx = 0, cz = 0;
  for (const point of ring) { cx += point.x; cz += point.z; }
  return { x: cx / ring.length, z: cz / ring.length };
}

/** 解析：挑选福田中心区夜景灯光秀的楼栋（纯计划，不建几何）。
 *  输入：REAL_BUILDINGS 与地形；范围 x∈[-3000,3000]、z∈[-1500,2500] 且高度≥150 m；
 *        excludeIds 是已被地标接管的源对象 id（收窄/收分塔楼由专模自己打光，不能再按基地足迹拉通高灯带）。
 *  输出：每栋楼的灯带位置（最多 6 条竖向）、塔顶轮廓与材质桶；确定性排序。
 *  说明：灯带样式/颜色是展示估计，不改变建筑高度来源。 */
export function planLightShow(buildings, terrain, { excludeIds = null } = {}) {
  const excluded = excludeIds ? new Set(excludeIds) : null;
  const towers = [];
  for (const building of buildings) {
    if (excluded?.has(building.id)) continue;
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

/** 解析：把地标外露钢架和专模收分截面转成 LED 灯带实例。
 *  输入：landmarks.colliders（partCollider 结果，专模碰撞体带 landmarkId），
 *        平安巨柱 id 形如 `<source>:mega-column:<index>:<tier>`。
 *  输出：{ rows, bottom, top }；每行是从下到上的空间线段，width 是灯带宽；没有可用灯带时返回 null。
 *  说明：只做显示、不新增碰撞体；颜色由材质按世界高度渐变（从下到上青→品红→暖金）。
 *        巨柱路径按柱轴每段一条；专模路径按 landmarkId 取最高的若干 loft 分段，每段在 ±x/±z
 *        四个正交方向的环顶点出灯带，端点沿“环心→顶点”外移 0.28 m，贴合收分轮廓。 */
export function planLandmarkBands(colliders = [], { clearance = 0.2, width = 1.2 } = {}) {
  const centroid = ring => ring.reduce((sum, point) => ({ x: sum.x + point.x / ring.length, z: sum.z + point.z / ring.length }),
    { x: 0, z: 0 });
  const bearing = (from, to) => {
    const dx = to.x - from.x, dz = to.z - from.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
  };
  // 柱截面的外向半径：把截面顶点投影到“塔心→柱心”方向取最大值，
  // 灯带落在柱面外，不会被柱体包住（柱在底部更深）。
  const outerReach = (ring, centre, direction) => Math.max(...ring.map(point =>
    (point.x - centre.x) * direction.x + (point.z - centre.z) * direction.z));
  const rows = [];
  // 一路：平安 8 根巨柱，按源分段沿柱轴出灯带（原有路径，几何不变）。
  const columns = new Map();
  for (const collider of colliders) {
    const match = /:mega-column:(\d+):(\d+)$/.exec(collider.name ?? '');
    if (!match || !collider.loft) continue;
    if (!columns.has(match[1])) columns.set(match[1], []);
    columns.get(match[1]).push(collider);
  }
  if (columns.size > 0) {
    const columnParts = [...columns.values()].map(parts => parts.sort((a, b) => a.minY - b.minY));
    const center = columnParts.reduce((sum, parts) => {
      const base = centroid(parts[0].loft.lower);
      return { x: sum.x + base.x / columnParts.length, z: sum.z + base.z / columnParts.length };
    }, { x: 0, z: 0 });
    const gap = width / 2 + clearance;
    // 每根柱按源分段的截面逐段取灯带：每段都贴在柱面外，沿收分内倾，不会在柱中间切进塔身。
    for (const parts of columnParts) {
      for (const part of parts) {
        const low = centroid(part.loft.lower);
        const high = centroid(part.loft.upper);
        const lowDirection = bearing(center, low);
        const highDirection = bearing(center, high);
        const lowReach = outerReach(part.loft.lower, low, lowDirection);
        const highReach = outerReach(part.loft.upper, high, highDirection);
        rows.push({
          kind: 'mega-column',
          x0: low.x + lowDirection.x * (lowReach + gap), z0: low.z + lowDirection.z * (lowReach + gap), y0: part.minY,
          x1: high.x + highDirection.x * (highReach + gap), z1: high.z + highDirection.z * (highReach + gap), y1: part.maxY,
          width
        });
      }
    }
  }
  // 二路：专模 loft 边灯带。按 landmarkId 分组，只取中心在本区、总高≥120 m 的专模；
  // 灯带端点取真实截面环上的顶点，不用包围盒四角硬凑，因此贴合收分轮廓、不会悬空。
  const landmarks = new Map();
  for (const collider of colliders) {
    if (!collider.landmarkId) continue;
    // 巨柱只走上面那一路：柱体在柱面外 0.8 m 已有灯带，柱面内 0.28 m 的边带会被柱体包住。
    if (/:mega-column:\d+:\d+$/.test(collider.name ?? '')) continue;
    if (!landmarks.has(collider.landmarkId)) landmarks.set(collider.landmarkId, []);
    landmarks.get(collider.landmarkId).push(collider);
  }
  const directions = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
  const outward = (vertex, centre, distance) => {
    const dx = vertex.x - centre.x, dz = vertex.z - centre.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return { x: vertex.x, z: vertex.z };
    return { x: vertex.x + dx / length * distance, z: vertex.z + dz / length * distance };
  };
  for (const landmarkId of [...landmarks.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (rows.length >= LANDMARK_EDGE_BANDS_CITY_LIMIT) break;
    const parts = landmarks.get(landmarkId);
    const low = Math.min(...parts.map(part => part.minY));
    const high = Math.max(...parts.map(part => part.maxY));
    if (!(high - low >= LANDMARK_EDGE_MIN_HEIGHT_M)) continue;
    const lofts = parts.filter(part => part.loft && Array.isArray(part.loft.lower) && Array.isArray(part.loft.upper)
      && part.loft.lower.length >= 3 && part.loft.upper.length === part.loft.lower.length && part.maxY > part.minY);
    // 没有 loft 的专模跳过，不拿 bbox 凑灯带。
    if (lofts.length === 0) continue;
    // 专模中心取各 loft 截面环心的均值：来自真实体量，不用包围盒角点。
    const centre = { x: 0, z: 0 };
    for (const part of lofts) {
      const ringCentre = centroid(part.loft.lower);
      centre.x += ringCentre.x / lofts.length;
      centre.z += ringCentre.z / lofts.length;
    }
    if (centre.x < SHOW_AREA.minX || centre.x > SHOW_AREA.maxX
      || centre.z < SHOW_AREA.minZ || centre.z > SHOW_AREA.maxZ) continue;
    let bands = 0;
    const segments = [...lofts].sort((a, b) => (b.maxY - a.maxY) || (a.name ?? '').localeCompare(b.name ?? '', 'en'))
      .slice(0, LANDMARK_EDGE_SEGMENTS);
    for (const part of segments) {
      if (bands >= LANDMARK_EDGE_BANDS_PER_LANDMARK || rows.length >= LANDMARK_EDGE_BANDS_CITY_LIMIT) break;
      const lowCentre = centroid(part.loft.lower);
      const highCentre = centroid(part.loft.upper);
      const used = new Set();
      for (const direction of directions) {
        if (bands >= LANDMARK_EDGE_BANDS_PER_LANDMARK || rows.length >= LANDMARK_EDGE_BANDS_CITY_LIMIT) break;
        // 环上沿该正交方向最外的顶点；同段内按顶点去重，避免方向并列时重复灯带。
        let index = -1, best = -Infinity;
        for (let i = 0; i < part.loft.lower.length; i++) {
          const point = part.loft.lower[i];
          const reach = (point.x - lowCentre.x) * direction.x + (point.z - lowCentre.z) * direction.z;
          if (reach > best + 1e-9) { best = reach; index = i; }
        }
        if (index < 0 || used.has(index)) continue;
        used.add(index);
        const lowerPoint = outward(part.loft.lower[index], lowCentre, LANDMARK_EDGE_OFFSET_M);
        const upperPoint = outward(part.loft.upper[index], highCentre, LANDMARK_EDGE_OFFSET_M);
        rows.push({ kind: 'loft-edge', landmarkId, x0: lowerPoint.x, z0: lowerPoint.z, y0: part.minY,
          x1: upperPoint.x, z1: upperPoint.z, y1: part.maxY, width });
        bands += 1;
      }
    }
  }
  if (rows.length === 0) return null;
  return { rows, bottom: Math.min(...rows.map(row => row.y0)), top: Math.max(...rows.map(row => row.y1)) };
}

/** 解析：钢架灯带材质——颜色随世界高度从下到上渐变，夜里渐入、轻微呼吸。 */
function createBandMaterial(bottom, top) {
  const span = Math.max(1, top - bottom);
  const height = clamp(positionWorld.y.sub(bottom).div(span), 0, 1);
  const lower = smoothstep(0, 0.55, height);
  const upper = smoothstep(0.55, 1, height);
  const tint = mix(mix(color(0x1fd6ff), color(0xff2f9e), lower), color(0xffd34d), upper);
  const breathe = sin(time.mul(0.8).add(height.mul(7))).mul(0.18).add(0.82);
  const fade = smoothstep(0.32, 0.68, sceneUniforms.night);
  const material = new THREE.MeshBasicNodeMaterial({ colorNode: tint.mul(breathe).mul(fade), transparent: false, fog: false });
  material.name = 'shenzhen-light-show:steel-bands';
  return material;
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
export function buildSzLightShow(scene, { buildings = [], terrain = null, excludeIds = null, landmarkBands = null,
  isProgramActive = () => false } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Light show requires a scene');
  const plan = planLightShow(buildings, terrain, { excludeIds });
  const group = new THREE.Group();
  group.name = 'shenzhen-light-show';
  scene.add(group);
  const bandRows = landmarkBands?.rows?.length ? landmarkBands.rows : [];
  const statistics = { ...plan.totals, landmarkBands: bandRows.length,
    drawCallsEstimate: (plan.totals.towers > 0 ? SHOW_BUCKETS * 2 : 0) + (bandRows.length > 0 ? 1 : 0),
    visible: false, colorSource: 'display-estimate', heightSource: 'estimate' };
  // 夜景显隐由本模块按全局日夜 uniform 自己判断，入口只调用 update()，不再逐帧改 group.visible。
  const updateVisibility = () => {
    group.visible = dayPhase.channel('show') > 0 && !isProgramActive();
    statistics.visible = group.visible;
  };
  if (plan.towers.length === 0 && bandRows.length === 0) {
    return { group, statistics, towers: [], update: updateVisibility, dispose() { scene.remove(group); } };
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
  const bandMaterials = [];
  if (bandRows.length > 0) {
    const bandMaterial = createBandMaterial(landmarkBands.bottom, landmarkBands.top);
    bandMaterials.push(bandMaterial);
    const matrices = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const row of bandRows) {
      const start = new THREE.Vector3(row.x0, row.y0, row.z0);
      const end = new THREE.Vector3(row.x1, row.y1, row.z1);
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 1) continue;
      const rotation = new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize());
      matrices.push(new THREE.Matrix4().compose(start.add(end).multiplyScalar(0.5), rotation,
        new THREE.Vector3(row.width, length, row.width)));
    }
    if (matrices.length > 0) {
      const mesh = new THREE.InstancedMesh(geometry, bandMaterial, matrices.length);
      mesh.name = 'shenzhen-light-show:steel-bands';
      matrices.forEach((entry, index) => mesh.setMatrixAt(index, entry));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      meshes.push(mesh);
      statistics.landmarkBands = matrices.length;
    }
  }
  statistics.instances = meshes.reduce((sum, mesh) => sum + mesh.count, 0);
  statistics.meshes = meshes.length;
  return {
    group,
    statistics,
    towers: plan.towers,
    update: updateVisibility,
    dispose() {
      scene.remove(group);
      geometry.dispose();
      for (const material of [...materials, ...bandMaterials]) material.dispose();
    }
  };
}
