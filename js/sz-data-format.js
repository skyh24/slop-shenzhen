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
  validateIecPaths(raw.iecPaths);
  validateTrees(raw.trees);
  validateSites(raw.sites);
  validateAir(raw.air);
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
    return { id: b.id[i], height, minHeight: b.minH[i], year: 0, polygons: [shape],
      minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
      heightSource: raw.enums.heightSource[b.src[i]], category: raw.enums.category[b.cat[i]],
      facade: raw.enums.facade[b.facade[i]], landmark: raw.landmarks[b.lm[i]]?.id ?? null,
      name: Array.isArray(b.name) && b.name[i] >= 0 ? (raw.names?.[b.name[i]] ?? null) : null,
      levels: Array.isArray(b.lv) ? b.lv[i] : -1,
      role: Array.isArray(b.role) ? raw.enums.buildingRole[b.role[i]] : null,
      upstreamFamily: Array.isArray(b.upstream) ? raw.enums.upstreamFamily[b.upstream[i]] : null,
      confidence };
  });
  const decoded = { buildings, geo: { version: raw.version,
    frame: { origin: raw.origin, bearingDeg: 0, units: 'm' }, bounds: raw.bounds,
    coverage: raw.coverage.map(polygon), land: raw.land.map(polygon), water: raw.water.map(polygon),
    wetland: raw.wetland.map(polygon), green: raw.green.map(polygon),
    roadGraph: raw.roadGraph, terrain: raw.terrain, terrainSurface: raw.terrainSurface,
    roadFrontage: raw.roadFrontage ?? null,
    metro: raw.metro, landmarks: raw.landmarks,
    bridges: raw.bridges ?? [], yanjiangExpressway: raw.yanjiangExpressway ?? null,
    seaSurface: raw.seaSurface && { ...raw.seaSurface, polygons: raw.seaSurface.polygons.map(polygon) },
    streetscape: raw.streetscape ?? null,
    iecPaths: raw.iecPaths ?? [],
    trees: raw.trees ?? null,
    sites: decodeSites(raw.sites),
    air: raw.air ?? null,
    parks: (raw.parks ?? []).map(park => ({ ...park, areas: park.areas.map(area => ({ ...area, polygon: polygon(area.polygon) })) }))
  } };
  if (metrics) metrics.decodeMs = nowMs() - validatedAt;
  return decoded;
}
