// 普通建筑的规划事实：商圈归属、基础体量排除和近景输入收成同一份。
// 基础楼体与近景不再各自解释“这栋楼属于谁、是否应该出细节”；
// 本模块不读全局 GEO，调用方必须用同一批建筑对象和同一份商圈区域调用，
// 局部 fixture 才不会混入全城索引。

/** 解析：把商圈区域的 buildingRefs 映射到同一批建筑对象的 id。
 *  输入：regions（商圈区域表）、buildings（与 regions 同源的建筑数组）。
 *  输出：Set<string>；refs 越界或建筑缺 id 时跳过，不在两套数据之间猜身份。 */
export function retailBuildingIdsFromRegions(regions, buildings) {
  const ids = new Set();
  if (!Array.isArray(regions) || !Array.isArray(buildings)) return ids;
  for (const region of regions) {
    if (region?.type !== 'retail' || !Array.isArray(region.buildingRefs)) continue;
    for (const ref of region.buildingRefs) {
      const id = buildings[ref]?.id;
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

/** 解析：基础楼体交给近景的完整输入包。
 *  输入：同一次 buildCityBlocks 使用的原始 buildings/terrain、基础排除身份、
 *        基础屋顶占用和 envelope 计划。
 *  输出：{ buildings, terrain, skipIds, roofPlans, retailBuildingIds, envelopePlans }。
 *  skipIds 合并 skipIds、重复体量和道路冲突；近景不再自己拼 detailSkipIds。 */
export function createBuildingDetailPlan({
  buildings, terrain, skipIds, duplicateIds, roadConflicts,
  roofPlans, retailBuildingIds, envelopePlans
} = {}) {
  if (!Array.isArray(buildings)) throw new Error('Building detail plan requires a building list');
  if (!terrain) throw new Error('Building detail plan requires terrain');
  const excluded = new Set(skipIds ?? []);
  for (const id of duplicateIds?.keys() ?? []) excluded.add(id);
  for (const row of roadConflicts ?? []) {
    if (row?.buildingId !== undefined) excluded.add(row.buildingId);
  }
  return {
    buildings, terrain, skipIds: excluded,
    roofPlans: roofPlans ?? new Map(),
    retailBuildingIds: retailBuildingIds ?? new Set(),
    envelopePlans: envelopePlans ?? new Map()
  };
}
