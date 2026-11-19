import * as THREE from 'three/webgpu';
import { attribute, color, distance, floor, vec2, fract, fwidth, max, min, mx_noise_float, positionWorld, select, smoothstep, vec3 } from 'three/tsl';
import { copyGroundChunksForRender, createGroundSurfaceSampler, URBAN_STONE_KIND, URBAN_LAWN_KIND, PARK_GRAVEL_KIND } from './sz-ground-surface.js';

// 静态地表按 2.4 km 超块合并（与 sz-roads.js 同款逻辑）：页面只需给每个分块一份带位置/法线/颜色/索引的
// BufferGeometry 和世界原点，合并时把原点烘焙进顶点位置。三角形不变，只牺牲更粗的视锥剔除。
const STATIC_BATCH_SIZE = 2400;

function mergeChunkGeometries(entries) {
  const names = Object.keys(entries[0].geometry.attributes);
  const merged = new THREE.BufferGeometry();
  const arrays = new Map(names.map(name => [name, []]));
  const indices = [];
  let vertexOffset = 0;
  for (const { geometry, x, z } of entries) {
    const count = geometry.attributes.position.count;
    for (const name of names) {
      const source = geometry.attributes[name];
      const copy = new source.array.constructor(source.array.length);
      copy.set(source.array);
      if (name === 'position') {
        for (let i = 0; i < copy.length; i += 3) { copy[i] += x; copy[i + 2] += z; }
      }
      arrays.get(name).push(copy);
    }
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i++) indices.push(index.array[i] + vertexOffset);
    else for (let i = 0; i < count; i++) indices.push(i + vertexOffset);
    vertexOffset += count;
  }
  for (const [name, pieces] of arrays) {
    const first = entries[0].geometry.attributes[name];
    const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const array = new first.array.constructor(length);
    let offset = 0;
    for (const piece of pieces) { array.set(piece, offset); offset += piece.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(array, first.itemSize, first.normalized));
  }
  merged.setIndex(indices);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function batchChunks(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = `${Math.floor(entry.x / STATIC_BATCH_SIZE)},${Math.floor(entry.z / STATIC_BATCH_SIZE)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  return [...buckets.entries()].map(([key, items]) => ({
    key, chunks: items, geometry: mergeChunkGeometries(items)
  }));
}

export { createGroundSurfaceSampler };

const COLORS = [0xb5b0a2, 0x6f875a, 0x527858, 0xa7a8a4, 0xb8b1a5, 0x736f68, 0xa79780, 0x938473, 0x535655, 0x383d42];

function groundMaterial(frontageLight) {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.96 });
  // 石材接缝只作用于铺装三角面，远处按像素覆盖渐隐。
  const finish = attribute('paved', 'float');
  const paving = max(0, finish);
  const marble = max(0, finish.negate());
  const grid = positionWorld.xz.div(select(finish.lessThan(0), 1.2, 0.72));
  const tile = fract(grid);
  const edge = min(min(tile.x, tile.x.oneMinus()), min(tile.y, tile.y.oneMinus()));
  const pixel = max(fwidth(grid.x), fwidth(grid.y));
  const joint = smoothstep(0.009, max(0.026, pixel), edge).oneMinus()
    .mul(smoothstep(0.09, 0.38, pixel).oneMinus());
  // 路面颗粒随像素覆盖淡出；不创建石子几何或碰撞。
  const grainUV = positionWorld.xz.mul(48);
  const noise = fract(floor(grainUV).dot(vec2(0.754877, 0.56984)).mul(28.718));
  const grainFade = smoothstep(0.3, 1.4, max(fwidth(grainUV.x), fwidth(grainUV.y))).oneMinus();
  const grain = noise.sub(0.5).mul(grainFade);
  // 1.2 米方板共用世界坐标。每块略微换色，细石脉在板缝处自然截断。
  const block = floor(grid);
  const variation = fract(block.dot(vec2(0.61803, 0.41421)));
  const veins = mx_noise_float(vec2(tile.x.mul(1.2).add(tile.y.mul(2.8)), tile.y.mul(1.4))
    .add(variation.mul(11))).abs();
  const vein = smoothstep(0.015, 0.14, veins).oneMinus()
    .mul(smoothstep(0.025, 0.16, pixel).oneMinus());
  const marbleTone = variation.sub(0.5).mul(0.11).sub(vein.mul(0.10)).sub(joint.mul(0.34));
  const finishTone = marbleTone.mul(marble).sub(joint.mul(0.20).mul(paving));
  material.colorNode = vec3(finishTone.add(grain.mul(attribute('asphalt', 'float')).mul(0.18)).add(1));
  material.roughnessNode = marble.mul(-0.16).add(0.96);
  if (frontageLight) {
    const reach = smoothstep(5, 46, distance(positionWorld.xz, vec2(frontageLight.x, frontageLight.z))).oneMinus();
    material.emissiveNode = color(0xa99c8c).mul(0.23).mul(frontageLight.night)
      .mul(reach).mul(max(paving, marble));
  }
  return material;
}

// 栅格只在内存中标记邻楼范围。离开建成街区时，普通干地的颜色逐渐恢复。
function buildingInfluence(buildings) {
  const step = 32, reach = 96, cells = new Map();
  for (const { minX, minZ, maxX, maxZ, minHeight } of buildings) {
    if (minHeight > 2.4) continue;
    for (let i = Math.ceil((minX - reach) / step); i <= Math.floor((maxX + reach) / step); i++) {
      for (let j = Math.ceil((minZ - reach) / step); j <= Math.floor((maxZ + reach) / step); j++) {
        const dx = Math.max(0, minX - i * step, i * step - maxX);
        const dz = Math.max(0, minZ - j * step, j * step - maxZ);
        const weight = Math.min(1, (reach - Math.hypot(dx, dz)) / 32);
        const key = i * 65536 + j;
        if (weight > (cells.get(key) ?? 0)) cells.set(key, weight);
      }
    }
  }
  return (x, z) => {
    const u = x / step, v = z / step, i = Math.floor(u), j = Math.floor(v);
    const fx = u - i, fz = v - j, k = i * 65536 + j;
    return (1 - fz) * ((1 - fx) * (cells.get(k) ?? 0) + fx * (cells.get(k + 65536) ?? 0))
      + fz * ((1 - fx) * (cells.get(k + 1) ?? 0) + fx * (cells.get(k + 65537) ?? 0));
  };
}

export function buildSzGround(scene, surface, options = {}) {
  const chunks = copyGroundChunksForRender(surface);
  const palette = COLORS.map(value => new THREE.Color(value));
  palette[URBAN_STONE_KIND] = new THREE.Color(0xa9aaa7);
  palette[URBAN_LAWN_KIND] = new THREE.Color(0x748e50);
  palette[PARK_GRAVEL_KIND] = new THREE.Color(0xa99b86);
  const urbanWeight = buildingInfluence(options.buildings ?? []);
  const dryColor = new THREE.Color();
  const material = options.material ?? groundMaterial(options.frontageLight);
  const group = new THREE.Group();
  group.name = 'shenzhen-ground';
  const entries = [];
  for (const chunk of chunks) {
    const colors = new Float32Array(chunk.kinds.length * 3);
    const paved = new Float32Array(chunk.kinds.length);
    const asphalt = new Float32Array(chunk.kinds.length);
    chunk.kinds.forEach((kind, i) => {
      const color = palette[kind];
      if (!color) throw new Error(`Unsupported ground kind: ${kind}`);
      color.toArray(colors, i * 3);
      if (kind === URBAN_LAWN_KIND) {
        const x = chunk.origin[0] + chunk.positions[i * 3];
        const z = chunk.origin[1] + chunk.positions[i * 3 + 2];
        const tint = 1 + 0.055 * Math.sin(x * 0.11 + z * 0.07) * Math.cos(z * 0.14);
        for (let channel = 0; channel < 3; channel++) colors[i * 3 + channel] *= tint;
      }
      paved[i] = kind === URBAN_STONE_KIND ? -1 : Number(kind === 3 || kind === 4 || kind === 7);
      if (kind === 0) {
        const weight = urbanWeight(chunk.origin[0] + chunk.positions[i * 3], chunk.origin[1] + chunk.positions[i * 3 + 2]);
        dryColor.copy(color).lerp(palette[URBAN_STONE_KIND], weight).toArray(colors, i * 3);
        paved[i] = -weight;
      }
      asphalt[i] = kind === PARK_GRAVEL_KIND ? 1.35 : Number(kind === 5 || kind === 8 || kind === 9);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('paved', new THREE.BufferAttribute(paved, 1));
    geometry.setAttribute('asphalt', new THREE.BufferAttribute(asphalt, 1));
    geometry.setIndex(new THREE.BufferAttribute(chunk.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    entries.push({ geometry, x: chunk.origin[0], z: chunk.origin[1], id: chunk.id });
  }
  const meshes = [];
  for (const batch of batchChunks(entries)) {
    const mesh = new THREE.Mesh(batch.geometry, material);
    mesh.name = `terrain-batch:${batch.key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = options.castShadow ?? true;
    mesh.userData.terrainSurface = true;
    group.add(mesh);
    meshes.push(mesh);
    for (const entry of batch.chunks) entry.geometry.dispose();
  }
  scene.add(group);
  return { group, meshes, groundHeight: createGroundSurfaceSampler(surface),
    dispose() {
      scene.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      if (!options.material) material.dispose();
    } };
}
