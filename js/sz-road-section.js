const ESTIMATED_LANE_WIDTH_M = 3.25;
const MAX_DISPLAY_LANES = 8;
const groundSections = new WeakMap();
const deckSections = new WeakMap();
const centeredLanes = (count, laneWidthM, travelWidthM) => Object.freeze(
  Array.from({ length: count }, (_, i) => (i + 0.5) * laneWidthM - travelWidthM / 2));
const offsetsFromRight = centers => Object.freeze(centers.map(center => -center).reverse());

function createSection(link, metadata, deck) {
  const [, , , sourceWidthM, sourceLaneCount, direction] = link;
  const twoWay = direction === 0;
  const reviewed = Boolean(metadata.crossSection);
  const pavementWidthM = deck?.width ?? sourceWidthM;
  const travelWidthM = deck ? pavementWidthM - 2 * (deck.barrierWidthM ?? 0)
    : reviewed ? sourceLaneCount * metadata.crossSection.laneWidthM : pavementWidthM;
  // 桥面可能宽于源断面。桥上估计车道数沿用源宽度，铺装加宽不派生新车道。
  const classRamp = metadata.highway?.endsWith('_link') && metadata.widthSource === 'estimate-from-class';
  const estimate = deck
    ? classRamp ? 1 : Math.floor((Math.min(sourceWidthM, travelWidthM) + 0.25) / 3)
    : Math.floor(sourceWidthM / ESTIMATED_LANE_WIDTH_M);
  const laneCount = Math.min(MAX_DISPLAY_LANES, Math.max(twoWay && !deck ? 2 : 1, sourceLaneCount || estimate));
  const forwardCount = twoWay ? Math.ceil(laneCount / 2) : direction === 1 ? laneCount : 0;
  const backwardCount = laneCount - forwardCount;
  const splitM = twoWay ? deck ? travelWidthM * (forwardCount / laneCount - 0.5) : 0 : null;
  const forwardWidthM = twoWay ? travelWidthM / 2 + splitM : travelWidthM;
  const backwardWidthM = twoWay ? travelWidthM / 2 - splitM : travelWidthM;
  // 路径的正偏距朝行驶方向左侧。两向道路各方向的车道从本侧路缘向分界线排列。
  const forwardLaneWidthM = forwardCount ? forwardWidthM / forwardCount : null;
  const backwardLaneWidthM = backwardCount ? backwardWidthM / backwardCount : null;
  const forwardCentersM = centeredLanes(forwardCount, forwardLaneWidthM, travelWidthM);
  const backwardCentersM = centeredLanes(backwardCount, backwardLaneWidthM, travelWidthM);
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
  // 超宽单向道路的标线有绘制上限，已知的车道仍完整供路线选择。
  const routeCentersM = !twoWay && sourceLaneCount > laneCount
    ? centeredLanes(sourceLaneCount, travelWidthM / sourceLaneCount, travelWidthM)
    : direction === 1 ? forwardCentersM : backwardCentersM;
  return Object.freeze({
    sourceId: deck?.osmId ?? metadata.osmId ?? null,
    surfaceId: deck?.surfaceId ?? 'terrain',
    layer: deck?.layer ?? metadata.layer ?? 0,
    widthSource: metadata.widthSource ?? null,
    laneSource: metadata.crossSection?.laneCountSource ?? (estimated ? 'width-estimate' : 'osm-lanes'),
    sourceWidthM, pavementWidthM, travelWidthM, sourceLaneCount, laneCount, estimated, reviewed, direction, twoWay, splitM,
    narrow: pavementWidthM < 7 || (twoWay && laneCount <= 2),
    forwardLaneWidthM, backwardLaneWidthM, forwardCentersM, backwardCentersM,
    dividerOffsetsM: Object.freeze(dividerOffsetsM),
    defaultOffsetsM,
    routeOffsetsM: twoWay || estimated ? defaultOffsetsM
      : offsetsFromRight(routeCentersM)
  });
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
