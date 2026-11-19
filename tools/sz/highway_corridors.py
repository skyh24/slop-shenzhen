"""为城市包内高速和下穿生成与实体地形一致的估计设计断面。"""

import heapq
import json
import math
from bisect import bisect_right
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring, unary_union

from commercial_paving import cut_ground_openings
from elevated_cut import apply_elevated_cut, build_cut_walls, deck_width, merge_cut_walls
from keyuan_underpass import _restore_roof
from road_structures import ground_height, resolve_route, strip
from tunnel_portals import _SurfaceSampler, _resample, _source_points, plan_tunnel_portal_mask
from waterfront import _clip_terrain, _polygon

# 皇岗端由源节点接入城市地面路，两条短分支需沿同一 source way 继续放坡。
G4_TERMINAL_WAYS = {'way/74017036', 'way/974372190', 'way/974372191', 'way/1573392908'}
G4_SOURCE = Path(__file__).resolve().parents[2] / 'data/source/g4-mainline.json'
NANPING_SOURCE = Path(__file__).resolve().parents[2] / 'data/source/nanping-mainline.json'
CORRIDOR_SOURCE = NANPING_SOURCE.with_name('road-corridor-profiles.json')
NANPING_CUT_VERSION = 4
NANPING_HEADROOM_M = 5.2

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
        width = deck_width(edge) / 2 + 0.75
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


def _nanping_height(curve, fraction):
    i = min(len(curve) - 2, max(0, bisect_right(curve, fraction, key=lambda point: point[0]) - 1))
    (start, y), (end, next_y) = curve[i:i + 2]
    t = max(0, min(1, (fraction - start) / (end - start)))
    return y + (next_y - y) * t


def _compact_profile(samples, tolerance=0.025):
    """保留端点和必要的纵断面站点，误差不超过 2.5 厘米。"""
    first, last = samples[0], samples[-1]
    d, y = first
    length = last[0] - d
    if len(samples) == 2:
        return [first, last]
    error, split = max((abs(h - (y + (last[1] - y) * (s - d) / length)), i)
                       for i, (s, h) in enumerate(samples[1:-1], 1))
    if error <= tolerance:
        return [first, last]
    return _compact_profile(samples[:split + 1], tolerance)[:-1] + _compact_profile(samples[split:], tolerance)


def _nanping_profiles(graph, structures, spec):
    ways = set(spec['ways'])
    selected = {i: edge for i, (edge, meta) in enumerate(zip(graph['links'], graph['metadata'], strict=True))
                if meta['osmId'] in ways and meta['highway'] == 'trunk'}
    if not selected:
        return {}
    routes = spec['referenceRoutes']
    reviewed = {row['index']: row['stations'] for row in structures.get('records', []) if row['route'] in routes}
    route_ends = {row['id']: row['portalNodes'] for row in structures.get('routes', [])}
    if not reviewed or not all(route in route_ends for route in routes) or not reviewed.keys() <= selected.keys():
        raise ValueError('Nanping needs the matching reviewed eastbound and westbound profiles')

    outgoing = {edge[0]: i for i, edge in selected.items() if edge[5] == 1}
    incoming = {edge[1] for edge in selected.values()}
    starts = outgoing.keys() - incoming
    if len(outgoing) != len(selected) or len(incoming) != len(selected) or len(starts) != 2:
        raise ValueError('Nanping source ways must form two directed mainlines')
    chains = []
    for node in sorted(starts):
        chain = []
        while node in outgoing:
            index = outgoing.pop(node)
            chain.append(index)
            node = selected[index][1]
        chains.append(chain)
    if outgoing:
        raise ValueError('Nanping source ways contain disconnected links')
    node_ids = graph['nodeIds']
    east, west = sorted(chains, key=lambda chain: graph['nodes'][2 * selected[chain[0]][0]])
    lines = {i: LineString(_source_points(graph, edge)) for i, edge in selected.items()}

    def first_reference(chain):
        return next(i for i in chain if i in reviewed)

    profiles = {}
    def set_profile(index, rows):
        length = lines[index].length
        profiles[index] = [[round(distance / length, 8), round(height, 5)]
                           for distance, height in _compact_profile(rows)]

    heights = {}
    for index, stations in reviewed.items():
        length = lines[index].length
        rows = [(stations[j], stations[j + 2]) for j in range(0, len(stations), 8)]
        rows[-1] = (length, rows[-1][1])
        set_profile(index, rows)
        for node, row in zip(selected[index][:2], (rows[0], rows[-1]), strict=True):
            if abs(heights.setdefault(node, row[1]) - row[1]) > 1e-5:
                raise ValueError('Reviewed Nanping profiles have a height discontinuity')

    east_start = first_reference(east)
    for index in east[:east.index(east_start)]:
        y = heights[selected[east_start][0]]
        set_profile(index, [(0, y), (lines[index].length, y)])
    suffix_anchor = spec['eastTailAnchorsM']
    last = max(i for i, index in enumerate(east) if index in reviewed)
    remaining = east[last + 1:]
    distance = 0
    tail_y = heights[selected[east[last]][1]]
    controls = [(0, tail_y)]
    for index in remaining:
        distance += lines[index].length
        if (node := node_ids[selected[index][1]]) in suffix_anchor:
            controls.append((distance, suffix_anchor[node]))
    if distance > controls[-1][0]:
        controls.append((distance, controls[-1][1]))
    normalized = [(station / distance, y) for station, y in controls]
    start = 0
    for index in remaining:
        length = lines[index].length
        rows = [(s, _nanping_height(normalized, (start + s) / distance))
                for s in (0, length)]
        set_profile(index, rows)
        start += length

    # 西向东端没有旧纵断面：投影到平行东幅，并在并入已审核断面处平顺消除高差。
    west_start = first_reference(west)
    gap = west[:west.index(west_start)]
    end_node = selected[west_start][0]
    east_axis = LineString([point for i in east for point in list(lines[i].coords)[:-1]] + [lines[east[-1]].coords[-1]])
    east_distances = [0]
    for index in east:
        east_distances.append(east_distances[-1] + lines[index].length)

    def parallel_height(point):
        distance = east_axis.project(point)
        j = min(len(east) - 1, bisect_right(east_distances, distance) - 1)
        return _nanping_height(profiles[east[j]], (distance - east_distances[j]) / lines[east[j]].length)

    end_point = Point(graph['nodes'][end_node * 2:end_node * 2 + 2])
    delta = heights[end_node] - parallel_height(end_point)
    remaining_m = sum(lines[index].length for index in gap)
    for index in gap:
        line = lines[index]
        length = line.length
        # 短曲线内不追逐两幅投影的小幅抖动，站距至少约 50 米。
        steps = max(1, math.ceil(length / 70))
        stations = [length * k / steps for k in range(steps + 1)]
        rows = [(d, parallel_height(line.interpolate(d)) + delta * max(0, 1 - (remaining_m - d) / 500))
                for d in stations]
        set_profile(index, rows)
        remaining_m -= length
    last = max(i for i, index in enumerate(west) if index in reviewed)
    for index in west[last + 1:]:
        y = heights[selected[west[last]][1]]
        set_profile(index, [(0, y), (lines[index].length, y)])

    if profiles.keys() != selected.keys():
        raise ValueError('Nanping cross section does not cover the full route')
    anchors = {}
    for index, curve in profiles.items():
        for node, (_, y) in zip(selected[index][:2], (curve[0], curve[-1]), strict=True):
            if abs(anchors.setdefault(node, y) - y) > 0.001:
                raise ValueError(f'Grade mismatch at Nanping node {node_ids[node]}')
    return profiles


def _profile_key(graph, index):
    a, b = graph['links'][index][:2]
    return ':'.join([graph['metadata'][index]['osmId'], graph['nodeIds'][a], graph['nodeIds'][b]])


def _cut_profiled_decks(surface, graph, profiles, fallback=None, ground_ends=(), restore_entries=False):
    """洞外沿设计纵断面裁山，洞内保留覆土。"""
    main = [(graph['links'][index], graph['metadata'][index], curve) for index, curve in profiles.items()]
    rendered_height = _SurfaceSampler(surface)

    def sampler(x, z):
        y = rendered_height(x, z)
        return fallback(x, z) if y is None and fallback else y

    tunnel_nodes = {node for edge, meta, _ in main if meta['tunnel'] for node in edge[:2]}
    portal_sections = []
    cuts = []
    samples = []
    entry_ground = []
    removed_entries = []
    for edge, meta, curve in main:
        if meta['tunnel']:
            continue
        points = _source_points(graph, edge)
        length = LineString(points).length
        stations = _resample(points, length)
        half_width = deck_width(edge) / 2 + 0.75
        for node, at, inner in [(edge[0], points[0], points[1]), (edge[1], points[-1], points[-2])]:
            if node not in tunnel_nodes and node not in ground_ends:
                continue
            dx, dz = inner[0] - at[0], inner[1] - at[1]
            run = math.hypot(dx, dz) or 1
            if node in tunnel_nodes:
                portal_y = curve[0 if node == edge[0] else -1][1]
                portal_sections.append((*at, dx / run, dz / run, half_width, portal_y))
            if node in ground_ends:
                # 在接点的地面一侧保留整幅路基。保留区只延入桥头 25 厘米，以免上坡的地面穿过桥面。
                width = half_width + 3
                apron = Polygon([(at[0] + (s * dx + t * dz) / run, at[1] + (s * dz - t * dx) / run)
                                 for s, t in [(-8, -width), (0.25, -width), (0.25, width), (-8, width)]])
                entry_ground.append(apron)
                if restore_entries and rendered_height(*at) is None:
                    removed_entries.append(apron)
        spans = []
        run_points = []
        for (d, x, z), (next_d, xx, zz) in zip(stations, stations[1:]):
            dx, dz = xx - x, zz - z
            run = math.hypot(dx, dz)
            if run <= 1e-8:
                continue
            probes = ((sampler(x + t * dx + offset * dz / run, z + t * dz - offset * dx / run),
                       _nanping_height(curve, (d + t * (next_d - d)) / length))
                      for t in (-0.4, 0, 0.5, 1, 1.4)
                      for offset in (-half_width, -half_width / 2, 0, half_width / 2, half_width))
            if any(y is not None and y > deck_y + 0.025 for y, deck_y in probes):
                if not run_points:
                    run_points.append((x, z, _nanping_height(curve, d / length)))
                run_points.append((xx, zz, _nanping_height(curve, next_d / length)))
            elif run_points:
                spans.append(run_points)
                run_points = []
        if run_points:
            spans.append(run_points)
        for span in spans:
            # 连续裁一段，拐角用斜接。两端多留 2 m，覆盖相邻道路的实际搭接断面。
            xy = [(x, z) for x, z, _ in span]
            endpoints = []
            for tip, inner in [(xy[0], xy[1]), (xy[-1], xy[-2])]:
                dx, dz = tip[0] - inner[0], tip[1] - inner[1]
                stretch = 2.0 / math.hypot(dx, dz)
                endpoints.append((tip[0] + dx * stretch, tip[1] + dz * stretch))
            line = LineString([endpoints[0], *xy, endpoints[1]])
            cuts.append(line.buffer(half_width, cap_style='flat', join_style='mitre', mitre_limit=2))
            samples.extend(span)

    def opening_floor(x, z):
        # 洞口截面只补门楣上方的山体，车行净空向下留给铺装与洞门。
        for px, pz, dx, dz, half, portal_y in portal_sections:
            along = (x - px) * dx + (z - pz) * dz
            across = (x - px) * dz - (z - pz) * dx
            if -2.3 <= along <= 0.55 and abs(across) <= half + 0.3:
                return portal_y + NANPING_HEADROOM_M
        return -math.inf

    if restore_entries:
        # 回填真实接地道路的来向；转弯/分流处不能用桥面切线猜地面引道的位置。
        for index, edge in enumerate(graph['links']):
            meta = graph['metadata'][index]
            if index in profiles or meta['tunnel'] or meta['bridge'] or meta['layer']:
                continue
            for node, reverse in [(edge[0], False), (edge[1], True)]:
                if node not in ground_ends:
                    continue
                coords = _source_points(graph, edge)
                line = LineString(coords[::-1] if reverse else coords)
                approach = substring(line, 0, min(line.length, 12))
                at, inner = approach.coords[:2]
                if rendered_height(*at) is not None and rendered_height(*inner) is not None:
                    continue
                dx, dz = inner[0] - at[0], inner[1] - at[1]
                run = math.hypot(dx, dz)
                lead = (at[0] - 0.65 * dx / run, at[1] - 0.65 * dz / run)
                apron = LineString([lead, *approach.coords]).buffer(deck_width(edge) / 2 + 1.0, cap_style='flat')
                entry_ground.append(apron)
                removed_entries.append(apron)

    mask = unary_union(cuts)
    if entry_ground:
        mask = mask.difference(unary_union(entry_ground))
    walls = build_cut_walls(mask, samples, sampler, opening_floor=opening_floor)
    cut, area = cut_ground_openings(surface, mask) if not mask.is_empty else (surface, 0)
    if walls['positions']:
        cut['cutWalls'] = merge_cut_walls(surface.get('cutWalls'), walls, mask)
    if removed_entries:
        restored = unary_union(removed_entries)
        cut, _ = _restore_roof(cut, restored, fallback)
        cut['cutWalls'] = merge_cut_walls(cut.get('cutWalls'), {'positions': []}, restored)
    elevations = [y for curve in profiles.values() for _, y in curve]
    return cut, {'links': len(main), 'tunnelLinks': sum(meta['tunnel'] for _, meta, _ in main),
                 'minDeckY': min(elevations), 'maxDeckY': max(elevations),
                 'cutM2': round(area, 3), 'wallTriangles': walls['triangles']}


def _apply_nanping(surface, graph, structures, spec):
    profiles = _nanping_profiles(graph, structures, spec)
    if not profiles:
        return surface, None
    cut, stats = _cut_profiled_decks(surface, graph, profiles)
    cut['nanpingProfile'] = {'cutVersion': NANPING_CUT_VERSION, 'name': spec['name'],
                             'profiles': {_profile_key(graph, i): curve for i, curve in sorted(profiles.items())}}
    return cut, {**stats, 'heightSource': spec['heightSource']}


def _road_corridor_controls(route, lines, terrain):
    total = sum(line.length for line in lines)
    ends = [lines[0].coords[0], lines[-1].coords[-1]]
    joints = dict(zip(route['pathNodes'], [0.0, *[sum(line.length for line in lines[:i])
                                                 for i in range(1, len(lines) + 1)]], strict=True))
    locations = dict(zip(route['pathNodes'], [ends[0], *(line.coords[-1] for line in lines)], strict=True))
    if 'riseM' not in route:
        return [(total if s == 'end' else joints.get(s, s), y if y is not None else
                 ground_height(terrain, *locations.get(s, ends[s == 'end']))) for s, y in route['controlsM']]

    def terminal_y(value, point):
        if value == 'underpass':
            z = point[1]
            return HONGLI['boreFloorM'] + HONGLI['approachGrade'] * max(
                0, HONGLI['northPortalZ'] - z, z - HONGLI['southPortalZ'])
        return ground_height(terrain, *point) if value is None else value

    rise = route['riseM']
    anchors = {0.0: terminal_y(route['terminalY'][0], ends[0]),
               total: terminal_y(route['terminalY'][1], ends[-1]),
               **{joints[node]: y for node, y in route.get('joinDeckM', {}).items()}}
    # 车公庙的汇入与分流节点沿用既有一层桥面；避免把 DEM 局部高点加到桥面。
    def blend(distance):
        t = max(0, 1 - distance / 115)
        return t * t * (3 - 2 * t)

    stations = []
    middle = sorted(joints[node] for node in route.get('joinDeckM', {}))
    start = 0
    for line in lines:
        steps = math.ceil(line.length / 16)
        for j in range(steps + 1):
            d = line.length * j / steps
            x, z = line.interpolate(d).coords[0]
            s = start + d
            if stations and s - stations[-1][0] < 0.001:
                continue
            ground = ground_height(terrain, x, z) + rise
            influence = [(blend(abs(s - at)), y) for at, y in anchors.items() if abs(s - at) < 115]
            if middle and middle[0] <= s <= middle[-1]:
                # 同层立交内使用共享桥头之间的设计纵坡。
                k = min(bisect_right(middle, s), len(middle) - 1)
                a, b = middle[max(0, k - 1)], middle[k]
                ground = anchors[a] if a == b else anchors[a] + (anchors[b] - anchors[a]) * (s - a) / (b - a)
            weight = sum(w for w, _ in influence)
            y = (max(0, 1 - weight) * ground + sum(w * y for w, y in influence)) / max(1, weight)
            y = anchors.get(s, y)
            stations.append((s, y))
        start += line.length
    stations[-1] = (total, anchors[total])
    # 对 DEM 的局部尖峰限坡，保留两端的接点标高。
    grade = 0.075
    for step in (1, -1):
        for j in range(1, len(stations) - 1) if step == 1 else range(len(stations) - 2, 0, -1):
            s, y = stations[j]
            if s in anchors:
                continue
            previous_s, previous_y = stations[j - step]
            run = grade * abs(s - previous_s)
            stations[j] = s, min(previous_y + run, max(previous_y - run, y))
    return _compact_profile(stations)


def _apply_road_corridor_profiles(surface, payload, spec, *, extension=False):
    graph, terrain = payload['roadGraph'], payload['terrain']
    source = payload['mapRegions']['source']
    if (source['id'], source['sha256']) != (spec['source'], spec['osmSnapshotSha256']):
        raise ValueError('Road corridor profiles need the matching source snapshot')
    structures = payload['roadStructures']
    reference = set() if extension else set(spec['referenceRoutes'])
    routes = {row['id']: row for row in structures['routes'] if row['id'] in reference}
    if routes.keys() != reference:
        raise ValueError('Missing reviewed profiles for Meiguan Road')
    by_way = {}
    for index, meta in enumerate(graph['metadata']):
        by_way.setdefault(meta['osmId'], []).append(index)
    profiles, entrances, counts, heights = {}, {}, {}, {}

    def add(index, length, samples, shared_start, shared_end):
        if index in profiles or graph['metadata'][index]['tunnel']:
            raise ValueError('Road corridor profiles must use distinct links outside tunnels')
        curve = [[round(d / length, 8), round(y, 5)] for d, y in _compact_profile(samples)]
        profiles[index] = curve
        entrances[index] = [shared_start, shared_end]
        for node, y in zip(graph['links'][index][:2], [curve[0][1], curve[-1][1]], strict=True):
            if abs(heights.setdefault(node, y) - y) > 0.001:
                raise ValueError(f'Road corridor grade mismatch at {graph["nodeIds"][node]}')

    specs = spec['extensions' if extension else 'routes']
    continuations = {row['pathNodes'][0] for row in specs if 'start' not in row['groundEnds']}
    continuations.update(row['pathNodes'][-1] for row in specs if 'end' not in row['groundEnds'])
    for row in structures['records']:
        if row['route'] not in reference:
            continue
        index = row['index']
        edge = graph['links'][index]
        length = LineString(_source_points(graph, edge)).length
        stations = row['stations']
        samples = [(stations[j], stations[j + 2]) for j in range(0, len(stations), 8)]
        samples[-1] = (length, samples[-1][1])
        add(index, length, samples, row['sharedStart'] and graph['nodeIds'][edge[0]] not in continuations,
            row['sharedEnd'] and graph['nodeIds'][edge[1]] not in continuations)
        counts[row['route']] = counts.get(row['route'], 0) + 1

    for route in specs:
        path = route['pathNodes']
        indices = resolve_route({**route, 'portalNodes': [path[0], path[-1]]}, graph, by_way)
        if not indices or any(graph['links'][i][5] != 1 for i in indices):
            raise ValueError(f'Cannot resolve road corridor {route["id"]}')
        lines = [LineString(_source_points(graph, graph['links'][i])) for i in indices]
        total = sum(line.length for line in lines)
        ends = route['groundEnds']
        joins = set(route.get('groundJoins', []))
        controls = _road_corridor_controls(route, lines, terrain)
        if (controls[0][0] != 0 or controls[-1][0] != total or any(
                b <= a or abs(yb - ya) > 0.11 * (b - a) for (a, ya), (b, yb) in zip(controls, controls[1:]))):
            raise ValueError(f'Invalid grade controls for {route["id"]}')
        normalized = [(s / total, y) for s, y in controls]
        start = 0
        for j, (index, line) in enumerate(zip(indices, lines, strict=True)):
            length = line.length
            points = [start, *(s for s, _ in controls if start < s < start + length), start + length]
            add(index, length, [(s - start, _nanping_height(normalized, s / total)) for s in points],
                path[j] in joins or j == 0 and 'start' in ends,
                path[j + 1] in joins or j == len(indices) - 1 and 'end' in ends)
            start += length
        counts[route['id']] = len(indices)

    ground_ends = {node for index, ends in entrances.items()
                   for node, at_grade in zip(graph['links'][index][:2], ends, strict=True) if at_grade}
    cut, stats = _cut_profiled_decks(surface, graph, profiles, fallback=lambda x, z: ground_height(terrain, x, z),
                                    ground_ends=ground_ends, restore_entries=extension)
    cut['roadCorridorExtensions' if extension else 'roadCorridorProfiles'] = {
        _profile_key(graph, i): [*entrances[i], curve] for i, curve in sorted(profiles.items())
    }
    return cut, {**stats, 'routes': counts, 'heightSource': spec['heightSource']}


def _apply_tunnel_corridors(surface, payload, spec):
    routes = spec['tunnelReferenceRoutes']
    records = [row for row in payload['roadStructures']['records'] if row['route'] in routes]
    if {row['route'] for row in records} != set(routes):
        raise ValueError('Missing reviewed tunnel corridor profiles')
    ground = lambda x, z: ground_height(payload['terrain'], x, z)
    corridors, openings = [], []
    for row in records:
        if payload['roadGraph']['metadata'][row['index']]['osmId'] != row['way']:
            raise ValueError('Tunnel corridor source link mismatch')
        values = row['stations']
        frames = [values[i:i + 8] for i in range(0, len(values), 8)]
        corridors.append(strip(frames, extra=0.6))
        cover = row['coverM'] or [0, 0]
        # 只切开露天降坡段；洞顶地面保持完整，洞内路面使用同一套断面。
        for a, b in zip(frames, frames[1:]):
            d, x, y, z = [(a[i] + b[i]) / 2 for i in range(4)]
            if cover[1] > cover[0] and cover[0] <= d <= cover[1]:
                continue
            if ground(x, z) > y + 0.025:
                openings.append(strip([a, b], extra=0.6))
    # 先补回旧洞口规则误切的地面，再按连续纵断面重新挖开入口。
    water = unary_union([_polygon(rings) for rings in [*payload['water'], *payload['seaSurface']['polygons']]])
    dry = unary_union([_polygon(rings) for rings in payload['land']]).difference(water)
    restored, added = _restore_roof(surface, unary_union(corridors).intersection(dry), ground)
    cut, removed = cut_ground_openings(restored, unary_union(openings))
    cut['tunnelCorridorRoutes'] = routes
    return cut, {'routes': routes, 'links': len(records), 'restoredM2': round(added, 3),
                 'cutM2': round(removed, 3), 'heightSource': spec['heightSource']}


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
    if 'highDeckTunnelPortals' not in report:
        portal_report = {}
        mask = plan_tunnel_portal_mask(graph, surface, portal_report, high_deck_only=True)
        if not mask.is_empty:
            surface, area = cut_ground_openings(surface, mask)
            report['highDeckTunnelPortals'] = {**portal_report['tunnelPortals'], 'genericCutM2': round(area, 3)}
    surface = apply_elevated_cut(surface, graph, report)
    nanping = surface.get('nanpingProfile')
    if nanping and nanping['cutVersion'] != NANPING_CUT_VERSION:
        raise ValueError('Nanping grade changes require rebuilding the uncut terrain with --rebuild-ground')
    if not nanping:
        surface, stats = _apply_nanping(surface, graph, payload.get('roadStructures', {}),
                                        json.loads(NANPING_SOURCE.read_text()))
        if stats is not None:
            report['nanpingProfile'] = stats
    corridor_spec = json.loads(CORRIDOR_SOURCE.read_text())
    if 'roadCorridorProfiles' not in surface:
        surface, report['roadCorridorProfiles'] = _apply_road_corridor_profiles(
            surface, payload, corridor_spec)
    if surface.get('roadCorridorExtensionVersion') != 4:
        surface, report['roadCorridorExtensions'] = _apply_road_corridor_profiles(
            surface, payload, corridor_spec, extension=True)
        surface['roadCorridorExtensionVersion'] = 4
    if surface.get('tunnelCorridorRoutes') != corridor_spec['tunnelReferenceRoutes']:
        surface, report['tunnelCorridors'] = _apply_tunnel_corridors(surface, payload, corridor_spec)
    payload['terrainSurface'] = surface
    report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                                    triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']))
