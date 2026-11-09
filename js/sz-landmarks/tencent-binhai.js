import { baseAt, footprintParts } from './parts.js';

// 文化连层由 0–14 米裙房与 14–35 米上段组成。
const SOUTH_TOWER = 'way/694152192';
const NORTH_TOWER = 'way/694152193';
const CULTURE_BASE = 'way/775462996';
const CULTURE_UPPER = 'way/601101655';
const HEALTH_LINK = 'way/775462995';
const KNOWLEDGE_LINK = 'way/775462997';
const sourceIds = [SOUTH_TOWER, NORTH_TOWER, CULTURE_BASE, CULTURE_UPPER, HEALTH_LINK, KNOWLEDGE_LINK];

function build(buildings, terrain) {
  const south = buildings.get(SOUTH_TOWER);
  const north = buildings.get(NORTH_TOWER);
  const base = buildings.get(CULTURE_BASE);
  const upper = buildings.get(CULTURE_UPPER);
  const health = buildings.get(HEALTH_LINK);
  const knowledge = buildings.get(KNOWLEDGE_LINK);
  const podiumY = baseAt(base, terrain);
  return [
    ...footprintParts(south, baseAt(south, terrain), 'tencentTower', { roofContact: true }),
    ...footprintParts(north, baseAt(north, terrain), 'tencentTower', { roofContact: true }),
    ...footprintParts(base, podiumY, 'tencentPodium'),
    ...footprintParts(upper, podiumY, 'tencentCopper', { baseSourceId: base.id }),
    ...footprintParts(health, baseAt(health, terrain), 'tencentCopper'),
    ...footprintParts(knowledge, baseAt(knowledge, terrain), 'tencentCopper')
  ];
}

export { sourceIds, build };
