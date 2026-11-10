import * as THREE from 'three/webgpu';
import { createMarkingLayout } from './sz-road-markings.js';
import { createSzRoadPaintMaterial } from './sz-road-material.js';

const CELL = 600;
const HEIGHT = 0.055;

function colorFor(name) {
  if (name === 'yellow') return new THREE.Color(0xf0b81e);
  return new THREE.Color(0xf1eee4);
}

function buildChunks(strips, roadHeight) {
  const cells = new Map();
  for (const strip of strips) {
    const ux = strip.bx - strip.ax, uz = strip.bz - strip.az;
    const length = Math.hypot(ux, uz);
    if (length < 0.05) continue;
    const y0 = roadHeight(strip.ax, strip.az);
    const y1 = roadHeight(strip.bx, strip.bz);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    const sx = -uz / length * strip.width / 2, sz = ux / length * strip.width / 2;
    const key = `${Math.floor((strip.ax + strip.bx) / 2 / CELL)},${Math.floor((strip.az + strip.bz) / 2 / CELL)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { position: [], color: [], paint: [], index: [] });
    const color = colorFor(strip.color);
    const base = cell.position.length / 3;
    for (const [x, y, z, side, u] of [[strip.ax, y0 + HEIGHT, strip.az, -1, strip.phase],
      [strip.ax, y0 + HEIGHT, strip.az, 1, strip.phase],
      [strip.bx, y1 + HEIGHT, strip.bz, 1, strip.phase + length],
      [strip.bx, y1 + HEIGHT, strip.bz, -1, strip.phase + length]]) {
      cell.position.push(x + sx * side, y, z + sz * side);
      cell.paint.push(u, strip.period, strip.duty);
      cell.color.push(color.r, color.g, color.b);
    }
    cell.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return cells;
}

export function buildSzRoadPaint(scene, graph, { roadHeight, intersections = [] } = {}) {
  if (typeof roadHeight !== 'function') throw new Error('Road paint requires rendered road height');
  const layout = createMarkingLayout(graph, { intersections });
  const cells = buildChunks(layout.strips, roadHeight);
  const group = new THREE.Group();
  group.name = 'shenzhen-road-markings';
  const material = createSzRoadPaintMaterial();
  const meshes = [];
  for (const [key, cell] of cells) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.position, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(cell.color, 3));
    geometry.setAttribute('paint', new THREE.Float32BufferAttribute(cell.paint, 3));
    const normals = new Float32Array(cell.position.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(cell.index);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `road-markings/${key}`;
    mesh.renderOrder = 3;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return { group, meshes, statistics: { ...layout.statistics, chunks: meshes.length },
    // 材质是模块级单例，只销毁本次几何。
    dispose() { scene.remove(group); for (const mesh of meshes) mesh.geometry.dispose(); } };
}
