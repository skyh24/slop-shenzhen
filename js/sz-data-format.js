// 数据适配只解码和保留来源，不生成建筑轮廓或补造高程。
function requireData(condition, field) {
  if (!condition) throw new Error(`Invalid Shenzhen city data: ${field}`);
}

function validateSeaSurface(surface) {
  if (surface === undefined) return;
  const source = surface?.source;
  const validOsmId = id => typeof id === 'string' && /^(?:way|relation)\/\d+$/.test(id);
  requireData(surface?.version === 1 && surface.heightM === 0 && source?.verticalDatum === 'EGM2008'
    && source.heightMethod === 'copernicus-glo30-ocean-editing'
    && source.geometry === 'osm-coastline-directed-water-side' && source.osmSnapshotId === 'osm-guangdong'
    && Array.isArray(source.coastlineIds) && source.coastlineIds.length > 0 && source.coastlineIds.every(validOsmId)
    && Array.isArray(source.excludedWetlandIds) && source.excludedWetlandIds.every(validOsmId)
    && Array.isArray(surface.polygons) && surface.polygons.length > 0, 'sea surface and source');
}

function validateStreetscape(streetscape, parks) {
  if (streetscape === undefined) return;
  const source = streetscape?.source;
  const wayId = /^way\/\d+$/;
  const nodeId = /^node\/\d+$/;
  const park = parks.find(park => park.id === source?.parkId && park.osmId === source?.parkOsmId);
  const members = new Set(park?.areas.map(area => area.osmId));
  requireData(streetscape?.version === 1 && source?.osmSnapshotId === 'osm-guangdong'
    && members.has(source?.areaOsmId) && wayId.test(streetscape.arrivalWayId)
    && Array.isArray(streetscape.paths) && Array.isArray(streetscape.trees), 'streetscape source');
  for (const path of streetscape.paths) {
    requireData(wayId.test(path.osmId) && ['footway', 'cycleway'].includes(path.kind)
      && path.tags?.highway === path.kind && path.heightSource === 'terrain'
      && ['osm-width', 'visual-estimate'].includes(path.widthSource) && path.widthM > 0 && Number.isFinite(path.widthM)
      && Array.isArray(path.segments) && path.segments.length > 0, 'streetscape path');
    for (const { points, nodeIds } of path.segments) {
      requireData(Array.isArray(points) && points.length >= 2 && points.every(point => Array.isArray(point)
        && point.length === 2 && point.every(Number.isFinite)) && Array.isArray(nodeIds)
        && nodeIds.length === points.length && nodeIds.every(id => id === null || nodeId.test(id)), 'streetscape path coordinates');
    }
  }
  for (const tree of streetscape.trees) {
    requireData(nodeId.test(tree.osmId) && members.has(tree.areaOsmId) && tree.positionSource === 'osm-node'
      && tree.tags?.natural === 'tree' && tree.appearanceSource === 'visual-estimate'
      && Number.isFinite(tree.x) && Number.isFinite(tree.z), 'streetscape tree source');
  }
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

function validateBridges(bridges, landmarkIds) {
  if (bridges === undefined) return;
  requireData(Array.isArray(bridges), 'bridges');
  const positive = n => Number.isFinite(n) && n > 0;
  const laneCount = n => Number.isInteger(n) && n > 0;
  for (const bridge of bridges) {
    requireData(landmarkIds.has(bridge?.id) && Number.isSafeInteger(bridge.source?.osmRelationId)
      && bridge.source.verticalDatum === 'nominal-waterline-visual-reference'
      && Array.isArray(bridge.stations) && bridge.stations.length > 1
      && Array.isArray(bridge.spans) && bridge.spans.length > 0, 'bridge source');
    const oppositeStations = new Set();
    let previous = -Infinity;
    for (const p of bridge.stations) {
      requireData([p?.stationM, p?.x, p?.y, p?.z].every(Number.isFinite) && p.stationM > previous
        && laneCount(p.lanes), 'bridge station');
      previous = p.stationM;
      if (p.oppositeX === undefined && p.oppositeZ === undefined && p.oppositeLanes === undefined) continue;
      requireData(Number.isFinite(p.oppositeX) && Number.isFinite(p.oppositeZ) && laneCount(p.oppositeLanes), 'opposite bridge station');
      oppositeStations.add(p.stationM);
    }
    let lastSpanEnd = bridge.stations[0].stationM;
    for (const span of bridge.spans) {
      const tower = span?.tower;
      const supports = span?.supportStationsM;
      requireData(span?.startM >= lastSpanEnd && span.startM < span.endM
        && Array.isArray(supports) && supports[0] === span.startM && supports.at(-1) === span.endM
        && supports.every((s, i) => oppositeStations.has(s) && (i === 0 || s > supports[i - 1]))
        && supports.includes(tower?.stationM) && [tower.x, tower.y, tower.z, tower.capY, tower.topY, tower.lean].every(Number.isFinite)
        && tower.capY < tower.y && tower.y < tower.topY && Number.isSafeInteger(tower.osmNodeId)
        && [span.deckWidthM, span.girderDepthM, span.mainSpanM, span.backSpanM].every(positive)
        && [-1, 1].includes(span.mainDirection) && Number.isInteger(span.stayPairs) && span.stayPairs > 1, 'bridge span');
      lastSpanEnd = span.endM;
    }
    const a = bridge.approach, light = bridge.lighting;
    requireData([a?.deckWidthM, a?.girderDepthM, a?.typicalPierSpacingM, a?.pierWidthM, a?.pierDepthM,
      light?.designSpacingM ?? light?.estimatedSpacingM, light?.designHeightM].every(positive), 'bridge approach and lighting');
  }
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
  requireData(raw.parks === undefined || Array.isArray(raw.parks), 'parks');
  const landmarkIds = new Set(raw.landmarks.map(landmark => landmark.id));
  validateBridges(raw.bridges, landmarkIds);
  validateSeaSurface(raw.seaSurface);
  const isOsmId = id => typeof id === 'string' && /^(?:way|relation)\/\d+$/.test(id);
  for (const park of raw.parks ?? []) {
    requireData(landmarkIds.has(park?.id) && isOsmId(park.osmId)
      && park.source === `https://www.openstreetmap.org/${park.osmId}`
      && Array.isArray(park.areas) && park.areas.length > 0, 'park source');
    for (const area of park.areas) {
      requireData(isOsmId(area?.osmId) && Array.isArray(area.polygon) && area.polygon.length > 0
        && Array.isArray(area.arrivals) && area.arrivals.every(point => Array.isArray(point)
          && point.length === 2 && point.every(Number.isFinite)), 'park area and arrival samples');
    }
  }
  validateStreetscape(raw.streetscape, raw.parks ?? []);
  for (let i = 0; i < buildings.h.length; i++) {
    requireData(typeof buildings.id[i] === 'string' && buildings.id[i].length > 0, 'building identity');
    requireData(Number.isFinite(buildings.h[i]) && Number.isFinite(buildings.minH[i])
      && buildings.h[i] > buildings.minH[i] && buildings.minH[i] >= 0, 'building height');
    for (const [field, name] of [['src', 'heightSource'], ['facade', 'facade'], ['cat', 'category']]) {
      requireData(Number.isInteger(buildings[field][i]) && typeof raw.enums?.[name]?.[buildings[field][i]] === 'string', `building ${name}`);
    }
    requireData(Number.isInteger(buildings.lm[i]) && buildings.lm[i] >= -1 && buildings.lm[i] < raw.landmarks.length, 'building landmark');
  }
  // 名称与层数只影响显示，允许旧包缺失；出现时必须和建筑数组一一对应。
  if (raw.names !== undefined) {
    requireData(Array.isArray(raw.names) && raw.names.every(name => typeof name === 'string' && name.length > 0), 'building names');
  }
  for (const field of ['name', 'lv']) {
    if (buildings[field] === undefined) continue;
    requireData(Array.isArray(buildings[field]) && buildings[field].length === buildings.h.length, `buildings.${field}`);
  }
  if (buildings.name !== undefined) {
    for (const index of buildings.name) {
      requireData(Number.isInteger(index) && index >= -1
        && (index === -1 || (Array.isArray(raw.names) && index < raw.names.length)), 'building name index');
    }
  }
  if (buildings.lv !== undefined) {
    requireData(buildings.lv.every(level => Number.isInteger(level) && level >= -1), 'building levels');
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
  for (const [index, [a, b, name, width, lanes, direction, inner]] of graph.links.entries()) {
    requireData(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0
      && a < graph.nodeIds.length && b < graph.nodeIds.length && a !== b
      && Number.isInteger(name) && typeof graph.names[name] === 'string'
      && Number.isFinite(width) && width > 0 && Number.isInteger(lanes) && lanes >= 0
      && [-1, 0, 1].includes(direction) && Array.isArray(inner) && inner.length % 2 === 0
      && inner.every(Number.isFinite), 'road graph link');
    const road = graph.metadata[index];
    if (road?.crossSection !== undefined) {
      const section = road.crossSection;
      const stations = section?.points;
      requireData(section?.id === 'beihuan-xinzhou' && section.laneCountSource === 'municipal-design-and-relative-imagery'
        && road.heightSource === 'terrain' && !road.bridge && !road.tunnel && !road.layer
        && direction === 1 && lanes > 0 && Number.isFinite(section.laneWidthM) && section.laneWidthM > 0
        && Number.isFinite(section.outerShoulderM) && section.outerShoulderM >= 0
        && Math.abs(width - lanes * section.laneWidthM - section.outerShoulderM) < 1e-3
        && Array.isArray(stations) && stations.length >= 6 && stations.length % 3 === 0
        && stations.every((value, i) => Number.isFinite(value) && (i % 3 !== 2 || value > 0 && value < width))
        && stations[0] === graph.nodes[a * 2] && stations[1] === graph.nodes[a * 2 + 1]
        && stations.at(-3) === graph.nodes[b * 2] && stations.at(-2) === graph.nodes[b * 2 + 1], 'road graph cross section');
    }
  }
  if (graph.turnRestrictions !== undefined) {
    const { version, source, rules } = graph.turnRestrictions ?? {};
    const wayId = id => /^way\/\d+$/.test(id);
    const nodeIds = new Set(graph.nodeIds);
    requireData(version === 1 && source === 'osm-guangdong' && Array.isArray(rules) && rules.every(rule =>
      /^relation\/\d+$/.test(rule?.osmId) && /^(no|only)_\w+$/.test(rule.restriction)
      && /^node\/\d+$/.test(rule.viaNodeId) && nodeIds.has(rule.viaNodeId) && wayId(rule.fromWayId)
      && Array.isArray(rule.toWayIds) && rule.toWayIds.length > 0 && rule.toWayIds.every(wayId)
      && Array.isArray(rule.viaWayIds) && rule.viaWayIds.every(wayId)), 'road graph turn restrictions');
  }
  if (raw.roadFrontage !== undefined) {
    const frontage = raw.roadFrontage;
    requireData(frontage?.version === 1 && frontage.source?.osmSnapshotId === 'osm-guangdong'
      && Array.isArray(frontage.corridors) && Array.isArray(frontage.features) && Array.isArray(frontage.intersections), 'road frontage source');
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
      facade: raw.enums.facade[b.facade[i]], landmark: raw.landmarks[b.lm[i]]?.id ?? null,
      name: Array.isArray(b.name) && b.name[i] >= 0 ? (raw.names?.[b.name[i]] ?? null) : null,
      levels: Array.isArray(b.lv) ? b.lv[i] : -1 };
  });
  return { buildings, geo: { version: raw.version,
    frame: { origin: raw.origin, bearingDeg: 0, units: 'm' }, bounds: raw.bounds,
    coverage: raw.coverage.map(polygon), land: raw.land.map(polygon), water: raw.water.map(polygon),
    wetland: raw.wetland.map(polygon), green: raw.green.map(polygon),
    roadGraph: raw.roadGraph, terrain: raw.terrain, terrainSurface: raw.terrainSurface,
    roadFrontage: raw.roadFrontage ?? null,
    metro: raw.metro, landmarks: raw.landmarks,
    bridges: raw.bridges ?? [],
    seaSurface: raw.seaSurface && { ...raw.seaSurface, polygons: raw.seaSurface.polygons.map(polygon) },
    streetscape: raw.streetscape ?? null,
    parks: (raw.parks ?? []).map(park => ({ ...park, areas: park.areas.map(area => ({ ...area, polygon: polygon(area.polygon) })) }))
  } };
}
