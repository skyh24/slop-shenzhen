export const ROAD_TUNNEL_CLEARANCE_M = 5.2;
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
  const routeCentersM = twoWay ? null : !deck && sourceLaneCount > laneCount
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

// 道路三岔口优先选同名、近直线的主线双臂；附属匝道不参与主线收宽。
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
      if (straight < 0.94 || (!named && !['motorway', 'trunk', 'primary'].includes(a.kind))) continue;
      const width = Math.min(a.width, b.width);
      if (!arms.some(c => c !== a && c !== b && (c.kind?.endsWith('_link') || c.width < width * 0.82))) continue;
      const score = (named ? 20 : 0) + 10 * straight + width;
      if (score > best) { best = score; pair = [a, b]; }
    }
  }
  return pair;
}

// 连续车行边共用入口断面；地面端保持原路缘，桥隧端沿一段长度平顺过渡。
export function prepareRoadJoinSections(graph) {
  if (!graph || graph.joinSectionsPrepared) return graph;
  const nodes = new Map(), metadata = graph.metadata.map(meta => ({ ...meta }));
  const structured = meta => meta.bridge || meta.tunnel || meta.layer || meta.mountainTunnel;
  graph.links.forEach((link, index) => {
    const meta = metadata[index];
    if (['footway', 'path', 'steps', 'cycleway', 'pedestrian'].includes(meta.highway)) return;
    const points = [{ x: graph.nodes[link[0] * 2], z: graph.nodes[link[0] * 2 + 1] }];
    for (let i = 0; i < link[6].length; i += 2) points.push({ x: link[6][i], z: link[6][i + 1] });
    points.push({ x: graph.nodes[link[1] * 2], z: graph.nodes[link[1] * 2 + 1] });
    for (const [side, node] of link.slice(0, 2).entries()) {
      const p = side ? points.at(-1) : points[0], q = side ? points.at(-2) : points[1];
      const run = Math.hypot(q.x - p.x, q.z - p.z);
      if (!run) continue;
      const structure = structured(meta);
      const width = structure ? Math.max(meta.mountainTunnel?.width ?? 0, deckLaneProfile(link).widthM) : link[3];
      if (structure) meta.junctionWidthM = width;
      if (!nodes.has(node)) nodes.set(node, []);
      nodes.get(node).push({ index, side, structure, width, kind: meta.highway, name: graph.names[link[2]], dx: (q.x - p.x) / run, dz: (q.z - p.z) / run });
    }
  });
  for (const arms of nodes.values()) {
    const pair = arms.length === 2 ? arms : throughRoadArms(arms);
    if (!pair || !pair.some(arm => arm.structure)) continue;
    const [a, b] = pair, ground = pair.find(arm => !arm.structure);
    // 原地面断面优先；结构之间用两条切线的角平分线，左右墙不会在弯接点张开缝隙。
    let dx = ground ? -ground.dx : a.dx - b.dx, dz = ground ? -ground.dz : a.dz - b.dz;
    const run = Math.hypot(dx, dz);
    if (run < 0.1) continue;
    dx /= run; dz /= run;
    const widthM = Math.max(a.width, b.width);
    for (const arm of pair) {
      if (!arm.structure) continue;
      const sign = Math.sign(dx * arm.dx + dz * arm.dz) * (arm.side ? -1 : 1);
      (metadata[arm.index].junctionSections ??= [null, null])[arm.side] = { nx: dz * sign, nz: -dx * sign, widthM };
    }
  }
  return { ...graph, metadata, joinSectionsPrepared: true };
}

export function applyRoadJoinFrames(frames, metadata) {
  if (!metadata.junctionSections || frames.length < 2) return frames;
  const length = frames.at(-1).d;
  for (const [side, section] of metadata.junctionSections.entries()) {
    if (!section) continue;
    const portal = side ? frames.at(-1) : frames[0], reach = Math.min(32, length / 2);
    for (const frame of frames) {
      const blend = Math.max(0, 1 - Math.abs(frame.d - portal.d) / reach);
      if (!blend) continue;
      const nx = frame.nx + (section.nx - frame.nx) * blend;
      const nz = frame.nz + (section.nz - frame.nz) * blend;
      const norm = Math.hypot(nx, nz);
      const width = frame.widthM ?? Math.hypot(frame.left.x - frame.right.x, frame.left.z - frame.right.z);
      frame.widthM = width + (section.widthM - width) * blend;
      frame.nx = nx / norm; frame.nz = nz / norm;
      frame.left = { ...frame.left, x: frame.x + frame.nx * frame.widthM / 2, z: frame.z + frame.nz * frame.widthM / 2 };
      frame.right = { ...frame.right, x: frame.x - frame.nx * frame.widthM / 2, z: frame.z - frame.nz * frame.widthM / 2 };
    }
  }
  return frames;
}
