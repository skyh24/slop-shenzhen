import { baseAt, footprintParts, spanPart } from './parts.js';
import { approach, ellipse, frameAt, longestEdge, rect, stackedLofts, volume } from './model-profile.js';

export const sourceIds = ['way/600815118', 'way/600810213', 'way/707365805'];

function geometry(source) {
  const { a, b, length } = longestEdge(source.polygons[0].outer);
  const at = frameAt({ x: source.cx, z: source.cz }, a.x < b.x ? a : b, a.x < b.x ? b : a);
  return { at, halfWidth: length / 2 + 6.2, halfDepth: (source.maxZ - source.minZ) / 2 };
}

export function build(sources, terrain, { heightAt } = {}) {
  const [tower, annex, link] = sourceIds.map(id => sources.get(id));
  const { at, halfWidth, halfDepth } = geometry(tower);
  const door = at(0, halfDepth - 4);
  const base = heightAt?.(door.x, door.z) ?? baseAt(tower, terrain);
  // 承建方总高 193 米；梭形收分、立面凹带和首层退界由实景与源足迹拟合。
  // 顶部先收成较窄的玻璃壳，再用一道实体冠带和女儿墙压边；平顶藏在女儿墙后，远处看到的是实景里的窄檐口。
  const crownStart = 191.0;
  const profile = [[8.2, 0.97], [24, 1], [75, 1], [132, 0.982], [170, 0.945], [crownStart, 0.89], [193, 0.875]];
  const lens = Array.from({ length: 24 }, (_, i) => {
    const angle = i * Math.PI / 12;
    // 长面微弧，两端收成窄圆角；顶面保留照片里的平直长边。
    return [Math.cos(angle) * halfWidth, Math.sign(Math.sin(angle)) * Math.abs(Math.sin(angle)) ** 0.50 * halfDepth];
  });
  const section = ([y, scale]) => ({ y, ring: lens.map(([u, v]) => at(u * scale, v * scale - 0.6 * y / 193)) });
  const skin = profile.map(spec => ({ ...section(spec),
    style: spec[0] >= crownStart ? 'tencentCrown' : 'tencentLegacyGlass' }));
  const crown = section(profile.at(-1));
  const canopy = (u, v) => ({ ...at(u, v), y: base + 7.9 });
  const parapet = crown.ring.map((a, i) => {
    const b = crown.ring[(i + 1) % crown.ring.length];
    return spanPart(`tencent-towers:parapet:${i}`, tower,
      { ...a, y: base + 193 }, { ...b, y: base + 193 }, 0.7, 0.7, 0.55, 'tencentParapet');
  });
  return [
    volume('tencent-towers:lobby', tower, rect(at, 0, -0.8, 39, halfDepth * 1.42), base - 0.45, base + 9.2, 'landmarkLobby'),
    spanPart('tencent-towers:canopy', tower, canopy(0, halfDepth - 6.5), canopy(0, halfDepth + 2.3), 20, 20, 0.42, 'landmarkEdge'),
    ...[-14.2, 14.2].map((u, i) => volume(`tencent-towers:column:${i}`, tower, ellipse(at, u, halfDepth - 2.2, 0.62, 0.62, 10),
      base - 0.45, base + 9.6, 'landmarkEdge')),
    ...stackedLofts('tencent-towers:shaft', tower, base, skin, { heightSource: 'published', smoothSides: true }),
    ...parapet,
    volume('tencent-towers:roof-plant', tower, rect(at, 5.4, 0, 10, 4.2), base + 193, base + 194.15, 'tencentRoof'),
    volume('tencent-towers:roof-mast', tower, ellipse(at, 9.4, -0.8, 0.13, 0.13, 8), base + 193, base + 198.2, 'tencentParapet'),
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
