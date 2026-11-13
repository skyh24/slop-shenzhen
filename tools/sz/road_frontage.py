"""从已核实的道路、过街、步道和信号节点生成街道试点。"""

import json
import math
from collections import defaultdict
from pathlib import Path

import osmium
from shapely import constrained_delaunay_triangles
from shapely.geometry import LineString, MultiPoint, Point, Polygon, box
from shapely.ops import linemerge, polygonize, substring, unary_union

from beihuan import MANIFEST as BEIHUAN_MANIFEST
from geo import project
from land import _polys
from roads import _num

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/road-frontage-pilot.json'


def _local_box(bounds):
    a = project(*bounds[:2])
    b = project(*bounds[2:])
    return box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))


def _way_line(way):
    return LineString([project(*p) for p in way['geom'].coords])


def _lines(geometry):
    if geometry.geom_type == 'LineString' and geometry.length > 0.01:
        yield geometry
    elif hasattr(geometry, 'geoms'):
        for child in geometry.geoms:
            yield from _lines(child)


def _buffer(line, width):
    return line.buffer(width / 2, cap_style='flat', join_style='bevel')


def _encode_surface(kind, source_ids, polygon, rise=0):
    outlines, faces = [], []
    for part in _polys(polygon):
        if part.area < 0.008:
            continue
        if rise:
            outlines.extend([[round(v, 3) for p in ring.coords for v in p] for ring in [part.exterior, *part.interiors]])
        for triangle in constrained_delaunay_triangles(part).geoms:
            xy = [round(v, 3) for p in list(triangle.exterior.coords)[:3] for v in p]
            if len(set(zip(xy[::2], xy[1::2]))) == 3:
                faces.extend(xy)
    return {'kind': kind, 'sourceIds': sorted(set(source_ids)), 'riseM': rise, 'trianglesXZ': faces, 'outlines': outlines}


def _read_tags(pbf, way_ids, node_ids):
    ways, nodes = {}, {}
    wanted_ways = {int(i.split('/')[1]) for i in way_ids}
    reader = (osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY)
              .with_filter(osmium.filter.IdFilter(list(wanted_ways | node_ids))))
    for obj in reader:
        if obj.is_way() and obj.id in wanted_ways:
            ways[f'way/{obj.id}'] = dict(obj.tags)
        elif obj.is_node() and obj.id in node_ids:
            nodes[obj.id] = (Point(project(obj.lon, obj.lat)), dict(obj.tags))
    return ways, nodes


def _ground(metadata):
    return metadata['heightSource'] == 'terrain' and not (metadata['bridge'] or metadata['tunnel'] or metadata['layer'])


def _graph_lines(graph, extent):
    for link, metadata in zip(graph['links'], graph['metadata'], strict=True):
        a, b, name, width, lanes, direction, inner = link
        points = [tuple(graph['nodes'][a * 2:a * 2 + 2]), *zip(inner[::2], inner[1::2]),
                  tuple(graph['nodes'][b * 2:b * 2 + 2])]
        line = LineString(points)
        if line.intersects(extent):
            yield {'line': line, 'name': graph['names'][name], 'width': width, 'lanes': lanes, 'direction': direction,
                   'from': graph['nodeIds'][a], 'to': graph['nodeIds'][b], 'meta': metadata}


def _unit_tangent(line, s):
    a = line.interpolate(max(0, s - 0.5))
    b = line.interpolate(min(line.length, s + 0.5))
    length = a.distance(b)
    return (b.x - a.x) / length, (b.y - a.y) / length


def _profile_layout(link):
    profile = link['meta'].get('crossSection')
    width = link['width']
    points = (list(zip(profile['points'][::3], profile['points'][1::3], profile['points'][2::3]))
              if profile else [(x, z, width / 2) for x, z in link['line'].coords])
    travel_width = link['lanes'] * profile['laneWidthM'] if profile else width
    travel, footprints = [], []
    for i, (x, z, left) in enumerate(points):
        a, b = points[max(0, i - 1)], points[min(i + 1, len(points) - 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        shift = (travel_width / 2 - left) / math.hypot(dx, dz)
        travel.append((x - dz * shift, z + dx * shift))

    def section(point, rx, rz):
        x, z, left = point
        right = width - left
        return [(x - rx * left, z - rz * left), (x + rx * right, z + rz * right)]

    # 与 sz-roads 的斜接和端点断面一致，避免把绿带铺到沥青里。
    previous = None
    for a, b in zip(points, points[1:]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        start = section(a, -dz / length, dx / length)
        end = section(b, -dz / length, dx / length)
        footprints.append(Polygon([start[0], end[0], end[1], start[1]]))
        if previous:
            prev_dx, prev_dz, prev_end = previous
            side = 0 if prev_dx * dz - prev_dz * dx > 0 else 1
            bevel = Polygon([a[:2], prev_end[side], start[side]])
            if bevel.area > 1e-8:
                footprints.append(bevel)
        else:
            from_section = start
        previous = dx, dz, end
    return {'asphalt': unary_union(footprints), 'travel': LineString(travel), 'travelWidth': travel_width,
            'fromSection': from_section, 'toSection': end}


def _asphalt_mask(links, extent, junction_masks=None):
    footprints, junctions = [], defaultdict(list)
    for link in links:
        if not _ground(link['meta']):
            continue
        profile = link['profile'] = _profile_layout(link)
        footprints.append(profile['asphalt'].intersection(extent))
        for end, section in [('from', 'fromSection'), ('to', 'toSection')]:
            junctions[link[end]].append((link, profile[section]))
    # 用与运行时一致的共享源节点断面凸包排除路口角区。
    for arms in junctions.values():
        if len(arms) >= 2:
            hull = MultiPoint([point for _, section in arms for point in section]).convex_hull
            if hull.area > 0:
                footprints.append(hull)
            if junction_masks is not None and len(arms) >= 3:
                overlaps = [a['profile']['asphalt'].intersection(b['profile']['asphalt'])
                            for i, (a, _) in enumerate(arms) for b, _ in arms[i + 1:]]
                junction_masks.append(unary_union([hull, *overlaps]).buffer(0.7))
    return unary_union(footprints)


def _compile_intersections(specs, nodes, osm_ways, links, asphalt, buildings):
    intersections, stop_paint = [], []
    occupied = asphalt.union(buildings).buffer(0.22)
    for spec in specs:
        approaches, marks = [], []
        for item in spec['approaches']:
            node_id, way_id = item['osmNodeId'], item['osmWayId']
            point, tags = nodes[node_id]
            if (tags.get('highway') != 'traffic_signals' or tags.get('traffic_signals:direction') != 'forward'
                    or node_id not in osm_ways[way_id]['nodeRefs']):
                raise ValueError(f'Signal {node_id} no longer belongs to the reviewed directed approach')
            eligible = [link for link in links if link['meta']['osmId'] == way_id and _ground(link['meta'])
                        and link['direction'] == 1 and link['line'].distance(point) < 0.03
                        and link['line'].project(point) > 0.05]
            if len(eligible) != 1:
                raise ValueError(f'Signal {node_id} does not match one ground approach')
            link, = eligible
            line = link['line']
            s = line.project(point)
            stop = line.interpolate(s)
            dx, dz = _unit_tangent(line, s)
            rx, rz = -dz, dx
            width = link['width']
            half = width / 2 - 0.16
            bar = LineString([(stop.x + rx * half, stop.y + rz * half), (stop.x - rx * half, stop.y - rz * half)])
            marks.append(bar)
            # 杆位是同源进向路缘上的布置估计，候选必须避开道路与实体建筑。
            pole = next((p for ahead in (7, 10, 4, 0, -3) for inset in (0.85, 1.45, 2.25)
                         if not occupied.covers(p := Point(stop.x + dx * ahead + rx * (width / 2 + inset),
                                                            stop.y + dz * ahead + rz * (width / 2 + inset)))), None)
            approaches.append({**item, 'fromNodeId': link['from'], 'toNodeId': link['to'],
                               'stopX': round(stop.x, 3), 'stopZ': round(stop.y, 3), 'dx': round(dx, 7), 'dz': round(dz, 7),
                               'widthM': width, 'widthSource': link['meta']['widthSource'],
                               'pole': [round(pole.x, 3), round(pole.y, 3)] if pole else None})
        conflict = unary_union(marks).convex_hull.buffer(4)
        intersections.append({'id': spec['id'], 'timingSource': 'user-defined-game-simulation',
                              'bounds': [round(v, 3) for v in conflict.bounds], 'approaches': approaches})
        stop_paint += marks
    return intersections, stop_paint


def _dash_parts(line, pitch=9.0, paint=3.7):
    for i in range(math.ceil(line.length / pitch)):
        start = i * pitch
        yield from _lines(substring(line, start, min(line.length, start + paint)))


def _lane_paint(links, clip, preserve, marking_width, include_unmeasured=False):
    paint, source_ids = [], []
    for link in links:
        if link['direction'] == 0 or (link['lanes'] < 1 and not include_unmeasured):
            continue
        profile = link.get('profile')
        line, travel_width = (profile['travel'], profile['travelWidth']) if profile else (link['line'], link['width'])
        half = travel_width / 2
        asphalt = profile['asphalt'] if profile else _buffer(line, travel_width)
        drivable = asphalt.intersection(clip).difference(preserve)
        if drivable.is_empty:
            continue
        source_ids.append(link['meta']['osmId'])
        for offset in (-half + 0.27, half - 0.27):
            paint.append(_buffer(line.offset_curve(offset, join_style='bevel'), marking_width).intersection(drivable))
        for i in range(1, link['lanes']):
            offset = -half + i * travel_width / link['lanes']
            for fragment in _lines(line.offset_curve(offset, join_style='bevel').intersection(clip)):
                paint += [_buffer(dash, marking_width).intersection(drivable) for dash in _dash_parts(fragment)]
    return unary_union(paint), source_ids


def _median(spec, clip, osm_ways, occupied, ground_links):
    if 'opposingChains' in spec:
        axes = [linemerge([link['line'] for link in ground_links if link['meta']['osmId'] in chain])
                for chain in spec['opposingChains']]
    else:
        axes = [_way_line(osm_ways[i]) for i in spec['opposingWayIds']]
    lines = [max(_lines(axis.intersection(clip)), key=lambda line: line.length) for axis in axes]
    chains = [list(line.coords) if line.coords[0][0] < line.coords[-1][0] else list(line.coords)[::-1] for line in lines]
    between = Polygon(chains[0] + chains[1][::-1])
    if not between.is_valid:
        raise ValueError('Reviewed median axes no longer bound a simple corridor')
    return between.difference(occupied.buffer(spec['edgeInsetEstimateM']))


def _reviewed_median_flower_band(island, review, ground_links, way_tags):
    anchor = Point(project(*review['flowerBand']['islandAnchorLonLat']))
    center, = [part for part in _polys(island) if part.covers(anchor)]
    for identity in review['openingWayIds']:
        tags = way_tags.get(identity, {})
        matches = [link for link in ground_links if link['meta']['osmId'] == identity]
        if (tags.get('highway') != 'primary_link' or tags.get('oneway') != 'yes'
                or not matches or any(link['direction'] != 1 or island.intersects(link['line']) for link in matches)
                or not any(center.distance(link['line']) <= link['width'] / 2 + 1 for link in matches)):
            raise ValueError(f'Reviewed median opening {identity} no longer bounds the lawn')
    # 影像显示中部草坪沿边有低花带。按车道断面围成的岛定位，影像只提供形态与估宽。
    band = review['flowerBand']
    outer = center.buffer(-band['edgeSetbackEstimateM'])
    inner = center.buffer(-band['edgeSetbackEstimateM'] - band['widthEstimateM'])
    return outer.difference(inner)


def _shrub_sites(island):
    interior = island.buffer(-1.2)
    if interior.is_empty:
        return []
    min_x, min_z, max_x, max_z = interior.bounds
    sites = []
    for x in range(math.ceil(min_x), math.floor(max_x), 4):
        cross = LineString([(x, min_z), (x, max_z)])
        for section in _lines(interior.intersection(cross)):
            if section.length <= 4:
                continue
            for t in (0.12, 0.88):
                p = section.interpolate(t, normalized=True)
                sites.append([round(p.x, 2), round(p.y, 2)])
    return sites


def _pedestrian_features(spec, osm_ways, way_tags, clip, asphalt, buildings, style):
    paving, crossings, zebra = [], [], []
    unresolved, crossing_axes = [], []
    for kind, ids in [('sidewalk', spec['sidewalks']), ('crossing', spec['crossings'])]:
        for identity in ids:
            tags = way_tags.get(identity, {})
            way = osm_ways.get(identity)
            if (not way or tags.get('footway') != kind or tags.get('highway') != 'footway'
                    or tags.get('foot') in ('no', 'private') or tags.get('access') in ('no', 'private')
                    or any(tags.get(key, value) != value for key, value in [('bridge', 'no'), ('tunnel', 'no'), ('layer', '0')])):
                unresolved.append(identity)
                continue
            width = _num(tags.get('width')) or style[f'{kind}WidthM']
            line = _way_line(way).intersection(clip)
            if kind == 'sidewalk':
                paving.append((identity, _buffer(line, width)))
            elif tags.get('crossing:markings') in ('zebra', 'yes'):
                crossings.append((identity, _buffer(line, width)))
                for fragment in _lines(line):
                    zebra += [_buffer(stripe, width).intersection(asphalt) for stripe in _dash_parts(fragment, 0.82, 0.45)]
                    if spec['id'] == 'shennan-chegongmiao':
                        crossing_axes.append({'osmId': identity, 'widthM': width,
                                              'points': [[round(x, 3), round(z, 3)] for x, z in fragment.coords]})
    cross_shape = unary_union([poly for _, poly in crossings])
    # 人行路仅来自源步道。过街连接只在源过街线穿出的路缘处降低到地面。
    paved = unary_union([poly for _, poly in paving]).difference(asphalt.buffer(0.09)).difference(buildings)
    flush = paved.intersection(cross_shape.buffer(1.5))
    raised = paved.difference(cross_shape.buffer(1.5))
    return paving, crossings, raised, flush, unary_union(zebra), cross_shape, unresolved, crossing_axes


def _hongshulin_walk_surfaces(paving, crossings, clip, buildings, style):
    # 过街源线经过的安全岛、中央带与接近段使用推定铺装；运行时由共享车行面精确挖除沥青。
    # 收圆端点只用来接合已核步道，不将其解释为现状铺装边缘或无障碍坡道。
    cross_shape = unary_union([poly.buffer(0.25) for _, poly in crossings])
    walk_shape = unary_union([poly for _, poly in paving]).union(cross_shape).intersection(clip).difference(buildings)
    flush_limit = cross_shape.buffer(1.25)
    raised_limit = cross_shape.buffer(3.25)
    rise = style['sidewalkRiseM']
    sidewalk_ids = [identity for identity, _ in paving]
    all_ids = sidewalk_ids + [identity for identity, _ in crossings]
    for kind, suffix, ids, shape, height in [
        ('sidewalk', 'sidewalk', sidewalk_ids, walk_shape.difference(raised_limit), rise),
        ('paving', 'ramp', all_ids, walk_shape.intersection(raised_limit.difference(flush_limit)), 0),
        ('paving', 'paving', all_ids, walk_shape.intersection(flush_limit), 0),
    ]:
        feature = _encode_surface(kind, ids, shape, height)
        if not feature['trianglesXZ']:
            continue
        if suffix == 'ramp':
            coords = feature['trianglesXZ']
            # 在边界顶点上用同一标高，确保坡面两端与对应台面相接。
            offsets = []
            for x, z in zip(coords[::2], coords[1::2]):
                point = Point(x, z)
                if flush_limit.boundary.distance(point) <= 0.001:
                    value = 0
                elif raised_limit.boundary.distance(point) <= 0.001:
                    value = rise
                else:
                    value = rise * min(1, max(0, (cross_shape.distance(point) - 1.25) / 2))
                offsets.append(round(value, 6))
            feature['vertexRisesM'] = offsets
        yield {'id': f'shennan-hongshulin:{suffix}', 'surfaceTreatment': 'crossing-approach-design-estimate',
               'clipToRoadComplement': True, **feature}


def _junction_design(spec, osm_ways, ground, asphalt, buildings, clip, control, style):
    design = spec['junctionDesign']
    source_ids = spec['sidewalks'] + spec['crossings']
    axes = {identity: _way_line(osm_ways[identity]).intersection(clip) for identity in source_ids}
    if not all(not axis.is_empty for axis in axes.values()):
        raise ValueError(f"Reviewed walking axis leaves its corridor: {spec['id']}")
    walk = unary_union([_buffer(axis, style['sidewalkWidthM']) for axis in axes.values()])
    # 共享源端点围合的空地才是候选岛。平面相交不会新建节点或围合种植区。
    plots = []
    slip = set(design['slipWays'])
    for island in polygonize([row['line'] for row in ground]):
        if not clip.covers(island):
            continue
        edges = {row['meta']['osmId'] for row in ground if island.boundary.intersection(row['line']).length > 1}
        if not edges & slip and not (len(edges) >= 3 and island.area < 450):
            continue
        free = island.difference(asphalt.buffer(0.8).union(buildings).union(walk.buffer(1.8)))
        for part in _polys(free.buffer(-0.75).buffer(0.75)):
            if part.area >= 8:
                plots.append((edges, part))

    legs, zebras = [], []
    coords = {point for identity, axis in axes.items() if identity in spec['crossings']
              for line in _lines(axis) for point in (line.coords[0], line.coords[-1])}
    for identity, axis in axes.items():
        for line in _lines(axis):
            spans = []
            if identity in spec['crossings']:
                crossing = line.intersection(asphalt)
                for span in _lines(linemerge(crossing) if crossing.geom_type == 'MultiLineString' else crossing):
                    if span.length < 2.5:
                        continue
                    midpoint = span.interpolate(0.5, normalized=True)
                    road = min(ground, key=lambda row: row['line'].distance(midpoint))
                    dx, dz = _unit_tangent(road['line'], road['line'].project(midpoint))
                    sx, sz = _unit_tangent(span, span.length / 2)
                    if abs(dx * sx + dz * sz) > 0.72:
                        continue
                    start, end = sorted(line.project(Point(p)) for p in (span.coords[0], span.coords[-1]))
                    group = None
                    if control and identity in design['signalizedCrossings']:
                        match = max(control['approaches'], key=lambda a: abs(dx * a['dx'] + dz * a['dz']))
                        group = 1 - match['group']
                    spans.append((max(0, start - 0.65), min(line.length, end + 0.65), group))
                    local_pavement = asphalt.intersection(_buffer(span, 4.6).buffer(0.4))
                    # 条纹长轴跟随车流，间距沿实际步行轴排列。
                    bars = max(2, math.floor(span.length / 0.82))
                    for i in range(bars):
                        point = span.interpolate((i + 0.5) / bars, normalized=True)
                        half = style['crossingWidthM'] / 2
                        stripe = LineString([(point.x - half * dx, point.y - half * dz),
                                             (point.x + half * dx, point.y + half * dz)])
                        zebras.append(_buffer(stripe, 0.45).intersection(local_pavement))
            cuts = {0., line.length, *(line.project(Point(p)) for p in coords if line.distance(Point(p)) < 0.001)}
            cuts.update(s for a, b, _ in spans for s in (a, b))
            cuts = sorted(cuts)
            for start, end in zip(cuts, cuts[1:]):
                part = substring(line, start, end)
                if part.length < 0.04:
                    continue
                span = next((row for row in spans if row[0] < (start + end) / 2 < row[1]), None)
                if span is None and part.intersection(asphalt).length > 0.02:
                    continue
                points = [[round(x, 3), round(z, 3)] for x, z in part.coords]
                legs.append({'osmId': identity, 'points': points, 'crossing': span is not None,
                             **({'signalGroup': span[2]} if span and span[2] is not None else {})})
    return legs, unary_union(zebras), plots


def compile_road_frontage(manifest, osm, graph, buildings, way_tags, nodes, report):
    clips = {spec['id']: _local_box(spec['bounds']) for spec in manifest['corridors']}
    extent = unary_union(list(clips.values())).buffer(25)
    links = list(_graph_lines(graph, extent))
    junction_masks = []
    asphalt = _asphalt_mask(links, extent, junction_masks)
    building_mask = unary_union([b['poly'] for b in buildings if b['minHeight'] < 0.3 and b['poly'].intersects(extent)])
    osm_ways = {way['id']: way for way in osm['roads']}
    style = manifest['styleEstimates']
    intersections, stop_bars = _compile_intersections(manifest['intersections'], nodes, osm_ways, links, asphalt, building_mask)
    features, corridors, entrances, unresolved, shrub_sites = [], [], [], [], []
    for spec in manifest['corridors']:
        clip = clips[spec['id']]
        local_links = [link for link in links if link['name'] in spec['roadNames'] and link['line'].intersects(clip)]
        ground_links = [link for link in local_links if _ground(link['meta'])]
        if profile_id := spec.get('profileOnly'):
            ground_links = [link for link in ground_links if link['meta'].get('crossSection', {}).get('id') == profile_id]
        paving, crossings, raised, flush, zebra, cross_shape, missing, crossing_axes = _pedestrian_features(
            spec, osm_ways, way_tags, clip, asphalt, building_mask, style)
        unresolved += missing
        pavement_ids = [identity for identity, _ in paving]
        crossings_ids = [identity for identity, _ in crossings]
        preserve = cross_shape.buffer(0.6)
        junction_design = spec.get('junctionDesign')
        plots = []
        if junction_design:
            ground_links = [link for link in links if _ground(link['meta']) and link['line'].intersects(clip)]
            control = next((row for row in intersections if row['id'] == spec['id']), None)
            walk_legs, zebra, plots = _junction_design(spec, osm_ways, ground_links, asphalt, building_mask, clip, control, style)
            if not set(spec['crossings']) <= {leg['osmId'] for leg in walk_legs if leg['crossing']}:
                raise ValueError(f"A reviewed crossing no longer spans ground pavement: {spec['id']}")
            preserve = unary_union([preserve, zebra.buffer(0.55), *(mask for mask in junction_masks if mask.intersects(clip)),
                                    *[bar.buffer(0.8) for bar in stop_bars if bar.intersects(clip)]])
        marks, road_ids = _lane_paint(ground_links, clip, preserve, style['markingWidthM'], bool(junction_design))
        corridor = {'id': spec['id'], 'bounds': list(clip.bounds), 'roadIds': sorted(set(road_ids)),
                    'unresolvedVerticalWays': sorted({link['meta']['osmId'] for link in local_links if not _ground(link['meta'])}),
                    'sidewalkIds': pavement_ids, 'crossingIds': crossings_ids}
        if crossing_axes:
            corridor['crossingAxes'] = crossing_axes
        if junction_design:
            corridor['walkLegs'] = walk_legs
            corridor['plantingSource'] = 'estimated-from-same-level-road-enclosures'
            for i, (edge_ids, plot) in enumerate(plots):
                for kind, area, rise in [('median', plot, 0.16), ('flower-band', plot.buffer(-0.33), 0)]:
                    feature = _encode_surface(kind, edge_ids, area, rise)
                    if feature['trianglesXZ']:
                        plant_sites = []
                        if not rise:
                            planting = area.buffer(-0.47)
                            x0, z0, x1, z1 = area.bounds
                            plant_sites = [[x, z] for x in range(math.ceil(x0), math.floor(x1) + 1)
                                           for z in range(math.ceil(z0), math.floor(z1) + 1)
                                           if (x + z) % 3 == 0 and planting.covers(Point(x, z))]
                        features.append({'id': f"{spec['id']}:island-{i}:{kind}", **feature,
                                         **({'solidPlanting': True} if rise else {'surfaceOffsetM': 0.164, 'plantSites': plant_sites})})
        polygons = [('sidewalk', pavement_ids, raised, style['sidewalkRiseM']), ('paving', pavement_ids, flush, 0),
                    ('paint', road_ids + crossings_ids, marks.union(zebra), 0)]
        if median := spec.get('median'):
            median_clip = _local_box(median['bounds']) if 'bounds' in median else clip
            # 只补草地的走廊也按源车道取边界，无需加入标线重绘范围。
            median_links = ground_links if spec['roadNames'] else [link for link in links if _ground(link['meta'])]
            island = _median(median, median_clip, osm_ways, asphalt.union(building_mask), median_links)
            # 去掉路缘处由窄缝形成的零碎孤岛。
            if median.get('planting') == 'open-lawn':
                island = unary_union([part for part in _polys(island) if part.area >= 40])
            median_ids = median.get('opposingWayIds') or [identity for chain in median['opposingChains'] for identity in chain]
            polygons.append(('median', median_ids, island, style['medianRiseM']))
            if median.get('planting') != 'open-lawn':
                shrub_sites.extend(_shrub_sites(island))
            corridor['medianSource'] = {'source': manifest['evidence'][median['evidence']],
                                        'positionSource': 'documented-median-between-osm-carriageways',
                                        'boundarySource': 'derived-estimate', 'areaM2': round(island.area, 2)}
            if 'planting' in median:
                corridor['medianSource']['planting'] = median['planting']
            if review := median.get('imageryReview'):
                band = _reviewed_median_flower_band(island, review, median_links, way_tags)
                # 花带和草坪共用标高，花带无独立路缘和接触面。
                flower = _encode_surface('flower-band', median_ids + review['openingWayIds'], band)
                features.append({'id': f"{spec['id']}:flower-band", 'surfaceOffsetM': style['medianRiseM'], **flower})
                corridor['medianSource'].update({'boundarySource': 'imagery-reviewed-road-edge-estimate',
                                                 'imageryReview': review, 'flowerBandAreaM2': round(band.area, 2)})
        if spec['id'] == 'shennan-hongshulin':
            features.extend(_hongshulin_walk_surfaces(paving, crossings, clip, building_mask, style))
            polygons = [row for row in polygons if row[0] not in ('sidewalk', 'paving')]
        for kind, ids, polygon, rise in polygons:
            feature = _encode_surface(kind, ids, polygon, rise)
            if feature['trianglesXZ']:
                features.append({'id': f"{spec['id']}:{kind}", **feature})
        for node_id in spec.get('entranceNodeIds', []):
            point, tags = nodes[node_id]
            entrances.append({'osmNodeId': node_id, 'ref': tags.get('ref'), 'x': round(point.x, 3), 'z': round(point.y, 3),
                              'status': 'source-entrance-ground-connection-unresolved',
                              'nearestPavingM': round(min(poly.distance(point) for _, poly in paving), 2)})
        corridors.append(corridor)
    stop_shape = unary_union([_buffer(bar, style['stopLineWidthM']) for bar in stop_bars]).intersection(asphalt)
    source_ids = [f"node/{item['osmNodeId']}" for junction in intersections for item in junction['approaches']]
    stop_feature = _encode_surface('paint', source_ids, stop_shape)
    if stop_feature['trianglesXZ']:
        features.append({'id': 'source-signal-stop-lines', **stop_feature})
    result = {'version': 1, 'source': {key: manifest[key] for key in ('checkedAt', 'osmSnapshotId', 'evidence')},
              'corridors': corridors, 'intersections': intersections, 'features': features, 'entrances': entrances,
              'shrubSites': shrub_sites}
    report['roadFrontage'] = {'corridors': corridors, 'unresolvedPedestrianWays': unresolved, 'entrances': entrances,
                              'features': len(features), 'planarTriangles': sum(len(f['trianglesXZ']) // 6 for f in features),
                              'medianShrubsEstimated': len(shrub_sites),
                              'signalApproaches': sum(len(j['approaches']) for j in intersections),
                              'signalTimingSource': 'user-defined-game-simulation'}
    return result


def build_road_frontage(pbf, osm, graph, buildings, report):
    manifest = json.loads(MANIFEST.read_text())
    if 'beihuanCrossSection' in report:
        beihuan = json.loads(BEIHUAN_MANIFEST.read_text())
        manifest['corridors'].append(beihuan['corridor'])
        manifest['evidence'].update(beihuan['evidence'])
    ways = {i for corridor in manifest['corridors'] for key in ('sidewalks', 'crossings') for i in corridor[key]}
    ways |= {i for corridor in manifest['corridors']
             for i in corridor.get('median', {}).get('imageryReview', {}).get('openingWayIds', [])}
    nodes = {item['osmNodeId'] for junction in manifest['intersections'] for item in junction['approaches']}
    nodes |= {i for corridor in manifest['corridors'] for i in corridor.get('entranceNodeIds', [])}
    tags, point_data = _read_tags(pbf, ways, nodes)
    return compile_road_frontage(manifest, osm, graph, buildings, tags, point_data, report)
