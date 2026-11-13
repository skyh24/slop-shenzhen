import * as THREE from 'three/webgpu';
import { createMarkingLayout, deckPaintLines } from './sz-road-markings.js';
import { createSzRoadPaintMaterial } from './sz-road-material.js';
import { getDeckSection } from './sz-road-section.js';

// 标线是静态几何，按 2.4 km 合并成块：出生点 1484 次绘制里有 246 次来自标线 600 m 分块，
// 放大到 2.4 km 后同一视野内的块数约降到 1/16，三角形不变。
const CELL = 2400;
const HEIGHT = 0.055;

function colorFor(name) {
  if (name === 'yellow') return new THREE.Color(0xf0b81e);
  return new THREE.Color(0xf1eee4);
}

function paintCell(cells, x, z) {
  const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  if (!cells.has(key)) cells.set(key, { position: [], color: [], paint: [], index: [] });
  return cells.get(key);
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
    const cell = paintCell(cells, (strip.ax + strip.bx) / 2, (strip.az + strip.bz) / 2);
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

function addDeckPaint(cells, graph, decks) {
  const statistics = { links: 0, laneCounts: {}, dashedLines: 0 };
  for (const deck of decks) {
    const section = getDeckSection(graph, deck);
    const lines = deckPaintLines(section);
    statistics.links++;
    statistics.laneCounts[section.laneCount] = (statistics.laneCounts[section.laneCount] ?? 0) + 1;
    statistics.dashedLines += section.laneCount - 1;
    for (let i = 1; i < deck.frames.length; i++) {
      const a = deck.frames[i - 1], b = deck.frames[i];
      const cell = paintCell(cells, (a.x + b.x) / 2, (a.z + b.z) / 2);
      // 桥面分成两个三角面。标线在同一条对角线处切开，弯坡上也贴着实际桥面。
      const triangle = (i - 1 + (deck.leadingOverlapFrames ?? 0)) * 2;
      const [leftA, rightA, rightB] = deck.topTriangles[triangle];
      const [, , leftB] = deck.topTriangles[triangle + 1];
      const phase = deck.stationOffsetM ?? 0;
      const widthA = Math.hypot(leftA.x - rightA.x, leftA.z - rightA.z);
      const widthB = Math.hypot(leftB.x - rightB.x, leftB.z - rightB.z);
      const vertex = (p, q, t, station, color, duty) => {
        cell.position.push(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t + HEIGHT, p.z + (q.z - p.z) * t);
        cell.paint.push(station + phase, 10, duty);
        cell.color.push(color.r, color.g, color.b);
      };
      for (const line of lines) {
        const color = colorFor(line.color);
        const center = 0.5 + line.offset / section.pavementWidthM;
        const loA = center - 0.09 / widthA, loB = center - 0.09 / widthB;
        const hiA = center + 0.09 / widthA, hiB = center + 0.09 / widthB;
        const lo = loA / (1 + loA - loB), hi = hiA / (1 + hiA - hiB);
        const base = cell.position.length / 3;
        vertex(leftA, rightA, loA, a.d, color, line.duty);
        vertex(leftA, rightA, hiA, a.d, color, line.duty);
        vertex(leftA, rightB, hi, a.d + (b.d - a.d) * hi, color, line.duty);
        vertex(leftA, rightB, lo, a.d + (b.d - a.d) * lo, color, line.duty);
        vertex(leftB, rightB, hiB, b.d, color, line.duty);
        vertex(leftB, rightB, loB, b.d, color, line.duty);
        cell.index.push(base, base + 1, base + 2, base, base + 2, base + 3,
          base + 3, base + 2, base + 4, base + 3, base + 4, base + 5);
      }
    }
  }
  return statistics;
}

export function buildSzRoadPaint(scene, graph, { roadHeight, intersections = [], frontage, decks = [] } = {}) {
  if (typeof roadHeight !== 'function') throw new Error('Road paint requires rendered road height');
  const layout = createMarkingLayout(graph, { intersections, frontage });
  const cells = buildChunks(layout.strips, roadHeight);
  const elevated = addDeckPaint(cells, graph, decks);
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
  return { group, meshes, statistics: { ...layout.statistics, elevated, chunks: meshes.length },
    // 材质是模块级单例，只销毁本次几何。
    dispose() { scene.remove(group); for (const mesh of meshes) mesh.geometry.dispose(); } };
}
