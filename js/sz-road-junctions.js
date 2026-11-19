import { createGroundSurfaceSampler } from './sz-ground-surface.js';
import { clipRoadBoundaryIntervals, clipRoadSurfaceTriangles, cutTerrainOpenings, isGroundRoad, roadLinkPoints, visitGroundRoadFootprints } from './sz-roads.js';
import { applyRoadJoinFrames, deckLaneProfile, prepareRoadJoinSections, ROAD_TUNNEL_CLEARANCE_M } from './sz-road-section.js';
import { sectionSpine } from './sz-section-frame.js';
import { highwayProfileHeight, interchangeRise, roadDeckLayer, roadDeckRise } from './sz-interchange-levels.js';
import { terrainHeight } from './sz-terrain.js';

const mountainWidth = meta => meta.mountainTunnel?.width;

const GRADE = 0.115;
const TOLERANCE = 0.001;

function stationsOf(points, width, meta = {}) {
  const samples = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
    for (let j = 1; j <= steps; j++) {
      samples.push({ x: a.x + (b.x - a.x) * j / steps, z: a.z + (b.z - a.z) * j / steps });
    }
  }
  return applyRoadJoinFrames(sectionSpine(samples, { widthM: width }).map(f => ({ ...f, d: f.station, widthM: width,
    left: { x: f.x + f.nx * width / 2, z: f.z + f.nz * width / 2 },
    right: { x: f.x - f.nx * width / 2, z: f.z - f.nz * width / 2 } })), meta);
}

// 上下界从固定断面向整个源连通图传播，短链路不再独立截断引道坡长。
function envelope(nodes, sign) {
  const values = new Map([...nodes].map(([id, node]) => [id, node.fixed === null ? Infinity : sign * node.fixed]));
  const queue = [...nodes].filter(([, node]) => node.fixed !== null).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const edge of nodes.get(id).edges) {
      const peer = edge.a === id ? edge.b : edge.a;
      const next = values.get(id) + edge.budget;
      if (next >= values.get(peer) - 1e-8) continue;
      values.set(peer, next);
      queue.push(peer);
    }
  }
  return values;
}

/** 同一源节点的桥、匝道、洞底共用高度；只修估计断面，既有设计控制点保持固定。 */
export function prepareRoadJunctions(city, extendedApproaches = [], pass = 0) {
  const graph = prepareRoadJoinSections(city.roadGraph), surface = city.terrainSurface;
  if (!graph?.nodeIds || !surface || graph.junctionsPrepared) return city;
  const sample = createGroundSurfaceSampler(surface);
  const ground = (x, z) => sample(x, z) ?? terrainHeight(city.terrain, x, z);
  const structuralNodes = new Set(), groundNodes = new Set(), approaches = new Set(extendedApproaches);
  graph.links.forEach((link, i) => {
    const meta = graph.metadata[i];
    if (meta.bridge || meta.tunnel || meta.layer || meta.mountainTunnel) link.slice(0, 2).forEach(n => structuralNodes.add(n));
  });
  graph.links.forEach((link, i) => {
    if (!isGroundRoad(graph.metadata[i])) return;
    if (approaches.has(i) || link.slice(0, 2).some(n => structuralNodes.has(n))) approaches.add(i);
    else link.slice(0, 2).forEach(n => groundNodes.add(n));
  });
  // 外围地面节点是约束；结构边旁的一段地面路参与接坡，避免在标签边界强制落地。
  const approachNodes = new Map();
  for (const i of approaches) for (const n of graph.links[i].slice(0, 2)) {
    approachNodes.set(n, (approachNodes.get(n) ?? 0) + 1);
  }
  for (const [n, count] of approachNodes) if (!structuralNodes.has(n) && count === 1) groundNodes.add(n);
  const underpasses = new Map();
  for (const profile of [surface.keyuanUnderpass, surface.hongliUnderpass]) {
    for (const way of profile?.tunnels ?? []) underpasses.set(way, profile);
  }
  const nodes = new Map(), edges = [];
  const nodeAt = id => {
    if (!nodes.has(id)) nodes.set(id, { values: [], anchors: [], fixed: null, edges: [] });
    return nodes.get(id);
  };
  graph.links.forEach((link, index) => {
    const meta = graph.metadata[index];
    const approach = approaches.has(index);
    if (!meta || (!meta.bridge && !meta.tunnel && !meta.layer && !meta.mountainTunnel && !approach)) return;
    const tunnel = meta.tunnel || meta.mountainTunnel;
    const width = approach ? link[3] : meta.junctionWidthM ?? mountainWidth(meta) ?? deckLaneProfile(link).widthM;
    const frames = stationsOf(roadLinkPoints(graph, link), width, meta);
    const length = frames.at(-1).d;
    if (!(length > 0)) return;
    const grounds = frames.map(f => ground(f.x, f.z));
    if (!grounds.every(Number.isFinite)) return;
    const layer = roadDeckLayer(meta, graph.names[link[2]]), rise = roadDeckRise(layer, meta);
    const profile = underpasses.get(meta.osmId), mountain = meta.mountainTunnel;
    const fixed = Boolean(meta.highwayProfile || meta.interchangeApproach || profile || mountain);
    const ys = frames.map((f, i) => {
      const t = f.d / length;
      if (approach) return grounds[i];
      if (meta.highwayProfile) return highwayProfileHeight(meta.highwayProfile, t);
      if (mountain) return mountain.startY + (mountain.endY - mountain.startY) * (mountain.bore ? t : t * t * (3 - 2 * t));
      if (profile) return profile.boreFloorM + profile.approachGrade * Math.max(0, profile.northPortalZ - f.z, f.z - profile.southPortalZ);
      if (tunnel) {
        const sink = Math.min(groundNodes.has(link[0]) ? Math.min(1, f.d / 12) : 1,
          groundNodes.has(link[1]) ? Math.min(1, (length - f.d) / 12) : 1);
        return grounds[i] - 6 * Math.abs(meta.layer ?? 0) * sink;
      }
      if (meta.interchangeApproach) {
        const u = meta.interchangeApproach;
        const y = grounds[0] + (grounds.at(-1) - grounds[0]) * t;
        const d = Math.min(u.start + Math.max(0, f.d - u.delayStart), u.end + Math.max(0, length - f.d - u.delayEnd));
        return y + (u.deckY === undefined ? 4.8 : u.deckY - y) * interchangeRise(d) / 4.8;
      }
      const y = grounds[0] + (grounds.at(-1) - grounds[0]) * t + rise;
      return y - Math.max(groundNodes.has(link[0]) ? Math.max(0, rise - f.d * 0.12) : 0,
        groundNodes.has(link[1]) ? Math.max(0, rise - (length - f.d) * 0.12) : 0);
    });
    const costs = [0];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      const run = Math.min(b.d - a.d, ...['left', 'right'].map(side =>
        Math.hypot(b[side].x - a[side].x, b[side].z - a[side].z)));
      costs.push(costs.at(-1) + GRADE * run);
    }
    const edge = { index, a: link[0], b: link[1], frames, ys, length, width, tunnel, fixed, approach, costs, budget: costs.at(-1) };
    edges.push(edge);
    for (const [side, id] of link.slice(0, 2).entries()) {
      const node = nodeAt(id), y = side ? ys.at(-1) : ys[0];
      node.values.push(y);
      node.edges.push(edge);
      if (fixed) node.anchors.push(y);
    }
  });
  const conflicts = [];
  for (const [id, node] of nodes) {
    if (node.anchors.length) {
      node.fixed = node.anchors[0];
      if (Math.max(...node.anchors) - Math.min(...node.anchors) > 0.25) conflicts.push(id);
    } else if (groundNodes.has(id)) node.fixed = ground(graph.nodes[id * 2], graph.nodes[id * 2 + 1]);
    node.y = node.fixed ?? Math.min(...node.values);
  }
  // 固定断面自身的陡坡不向相邻路线传播错误约束，只约束可重算的估计边。
  for (const edge of edges.filter(e => e.fixed)) edge.budget = Math.max(edge.budget, Math.abs(edge.ys[0] - edge.ys.at(-1)));
  const upper = envelope(nodes, 1), negativeLower = envelope(nodes, -1);
  for (const [id, node] of nodes) {
    node.low = -negativeLower.get(id);
    node.high = upper.get(id);
    node.feasible = node.low <= node.high + TOLERANCE;
    if (!node.feasible) conflicts.push(id);
    else node.y = Math.max(node.low, Math.min(node.high, node.y));
  }
  // 约束相撞时继续向相邻地面边借坡长；次数有界，不把一次修路扩散成全城重铺。
  const blockedGround = new Set([...nodes].filter(([, n]) => !n.feasible && n.fixed !== null && !n.anchors.length).map(([id]) => id));
  if (blockedGround.size && pass < 4) {
    const extra = graph.links.flatMap((link, index) => !approaches.has(index) && isGroundRoad(graph.metadata[index])
      && link.slice(0, 2).some(n => blockedGround.has(n)) ? [index] : []);
    if (extra.length) return prepareRoadJunctions(city, [...approaches, ...extra], pass + 1);
  }
  const queue = [...nodes.keys()];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], node = nodes.get(id);
    if (!node.feasible) continue;
    for (const edge of node.edges) {
      const peerId = edge.a === id ? edge.b : edge.a, peer = nodes.get(peerId);
      if (edge.fixed || peer.fixed !== null || !peer.feasible) continue;
      const next = Math.max(peer.low, node.y + edge.budget);
      if (next >= peer.y - 1e-8) continue;
      peer.y = next;
      queue.push(peerId);
    }
  }
  const metadata = graph.metadata.slice(), cuts = [], repaired = [];
  for (const edge of edges) {
    const a = nodes.get(edge.a), b = nodes.get(edge.b);
    let ys = edge.ys;
    const valid = a.feasible && b.feasible && Math.abs(a.y - b.y) <= edge.budget + TOLERANCE;
    if (!edge.fixed && valid) {
      const changedEnd = Math.abs(a.y - ys[0]) > 0.02 || Math.abs(b.y - ys.at(-1)) > 0.02;
      if (edge.approach && !changedEnd) continue;
      ys = ys.map((y, i) => {
        const run = edge.costs[i], remaining = edge.budget - run;
        return Math.max(a.y - run, b.y - remaining, Math.min(y, a.y + run, b.y + remaining));
      });
      for (const step of [1, -1]) {
        for (let i = step > 0 ? 1 : ys.length - 2; i > 0 && i < ys.length - 1; i += step) {
          const run = Math.abs(edge.costs[i] - edge.costs[i - step]);
          ys[i] = Math.max(ys[i - step] - run, Math.min(ys[i - step] + run, ys[i]));
        }
      }
      const changed = ys.some((y, i) => Math.abs(y - edge.ys[i]) >= 0.02);
      if (edge.approach && !changed) continue;
      const atGrade = [edge.a, edge.b].map((id, side) => groundNodes.has(id)
        && Math.abs((side ? ys.at(-1) : ys[0]) - ground(graph.nodes[id * 2], graph.nodes[id * 2 + 1])) < 0.05);
      metadata[edge.index] = { ...metadata[edge.index], ...(edge.approach ? { bridge: true, layer: 1,
        heightSource: 'estimate', junctionApproach: true, junctionWidthM: edge.width } : {}), junctionProfile:
        [ys[0], ys.at(-1), !atGrade[0], !atGrade[1], edge.frames.map((f, i) => [f.d / edge.length, ys[i]])] };
      if (changed) repaired.push(edge.index);
    } else if (edge.approach) continue;
    // 已有山体、下穿和立交设计也登记同一接续剖面，数值沿用原设计。
    if (edge.fixed && !metadata[edge.index].highwayProfile) {
      const atGrade = [edge.a, edge.b].map((id, side) => groundNodes.has(id)
        && Math.abs((side ? ys.at(-1) : ys[0]) - ground(graph.nodes[id * 2], graph.nodes[id * 2 + 1])) < 0.05);
      metadata[edge.index] = { ...metadata[edge.index], junctionProfile:
        [ys[0], ys.at(-1), !atGrade[0], !atGrade[1], edge.frames.map((f, i) => [f.d / edge.length, ys[i]])] };
    }
    edge.finalYs = ys;
    const meta = metadata[edge.index], curve = meta.junctionProfile ?? meta.highwayProfile;
    const atGrade = curve ? [!curve[2], !curve[3]] : [groundNodes.has(edge.a), groundNodes.has(edge.b)];
    // 只移除露天接坡上方的地面；洞身覆土与上方横路仍保留。
    for (let i = 1; i < edge.frames.length; i++) {
      const u = edge.frames[i - 1], v = edge.frames[i];
      const cover = ground((u.x + v.x) / 2, (u.z + v.z) / 2) - (ys[i - 1] + ys[i]) / 2;
      if (coveredInterval(edge, meta, i, cover) || cover <= 0.01) continue;
      const halfU = u.widthM / 2 + 0.75, halfV = v.widthM / 2 + 0.75;
      // 接地端保留一条原地形边，采样与邻路不能落进裁切后的空格而回退到别的标高。
      const run = Math.hypot(v.x - u.x, v.z - u.z);
      const startInset = i === 1 && atGrade[0] ? Math.min(0.05 / run, 0.1) : 0;
      const endInset = i === edge.frames.length - 1 && atGrade[1] ? Math.min(0.05 / run, 0.1) : 0;
      const a = { x: u.x + (v.x - u.x) * startInset, z: u.z + (v.z - u.z) * startInset };
      const b = { x: v.x + (u.x - v.x) * endInset, z: v.z + (u.z - v.z) * endInset };
      cuts.push([{ x: a.x + u.nx * halfU, z: a.z + u.nz * halfU },
        { x: a.x - u.nx * halfU, z: a.z - u.nz * halfU },
        { x: b.x - v.nx * halfV, z: b.z - v.nz * halfV },
        { x: b.x + v.nx * halfV, z: b.z + v.nz * halfV }]);
    }
  }
  const prepared = cuts.length ? cutTerrainOpenings(surface, cuts) : surface;
  const preparedGraph = { ...graph, metadata, junctionsPrepared: true, junctionGround: ground,
    junctionRepair: { repaired, conflicts: [...new Set(conflicts)] } };
  const walls = roadCutWalls(edges, preparedGraph, ground, city.terrain);
  const oldWalls = surface.cutWalls ?? { positions: [], triangles: 0 };
  return { ...city, roadGraph: preparedGraph,
    terrainSurface: { ...prepared, cutWalls: { positions: [...oldWalls.positions, ...walls.positions],
      triangles: (oldWalls.triangles ?? 0) + walls.positions.length / 9,
      colliders: [...(oldWalls.colliders ?? []), ...walls.colliders] } } };
}

function coveredInterval(edge, meta, index, cover) {
  if (!edge.tunnel) return false;
  const mid = (edge.frames[index - 1].d + edge.frames[index].d) / 2;
  const corridor = meta.tunnelCorridor, mountain = meta.mountainTunnel;
  if (corridor) return corridor.coverM[1] > corridor.coverM[0] && mid >= corridor.coverM[0] && mid <= corridor.coverM[1];
  if (mountain) return mountain.bore && mid >= (mountain.openStartM ?? 0) && mid <= edge.length - (mountain.openEndM ?? 0);
  return cover > 5.6;
}

// 所有开挖走廊共用土壁和沟底封边。土壁位于车道净宽以外，洞门上方补土而保留通行净空。
function roadCutWalls(edges, graph, ground, terrain) {
  const metadata = graph.metadata;
  const positions = [], colliders = [];
  const quad = (a, b, c, d) => {
    for (const p of [a, b, c, a, c, d]) positions.push(p.x, p.y, p.z);
  };
  for (const edge of edges) {
    if (!edge.finalYs) continue;
    const meta = metadata[edge.index], ys = edge.finalYs;
    const height = meta.mountainTunnel?.baseHeight ?? ((x, z) => ground(x, z) ?? terrainHeight(terrain, x, z));
    const cap = (frame, floor) => {
      const ceiling = floor + (meta.tunnelCorridor?.clearanceM ?? ROAD_TUNNEL_CLEARANCE_M) + 0.9;
      const left = { ...frame.left, y: Math.max(ceiling, height(frame.left.x, frame.left.z) ?? ceiling) };
      const right = { ...frame.right, y: Math.max(ceiling, height(frame.right.x, frame.right.z) ?? ceiling) };
      quad({ ...left, y: ceiling }, { ...right, y: ceiling }, right, left);
    };
    let previousCovered = null;
    for (let i = 1; i < edge.frames.length; i++) {
      const a = edge.frames[i - 1], b = edge.frames[i];
      const cover = height((a.x + b.x) / 2, (a.z + b.z) / 2) - (ys[i - 1] + ys[i]) / 2;
      const covered = coveredInterval(edge, meta, i, cover);
      if (edge.tunnel && ((covered && previousCovered === null) ||
        (previousCovered !== null && covered !== previousCovered))) cap(a, ys[i - 1]);
      if (covered && i === edge.frames.length - 1) cap(b, ys[i]);
      previousCovered = covered;
      const lift = covered ? (meta.tunnelCorridor?.clearanceM ?? ROAD_TUNNEL_CLEARANCE_M) + 0.9 : -0.04;
      for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const u = { x: a[side].x + a.nx * sign * 0.75, z: a[side].z + a.nz * sign * 0.75, y: ys[i - 1] + lift };
        const v = { x: b[side].x + b.nx * sign * 0.75, z: b[side].z + b.nz * sign * 0.75, y: ys[i] + lift };
        const topU = { ...u, y: Math.max(u.y, height(u.x, u.z) ?? u.y) + 0.03 };
        const topV = { ...v, y: Math.max(v.y, height(v.x, v.z) ?? v.y) + 0.03 };
        if (Math.max(topU.y - u.y, topV.y - v.y) < 0.1) continue;
        const intervals = covered ? [[0, 1]] : roadJunctionWallIntervals(graph, edge.index, a, b, u, v);
        const mix = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
        for (const [from, to] of intervals) {
          const lowU = mix(u, v, from), lowV = mix(u, v, to);
          const highU = mix(topU, topV, from), highV = mix(topU, topV, to);
          quad(lowU, lowV, highV, highU);
          if (!covered) quad(mix({ ...a[side], y: u.y }, { ...b[side], y: v.y }, from),
            mix({ ...a[side], y: u.y }, { ...b[side], y: v.y }, to), lowV, lowU);
          const outer = [lowU, lowV, { x: lowV.x + b.nx * sign * 0.12, z: lowV.z + b.nz * sign * 0.12 },
            { x: lowU.x + a.nx * sign * 0.12, z: lowU.z + a.nz * sign * 0.12 }];
          colliders.push({ type: 'road-cut-wall', name: `road-cut:${edge.index}:${i}:${side}`,
            sourceId: meta.osmId, polygon: { outer, holes: [] },
            minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
            minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
            minY: Math.min(lowU.y, lowV.y), maxY: Math.max(highU.y, highV.y),
            verticalSpan: [lowU.y, lowV.y, highU.y, highV.y] });
        }
      }
    }
  }
  return { positions, colliders };
}

const joinMasks = new WeakMap();

function junctionMasks(graph) {
  if (joinMasks.has(graph)) return joinMasks.get(graph);
  const ground = new Map(), structures = new Map();
  visitGroundRoadFootprints(graph, (ring, indices) => {
    for (const index of indices) for (const node of graph.links[index].slice(0, 2)) {
      const [x, z] = graph.nodes.slice(2 * node, 2 * node + 2);
      if (!ring.some(p => Math.abs(p.x - x) < 80 && Math.abs(p.z - z) < 80)) continue;
      if (!ground.has(node)) ground.set(node, []);
      ground.get(node).push(ring);
    }
  });
  graph.links.forEach((link, index) => {
    const meta = graph.metadata[index], profile = meta.junctionProfile ?? meta.highwayProfile;
    if (!profile) return;
    const width = meta.junctionWidthM ?? mountainWidth(meta) ?? deckLaneProfile(link).widthM;
    const frames = stationsOf(roadLinkPoints(graph, link), width, meta);
    for (const [side, node] of link.slice(0, 2).entries()) {
      const sequence = side ? frames.slice().reverse() : frames;
      const portal = sequence[0], masks = [];
      for (let i = 1; i < sequence.length; i++) {
        const a = sequence[i - 1], b = sequence[i];
        masks.push([a.left, a.right, b.right, b.left]);
        if (Math.abs(b.d - portal.d) >= width + 4) break;
      }
      const inner = sequence[1], run = Math.hypot(portal.x - inner.x, portal.z - inner.z);
      const dx = (portal.x - inner.x) * 4 / run, dz = (portal.z - inner.z) * 4 / run;
      const extension = [portal.left, portal.right,
        { x: portal.right.x + dx, z: portal.right.z + dz }, { x: portal.left.x + dx, z: portal.left.z + dz }];
      if (!structures.has(node)) structures.set(node, []);
      structures.get(node).push({ index, y: profile[side], masks, extension });
    }
  });
  const result = { ground, structures };
  joinMasks.set(graph, result);
  return result;
}

// 地面路优先拥有铺装；同节点、同高结构只保留一份补面，跨层道路不参与裁切。
export function clipRoadJunctionOverlap(graph, index, side, triangles) {
  const link = graph.links[index], meta = graph.metadata[index];
  const profile = meta.junctionProfile ?? meta.highwayProfile;
  if (!profile) return triangles;
  const node = link[side], y = profile[side], cached = junctionMasks(graph);
  const masks = !profile[side + 2] ? [...(cached.ground.get(node) ?? [])] : [];
  for (const peer of cached.structures.get(node) ?? []) {
    if (peer.index === index || Math.abs(peer.y - y) > 0.05) continue;
    masks.push(...peer.masks);
    if (peer.index < index) masks.push(peer.extension);
  }
  return clipRoadSurfaceTriangles(triangles, masks);
}

// 与补面共用相邻道路足迹，只在同源节点且同高的汇入处打开侧壁。
export function roadJunctionWallIntervals(graph, index, a, b, left, right) {
  const link = graph.links[index], meta = graph.metadata[index], profile = meta.junctionProfile ?? meta.highwayProfile;
  if (!profile) return [[0, 1]];
  const masks = [], cached = junctionMasks(graph);
  for (const [side, node] of link.slice(0, 2).entries()) {
    const x = graph.nodes[node * 2], z = graph.nodes[node * 2 + 1];
    if (Math.min(Math.hypot(a.x - x, a.z - z), Math.hypot(b.x - x, b.z - z)) >
      Math.max(meta.junctionWidthM ?? link[3], 12) + 4) continue;
    for (const peer of cached.structures.get(node) ?? []) {
      if (peer.index !== index && Math.abs(peer.y - profile[side]) < 0.05) masks.push(...peer.masks);
    }
  }
  return masks.length ? clipRoadBoundaryIntervals(left, right, masks) : [[0, 1]];
}
