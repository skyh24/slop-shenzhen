export const ESTIMATED_LANE_WIDTH_M = 3.25;
const MAX_LANES = 5;
const DECK_SHOULDER_M = 0.5;
const DECK_BARRIER_M = 0.35;
const groundSections = new WeakMap();
const deckSections = new WeakMap();

const countLanes = (count, twoWay) => Math.min(MAX_LANES, Math.max(twoWay ? 2 : 1, count));

// 每幅桥面排 1–5 条车道。保留已有的结构设计宽度，不能因为重排标线把桥面或接缝削窄。
export function deckLaneProfile(link) {
  const [, , , sourceWidthM, taggedLanes, direction] = link;
  const twoWay = direction === 0;
  const tagged = Number.isInteger(taggedLanes) && taggedLanes > 0 ? taggedLanes : 0;
  const estimated = Math.max(1, Math.floor((Number(sourceWidthM) + 0.25) / ESTIMATED_LANE_WIDTH_M / (twoWay ? 2 : 1)));
  const structuralLanesPerDirection = Math.min(4,
    Math.max(1, tagged ? (twoWay ? Math.max(1, Math.round(tagged / 2)) : tagged) : estimated));
  const laneCount = countLanes(tagged || Math.floor(Number(sourceWidthM) / ESTIMATED_LANE_WIDTH_M), twoWay);
  const structuralLanes = Math.max(laneCount, structuralLanesPerDirection * (twoWay ? 2 : 1));
  const designWidthM = structuralLanes * ESTIMATED_LANE_WIDTH_M + 2 * DECK_SHOULDER_M + 2 * DECK_BARRIER_M;
  return {
    twoWay, perDirection: twoWay ? Math.ceil(laneCount / 2) : laneCount, laneCount,
    widthM: Math.max(Number.isFinite(sourceWidthM) ? sourceWidthM : 0, designWidthM),
    designWidthM
  };
}
const centeredLanes = (count, laneWidthM, travelWidthM) => Object.freeze(
  Array.from({ length: count }, (_, i) => (i + 0.5) * laneWidthM - travelWidthM / 2));
const offsetsFromRight = centers => Object.freeze(centers.map(center => center === 0 ? 0 : -center).reverse());

function createSection(link, metadata, deck) {
  const [, , , sourceWidthM, taggedLanes, direction] = link;
  const sourceLaneCount = deck?.lanes || taggedLanes || 0;
  const twoWay = direction === 0;
  const reviewed = Boolean(metadata.crossSection);
  const pavementWidthM = deck?.width ?? sourceWidthM;
  // 桥面车道数由 deckLaneProfile 在派生几何时一并定下，显示宽度和标线不再各自估算。
  const estimate = Math.floor(sourceWidthM / ESTIMATED_LANE_WIDTH_M);
  const uncappedCount = deck?.laneCount ?? (sourceLaneCount || estimate);
  const laneCount = !deck && twoWay && pavementWidthM < 7 ? 2 : countLanes(uncappedCount, twoWay);
  const barrierWidthM = deck ? deck.barrierWidthM ?? DECK_BARRIER_M : 0;
  // 超宽铺装的多余空间留给两侧，标线和路线都使用同一套车道。
  const travelWidthM = deck
    ? Math.min(pavementWidthM - 2 * barrierWidthM, laneCount * ESTIMATED_LANE_WIDTH_M)
    : reviewed ? Math.min(pavementWidthM, laneCount * metadata.crossSection.laneWidthM)
    : uncappedCount > MAX_LANES ? Math.min(pavementWidthM, laneCount * ESTIMATED_LANE_WIDTH_M) : pavementWidthM;
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
  const section = {
    sourceId: deck?.osmId ?? metadata.osmId ?? null,
    surfaceId: deck?.surfaceId ?? 'terrain',
    layer: deck?.layer ?? metadata.layer ?? 0,
    widthSource: metadata.widthSource ?? null,
    laneSource: deck?.laneSource ?? metadata.crossSection?.laneCountSource ?? (estimated ? 'width-estimate' : 'osm-lanes'),
    sourceWidthM, pavementWidthM, travelWidthM, barrierWidthM, sourceLaneCount, laneCount, estimated, reviewed, direction, twoWay, splitM,
    narrow: pavementWidthM < 7 || (twoWay && laneCount <= 2),
    forwardLaneWidthM, backwardLaneWidthM, forwardCentersM, backwardCentersM,
    dividerOffsetsM: Object.freeze(dividerOffsetsM),
    defaultOffsetsM,
    forwardOffsetsM: offsetsFromRight(forwardCentersM),
    backwardOffsetsM: Object.freeze(twoWay ? [...backwardCentersM].reverse() : [...backwardCentersM])
  };
  section.routeOffsetsM = laneOffsets(section) ?? defaultOffsetsM;
  return Object.freeze(section);
}

// 已核实断面或 OSM 明确标注的车道才可信；纯宽度估计只画标线，不据此派车。
function verifiedLanes(section) {
  return Boolean(section.reviewed) || (section.laneSource === 'osm-lanes' && !section.estimated);
}

// 沿边行驶方向的车道中心偏移（米，正=行驶方向右侧）。数组按坐标升序：
// 双向分别读取本侧。反向须先转换断面坐标，再按行驶方向从左往右排序。
// 返回 null 表示断面车道不可信，调用方应回退到保守偏移。
export function laneOffsets(section, sign = section.direction || 1) {
  if (!verifiedLanes(section)) return null;
  return sign === 1 ? section.forwardOffsetsM : section.backwardOffsetsM;
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

// 优先选近直线的同类主线双臂；斜接辅道即使同宽、没有匝道标签，也不参与主线收宽。
export function throughRoadArms(arms) {
  if (arms.length < 3) return null;
  let pair = null;
  let best = -Infinity;
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    for (let j = i + 1; j < arms.length; j++) {
      const b = arms[j];
      if (a.kind?.endsWith('_link') || a.kind !== b.kind) continue;
      const straight = -(a.dx * b.dx + a.dz * b.dz);
      const named = a.name && a.name === b.name;
      if (straight < 0.94 || (!named && straight < 0.985 && !['motorway', 'trunk', 'primary'].includes(a.kind))) continue;
      const width = Math.min(a.width, b.width);
      if (!arms.some(c => {
        if (c === a || c === b) return false;
        const angle = Math.max(a.dx * c.dx + a.dz * c.dz, b.dx * c.dx + b.dz * c.dz);
        return c.kind?.endsWith('_link') || c.width < width * 0.82
          || (angle >= 0.72 && angle < straight - 0.005);
      })) continue;
      const score = (named ? 20 : 0) + 10 * straight + width;
      if (score > best) { best = score; pair = [a, b]; }
    }
  }
  return pair;
}
