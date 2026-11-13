import { polygonContainsInclusive } from './sz-polygon.js';

// 表现配置与城市包分别版本化。绑定复用已存在的对象或边界。
const SCHEMA_VERSION = 1;
export const SCENE_STYLE = {
  schemaVersion: SCHEMA_VERSION,
  bindings: [
    { target: { kind: 'region', id: 'osm:way/546582690' }, params: { surfaceStyle: 'light-stone' } },
    { target: { kind: 'mountain', id: 'osm:way/41281446' }, params: { surfaceStyle: 'summit-stone' } },
    { target: { kind: 'park', id: 'osm:relation/18459537' }, params: { fixtureSpacingM: 17, fixtureSetbackM: 3.6 } },
    { target: { kind: 'road', id: 'way/853286944' }, params: { lampSpacingM: 46 } }
  ]
};

export const SURFACE_STYLES = Object.freeze({
  'warm-stone': { color: 0xb1a59a, roughness: 0.94, depthBias: -2 },
  'light-stone': { color: 0xa6a099, tileSizeM: 0.58, depthBias: -2 },
  'summit-stone': { groutWidth: [0.009, 0.024], color: 0x9e7e70, variation: 0xc0a18d, jointColor: 0x605b57, tileSizeM: 1.22,
    roughness: 0.85, metalness: 0.03, nightColor: 0x9f8275, nightStrength: 0.062 },
  'concrete': { color: 0x96948e, tileSizeM: 0.58, depthBias: -2 },
  'park-gravel': { color: 0xb5a382, roughness: 0.95, depthBias: -2 }
});

const numeric = (minimum, maximum) => value => Number.isFinite(value) && value >= minimum && value <= maximum;
const FIELDS = {
  surfaceStyle: { kinds: ['region', 'mountain', 'park', 'surface'], valid: value => typeof value === 'string' && Object.hasOwn(SURFACE_STYLES, value) },
  fixtureSpacingM: { kinds: ['mountain', 'park'], valid: numeric(1, 200) },
  fixtureSetbackM: { kinds: ['mountain', 'park'], valid: numeric(0, 25) },
  maxSlopeRatio: { kinds: ['mountain', 'park'], valid: value => value === null || numeric(0, 3)(value) },
  lampSpacingM: { kinds: ['road'], valid: numeric(6, 200) },
  lampsEnabled: { kinds: ['road'], valid: value => typeof value === 'boolean' }
};
const AREA_KINDS = ['region', 'park', 'mountain'];
const keyOf = (kind, id) => `${kind}:${id}`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

export function createSceneStyle(geo, config = SCENE_STYLE, onConflict = details => console.warn('Conflicting scene style bindings', details)) {
  if (!exactKeys(config, ['schemaVersion', 'bindings']) || config.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(config.bindings)) throw new Error(`Unsupported scene style schemaVersion: ${config?.schemaVersion}`);
  const regions = new Map((geo.mapRegions?.regions ?? []).map(region => [region.id, region]));
  const roadIds = new Set(geo.roadGraph.metadata.map(road => road.osmId));
  const pavedSurfaces = new Set((geo.roadFrontage?.features ?? [])
    .filter(({ kind }) => kind === 'paving' || kind === 'sidewalk').map(({ id }) => id));
  const bindings = new Map(), areasByField = new Map();
  const reported = new Set();

  for (const entry of config.bindings) {
    const { target, params } = entry ?? {};
    const { id, kind } = target ?? {};
    const key = keyOf(kind, id);
    if (!exactKeys(entry, ['target', 'params']) || !exactKeys(target, ['kind', 'id'])
      || typeof id !== 'string' || !id || !record(params)) throw new Error(`Invalid scene style binding: ${key}`);
    const region = regions.get(id);
    switch (kind) {
      case 'region':
      case 'mountain':
      case 'park':
        // 较旧的 v2 包没有区域数据时仍可启动，场景使用类型默认值。
        if (geo.mapRegions && (!region || (kind === 'park' && region.type !== 'park'))) {
          throw new Error(`Unknown scene style target: ${key}`);
        }
        break;
      case 'road':
        if (!roadIds.has(id)) throw new Error(`Unknown scene style target: ${key}`);
        break;
      case 'surface':
        if (!pavedSurfaces.has(id)) throw new Error(`Unknown scene style target: ${key}`);
        break;
      default:
        throw new Error(`Unknown scene style target: ${key}`);
    }
    if (bindings.has(key)) throw new Error(`Duplicate scene style binding: ${key}`);
    for (const [field, value] of Object.entries(params)) {
      const rule = Object.hasOwn(FIELDS, field) && FIELDS[field];
      if (!rule || !rule.kinds.includes(kind) || !rule.valid(value)) {
        throw new Error(`Invalid scene style parameter: ${key}.${field}`);
      }
    }
    const values = Object.freeze({ ...params });
    bindings.set(key, values);
    if (region && AREA_KINDS.includes(kind)) {
      for (const field of Object.keys(values)) {
        if (!areasByField.has(field)) areasByField.set(field, []);
        areasByField.get(field).push({ id, kind, polygons: region.polygons, values });
      }
    }
  }

  function resolve(defaults, { x, z, regionId, kind, id } = {}) {
    const values = { ...defaults };
    const object = bindings.get(keyOf(kind, id));
    // 逐字段选择一个归属者。同一字段的山地/公园/地理绑定不叠加。
    for (const field of Object.keys(defaults)) {
      const candidates = areasByField.get(field) ?? [];
      const explicit = regionId ? candidates.filter(area => area.id === regionId) : [];
      const local = explicit.length ? explicit : Number.isFinite(x) && Number.isFinite(z)
        ? candidates.filter(area => area.polygons.some(polygon => polygonContainsInclusive(polygon, x, z))) : [];
      const bestKind = AREA_KINDS.findLast(areaKind => local.some(area => area.kind === areaKind));
      const owners = local.filter(area => area.kind === bestKind);
      if (owners.length === 1) values[field] = owners[0].values[field];
      else if (owners.length > 1 && owners.every(area => area.values[field] === owners[0].values[field])) {
        values[field] = owners[0].values[field];
      } else if (owners.length > 1) {
        const ids = owners.map(area => area.id).sort();
        const signature = [field, bestKind, ...ids].join('|');
        if (!reported.has(signature)) {
          reported.add(signature);
          onConflict({ field, kind: bestKind, ids });
        }
      }
      if (object && Object.hasOwn(object, field)) values[field] = object[field];
    }
    return values;
  }

  return { resolve, road: id => bindings.get(keyOf('road', id)) };
}
