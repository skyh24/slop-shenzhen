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

function validateTalentPark(site, raw) {
  if (site === undefined) return;
  const pair = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const line = points => Array.isArray(points) && points.length > 1 && points.every(pair);
  const data = site?.simulation;
  requireData(site?.version === 1 && raw.parks?.some(p => p.id === 'talent-park' && p.osmId === site.parkOsmId)
    && /^relation\/\d+$/.test(site.lakeOsmId) && Number.isInteger(site.lakeWaterIndex)
    && !!raw.water[site.lakeWaterIndex] && pair(site.view) && Number.isInteger(site.viewNode)
    && site.lengthM >= 300 && site.lengthM <= 500 && line(site.retainingEdge)
    && ['x', 'y', 'z'].every(key => Number.isFinite(data?.airspaceCenter?.[key]))
    && Number.isFinite(data.lakeHeightM) && data.lakeHeightSource === 'estimate', 'Talent Park waterfront source');
  const paths = [...site.route, ...site.entrances];
  requireData(paths.every(path => /^way\/\d+$/.test(path.osmId) && line(path.points)
    && ['greenway', 'promenade', 'steps'].includes(path.kind) && Number.isFinite(path.widthM)
    && path.widthM >= 1.5 && path.widthM <= 6 && path.nodeIds?.length === path.points.length
    && path.nodeIds.every(Number.isSafeInteger)) && site.entrances.filter(path => path.kind === 'steps').length === 1
    && site.route.some(path => path.nodeIds.includes(site.viewNode)), 'Talent Park paths and access');
  requireData(site.surfaces?.some(row => row.material === 'gravel') && site.surfaces.every(row =>
    ['greenway', 'promenade', 'gravel'].includes(row.material) && row.trianglesXZ?.length >= 6
    && row.trianglesXZ.length % 6 === 0 && row.trianglesXZ.every(Number.isFinite)), 'Talent Park paving');
  if (site.footbridges === undefined && site.bridgeRoutes === undefined) return;
  const ids = new Set();
  requireData(Array.isArray(site.footbridges) && site.footbridges.every(b => {
    if (!/^way\/\d+$/.test(b.id) || ids.has(b.id) || b.waterIndex !== site.lakeWaterIndex
      || b.waterHeightM !== data.lakeHeightM || b.mode !== 'walk' || b.profile !== 'park-footbridge-estimate'
      || !Number.isFinite(b.widthM) || b.widthM < 1.5 || b.widthM > 6
      || !Number.isFinite(b.girderDepthM) || b.girderDepthM <= 0 || !Array.isArray(b.points) || b.points.length < 2
      || !b.points.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return false;
    ids.add(b.id);
    return true;
  }), 'Talent Park footbridges');
  requireData(Array.isArray(site.bridgeRoutes) && site.bridgeRoutes.every(r => typeof r.id === 'string'
    && Array.isArray(r.paths) && r.paths.some(p => p.kind === 'bridge') && r.paths.every((p, i) =>
      line(p.points) && Number.isFinite(p.widthM) && p.widthM > 0
      && (p.kind === 'promenade' || (p.kind === 'bridge' && ids.has(p.osmId)))
      && (i === 0 || r.paths[i - 1].to === p.from))), 'Talent Park bridge routes');
}

function validateGolfCourse(site, graph, buildings) {
  if (site === undefined) return;
  const wayId = /^way\/\d+$/;
  const materials = ['paved', 'aggregate'];
  const coordinates = (values, multiple) => Array.isArray(values) && values.length >= multiple
    && values.length % multiple === 0 && values.every(Number.isFinite);
  requireData(site?.version === 1 && site.osmId === 'way/173622150' && site.publicAccess === 'unverified'
    && ['paths', 'surfaces', 'ponds', 'foundations'].every(key => Array.isArray(site[key])), 'golf course source');
  const paths = new Map();
  for (const path of site.paths) {
    requireData(wayId.test(path.osmId) && !paths.has(path.osmId) && path.kind === 'garden-path'
      && Number.isFinite(path.widthM) && path.widthM > 0 && materials.includes(path.material)
      && ['terrain', 'unresolved-structure'].includes(path.heightSource)
      && ['unverified', 'restricted'].includes(path.publicAccess) && typeof path.serviceAccess === 'string'
      && Array.isArray(path.segments) && path.segments.every(line => line.length >= 4 && coordinates(line, 2)), 'golf course path');
    paths.set(path.osmId, path);
  }
  requireData(graph.metadata.every(meta => !paths.has(meta.osmId)), 'golf course paths excluded from car network');
  for (const surface of site.surfaces) {
    requireData(materials.includes(surface.material) && coordinates(surface.trianglesXZ, 6)
      && Array.isArray(surface.sourceIds) && surface.sourceIds.length > 0 && surface.sourceIds.every(id => {
        const path = paths.get(id);
        return path?.heightSource === 'terrain' && path.material === surface.material;
      }), 'golf course paving');
  }
  for (const pond of site.ponds) {
    requireData(wayId.test(pond.osmId) && Number.isFinite(pond.heightM)
      && pond.heightSource === 'fabdem-pond-centre-visual-estimate' && Array.isArray(pond.banks)
      && pond.banks.every(ring => ring.length >= 9 && coordinates(ring, 3)
        && ring.every((value, i) => i % 3 !== 1 || value >= pond.heightM)), 'golf course pond level');
    decodePoly(pond.rings);
  }
  const ids = new Set(buildings.id);
  const foundationIds = new Set();
  for (const { id, baseY, bottomY } of site.foundations) {
    requireData(ids.has(id) && !foundationIds.has(id) && Number.isFinite(baseY) && Number.isFinite(bottomY)
      && baseY > bottomY, 'golf course foundation');
    foundationIds.add(id);
  }
}

function validateIecPaths(paths) {
  if (paths === undefined) return;
  requireData(Array.isArray(paths), 'IEC paths');
  const ids = new Set();
  for (const path of paths) {
    requireData(/^way\/\d+$/.test(path.osmId) && !ids.has(path.osmId)
      && ['public-roadside', 'unverified'].includes(path.access)
      && path.heightSource === 'terrain' && ['osm-width', 'visual-estimate'].includes(path.widthSource)
      && Number.isFinite(path.widthM) && path.widthM > 0
      && Array.isArray(path.points) && path.points.length >= 2
      && path.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
      && Array.isArray(path.nodeIds) && path.nodeIds.length === path.points.length
      && path.nodeIds.every(id => /^node\/\d+$/.test(id)), 'IEC path');
    ids.add(path.osmId);
  }
}

function validateShenzhenBay(site, parks, sea) {
  if (site === undefined) return;
  const wayId = /^way\/\d+$/;
  const points = (rows, dimensions) => Array.isArray(rows) && rows.length >= 2
    && rows.every(row => Array.isArray(row) && row.length === dimensions && row.every(Number.isFinite));
  const park = parks.find(park => park.id === 'shenzhen-bay-park');
  requireData(site?.version === 1 && park?.areas.some(area => area.osmId === site.areaOsmId)
    && site.seaHeightM === sea?.heightM && /^node\/\d+$/.test(site.arrivalReference)
    && points(site.walkRoute, 3) && Number.isSafeInteger(site.viewNode)
    && Number.isFinite(site.estimates?.rockSlopeRunM) && site.estimates.rockSlopeRunM > 0
    && Array.isArray(site.paths) && site.paths.length && Array.isArray(site.shore) && site.shore.length, 'Shenzhen Bay source');
  requireData(site.paths.every(path => wayId.test(path.osmId) && ['walk', 'cycle'].includes(path.mode)
    && points(path.points, 2) && Array.isArray(path.nodes) && path.nodes.length === path.points.length
    && path.nodes.every(Number.isSafeInteger) && Number.isFinite(path.widthM) && path.widthM > 0)
    && site.paths.some(path => path.mode === 'walk' && path.nodes.includes(site.viewNode)), 'Shenzhen Bay paths');
  requireData(site.shore.every(shore => wayId.test(shore.id) && points(shore.stations, 3)
    && ['rock-slope', 'retaining-edge'].includes(shore.profile)), 'Shenzhen Bay shore');
}

function validateWaterfront(site, raw) {
  if (site === undefined) return;
  const way = /^way\/\d+$/;
  const xyz = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  const polyline = p => Array.isArray(p) && p.length > 1 && p.every(xyz);
  const waterIndex = i => Number.isSafeInteger(i) && !!raw.water[i];
  const positive = v => Number.isFinite(v) && v > 0;
  const mode = v => v === 'walk' || v === 'shared';
  requireData(site?.version === 1 && Array.isArray(site.waters) && site.waters.length === 2
    && site.waters.every(w => way.test(w.id) && waterIndex(w.waterIndex) && Number.isFinite(w.heightM)
      && w.heightSource === 'estimate'), 'waterfront water sources');
  requireData(Array.isArray(site.roadBridges) && site.roadBridges.every(b => way.test(b.osmId)
    && Number.isFinite(b.heightM) && positive(b.girderDepthM) && waterIndex(b.waterIndex)
    && Number.isFinite(b.waterHeightM) && Array.isArray(b.edges) && b.edges.length > 0
    && b.edges.every(i => Number.isSafeInteger(i) && raw.roadGraph.metadata[i]?.osmId === b.osmId
      && raw.roadGraph.metadata[i].bridge && !raw.roadGraph.metadata[i].tunnel)
    && b.portals?.length === b.edges.length && b.portals.every((p, i) => p.edge === b.edges[i]
      && p.heightsM?.length === 2 && p.heightsM.every(Number.isFinite))), 'waterfront road bridges');
  requireData(Array.isArray(site.footbridges) && site.footbridges.every(b => way.test(b.id) && polyline(b.points)
    && positive(b.widthM) && positive(b.girderDepthM) && waterIndex(b.waterIndex) && Number.isFinite(b.waterHeightM)
    && mode(b.mode)), 'waterfront slow bridges');
  requireData(Array.isArray(site.routes) && site.routes.every(r => typeof r.id === 'string' && mode(r.mode)
    && polyline(r.points) && Array.isArray(r.paths) && r.paths.every(p => way.test(p.osmId) && mode(p.mode)
      && positive(p.widthM) && p.points?.length >= 2 && p.points.every(xz => xz.length === 2 && xz.every(Number.isFinite)))),
  'waterfront routes');
  requireData(Array.isArray(site.rails) && site.rails.every(r => typeof r.id === 'string'
    && Array.isArray(r.stations) && r.stations.every(p => p === null || xyz(p)))
    && polyline(site.bayLower?.points), 'waterfront banks');
  if (site.extensions === undefined && site.extensionWaters === undefined) return;
  requireData(Array.isArray(site.extensions) && site.extensions.every(r => typeof r.id === 'string'
    && typeof r.waterId === 'string' && polyline(r.points) && positive(r.lengthM)
    && Array.isArray(r.paths) && r.paths.length > 0 && r.paths.every(p => way.test(p.osmId)
      && (mode(p.mode) || p.mode === 'cycle') && positive(p.widthM) && p.heightSource === 'terrain-derived-estimate'
      && p.points?.length >= 2 && p.points.every(xz => xz.length === 2 && xz.every(Number.isFinite)))), 'waterfront extensions');
  requireData(Array.isArray(site.extensionWaters) && site.extensionWaters.every(w => way.test(w.id)
    && waterIndex(w.waterIndex) && Number.isFinite(w.heightM) && w.heightSource === 'estimate'), 'waterfront extension waters');
}

function validateTrees(trees) {
  if (trees === undefined) return;
  requireData(trees?.version === 1 && Number.isSafeInteger(trees.count) && trees.count >= 0, 'trees header');
  for (const key of ['x', 'z', 'height', 'crown', 'species', 'source', 'appearance']) {
    requireData(Array.isArray(trees[key]) && trees[key].length === trees.count, `trees.${key}`);
  }
  const integers = (values, min) => values.every(value => Number.isSafeInteger(value) && value >= min);
  requireData(integers(trees.x, -10000000) && integers(trees.z, -10000000) && integers(trees.height, 0)
    && integers(trees.crown, 0) && integers(trees.species, 0) && integers(trees.source, 0)
    && integers(trees.appearance, 0), 'trees values');
  const { speciesNames, sources, appearanceSources } = trees;
  requireData(Array.isArray(speciesNames) && speciesNames.length > 0
    && speciesNames.every(name => typeof name === 'string' && name.length > 0), 'trees species names');
  requireData(Array.isArray(sources) && sources.length > 0 && sources.every(name => ['osm-node', 'osm-row', 'simulated-street', 'simulated-park'].includes(name)), 'trees sources');
  requireData(Array.isArray(appearanceSources) && appearanceSources.length > 0
    && appearanceSources.every(name => ['osm-tags', 'species-estimate'].includes(name)), 'trees appearance sources');
  requireData(trees.species.every(index => index < speciesNames.length)
    && trees.source.every(index => index < sources.length)
    && trees.appearance.every(index => index < appearanceSources.length), 'trees enum ranges');
  const osmIndices = new Set();
  requireData(Array.isArray(trees.osm) && trees.osm.every(entry => {
    const valid = Array.isArray(entry) && Number.isSafeInteger(entry[0]) && entry[0] >= 0 && entry[0] < trees.count
      && /^(?:node|way)\/\d+$/.test(entry[1]) && trees.source[entry[0]] <= 1 && !osmIndices.has(entry[0]);
    if (valid) osmIndices.add(entry[0]);
    return valid;
  }), 'trees osm identities');
  requireData(trees.limitations === undefined || Array.isArray(trees.limitations), 'trees limitations');
}

function validateAir(air) {
  if (air === undefined) return;
  requireData(air?.version >= 3 && typeof air.verifiedAt === 'string'
    && ['source-endpoints-schematic-tracks', 'no-operational-track-verified'].includes(air.status), 'air routes header');
  const stations = defs => {
    requireData(Array.isArray(defs) && defs.length > 0, 'air drone stations');
    const ids = new Set();
    for (const station of defs) {
      requireData(typeof station?.id === 'string' && station.id.length > 0 && !ids.has(station.id)
        && typeof station.name === 'string' && station.name.length > 0
        && typeof station.operator === 'string' && Number.isFinite(station.x) && Number.isFinite(station.z)
        && typeof station.coordinateSource === 'string'
        && Array.isArray(station.sourceUrls) && station.sourceUrls.length > 0
        && station.sourceUrls.every(url => /^https?:\/\//.test(url))
        && typeof station.verifiedAt === 'string', 'air drone station');
      ids.add(station.id);
    }
    return ids;
  };
  const stationIds = stations(air.droneStations);
  requireData(Array.isArray(air.droneRoutes) && air.droneRoutes.length > 0, 'air drone routes');
  for (const route of air.droneRoutes) {
    requireData(typeof route?.id === 'string' && typeof route.name === 'string'
      && stationIds.has(route.fromStationId) && stationIds.has(route.toStationId)
      && Number.isFinite(route.lengthM) && route.lengthM > 0
      && route.trackStatus === 'schematic'
      && Number.isFinite(route.altitudeM) && route.altitudeM > 0 && route.altitudeSource === 'estimate'
      && Array.isArray(route.sourceUrls) && route.sourceUrls.length > 0
      && typeof route.verifiedAt === 'string', 'air drone route');
  }
  const suspension = air.apecSuspension;
  requireData(suspension && Array.isArray(suspension.windows) && suspension.windows.length > 0
    && suspension.windows.every(window => typeof window.from === 'string' && typeof window.to === 'string'
      && window.from <= window.to && typeof window.sourceUrl === 'string'), 'air APEC suspension');
}

function validateNorthRail(data) {
  if (data === undefined) return;
  const xy = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const wayId = id => typeof id === 'string' && /^way\/\d+$/.test(id);
  requireData(data?.version === 1 && data.source === 'osm-guangdong' && data.heightSource === 'estimate'
    && wayId(data.stationId) && xy(data.center) && xy(data.axis)
    && Math.abs(Math.hypot(...data.axis) - 1) < 1e-4
    && data.published?.tracks === 20 && data.published?.platforms === 11
    && [data.published.roofHeightM, data.published.roofSpanEastWestM, data.published.roofSpanNorthSouthM].every(n => Number.isFinite(n) && n > 0)
    && Array.isArray(data.nodes) && Array.isArray(data.ways) && Array.isArray(data.edges)
    && Array.isArray(data.routes) && data.routes.length === data.published.tracks, 'Shenzhen North rail header');
  const { nodes, ways, edges, routes } = data;
  requireData(nodes.every(node => Array.isArray(node) && node.length === 3 && /^\d+$/.test(node[0]) && xy(node.slice(1)))
    && new Set(nodes.map(node => node[0])).size === nodes.length, 'Shenzhen North rail nodes');
  requireData(ways.every(way => way && wayId(way.id) && typeof way.bridge === 'boolean' && Number.isInteger(way.layer))
    && new Set(ways.map(way => way.id)).size === ways.length, 'Shenzhen North rail ways');
  const index = (value, length) => Number.isInteger(value) && value >= 0 && value < length;
  requireData(edges.every(e => Array.isArray(e) && e.length === 3 && e[0] !== e[1]
    && index(e[0], nodes.length) && index(e[1], nodes.length) && index(e[2], ways.length)), 'Shenzhen North rail edges');
  const berths = new Set();
  for (const route of routes) {
    requireData(route && index(route.berth - 1, routes.length) && !berths.has(route.berth)
      && [-1, 1].includes(route.direction) && Array.isArray(route.edges) && route.edges.length > 1,
    'Shenzhen North rail route');
    berths.add(route.berth);
    let previous = null;
    for (const ref of route.edges) {
      requireData(Number.isInteger(ref) && ref !== 0 && index(Math.abs(ref) - 1, edges.length), 'Shenzhen North rail route edge');
      const [a, b] = edges[Math.abs(ref) - 1];
      const from = ref > 0 ? a : b, to = ref > 0 ? b : a;
      requireData(previous === null || previous === from, 'Shenzhen North disconnected rail route');
      previous = to;
    }
  }
  for (const side of ['west', 'east']) {
    const plaza = data.plazas?.[side];
    requireData(plaza && wayId(plaza.id) && Array.isArray(plaza.rings) && plaza.rings.length
      && plaza.rings.every(r => Array.isArray(r) && r.length >= 6 && r.length % 2 === 0
        && r.every(Number.isSafeInteger)), 'Shenzhen North plaza');
  }
  for (const role of ['northConcourse', 'southOverpass', 'eastWalk', 'eastWalkSouth', 'westRamp', 'eastRamp']) {
    const walk = data.walks?.[role];
    requireData(walk && wayId(walk.id) && Array.isArray(walk.points) && walk.points.length >= 2
      && walk.points.every(xy), 'Shenzhen North footway');
  }
}

function validateSites(sites) {
  if (sites === undefined) return;
  requireData(sites?.version === 1 && sites.source === 'osm-guangdong'
    && sites.sites && typeof sites.sites === 'object' && !Array.isArray(sites.sites), 'landmark sites header');
  for (const [landmarkId, roles] of Object.entries(sites.sites)) {
    requireData(typeof landmarkId === 'string' && landmarkId.length > 0
      && roles && typeof roles === 'object' && !Array.isArray(roles), 'landmark site record');
    for (const [role, site] of Object.entries(roles)) {
      requireData(typeof role === 'string' && role.length > 0
        && typeof site?.osmId === 'string' && /^(?:way|relation)\/\d+$/.test(site.osmId)
        && Array.isArray(site.polygons) && site.polygons.length > 0, 'landmark site polygon source');
      for (const rings of site.polygons) {
        requireData(Array.isArray(rings) && rings.length > 0 && rings.every(ring =>
          Array.isArray(ring) && ring.length >= 6 && ring.length % 2 === 0
          && ring.every(value => Number.isSafeInteger(value))), 'landmark site rings');
      }
    }
  }
}

export function decodeSites(sites) {
  if (sites === undefined) return null;
  const decoded = {};
  for (const [landmarkId, roles] of Object.entries(sites.sites)) {
    decoded[landmarkId] = {};
    for (const [role, site] of Object.entries(roles)) {
      decoded[landmarkId][role] = {
        osmId: site.osmId,
        polygons: site.polygons.map(rings => {
          const decodedRings = rings.map(ring => {
            const out = [];
            let x = 0, z = 0;
            for (let i = 0; i < ring.length; i += 2) {
              x += ring[i]; z += ring[i + 1];
              out.push({ x: x / 10, z: z / 10 });
            }
            return out;
          });
          return { outer: decodedRings[0], holes: decodedRings.slice(1) };
        })
      };
    }
  }
  return decoded;
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

export function decodeMapRegion({ rings, ...region }) {
  const { osmId, roadOsmIds } = region.source ?? {};
  return { ...region, kind: 'region', sourceIds: osmId ? [osmId] : (roadOsmIds ?? []), polygons: rings.map(polygon) };
}

function validateIds(ids, field) {
  const seen = new Set();
  for (const id of ids) {
    requireData(typeof id === 'string' && id.length > 0 && !seen.has(id), `${field}: ${id}`);
    seen.add(id);
  }
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

function validateYanjiang(expressway) {
  if (expressway === undefined) return;
  requireData(expressway?.source?.osmRelationId === 6371344 && expressway.source.heightSource === 'estimate'
    && Number.isFinite(expressway.pierSpacingM) && expressway.pierSpacingM > 0
    && Array.isArray(expressway.segments) && expressway.segments.length > 0, 'Yanjiang source');
  for (const segment of expressway.segments) {
    const { osmWayId, widthM, stations } = segment ?? {};
    requireData(Number.isSafeInteger(osmWayId) && Number.isFinite(widthM) && widthM > 0
      && Array.isArray(stations) && stations.length >= 2, 'Yanjiang bridge segment');
    let previous = -Infinity;
    for (const p of stations) {
      requireData([p?.x, p?.y, p?.z, p?.stationM].every(Number.isFinite) && p.stationM > previous
        && Number.isInteger(p.lanes) && p.lanes > 0, 'Yanjiang bridge station');
      previous = p.stationM;
    }
  }
}

// 加载失败要按阶段区分给启动兜底入口：request 下载、decompress 解压或 UTF-8 解码、invalid 解析或校验。
export class CityDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CityDataError';
    this.code = code;
  }
}

function cityDataError(code, message, cause) {
  const error = new CityDataError(code, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

// 计时只用于启动日志；Node 的 vm 沙箱里可能没有 performance，退回 Date.now()。
function nowMs() {
  return typeof performance === 'object' && typeof performance?.now === 'function' ? performance.now() : Date.now();
}

// SZC1 保留数值精度。地形消费者原本支持 TypedArray，直接使用视图；其余字段恢复普通数组。
export async function decodeFastCity(input) {
  const bytes = input.byteOffset % 8 === 0 ? input : new Uint8Array(input);
  requireData(bytes.byteLength >= 48 && bytes.byteLength <= 256 * 1024 * 1024, 'SZC1 length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireData(view.getUint32(0, true) === 0x31435a53 && view.getUint32(4, true) === 1, 'SZC1 version');
  const metadataLength = view.getUint32(8, true);
  const binaryLength = view.getUint32(12, true);
  const binaryOffset = 48 + Math.ceil(metadataLength / 8) * 8;
  requireData(metadataLength > 0 && binaryOffset + binaryLength === bytes.length, 'SZC1 sections');
  const checked = new Uint8Array(bytes.length - 32);
  checked.set(bytes.subarray(0, 16));
  checked.set(bytes.subarray(48), 16);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', checked));
  requireData(digest.every((value, i) => value === bytes[16 + i]), 'SZC1 checksum');
  const { payload, columns } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(48, 48 + metadataLength)));
  requireData(payload && Array.isArray(columns) && columns.length <= 100000, 'SZC1 metadata');
  const types = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f64: Float64Array };
  requireData(new Uint8Array(new Uint16Array([1]).buffer)[0] === 1, 'SZC1 little endian platform');
  let offset = 0;
  for (const column of columns) {
    const Type = Object.hasOwn(types, column.type) ? types[column.type] : null;
    requireData(Type && Number.isSafeInteger(column.count) && column.count > 0
      && column.offset === offset && column.bytes === column.count * Type.BYTES_PER_ELEMENT
      && column.offset + column.bytes <= binaryLength, 'SZC1 column bounds');
    requireData(Array.isArray(column.path) && column.path.length > 0 && column.path.length <= 32, 'SZC1 column path');
    let target = payload;
    for (let i = 0; i < column.path.length; i++) {
      const key = column.path[i];
      requireData((typeof key === 'string' || (Number.isSafeInteger(key) && key >= 0))
        && !['__proto__', 'constructor', 'prototype'].includes(key)
        && target !== null && typeof target === 'object' && Object.hasOwn(target, key), 'SZC1 column target');
      if (i === column.path.length - 1) {
        requireData(target[key] === null, 'SZC1 column placeholder');
        const values = new Type(bytes.buffer, bytes.byteOffset + binaryOffset + offset, column.count);
        const terrainColumn = (column.path.length === 4 && column.path[0] === 'terrainSurface'
          && column.path[1] === 'chunks' && Number.isInteger(column.path[2])
          && ['positions', 'indices', 'cellRanges', 'kinds'].includes(key))
          || (column.path.length === 2 && column.path[0] === 'terrain' && key === 'heights');
        if (terrainColumn) {
          requireData(values.every(Number.isFinite), 'SZC1 finite column');
          target[key] = values;
          continue;
        }
        // 顺序复制比 Array.from 的迭代器路径快，同时保留现有 Array 接口。
        const restored = new Array(values.length);
        for (let j = 0; j < values.length; j++) {
          requireData(Number.isFinite(values[j]), 'SZC1 finite column');
          restored[j] = values[j];
        }
        target[key] = restored;
      } else {
        target = target[key];
      }
    }
    offset += Math.ceil(column.bytes / 8) * 8;
  }
  requireData(offset === binaryLength, 'SZC1 trailing bytes');
  return payload;
}

// 下载和解压后按魔数解析 JSON 或 SZC1；语义校验统一由 decodeCityPayload 做一次。
export async function readCityPayload(url, fetcher = fetch, metrics = null) {
  const startedAt = nowMs();
  let response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw cityDataError('request', `City data request failed: ${error.message}`, error);
  }
  if (!response.ok) throw new CityDataError('request', `City data request failed: ${response.status}`);
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw cityDataError('request', `City data request failed: ${error.message}`, error);
  }
  const downloadedAt = nowMs();
  if (metrics) metrics.downloadMs = downloadedAt - startedAt;
  // 静态服务器可能已经解压，按 gzip 魔数判断，而不是相信文件扩展名。
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let unpacked;
  let text;
  let fast;
  try {
    unpacked = compressed
      ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : bytes;
    fast = unpacked[0] === 0x53 && unpacked[1] === 0x5a && unpacked[2] === 0x43 && unpacked[3] === 0x31;
    if (!fast) text = new TextDecoder('utf-8', { fatal: true }).decode(unpacked);
  } catch (error) {
    throw cityDataError('decompress', `City data decompress failed: ${error.message}`, error);
  }
  const decompressedAt = nowMs();
  if (metrics) metrics.decompressMs = decompressedAt - downloadedAt;
  let raw;
  try {
    raw = fast ? await decodeFastCity(unpacked) : JSON.parse(text);
  } catch (error) {
    throw cityDataError('invalid', `City data parse failed: ${error.message}`, error);
  }
  if (metrics) metrics.parseMs = nowMs() - decompressedAt;
  return raw;
}

function validateMapRegions(map, buildings) {
  if (map === undefined) return;
  const types = ['retail', 'public', 'park', 'residential', 'office', 'village', 'unknown'];
  requireData(map?.version === 1 && map.source?.id === 'osm-guangdong'
    && /^[0-9a-f]{64}$/.test(map.source.sha256) && typeof map.source.snapshotAt === 'string'
    && Array.isArray(map.regions) && Array.isArray(map.places), 'mapRegions version and source');
  const places = new Set();
  for (const place of map.places) {
    requireData(typeof place?.id === 'string' && !places.has(place.id) && typeof place.name === 'string'
      && Array.isArray(place.osmIds) && place.osmIds.length > 0, 'mapRegions place');
    places.add(place.id);
  }
  const ids = new Set();
  const counts = Object.fromEntries(types.map(type => [type, 0]));
  for (const region of map.regions) {
    const source = region?.source;
    const sourced = source?.kind === 'osm-area' && /^(way|relation)\/\d+$/.test(source.osmId)
      && region.id === `osm:${source.osmId}` && region.level !== 'block';
    const derived = source?.kind === 'derived-block' && source.roadOsmIds?.length > 0
      && region.level === 'block' && region.type === 'unknown' && /^block:[a-z0-9-]+$/.test(region.id);
    requireData((sourced || derived) && !ids.has(region.id) && types.includes(region.type)
      && ['place', 'building', 'block'].includes(region.level)
      && (region.name === null || typeof region.name === 'string' && region.name.length > 0)
      && Number.isFinite(region.areaM2) && region.areaM2 > 0
      && Array.isArray(region.rings) && region.rings.length > 0 && region.rings.every(poly => Array.isArray(poly) && poly.length > 0
        && poly.every(ring => Array.isArray(ring) && ring.length >= 6 && ring.length % 2 === 0
          && ring.every(Number.isSafeInteger)))
      && Array.isArray(region.anchors) && region.anchors.length > 0
      && region.anchors.every(point => Array.isArray(point) && point.length === 3
        && point.every(Number.isFinite) && point[2] > 0)
      && Array.isArray(region.placeIds) && region.placeIds.every(id => places.has(id))
      && Array.isArray(region.buildingRefs) && region.buildingRefs.every((ref, i) => Number.isInteger(ref)
        && ref >= 0 && ref < buildings.id.length && (i === 0 || ref > region.buildingRefs[i - 1])), 'mapRegions region');
    ids.add(region.id);
    counts[region.type]++;
  }
  requireData(types.every(type => map.coverage?.[type] === counts[type]), 'mapRegions coverage');
}

function validateAirCruises(data, graph) {
  if (data === undefined) return;
  const { flight, routes } = data;
  requireData(data.version === 1 && data.roadSource === 'osm-guangdong' && /^[0-9a-f]{64}$/.test(data.roadSourceSha256)
    && flight?.heightReference === 'surface-road-or-ground'
    && ['targetHeightM', 'speedMps', 'accelerationMps2', 'initialTurnSeconds', 'brakingMps2', 'lateralAccelerationMps2', 'sampleStepM']
      .every(key => Number.isFinite(flight[key]) && flight[key] > 0)
    && Array.isArray(routes) && routes.length > 0, 'air cruise configuration');
  const roadIds = new Set(graph.metadata.map(road => road.osmId));
  const ids = new Set();
  for (const route of routes) {
    requireData(typeof route.id === 'string' && !ids.has(route.id) && route.start?.name && route.end?.name
      && Array.isArray(route.points) && route.points.length >= 3
      && route.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      && Array.isArray(route.segments) && route.segments.length > 0, 'air cruise path');
    ids.add(route.id);
    let length = 0;
    for (let i = 1; i < route.points.length; i++) {
      const [x, z] = route.points[i];
      const [px, pz] = route.points[i - 1];
      const step = Math.hypot(x - px, z - pz);
      requireData(step > 0 && step <= flight.sampleStepM + 0.02, 'air cruise sample interval');
      length += step;
    }
    let station = 0;
    let previousMain = null;
    for (const [i, segment] of route.segments.entries()) {
      requireData(segment.fromM === station && Number.isFinite(segment.toM) && segment.toM > station, 'air cruise chainage');
      station = segment.toM;
      if (segment.kind === 'main') {
        requireData(roadIds.has(segment.osmId) && (segment.direction === 1 || segment.direction === -1)
          && (!previousMain || previousMain.toNode === segment.fromNode), 'air cruise main road continuity');
        previousMain = segment;
      } else {
        requireData(segment.kind === 'entry' && i === 0
          || segment.kind === 'departure' && i === route.segments.length - 1, 'air cruise access segment');
      }
    }
    requireData(previousMain && Math.abs(station - length) < 0.011 && station === route.horizontalLengthM, 'air cruise path length');
  }
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
  validateMapRegions(raw.mapRegions, buildings);
  if (raw.retailBuildings !== undefined) {
    const buildingIds = new Set(buildings.id);
    const assigned = new Set();
    requireData(Array.isArray(raw.retailBuildings), 'retailBuildings');
    for (const row of raw.retailBuildings) {
      requireData(Array.isArray(row) && row.length === 2 && buildingIds.has(row[0])
        && !assigned.has(row[0]) && (row[1] === 1 || row[1] === 2), 'retail building use');
      assigned.add(row[0]);
    }
  }
  // 角色、上游族、分项可信度是新增字段，旧包可能没有；出现时必须和建筑数组一一对应并落在枚举内。
  for (const [field, enumName] of [['role', 'buildingRole'], ['upstream', 'upstreamFamily'],
    ['fpConf', 'confidence'], ['hConf', 'confidence'], ['eraConf', 'confidence']]) {
    if (buildings[field] === undefined) continue;
    const levels = raw.enums?.[enumName];
    requireData(Array.isArray(levels) && levels.length > 0, `enums.${enumName}`);
    requireData(Array.isArray(buildings[field]) && buildings[field].length === buildings.h.length,
      `buildings.${field}`);
    requireData(buildings[field].every(value => Number.isInteger(value) && value >= 0 && value < levels.length),
      `building ${enumName}`);
  }
  requireData(Array.isArray(raw.landmarks), 'landmarks');
  validateIds(raw.landmarks.map(lm => lm?.id), 'landmark identity');
  for (const lm of raw.landmarks) {
    requireData(lm && (lm.short === undefined || typeof lm.short === 'string')
      && (lm.mapPriority === undefined || typeof lm.mapPriority === 'boolean')
      && (lm.aliases === undefined || Array.isArray(lm.aliases) && lm.aliases.every(alias => typeof alias === 'string')),
    'landmark map labels');
  }
  requireData(raw.parks === undefined || Array.isArray(raw.parks), 'parks');
  const landmarkIds = new Set(raw.landmarks.map(landmark => landmark.id));
  validateBridges(raw.bridges, landmarkIds);
  validateYanjiang(raw.yanjiangExpressway);
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
  validateGolfCourse(raw.golfCourse, raw.roadGraph, raw.buildings);
  validateIecPaths(raw.iecPaths);
  validateTalentPark(raw.talentPark, raw);
  validateTrees(raw.trees);
  validateSites(raw.sites);
  validateNorthRail(raw.shenzhenNorthRail);
  validateAir(raw.air);
  if (raw.urbanPaving !== undefined) {
    const { version, manifestSha256, pilotOnly, publicRoutes, trees } = raw.urbanPaving ?? {};
    requireData(version === 1 && typeof manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifestSha256)
      && typeof pilotOnly === 'boolean' && Array.isArray(publicRoutes) && Array.isArray(trees), 'urban paving');
    requireData(publicRoutes.every(route => typeof route?.id === 'string' && typeof route.evidence === 'string'
      && Number.isFinite(route.widthM) && route.widthM > 0 && Number.isFinite(route.lateralM)
      && route.lateralM >= 0 && route.lateralM <= 0.38 && Array.isArray(route.pointsXZ) && route.pointsXZ.length >= 2
      && route.pointsXZ.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))), 'urban paving walks');
    requireData(trees.every(tree => typeof tree?.id === 'string' && typeof tree.speciesName === 'string'
      && [tree.x, tree.z, tree.height, tree.crown].every(Number.isFinite) && tree.height > 0 && tree.crown > 0), 'urban paving trees');
  }
  validateShenzhenBay(raw.shenzhenBay, raw.parks ?? [], raw.seaSurface);
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
  validateIds(graph.nodeIds, 'road node identity');
  const roadEdges = [];
  for (const [index, [a, b, name, width, lanes, direction, inner]] of graph.links.entries()) {
    requireData(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0
      && a < graph.nodeIds.length && b < graph.nodeIds.length && a !== b
      && Number.isInteger(name) && typeof graph.names[name] === 'string'
      && Number.isFinite(width) && width > 0 && Number.isInteger(lanes) && lanes >= 0
      && [-1, 0, 1].includes(direction) && Array.isArray(inner) && inner.length % 2 === 0
      && inner.every(Number.isFinite), 'road graph link');
    const road = graph.metadata[index];
    requireData(isOsmId(road?.osmId) && Number.isInteger(road.layer)
      && typeof road.bridge === 'boolean' && typeof road.tunnel === 'boolean'
      && typeof road.heightSource === 'string' && road.heightSource.length > 0
      && typeof road.widthSource === 'string' && road.widthSource.length > 0, `road metadata: ${index}`);
    if (road.drive !== undefined) {
      const drive = road.drive;
      const directions = ['both', 'forward', 'backward'];
      const positive = value => Number.isFinite(value) && value > 0;
      requireData(drive && typeof drive === 'object' && !Array.isArray(drive)
        && Object.keys(drive).every(key => ['closed', 'maxKph', 'maxheight', 'maxwidth', 'maxlength', 'maxweight'].includes(key))
        && (drive.closed === undefined || (Array.isArray(drive.closed) && drive.closed.every(key => directions.includes(key))))
        && (drive.maxKph === undefined || (drive.maxKph && !Array.isArray(drive.maxKph) && typeof drive.maxKph === 'object'
          && Object.entries(drive.maxKph).every(([key, value]) => directions.includes(key) && positive(value))))
        && ['maxheight', 'maxwidth', 'maxlength', 'maxweight'].every(key => drive[key] === undefined || positive(drive[key])),
      `road drive rules: ${index}`);
    }
    roadEdges.push(`${road.osmId}:${graph.nodeIds[a]}:${graph.nodeIds[b]}`);
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
  const structures = raw.roadStructures;
  if (structures !== undefined) {
    requireData(structures?.version === 1 && ['verticalStepM', 'maxGrade', 'bridgeSlabM', 'tunnelRoofM',
      'tunnelClearanceM', 'tunnelLightDepthM', 'tunnelWallM'].every(key => Number.isFinite(structures[key]) && structures[key] > 0)
      && Array.isArray(structures.routes) && Array.isArray(structures.records), 'road structures');
    validateIds(structures.routes.map(route => route?.id), 'structure route identity');
    requireData(structures.routes.every(route => route.waterPierBaseM === undefined
      || (route.kind === 'bridge' && Number.isFinite(route.waterPierBaseM))), 'bridge water pier base');
    const landscape = structures.landscape;
    if (landscape != null) {
      requireData(Array.isArray(landscape.patches) && Array.isArray(landscape.trees)
        && landscape.publicPath?.mode === 'walk' && Number.isFinite(landscape.publicPath.widthM)
        && landscape.publicPath.widthM > 0 && Array.isArray(landscape.publicPath.points)
        && landscape.publicPath.points.length > 1 && landscape.publicPath.points.every(point =>
          Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)), 'road landscape path');
      validateIds(landscape.patches.map(patch => patch?.id), 'road landscape patch identity');
      validateIds(landscape.trees.map(tree => tree?.id), 'road landscape tree identity');
      for (const patch of landscape.patches) {
        requireData(['flowers', 'grass', 'path'].includes(patch.color) && Number.isFinite(patch.offsetM)
          && Array.isArray(patch.trianglesXZ) && patch.trianglesXZ.length > 0 && patch.trianglesXZ.length % 6 === 0
          && patch.trianglesXZ.every(Number.isFinite) && Array.isArray(patch.sourceIds)
          && patch.sourceIds.every(isOsmId), 'road landscape patch');
      }
      requireData(landscape.trees.every(tree => [tree.x, tree.z, tree.height, tree.crown].every(Number.isFinite)
        && tree.height > 0 && tree.crown > 0 && typeof tree.speciesName === 'string'), 'road landscape trees');
    }
    const routes = new Map(structures.routes.map(route => [route.id, route]));
    const seen = new Set();
    for (const row of structures.records) {
      const route = routes.get(row?.route);
      requireData(Number.isInteger(row?.index) && graph.metadata[row.index]?.osmId === row.way && !seen.has(row.index)
        && ['bridge', 'tunnel', 'approach', 'ramp'].includes(row.kind)
        && (route?.kind === row.kind || route?.kind === 'mixed' || (route?.kind === 'bridge' && row.kind === 'approach'))
        && route?.ways?.includes(row.way) && (row.layer === undefined || Number.isFinite(row.layer))
        && Number.isFinite(row.widthM) && row.widthM > 0 && Number.isInteger(row.lanes) && row.lanes >= 0
        && Number.isFinite(row.stationOffsetM) && row.stationOffsetM >= 0
        && Number.isFinite(row.maxGrade) && row.maxGrade >= 0
        && row.maxGrade <= (route?.junction?.tunnelMouth === true && row.kind === 'ramp'
          ? Math.min(0.07, route.junction.maxGrade ?? structures.maxGrade) : structures.maxGrade)
        && Number.isFinite(row.openApronM) && row.openApronM >= 0
        && typeof row.sharedStart === 'boolean' && typeof row.sharedEnd === 'boolean'
        && (row.kind !== 'tunnel' ? row.coverM === null : row.coverM?.length === 2 && row.coverM.every(Number.isFinite))
        && Array.isArray(row.stations) && row.stations.length >= 16 && row.stations.length % 8 === 0
        && row.stations[0] === 0 && row.stations.every((value, i) => Number.isFinite(value)
          && (i < 8 || i % 8 !== 0 || value > row.stations[i - 8])), 'structure stations');
      seen.add(row.index);
    }
    if (structures.connections !== undefined) {
      const records = new Map(structures.records.map(row => [row.index, row]));
      requireData(Array.isArray(structures.connections) && structures.connections.every(row => {
        const { ramp, incoming, outgoing, template } = row ?? {};
        if (records.get(ramp)?.kind !== 'ramp' || !records.has(incoming) || !records.has(outgoing)
          || new Set([ramp, incoming, outgoing]).size !== 3 || !['loop', 'side'].includes(template)) return false;
        const node = graph.links[incoming][1];
        return graph.links[outgoing][0] === node && graph.links[ramp].slice(0, 2).includes(node);
      }), 'road structure connections');
      validateIds(structures.connections.map(row => String(row.ramp)), 'ramp connection identity');
    }
    if (structures.roadCovers !== undefined) {
      const records = new Map(structures.records.map(row => [row.index, row]));
      requireData(Array.isArray(structures.roadCovers), 'road covers');
      validateIds(structures.roadCovers.map(row => row?.osmId), 'road cover identity');
      const buildingIds = new Set(raw.buildings.id);
      for (const cover of structures.roadCovers) {
        requireData(isOsmId(cover.osmId) && cover.kind === 'acoustic-enclosure' && !buildingIds.has(cover.osmId)
          && ['clearanceM', 'roofM', 'wallM', 'beamSpacingM'].every(key => Number.isFinite(cover[key]) && cover[key] > 0)
          && Array.isArray(cover.spans) && cover.spans.length > 0 && cover.spans.every(span => {
            const row = records.get(span?.index);
            return row?.kind === 'bridge' && Number.isFinite(span.startM) && Number.isFinite(span.endM)
              && span.startM >= 0 && span.startM < span.endM && span.endM <= row.stations.at(-8) + 1e-5;
          }), 'road cover spans');
      }
    }
  }
  validateIds(roadEdges, 'road edge identity');
  validateWaterfront(raw.waterfront, raw);
  validateAirCruises(raw.airCruises, graph);
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
    for (const feature of frontage.features) {
      if (feature.arterialStyle !== undefined) {
        requireData(feature.kind === 'median' && ['grass', 'separator'].includes(feature.arterialStyle)
          && feature.riseM === 0 && Array.isArray(feature.sourceIds) && feature.sourceIds.length >= 2
          && feature.sourceIds.every(isOsmId) && Array.isArray(feature.trianglesXZ) && feature.trianglesXZ.length > 0
          && feature.trianglesXZ.length % 6 === 0 && feature.trianglesXZ.every(Number.isFinite), 'arterial median finish');
      }
      if (feature.solidPlanting !== undefined) {
        requireData(feature.solidPlanting === true && feature.kind === 'median' && feature.riseM > 0
          && Array.isArray(feature.outlines) && feature.outlines.length > 0
          && feature.outlines.every(ring => ring.length >= 8 && ring.length % 2 === 0 && ring.every(Number.isFinite)),
        'road frontage planting boundary');
      }
      if (feature.plantSites !== undefined) {
        requireData(feature.kind === 'flower-band' && Array.isArray(feature.plantSites)
          && feature.plantSites.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)),
        'road frontage planting sites');
      }
      if (feature.clipToRoadComplement === undefined && feature.vertexRisesM === undefined) continue;
      const { trianglesXZ, vertexRisesM } = feature;
      requireData(feature.clipToRoadComplement === true && Array.isArray(trianglesXZ)
        && trianglesXZ.length > 0 && trianglesXZ.length % 6 === 0 && trianglesXZ.every(Number.isFinite)
        && (vertexRisesM === undefined || (Array.isArray(vertexRisesM) && vertexRisesM.length === trianglesXZ.length / 2
          && vertexRisesM.every(rise => Number.isFinite(rise) && rise >= 0))), 'road frontage clipped surface');
    }
    for (const corridor of frontage.corridors) {
      if (corridor.walkLegs !== undefined) {
        requireData(Array.isArray(corridor.walkLegs) && corridor.walkLegs.every(leg =>
          (leg.crossing ? corridor.crossingIds.includes(leg.osmId) : [...corridor.sidewalkIds, ...corridor.crossingIds].includes(leg.osmId))
          && typeof leg.crossing === 'boolean' && Array.isArray(leg.points) && leg.points.length >= 2
          && leg.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
          && (leg.signalGroup === undefined || (leg.crossing && [0, 1].includes(leg.signalGroup)
            && frontage.intersections.some(row => row.id === corridor.id)))), 'road frontage walk legs');
      }
      if (corridor.crossingAxes === undefined) continue;
      requireData(Array.isArray(corridor.crossingAxes) && Array.isArray(corridor.crossingIds)
        && corridor.crossingAxes.every(axis => corridor.crossingIds.includes(axis.osmId)
          && Number.isFinite(axis.widthM) && axis.widthM > 0 && Array.isArray(axis.points) && axis.points.length >= 2
          && axis.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))),
      'road frontage crossing axes');
    }
  }
  return raw;
}

// 城市包只在这里校验一次（读取阶段不再校验）；校验项的 message 依赖来源字段名，测试按正则匹配。
export function decodeCityPayload(raw, metrics = null) {
  const validateStartedAt = nowMs();
  try {
    validateCityPayload(raw);
  } catch (error) {
    throw cityDataError('invalid', error.message, error);
  }
  const validatedAt = nowMs();
  if (metrics) metrics.validateMs = validatedAt - validateStartedAt;
  const b = raw.buildings;
  const retail = new Map(raw.retailBuildings);
  const foundations = new Map(raw.golfCourse?.foundations.map(row => [row.id, row]));
  const buildings = b.h.map((height, i) => {
    const shape = polygon(b.rings[i]);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of shape.outer) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    // 旧包没有这三组数组时保持 null；有值时按枚举还原字符串，不在这里补造可信度。
    const confidence = Array.isArray(b.fpConf) && Array.isArray(b.hConf) && Array.isArray(b.eraConf)
      ? { footprint: raw.enums.confidence[b.fpConf[i]],
        height: raw.enums.confidence[b.hConf[i]], era: raw.enums.confidence[b.eraConf[i]] }
      : null;
    return { id: b.id[i], kind: 'building', sourceId: b.id[i], height, minHeight: b.minH[i], year: 0, polygons: [shape],
      minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
      heightSource: raw.enums.heightSource[b.src[i]], category: raw.enums.category[b.cat[i]],
      facade: raw.enums.facade[b.facade[i]], landmark: raw.landmarks[b.lm[i]]?.id ?? null,
      name: Array.isArray(b.name) && b.name[i] >= 0 ? (raw.names?.[b.name[i]] ?? null) : null,
      levels: Array.isArray(b.lv) ? b.lv[i] : -1,
      role: Array.isArray(b.role) ? raw.enums.buildingRole[b.role[i]] : null,
      upstreamFamily: Array.isArray(b.upstream) ? raw.enums.upstreamFamily[b.upstream[i]] : null,
      confidence, ...(retail.has(b.id[i]) ? { retailFloors: retail.get(b.id[i]) } : {}),
      ...(foundations.has(b.id[i]) ? { foundation: foundations.get(b.id[i]) } : {}) };
  });
  const decoded = { buildings, geo: { version: raw.version,
    frame: { origin: raw.origin, bearingDeg: 0, units: 'm', angleUnits: 'rad', axes: { x: 'east', y: 'up', z: 'south' } },
    bounds: raw.bounds,
    coverage: raw.coverage.map(polygon), land: raw.land.map(polygon), water: raw.water.map(polygon),
    wetland: raw.wetland.map(polygon), green: raw.green.map(polygon),
    roadGraph: raw.roadGraph, terrain: raw.terrain, terrainSurface: raw.terrainSurface,
    roadStructures: raw.roadStructures ?? null,
    roadFrontage: raw.roadFrontage ?? null,
    mapRegions: raw.mapRegions ? { ...raw.mapRegions, regions: raw.mapRegions.regions.map(decodeMapRegion) } : null,
    shenzhenBay: raw.shenzhenBay ?? null,
    waterfront: raw.waterfront ?? null,
    regionalScene: raw.regionalScene ?? null,
    urbanPaving: raw.urbanPaving ?? null,
    metro: raw.metro, landmarks: raw.landmarks,
    bridges: raw.bridges ?? [], yanjiangExpressway: raw.yanjiangExpressway ?? null,
    seaSurface: raw.seaSurface && { ...raw.seaSurface, polygons: raw.seaSurface.polygons.map(polygon) },
    streetscape: raw.streetscape ?? null,
    talentPark: raw.talentPark ?? null,
    golfCourse: raw.golfCourse && { ...raw.golfCourse,
      ponds: raw.golfCourse.ponds.map(({ rings, ...pond }) => ({ ...pond, polygon: polygon(rings) })) },
    iecPaths: raw.iecPaths ?? [],
    trees: raw.trees ?? null,
    sites: decodeSites(raw.sites),
    shenzhenNorthRail: raw.shenzhenNorthRail ?? null,
    air: raw.air ?? null, airCruises: raw.airCruises ?? null,
    parks: (raw.parks ?? []).map(park => ({ ...park, areas: park.areas.map(area => ({ ...area, polygon: polygon(area.polygon) })) }))
  } };
  if (metrics) metrics.decodeMs = nowMs() - validatedAt;
  return decoded;
}
