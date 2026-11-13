import { baseAt, footprintParts } from './parts.js';

export const sourceIds = ['way/238825588', 'way/539435437'];

// 购物公园弧形一侧的部件与裙房共用约 128 米外边。下段由裙房提供，上段从屋面起算。
export function build(sources, terrain) {
  const [podium, upper] = sourceIds.map(id => sources.get(id));
  if (upper.height <= podium.height) return [];
  const base = baseAt(podium, terrain);
  return [
    ...footprintParts(podium, base, 'shoppingParkBase'),
    ...footprintParts(upper, base, 'shoppingParkGlass', { min: podium.height,
      baseSourceId: podium.id, bottomFace: false })
  ];
}
