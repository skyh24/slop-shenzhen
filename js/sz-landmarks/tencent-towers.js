import { baseAt, footprintParts, spanPart } from './parts.js';
import { approach, ellipse, frameAt, longestEdge, rect, stackedLofts, volume } from './model-profile.js';

export const sourceIds = ['way/600815118', 'way/600810213', 'way/707365805'];

function geometry(source) {
  const { a, b } = longestEdge(source.polygons[0].outer);
  const at = frameAt({ x: source.cx, z: source.cz }, a.x < b.x ? a : b, a.x < b.x ? b : a);
  const origin = at(0, 0), axis = at(1, 0);
  const dx = axis.x - origin.x, dz = axis.z - origin.z;
  const local = source.polygons[0].outer.map(p => [p.x - origin.x, p.z - origin.z]);
  const extent = (x, z) => Math.max(...local.map(([u, v]) => Math.abs(u * x + v * z)));
  return { at, halfWidth: extent(dx, dz), halfDepth: extent(-dz, dx) };
}

// 直窗带延伸至圆角。各截面的圆角取相同角度，收分时对应边保持平行。
function roundedRing(at, length, depth, center, radius) {
  const ring = [];
  for (let corner = 0; corner < 4; corner++) {
    const u = [1, -1, -1, 1][corner] * (length - radius);
    const v = center + [1, 1, -1, -1][corner] * (depth - radius);
    for (let i = 0; i <= 5; i++) {
      const angle = (corner + i / 5) * Math.PI / 2;
      ring.push(at(u + radius * Math.cos(angle), v + radius * Math.sin(angle)));
    }
  }
  return ring;
}

export function build(sources, terrain, { heightAt } = {}) {
  const [tower, annex, link] = sourceIds.map(id => sources.get(id));
  const { at, halfWidth, halfDepth } = geometry(tower);
  const door = at(0, halfDepth - 4);
  const base = heightAt?.(door.x, door.z) ?? baseAt(tower, terrain);
  const crownBase = 174;
  const section = (y, scale) => ({ y, style: 'tencentLegacyGlass',
    ring: roundedRing(at, halfWidth * scale, halfDepth * scale, 0, 6.4 * scale) });
  const skin = [[8.2, 0.985], [24, 1], [125, 1], [crownBase, 0.98]].map(([y, scale]) => section(y, scale));
  // 从窄端看，两片冠壳向中缝卷起。193 米取已发表高度，其余截面按照片拟合。
  const crown = [-1, 1].flatMap(side => {
    const sections = [[174, halfDepth * 0.98], [181, 13.3], [186.5, 10.6], [190.5, 6.8], [193, 2.4]]
      .map(([y, outer]) => {
        const gap = 0.95, depth = (outer - gap) / 2;
        return { y, style: 'tencentLouvers', ring: roundedRing(at, halfWidth * 0.98, depth,
          side * (gap + depth), Math.min(6.25, depth * 0.94)) };
      });
    return stackedLofts(`tencent-towers:crown:${side}`, tower, base, sections, { heightSource: 'published' });
  });
  const west = at(-halfWidth * 0.985 - 0.75, 0), center = at(0, 0);
  const yaw = Math.atan2(west.x - center.x, west.z - center.z);
  const signs = [
    { ...west, y: base + 184, yaw, width: 13.4, height: 13.4, style: 'tencentBadge' },
    { ...at(7, 13.9), y: base + 181, yaw: yaw + Math.PI / 2, pitch: -0.27,
      width: 18, height: 4.5, style: 'tencentWordmark' }
  ];
  const canopy = (u, v) => ({ ...at(u, v), y: base + 7.9 });
  const parts = [
    volume('tencent-towers:lobby', tower, rect(at, 0, -0.8, 39, halfDepth * 1.42), base - 0.45, base + 9.2, 'landmarkLobby'),
    spanPart('tencent-towers:canopy', tower, canopy(0, halfDepth - 6.5), canopy(0, halfDepth + 2.3), 20, 20, 0.42, 'landmarkEdge'),
    ...[-14.2, 14.2].map((u, i) => volume(`tencent-towers:column:${i}`, tower, ellipse(at, u, halfDepth - 2.2, 0.62, 0.62, 10),
      base - 0.45, base + 9.6, 'landmarkEdge')),
    ...stackedLofts('tencent-towers:shaft', tower, base, skin, { heightSource: 'estimate', topFace: false }),
    ...crown,
    volume('tencent-towers:end-seam', tower, rect(at, -halfWidth * 0.985, 0, 1.2, 2.45),
      base + 9.2, base + 179, 'tencentSpine'),
    volume('tencent-towers:roof-deck', tower, skin.at(-1).ring, base + crownBase - 0.5, base + crownBase, 'tencentRoof'),
    ...footprintParts(annex, baseAt(annex, terrain), 'tencentPodium', { id: 'tencent-towers:conference' }),
    ...footprintParts(link, baseAt(link, terrain), 'tencentPodium', { id: 'tencent-towers:conference-link' })
  ];
  return { parts, signs };
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
