import { sourceIds as tencentIds, build as buildTencent } from './tencent-binhai.js';
import { sourceIds as skyCityIds, build as buildSkyCity } from './dji-sky-city.js';
import { sourceIds as pingAnIds, build as buildPingAn } from './ping-an.js';
import { sourceIds as chunsunIds, build as buildChunsun } from './chunsun.js';
import { sourceIds as civicIds, optionalSkipIds as civicDuplicates, build as buildCivic } from './civic-center.js';
import { sourceIds as chunjianIds, build as buildChunjian } from './chunjian.js';
import { sourceIds as cultureIds, build as buildCulture } from './shenzhen-bay-culture-square.js';
import { sourceIds as conventionIds, build as buildConvention } from './convention-center.js';
import { sourceIds as upperhillsIds, build as buildUpperhills } from './upperhills.js';
import { sourceIds as nonferrousIds, optionalSkipIds as nonferrousDuplicates, build as buildNonferrous } from './nonferrous-tower.js';
import { sourceIds as iecIds, optionalSkipIds as iecDuplicates, build as buildIec } from './iec-xiangmihu.js';
import { sourceIds as superHqIds, optionalSkipIds as superHqSkips, build as buildSuperHq } from './super-hq.js';

const definitions = [
  { id: 'tencent-binhai', sourceIds: tencentIds, build: buildTencent },
  { id: 'dji-sky-city', sourceIds: skyCityIds, build: buildSkyCity },
  { id: 'ping-an', sourceIds: pingAnIds, build: buildPingAn },
  { id: 'chunsun', sourceIds: chunsunIds, build: buildChunsun },
  { id: 'civic-center', sourceIds: civicIds, optionalSkipIds: civicDuplicates, build: buildCivic },
  { id: 'chunjian', sourceIds: chunjianIds, build: buildChunjian },
  { id: 'shenzhen-bay-culture-square', sourceIds: cultureIds, build: buildCulture },
  { id: 'convention-center', sourceIds: conventionIds, build: buildConvention },
  { id: 'upperhills', sourceIds: upperhillsIds, build: buildUpperhills },
  { id: 'nonferrous-tower', sourceIds: nonferrousIds, optionalSkipIds: nonferrousDuplicates, build: buildNonferrous },
  { id: 'iec-xiangmihu', site: 'iec-xiangmihu', sourceIds: iecIds, optionalSkipIds: iecDuplicates, build: buildIec },
  { id: 'super-hq', site: 'super-hq', sourceIds: superHqIds, optionalSkipIds: superHqSkips, build: buildSuperHq }
];

export function planSzLandmarks(buildings, terrain, sites = {}) {
  const source = new Map(buildings.map(building => [building.id, building]));
  const skipIds = new Set();
  const plans = [];
  for (const definition of definitions) {
    // 快照缺少部件时保留原通用建筑。只有全套地标几何可生成时才接管源对象。
    const sourceIds = definition.sourceIds ?? [];
    if (!sourceIds.every(id => source.has(id))) continue;
    // 场地轮廓来自 bucket 里人工核对过的 OSM 对象；模型另有源建筑时两者都传。
    const context = { sites: sites[definition.site] ?? sites[definition.id] ?? {} };
    const parts = definition.build(source, terrain, context);
    if (parts.length === 0) continue;
    for (const id of sourceIds) skipIds.add(id);
    for (const id of definition.optionalSkipIds ?? []) if (source.has(id)) skipIds.add(id);
    plans.push({ id: definition.id, parts });
  }
  return { plans, skipIds };
}
