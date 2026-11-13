import { terrainHeight } from './sz-terrain.js';

export function buildingPlacement(building, grid) {
  const foundationBottomY = building.foundation?.bottomY ?? null;
  const baseY = building.foundation?.baseY ?? terrainHeight(grid, building.cx, building.cz);
  if (baseY === null) throw new Error(`Missing building terrain: ${building.id}`);
  const minY = baseY + building.minHeight;
  // 显示缓冲为 Float32，屋面接触和近景部件使用同一精度。
  const maxY = Math.fround(baseY + building.height);
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) {
    throw new Error(`Invalid building vertical bounds: ${building.id}`);
  }
  // DEM 锚点是派生放置基准，并非建筑测绘的基础标高；显示和碰撞共用它。
  const colliders = building.polygons.map(polygon => ({
    type: 'building', name: building.id, sourceId: building.id, polygon,
    minX: building.minX, maxX: building.maxX, minZ: building.minZ, maxZ: building.maxZ,
    minY: foundationBottomY ?? minY, maxY, heightSource: building.heightSource,
    baseSource: building.foundation ? 'modelled-footprint-foundation' : 'dem-footprint-bounds-center'
  }));
  return { baseY, minY, maxY, foundationBottomY, colliders };
}

export function buildingSeed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h / 4294967296;
}
