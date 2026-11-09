import * as THREE from 'three/webgpu';

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

function convexHull(points) {
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

function indexRoadFootprints(graph, grid) {
  const columns = grid.nx - 1;
  const rows = grid.nz - 1;
  const cells = new Array(columns * rows);
  const junctions = new Map();
  let groundLinks = 0;

  function addFootprint(points, sources) {
    if (points.length < 3) return;
    const bounds = boundsOf(points);
    const edges = points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      return { x: a.x, z: a.z, nx: (a.z - b.z) / length, nz: (b.x - a.x) / length };
    });
    const footprint = { bounds, edges, sources };
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

  function addArm(node, crossSection, source) {
    if (!junctions.has(node)) junctions.set(node, { points: [], sources: [] });
    const junction = junctions.get(node);
    junction.points.push(...crossSection);
    junction.sources.push(source);
  }

  for (let index = 0; index < graph.links.length; index++) {
    const metadata = graph.metadata[index];
    if (!isGroundRoad(metadata)) continue;
    groundLinks++;
    const link = graph.links[index];
    const [start, end, name, width, lanes, direction] = link;
    const source = { ...metadata, linkIndex: index, name: graph.names[name], width, lanes, direction };
    const points = roadLinkPoints(graph, link);
    let previous = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const scale = width / (2 * Math.hypot(dx, dz));
      const ox = dz * scale;
      const oz = -dx * scale;
      const startSection = [{ x: a.x + ox, z: a.z + oz }, { x: a.x - ox, z: a.z - oz }];
      const endSection = [{ x: b.x + ox, z: b.z + oz }, { x: b.x - ox, z: b.z - oz }];
      addFootprint([startSection[0], endSection[0], endSection[1], startSection[1]], [source]);
      if (previous) {
        // 按外侧路缘补斜接，避免急弯处的直角切口和无界延长。
        const change = previous.dx * dz - previous.dz * dx;
        const side = change > 0 ? 0 : 1;
        const before = previous.endSection[side];
        const after = startSection[side];
        if (Math.abs(turn(a, before, after)) > EPSILON) {
          addFootprint(change > 0 ? [a, before, after] : [a, after, before], [source]);
        }
      } else {
        addArm(start, startSection, source);
      }
      if (i === points.length - 1) addArm(end, endSection, source);
      previous = { dx, dz, endSection };
    }
  }

  // 共用 OSM 节点的地面路段才能补接缝；单独端点和跨层道路保持各自边界。
  for (const { points, sources } of junctions.values()) {
    if (sources.length >= 2) addFootprint(convexHull(points), sources);
  }
  return { cells, groundLinks };
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

function appendTriangles(vertices, polygon, [originX, originZ], plane) {
  const local = polygon.map(p => {
    const x = Math.fround(p.x - originX);
    const z = Math.fround(p.z - originZ);
    const y = p.y + plane.dx * (x + originX - p.x) + plane.dz * (z + originZ - p.z);
    return { x, y, z };
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
  return area;
}

function appendRoadTriangle(vertices, sources, triangle, footprints, origin) {
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
    // 在每个地形三角面内做并集，交叉口和相邻弯道只有一层路面。
    let visible = [polygon];
    for (const prior of covered) {
      if (!overlaps(footprint.bounds, prior.bounds)) continue;
      const remainder = [];
      for (const piece of visible) subtractFootprint(piece, prior, remainder);
      visible = remainder;
      if (visible.length === 0) break;
    }
    for (const piece of visible) area += appendTriangles(vertices, piece, origin, plane);
    if (visible.length) covered.push(footprint);
  }
  return area;
}

export function createRoadSurfaceLayout(graph, terrainSurface) {
  if (!Array.isArray(graph?.links) || graph.links.length !== graph.metadata?.length
    || terrainSurface?.version !== 1 || !terrainSurface.grid) {
    throw new Error('Source road graph and rendered terrain surface are required');
  }
  const { cells, groundLinks } = indexRoadFootprints(graph, terrainSurface.grid);
  const chunks = [];
  const rendered = new Set();
  const statistics = { sourceLinks: graph.links.length, groundLinks, unresolvedLinks: graph.links.length - groundLinks,
    renderedLinks: 0, linksWithoutSurface: 0, triangles: 0, areaM2: 0 };

  for (const chunk of terrainSurface.chunks) {
    const [originX, originZ] = chunk.origin;
    const { indices, cellRanges } = chunk;
    // 用和实际地形网格相同的 Float32 输入；保留分块局部坐标以避免世界坐标量化。
    const positions = new Float32Array(chunk.positions);
    const vertices = [];
    const roadRanges = [];
    const sources = new Map();
    for (let i = 0; i < cellRanges.length; i += 3) {
      const footprints = cells[cellRanges[i]];
      if (!footprints) continue;
      const start = cellRanges[i + 1];
      const end = start + cellRanges[i + 2];
      const firstVertex = vertices.length;
      for (let index = start; index < end; index += 3) {
        const triangle = [];
        for (let j = 0; j < 3; j++) {
          const offset = indices[index + j] * 3;
          triangle.push({ x: positions[offset] + originX, y: positions[offset + 1], z: positions[offset + 2] + originZ });
        }
        statistics.areaM2 += appendRoadTriangle(vertices, sources, triangle, footprints, chunk.origin);
      }
      if (vertices.length > firstVertex) roadRanges.push(cellRanges[i], firstVertex, vertices.length);
    }
    if (vertices.length === 0) continue;
    chunks.push({ id: `road-ground:${chunk.id}`, origin: chunk.origin, positions: new Float32Array(vertices),
      cellRanges: new Uint32Array(roadRanges),
      sources: [...sources.values()], heightSource: 'terrain' });
    statistics.triangles += vertices.length / 9;
    for (const index of sources.keys()) rendered.add(index);
  }
  statistics.renderedLinks = rendered.size;
  statistics.linksWithoutSurface = groundLinks - rendered.size;
  return { chunks, statistics };
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
  // 深度偏移只处理共面绘制，接触仍由真实地形三角面提供。
  const material = options.material ?? new THREE.MeshStandardNodeMaterial({
    color: 0x51585a, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  });
  const meshes = [];
  for (const chunk of layout.chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.origin[0], 0, chunk.origin[1]);
    mesh.name = chunk.id;
    mesh.receiveShadow = true;
    mesh.userData.sourceRoads = chunk.sources;
    group.add(mesh);
    meshes.push(mesh);
  }
  scene.add(group);
  return { group, meshes, surfaces: layout.chunks, statistics: layout.statistics,
    roadHeight: createRoadHeightSampler(layout.chunks, terrainSurface.grid),
    dispose() {
      scene.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      if (!options.material) material.dispose();
    }
  };
}
