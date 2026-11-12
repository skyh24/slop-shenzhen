import { baseAt, footprintParts, loftPart, point, spanPart } from './parts.js';

export const sourceIds = ['way/65255027', 'way/774640911', 'way/529086130'];
export const optionalSkipIds = ['way/925221216'];

function ring(x, z, radius, sides = 12) {
  return Array.from({ length: sides }, (_, i) => {
    const a = i * Math.PI * 2 / sides;
    return point(x + radius * Math.cos(a), z + radius * Math.sin(a));
  });
}

export function build(sources, terrain) {
  const [tower, crown, podium] = sourceIds.map(id => sources.get(id));
  const baseY = baseAt(tower, terrain);
  const coreHeight = tower.height;
  const glassHeight = coreHeight - 20;
  const tipHeight = crown.height;
  if (!(tipHeight > coreHeight && glassHeight > podium.height)) return [];
  const x = crown.cx, z = crown.cz;
  const core = baseY + coreHeight;
  // OSM 的 260 m 是建筑最高点。开放钢架和尖塔按照片估计截面、位置和分段高度。
  const frameTop = core + (tipHeight - coreHeight) * 0.55;
  const parts = [
    ...footprintParts(tower, baseY, 'pressTowerGlass', { id: 'press-tower:curved-wing', max: glassHeight, derived: true }),
    ...footprintParts(crown, baseY, 'civicStone', { id: 'press-tower:core', max: coreHeight, derived: true }),
    ...footprintParts(podium, baseY, 'tencentPodium', { id: 'press-tower:podium', baseSourceId: tower.id })
  ];
  const frameWidth = (crown.maxX - crown.minX) * 0.75;
  const frameDepth = (crown.maxZ - crown.minZ) * 0.66;
  const left = x - frameWidth / 2, right = x + frameWidth / 2;
  for (const side of [-1, 1]) {
    const edgeZ = z + frameDepth * side / 2;
    for (const edgeX of [left, right]) {
      const post = ring(edgeX, edgeZ, 0.54, 8);
      parts.push(loftPart(`press-tower:post:${side}:${edgeX === left ? 'left' : 'right'}`,
        crown, post, post, core, frameTop, 'djiSteel', { baseSourceId: tower.id }));
    }
    for (let i = 0; i < 4; i++) {
      const y0 = core + (frameTop - core) * i / 4, y1 = core + (frameTop - core) * (i + 1) / 4;
      const a = { x: left, y: y1, z: edgeZ }, b = { x: right, y: y1, z: edgeZ };
      parts.push(spanPart(`press-tower:truss:${side}:${i}`, crown, a, b, 0.65, 0.65, 0.65,
        'djiSteel', { baseSourceId: tower.id }));
      parts.push(spanPart(`press-tower:brace:${side}:${i}`, crown, { ...a, y: i % 2 ? y1 : y0 },
        { ...b, y: i % 2 ? y0 : y1 }, 0.38, 0.38, 0.42, 'djiSteel', { baseSourceId: tower.id }));
    }
  }
  parts.push(loftPart('press-tower:spire', crown, ring(right, z, 0.82), ring(right, z, 0.14),
    core, baseY + tipHeight, 'djiSteel', { heightSource: 'published', baseSourceId: tower.id, smoothSides: true }));

  // 「新闻眼」由球形截面近似，与塔身南面相接，实体与碰撞共用截面。
  const eyeX = tower.minX + (tower.maxX - tower.minX) * 0.40;
  const eyeZ = tower.maxZ - 2.5, eyeY = baseY + glassHeight - 25;
  const size = 6.0;
  const slices = Array.from({ length: 11 }, (_, i) => {
    const angle = 0.025 + (Math.PI - 0.05) * i / 10;
    return { y: eyeY - size * Math.cos(angle), ring: ring(eyeX, eyeZ, size * Math.sin(angle), 16) };
  });
  for (let i = 1; i < slices.length; i++) {
    const low = slices[i - 1], high = slices[i];
    parts.push(loftPart(`press-tower:news-eye:${i}`, tower, low.ring, high.ring, low.y, high.y,
      'pressEye', { smoothSides: true }));
  }
  return parts;
}
