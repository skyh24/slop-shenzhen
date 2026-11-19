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
  // 源车行宽度之外另留路肩与护栏，桥面不能从源道路里扣掉这部分空间。
  const designWidthM = Math.max(Number(sourceWidthM) || 0, structuralLanes * ESTIMATED_LANE_WIDTH_M)
    + 2 * DECK_SHOULDER_M + 2 * DECK_BARRIER_M;
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
  const laneCount = twoWay && sourceWidthM < 7 ? 2 : countLanes(uncappedCount, twoWay);
  const barrierWidthM = deck ? deck.barrierWidthM ?? DECK_BARRIER_M : 0;
  // 超宽铺装的多余空间留给两侧，标线和路线都使用同一套车道。
  const travelWidthM = reviewed ? Math.min(sourceWidthM, laneCount * metadata.crossSection.laneWidthM)
    : (sourceLaneCount || estimate) > MAX_LANES ? Math.min(sourceWidthM, laneCount * ESTIMATED_LANE_WIDTH_M) : sourceWidthM;
  const forwardCount = twoWay ? Math.ceil(laneCount / 2) : direction === 1 ? laneCount : 0;
  const backwardCount = laneCount - forwardCount;
  const splitM = twoWay ? 0 : null;
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
  // 估计断面也沿画出的车道行驶，来源仍单独标记；不能回退到双车道的分隔线上。
  const defaultOffsetsM = direction === -1 ? Object.freeze([...backwardCentersM]) : offsetsFromRight(forwardCentersM);
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

// 沿边行驶方向的车道中心偏移（米，正=行驶方向右侧）。数组按坐标升序：
// 双向分别读取本侧。反向须先转换断面坐标，再按行驶方向从左往右排序。
// 估计车道与已核车道共享横位，是否实测仍由 laneSource/estimated 表达。
export function laneOffsets(section, sign = section.direction || 1) {
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
