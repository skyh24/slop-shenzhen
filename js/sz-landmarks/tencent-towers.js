import { baseAt, footprintParts, spanPart, crownLoftPart } from './parts.js';
import { approach, ellipse, frameAt, longestEdge, rect, stackedLofts, volume } from './model-profile.js';

export const sourceIds = ['way/600815118', 'way/600810213', 'way/707365805'];

function geometry(source) {
  const { a, b, length } = longestEdge(source.polygons[0].outer);
  const at = frameAt({ x: source.cx, z: source.cz }, a.x < b.x ? a : b, a.x < b.x ? b : a);
  return { at, halfWidth: length / 2 + 0.9, halfDepth: (source.maxZ - source.minZ) / 2 - 0.4 };
}

export function build(sources, terrain, { heightAt } = {}) {
  const [tower, annex, link] = sourceIds.map(id => sources.get(id));
  const { at, halfWidth, halfDepth } = geometry(tower);
  const door = at(0, halfDepth - 4);
  const base = heightAt?.(door.x, door.z) ?? baseAt(tower, terrain);
  // 实景是两端起翘、中间下凹的梭形冠，不是平顶：主幕墙到 179.5m，顶部用非平面 loft 收成双尖冠。
  const crownBase = 179.5;
  const crownTop = 193;
  const crownDrop = 12.5;
  const profile = [[8.2, 0.972], [24, 1], [75, 1], [132, 0.986], [165, 0.958], [crownBase, 0.936]];
  const lens = Array.from({ length: 32 }, (_, i) => {
    const angle = i * Math.PI / 16;
    // 平面是尖梭形：两端收成窄尖，长面略鼓，正面看得到竖向中缝。
    return [Math.sign(Math.cos(angle)) * Math.abs(Math.cos(angle)) ** 0.92 * halfWidth,
      Math.sign(Math.sin(angle)) * Math.abs(Math.sin(angle)) ** 0.62 * halfDepth];
  });
  const section = ([y, scale]) => ({ y, ring: lens.map(([u, v]) => at(u * scale, v * scale - 0.6 * y / 193)) });
  const skin = profile.map(spec => ({ ...section(spec), style: 'tencentLegacyGlass' }));
  const lowerCrown = section(profile.at(-1)).ring;
  const crownUpper = lens.map(([u, v]) => {
    const top = base + crownTop - crownDrop * (1 - Math.abs(u / halfWidth) ** 1.45);
    return { ...at(u * 0.89, v * 0.89 - 0.6 * crownTop / 193), y: top };
  });
  const crown = crownLoftPart('tencent-towers:shaft:crown', tower, lowerCrown, crownUpper,
    base + crownBase, crownUpper.map(p => p.y), 'tencentLegacyGlass',
    { heightSource: 'published', uvOriginY: base, smoothSides: true });
  const deck = lens.map(([u, v]) => at(u * 0.925, v * 0.925 - 0.6 * crownBase / 193));
  const scaleAt = y => {
    for (let i = 1; i < profile.length; i++) {
      if (y <= profile[i][0]) {
        const [y0, s0] = profile[i - 1], [y1, s1] = profile[i];
        return s0 + (s1 - s0) * (y - y0) / (y1 - y0);
      }
    }
    return profile.at(-1)[1];
  };
  // 正面中央的深色竖缝：分段跟随塔身收分，避免一根直条在顶部浮出幕墙。
  const spine = Array.from({ length: 8 }, (_, i) => {
    const y0 = 9.4 + (crownBase + 0.6 - 9.4) * i / 8;
    const y1 = 9.4 + (crownBase + 0.6 - 9.4) * (i + 1) / 8;
    const scale = scaleAt((y0 + y1) / 2);
    return volume(`tencent-towers:spine:${i}`, tower,
      rect(at, 0, halfDepth * scale - 0.08, 1.05 * scale, 0.26), base + y0, base + y1, 'tencentSpine');
  });
  const canopy = (u, v) => ({ ...at(u, v), y: base + 7.9 });
  return [
    volume('tencent-towers:lobby', tower, rect(at, 0, -0.8, 39, halfDepth * 1.42), base - 0.45, base + 9.2, 'landmarkLobby'),
    spanPart('tencent-towers:canopy', tower, canopy(0, halfDepth - 6.5), canopy(0, halfDepth + 2.3), 20, 20, 0.42, 'landmarkEdge'),
    ...[-14.2, 14.2].map((u, i) => volume(`tencent-towers:column:${i}`, tower, ellipse(at, u, halfDepth - 2.2, 0.62, 0.62, 10),
      base - 0.45, base + 9.6, 'landmarkEdge')),
    ...stackedLofts('tencent-towers:shaft', tower, base, skin, { heightSource: 'published', smoothSides: true, topFace: false }),
    crown,
    ...spine,
    volume('tencent-towers:roof-deck', tower, deck, base + crownBase, base + crownBase + 0.55, 'tencentRoof'),
    volume('tencent-towers:roof-plant', tower, rect(at, 4.2, 0, 9, 3.4), base + crownBase, base + 180.2, 'tencentRoof'),
    ...footprintParts(annex, baseAt(annex, terrain), 'tencentPodium', { id: 'tencent-towers:conference' }),
    ...footprintParts(link, baseAt(link, terrain), 'tencentPodium', { id: 'tencent-towers:conference-link' })
  ];
}

export function approaches(sources) {
  const { at, halfDepth } = geometry(sources.get(sourceIds[0]));
  return [approach(at(0, halfDepth - 4), at(0, halfDepth + 25), 6)];
}

export function trim(parts, sources) {
  const { at, halfDepth } = geometry(sources.get(sourceIds[0]));
  const lobby = parts.find(part => part.id.startsWith('tencent-towers:lobby'));
  const a = at(0, 0), b = at(1, 0);
  const yaw = Math.atan2(a.z - b.z, b.x - a.x);
  return Array.from({ length: 11 }, (_, i) => ({
    ...at(-17.5 + i * 3.5, -0.8 + halfDepth * 0.71 + 0.08),
    y: lobby.minY + 4.05, yaw, size: [0.13, 7.7, 0.14]
  }));
}
