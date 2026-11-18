"""为城市包内 G4 和红荔下穿生成与实体地形一致的估计设计断面。"""

import heapq
import json
import math
from pathlib import Path

from shapely.geometry import LineString, box
from shapely.ops import substring, unary_union

from commercial_paving import cut_ground_openings
from elevated_cut import _g4_deck_width, build_cut_walls
from keyuan_underpass import _restore_roof
from tunnel_portals import _SurfaceSampler, _resample, _source_points
from waterfront import _clip_terrain

# 皇岗端由源节点接入城市地面路，两条短分支需沿同一 source way 继续放坡。
G4_TERMINAL_WAYS = {'way/74017036', 'way/974372190', 'way/974372191', 'way/1573392908'}
G4_SOURCE = Path(__file__).resolve().parents[2] / 'data/source/g4-mainline.json'
HONGLI = {
    'tunnels': ['way/535064405', 'way/535064406'],
    'feeders': ['way/535064404', 'way/545681215', 'way/961590245', 'way/961590244'],
    'northPortalZ': 86, 'southPortalZ': 207, 'datumM': 10.3, 'boreFloorM': 3.7, 'approachGrade': 0.099,
    'heightSource': 'estimate',
}


def _apply_hongli(surface, graph):
    bores = []
    approaches = []
    for edge, meta in zip(graph['links'], graph['metadata'], strict=True):
        if meta['osmId'] in HONGLI['tunnels']:
            bores.append((LineString(_source_points(graph, edge)), max(9, edge[3]) / 2 + 0.9))
        elif meta['osmId'] in HONGLI['feeders']:
            approaches.append(LineString(_source_points(graph, edge)).buffer(edge[3] / 2 + 1, cap_style='flat'))
    if len(bores) != 2:
        return surface, None

    corridor = unary_union([line.buffer(width, cap_style='flat') for line, width in bores])
    north, south = HONGLI['northPortalZ'], HONGLI['southPortalZ']
    roof = box(-3500, north, -3200, south)
    limits = box(-3500, -10, -3200, 310)
    core = unary_union([corridor, *approaches]).intersection(limits).difference(roof)
    restored, added = _restore_roof(surface, corridor.buffer(0.2), HONGLI['datumM'])

    def floor(point):
        return HONGLI['boreFloorM'] + HONGLI['approachGrade'] * max(north - point.y, point.y - south, 0)

    def shoulder(point, y):
        weight = max(0, 1 - point.distance(core))
        return y - max(0, y - floor(point)) * weight

    graded, chunks, _ = _clip_terrain(restored, {}, [
        (core, lambda point, y: min(y, floor(point))),
        (core.buffer(1), shoulder),
    ], grade_step=2)
    # 源节点附近保留一小段同高斜面，让地面铺装与洞口路面实际重叠。
    overlap = 4
    openings = unary_union([substring(line, overlap, line.length - overlap).buffer(width, cap_style='flat')
                            for line, width in bores]).difference(roof)
    cut, removed = cut_ground_openings(graded, openings)
    return cut, {'restoredM2': round(added, 3), 'cutM2': round(removed, 3), 'terrainChunks': chunks}


def _g4_heights(sampler, graph, edges, lift):
    neighbors = {}
    for _, edge, line in edges:
        a, b = edge[:2]
        neighbors.setdefault(a, []).append((b, line.length))
        neighbors.setdefault(b, []).append((a, line.length))
    nodes = graph['nodes']
    heights = {}
    for node in neighbors:
        x, z = nodes[2 * node:2 * node + 2]
        y = sampler(x, z)
        if y is None:
            samples = [h for dx, dz in [(8, 0), (-8, 0), (0, 8), (0, -8), (18, 0), (-18, 0), (0, 18), (0, -18)]
                       if (h := sampler(x + dx, z + dz)) is not None]
            y = min(samples, default=3)
        heights[node] = y + lift
    # 可行标高从较低的共享节点沿主线传播，限制短桥和山地接缝的坡度。
    queue = [(height, node) for node, height in heights.items()]
    heapq.heapify(queue)
    while queue:
        y, node = heapq.heappop(queue)
        if y != heights[node]:
            continue
        for peer, length in neighbors[node]:
            candidate = y + 0.045 * length
            if candidate < heights[peer]:
                heights[peer] = candidate
                heapq.heappush(queue, (candidate, peer))
    return heights


def _apply_g4(surface, graph, spec):
    source = set(spec['ways'])
    main = [(i, edge, LineString(_source_points(graph, edge)))
            for i, (edge, meta) in enumerate(zip(graph['links'], graph['metadata'], strict=True))
            if meta['osmId'] in source and meta['highway'] == 'motorway']
    if not main:
        return surface, None
    sampler = _SurfaceSampler(surface)
    lift = spec['riseM']
    anchors = _g4_heights(sampler, graph, main, lift)
    profiles = {}
    cuts = []
    samples = []
    for index, edge, line in main:
        a, b = edge[:2]
        start, end = anchors[a], anchors[b]
        profiles[str(index)] = [round(start, 5), round(end, 5), True, True]
        width = _g4_deck_width(edge) / 2 + 0.75
        points = list(line.coords)
        stations = _resample(points, line.length)
        for i, (da, x, z) in enumerate(stations[:-1]):
            db, xx, zz = stations[i + 1]
            dy = end - start
            ya, yb = start + dy * da / line.length, start + dy * db / line.length
            dx, dz = xx - x, zz - z
            length = math.hypot(dx, dz)
            if length < 1e-9:
                continue
            high = False
            for t in (0, 0.5, 1):
                for lateral in (-width, -width / 2, 0, width / 2, width):
                    h = sampler(x + dx * t + dz / length * lateral, z + dz * t - dx / length * lateral)
                    high |= h is not None and h > ya + (yb - ya) * t + 0.02
            if high:
                cuts.append(LineString([(x, z), (xx, zz)]).buffer(width, quad_segs=3))
                samples.extend([(x, z, ya), (xx, zz, yb)])

    ramps = [(i, edge, meta) for i, (edge, meta) in enumerate(zip(graph['links'], graph['metadata'], strict=True))
             if not meta['tunnel'] and (meta['highway'] == 'motorway_link' or meta['osmId'] in G4_TERMINAL_WAYS)]
    by_node = {}
    for index, edge, meta in ramps:
        for node in edge[:2]:
            by_node.setdefault(node, []).append((index, edge, meta))

    nodes = graph['nodes']
    ramp_anchors = dict(anchors)
    # 独立短匝道若在同向匝道内合流，先把共同接点定在坡上，留足后续落地距离。
    for index, edge, meta in ramps:
        a, b = edge[:2]
        if meta['highway'] != 'motorway_link' or (a in anchors) == (b in anchors):
            continue
        origin, joint = (a, b) if a in anchors else (b, a)
        floor = sampler(*nodes[joint * 2:joint * 2 + 2])
        run = LineString(_source_points(graph, edge)).length
        if floor is None or abs(anchors[origin] - floor) <= 0.12 * run:
            continue
        outgoing = edge[5] == 0 or (edge[5] == 1) == (origin == a)
        continuations = [part for i, part, row in by_node[joint] if i != index
                         and row['highway'] == 'motorway_link' and part[5] != 0
                         and (part[0 if part[5] == 1 else 1] == joint) == outgoing]
        if len(continuations) != 1:
            continue
        target = anchors[origin] + math.copysign(run * 0.10, floor - anchors[origin])
        ramp_anchors.setdefault(joint, target)

    heights = dict(ramp_anchors)
    for index, edge, meta in ramps:
        a, b = edge[:2]
        if str(index) in profiles or (a not in ramp_anchors and b not in ramp_anchors):
            continue
        origin, terminal = (a, b) if a in ramp_anchors else (b, a)
        chain = [(index, edge, terminal)]
        run = LineString(_source_points(graph, edge)).length
        floor = ramp_anchors.get(terminal)
        if floor is None:
            floor = sampler(*nodes[terminal * 2:terminal * 2 + 2])
        if floor is not None and abs(ramp_anchors[origin] - floor) > run * 0.12 and meta['osmId'] in G4_TERMINAL_WAYS:
            peers = [(i, e) for i, e, m in by_node[terminal] if i != index and m['osmId'] == meta['osmId']]
            if len(peers) == 1:
                peer, continuation = peers[0]
                following = continuation[1] if continuation[0] == terminal else continuation[0]
                outside = sampler(*nodes[following * 2:following * 2 + 2])
                if outside is not None:
                    run += LineString(_source_points(graph, continuation)).length
                    chain.append((peer, continuation, following))
                    floor = outside
        if floor is None:
            continue
        travelled = 0
        for ramp, part, following in chain:
            travelled += LineString(_source_points(graph, part)).length
            heights.setdefault(following, ramp_anchors[origin] + (floor - ramp_anchors[origin]) * travelled / run)
            first, last = part[:2]
            committed = {origin, *(node for _, _, node in chain[:-1])}
            profiles[str(ramp)] = [round(heights[first], 5), round(heights[last], 5),
                                   first in committed or first in ramp_anchors, last in committed or last in ramp_anchors]

    mask = unary_union(cuts)
    walls = build_cut_walls(mask, samples, sampler)
    cut, area = cut_ground_openings(surface, mask)
    previous = surface.get('cutWalls', {}).get('positions', [])
    combined = previous + walls['positions']
    cut['cutWalls'] = {'positions': combined, 'triangles': len(combined) // 9,
                       'minY': min(combined[1::3], default=0), 'maxY': max(combined[1::3], default=0)}
    cut['g4Profiles'] = profiles
    return cut, {'mainLinks': len(main), 'ramps': len(profiles) - len(main), 'cutM2': round(area, 3),
                 'wallTriangles': walls['triangles'], 'heightSource': spec['heightSource']}


def apply_highway_corridors(payload, report):
    surface = payload['terrainSurface']
    graph = payload['roadGraph']
    if 'hongliUnderpass' not in surface:
        surface, stats = _apply_hongli(surface, graph)
        if stats is not None:
            surface['hongliUnderpass'] = HONGLI
            report['hongliUnderpass'] = stats
    if 'g4Profiles' not in surface:
        surface, stats = _apply_g4(surface, graph, json.loads(G4_SOURCE.read_text()))
        if stats is not None:
            report['g4Profiles'] = stats
    payload['terrainSurface'] = surface
    report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                                    triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']))
