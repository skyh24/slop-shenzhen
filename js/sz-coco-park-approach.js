import { STR } from './sz-strings.js';
import { populateTeleportMenu } from './sz-ui.js';

// 来源与配准边界见 data/source/coco-park-entrance-evidence.md。
// 一期东南门外的模拟走线沿现有地面，起点在福华三路北侧，终点停在门外。
const COCO_PARK_APPROACH = {
  id: 'coco-park-southeast-approach',
  start: { x: -498.3, z: 1201.7, heading: Math.PI, exact: true },
  stop: { x: -498.3, z: 1177.2 }
};

export function createTeleportMenu(locations, bayPark, locationLabel) {
  const { id, start, stop } = COCO_PARK_APPROACH;
  const approach = { ...start, name: STR.teleport.cocoParkApproach,
    waypoint: { ...stop, name: STR.teleport.cocoParkEntrance } };
  const entries = { ...locations, [id]: approach };
  if (bayPark) entries[bayPark.id] = bayPark;
  const buttons = populateTeleportMenu(entries, locationLabel);
  const walkButton = buttons.find(button => button.dataset.teleport === id);
  function syncWalkApproach(mode) {
    walkButton.disabled = mode !== 'person';
    walkButton.querySelector('.pop-sub').textContent = walkButton.disabled
      ? STR.teleport.walkOnly : STR.teleport.cocoParkApproachDetail;
  }
  return { entries, buttons, syncWalkApproach };
}
