import * as THREE from 'three/webgpu';
import { createSzRoadSurfaceMaterial } from './sz-road-material.js';

// 静态地表按 2.4 km 超块合并（与 sz-ground.js 同款逻辑）：页面只需给每个分块一份带位置/法线/颜色/索引的
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

const EPSILON = 1e-8;
const turn = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

export function isGroundRoad({ heightSource, bridge, tunnel, layer }) {
  return heightSource === 'terrain' && !bridge && !tunnel && !layer;
}

export function roadLinkPoints(graph, [start, end, , , , , inner]) {
  const points = [{ x: graph.nodes[start * 2], z: graph.nodes[start * 2 + 1] }];
  for (let i = 0; i < inner.length; i += 2) points.push({ x: inner[i], z: inner[i + 1] });
  points.push({ x: graph.nodes[end * 2], z: graph.nodes[end * 2 + 1] });
  return points.filter((p, i) => !i || p.x !== points[i - 1].x || p.z !== points[i - 1].z);
}

export function roadSectionPoints(graph, link, metadata) {
  const source = metadata.crossSection?.points;
  if (!source) return roadLinkPoints(graph, link);
  const points = [];
  for (let i = 0; i < source.length; i += 3) points.push({ x: source[i], z: source[i + 1], leftM: source[i + 2] });
  return points;
}

// 支路选固定一侧，反向编码同一路段时保持世界坐标中的同一侧。
export function roadsideSides(highway, points) {
  if (['trunk', 'trunk_link', 'primary', 'primary_link'].includes(highway)) return [1, -1];
  const first = points[0];
  const last = points.at(-1);
  return [first.x < last.x || (first.x === last.x && first.z <= last.z) ? 1 : -1];
}

export function planStreetTreeSides(graph, bounds) {
  const segments = [];
  for (let i = 0; i < graph.links.length; i++) {
    const meta = graph.metadata[i];
    if (!isGroundRoad(meta) || !/^(trunk|primary|secondary|tertiary)(_link)?$/.test(meta.highway)) continue;
    const link = graph.links[i];
    const points = roadLinkPoints(graph, link);
    if (points.length < 2) continue;
    const sides = roadsideSides(meta.highway, points);
    // 旧包的模拟树没有道路 ID，沿用生成器的中心线偏距匹配已有点位。
    const offset = link[3] / 2 + 2.5;
    const pad = offset + 1.1;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1], b = points[j];
      if (!bounds.some(([x0, z0, x1, z1]) => Math.max(a.x, b.x) + pad >= x0 && Math.min(a.x, b.x) - pad <= x1
        && Math.max(a.z, b.z) + pad >= z0 && Math.min(a.z, b.z) - pad <= z1)) continue;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      segments.push({ a, dx: (b.x - a.x) / length, dz: (b.z - a.z) / length, length, offset, sides });
    }
  }
  return (x, z) => {
    if (!bounds.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1)) return true;
    let bestError = 1.1;
    let allowed = true;
    for (const { a, dx, dz, length, offset, sides } of segments) {
      const px = x - a.x, pz = z - a.z;
      const along = px * dx + pz * dz;
      if (along < -0.2 || along > length + 0.2) continue;
      const across = px * dz - pz * dx;
      const error = Math.abs(Math.abs(across) - offset);
      if (error >= bestError) continue;
      bestError = error;
      allowed = sides.includes(Math.sign(across));
    }
    return allowed;
  };
}

export function roadTravelPoints(graph, link, metadata, travelWidthM) {
  if (!metadata.crossSection) return roadLinkPoints(graph, link);
  const points = roadSectionPoints(graph, link, metadata);
  const halfTravel = travelWidthM / 2;
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const offset = (halfTravel - p.leftM) / length;
    return { x: p.x - (b.z - a.z) * offset, z: p.z + (b.x - a.x) * offset };
  });
}

export function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  function half(vertices) {
    const result = [];
    for (const p of vertices) {
      while (result.length >= 2 && turn(result[result.length - 2], result[result.length - 1], p) <= EPSILON) result.pop();
      result.push(p);
    }
    result.pop();
    return result;
  }
  return [...half(sorted), ...half(sorted.reverse())];
}

function boundsOf(points) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const { x, z } of points) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  return bounds;
}

function overlaps(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function footprintIndex(grid) {
  const columns = grid.nx - 1;
  const rows = grid.nz - 1;
  const cells = new Array(columns * rows);

  function addFootprint(points, sources, riseAt) {
    if (points.length < 3) return;
    const bounds = boundsOf(points);
    const edges = points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      return { x: a.x, z: a.z, nx: (a.z - b.z) / length, nz: (b.x - a.x) / length };
    });
    const footprint = { bounds, edges, sources, riseAt };
    const firstX = Math.max(0, Math.floor((bounds.minX - grid.x0) / grid.step));
    const lastX = Math.min(columns - 1, Math.floor((bounds.maxX - grid.x0) / grid.step));
    const firstZ = Math.max(0, Math.floor((bounds.minZ - grid.z0) / grid.step));
    const lastZ = Math.min(rows - 1, Math.floor((bounds.maxZ - grid.z0) / grid.step));
    for (let z = firstZ; z <= lastZ; z++) {
      for (let x = firstX; x <= lastX; x++) {
        const cell = z * columns + x;
        (cells[cell] ??= []).push(footprint);
      }
    }
  }
  return { cells, addFootprint };
}

// 路面裁切、行人避让和裙房退让共用裁切前的平面边界。
// 局部查询也收集相邻路段的端断面，保证区域边缘的路口补面完整。
export function visitGroundRoadFootprints(graph, visit, includeLink = null) {
  const junctions = new Map();
  const selected = new Set();
  const nodes = new Set();
  let groundLinks = 0;

  if (includeLink) {
    for (let index = 0; index < graph.links.length; index++) {
      if (!includeLink(index)) continue;
      const metadata = graph.metadata[index];
      if (!metadata || !isGroundRoad(metadata)) continue;
      selected.add(index);
      const [start, end] = graph.links[index];
      nodes.add(start);
      nodes.add(end);
    }
  }

  function addArm(node, crossSection, linkIndex) {
    if (includeLink && !nodes.has(node)) return;
    if (!junctions.has(node)) junctions.set(node, { points: [], linkIndices: [] });
    const junction = junctions.get(node);
    junction.points.push(...crossSection);
    junction.linkIndices.push(linkIndex);
  }

  for (let index = 0; index < graph.links.length; index++) {
    const link = graph.links[index];
    const [start, end, , width] = link;
    const emit = !includeLink || selected.has(index);
    if (!emit && !nodes.has(start) && !nodes.has(end)) continue;
    const metadata = graph.metadata[index];
    if (!metadata || !isGroundRoad(metadata)) continue;
    groundLinks++;
    if (!(width > 0)) continue;
    const linkIndices = [index];
    const points = roadSectionPoints(graph, link, metadata);
    let previous = null;
    for (let i = 1; i < points.length; i++) {
      if (!emit && i !== 1 && i !== points.length - 1) continue;
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < EPSILON) continue;
      const section = p => {
        const left = (p.leftM ?? width / 2) / length;
        const right = width / length - left;
        return [{ x: p.x + dz * left, z: p.z - dx * left }, { x: p.x - dz * right, z: p.z + dx * right }];
      };
      const startSection = section(a);
      const endSection = section(b);
      if (emit) visit([startSection[0], endSection[0], endSection[1], startSection[1]], linkIndices);
      if (previous) {
        // 按外侧路缘补斜接，避免急弯处的直角切口和无界延长。
        const change = previous.dx * dz - previous.dz * dx;
        const side = change > 0 ? 0 : 1;
        const before = previous.endSection[side];
        const after = startSection[side];
        if (emit && Math.abs(turn(a, before, after)) > EPSILON) {
          visit(change > 0 ? [a, before, after] : [a, after, before], linkIndices);
        }
      } else {
        addArm(start, startSection, index);
      }
      if (i === points.length - 1) addArm(end, endSection, index);
      previous = { dx, dz, endSection };
    }
  }

  // 共用 OSM 节点的地面路段才能补接缝；单独端点和跨层道路保持各自边界。
  for (const { points, linkIndices } of junctions.values()) {
    if (linkIndices.length < 2) continue;
    const hull = convexHull(points);
    if (hull.length >= 3) visit(hull, linkIndices);
  }
  return groundLinks;
}

function edgeDistance(edge, point) {
  const distance = (point.x - edge.x) * edge.nx + (point.z - edge.z) * edge.nz;
  return Math.abs(distance) < EPSILON ? 0 : distance;
}

// 路缘截线上的高度沿同一块地形三角面线性插值。
function splitPolygon(polygon, edge, outside) {
  const inside = [];
  let a = polygon[polygon.length - 1];
  let da = edgeDistance(edge, a);
  for (const b of polygon) {
    const db = edgeDistance(edge, b);
    if (da * db < 0) {
      const t = da / (da - db);
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      inside.push(point);
      outside?.push(point);
    }
    if (db >= 0) inside.push(b);
    if (db <= 0) outside?.push(b);
    a = b;
    da = db;
  }
  return inside;
}

function hasArea(polygon) {
  for (let i = 1; i + 1 < polygon.length; i++) {
    if (Math.abs(turn(polygon[0], polygon[i], polygon[i + 1])) > EPSILON) return true;
  }
  return false;
}

function intersectFootprint(triangle, footprint) {
  let polygon = triangle;
  for (const edge of footprint.edges) {
    polygon = splitPolygon(polygon, edge);
    if (polygon.length < 3) return [];
  }
  return polygon;
}

function subtractFootprint(polygon, footprint, result) {
  let inside = polygon;
  const pieces = [];
  for (const edge of footprint.edges) {
    const outside = [];
    inside = splitPolygon(inside, edge, outside);
    if (inside.length < 3) {
      result.push(polygon);
      return;
    }
    if (hasArea(outside)) pieces.push(outside);
  }
  result.push(...(hasArea(inside) ? pieces : [polygon]));
}

function appendTriangles(vertices, polygon, [originX, originZ], plane, treatment) {
  const local = polygon.map(p => {
    const x = Math.fround(p.x - originX);
    const z = Math.fround(p.z - originZ);
    const y = p.y + plane.dx * (x + originX - p.x) + plane.dz * (z + originZ - p.z);
    const rise = treatment?.riseAt?.(x + originX, z + originZ) ?? 0;
    return { x, y: Math.fround(y + rise), baseY: Math.fround(y), z };
  });
  let area = 0;
  for (let i = 1; i + 1 < local.length; i++) {
    const a = local[0];
    const b = local[i];
    const c = local[i + 1];
    const twiceArea = -turn(a, b, c);
    if (twiceArea <= EPSILON) continue;
    vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    area += twiceArea / 2;
  }
  if (area > 0 && treatment?.wallVertices) {
    for (let i = 0; i < local.length; i++) {
      const a = local[i], b = local[(i + 1) % local.length];
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < EPSILON || (a.y === a.baseY && b.y === b.baseY)) continue;
      // 顶面为顺时针，沿边向外检查是否还有连续步行面。侧壁顶边直接复用已量化的顶面顶点。
      const inset = 0.003 / length;
      const x = (a.x + b.x) / 2 + originX - dz * inset;
      const z = (a.z + b.z) / 2 + originZ + dx * inset;
      if (treatment.hasWalkSurface(x, z)) continue;
      const aBase = [a.x, a.baseY, a.z], bBase = [b.x, b.baseY, b.z];
      const aTop = [a.x, a.y, a.z], bTop = [b.x, b.y, b.z];
      if (b.y !== b.baseY) treatment.wallVertices.push(...aBase, ...bBase, ...bTop);
      if (a.y !== a.baseY) treatment.wallVertices.push(...aBase, ...bTop, ...aTop);
      treatment.countWall();
    }
  }
  return area;
}

function appendRoadTriangle(vertices, sources, triangle, footprints, origin, union, treatment, exclusions) {
  const [a, b, c] = triangle;
  const determinant = turn(a, b, c);
  if (determinant >= -EPSILON) return 0;
  const plane = {
    dx: ((b.y - a.y) * (c.z - a.z) - (c.y - a.y) * (b.z - a.z)) / determinant,
    dz: ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / determinant
  };
  const bounds = boundsOf(triangle);
  const covered = [];
  let area = 0;

  for (const footprint of footprints) {
    if (!overlaps(bounds, footprint.bounds)) continue;
    const polygon = intersectFootprint(triangle, footprint);
    if (!hasArea(polygon)) continue;
    for (const source of footprint.sources) sources.set(source.linkIndex, source);
    if (!union && !treatment && !exclusions?.length) {
      area += appendTriangles(vertices, polygon, origin, plane);
      continue;
    }
    // 先从铺装裁掉同层车行面，再合并本功能自身重叠的路缘片。
    let visible = [polygon];
    for (const prior of treatment?.roadCuts ?? exclusions ?? covered) {
      if (!overlaps(footprint.bounds, prior.bounds)) continue;
      const remainder = [];
      for (const piece of visible) subtractFootprint(piece, prior, remainder);
      visible = remainder;
      if (visible.length === 0) break;
    }
    const surface = treatment && { ...treatment, riseAt: footprint.riseAt };
    for (const piece of visible) area += appendTriangles(vertices, piece, origin, plane, surface);
    if (union && visible.length) covered.push(footprint);
  }
  return area;
}

function clippedSurface(cells, terrainSurface, id, statistics, union = true, treatment = null, exclusions) {
  const chunks = [];

  for (const chunk of terrainSurface.chunks) {
    const [originX, originZ] = chunk.origin;
    const { indices, cellRanges } = chunk;
    // 用和实际地形网格相同的 Float32 输入；保留分块局部坐标以避免世界坐标量化。
    let positions;
    const vertices = [];
    const wallVertices = [];
    let wallSegments = 0;
    const roadRanges = [];
    const sources = new Map();
    for (let i = 0; i < cellRanges.length; i += 3) {
      const footprints = cells[cellRanges[i]];
      if (!footprints) continue;
      positions ??= new Float32Array(chunk.positions);
      const start = cellRanges[i + 1];
      const end = start + cellRanges[i + 2];
      const firstVertex = vertices.length;
      const cellTreatment = treatment && { wallVertices, hasWalkSurface: treatment.hasWalkSurface,
        countWall: () => wallSegments++,
        roadCuts: treatment.roadCells[cellRanges[i]] ?? [] };
      for (let index = start; index < end; index += 3) {
        const triangle = [];
        for (let j = 0; j < 3; j++) {
          const offset = indices[index + j] * 3;
          triangle.push({ x: positions[offset] + originX, y: positions[offset + 1], z: positions[offset + 2] + originZ });
        }
        statistics.areaM2 += appendRoadTriangle(vertices, sources, triangle, footprints, chunk.origin, union, cellTreatment, exclusions?.[cellRanges[i]]);
      }
      if (vertices.length > firstVertex) roadRanges.push(cellRanges[i], firstVertex, vertices.length);
    }
    if (vertices.length === 0) continue;
    chunks.push({ id: `${id}:${chunk.id}`, origin: chunk.origin, positions: new Float32Array(vertices),
      cellRanges: new Uint32Array(roadRanges),
      sources: [...sources.values()], heightSource: 'terrain',
      ...(wallVertices.length ? { wallPositions: new Float32Array(wallVertices), wallSegments } : {}) });
    statistics.triangles += vertices.length / 9;
  }
  return chunks;
}

export function createRoadSurfaceLayout(graph, terrainSurface) {
  if (!Array.isArray(graph?.links) || graph.links.length !== graph.metadata?.length
    || terrainSurface?.version !== 1 || !terrainSurface.grid) {
    throw new Error('Source road graph and rendered terrain surface are required');
  }
  const { cells, addFootprint } = footprintIndex(terrainSurface.grid);
  const sources = new Map();
  const groundLinks = visitGroundRoadFootprints(graph, (points, linkIndices) => {
    const roadSources = linkIndices.map(linkIndex => {
      if (!sources.has(linkIndex)) {
        const [, , name, width, lanes, direction] = graph.links[linkIndex];
        sources.set(linkIndex, { ...graph.metadata[linkIndex], linkIndex, name: graph.names[name], width, lanes, direction });
      }
      return sources.get(linkIndex);
    });
    addFootprint(points, roadSources);
  });
  const statistics = { sourceLinks: graph.links.length, groundLinks, unresolvedLinks: graph.links.length - groundLinks,
    renderedLinks: 0, linksWithoutSurface: 0, triangles: 0, areaM2: 0 };
  const chunks = clippedSurface(cells, terrainSurface, 'road-ground', statistics);
  const rendered = new Set();
  for (const chunk of chunks) for (const source of chunk.sources) rendered.add(source.linkIndex);
  statistics.renderedLinks = rendered.size;
  statistics.linksWithoutSurface = groundLinks - rendered.size;
  return { chunks, statistics };
}

function addFeatureFootprints(feature, index) {
  const { trianglesXZ, riseM, vertexRisesM } = feature;
  if (trianglesXZ.length % 6 !== 0 || (vertexRisesM && vertexRisesM.length !== trianglesXZ.length / 2)) {
    throw new Error('Attributed road polygons and rendered terrain surface are required');
  }
  const source = [{ linkIndex: 0, osmIds: feature.sourceIds }];
  for (let i = 0; i < trianglesXZ.length; i += 6) {
    const a = { x: trianglesXZ[i], z: trianglesXZ[i + 1] };
    const b = { x: trianglesXZ[i + 2], z: trianglesXZ[i + 3] };
    const c = { x: trianglesXZ[i + 4], z: trianglesXZ[i + 5] };
    const winding = turn(a, b, c);
    if (Math.abs(winding) <= EPSILON) continue;
    let riseAt;
    if (vertexRisesM) {
      const [y, bY, cY] = vertexRisesM.slice(i / 2, i / 2 + 3);
      const dx = ((bY - y) * (c.z - a.z) - (cY - y) * (b.z - a.z)) / winding;
      const dz = ((b.x - a.x) * (cY - y) - (c.x - a.x) * (bY - y)) / winding;
      riseAt = (x, z) => Math.max(0, y + dx * (x - a.x) + dz * (z - a.z));
    } else if (riseM && feature.clipToRoadComplement) {
      riseAt = () => riseM;
    }
    index.addFootprint(winding > 0 ? [a, b, c] : [a, c, b], source, riseAt);
  }
}

export function createRoadsideSurfaceTreatment(graph, grid, features) {
  const walk = footprintIndex(grid);
  const road = footprintIndex(grid);
  const points = features.flatMap(({ trianglesXZ }) => Array.from({ length: trianglesXZ.length / 2 }, (_, i) =>
    ({ x: trianglesXZ[i * 2], z: trianglesXZ[i * 2 + 1] })));
  const bounds = boundsOf(points);
  for (const feature of features) addFeatureFootprints(feature, walk);
  visitGroundRoadFootprints(graph, polygon => {
    if (overlaps(bounds, boundsOf(polygon))) road.addFootprint(polygon, []);
  }, index => {
    const metadata = graph.metadata[index];
    if (!metadata || !isGroundRoad(metadata)) return false;
    const link = graph.links[index];
    const { minX, minZ, maxX, maxZ } = boundsOf(roadSectionPoints(graph, link, metadata));
    const width = link[3];
    return overlaps(bounds, { minX: minX - width, minZ: minZ - width, maxX: maxX + width, maxZ: maxZ + width });
  });

  function hasWalkSurface(x, z) {
    const col = Math.floor((x - grid.x0) / grid.step), row = Math.floor((z - grid.z0) / grid.step);
    if (col < 0 || col >= grid.nx - 1 || row < 0 || row >= grid.nz - 1) return false;
    const cell = row * (grid.nx - 1) + col;
    const point = { x, z };
    const contains = footprint => footprint.edges.every(edge => edgeDistance(edge, point) >= 0);
    return !!walk.cells[cell]?.some(contains) && !road.cells[cell]?.some(contains);
  }
  return { roadCells: road.cells, hasWalkSurface };
}

export function createRoadPolygonLayout(feature, terrainSurface, treatment, exclusionChunks) {
  if (terrainSurface?.version !== 1 || !terrainSurface.grid) {
    throw new Error('Attributed road polygons and rendered terrain surface are required');
  }
  const index = footprintIndex(terrainSurface.grid);
  addFeatureFootprints(feature, index);
  const exclusions = footprintIndex(terrainSurface.grid);
  for (const { positions, origin, cellRanges } of exclusionChunks ?? []) {
    for (let i = 0; i < cellRanges.length; i += 3) {
      const [cell, start, end] = cellRanges.subarray(i, i + 3);
      if (!index.cells[cell]) continue;
      for (let j = start; j < end; j += 9) {
        const points = [j, j + 6, j + 3].map(k => ({ x: positions[k] + origin[0], z: positions[k + 2] + origin[1] }));
        if (turn(...points) > EPSILON) exclusions.addFootprint(points, []);
      }
    }
  }
  const statistics = { triangles: 0, areaM2: 0 };
  return { chunks: clippedSurface(index.cells, terrainSurface, feature.id, statistics, false, treatment, exclusions.cells), statistics };
}

function sampleRoadCell({ positions, origin }, start, end, worldX, worldZ) {
  const x = worldX - origin[0];
  const z = worldZ - origin[1];
  for (let i = start; i < end; i += 9) {
    const ax = positions[i], az = positions[i + 2];
    const bx = positions[i + 3] - ax, bz = positions[i + 5] - az;
    const cx = positions[i + 6] - ax, cz = positions[i + 8] - az;
    const det = bx * cz - bz * cx;
    const u = ((x - ax) * cz - (z - az) * cx) / det;
    const v = (bx * (z - az) - bz * (x - ax)) / det;
    const w = 1 - u - v;
    if (Math.min(u, v, w) >= -EPSILON) return w * positions[i + 1] + u * positions[i + 4] + v * positions[i + 7];
  }
  return null;
}

export function createRoadHeightSampler(chunks, grid) {
  const columns = grid.nx - 1;
  const rows = grid.nz - 1;
  const cells = new Array(columns * rows);
  for (const chunk of chunks) {
    const { cellRanges } = chunk;
    for (let i = 0; i < cellRanges.length; i += 3) cells[cellRanges[i]] = [chunk, cellRanges[i + 1], cellRanges[i + 2]];
  }

  // 交通可检查实际沥青三角面，陆地范围或宽度估计不能代替已绘制的路面。
  return (x, z) => {
    const fx = (x - grid.x0) / grid.step;
    const fz = (z - grid.z0) / grid.step;
    if (!Number.isFinite(fx) || !Number.isFinite(fz) || fx < 0 || fx > columns || fz < 0 || fz > rows) return null;
    const firstX = Math.max(0, Math.ceil(fx) - 1);
    const lastX = Math.min(columns - 1, Math.floor(fx));
    const firstZ = Math.max(0, Math.ceil(fz) - 1);
    const lastZ = Math.min(rows - 1, Math.floor(fz));
    for (let j = firstZ; j <= lastZ; j++) {
      for (let i = firstX; i <= lastX; i++) {
        const range = cells[j * columns + i];
        if (!range) continue;
        const height = sampleRoadCell(range[0], range[1], range[2], x, z);
        if (height !== null) return height;
      }
    }
    return null;
  };
}

export function buildSzRoads(scene, graph, terrainSurface, options = {}) {
  const layout = createRoadSurfaceLayout(graph, terrainSurface);
  const group = new THREE.Group();
  group.name = 'shenzhen-source-roads';
  // 深度偏移和共面绘制在材质工厂里；接触仍由真实地形三角面提供。
  const material = options.material ?? createSzRoadSurfaceMaterial();
  const entries = [];
  for (const chunk of layout.chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    entries.push({ geometry, x: chunk.origin[0], z: chunk.origin[1], id: chunk.id, sources: chunk.sources });
  }
  const meshes = [];
  // 步行道样板要按局部坐标做亚毫米共面校核，合并会把原点烘焙进 float32 顶点；这些场景继续按块建 mesh。
  const batches = options.batch === false
    ? entries.map(entry => ({ key: entry.id, chunks: [entry], geometry: entry.geometry, origin: [entry.x, entry.z] }))
    : batchChunks(entries);
  for (const batch of batches) {
    const mesh = new THREE.Mesh(batch.geometry, material);
    mesh.name = options.batch === false ? batch.key : `road-ground-batch:${batch.key}`;
    if (batch.origin) mesh.position.set(batch.origin[0], 0, batch.origin[1]);
    mesh.receiveShadow = true;
    mesh.userData.sourceRoads = batch.chunks.flatMap(entry => entry.sources ?? []);
    group.add(mesh);
    meshes.push(mesh);
    if (options.batch !== false) for (const entry of batch.chunks) entry.geometry.dispose();
  }
  scene.add(group);
  return { group, meshes, surfaces: layout.chunks, statistics: layout.statistics,
    roadHeight: createRoadHeightSampler(layout.chunks, terrainSurface.grid),
    dispose() {
      scene.remove(group);
      // 材质是模块级单例，跨场景复用，只销毁本次几何。
      for (const mesh of meshes) mesh.geometry.dispose();
    }
  };
}
