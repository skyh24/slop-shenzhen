// 数据适配只解码和保留来源，不生成建筑轮廓或补造高程。
function requireData(condition, field) {
  if (!condition) throw new Error(`Invalid Shenzhen city data: ${field}`);
}

export function decodeRing(flat) {
  requireData(Array.isArray(flat) && flat.length >= 4 && flat.length % 2 === 0, 'coordinate sequence');
  const out = new Float64Array(flat.length);
  let x = 0;
  let z = 0;
  for (let i = 0; i < flat.length; i += 2) {
    requireData(Number.isSafeInteger(flat[i]) && Number.isSafeInteger(flat[i + 1]), 'coordinate delta');
    x += flat[i];
    z += flat[i + 1];
    out[i] = x / 10;
    out[i + 1] = z / 10;
  }
  return out;
}

export function decodePoly(rings) {
  requireData(Array.isArray(rings) && rings.length > 0, 'polygon rings');
  return rings.map(ring => {
    requireData(ring.length >= 6, 'polygon vertices');
    return decodeRing(ring);
  });
}

function polygon(rings) {
  const points = decodePoly(rings).map(flat => {
    const ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push({ x: flat[i], z: flat[i + 1] });
    return ring;
  });
  return { outer: points[0], holes: points.slice(1) };
}

export async function readCityPayload(url, fetcher = fetch) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`City data request failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = compressed
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw = JSON.parse(text);
  validateCityPayload(raw);
  return raw;
}

export function validateCityPayload(raw) {
  requireData(raw?.version === 2, 'version');
  requireData(raw.origin?.[0] === 114.0545 && raw.origin?.[1] === 22.5463, 'origin');
  requireData(raw.bounds?.length === 4 && raw.bounds.every(Number.isFinite)
    && raw.bounds[0] < raw.bounds[2] && raw.bounds[1] < raw.bounds[3], 'bounds');
  const buildings = raw.buildings;
  requireData(Array.isArray(buildings?.h), 'buildings');
  for (const key of ['id', 'rings', 'minH', 'cat', 'facade', 'src', 'lm']) {
    requireData(Array.isArray(buildings[key]) && buildings[key].length === buildings.h.length, `buildings.${key}`);
  }
  requireData(Array.isArray(raw.landmarks), 'landmarks');
  for (let i = 0; i < buildings.h.length; i++) {
    requireData(typeof buildings.id[i] === 'string' && buildings.id[i].length > 0, 'building identity');
    requireData(Number.isFinite(buildings.h[i]) && Number.isFinite(buildings.minH[i])
      && buildings.h[i] > buildings.minH[i] && buildings.minH[i] >= 0, 'building height');
    for (const [field, name] of [['src', 'heightSource'], ['facade', 'facade'], ['cat', 'category']]) {
      requireData(Number.isInteger(buildings[field][i]) && typeof raw.enums?.[name]?.[buildings[field][i]] === 'string', `building ${name}`);
    }
    requireData(Number.isInteger(buildings.lm[i]) && buildings.lm[i] >= -1 && buildings.lm[i] < raw.landmarks.length, 'building landmark');
  }
  for (const field of ['coverage', 'land', 'water', 'wetland', 'green']) requireData(Array.isArray(raw[field]), field);
  const grid = raw.terrain;
  requireData(grid && Number.isInteger(grid.nx) && Number.isInteger(grid.nz) && grid.nx >= 2 && grid.nz >= 2
    && Number.isFinite(grid.step) && grid.step > 0 && Number.isFinite(grid.x0) && Number.isFinite(grid.z0)
    && grid.heightScale === 0.1 && grid.diagonal === 'ne-sw'
    && grid.heights?.length === grid.nx * grid.nz && grid.heights.every(Number.isSafeInteger), 'terrain grid');
  const graph = raw.roadGraph;
  requireData(graph && Array.isArray(graph.nodes) && graph.nodes.length % 2 === 0
    && graph.nodes.every(Number.isFinite) && graph.nodeIds?.length === graph.nodes.length / 2
    && Array.isArray(graph.links) && graph.metadata?.length === graph.links.length && Array.isArray(graph.names), 'road graph');
  for (const [a, b, name, width, lanes, direction, inner] of graph.links) {
    requireData(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0
      && a < graph.nodeIds.length && b < graph.nodeIds.length && a !== b
      && Number.isInteger(name) && typeof graph.names[name] === 'string'
      && Number.isFinite(width) && width > 0 && Number.isInteger(lanes) && lanes >= 0
      && [-1, 0, 1].includes(direction) && Array.isArray(inner) && inner.length % 2 === 0
      && inner.every(Number.isFinite), 'road graph link');
  }
  return raw;
}

export function decodeCityPayload(raw) {
  validateCityPayload(raw);
  const b = raw.buildings;
  const buildings = b.h.map((height, i) => {
    const shape = polygon(b.rings[i]);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of shape.outer) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    return { id: b.id[i], height, minHeight: b.minH[i], year: 0, polygons: [shape],
      minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
      heightSource: raw.enums.heightSource[b.src[i]], category: raw.enums.category[b.cat[i]],
      facade: raw.enums.facade[b.facade[i]], landmark: raw.landmarks[b.lm[i]]?.id ?? null };
  });
  return { buildings, geo: { version: raw.version,
    frame: { origin: raw.origin, bearingDeg: 0, units: 'm' }, bounds: raw.bounds,
    coverage: raw.coverage.map(polygon), land: raw.land.map(polygon), water: raw.water.map(polygon),
    wetland: raw.wetland.map(polygon), green: raw.green.map(polygon),
    roadGraph: raw.roadGraph, terrain: raw.terrain, landmarks: raw.landmarks } };
}
