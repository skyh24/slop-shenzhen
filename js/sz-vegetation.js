import * as THREE from 'three/webgpu';
import { color, fwidth, max, mix, positionWorld, sin, smoothstep } from 'three/tsl';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';
import { convexHull } from './building-collision.js';
import { GeoBuilder, triangulateFootprint, readTriangles } from './sz-geometry.js';
import { mergeParts } from './sz-mesh-utils.js';
import { buildSzSea } from './sz-sea.js';
import { colliderPolygon } from './sz-trees.js';
import { createIntertidalBeds, planVegetationPilots, vegetationRandom } from './sz-vegetation-layout.js';

const CELL = 104;
const NEAR_M = 92;
const MID_M = 240;
const SHRUB_M = 240;
const ROCK_M = 380;

const CROWNS = [
  [[0, 0.77, 0, 0.76, 0.23, 0.73], [-0.42, 0.66, -0.10, 0.58, 0.19, 0.58],
    [0.43, 0.71, -0.16, 0.56, 0.21, 0.56], [0.16, 0.63, 0.40, 0.62, 0.18, 0.58]],
  [[-0.13, 0.81, -0.05, 0.66, 0.19, 0.62], [0.41, 0.66, 0.06, 0.54, 0.22, 0.57],
    [-0.47, 0.62, 0.17, 0.53, 0.21, 0.50], [0.08, 0.68, -0.39, 0.57, 0.17, 0.56]],
  [[-0.18, 0.78, -0.15, 0.74, 0.22, 0.73], [0.36, 0.70, 0.11, 0.63, 0.19, 0.61],
    [-0.30, 0.66, 0.37, 0.57, 0.20, 0.59]]
];
const SHRUB = [[0.05, 0.53, -0.08, 0.66, 0.5, 0.66], [-0.44, 0.27, -0.09, 0.51, 0.39, 0.48],
  [0.40, 0.34, 0.22, 0.59, 0.45, 0.56], [-0.20, 0.39, 0.40, 0.57, 0.43, 0.52]];
const BARK = 0xd7b593;
const TRUNK_TOP = [0.69, 0.67, 0.71];
const TRUNK_RADIUS = [0.072, 0.081, 0.067];
const PALETTE = {
  hill: [0x345d31, 0x71914e],
  bay: [0x3d663b, 0x839857],
  mangrove: [0x3c643c, 0x809353],
  shrub: [0x466634, 0x95a660],
  rock: [0x77736b, 0xb9a991],
  roots: [0x665a44, 0x9a8d74]
};

function lobe([x, y, z, width, height, depth], detail, seed, smooth = true) {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const direction = new THREE.Vector3();
  // 方向场按单位球坐标变化，多个细节档使用同一外形。
  for (let i = 0; i < position.count; i++) {
    const a = position.getX(i), b = position.getY(i), c = position.getZ(i);
    const uneven = 0.93 + 0.07 * Math.sin(5.7 * a + 4.2 * b + 6.8 * c + seed);
    position.setXYZ(i, x + a * width * uneven, y + b * height * uneven, z + c * depth * uneven);
    if (smooth) {
      direction.set(a / width, b / height, c / depth).normalize();
      normal.setXYZ(i, direction.x, direction.y, direction.z);
    }
  }
  return geometry;
}

function branch(a, b, base, tip, sides) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const axis = to.clone().sub(from);
  return new THREE.CylinderGeometry(tip, base, axis.length(), sides, 1, true)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()))
    .translate(...from.lerp(to, 0.5).toArray());
}

function treeGeometry(shape, level) {
  const near = level === 0;
  const parts = CROWNS[shape].map((profile, i) => ({
    geometry: lobe(profile, Math.max(0, (i === 0 ? 2 : 1) - level), i + shape),
    colour: [0xffffff, 0xe0ead4, 0xf5fadf, 0xe9f1dc][i]
  }));
  const radius = TRUNK_RADIUS[shape], top = TRUNK_TOP[shape];
  parts.push({ geometry: branch([0, 0, 0], [0, top, 0], radius, radius * 0.57, 8), colour: BARK });
  if (near) {
    for (const [x, y, z] of CROWNS[shape].slice(1)) {
      parts.push({ geometry: branch([0, top * 0.53, 0], [x, y - 0.04, z], radius * 0.74, radius * 0.29, 5),
        colour: BARK });
    }
  }
  return mergeParts(parts);
}

function rockGeometry(shape) {
  const geometry = lobe([0, 0.31, 0, 1.02, 0.69, shape ? 0.65 : 0.87], 0, 2.8 + shape, false);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    positions.setY(i, Math.min(shape ? 0.78 : 0.86, y + 0.11 * positions.getX(i)));
  }
  geometry.computeVertexNormals();
  return mergeParts([{ geometry }]);
}

function rootGeometry() {
  const random = vegetationRandom(438971);
  const parts = Array.from({ length: 8 }, (_, i) => {
    const turn = i * 2.4;
    const r = 0.22 + 0.57 * random();
    const x = Math.cos(turn) * r, z = Math.sin(turn) * r;
    return { geometry: branch([x, -0.28, z], [x * 0.92, 0.12 + random() * 0.24, z * 0.92], 0.026, 0.011, 4) };
  });
  return mergeParts(parts);
}

function triangleCount(geometry) {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3;
}

function rockCollider(mesh, index, item) {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const positions = mesh.geometry.attributes.position;
  const vertex = new THREE.Vector3();
  const vertices = [];
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i).applyMatrix4(matrix);
    vertices.push({ x: vertex.x, z: vertex.z });
    minY = Math.min(minY, vertex.y);
    maxY = Math.max(maxY, vertex.y);
  }
  if (maxY < item.supportY + 0.42) return null;
  const outer = convexHull(vertices);
  return { type: 'rock', name: item.id, sourceId: item.sourceId, polygon: { outer, holes: [] }, minY, maxY,
    minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
    minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)) };
}

function treeCollider(item) {
  const { x, y, z, radius, shape, height, id, sourceId } = item;
  const r = radius * TRUNK_RADIUS[shape];
  const polygon = colliderPolygon(x, z, r);
  const maxY = y + height * TRUNK_TOP[shape];
  return { type: 'tree', name: id, sourceId, positionSource: 'simulated-vegetation', appearanceSource: 'visual-estimate',
    minX: x - r, maxX: x + r, minY: y, maxY, minZ: z - r, maxZ: z + r, polygon,
    loft: { lower: polygon.outer, upper: colliderPolygon(x, z, r * 0.57).outer, minY: y, maxY } };
}

function buildBeds(group, beds) {
  if (!beds.length) return () => {};
  const mud = new THREE.MeshStandardNodeMaterial({ roughness: 0.96 });
  const { x, z } = positionWorld;
  const mottling = sin(x.mul(0.38).add(z.mul(0.27))).mul(sin(z.mul(0.46).sub(x.mul(0.13)))).mul(0.28).add(0.5);
  mud.colorNode = mix(color(0x6f6252), color(0xa69c83), mottling);
  const water = buildSzSea(group, { polygons: beds.map(bed => bed.mask), heightM: beds[0].waterY,
    source: beds.map(bed => bed.sourceId) }, { name: 'shenzhen-mangrove-water' });
  const meshes = beds.map(bed => {
    const batch = new GeoBuilder();
    const elevation = bed.heightAt;
    function subdivide(a, b, c, depth) {
      if (!depth) {
        const base = batch.count;
        for (const { x, z } of [a, c, b]) batch.vertex(x, elevation(x, z), z, 0, 1, 0, x, z);
        batch.tri(base, base + 1, base + 2);
        return;
      }
      const ab = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const bc = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 };
      const ca = { x: (c.x + a.x) / 2, z: (c.z + a.z) / 2 };
      subdivide(a, ab, ca, depth - 1);
      subdivide(ab, b, bc, depth - 1);
      subdivide(ca, bc, c, depth - 1);
      subdivide(ab, bc, ca, depth - 1);
    }
    for (const triangle of triangulateFootprint(bed.mask)) subdivide(...triangle, 3);
    // 渲染与树根采样使用同一组泥面，泥面不注册为玩家通行面。
    const sample = createSurfaceHeightAt([{ id: bed.sourceId, triangles: readTriangles(batch, 0) }]);
    bed.heightAt = (x, z) => sample(x, z, bed.sourceId);
    const geometry = batch.build();
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, mud);
    mesh.name = 'shenzhen-mangrove-mud';
    group.add(mesh);
    return mesh;
  });
  return () => {
    water.dispose();
    mud.dispose();
    for (const mesh of meshes) mesh.geometry.dispose();
  };
}

export function buildVegetationPilots(scene, geo, site, existingTrees) {
  const group = new THREE.Group();
  group.name = 'shenzhen-vegetation-pilots';
  scene.add(group);
  const beds = createIntertidalBeds(geo.seaSurface, geo.terrain, site.isWater, geo.water);
  const cleanBeds = buildBeds(group, beds);
  const placed = planVegetationPilots(geo, site, beds, existingTrees);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, vertexColors: true });
  // 实体冠用低振幅色差补细节，远处按像素宽度收敛到同一底色。
  const { x, y, z } = positionWorld;
  const u = x.mul(12.1).add(y.mul(13.6)), v = z.mul(11.7).sub(y.mul(10.2));
  const grain = sin(u).mul(sin(v)).mul(smoothstep(0.4, 2.5, max(fwidth(u), fwidth(v))).oneMinus());
  material.colorNode = color(0xffffff).mul(grain.mul(0.065).add(0.935));
  const geometries = new Map();
  const cells = new Map();
  const colliders = [];
  const counts = {};
  for (const item of placed) {
    const key = `${Math.floor(item.x / CELL)},${Math.floor(item.z / CELL)}`;
    if (!cells.has(key)) cells.set(key, { key, x: item.x, z: item.z, items: [], meshes: [], lod: -1 });
    cells.get(key).items.push(item);
    if (item.kind === 'tree' && item.siteId !== 'mangrove') colliders.push(treeCollider(item));
    const count = counts[item.siteId] ??= { tree: 0, shrub: 0, rock: 0, roots: 0, submerged: 0 };
    count[item.kind]++;
    if (item.roots) count.roots++;
    if (item.siteId === 'mangrove' && item.supportY < beds[0].waterY) count.submerged++;
  }

  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color(), light = new THREE.Color();
  const pipelines = new Map();
  function makeMesh(cell, items, kind, shape, lod, maxDistance, shadows, build) {
    if (!items.length) return;
    const template = `${kind}:${shape}:${lod}`;
    if (!geometries.has(template)) geometries.set(template, build());
    const geometry = geometries.get(template);
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.name = `vegetation:${cell.key}:${template}`;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    for (const [index, item] of items.entries()) {
      const { x, y, z, radius, height, turn } = item;
      position.set(x, kind === 'roots' ? item.supportY : y, z);
      scale.set(radius, kind === 'roots' ? 1 : height, radius);
      rotation.setFromAxisAngle(up, turn);
      mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
      const [dark, pale] = PALETTE[kind === 'tree' ? item.siteId : kind];
      tint.setHex(dark).lerp(light.setHex(pale), item.tint * 0.85);
      mesh.setColorAt(index, tint);
      if (kind === 'rock') {
        const collider = rockCollider(mesh, index, item);
        if (collider) colliders.push(collider);
      }
    }
    mesh.computeBoundingSphere();
    if (pipelines.has(shadows)) mesh.userData.sharesPipelineWith = pipelines.get(shadows);
    else pipelines.set(shadows, mesh);
    group.add(mesh);
    cell.meshes.push({ mesh, lod, maxDistance, triangles: triangleCount(geometry) * items.length });
  }

  for (const cell of cells.values()) {
    const xs = cell.items.map(p => p.x), zs = cell.items.map(p => p.z);
    cell.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    cell.z = (Math.min(...zs) + Math.max(...zs)) / 2;
    cell.minY = Math.min(...cell.items.map(p => p.y));
    cell.maxY = Math.max(...cell.items.map(p => p.y + p.height));
    for (let shape = 0; shape < CROWNS.length; shape++) {
      const trees = cell.items.filter(item => item.kind === 'tree' && item.shape === shape);
      for (let lod = 0; lod < 3; lod++) {
        makeMesh(cell, trees, 'tree', shape, lod, Infinity, shape < 2 && lod === 0, () => treeGeometry(shape, lod));
      }
    }
    for (const shape of [0, 1]) makeMesh(cell, cell.items.filter(item => item.kind === 'rock' && item.shape === shape),
      'rock', shape, -1, ROCK_M, false, () => rockGeometry(shape));
    makeMesh(cell, cell.items.filter(item => item.kind === 'shrub'), 'shrub', 0, -1, SHRUB_M, false,
      () => mergeParts(SHRUB.map((profile, i) => ({ geometry: lobe(profile, 0, i), colour: i === 0 ? 0xffffff : 0xe4edd7 }))));
    makeMesh(cell, cell.items.filter(item => item.roots), 'roots', 0, 0, NEAR_M + 20, false, rootGeometry);
  }

  const statistics = { counts, colliders: colliders.length, cells: cells.size,
    trianglesByTemplate: Object.fromEntries([...geometries].map(([key, geometry]) => [key, triangleCount(geometry)])),
    visible: { batches: 0, triangles: 0, nearCells: 0, middleCells: 0, farCells: 0 } };
  function update({ x, y, z }) {
    const visible = { batches: 0, triangles: 0, nearCells: 0, middleCells: 0, farCells: 0 };
    for (const cell of cells.values()) {
      const dy = Math.max(0, cell.minY - y, y - cell.maxY);
      const distance = Math.hypot(x - cell.x, dy, z - cell.z);
      const lod = distance < (cell.lod === 0 ? NEAR_M + 14 : NEAR_M) ? 0
        : distance < (cell.lod === 2 ? MID_M : MID_M + 24) ? 1 : 2;
      cell.lod = lod;
      visible[['nearCells', 'middleCells', 'farCells'][lod]]++;
      for (const batch of cell.meshes) {
        const show = (batch.lod < 0 || batch.lod === lod)
          && distance <= batch.maxDistance + (batch.mesh.visible ? 18 : 0);
        if (batch.mesh.visible !== show) batch.mesh.visible = show;
        if (show) {
          visible.batches++;
          visible.triangles += batch.triangles;
        }
      }
    }
    statistics.visible = visible;
  }

  function flightObstacles(bounds) {
    return placed.filter(item => item.kind === 'tree' && item.x + item.radius >= bounds.minX
      && item.x - item.radius <= bounds.maxX && item.z + item.radius >= bounds.minZ && item.z - item.radius <= bounds.maxZ)
      .map(({ x, y, z, radius, height }) => ({ minX: x - radius, maxX: x + radius,
        minY: y, maxY: y + height, minZ: z - radius, maxZ: z + radius }));
  }

  update({ x: 0, y: 0, z: 0 });
  let disposed = false;
  return { group, colliders, statistics, update, flightObstacles,
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const cell of cells.values()) for (const { mesh } of cell.meshes) mesh.dispose();
      for (const geometry of geometries.values()) geometry.dispose();
      cleanBeds();
      material.dispose();
      group.clear();
    } };
}
