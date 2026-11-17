const ESTIMATED_LANE_WIDTH_M = 3.25;
const MAX_DISPLAY_LANES = 8;
const MAX_LANES_PER_DIRECTION = 4;
const DECK_SHOULDER_M = 0.5;
const DECK_BARRIER_M = 0.35;
const groundSections = new WeakMap();
const deckSections = new WeakMap();

// 桥面按“每方向 1–4 车道”分类：6.5 m 匝道读成 2 车道，不再用统一最小宽度撑成空白双车道。
// 宽度 = 车道数 × 3.25 m + 两侧各 0.5 m 路肩 + 两侧 0.35 m 护栏，显示、碰撞和标线共用。
export function deckLaneProfile(link) {
  const [, , , sourceWidthM, taggedLanes, direction] = link;
  const twoWay = direction === 0;
  const tagged = Number.isInteger(taggedLanes) && taggedLanes > 0 ? taggedLanes : 0;
  const estimated = Math.max(1, Math.floor((Number(sourceWidthM) + 0.25) / ESTIMATED_LANE_WIDTH_M / (twoWay ? 2 : 1)));
  const perDirection = Math.min(MAX_LANES_PER_DIRECTION,
    Math.max(1, tagged ? (twoWay ? Math.max(1, Math.round(tagged / 2)) : tagged) : estimated));
  const laneCount = twoWay ? perDirection * 2 : perDirection;
  // 设计宽度只是下限：OSM 的宽桥面不能被车道数压窄，否则 61.8 m 主线会只剩 14.7 m。
  const designWidthM = laneCount * ESTIMATED_LANE_WIDTH_M + 2 * DECK_SHOULDER_M + 2 * DECK_BARRIER_M;
  return {
    twoWay, perDirection, laneCount,
    widthM: Math.max(Number.isFinite(sourceWidthM) ? sourceWidthM : 0, designWidthM),
    designWidthM
  };
}
const centeredLanes = (count, laneWidthM, travelWidthM) => Object.freeze(
  Array.from({ length: count }, (_, i) => (i + 0.5) * laneWidthM - travelWidthM / 2));
const offsetsFromRight = centers => Object.freeze(centers.map(center => center === 0 ? 0 : -center).reverse());

function createSection(link, metadata, deck) {
  const [, , , sourceWidthM, taggedLanes, direction] = link;
  const sourceLaneCount = deck?.lanes || taggedLanes;
  const twoWay = direction === 0;
  const reviewed = Boolean(metadata.crossSection);
  const pavementWidthM = deck?.width ?? sourceWidthM;
  // 桥面车道数由 deckLaneProfile 在派生几何时一并定下，显示宽度和标线不再各自估算。
  const estimate = Math.floor(sourceWidthM / ESTIMATED_LANE_WIDTH_M);
  const laneCount = deck
    ? Math.min(MAX_DISPLAY_LANES, Math.max(twoWay ? 2 : 1, deck.laneCount ?? estimate))
    : Math.min(MAX_DISPLAY_LANES, Math.max(twoWay ? 2 : 1, sourceLaneCount || estimate));
  // 车道按固定 3.25 m 翼展排布；比设计宽度多出来的铺装留作路肩，不能被摊进车道宽。
  const travelWidthM = deck
    ? Math.min(pavementWidthM - 2 * (deck.barrierWidthM ?? 0), laneCount * ESTIMATED_LANE_WIDTH_M)
    : reviewed ? sourceLaneCount * metadata.crossSection.laneWidthM : pavementWidthM;
  const forwardCount = twoWay ? Math.ceil(laneCount / 2) : direction === 1 ? laneCount : 0;
  const backwardCount = laneCount - forwardCount;
  const splitM = twoWay ? deck ? travelWidthM * (forwardCount / laneCount - 0.5) : 0 : null;
  const forwardWidthM = twoWay ? travelWidthM / 2 + splitM : travelWidthM;
  const backwardWidthM = twoWay ? travelWidthM / 2 - splitM : travelWidthM;
  // 车道中心的断面坐标以本方向左侧为正；两向道路各方向的车道从本侧路缘向分界线排列。
  const forwardLaneWidthM = forwardCount ? forwardWidthM / forwardCount : null;
  const backwardLaneWidthM = backwardCount ? backwardWidthM / backwardCount : null;
  // 正向车道从行进左侧（负偏距）起排，反向车道从对侧起排；两向的中心不能重合在同一半幅。
  const forwardCentersM = centeredLanes(forwardCount, forwardLaneWidthM, travelWidthM);
  // 双向的反向车道位于分界线另一侧；若也按整幅居中会与正向车道重叠，这里按反向行驶方向从右路缘排起。
  const backwardCentersM = twoWay
    ? Object.freeze(Array.from({ length: backwardCount },
      (_, i) => travelWidthM / 2 - (i + 0.5) * backwardLaneWidthM))
    : centeredLanes(backwardCount, backwardLaneWidthM, travelWidthM);
  const dividerOffsetsM = [];
  const leftCount = twoWay ? forwardCount : laneCount;
  const leftLaneWidthM = direction === -1 ? backwardLaneWidthM : forwardLaneWidthM;
  for (let i = 1; i < leftCount; i++) dividerOffsetsM.push(-travelWidthM / 2 + i * leftLaneWidthM);
  if (twoWay) {
    for (let i = 1; i < backwardCount; i++) dividerOffsetsM.push(travelWidthM / 2 - i * backwardLaneWidthM);
  }
  const estimated = sourceLaneCount === 0;
  const defaultRightOffsetM = twoWay ? Math.min(pavementWidthM / 4, 2.3) : 0;
  // 双向的普通路线沿用保守右偏距；未核单向车道数时不把标线估计用作自动驾驶车道。
  const defaultOffsetsM = Object.freeze([defaultRightOffsetM]);
  // 超宽单向道路的标线有绘制上限，已知的车道仍完整供路线选择；双向由 laneOffsets 只取正向半幅。
  const routeCentersM = twoWay ? null : sourceLaneCount > laneCount
    ? centeredLanes(sourceLaneCount, travelWidthM / sourceLaneCount, travelWidthM)
    : direction === 1 ? forwardCentersM : backwardCentersM;
  const section = {
    sourceId: deck?.osmId ?? metadata.osmId ?? null,
    surfaceId: deck?.surfaceId ?? 'terrain',
    layer: deck?.layer ?? metadata.layer ?? 0,
    widthSource: metadata.widthSource ?? null,
    laneSource: deck?.laneSource ?? metadata.crossSection?.laneCountSource ?? (estimated ? 'width-estimate' : 'osm-lanes'),
    sourceWidthM, pavementWidthM, travelWidthM, sourceLaneCount, laneCount, estimated, reviewed, direction, twoWay, splitM,
    narrow: pavementWidthM < 7 || (twoWay && laneCount <= 2),
    forwardLaneWidthM, backwardLaneWidthM, forwardCentersM, backwardCentersM,
    dividerOffsetsM: Object.freeze(dividerOffsetsM),
    defaultOffsetsM,
    routeCentersM
  };
  section.routeOffsetsM = laneOffsets(section) ?? defaultOffsetsM;
  return Object.freeze(section);
}

// 已核实断面或 OSM 明确标注的车道才可信；纯宽度估计只画标线，不据此派车。
function verifiedLanes(section) {
  return Boolean(section.reviewed) || (section.laneSource === 'osm-lanes' && !section.estimated);
}

// 沿边行驶方向的车道中心偏移（米，正=行驶方向右侧）。数组按坐标升序：
// 首位最靠分界线，末位最靠右侧路缘。双向只取正向半幅，反向车道在分界线另一侧。
// 返回 null 表示断面车道不可信，调用方应回退到保守偏移。
export function laneOffsets(section) {
  if (!verifiedLanes(section)) return null;
  return offsetsFromRight(section.twoWay ? section.forwardCentersM : section.routeCentersM);
}

// 路网与桥面计划在场景生命周期内固定，渲染和双向行车边读取同一个断面结果。
export function getRoadSection(graph, index) {
  let sections = groundSections.get(graph);
  if (!sections) groundSections.set(graph, sections = []);
  return sections[index] ??= createSection(graph.links[index], graph.metadata[index]);
}

export function getDeckSection(graph, deck) {
  if (!deckSections.has(deck)) {
    const link = graph.links[deck.index] ?? [null, null, null, deck.width, deck.lanes ?? 0, deck.direction ?? 0];
    deckSections.set(deck, createSection(link, graph.metadata[deck.index] ?? {}, deck));
  }
  return deckSections.get(deck);
}

export function usableWidth({ section }, halfWidth) {
  return section.travelWidthM >= (section.twoWay ? 4 : 2) * halfWidth + 0.16;
}
