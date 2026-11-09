import { sourceIds as tencentIds, build as buildTencent } from './tencent-binhai.js';
import { sourceIds as skyCityIds, build as buildSkyCity } from './dji-sky-city.js';
import { sourceIds as pingAnIds, build as buildPingAn } from './ping-an.js';
import { sourceIds as chunsunIds, build as buildChunsun } from './chunsun.js';

const definitions = [
  { id: 'tencent-binhai', sourceIds: tencentIds, build: buildTencent },
  { id: 'dji-sky-city', sourceIds: skyCityIds, build: buildSkyCity },
  { id: 'ping-an', sourceIds: pingAnIds, build: buildPingAn },
  { id: 'chunsun', sourceIds: chunsunIds, build: buildChunsun }
];

export function planSzLandmarks(buildings, terrain) {
  const source = new Map(buildings.map(building => [building.id, building]));
  const skipIds = new Set();
  const plans = [];
  for (const definition of definitions) {
    // 快照缺少部件时保留原通用建筑。只有全套地标几何可生成时才接管源对象。
    if (!definition.sourceIds.every(id => source.has(id))) continue;
    const parts = definition.build(source, terrain);
    for (const id of definition.sourceIds) skipIds.add(id);
    for (const id of definition.optionalSkipIds ?? []) if (source.has(id)) skipIds.add(id);
    plans.push({ id: definition.id, parts });
  }
  return { plans, skipIds };
}
