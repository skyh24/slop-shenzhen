// 科技路与深南大道按模拟场景的平交方案接续，保留两组单向车道的行驶方向。
export const KEJI_SURFACE_WAYS = new Set(['way/96327302', 'way/488273278']);
const SHENNAN_WAYS = new Set(['way/1049950452', 'way/1549038439', 'way/1049950453', 'way/1463427746']);
const EPSILON = 1e-6;

function graphPoints(graph, [a, b, , , , , inner]) {
  const xy = [graph.nodes[2 * a], graph.nodes[2 * a + 1], ...inner, graph.nodes[2 * b], graph.nodes[2 * b + 1]];
  return Array.from({ length: xy.length / 2 }, (_, index) => xy.slice(2 * index, 2 * index + 2));
}

const cross = (ax, az, bx, bz) => ax * bz - az * bx;

function findCrossing(first, second) {
  for (let i = 0; i < first.length - 1; i++) {
    const [x, z] = first[i];
    const dx = first[i + 1][0] - x, dz = first[i + 1][1] - z;
    for (let j = 0; j < second.length - 1; j++) {
      const [u, v] = second[j];
      const du = second[j + 1][0] - u, dv = second[j + 1][1] - v;
      const det = cross(dx, dz, du, dv);
      if (Math.abs(det) < EPSILON) continue;
      const t = cross(u - x, v - z, du, dv) / det;
      const s = cross(u - x, v - z, dx, dz) / det;
      if (t > EPSILON && t < 1 - EPSILON && s > EPSILON && s < 1 - EPSILON) {
        return { point: [x + dx * t, z + dz * t], alongFirst: i + t, alongSecond: j + s };
      }
    }
  }
  return null;
}

export function applyShennanKejiCrossing(graph) {
  const keji = [], shennan = [];
  for (const [index, metadata] of (graph?.metadata ?? []).entries()) {
    const { osmId, layer, heightSource, bridge, tunnel } = metadata;
    const converted = KEJI_SURFACE_WAYS.has(osmId) && tunnel;
    const mainStreet = SHENNAN_WAYS.has(osmId) && !tunnel && !bridge && !layer && heightSource === 'terrain';
    if (!converted && !mainStreet) continue;
    const link = graph.links[index];
    const road = { index, metadata, link, points: graphPoints(graph, link), cuts: [] };
    (converted ? keji : shennan).push(road);
  }
  if (keji.length !== KEJI_SURFACE_WAYS.size || !shennan.length) return graph;

  const nodes = [...graph.nodes], nodeIds = [...graph.nodeIds];
  for (const across of keji) {
    const crossedWays = new Set();
    for (const along of shennan) {
      const meeting = findCrossing(across.points, along.points);
      if (!meeting) continue;
      if (crossedWays.has(along.metadata.osmId)) return graph;
      crossedWays.add(along.metadata.osmId);
      const node = nodeIds.length;
      nodes.push(...meeting.point);
      nodeIds.push(`junction/shennan-keji/${across.metadata.osmId}/${along.metadata.osmId}`);
      across.cuts.push({ node, at: meeting.alongFirst });
      along.cuts.push({ node, at: meeting.alongSecond });
    }
    if (crossedWays.size !== SHENNAN_WAYS.size) return graph;
  }

  const links = [...graph.links], metadata = [...graph.metadata];
  const kejiName = graph.names.indexOf('科技路');
  for (const road of [...keji, ...shennan]) {
    if (!road.cuts.length) continue;
    const [start, end, name, width, lanes, direction] = road.link;
    const { cuts, points } = road;
    const converted = KEJI_SURFACE_WAYS.has(road.metadata.osmId);
    const profile = converted ? { ...road.metadata, layer: 0, bridge: false, tunnel: false,
      heightSource: 'terrain', widthSource: 'junction-design-estimate' } : road.metadata;
    // 保留原索引给仍以索引引用源段的结构和设施，后续断面按原方向追加。
    cuts.sort((a, b) => a.at - b.at);
    const boundaries = [{ node: start, at: 0 }, ...cuts, { node: end, at: points.length - 1 }];
    for (let i = 1; i < boundaries.length; i++) {
      const a = boundaries[i - 1], b = boundaries[i];
      const inner = points.slice(Math.floor(a.at) + 1, Math.ceil(b.at));
      const segment = [[nodes[a.node * 2], nodes[a.node * 2 + 1]], ...inner, [nodes[b.node * 2], nodes[b.node * 2 + 1]]];
      let lengthM = 0;
      for (let j = 1; j < segment.length; j++) lengthM += Math.hypot(segment[j][0] - segment[j - 1][0], segment[j][1] - segment[j - 1][1]);
      const index = i === 1 ? road.index : links.length;
      // 两条直行线中心相隔约 8.5–8.9 米，收窄原 12 米断面以限制对向重叠。
      links[index] = [a.node, b.node, converted && kejiName >= 0 ? kejiName : name, converted ? 9 : width, lanes, direction, inner.flat()];
      metadata[index] = { ...profile, lengthM };
    }
  }
  return { ...graph, nodes, nodeIds, links, metadata };
}
