"""由已审核的源边编译桥隧纵断面及同源洞口边界。"""

import math
from collections import defaultdict

from shapely import make_valid
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from commercial_paving import cut_ground_openings, ground_carriageway_mask
from package_validation import ring_points
from road_landscape import compile_landscape
from terrain_surface import _polygons, _triangle_height


def source_points(graph, link):
    a, b, *_, inner = link
    nodes = graph['nodes']
    return [tuple(nodes[2 * a:2 * a + 2]), *zip(inner[::2], inner[1::2]), tuple(nodes[2 * b:2 * b + 2])]


def ground_height(grid, x, z):
    u, v = (x - grid['x0']) / grid['step'], (z - grid['z0']) / grid['step']
    col, row = math.floor(u), math.floor(v)
    if not (0 <= col < grid['nx'] - 1 and 0 <= row < grid['nz'] - 1):
        raise ValueError('Missing engineering surface height')
    u, v = u - col, v - row
    stride = grid['nx']
    i = row * stride + col
    a, b, c, d = [grid['heights'][j] * grid['heightScale'] for j in (i, i + 1, i + stride, i + stride + 1)]
    return a + (b - a) * u + (c - a) * v if u + v <= 1 else d + (c - d) * (1 - u) + (b - d) * (1 - v)


def ease(t):
    t = min(1, max(0, t))
    return t * t * (3 - 2 * t)


def station_frames(points, events, profile, width_at):
    line = LineString(points)
    corners = [0.]
    for a, b in zip(points, points[1:]):
        corners.append(corners[-1] + math.dist(a, b))
    # 源折点和洞顶起终点为固定站，细分其间距离后仍保留源中心线。
    distances = sorted(set(round(s, 6) for s in [*events, *corners]))
    runs = []
    for a, b in zip(distances, distances[1:]):
        steps = math.ceil((b - a) / 4)
        runs.extend(a + (b - a) * i / steps for i in range(steps))
    runs.append(distances[-1])
    frames = []
    for s in runs:
        x, z = line.interpolate(s).coords[0]
        a = line.interpolate(max(0, s - 0.005))
        b = line.interpolate(min(line.length, s + 0.005))
        dx, dz = b.x - a.x, b.y - a.y
        norm = math.hypot(dx, dz)
        half = width_at(s) / 2
        nx, nz = dz / norm * half, -dx / norm * half
        frames.append([round(value, 6) for value in (s, x, profile(s), z, x + nx, z + nz, x - nx, z - nz)])
    return frames


def strip(frames, extra=0):
    def edge(frame, offset):
        _, x, _, z, *_ = frame
        px, pz = frame[offset:offset + 2]
        width = math.hypot(px - x, pz - z)
        return px + (px - x) / width * extra, pz + (pz - z) / width * extra

    return unary_union([Polygon([edge(a, 4), edge(b, 4), edge(b, 6), edge(a, 6)])
                        for a, b in zip(frames, frames[1:])])


def compile_route(route, graph, grid, by_way, config):
    nodes = graph['nodeIds']
    paths_by_end = {nodes.index(route['portalNodes'][0]): []}
    for way in route['ways']:
        paths_by_end = {graph['links'][i][1]: [*paths_by_end[graph['links'][i][0]], i]
                        for i in by_way[way] if graph['links'][i][0] in paths_by_end}
    indices = paths_by_end.get(nodes.index(route['portalNodes'][1]))
    if not indices:
        raise ValueError('Reviewed way sequence does not connect both endpoint nodes')
    links = [graph['links'][i] for i in indices]
    if any(link[5] != 1 for link in links) or any(a[1] != b[0] for a, b in zip(links, links[1:])):
        raise ValueError('Route must have continuous, forward source nodes')
    tunnel = route['kind'] == 'tunnel'
    if tunnel and any(graph['metadata'][i]['tunnel'] != (graph['metadata'][i]['osmId'] == route['boreWay']) for i in indices):
        raise ValueError('Reviewed tunnel source tags have changed')
    if not tunnel and any(not graph['metadata'][i]['bridge'] or graph['metadata'][i]['tunnel'] for i in indices):
        raise ValueError('Reviewed bridge source tags have changed')
    paths = [source_points(graph, link) for link in links]
    lengths = [LineString(path).length for path in paths]
    total = sum(lengths)
    start, end = (ground_height(grid, *point) for point in (paths[0][0], paths[-1][-1]))
    baseline_grade = abs(end - start) / total
    rise = config['verticalStepM'] * (-1 if tunnel else 1)
    # 双端竖曲线与端点基准的坡度预算相加，保留边缘线长度变化余量。
    grade_budget = config['maxGrade'] - baseline_grade - 0.002
    if grade_budget <= 0:
        raise ValueError('Endpoint elevations exceed maximum grade')
    transition = math.ceil(abs(rise) * 1.5 / grade_budget)
    apron = 8 if tunnel else 0
    transition += apron
    if total <= 2 * transition or (tunnel and min(lengths[0], lengths[-1]) < transition):
        raise ValueError('Insufficient source length for both vertical curves')
    if tunnel and len(links) != 3:
        raise ValueError('Tunnel requires sourced approach, bore and exit')

    def profile(s):
        return start + (end - start) * s / total + rise * ease((min(s, total - s) - apron) / (transition - apron))

    records, openings, envelope = [], [], []
    distance = 0
    for j, (index, link, length, path) in enumerate(zip(indices, links, lengths, paths, strict=True)):
        paved_width = link[3]
        lanes = route.get('lanes', link[4])
        bore_width = paved_width
        if tunnel:
            # 源车道计数优先，快车道缩减只发生在两侧源段相接处。
            bore_width = max(links[1][3] if graph['metadata'][indices[1]]['widthSource'] == 'osm-width' else 0,
                             lanes * 3.5 + 1.2)
        seam_start = route.get('entryWidthM', link[3]) if j == 0 else bore_width
        seam_end = route.get('exitWidthM', link[3]) if j == len(links) - 1 else bore_width

        def width_at(s):
            if not tunnel:
                return paved_width
            return bore_width + (seam_start - bore_width) * (1 - ease(s / 60)) \
                + (seam_end - bore_width) * (1 - ease((length - s) / 60))

        events = [value - distance for value in (apron, transition, total - transition, total - apron) if distance < value < distance + length]
        frames = station_frames(path, events, lambda s: profile(distance + s), width_at)
        max_grade = 0
        for a, b in zip(frames, frames[1:]):
            for ax, az in ((1, 3), (4, 5), (6, 7)):
                max_grade = max(max_grade, abs(b[2] - a[2]) / max(1e-9, math.hypot(b[ax] - a[ax], b[az] - a[az])))
        if max_grade > config['maxGrade']:
            raise ValueError(f'Rendered longitudinal grade exceeds cap: {max_grade:.5f}')
        cover = [max(0, transition - distance), min(length, total - transition - distance)]
        if tunnel:
            if j == 0:
                openings.append(strip([f for f in frames if apron - 1e-5 <= f[0] <= cover[0] + 1e-5]))
            if j == len(links) - 1:
                openings.append(strip([f for f in frames if cover[1] - 1e-5 <= f[0] <= length - apron + 1e-5]))
            envelope.append(strip(frames, config['tunnelWallM']))
        records.append({'index': index, 'way': graph['metadata'][index]['osmId'], 'route': route['id'],
                        'kind': route['kind'], 'heightSource': 'project-design-estimate', 'stations': [v for frame in frames for v in frame],
                        'stationOffsetM': round(distance, 6), 'widthM': round(bore_width, 3), 'lanes': lanes,
                        'sharedStart': j == 0, 'sharedEnd': j == len(links) - 1,
                        'coverM': [round(value, 6) for value in cover] if tunnel else None,
                        'openApronM': apron, 'maxGrade': round(max_grade, 6)})
        distance += length
    return records, unary_union(openings), unary_union(envelope)


def bridge_crossing_clearance(record, graph, grid, lines, tree, slab):
    stations = record['stations']
    frames = [stations[i:i + 8] for i in range(0, len(stations), 8)]
    projection = strip(frames)
    minimum = math.inf
    crossing_ways = []
    own = graph['links'][record['index']]
    for index in map(int, tree.query(projection, predicate='intersects')):
        meta = graph['metadata'][index]
        link = graph['links'][index]
        if index == record['index'] or set(own[:2]) & set(link[:2]) or meta['heightSource'] != 'terrain':
            continue
        line = lines[index]
        # 下层中心线须穿越桥幅，邻近的平行地面幅不作为交叉口。
        if not line.crosses(projection):
            continue
        corridor = line.buffer(link[3] / 2, cap_style='flat')
        local_min = math.inf
        for a, b in zip(frames, frames[1:]):
            def edge(frame, i):
                return (frame[i], frame[2], frame[i + 1])
            la, ra, lb, rb = edge(a, 4), edge(a, 6), edge(b, 4), edge(b, 6)
            for face in ((la, ra, rb), (la, rb, lb)):
                poly = Polygon([(x, z) for x, _, z in face])
                for overlap in _polygons(poly.intersection(corridor)):
                    for x, z in overlap.exterior.coords:
                        gap = _triangle_height(face, x, z) - slab - ground_height(grid, x, z)
                        local_min = min(local_min, gap)
        if math.isfinite(local_min):
            crossing_ways.append({'way': meta['osmId'], 'clearanceM': round(local_min, 4)})
            minimum = min(minimum, local_min)
    return (round(minimum, 4) if math.isfinite(minimum) else None), crossing_ways


def compile_road_structures(payload, manifest, report, *, base=None):
    graph = payload['roadGraph']
    by_way = defaultdict(list)
    for i, meta in enumerate(graph['metadata']):
        by_way[meta['osmId']].append(i)
    grid = payload['terrain']
    road_lines = [LineString(source_points(graph, link)) for link in graph['links']]
    road_tree = STRtree(road_lines)
    routes, records, openings, envelopes, conflicts = [], [], [], [], []
    clearances = []
    for route in manifest['routes']:
        try:
            parts, opening, envelope = compile_route(route, graph, grid, by_way, manifest)
            if route['kind'] == 'bridge':
                clearance, crossings = bridge_crossing_clearance(parts[0], graph, grid, road_lines, road_tree,
                                                                  manifest['bridgeSlabM'])
                if clearance is not None and clearance < manifest['minimumVehicleClearanceM']:
                    raise ValueError(f'Bridge underside clearance is insufficient: {clearance:.3f} m')
                clearances.append({'route': route['id'], 'minimumM': clearance, 'crossingWays': crossings})
            if not envelope.is_empty and any(envelope.intersection(other).area > 0.01 for other in envelopes):
                raise ValueError('Adjacent bore envelopes overlap')
        except ValueError as error:
            conflicts.append({'route': route['id'], 'ways': route['ways'], 'reason': str(error)})
            continue
        routes.append(route)
        records.extend(parts)
        openings.append(opening)
        envelopes.append(envelope)
    # 只在审核路线的敞开段裁地形，已覆盖段继续由原地表承托上方道路。
    mask = unary_union(openings)
    if not mask.is_empty:
        # 洞口不能切进相邻地面道路或建筑轮廓。
        replacements = {r['index'] for r in records if r['kind'] == 'tunnel'}
        temp_graph = {**graph, 'metadata': [dict(m, heightSource='structure-approach') if i in replacements else m
                                         for i, m in enumerate(graph['metadata'])]}
        carriageway, details = ground_carriageway_mask(mask, temp_graph)
        building_shapes = []
        b = payload['buildings']
        for i, rings in enumerate(b['rings']):
            outer = ring_points(rings[0])
            min_x, min_z, max_x, max_z = mask.bounds
            if max(x for x, _ in outer) < min_x or min(x for x, _ in outer) > max_x \
                or max(z for _, z in outer) < min_z or min(z for _, z in outer) > max_z:
                continue
            building_shapes.append((b['id'][i], make_valid(Polygon(outer, [ring_points(r) for r in rings[1:]]))))
        blocked = [source_id for source_id, shape in building_shapes if shape.intersection(mask).area > 0.01]
        if carriageway.area > 0.05 or blocked:
            reason = {'groundRoads': details['roadOsmIds'], 'roadOverlapM2': round(carriageway.area, 3),
                      'buildings': sorted(set(blocked))}
            conflicts.extend({'route': r['id'], 'ways': r['ways'], 'reason': reason}
                             for r in routes if r['kind'] == 'tunnel')
            routes = [r for r in routes if r['kind'] != 'tunnel']
            records = [r for r in records if r['kind'] != 'tunnel']
            mask = Polygon()
    previous = payload.get('roadStructures')
    configuration = {key: value for key, value in manifest.items() if key not in ('routes', 'landscape')}
    landscape = compile_landscape(payload, manifest.get('landscape'), graph, road_lines)
    plan = {**configuration, 'routes': routes, 'records': records, 'landscape': landscape}
    if previous and previous != plan and base is None:
        raise ValueError('Changed portal geometry requires rebuilding from uncut terrain')
    if not previous or base is not None:
        surface, area = cut_ground_openings(base if base is not None else payload['terrainSurface'], mask)
        payload['terrainSurface'] = surface
        payload['roadStructures'] = plan
        report['roadStructures'] = {'portalCutM2': round(area, 3)}
    report['roadStructures'].update({'landscape': {
        'patches': [row['id'] for row in landscape['patches']],
        'estimatedTrees': len(landscape['trees']), 'sources': manifest.get('landscape')
    } if landscape else None, 'routes': routes, 'conflicts': conflicts, 'bridgeClearance': clearances,
                                     'tunnelMinimumClearanceM': round(manifest['tunnelClearanceM'] - manifest['tunnelLightDepthM'], 3),
                                     'segments': [{k: v for k, v in row.items() if k != 'stations'} for row in records]})
