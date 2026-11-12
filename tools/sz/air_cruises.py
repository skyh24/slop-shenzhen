"""从指定东行主路拓扑生成空中巡游线，接离段为明确的模拟航迹。"""

from collections import defaultdict
from heapq import heappop, heappush
from itertools import groupby
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point
from shapely.ops import substring

from geo import project

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/air-cruises.json'
MAX_CENTERLINE_DEVIATION_M = 2.5


def directed_edges(graph, roads):
    wanted = {(road['name'], road['highway']) for road in roads}
    adjacency = defaultdict(list)
    for link, meta in zip(graph['links'], graph['metadata']):
        a, b, name_index, width, _, direction, inner = link
        name = graph['names'][name_index]
        if (name, meta['highway']) not in wanted:
            continue
        xy = graph['nodes']
        points = [xy[2*a:2*a+2], *zip(inner[::2], inner[1::2]), xy[2*b:2*b+2]]
        for sign in (1, -1):
            if direction not in (0, sign):
                continue
            start, end = (a, b) if sign == 1 else (b, a)
            line = LineString(points if sign == 1 else points[::-1])
            adjacency[start].append({'start': start, 'end': end, 'line': line, 'sign': sign,
                                     'width': width, 'road': name, **meta})
    return adjacency


def match_endpoint(spec, graph):
    target = Point(project(*spec['mainLonLat']))
    candidates = []
    for edges in graph.values():
        for edge in edges:
            if edge['osmId'] != spec['mainWayId']:
                continue
            line = edge['line']
            if line.coords[-1][0] <= line.coords[0][0]:
                continue
            candidates.append((line.distance(target), edge))
    if not candidates:
        raise ValueError(f"Missing eastbound main road near {spec['mainWayId']}")
    distance, edge = min(candidates, key=lambda row: row[0])
    if distance > 3:
        raise ValueError(f"Main road anchor moved by {distance:.1f} m: {spec['mainWayId']}")
    return edge, edge['line'].project(target)


def main_path(adjacency, first, last):
    start, start_m = first
    end, end_m = last
    if start is end:
        if end_m <= start_m:
            raise ValueError('Air cruise must advance along the directed main road')
        return [(start, start_m, end_m)]
    src, dst = start['end'], end['start']
    distance, parent, queue = {src: 0}, {}, [(0, src)]
    while queue:
        length, node = heappop(queue)
        if length != distance[node]:
            continue
        if node == dst:
            break
        for edge in adjacency[node]:
            next_node = edge['end']
            cost = length + edge['line'].length
            if cost >= distance.get(next_node, math.inf):
                continue
            distance[next_node] = cost
            parent[next_node] = edge
            heappush(queue, (cost, next_node))
    if dst not in distance:
        raise ValueError(f"No connected main road between {start['osmId']} and {end['osmId']}")
    edges = []
    while dst != src:
        edge = parent[dst]
        edges.append((edge, 0, edge['line'].length))
        dst = edge['start']
    return [(start, start_m, start['line'].length), *reversed(edges), (end, 0, end_m)]


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def round_corners(points):
    result = [points[0]]
    for a, b, c in zip(points, points[1:], points[2:]):
        left, right = math.dist(a, b), math.dist(b, c)
        if min(left, right) < 0.01:
            result.append(b)
            continue
        trim = min(9.0, left / 3, right / 3)
        p, q = mix(b, a, trim / left), mix(b, c, trim / right)
        curve = [mix(mix(p, b, i/6), mix(b, q, i/6), i/6) for i in range(7)]
        # 弯道修圆只取同一源道路走廊。急弯收短控制柄，避免切到路外。
        corner = LineString([p, b, q])
        if not corner.buffer(MAX_CENTERLINE_DEVIATION_M).covers(LineString(curve)):
            trim = min(trim, 2 * MAX_CENTERLINE_DEVIATION_M)
            p, q = mix(b, a, trim / left), mix(b, c, trim / right)
            curve = [mix(mix(p, b, i/6), mix(b, q, i/6), i/6) for i in range(7)]
        result.extend(curve)
    result.append(points[-1])
    return result


def access_curve(anchor, join, neighbour, departing):
    length = math.dist(anchor, join)
    if not 5 <= length <= 150:
        raise ValueError(f'Air cruise access chord out of bounds: {length:.1f} m')
    # 航空接离段与主路切向相接；不把跨过的地面道路标成巡游主路。
    tangent = mix(join, neighbour, -(length * 0.45) / math.dist(join, neighbour))
    ctrl = mix(anchor, tangent, 0.38)
    curve = []
    for i in range(33):
        t = i / 32
        curve.append(mix(mix(mix(anchor, ctrl, t), mix(ctrl, tangent, t), t),
                         mix(mix(ctrl, tangent, t), mix(tangent, join, t), t), t))
    return curve[::-1] if departing else curve


def sample(points, step):
    result = [points[0]]
    for a, b in zip(points, points[1:]):
        count = math.ceil(math.dist(a, b) / step)
        result.extend(mix(a, b, i/count) for i in range(1, count + 1))
    rounded = [tuple(round(v, 2) for v in point) for point in result]
    return [point for point, _ in groupby(rounded)]


def build_route(spec, graph, step):
    adjacency = directed_edges(graph, spec['roads'])
    first = match_endpoint(spec['start'], adjacency)
    last = match_endpoint(spec['end'], adjacency)
    selected = main_path(adjacency, first, last)
    if [name for name, _ in groupby(row[0]['road'] for row in selected)] != [road['name'] for road in spec['roads']]:
        raise ValueError(f"Unexpected main road sequence: {spec['id']}")
    raw, marks = [], []
    for edge, from_m, to_m in selected:
        if to_m <= from_m:
            continue
        points = list(substring(edge['line'], from_m, to_m).coords)
        raw.extend(points if not raw else points[1:])
        marks.append((edge, from_m, to_m, points[0], points[-1]))
    main = sample(round_corners(raw), step)
    centerline, main_line = LineString(raw), LineString(main)
    if not centerline.buffer(MAX_CENTERLINE_DEVIATION_M + 0.02).covers(main_line):
        raise ValueError(f"Smoothed path exceeds main corridor: {spec['id']}")
    entry = spec['start'].get('anchorLonLat')
    departure = spec['end'].get('anchorLonLat')
    before = sample(access_curve(project(*entry), main[0], main[1], False), step) if entry else [main[0]]
    after = sample(access_curve(project(*departure), main[-1], main[-2], True), step) if departure else [main[-1]]
    entry_m = LineString(before).length if entry else 0
    exit_m = LineString(after).length if departure else 0
    segments = []

    def record(kind, from_m, to_m, **details):
        segments.append({'kind': kind, 'fromM': round(from_m, 2), 'toM': round(to_m, 2), **details})

    if entry:
        record('entry', 0, entry_m)
    station = entry_m
    for i, (edge, from_m, to_m, _, endpoint) in enumerate(marks):
        end_station = entry_m + (main_line.length if i == len(marks) - 1 else main_line.project(Point(endpoint)))
        if end_station <= station:
            raise ValueError(f"Non-monotonic cruise chainage: {spec['id']}")
        record('main', station, end_station, road=edge['road'], osmId=edge['osmId'],
               fromNode=graph['nodeIds'][edge['start']], toNode=graph['nodeIds'][edge['end']],
               direction=edge['sign'], sourceFromM=round(from_m, 2), sourceToM=round(to_m, 2),
               bridge=edge['bridge'], tunnel=edge['tunnel'])
        station = end_station
    if departure:
        record('departure', station, station + exit_m)
    return {**spec, 'points': before[:-1] + main + after[1:], 'segments': segments,
            'horizontalLengthM': round(station + exit_m, 2)}


def build_air_cruises(graph, source):
    manifest = json.loads(MANIFEST.read_text())
    routes = [build_route(spec, graph, manifest['flight']['sampleStepM']) for spec in manifest['routes']]
    package = {**manifest, 'roadSourceSha256': source['sha256'], 'routes': routes}
    report = {**package, 'routes': [{k: v for k, v in route.items() if k != 'points'} for route in routes]}
    return package, report
