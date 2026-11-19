// 城市立交采用估计断面。同一源节点只分配一个标高，所有道路消费者读取同一份派生路图。
export const DECK_RISE_M = 4.8;
const HIGH_DECK_RISE_M = 10.3;
const HIGH_DECK_ROADS = new Map([['南坪快速', 'trunk'], ['南光高速', 'motorway']]);
// 南光高速南头互通的一小段主线在源数据中记作匝道，两端均只接南光同向主线。
const NANGUANG_THROUGH_WAY = 'way/1081087778';

// OSM 的 layer 只表示相对上下关系。场景桥面采用两档估计抬升。
export function roadDeckLayer(metadata, name) {
  const layer = metadata.layer ?? 0;
  if (layer <= 0) return layer;
  if (metadata.nanpingMainline) return 2;
  const upperMainline = HIGH_DECK_ROADS.get(name) === metadata.highway && HIGH_DECK_ROADS.has(name);
  return !metadata.highwayProfile && !metadata.interchangeApproach
    && (upperMainline || metadata.osmId === NANGUANG_THROUGH_WAY) ? 2 : 1;
}

export function roadDeckRise(layer, metadata) {
  return layer === 2 ? (metadata?.nanpingMainline ? 10 : HIGH_DECK_RISE_M) : layer === 1 ? DECK_RISE_M : 0;
}
// 南光高速两幅主线与隧道在源节点直接接续，由两侧道路共同承担高差。
export const HIGH_DECK_TUNNEL_APPROACH_M = 84;
const NANGUANG_BORES = new Set(['way/25516495', 'way/183920372']);

export function highDeckTunnelPortals(graph) {
  const decks = new Map();
  for (const [index, meta] of graph.metadata.entries()) {
    const link = graph.links[index];
    if (meta.tunnel || roadDeckLayer(meta, graph.names[link[2]]) !== 2) continue;
    for (const node of link.slice(0, 2)) {
      if (!decks.has(node)) decks.set(node, []);
      decks.get(node).push(index);
    }
  }
  const portals = new Map();
  for (const [index, meta] of graph.metadata.entries()) {
    if (!meta.tunnel || (!meta.nanpingMainline && !NANGUANG_BORES.has(meta.osmId))) continue;
    const ends = new Map();
    for (const node of graph.links[index].slice(0, 2)) {
      const peers = decks.get(node)?.filter(peer => graph.links[peer][2] === graph.links[index][2]);
      if (peers?.length) ends.set(node, peers);
    }
    if (ends.size) portals.set(index, ends);
  }
  return portals;
}

// 下穿洞门只接共用源节点且标高一致的工程引道。
export function profiledUnderpassPortals(graph, underpass) {
  const portals = new Map();
  if (!underpass || !graph.metadata.some(meta => meta.explicitCorridorProfile)) return portals;
  const tunnels = new Set(underpass.tunnels);
  const approaches = new Map();
  for (const [index, link] of graph.links.entries()) {
    const meta = graph.metadata[index];
    if (!meta.explicitCorridorProfile) continue;
    for (const [side, node] of link.slice(0, 2).entries()) {
      const z = graph.nodes[2 * node + 1];
      const y = underpass.boreFloorM + underpass.approachGrade *
        Math.max(0, underpass.northPortalZ - z, z - underpass.southPortalZ);
      if (Math.abs(meta.highwayProfile[side] - y) > 0.01) continue;
      if (!approaches.has(node)) approaches.set(node, []);
      approaches.get(node).push(index);
    }
  }
  for (const [index, link] of graph.links.entries()) {
    if (!tunnels.has(graph.metadata[index].osmId)) continue;
    const ends = new Map(link.slice(0, 2).filter(node => approaches.has(node)).map(node => [node, approaches.get(node)]));
    if (ends.size) portals.set(index, ends);
  }
  return portals;
}

const APPROACH_M = 64;
// 两端各留 8 米竖曲线，中央等坡；有效引道长度沿源路里程计算。
export function interchangeRise(distance) {
  const curveM = 8;
  const run = Math.max(0, Math.min(APPROACH_M, distance));
  const grade = DECK_RISE_M / (APPROACH_M - curveM);
  if (run < curveM) return grade * run ** 2 / (2 * curveM);
  if (run > APPROACH_M - curveM) return DECK_RISE_M - grade * (APPROACH_M - run) ** 2 / (2 * curveM);
  return grade * (run - curveM / 2);
}

function edgeGeometry(graph, edge) {
  const { nodes } = graph;
  const [start, end, , , , , inner] = edge;
  const points = [nodes[start * 2], nodes[start * 2 + 1], ...inner, nodes[end * 2], nodes[end * 2 + 1]];
  const lengths = [0];
  for (let i = 2; i < points.length; i += 2) {
    lengths.push(lengths.at(-1) + Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]));
  }
  return { points, lengths, length: lengths.at(-1) };
}

function intersectsArea(points, area) {
  for (let i = 2; i < points.length; i += 2) {
    if (Math.min(points[i], points[i - 2]) <= area.maxX && Math.max(points[i], points[i - 2]) >= area.minX
      && Math.min(points[i + 1], points[i - 1]) <= area.maxZ && Math.max(points[i + 1], points[i - 1]) >= area.minZ) return true;
  }
  return false;
}

export function applyInterchangeLevels(graph, areas) {
  if (!areas?.length) return graph;
  const { links, metadata, names } = graph;
  const result = metadata.slice();
  const incident = new Map();
  for (const [index, edge] of links.entries()) {
    for (const node of edge.slice(0, 2)) {
      if (!incident.has(node)) incident.set(node, []);
      incident.get(node).push(index);
    }
  }
  const isGround = meta => !meta.bridge && !meta.layer && !meta.tunnel && meta.heightSource === 'terrain';
  for (const area of areas) {
    const chegongmiao = area.id === 'chegongmiao';
    const bridgeWays = new Set();
    const groundWays = new Set(area.groundWays);
    for (const [index, meta] of metadata.entries()) {
      if (meta.tunnel || (!meta.bridge && !(meta.layer > 0))) continue;
      if (!intersectsArea(edgeGeometry(graph, links[index]).points, area.area)) continue;
      if (meta.bridge) bridgeWays.add(meta.osmId);
      else groundWays.add(meta.osmId);
    }
    const lengths = new Map();
    for (const [index, meta] of metadata.entries()) {
      if (!meta.tunnel && bridgeWays.has(meta.osmId) && !groundWays.has(meta.osmId)) {
        lengths.set(index, edgeGeometry(graph, links[index]).length);
      } else if (groundWays.has(meta.osmId)) {
        result[index] = { ...meta, layer: 0, bridge: false, tunnel: false, heightSource: 'terrain' };
      }
    }
    // 只有明确的直续地面边能借作引道，分叉或不明去向的节点留在地面。
    const borrowed = new Map();
    for (const [index, length] of lengths) {
      if (length >= APPROACH_M) continue;
      const edge = links[index];
      for (const node of edge.slice(0, 2)) {
        const peers = incident.get(node);
        if (peers.length !== 2) continue;
        const peer = peers.find(candidate => candidate !== index);
        if (!isGround(result[peer]) || lengths.has(peer) || borrowed.has(peer)) continue;
        const continuation = links[peer];
        if (!names[edge[2]] || edge[2] !== continuation[2] || edge[5] !== continuation[5]
          || (edge[5] !== 0 && (node === edge[0]) === (node === continuation[0]))) continue;
        const run = edgeGeometry(graph, continuation).length;
        const used = Math.min(run, APPROACH_M);
        // 用原有接点和边身份，剩余部分的标高保持贴地。
        if (used + length < APPROACH_M) continue;
        borrowed.set(peer, { length: run, delay: run - used, side: node === continuation[0] ? 1 : 0 });
      }
    }
    for (const [index, { length }] of borrowed) lengths.set(index, length);
    const distance = new Map();
    const queue = [];
    for (const index of lengths.keys()) {
      for (const node of links[index].slice(0, 2)) {
        if (distance.has(node) || !incident.get(node).some(peer => !lengths.has(peer) && isGround(result[peer]))) continue;
        distance.set(node, 0);
        queue.push(node);
      }
    }
    // 只传播到 64 米内，短段和分流两侧共享同一个引道里程。
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      for (const index of incident.get(node)) {
        if (!lengths.has(index)) continue;
        const [a, b] = links[index];
        const peer = node === a ? b : a;
        const next = distance.get(node) + lengths.get(index) - (borrowed.get(index)?.delay ?? 0);
        if (next >= (distance.get(peer) ?? APPROACH_M)) continue;
        distance.set(peer, next);
        queue.push(peer);
      }
    }
    for (const index of lengths.keys()) {
      const [a, b] = links[index];
      const extension = borrowed.get(index);
      const approach = { id: area.id, start: distance.get(a) ?? APPROACH_M, end: distance.get(b) ?? APPROACH_M,
        delayStart: extension?.side === 0 ? extension.delay : 0,
        delayEnd: extension?.side === 1 ? extension.delay : 0,
        deckY: chegongmiao ? area.groundY + DECK_RISE_M : undefined };
      result[index] = { ...result[index], layer: 1, bridge: true, heightSource: 'estimate', interchangeApproach: approach };
    }
  }
  return { ...graph, metadata: result };
}

// 构建期裁山、运行时铺装和洞底用同一组归一化里程控制点。
export function highwayProfileHeight(profile, fraction) {
  const curve = profile[4];
  if (!curve) return profile[0] + (profile[1] - profile[0]) * fraction;
  if (fraction <= 0) return profile[0];
  const next = curve.findIndex(([station], index) => index > 0 && fraction <= station);
  if (next < 0) return profile[1];
  const [start, y] = curve[next - 1];
  const [end, nextY] = curve[next];
  return y + (nextY - y) * (fraction - start) / (end - start);
}

export function applyCorridorRoadProfiles(graph, terrain) {
  const mapped = applyInterchangeLevels(graph, terrain?.interchangeLevels);
  const { g4Profiles, hongliUnderpass, nanpingProfile, roadCorridorProfiles, roadCorridorExtensions } = terrain ?? {};
  if (!g4Profiles && !hongliUnderpass && !nanpingProfile && !roadCorridorProfiles && !roadCorridorExtensions) return mapped;
  const nanpingLinks = new Map();
  const nanpingNodes = new Set();
  const nanpingName = mapped.names.indexOf(nanpingProfile?.name);
  if (nanpingProfile?.profiles) {
    for (const [index, link] of mapped.links.entries()) {
      const [a, b] = link;
      const { osmId } = mapped.metadata[index];
      const curve = nanpingProfile.profiles[`${osmId}:${mapped.nodeIds[a]}:${mapped.nodeIds[b]}`];
      if (!curve) continue;
      nanpingLinks.set(index, curve);
      nanpingNodes.add(a);
      nanpingNodes.add(b);
    }
  }
  const feeders = new Set(hongliUnderpass?.feeders);
  const tunnelWays = new Set(hongliUnderpass?.tunnels);
  const portals = new Set(mapped.links.flatMap((link, index) =>
    tunnelWays.has(mapped.metadata[index].osmId) ? link.slice(0, 2) : []));
  const links = nanpingName < 0 ? mapped.links : mapped.links.map((link, index) =>
    nanpingLinks.has(index) && link[2] !== nanpingName ? link.with(2, nanpingName) : link);
  return { ...mapped, links, metadata: mapped.metadata.map((meta, index) => {
    const curve = nanpingLinks.get(index);
    if (curve) {
      const alignment = { ...meta, nanpingMainline: true, heightSource: 'estimate',
        highwayProfile: [curve[0][1], curve.at(-1)[1], true, true, curve] };
      return meta.tunnel ? alignment : { ...alignment, layer: 2, bridge: true };
    }
    if (roadCorridorProfiles || roadCorridorExtensions) {
      const [a, b] = mapped.links[index];
      const key = `${meta.osmId}:${mapped.nodeIds[a]}:${mapped.nodeIds[b]}`;
      const corridor = roadCorridorExtensions?.[key] ?? roadCorridorProfiles?.[key];
      if (corridor) {
        const [startAtGrade, endAtGrade, stations] = corridor;
        return { ...meta, layer: 1, bridge: true,
          heightSource: 'estimate', explicitCorridorProfile: true,
          highwayProfile: [stations[0][1], stations.at(-1)[1], !startAtGrade, !endAtGrade, stations] };
      }
    }
    const profile = g4Profiles?.[index];
    if (profile) return { ...meta, layer: 1, bridge: true, tunnel: false, heightSource: 'estimate', highwayProfile: profile };
    if (feeders.has(meta.osmId) && mapped.links[index].slice(0, 2).some(node => portals.has(node))) {
      return { ...meta, layer: 0, bridge: false, tunnel: false, heightSource: 'terrain' };
    }
    if (!meta.tunnel && !meta.layer && meta.highway?.endsWith('_link')
      && mapped.links[index].slice(0, 2).some(node => nanpingNodes.has(node))) {
      return { ...meta, layer: 1, bridge: true, heightSource: 'estimate' };
    }
    return meta;
  }) };
}
