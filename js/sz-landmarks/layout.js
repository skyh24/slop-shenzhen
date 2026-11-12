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
import { sourceIds as pressIds, optionalSkipIds as pressDuplicates, build as buildPress } from './press-tower.js';
import { sourceIds as iecIds, optionalSkipIds as iecDuplicates, build as buildIec } from './iec-xiangmihu.js';
import { sourceIds as superHqIds, optionalSkipIds as superHqSkips, build as buildSuperHq } from './super-hq.js';
import { polygonContains } from '../building-collision.js';

// 超级总部/西丽在建场地由「建好形态/在建工地」接管：场地轮廓内的旧通用楼不再单独渲染。
const siteTakeoverSites = ['super-hq', 'xili-station'];

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
  { id: 'press-tower', sourceIds: pressIds, optionalSkipIds: pressDuplicates, build: buildPress },
  { id: 'iec-xiangmihu', site: 'iec-xiangmihu', sourceIds: iecIds, optionalSkipIds: iecDuplicates, build: buildIec },
  { id: 'super-hq', site: 'super-hq', sourceIds: superHqIds, optionalSkipIds: superHqSkips, build: buildSuperHq }
];

// 场地接管清单和地标计划放在一起：两者都是「谁不再按通用楼渲染」的判定，同源同处便于核对；
// 场地内旧通用楼交给地标和工地，避免同一位置叠出两套体量。
export function siteTakeoverIds(buildings, sites = {}) {
  const ids = new Set();
  for (const siteId of siteTakeoverSites) {
    for (const role of Object.values(sites?.[siteId] ?? {})) {
      for (const building of buildings) {
        if (ids.has(building.id)) continue;
        for (const polygon of role.polygons) {
          if (polygonContains(polygon, building.cx, building.cz)) { ids.add(building.id); break; }
        }
      }
    }
  }
  return ids;
}

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
  // 场地接管与地标接管合并成一份 skipIds：超级总部/西丽场地轮廓内的旧通用楼不再单独渲染。
  for (const id of siteTakeoverIds(buildings, sites)) skipIds.add(id);
  return { plans, skipIds };
}
