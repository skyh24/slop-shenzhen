"""从锁定 OSM 快照提取深圳北国铁站场；道岔只采用共享节点。"""

from collections import defaultdict
import heapq
import json
import math
from pathlib import Path

import osmium

from geo import project
from landmark_sites import _encode_geometry
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'data/source/shenzhen-north-rail.json'
# 只用于站场的横断面与范围筛选；输出仍用全城米制坐标。
CENTER = (-3138.1, -7285.3)
AXIS = (0.678056, 0.73501)
EXTENT = (-1745, 1930)


def axis(point):
    x, z = point[0] - CENTER[0], point[1] - CENTER[1]
    dx, dz = AXIS
    return x * dz - z * dx, x * dx + z * dz


def crossing(a, b, v):
    u0, v0 = axis(a)
    u1, v1 = axis(b)
    if min(v0, v1) <= v < max(v0, v1):
        return u0 + (u1 - u0) * (v - v0) / (v1 - v0)
    return None


def shortest(start, goal, adjacency, points):
    queue = [(0, start, ())]
    visited = set()
    while queue:
        cost, node, path = heapq.heappop(queue)
        if node in visited:
            continue
        visited.add(node)
        if node == goal:
            return path
        for other, edge in adjacency[node]:
            if other not in visited:
                lateral = abs(axis(points[node])[0] - axis(points[other])[0])
                heapq.heappush(queue, (cost + math.dist(points[node], points[other]) + lateral, other, (*path, edge)))
    return None


def make_routes(edges, points, manifest):
    south, north = defaultdict(list), defaultdict(list)
    tracks = []
    for i, (a, b, _) in enumerate(edges):
        if axis(points[a])[1] > axis(points[b])[1]:
            a, b = b, a
            directed = -i - 1
        else:
            directed = i + 1
        south[a].append((b, directed))
        north[b].append((a, -directed))
        u = crossing(points[a], points[b], 0)
        if u is not None:
            tracks.append((u, directed, a, b))
    tracks.sort()
    if len(tracks) != manifest['published']['tracks']:
        raise ValueError(f'Unexpected Shenzhen North track count: {len(tracks)}')
    # 两端真实连接先从不同接入线选路；重叠资源在运行时等待。
    routes = []
    for i, (_, edge, a, b) in enumerate(tracks):
        north_gates = manifest['northGates']
        south_gates = manifest['southGates']
        n = next((r for off in range(len(north_gates))
                  if (r := shortest(a, north_gates[(i + off) % len(north_gates)], north, points)) is not None), None)
        s = next((r for off in range(len(south_gates))
                  if (r := shortest(b, south_gates[(i + off) % len(south_gates)], south, points)) is not None), None)
        if n is None or s is None:
            raise ValueError(f'Unconnected Shenzhen North berth: {i}')
        path = [-k for k in reversed(n)] + [edge] + list(s)
        # 两方向演示分配到交错股道；方向表示几何运行方向，不代表实际上下行指派。
        direction = 1 if i % 2 == 0 else -1
        routes.append({'berth': i + 1, 'direction': direction,
                       'edges': path if direction == 1 else [-k for k in reversed(path)]})
    # 让可辨识的两侧股道先参与演示，并交替扫描两端。
    order = [19, 2, 17, 4, 15, 6, 13, 8, 11, 10, 9, 12, 7, 14, 5, 16, 3, 18, 1, 20]
    return [routes[i - 1] for i in order]


def compile_rail(ways, manifest):
    points, edges, ids = {}, [], []
    plazas, walks = {}, {}
    place_roles = {v: k for k, v in manifest['plazas'].items()}
    walk_roles = {v: k for k, v in manifest['walks'].items()}
    for identity, tags, refs, coords in sorted(ways):
        if identity in place_roles:
            if tags.get('highway') != 'pedestrian' or refs[0] != refs[-1]:
                raise ValueError(f'Invalid station plaza source: {identity}')
            plazas[place_roles[identity]] = {'id': f'way/{identity}', 'rings': _encode_geometry(Polygon(coords))[0]}
        if identity in walk_roles:
            walks[walk_roles[identity]] = {'id': f'way/{identity}', 'points': [[round(v, 2) for v in p] for p in coords]}
        if tags.get('railway') != 'rail' or tags.get('tunnel') or tags.get('name') == '平南线':
            continue
        relevant = []
        for a, b, p, q in zip(refs, refs[1:], coords, coords[1:]):
            (u1, v1), (u2, v2) = axis(p), axis(q)
            if min(v1, v2) > EXTENT[1] or max(v1, v2) < EXTENT[0] or min(u1, u2) > 145 or max(u1, u2) < -145:
                continue
            if math.dist(p, q) < 0.04:
                continue
            points[a] = [round(v, 2) for v in p]
            points[b] = [round(v, 2) for v in q]
            relevant.append((a, b, len(ids)))
        if relevant:
            ids.append({'id': f'way/{identity}', 'layer': int(tags.get('layer', 0)),
                        'bridge': tags.get('bridge') not in (None, 'no'),
                        'line': tags.get('ref') or tags.get('name'), 'service': tags.get('service')})
            edges.extend(relevant)
    if plazas.keys() != manifest['plazas'].keys() or walks.keys() != manifest['walks'].keys():
        raise ValueError('Missing Shenzhen North public-space sources')
    nodes = sorted(points)
    indices = {node: i for i, node in enumerate(nodes)}
    routes = make_routes(edges, points, manifest)
    return {'version': 1, 'source': manifest['snapshot'], 'stationId': manifest['stationId'],
            'published': manifest['published'], 'heightSource': 'estimate', 'center': CENTER, 'axis': AXIS,
            'nodes': [[str(node), *points[node]] for node in nodes], 'ways': ids,
            'edges': [[indices[a], indices[b], way] for a, b, way in edges], 'routes': routes,
            'plazas': plazas, 'walks': walks}


def build_shenzhen_north(pbf, report):
    manifest = json.loads(MANIFEST.read_text())
    extra = set((*manifest['plazas'].values(), *manifest['walks'].values()))
    # 标签筛选后先按首个合法节点限缩扫描；保留穿越走廊的长线及其两端节点。
    reader = (osmium.FileProcessor(str(pbf)).with_locations()
              .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
              .with_filter(osmium.filter.KeyFilter('railway', 'highway')))
    ways = []
    for obj in reader:
        if obj.id not in extra and (obj.tags.get('railway') != 'rail' or obj.tags.get('tunnel')):
            continue
        try:
            ll = [(node.lon, node.lat) for node in obj.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(ll) < 2 or max(p[0] for p in ll) < 113.993 or min(p[0] for p in ll) > 114.05 \
                or max(p[1] for p in ll) < 22.593 or min(p[1] for p in ll) > 22.631:
            continue
        ways.append((obj.id, dict(obj.tags), [node.ref for node in obj.nodes], [project(*p) for p in ll]))
    result = compile_rail(ways, manifest)
    report['shenzhenNorthRail'] = {
        'source': manifest['snapshot'], 'stationId': manifest['stationId'], 'replacedBuildings': manifest['buildingIds'],
        'wayIds': [way['id'] for way in result['ways']], 'edges': len(result['edges']), 'routes': len(result['routes']),
        'publicSourceIds': [obj['id'] for key in ('plazas', 'walks') for obj in result[key].values()],
        'heightSource': result['heightSource'], 'published': result['published'], 'verifiedAt': manifest['verifiedAt'],
        'limitations': manifest['limitations'],
    }
    return result
