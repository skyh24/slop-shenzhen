import { baseAt, footprintParts } from './parts.js';
import { createBuildingEnvelopePlan } from '../sz-building-envelope.js';

export const sourceIds = ['way/238825588', 'way/539435437'];

// 购物公园弧形一侧的部件与裙房共用约 128 米外边。下段由裙房提供，上段从屋面起算。
export function build(sources, terrain) {
  const [podium, upper] = sourceIds.map(id => sources.get(id));
  if (upper.height <= podium.height) return [];
  const base = baseAt(podium, terrain);
  const lowerParts = footprintParts(podium, base, 'shoppingParkBase');
  const upperParts = footprintParts(upper, base, 'shoppingParkGlass', { min: podium.height,
    baseSourceId: podium.id, bottomFace: false });
  // 共边已在分段处接高。只裁被圆筒占用的裙房顶面和同源接触三角。
  const { envelopes } = createBuildingEnvelopePlan([podium, upper], building => building === podium
    ? { minY: base + podium.minHeight, maxY: Math.fround(base + podium.height) }
    : { minY: Math.fround(base + podium.height), maxY: Math.fround(base + upper.height) }, new Set(), [sourceIds]);
  return [...lowerParts.map(part => ({ ...part, roofPieces: envelopes.get(part.polygon)?.cap(part.maxY, 1) })),
    ...upperParts];
}
