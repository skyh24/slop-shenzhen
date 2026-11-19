import { ellipse } from './model-profile.js';
import { loftPart } from './parts.js';

// 东楼水广场侧的长边顺原足迹切口。上下各层共用同一凹口，鼻子在其中垂到街前。
export function trunkOpening(ring) {
  const result = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    result.push(a);
    if (Math.min(a.x, b.x) < -10514 || Math.min(a.z, b.z) >= 105.75 || Math.max(a.z, b.z) <= 108.75) continue;
    const edge = z => ({ x: a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z), z });
    const [start, end] = a.z < b.z ? [105.75, 108.75] : [108.75, 105.75];
    result.push(edge(start), { x: -10515.45, z: start }, { x: -10515.45, z: end }, edge(end));
  }
  return result;
}

export function elephantParts(building, base, seat) {
  const parts = [];
  // 原点取抱抱象 OSM 艺术品节点，正 x 朝喷泉。身、耳和鼻按参考照片估算外形。
  const at = (out, side) => ({ x: -10515.30 + out, z: 107.22 + side });
  function rounded(id, out, side, y, rx, rz, ry, style) {
    const count = 10;
    let previous;
    for (let j = 0; j <= count; j++) {
      const angle = (j / count - 0.5) * (Math.PI - 0.04);
      const h = y + Math.sin(angle) * ry;
      const ring = ellipse(at, out, side, rx * Math.cos(angle), rz * Math.cos(angle), 20);
      if (previous) parts.push(loftPart('mixc:elephant:' + id + ':' + j, building, previous.ring, ring, previous.h, h, style,
        { smoothSides: true, bottomFace: j === 1, topFace: j === count }));
      previous = { ring, h };
    }
  }
  rounded('body', -4.45, 0, seat + 2.55, 4.5, 2.63, 2.55, 'elephantQuilt');
  for (const side of [-1, 1]) {
    rounded('haunch:' + side, -6.9, side * 1.72, seat + 1.28, 1.82, 1.08, 1.28, 'elephantPearl');
    rounded('paw:' + side, -0.82, side * 1.62, seat + 1.57, 1.04, 0.94, 1.59, 'elephantQuilt');
    rounded('ear:' + side, -1.45, side * 2.16, seat + 4.95, 0.60, 1.44, 2.06, 'elephantPearl');
    rounded('inner-ear:' + side, -1.05, side * 2.25, seat + 4.98, 0.36, 1.03, 1.57, 'elephantEar');
  }
  rounded('head', -0.85, 0, seat + 4.42, 2.30, 2.02, 2.20, 'elephantPearl');
  for (const side of [-1, 1]) {
    rounded('eye:' + side, 1.10, side * 0.96, seat + 4.70, 0.21, 0.24, 0.35, 'elephantEye');
    rounded('cheek:' + side, 0.81, side * 1.30, seat + 3.96, 0.20, 0.46, 0.28, 'elephantBlush');
  }
  // 横向褶缝沿连续截面收放；鼻尖前伸上卷，鼻底与地面留隙。
  const top = seat + 4.0, bottom = base + 1.9, pleats = 23;
  let previous;
  for (let i = 0; i <= pleats * 4; i++) {
    const t = i / (pleats * 4), y = bottom + t * (top - bottom);
    const x = 2.33 - 0.9 * t + 0.55 * Math.exp(-t * 22);
    const radius = (0.49 + 0.33 * t * t) * (0.90 + 0.10 * Math.sin(i * Math.PI / 4) ** 2);
    const ring = ellipse(at, x, 0, radius, radius * 1.03, 16);
    if (previous) parts.push(loftPart('mixc:elephant:trunk:' + i, building, previous.ring, ring, previous.y, y,
      i % 4 === 0 ? 'elephantFold' : 'elephantPearl', { smoothSides: true, bottomFace: i === 1, topFace: i === pleats * 4 }));
    previous = { ring, y };
  }
  rounded('curl', 2.98, 0, bottom + 0.12, 0.70, 0.51, 0.52, 'elephantPearl');
  rounded('tip', 3.44, 0, bottom + 0.48, 0.46, 0.47, 0.63, 'elephantPearl');
  return parts;
}
