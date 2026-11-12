import * as THREE from 'three/webgpu';
import { attribute, fract, fwidth, max, min, mix, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { unpackSurface, sampler, createGroundSurfaceSampler } from './sz-ground-surface.js';

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

const COLORS = [0xb5b0a2, 0x6f875a, 0x527858, 0xa7a8a4];

function groundMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.96 });
  // 石材接缝只作用于铺装三角面，远处按像素覆盖渐隐。
  const grid = positionWorld.xz.div(0.72);
  const tile = fract(grid);
  const edge = min(min(tile.x, tile.x.oneMinus()), min(tile.y, tile.y.oneMinus()));
  const pixel = max(fwidth(grid.x), fwidth(grid.y));
  const joint = smoothstep(0.009, max(0.026, pixel), edge).oneMinus()
    .mul(smoothstep(0.09, 0.38, pixel).oneMinus());
  material.colorNode = vec3(mix(1, joint.mul(-0.20).add(1), attribute('paved', 'float')));
  return material;
}

export function buildSzGround(scene, surface, options = {}) {
  const chunks = unpackSurface(surface);
  const palette = COLORS.map(value => new THREE.Color(value));
  const material = options.material ?? groundMaterial();
  const group = new THREE.Group();
  group.name = 'shenzhen-ground';
  const entries = [];
  for (const chunk of chunks.values()) {
    const colors = new Float32Array(chunk.kinds.length * 3);
    const paved = new Float32Array(chunk.kinds.length);
    chunk.kinds.forEach((kind, i) => {
      const color = palette[kind];
      if (!color) throw new Error(`Unsupported ground kind: ${kind}`);
      color.toArray(colors, i * 3);
      paved[i] = kind === 3 ? 1 : 0;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('paved', new THREE.BufferAttribute(paved, 1));
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
  return { group, meshes, groundHeight: sampler(surface, chunks),
    dispose() {
      scene.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      if (!options.material) material.dispose();
    } };
}
