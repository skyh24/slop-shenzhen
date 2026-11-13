import { baseAt, footprintParts } from './parts.js';
import { approach, frameAt, longestEdge, rect, stackedLofts } from './model-profile.js';

export const sourceIds = ['way/781166572', 'way/781166573'];

function frame(tower) {
  const { a, b, length } = longestEdge(tower.polygons[0].outer);
  const at = frameAt({ x: tower.cx, z: tower.cz }, a.x < b.x ? a : b, a.x < b.x ? b : a);
  return { at, w: length, d: (tower.maxZ - tower.minZ) };
}

export function build(sources, terrain) {
  const [tower, porch] = sourceIds.map(id => sources.get(id));
  const { at, w, d } = frame(tower);
  const base = baseAt(tower, terrain);
  // Farrells 的 441.8 米为建成总高；近垂直的塔身在高处收为不对称拱顶。
  const rows = [[0, 1, 1, 0, 'landmarkLobby'], [10, 1, 1, 0, 'kkGlass'], [295, .94, .96, 0, 'kkGlass'],
    [369, .86, .92, -1, 'kkGlass'], [400, .78, .87, -1.6, 'kkCrown'],
    [418, .62, .80, -2.8, 'kkCrown'], [432, .43, .69, -4.4, 'kkCrown'], [439.4, .23, .54, -6, 'kkCrown'],
    [441.8, .055, .39, -7, null]];
  return [
    ...stackedLofts('kk100:profile', tower, base, rows.map(([y, sx, sz, u, style]) => ({
      y, ring: rect(at, u, 0, w * sx, d * sz), style
    })), { heightSource: 'published' }),
    ...footprintParts(porch, base, 'kkCrown', { id: 'kk100:mall-porch', baseSourceId: tower.id })
  ];
}

export function approaches(sources) {
  const { at, d } = frame(sources.get(sourceIds[0]));
  return [approach(at(0, d / 2), at(0, d / 2 + 19), 5)];
}
