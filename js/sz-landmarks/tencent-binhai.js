import { baseAt, footprintParts } from './parts.js';
import { approach, column } from './model-profile.js';

// 文化连层由 0–14 米裙房与 14–35 米上段组成。
const SOUTH_TOWER = 'way/694152192';
const NORTH_TOWER = 'way/694152193';
const CULTURE_BASE = 'way/775462996';
const CULTURE_UPPER = 'way/601101655';
const HEALTH_LINK = 'way/775462995';
const KNOWLEDGE_LINK = 'way/775462997';
const sourceIds = [SOUTH_TOWER, NORTH_TOWER, CULTURE_BASE, CULTURE_UPPER, HEALTH_LINK, KNOWLEDGE_LINK];

function build(buildings, terrain, { heightAt } = {}) {
  const south = buildings.get(SOUTH_TOWER);
  const north = buildings.get(NORTH_TOWER);
  const base = buildings.get(CULTURE_BASE);
  const upper = buildings.get(CULTURE_UPPER);
  const health = buildings.get(HEALTH_LINK);
  const knowledge = buildings.get(KNOWLEDGE_LINK);
  // 共用场地标高，铜色连层不会因分别采样桥心地高而错层。保留西侧入口凹口和柱间。
  const podiumY = baseAt(base, terrain);
  const feet = [-10, 10].map(dz => ({ x: base.minX + 5, z: base.cz + dz }));
  return [
    ...footprintParts(south, podiumY, 'tencentTower', { roofContact: true, baseSourceId: base.id }),
    ...footprintParts(north, podiumY, 'tencentTower', { roofContact: true, baseSourceId: base.id }),
    ...footprintParts(base, podiumY, 'tencentPodium', { topFace: false }),
    ...footprintParts(upper, podiumY, 'tencentCopper', { baseSourceId: base.id }),
    ...footprintParts(health, podiumY, 'tencentCopper', { baseSourceId: base.id }),
    ...footprintParts(knowledge, podiumY, 'tencentCopper', { baseSourceId: base.id }),
    ...feet.map((p, i) => column(`tencent-binhai:porch-column:${i}`, upper, p, 0.7,
      (heightAt?.(p.x, p.z) ?? podiumY) - 0.35, podiumY + 14.3, 'landmarkEdge'))
  ];
}

function approaches(buildings) {
  const base = buildings.get(CULTURE_BASE);
  return [approach({ x: base.minX + 1, z: base.cz }, { x: base.minX - 26, z: base.cz }, 6)];
}

export { sourceIds, build, approaches };
