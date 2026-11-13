import { STR } from './sz-strings.js';
import { populateTeleportMenu } from './sz-ui.js';

// 来源与配准边界见 data/source/coco-park-entrance-evidence.md。
// 一期东南门外的模拟走线沿现有地面，起点在福华三路北侧，终点停在门外。
const COCO_PARK_APPROACH = {
  id: 'coco-park-southeast-approach',
  start: { x: -498.3, z: 1201.7, heading: Math.PI, exact: true },
  stop: { x: -498.3, z: 1177.2 }
};

// 地点 ID 已由城市包或场地模块绑定；类别只影响菜单筛选。
const TELEPORT_CATEGORIES = {
  retail: ['huaqiangbei', 'upperhills', 'dongmen', 'sea-world', 'kk100', 'oh-bay', 'taizi-bay', COCO_PARK_APPROACH.id],
  park: ['talent-park', 'lianhuashan', 'shenzhen-bay-park'],
  culture: ['oct-loft', 'nantou-ancient-city', 'dongmen', 'sea-world', 'shenzhen-bay-culture-square'],
  amusement: ['window-of-world', 'oh-bay'],
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
  const approach = { ...start, name: STR.teleport.cocoParkApproach,
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
  const walkButton = buttons.find(button => button.dataset.teleport === id);
  function syncWalkApproach(mode) {
    for (const button of buttons) {
      if (walkEntries[button.dataset.teleport]?.walkOnly) button.disabled = mode !== 'person';
    }
    walkButton.disabled = mode !== 'person';
    walkButton.querySelector('.pop-sub').textContent = walkButton.disabled
      ? STR.teleport.walkOnly : STR.teleport.cocoParkApproachDetail;
  }
  return { entries, buttons, syncWalkApproach };
}
