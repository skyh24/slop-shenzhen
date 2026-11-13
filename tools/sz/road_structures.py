"""由已审核的源边编译桥隧纵断面及同源洞口边界。"""

import math
from bisect import bisect_right
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


def eased_grade_run(distance, length, curve):
    # 两端以抛物线接水平路面，中段保持常坡。
    d = min(length, max(0, distance))
    if d < curve:
        return d * d / (2 * curve)
    if d > length - curve:
        return length - curve - (length - d) ** 2 / (2 * curve)
    return d - curve / 2


def compile_interchange_ramp(route, graph, grid, indices, config, accepted):
    junction = route['junction']
    links = [graph['links'][i] for i in indices]
    if any(not graph['metadata'][i]['highway'].endswith('_link') or graph['metadata'][i]['tunnel']
           for i in indices):
        raise ValueError('Interchange ramps require sourced road links')
    anchor = graph['nodeIds'].index(junction['node'])
    end_at_deck = links[-1][1] == anchor
    if end_at_deck == (links[0][0] == anchor):
        raise ValueError('Ramp must share exactly one endpoint with its mainline')
    mainline = next((parts for parent, parts, *_ in accepted if parent['id'] == junction['mainline']), [])
    incoming = next((part for part in mainline if graph['links'][part['index']][1] == anchor), None)
    outgoing = next((part for part in mainline if graph['links'][part['index']][0] == anchor), None)
    if not incoming or not outgoing or any(part['kind'] == 'tunnel' for part in (incoming, outgoing)):
        raise ValueError('Ramp must join a continuous compiled mainline at its source node')
    deck_y = outgoing['stations'][2]
    if abs(deck_y - incoming['stations'][-6]) > 0.005:
        raise ValueError('Ramp junction has incompatible mainline elevations')
    paths = [source_points(graph, link) for link in links]
    lengths = [LineString(path).length for path in paths]
    length = sum(lengths)
    ground_y = ground_height(grid, *(paths[0][0] if end_at_deck else paths[-1][-1]))
    apron = 8
    merge = junction.get('mergeM', {'loop': 30, 'side': 105}[junction['template']])
    if not math.isfinite(merge) or merge <= 0:
        raise ValueError('Reviewed ramp merge length must be positive')
    run = length - merge - apron
    curve = min(36, run / 3)
    if run <= 0 or abs(deck_y - ground_y) / (run - curve) > config['maxGrade']:
        raise ValueError('Insufficient source length for a gradual interchange ramp')

    def profile(s):
        # 折算里程始终从地面端起算。
        rise = eased_grade_run((s if end_at_deck else length - s) - apron, run, curve)
        return ground_y + (deck_y - ground_y) * rise / (run - curve)

    parts, openings = [], []
    station = 0
    breaks = [apron, apron + curve, length - merge - curve, length - merge]
    for i, (index, path, span) in enumerate(zip(indices, paths, lengths, strict=True)):
        width, lanes = links[i][3:5]
        meta = graph['metadata'][index]
        if meta['osmId'] in route.get('rampWidthsM', {}):
            estimate = route['rampWidthsM'][meta['osmId']]
            if meta['widthSource'] not in ('estimate-from-class', 'estimate-from-lanes') or not width <= estimate <= width + 2:
                raise ValueError(f"Reviewed ramp width would overwrite source dimensions: {meta['osmId']}")
            width = estimate
        events = [(s if end_at_deck else length - s) - station for s in breaks]
        frames = station_frames(path, [s for s in events if 0 < s < span], lambda s: profile(station + s), lambda _: width,
                                tangent_span=3.0)
        grade = sampled_grade(frames)
        if grade > config['maxGrade']:
            raise ValueError(f"Rendered interchange ramp grade exceeds cap: {grade:.5f}")
        shared_start = i == 0 and end_at_deck
        shared_end = i == len(links) - 1 and not end_at_deck
        for a, b in zip(frames, frames[1:]):
            if (shared_start and a[0] < apron - 1e-5) or (shared_end and b[0] > span - apron + 1e-5):
                continue
            if any(ground_height(grid, f[k], f[k + 1]) > f[2] + 0.015 for f in (a, b) for k in (4, 6)):
                openings.append(strip([a, b]))
        parts.append({'index': index, 'way': graph['metadata'][index]['osmId'], 'route': route['id'], 'kind': 'ramp',
                      'layer': outgoing.get('layer', 1), 'heightSource': 'project-design-estimate',
                      'stations': [value for frame in frames for value in frame], 'stationOffsetM': round(station, 6),
                      'widthM': width, 'lanes': lanes, 'sharedStart': shared_start, 'sharedEnd': shared_end,
                      'coverM': None, 'openApronM': apron, 'maxGrade': round(grade, 6)})
        station += span
    connection = {'ramp': indices[-1 if end_at_deck else 0], 'incoming': incoming['index'],
                  'outgoing': outgoing['index'], 'template': junction['template']}
    return parts, unary_union(openings), Polygon(), connection


def station_frames(points, events, profile, width_at, *, tangent_span=0.005):
    line = LineString(points)
    corners = [0.]
    for a, b in zip(points, points[1:]):
        corners.append(corners[-1] + math.dist(a, b))
    # 源折点和洞顶起终点为固定站，细分其间距离后仍保留源中心线。
    distances = [0.]
    for s in sorted(set(round(s, 6) for s in [*events, *corners[1:-1]])):
        if s - distances[-1] >= 0.025 and line.length - s >= 0.025:
            distances.append(s)
    distances.append(line.length)
    runs = []
    for a, b in zip(distances, distances[1:]):
        steps = math.ceil((b - a) / 4)
        runs.extend(a + (b - a) * i / steps for i in range(steps))
    runs.append(distances[-1])
    frames = []
    for s in runs:
        x, z = line.interpolate(s).coords[0]
        a = line.interpolate(max(0, s - tangent_span))
        b = line.interpolate(min(line.length, s + tangent_span))
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

    triangles = []
    for a, b in zip(frames, frames[1:]):
        left_a, right_a, left_b, right_b = edge(a, 4), edge(a, 6), edge(b, 4), edge(b, 6)
        triangles.extend((Polygon([left_a, right_a, right_b]), Polygon([left_a, right_b, left_b])))
    return unary_union([triangle for triangle in triangles if triangle.area > 1e-9])


def resolve_route(route, graph, by_way):
    nodes = graph['nodeIds']
    if path := route.get('pathNodes'):
        if len(path) != len(route['ways']) + 1 or [path[0], path[-1]] != route['portalNodes']:
            raise ValueError('Reviewed path does not match route endpoints')
        indices = []
        for way, a, b in zip(route['ways'], path, path[1:]):
            matches = [i for i in by_way[way] if [nodes[n] for n in graph['links'][i][:2]] == [a, b]]
            if len(matches) != 1:
                raise ValueError(f'Reviewed way and nodes do not identify one link: {way}')
            indices.extend(matches)
        return indices
    paths_by_end = {nodes.index(route['portalNodes'][0]): []}
    for way in route['ways']:
        paths_by_end = {graph['links'][i][1]: [*paths_by_end[graph['links'][i][0]], i]
                        for i in by_way[way] if graph['links'][i][0] in paths_by_end}
    return paths_by_end.get(nodes.index(route['portalNodes'][1]))


def sampled_grade(frames):
    return max(abs(b[2] - a[2]) / max(1e-9, math.hypot(b[x] - a[x], b[z] - a[z]))
               for a, b in zip(frames, frames[1:]) for x, z in ((1, 3), (4, 5), (6, 7)))


def compile_reviewed_profile(route, graph, grid, indices, config):
    links = [graph['links'][i] for i in indices]
    lines = [LineString(source_points(graph, link)) for link in links]
    total = sum(line.length for line in lines)
    station, heights = map(list, zip(*route['profileM']))
    shared = [not graph['nodeIds'][node].startswith('clip/') for node in (links[0][0], links[-1][1])]
    if station[0] != 0 or abs(station[-1] - total) > 0.05 or any(a >= b for a, b in zip(station, station[1:])):
        raise ValueError('Reviewed profile stations no longer match the source route')
    station[-1] = total
    for i, line in enumerate((lines[0], lines[-1])):
        endpoint = 0 if i == 0 else -1
        if shared[i]:
            expected = ground_height(grid, *line.coords[endpoint])
            if abs(expected - heights[endpoint]) > 0.05:
                raise ValueError('Reviewed profile does not meet the existing road at its endpoint')
            heights[endpoint] = expected
    curve_m = route.get('verticalCurveM')
    if curve_m is not None and (not math.isfinite(curve_m) or curve_m <= 0):
        raise ValueError('Reviewed vertical curve length must be positive')
    spans = [end - start for start, end in zip(station, station[1:])]
    curves = [min(curve_m, span / 2) if curve_m is not None else None for span in spans]
    runs = [span - curve if curve is not None else span / 1.5 for span, curve in zip(spans, curves, strict=True)]
    if any(abs(b - a) / run > config['maxGrade'] for a, b, run in zip(heights, heights[1:], runs)):
        raise ValueError('Reviewed vertical curve exceeds maximum grade')

    def profile(s):
        i = max(0, min(len(station) - 2, bisect_right(station, s) - 1))
        span, curve = spans[i], curves[i]
        d = s - station[i]
        if curve is None:
            weight = ease(d / span)
        else:
            weight = eased_grade_run(d, span, curve) / runs[i]
        return heights[i] + (heights[i + 1] - heights[i]) * weight

    records, openings, envelope = [], [], []
    distance = 0
    portal_ways = set(route.get('portalApproachWays', []))
    portal_cover = route.get('portalCoverM', {})
    bridge_widths = route.get('bridgeWidthsM', {})
    section_widths = {**route.get('approachWidthsM', {}), **bridge_widths}
    widths = [section_widths.get(graph['metadata'][index]['osmId'], link[3])
              for index, link in zip(indices, links, strict=True)]
    for j, (index, link, line) in enumerate(zip(indices, links, lines, strict=True)):
        meta = graph['metadata'][index]
        tunnel = bool(meta['tunnel'])
        portal = meta['osmId'] in portal_ways
        cover = [0, line.length] if tunnel else portal_cover.get(meta['osmId'], [0, 0]) if portal else None
        bridge = bool(meta['bridge'])
        if tunnel and meta['osmId'] not in route.get('boreWays', []):
            raise ValueError(f"Unreviewed tunnel in profile: {meta['osmId']}")
        if not (tunnel or bridge or (portal and meta['layer'] < 0) or meta['heightSource'] == 'terrain'):
            raise ValueError(f"Unknown elevation on reviewed route: {meta['osmId']}")
        width, lanes = widths[j], link[4]
        if meta['osmId'] in section_widths:
            if (tunnel or bridge != (meta['osmId'] in bridge_widths)
                    or meta['widthSource'] != 'estimate-from-class' or not 6 <= width <= link[3]):
                raise ValueError(f"Reviewed section width would overwrite source dimensions: {meta['osmId']}")
            lanes = route['lanes']
        events = [s - distance for s in station if distance < s < distance + line.length]
        for s, end, curve in zip(station, station[1:], curves):
            if curve is not None:
                events.extend(p - distance for p in (s + curve, end - curve) if distance < p < distance + line.length)
        start_apron = route.get('groundApronM', [0, 0])[0] if j == 0 and shared[0] else 0
        end_apron = route.get('groundApronM', [0, 0])[1] if j == len(links) - 1 and shared[1] else 0
        events.extend([start_apron, line.length - end_apron])
        if cover:
            if not 0 <= cover[0] <= cover[1] <= line.length:
                raise ValueError(f"Reviewed portal cover is outside its source way: {meta['osmId']}")
            events.extend(cover)
        def width_at(s):
            before = (widths[j - 1] + width) / 2 if j else width
            after = (widths[j + 1] + width) / 2 if j + 1 < len(widths) else width
            taper = min(60, line.length / 2)
            return width + (before - width) * (1 - ease(s / taper)) \
                + (after - width) * (1 - ease((line.length - s) / taper))

        frames = station_frames(list(line.coords), events, lambda s: profile(distance + s), width_at,
                                tangent_span=3.0 if curve_m is not None else 0.005)
        grade = sampled_grade(frames)
        if grade > config['maxGrade']:
            raise ValueError(f"Rendered longitudinal grade exceeds cap: {meta['osmId']} {grade:.5f}")
        if tunnel or portal:
            # 洞顶按纵断面求标高，地形仅用来校验覆土。
            roof = config['tunnelClearanceM'] + config['tunnelRoofM']
            for frame in frames:
                if cover[0] - 1e-5 <= frame[0] <= cover[1] + 1e-5 and cover[1] > cover[0] \
                        and min(ground_height(grid, frame[k], frame[k + 1]) for k in (4, 6)) < frame[2] + roof - 0.03:
                    raise ValueError(f"Insufficient cover at reviewed mountain bore: {meta['osmId']}")
            if cover[1] > cover[0]:
                envelope.append(strip([f for f in frames if cover[0] - 1e-5 <= f[0] <= cover[1] + 1e-5],
                                      config['tunnelWallM']))
        if not tunnel:
            # 挖方仅裁去路线实际低于地坪的断面。高出地坪的部分由实体路基承托。
            for a, b in zip(frames, frames[1:]):
                if a[0] < start_apron or b[0] > frames[-1][0] - end_apron + 1e-5:
                    continue
                if cover and a[0] >= cover[0] - 1e-5 and b[0] <= cover[1] + 1e-5:
                    continue
                if any(ground_height(grid, frame[k], frame[k + 1]) > frame[2] + 0.015
                       for frame in (a, b) for k in (4, 6)):
                    openings.append(strip([a, b]))
        kind = 'tunnel' if tunnel or portal else 'bridge' if bridge else 'approach'
        records.append({'index': index, 'way': meta['osmId'], 'route': route['id'], 'kind': kind,
                        'layer': meta['layer'], 'heightSource': 'project-design-estimate',
                        'stations': [value for frame in frames for value in frame], 'stationOffsetM': round(distance, 6),
                        'widthM': width, 'lanes': lanes, 'sharedStart': j == 0 and shared[0],
                        'sharedEnd': j == len(links) - 1 and shared[1], 'coverM': cover,
                        'openApronM': max(start_apron, end_apron), 'maxGrade': round(grade, 6)})
        distance += line.length
    return records, unary_union(openings), unary_union(envelope)


def compile_route(route, graph, grid, by_way, config, accepted=()):
    indices = resolve_route(route, graph, by_way)
    if not indices:
        raise ValueError('Reviewed way sequence does not connect both endpoint nodes')
    links = [graph['links'][i] for i in indices]
    if any(link[5] != 1 for link in links) or any(a[1] != b[0] for a, b in zip(links, links[1:])):
        raise ValueError('Route must have continuous, forward source nodes')
    if route.get('junction'):
        return compile_interchange_ramp(route, graph, grid, indices, config, accepted)
    if route.get('profileM'):
        return compile_reviewed_profile(route, graph, grid, indices, config)
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
        max_grade = sampled_grade(frames)
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


def bridge_crossing_clearance(record, graph, grid, lines, tree, slab, replaced=()):
    stations = record['stations']
    frames = [stations[i:i + 8] for i in range(0, len(stations), 8)]
    projection = strip(frames)
    minimum = math.inf
    crossing_ways = []
    own = graph['links'][record['index']]
    for index in map(int, tree.query(projection, predicate='intersects')):
        meta = graph['metadata'][index]
        link = graph['links'][index]
        if index in replaced or index == record['index'] or set(own[:2]) & set(link[:2]) or meta['heightSource'] != 'terrain':
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
    accepted, conflicts = [], []
    connections = {}
    for route in manifest['routes']:
        try:
            parts, opening, envelope, *junction = compile_route(route, graph, grid, by_way, manifest, accepted)
            if junction and route['junction']['mainline'] == route['id']:
                raise ValueError('Ramp cannot be its own mainline')
            clearances = []
            replaced = {part['index'] for _, group, *_ in accepted for part in group} | {part['index'] for part in parts}
            for part in parts:
                if part['kind'] not in ('bridge', 'ramp'):
                    continue
                clearance, crossings = bridge_crossing_clearance(part, graph, grid, road_lines, road_tree,
                                                                 manifest['bridgeSlabM'], replaced if junction else ())
                if clearance is not None and clearance < manifest['minimumVehicleClearanceM']:
                    raise ValueError(f'Bridge underside clearance is insufficient: {clearance:.3f} m')
                clearances.append({'route': route['id'], 'way': part['way'], 'minimumM': clearance, 'crossingWays': crossings})
            if not envelope.is_empty and any(envelope.intersection(other).area > 0.01 for _, _, _, other, _ in accepted):
                raise ValueError('Adjacent bore envelopes overlap')
        except ValueError as error:
            conflicts.append({'route': route['id'], 'ways': route['ways'], 'reason': str(error)})
            continue
        accepted.append((route, parts, opening, envelope, clearances))
        if junction:
            connections[route['id']] = junction[0]
    # 仅剔除发生冲突的开挖路线。被剔除的路线恢复为原始地面后，再校验剩余洞口。
    if any(not opening.is_empty for _, _, opening, _, _ in accepted):
        bounds = unary_union([opening for _, _, opening, _, _ in accepted]).bounds
        b = payload['buildings']
        building_shapes = []
        for i, rings in enumerate(b['rings']):
            outer = ring_points(rings[0])
            min_x, min_z, max_x, max_z = bounds
            if max(x for x, _ in outer) < min_x or min(x for x, _ in outer) > max_x \
                or max(z for _, z in outer) < min_z or min(z for _, z in outer) > max_z:
                continue
            building_shapes.append((b['id'][i], make_valid(Polygon(outer, [ring_points(r) for r in rings[1:]]))))
        building_tree = STRtree([shape for _, shape in building_shapes])
    while any(not opening.is_empty for _, _, opening, _, _ in accepted):
        replacements = {part['index'] for _, parts, _, _, _ in accepted for part in parts}
        temp_graph = {**graph, 'metadata': [dict(m, heightSource='structure-approach') if i in replacements else m
                                         for i, m in enumerate(graph['metadata'])]}
        keep = []
        for candidate in accepted:
            route, _, opening, _, _ = candidate
            if not opening.is_empty:
                carriageway, details = ground_carriageway_mask(opening, temp_graph)
                blocked = [building_shapes[i][0] for i in building_tree.query(opening, predicate='intersects')
                           if building_shapes[i][1].intersection(opening).area > 0.01]
                if carriageway.area > 0.05 or blocked:
                    reason = {'groundRoads': details['roadOsmIds'], 'roadOverlapM2': round(carriageway.area, 3),
                              'buildings': sorted(set(blocked))}
                    conflicts.append({'route': route['id'], 'ways': route['ways'], 'reason': reason})
                    continue
            keep.append(candidate)
        if len(keep) == len(accepted):
            break
        parents = {route['id'] for route, *_ in keep}
        accepted = []
        for candidate in keep:
            route = candidate[0]
            if route.get('junction') and route['junction']['mainline'] not in parents:
                conflicts.append({'route': route['id'], 'ways': route['ways'], 'reason': 'Ramp mainline was rejected'})
            else:
                accepted.append(candidate)
    routes = [route for route, _, _, _, _ in accepted]
    records = [part for _, parts, _, _, _ in accepted for part in parts]
    clearances = [row for _, _, _, _, clearances in accepted for row in clearances]
    mask = unary_union([opening for _, _, opening, _, _ in accepted])
    previous = payload.get('roadStructures')
    configuration = {key: value for key, value in manifest.items() if key not in ('routes', 'landscape')}
    landscape = compile_landscape(payload, manifest.get('landscape'), graph, road_lines)
    plan = {**configuration, 'routes': routes, 'records': records, 'landscape': landscape}
    if connections:
        plan['connections'] = [connections[route['id']] for route in routes if route['id'] in connections]
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
    report['roadStructures']['connections'] = plan.get('connections', [])
