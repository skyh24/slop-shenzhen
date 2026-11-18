import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { cutTerrainOpenings, roadLinkPoints } from './sz-roads.js';
import { roadDeckLayer, roadDeckRise } from './sz-interchange-levels.js';
import { terrainHeight } from './sz-terrain.js';

const MAX_APPROACH_M = 100;
const APPROACH_FALL = 0.055;
const ELEVATED_FORK_OPEN_M = 45;
// 以共同的源路端点识别施工范围，包括福龙路两处洞内分岔。
const CORRIDORS = [
  { bore: ['96327293'], ends: [['1116448854', '495113720'], ['1116448445', '96327311']] },
  { bore: ['96327299'], ends: [['1116449041', '248224196'], ['1116448622', '96327303']] },
  { bore: ['184296406'], ends: [['279961533', '680371233', ['614184043', '614184051']], ['279961534', '25680852']],
    merge: ['377694344', '3810814611', '614184067'] },
  { bore: ['227759791', '1467919582'], ends: [['2364215022', '589243212'], ['2364215039', '377693666']],
    merge: ['377695180', '3810829855', null, ['377695178']] }
];

function roadStations(points) {
  let distance = 0;
  return points.map((point, index) => {
    const previous = points[index - 1];
    if (previous) distance += Math.hypot(point.x - previous.x, point.z - previous.z);
    return { ...point, d: distance };
  });
}

function splitAt(points, distance) {
  const index = points.findIndex(point => point.d > distance + 1e-6);
  if (index < 0) return [points, []];
  const a = points[index - 1], b = points[index];
  if (Math.abs(a.d - distance) < 1e-6) return [points.slice(0, index), points.slice(index - 1)];
  const fraction = (distance - a.d) / (b.d - a.d);
  const cut = { x: a.x + (b.x - a.x) * fraction, z: a.z + (b.z - a.z) * fraction, d: distance };
  return [[...points.slice(0, index), cut], [cut, ...points.slice(index)]];
}

// 引道整条开敞。切口沿原路中心线逐段偏移，并向洞内搭接，给洞门留下净开口。
function openingRings(points, halfWidth, entryExtension = 0) {
  const sections = points.map((point, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
    const distance = i === 0 ? -entryExtension : i === points.length - 1 ? -0.08 : 0;
    const x = point.x + dx * distance, z = point.z + dz * distance;
    return [{ x: x + dz * halfWidth, z: z - dx * halfWidth },
      { x: x - dz * halfWidth, z: z + dx * halfWidth }];
  });
  return sections.slice(1).map((section, i) => [...sections[i], ...section]);
}

export function prepareMountainTunnels(city) {
  const { roadGraph: source, terrainSurface, terrain } = city;
  if (!source?.nodeIds || !terrainSurface) return city;
  const ground = createGroundSurfaceSampler(terrainSurface);
  const cuts = [];
  const graph = { ...source, nodes: [...source.nodes], nodeIds: [...source.nodeIds],
    links: [...source.links], metadata: [...source.metadata] };
  const lookup = new Map();
  source.metadata.forEach(({ osmId }, index) => {
    if (!lookup.has(osmId)) lookup.set(osmId, []);
    lookup.get(osmId).push(index);
  });
  const wayIndices = id => lookup.get(`way/${id}`) ?? [];
  const baseHeight = (x, z) => ground(x, z) ?? terrainHeight(terrain, x, z);
  const deckPeersAt = (peerIds, node) => peerIds.flatMap(wayIndices).filter(index =>
    source.links[index].slice(0, 2).includes(node));
  const deckHeightAt = (peer, groundY) => {
    const meta = source.metadata[peer];
    return groundY + roadDeckRise(roadDeckLayer(meta, source.names[source.links[peer][2]]), meta);
  };
  const findApproach = ([nodeId, wayId, peerIds = []]) => {
    const node = source.nodeIds.indexOf(`node/${nodeId}`);
    const index = wayIndices(wayId).find(i => source.links[i].slice(0, 2).includes(node));
    if (index === undefined) return null;
    const link = source.links[index];
    const atStart = node === link[0];
    const points = roadLinkPoints(source, link);
    const stations = roadStations(atStart ? points : points.reverse());
    const length = stations.at(-1).d;
    const [approach, remainder] = splitAt(stations, Math.min(MAX_APPROACH_M, length));
    const anchor = approach.at(-1);
    const sample = ground(anchor.x, anchor.z);
    if (!Number.isFinite(sample)) return null;
    const deckPeers = deckPeersAt(peerIds, atStart ? link[1] : link[0]);
    const anchorY = deckPeers.length ? deckHeightAt(deckPeers[0], sample) : sample;
    return { node, link, index, atStart, approach, remainder, anchorY, deckPeers,
      portalY: anchorY - anchor.d * APPROACH_FALL };
  };
  for (const corridor of CORRIDORS) {
    const bore = corridor.bore.flatMap(wayIndices).filter(index => source.metadata[index].tunnel);
    const ends = corridor.ends.map(findApproach);
    if (!bore.length || ends.some(end => !end)) continue;

    const floors = new Map(ends.map(end => [end.node, end.portalY]));
    const boreLength = bore.reduce((sum, index) => sum + source.metadata[index].lengthM, 0);
    let node = ends[0].node;
    let distance = 0;
    const orderedBore = [];
    const remaining = new Set(bore);
    while (remaining.size) {
      const index = [...remaining].find(i => source.links[i].slice(0, 2).includes(node));
      if (index === undefined) break;
      remaining.delete(index);
      orderedBore.push(index);
      const [a, b] = source.links[index];
      node = node === a ? b : a;
      distance += source.metadata[index].lengthM;
      if (!floors.has(node)) floors.set(node, ends[0].portalY + (ends[1].portalY - ends[0].portalY) * distance / boreLength);
    }
    if (remaining.size || node !== ends[1].node) continue;
    for (const index of orderedBore) {
      const [a, b] = source.links[index];
      graph.metadata[index] = { ...source.metadata[index], mountainTunnel: {
        startY: floors.get(a), endY: floors.get(b), bore: true, baseHeight,
        portalStart: ends.some(end => end.node === a), portalEnd: ends.some(end => end.node === b)
      } };
    }
    if (corridor.merge) {
      const [boreId, sourcePortal, approachId, peerIds = []] = corridor.merge;
      const branch = wayIndices(boreId).find(index => source.metadata[index].tunnel);
      const portal = source.nodeIds.indexOf(`node/${sourcePortal}`);
      const path = branch === undefined ? null : source.links[branch];
      const inner = path?.find((node, index) => index < 2 && node !== portal);
      if (path?.slice(0, 2).includes(portal) && floors.has(inner)) {
        const feeder = approachId && findApproach([sourcePortal, approachId]);
        const deckPeers = deckPeersAt(peerIds, portal);
        const sample = ground(source.nodes[portal * 2], source.nodes[portal * 2 + 1]);
        const portalY = feeder?.portalY ?? (deckPeers.length && Number.isFinite(sample) ? deckHeightAt(deckPeers[0], sample) : null);
        if (Number.isFinite(portalY)) {
          const portalStart = path[0] === portal;
          let openM = 0;
          if (deckPeers.length) {
            const points = roadLinkPoints(source, path);
            const stations = roadStations(portalStart ? points : points.reverse());
            const [opening, covered] = splitAt(stations, ELEVATED_FORK_OPEN_M);
            if (covered.length) {
              openM = opening.at(-1).d;
              cuts.push(...openingRings([...opening].reverse(), Math.max(path[3], 9) / 2 + 0.35, 1.2));
              const splitPoints = [...opening, ...covered.slice(1)];
              if (!portalStart) splitPoints.reverse();
              graph.links[branch] = [...path.slice(0, 6), splitPoints.slice(1, -1).flatMap(({ x, z }) => [x, z])];
            }
          }
          graph.metadata[branch] = { ...source.metadata[branch], mountainTunnel: {
            startY: portalStart ? portalY : floors.get(inner), endY: portalStart ? floors.get(inner) : portalY,
            bore: true, portalStart: portalStart && !openM, portalEnd: !portalStart && !openM,
            openStartM: portalStart ? openM : 0, openEndM: portalStart ? 0 : openM, baseHeight,
            deckPortals: deckPeers.length ? [[portal, deckPeers]] : []
          } };
          if (feeder) ends.push(feeder);
        }
      }
    }
    for (const end of ends) {
      const { link, index, atStart, approach, remainder, anchorY, portalY, deckPeers } = end;
      const [a, b, name, width, lanes, direction] = link;
      let anchorNode = atStart ? b : a;
      if (remainder.length) {
        anchorNode = graph.nodeIds.length;
        const anchor = approach.at(-1);
        graph.nodes.push(anchor.x, anchor.z);
        graph.nodeIds.push(`junction/mountain-tunnel/${source.nodeIds[end.node]}`);
        const inner = remainder.slice(1, -1);
        if (!atStart) inner.reverse();
        graph.links.push([atStart ? anchorNode : a, atStart ? b : anchorNode, name, width, lanes, direction,
          inner.flatMap(({ x, z }) => [x, z])]);
        graph.metadata.push({ ...source.metadata[index], lengthM: remainder.at(-1).d - anchor.d });
      }
      const inner = approach.slice(1, -1);
      if (!atStart) inner.reverse();
      graph.links[index] = [atStart ? a : anchorNode, atStart ? anchorNode : b, name, width, lanes, direction,
        inner.flatMap(({ x, z }) => [x, z])];
      const approachWidth = Math.max(width, 9);
      graph.metadata[index] = { ...source.metadata[index], heightSource: 'estimate', lengthM: approach.at(-1).d,
        mountainTunnel: { startY: atStart ? portalY : anchorY, endY: atStart ? anchorY : portalY,
          bore: false, baseHeight, width: approachWidth,
          deckPortals: deckPeers.length ? [[anchorNode, deckPeers]] : [] } };
      const entryExtension = source.metadata[index].osmId === 'way/614184067' ? 5 : 1.2;
      cuts.push(...openingRings(approach, approachWidth / 2 + 0.35, entryExtension));
    }
  }
  if (!cuts.length) return city;
  return { ...city, roadGraph: graph, terrainSurface: cutTerrainOpenings(terrainSurface, cuts) };
}
