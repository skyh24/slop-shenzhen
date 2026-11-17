import { baseAt, footprintParts, spanPart, crownLoftPart } from './parts.js';
import { approach, ellipse, frameAt, longestEdge, rect, stackedLofts, volume } from './model-profile.js';

export const sourceIds = ['way/600815118', 'way/600810213', 'way/707365805'];

function geometry(source) {
  const { a, b, length } = longestEdge(source.polygons[0].outer);
  const at = frameAt({ x: source.cx, z: source.cz }, a.x < b.x ? a : b, a.x < b.x ? b : a);
  return { at, halfWidth: length / 2 + 0.9, halfDepth: (source.maxZ - source.minZ) / 2 - 0.4 };
}

// 实景平面是直边圆角矩形，不是梭形：长边平直，两端用圆角收头，顶部一圈薄檐口像椭圆环绕侧面。
function planRing(halfWidth, halfDepth) {
  const radius = Math.min(9.5, halfDepth * 0.62);
  const straight = Math.max(1, halfWidth - radius);
  const inner = Math.max(0.5, halfDepth - radius);
  const points = [];
  const push = (x, z) => points.push([x, z]);
  const arc = (cx, cz, from, to, steps, includeEnd = true) => {
    const last = includeEnd ? steps : steps - 1;
    for (let i = 1; i <= last; i++) {
      const angle = from + (to - from) * i / steps;
      push(cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius);
    }
  };
  push(-straight, halfDepth);
  push(straight, halfDepth);
  arc(straight, inner, Math.PI / 2, 0, 4);
  push(halfWidth, -inner);
  arc(straight, -inner, 0, -Math.PI / 2, 4);
  push(-straight, -halfDepth);
  arc(-straight, -inner, -Math.PI / 2, -Math.PI, 4);
  push(-halfWidth, inner);
  arc(-straight, inner, Math.PI, Math.PI / 2, 4, false);
  return points.reverse();
}

export function build(sources, terrain, { heightAt } = {}) {
  const [tower, annex, link] = sourceIds.map(id => sources.get(id));
  const { at, halfWidth, halfDepth } = geometry(tower);
  const door = at(0, halfDepth - 4);
  const base = heightAt?.(door.x, door.z) ?? baseAt(tower, terrain);
  const ring = planRing(halfWidth, halfDepth);
  // 两侧接近垂直，顶部平；193m 处的薄檐口是照片里绕侧边的椭圆线。
  const profile = [[8.2, 0.98], [24, 1], [75, 1], [132, 0.998], [165, 0.992], [193, 0.985]];
  const section = ([y, scale]) => ({ y, ring: ring.map(([u, v]) => at(u * scale, v * scale - 0.6 * y / 193)) });
  const skin = profile.map(spec => ({ ...section(spec), style: 'tencentLegacyGlass' }));
  const scaleAt = y => {
    for (let i = 1; i < profile.length; i++) {
      if (y <= profile[i][0]) {
        const [y0, s0] = profile[i - 1], [y1, s1] = profile[i];
        return s0 + (s1 - s0) * (y - y0) / (y1 - y0);
      }
    }
    return profile.at(-1)[1];
  };
  // 中央竖缝：前后两面各做一条，分段跟随塔身收分，从首层一直延伸到檐口下。
  const spine = [-1, 1].flatMap(side => Array.from({ length: 12 }, (_, i) => {
    const y0 = 9.4 + (192.2 - 9.4) * i / 12;
    const y1 = 9.4 + (192.2 - 9.4) * (i + 1) / 12;
    const scale = scaleAt((y0 + y1) / 2);
    return volume(`tencent-towers:spine:${side}:${i}`, tower,
      rect(at, 0, side * (halfDepth * scale - 0.04), 0.42 * scale, 0.22), base + y0, base + y1, 'tencentSpine');
  }));
  // 檐口：下环贴幕墙，上环外挑 0.8%，形成连续薄椭圆边；不封顶，屋顶另铺平板。
  const corniceLow = section([191.8, 1]).ring;
  const corniceHigh = section([193, 1.025]).ring;
  const cornice = crownLoftPart('tencent-towers:cornice', tower, corniceLow, corniceHigh,
    base + 191.8, corniceHigh.map(() => base + 193), 'tencentCornice',
    { heightSource: 'published', uvOriginY: base, smoothSides: true });
  const roof = section([193, 0.985]).ring;
  const canopy = (u, v) => ({ ...at(u, v), y: base + 7.9 });
  return [
    volume('tencent-towers:lobby', tower, rect(at, 0, -0.8, 39, halfDepth * 1.42), base - 0.45, base + 9.2, 'landmarkLobby'),
    spanPart('tencent-towers:canopy', tower, canopy(0, halfDepth - 6.5), canopy(0, halfDepth + 2.3), 20, 20, 0.42, 'landmarkEdge'),
    ...[-14.2, 14.2].map((u, i) => volume(`tencent-towers:column:${i}`, tower, ellipse(at, u, halfDepth - 2.2, 0.62, 0.62, 10),
      base - 0.45, base + 9.6, 'landmarkEdge')),
    ...stackedLofts('tencent-towers:shaft', tower, base, skin, { heightSource: 'published', smoothSides: true, topFace: false }),
    cornice,
    ...spine,
    volume('tencent-towers:roof', tower, roof, base + 192.96, base + 193, 'tencentRoof'),
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
