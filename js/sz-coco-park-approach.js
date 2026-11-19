import { STR } from './sz-strings.js';
import { populateTeleportMenu } from './sz-ui.js';
import { COCO_PARK_FRONTAGE } from './sz-zhongxin-walk.js';

// 来源与配准边界见 data/source/coco-park-entrance-evidence.md。
// 沿中心二路西侧已接入的前场铺装，落点朝向东南门外。
const [[startX, startZ], [stopX, stopZ]] = COCO_PARK_FRONTAGE;
const COCO_PARK_APPROACH = {
  id: 'coco-park-southeast-approach',
  start: { x: startX, z: startZ, heading: Math.atan2(stopX - startX, stopZ - startZ), exact: true },
  stop: { x: stopX, z: stopZ }
};

// 地点 ID 已由城市包或场地模块绑定；类别只影响菜单筛选。
const TELEPORT_CATEGORIES = {
  landmark: ['oh-bay', 'oh-bay-east-shore', 'oh-bay-west-shore', 'oh-bay-wheel', 'mixc-world'],
  retail: ['oh-bay-east-shore', 'oh-bay-west-shore', 'mixc-world', 'huaqiangbei', 'upperhills', 'dongmen', 'sea-world', 'kk100', 'oh-bay', 'taizi-bay', COCO_PARK_APPROACH.id],
  park: ['talent-park', 'lianhuashan', 'shenzhen-bay-park'],
  culture: ['oct-loft', 'nantou-ancient-city', 'dongmen', 'sea-world', 'shenzhen-bay-culture-square'],
  amusement: ['oh-bay-wheel', 'window-of-world', 'oh-bay'],
  sports: ['chunjian', 'szu-yuanping-stadium', 'university-town-stadium', 'shenzhen-stadium', 'shenzhen-gymnasium']
};

const MENU_REGIONS = {
  'osm:way/529086160': 'retail',
  'osm:way/776141699': 'retail',
  'osm:relation/19692109': 'retail',
  'osm:way/322631274': 'retail',
  'osm:way/236402467': 'amusement',
  'osm:way/207170378': 'park'
};

export function createTeleportMenu(locations, bayPark, locationLabel, walkEntries = {}, regions = []) {
  const { id, start, stop } = COCO_PARK_APPROACH;
  const approach = { ...start, detail: STR.teleport.cocoParkApproachDetail, name: STR.teleport.cocoParkApproach,
    waypoint: { ...stop, name: STR.teleport.cocoParkEntrance } };
  const entries = { ...locations, [id]: approach, ...walkEntries };
  if (bayPark) entries[bayPark.id] = bayPark;
  const categories = new Map();
  for (const key of Object.keys(entries)) {
    const groups = Object.keys(TELEPORT_CATEGORIES).filter(category => TELEPORT_CATEGORIES[category].includes(key));
    if (Object.hasOwn(walkEntries, key)) groups.push('culture');
    if (Object.hasOwn(locations, key) && (!groups.length || ['huaqiangbei', 'sea-world', 'kk100'].includes(key))) groups.push('landmark');
    categories.set(key, groups);
  }
  for (const region of regions) {
    const category = MENU_REGIONS[region.id];
    const anchor = region.anchors[0];
    if (!category || !anchor || !region.name) continue;
    const [x, z] = anchor;
    const key = `region-${region.source.osmId.replace('/', '-')}`;
    entries[key] = { x, z, name: region.name, waypoint: { x, z, name: region.name } };
    categories.set(key, [category]);
  }
  const buttons = populateTeleportMenu(entries, locationLabel, categories);
  return { entries, buttons };
}
