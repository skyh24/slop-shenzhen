import { footprintParts, roofPanelPart, spanPart } from './parts.js';
import { northFrame, northRailHeight } from '../sz-rail/geometry.js';

export const sourceIds = ['way/222088288', 'way/262922059', 'way/262922064'];
export const stationId = 'way/1212433645';
const baseY = northRailHeight(0);
export const northRoofY = baseY + 43.6;
export const northPublicDeckY = 18.2;

export function build(source, _terrain, { sites, northRail }) {
  if (!northRail || sites.station?.osmId !== stationId) return [];
  const { toWorld, lateral, along } = northFrame(northRail);
  const [hall, north, south] = sourceIds.map(id => source.get(id));
  const parts = [];
  const box = (id, u0, u1, v0, v1, y0, y1, style) => {
    parts.push(spanPart(`north:${id}`, hall, toWorld((u0 + u1) / 2, v0, y1),
      toWorld((u0 + u1) / 2, v1, y1), u1 - u0, u1 - u0, y1 - y0, style));
  };
  // 足迹定外缘；平顶与东侧上扬弧底的分段厚度按航拍估计。
  const ring = hall.polygons[0].outer;
  const edges = [...new Set(ring.map(p => Math.round(lateral(p))))].sort((a, b) => a - b);
  const low = edges[0], high = edges.at(-1);
  const half = (high - low) / 2;
  const n = Math.min(...ring.map(along)) + 0.35;
  const s = Math.max(...ring.map(along)) - 0.5;
  const v = t => n + (s - n) * t;
  const roof = (u, t) => northRoofY - 0.5 * Math.abs(2 * t - 1) - 0.6 * Math.abs(u - low - half) / half;
  const depth = u => 1.5 + 7.6 * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 120) / (high - 120)))) ** 1.6;
  const divisions = [low, -148, -125, -87, -42, 4, 50, 96, 121, 146, 169, 191, 214, high];
  for (let i = 1; i < divisions.length; i++) {
    const a = divisions[i - 1], b = divisions[i];
    for (let j = 0; j < 4; j++) {
      const t0 = j / 4, t1 = (j + 1) / 4;
      const p = [toWorld(a, v(t0), roof(a, t0)), toWorld(b, v(t0), roof(b, t0)),
        toWorld(b, v(t1), roof(b, t1)), toWorld(a, v(t1), roof(a, t1))];
      for (const ids of [[0, 1, 2], [0, 2, 3]]) parts.push(roofPanelPart(
        `north:main-roof:${i}:${j}:${ids[1]}`, hall, ids.map(k => p[k]),
        ids.map(k => depth(k === 0 || k === 3 ? a : b)), 'northRoof', { baseSource: 'estimate', roofContact: true }));
    }
  }
  // 跨线层底面与站台分离。室内用闭合外壳，门廊在外墙之外。
  box('cross-track-deck', -158, 119, -95, 91, northPublicDeckY - 2.1, northPublicDeckY, 'northStone');
  box('waiting-shell', -155, 114, -89, 86, northPublicDeckY, northRoofY - 1.9, 'northGlass');
  box('west-porch', -168.2, -154.8, -91, 88, northPublicDeckY - 1.5, northPublicDeckY, 'northStone');
  box('east-upper-porch', 114, 229, -91, 86, northPublicDeckY - 1.7, northPublicDeckY, 'northStone');
  // 边跨落地体与柱列不进入国铁净空。
  box('west-pier-base', -163, -140, -92, 90, 7.65, northPublicDeckY - 0.1, 'northStone');
  box('east-pier-base', 112.5, 120.5, -89, 86, 7.65, northPublicDeckY - 0.1, 'northStone');
  box('west-entry-band', -157, -154.6, -63, 68, northPublicDeckY, northPublicDeckY + 7.5, 'northGlass');
  box('east-entry-band', 114, 115.8, -69, 63, northPublicDeckY, northPublicDeckY + 8.5, 'northGlass');
  for (const [label, canopy] of [['north', north], ['south', south]]) {
    // 源图是无柱雨棚占地；底部保留约 8 米站台与车辆净空。
    parts.push(...footprintParts(canopy, baseY, 'northCanopy', {
      id: `north:canopy:${label}`, min: 9.1, max: 10.35, derived: true, baseSourceId: stationId
    }));
  }
  for (const [side, u0, u1] of [['east', 213, 231], ['west', -167, -143]]) {
    for (const [j, v0] of [-54, -9, 37].entries()) {
      box(`north-portal:${side}:${j}`, u0, u1, v0, v0 + 14, 8, 14.2, 'northGlass');
      box(`portal-lintel:${side}:${j}`, u0 - 0.2, u1 + 0.5, v0 - 0.8, v0 + 14.8, 14.1, 15, 'northStone');
    }
  }
  for (const side of [-1, 1]) for (let i = 0; i < 12; i++) {
    const v0 = -92 + i * 16.5;
    const u = side > 0 ? 224 : -165;
    parts.push({ ...spanPart(`north:portico-column:${side}:${i}`, hall,
      toWorld(u, v0 - 0.63, northRoofY - 1.8), toWorld(u, v0 + 0.63, northRoofY - 1.8),
      1.26, 1.26, northRoofY - 9.75, 'northColumn'), instanced: true });
  }
  return parts;
}
