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

function addDeckStrip(cells, deck, section, frames, triangles, openings, statistics, count = true) {
  if (!frames || frames.length < 2 || !triangles) return;
  for (let i = 1; i < frames.length; i++) {
    // 桥面分成两个三角面。标线在同一条对角线处切开，弯坡上也贴着实际桥面。
    const triangle = (i - 1) * 2;
    const first = triangles[triangle], second = triangles[triangle + 1];
    if (!first || !second) break;
    const [leftA, rightA, rightB] = first;
    const [, , leftB] = second;
    const a = frames[i - 1], b = frames[i];
    const cell = paintCell(cells, (a.x + b.x) / 2, (a.z + b.z) / 2);
    const phase = deck.stationOffsetM ?? 0;
    const widthA = Math.hypot(leftA.x - rightA.x, leftA.z - rightA.z);
    const widthB = Math.hypot(leftB.x - rightB.x, leftB.z - rightB.z);
    // 同一根标线在两端各自的铺装宽度下换算比例；不能用较窄一端同时算两端，否则宽端整排线会向中心错位。
    const linesA = deckPaintLines(section, widthA);
    const linesB = new Map(deckPaintLines(section, widthB).map(line => [line.id, line]));
    const vertex = (p, q, t, station, color, duty) => {
      cell.position.push(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t + HEIGHT, p.z + (q.z - p.z) * t);
      cell.paint.push(station + phase, 10, duty);
      cell.color.push(color.r, color.g, color.b);
    };
    const ids = new Set([...linesA.map(line => line.id), ...linesB.keys()]);
    for (const id of ids) {
      // 渐变段窄端放不下的车道线随该条车道一起结束，不能折到边线处叠成一条粗白带。
      const aLine = linesA.find(line => line.id === id);
      const bLine = linesB.get(id);
      if (!aLine || !bLine) continue;
      const source = aLine;
      const offsetA = aLine.offset;
      const offsetB = bLine.offset;
      const side = offsetA < 0 ? 'left' : 'right';
      const duty = source.duty === 1 && openings?.get(i - 1)?.has(side) ? 0.32 : source.duty;
      const color = colorFor(source.color);
      const centerA = 0.5 + offsetA / widthA;
      const centerB = 0.5 + offsetB / widthB;
      const loA = centerA - 0.09 / widthA, hiA = centerA + 0.09 / widthA;
      const loB = centerB - 0.09 / widthB, hiB = centerB + 0.09 / widthB;
      const base = cell.position.length / 3;
      vertex(leftA, rightA, loA, a.d, color, duty);
      vertex(leftA, rightA, hiA, a.d, color, duty);
      vertex(leftB, rightB, hiB, b.d, color, duty);
      vertex(leftB, rightB, loB, b.d, color, duty);
      cell.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  if (!count) return;
  statistics.links++;
  statistics.laneCounts[section.laneCount] = (statistics.laneCounts[section.laneCount] ?? 0) + 1;
  statistics.dashedLines += section.laneCount - 1;
}

function addDeckPaint(cells, graph, decks) {
  const statistics = { links: 0, aprons: 0, laneCounts: {}, dashedLines: 0 };
  for (const deck of decks) {
    const section = getDeckSection(graph, deck);
    // contactSurface=false 的贴地结构边没有接触面，但有独立的顶面标线三角面。
    addDeckStrip(cells, deck, section, deck.frames, deck.topPaintTriangles ?? deck.topTriangles, deck.openings, statistics);
    // 悬空端引道不属于主桥面帧序列，单独按同一标线模板补画，避免引道留白。
    for (const apron of deck.aprons ?? []) {
      if (!apron.frames?.length || !apron.topTriangles?.length) continue;
      addDeckStrip(cells, deck, section, apron.frames, apron.topTriangles, null, statistics, false);
      statistics.aprons++;
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
