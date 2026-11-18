import { terrainHeight } from './sz-terrain.js';

function lowestOuterCorner(building, grid) {
  let low = null;
  for (const { outer } of building.polygons) {
    for (const { x, z } of outer) {
      const y = terrainHeight(grid, x, z);
      if (y === null) return null;
      low = low === null ? y : Math.min(low, y);
    }
  }
  return low;
}

export function buildingPlacement(building, grid) {
  const foundationBottomY = building.foundation?.bottomY ?? null;
  // 普通落地体块保持水平，底面落在实际外轮廓的最低角；架空件和专模保留原基准。
  const groundAtCorners = building.minHeight === 0 && !building.landmark
    && building.role !== 'bridge' && building.role !== 'canopy';
  const baseY = building.foundation?.baseY ?? (groundAtCorners
    ? lowestOuterCorner(building, grid) : terrainHeight(grid, building.cx, building.cz));
  const baseSource = building.foundation ? 'modelled-footprint-foundation'
    : groundAtCorners ? 'dem-footprint-lowest-corner' : 'dem-footprint-bounds-center';
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
    minY: foundationBottomY ?? minY, maxY, heightSource: building.heightSource, baseSource
  }));
  return { baseY, minY, maxY, foundationBottomY, baseSource, colliders };
}

export function buildingSeed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h / 4294967296;
}
