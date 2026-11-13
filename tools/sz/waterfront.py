"""在已核水域、岸路和桥源上编译三个样段；所有未测高程显式保留为估计。"""

import json
import math
from pathlib import Path

from shapely import STRtree, constrained_delaunay_triangles, make_valid, prepare
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring, unary_union

from commercial_paving import ground_carriageway_mask
from geo import project_coords
from land import _polys, _to_local
from roads import _num
from shenzhen_bay import PAVING, PUBLIC, _polygon, _snapshots, _surface_sampler, bay_paving, path_material, paving_masks
from terrain_surface import _triangle_height

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/waterfront-samples.json'
ROUTES = SOURCE.with_name('waterfront-routes.json')


def _line(row):
    return LineString(project_coords(row['geom'].coords))


def _points(line, step=2):
    coords = list(line.coords)
    for a, b in zip(coords, coords[1:]):
        count = max(1, math.ceil(math.dist(a, b) / step))
        for i in range(count):
            yield tuple(p + (q - p) * i / count for p, q in zip(a, b))
    yield coords[-1]


def _joined(rows):
    if any(a['nodes'][-1] != b['nodes'][0] for a, b in zip(rows, rows[1:])):
        raise ValueError('Waterfront path has no shared source node')
    return LineString([*rows[0]['line'].coords, *(p for r in rows[1:] for p in list(r['line'].coords)[1:])])


def _source_paths(specs, osm, pbf):
    wanted = {row[0] for row in specs}
    ways = {r['id']: r for r in osm['roads'] if r['id'] in wanted}
    snapshots = _snapshots(pbf, wanted, extra_tags=('segregated',))
    result = []
    for identity, start, end, *clip in specs:
        way, source = ways[identity], snapshots[identity]
        tags = source['tags']
        kind = tags.get('highway')
        bridge = tags.get('bridge', 'no') != 'no'
        if (kind not in ('footway', 'path', 'cycleway') or tags.get('access') not in PUBLIC
                or tags.get('tunnel', 'no') != 'no' or int(tags.get('layer', 0)) != int(bridge)
                or any(key.endswith(':conditional') for key in tags)):
            raise ValueError(f'Unreviewed waterfront access or level: {identity}')
        refs = way['nodeRefs']
        first, last = refs.index(start), refs.index(end)
        indices = range(first, last + (1 if first < last else -1), 1 if first < last else -1)
        coords = _line(way).coords
        line = LineString([coords[i] for i in indices])
        if clip:
            lo, hi = clip[0]
            line = substring(line, lo, hi if hi is not None else line.length)
        walk = tags.get('foot') in (('yes', 'designated', 'permissive') if kind == 'cycleway' else PUBLIC)
        cycle = tags.get('bicycle') in (PUBLIC if kind == 'cycleway' else ('yes', 'designated', 'permissive'))
        if not walk:
            raise ValueError(f'No pedestrian access for sample: {identity}')
        width = _num(tags.get('width')) or (3.1 if kind == 'cycleway' else 2.6)
        result.append({'osmId': identity, **source, 'nodes': [start, end], 'line': line, 'bridge': bridge,
                       'widthM': width, 'widthSource': 'osm' if _num(tags.get('width')) else 'estimate',
                       'mode': 'shared' if cycle else 'walk'})
    return result


def _water(payload, osm, identity):
    marker = _to_local(next(r['geom'] for r in osm['water'] if r['id'] == identity)).representative_point()
    return next((i, poly) for i, rings in enumerate(payload['water']) if (poly := _polygon(rings)).covers(marker))


def _clip_terrain(surface, masks, grades, *, replace_kinds=None):
    """在原三角面内切材质与高程影响范围；范围外保留原来的几何和采样。"""
    affected = unary_union([*masks.values(), *(shape for shape, _ in grades)])
    prepare(affected)
    for mask in masks.values():
        prepare(mask)
    size, grid = surface['chunkSize'], surface['grid']
    nx, x0, z0, step = (grid[k] for k in ('nx', 'x0', 'z0', 'step'))
    chunks, changed = [], []
    totals = {kind: 0.0 for kind in masks}
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        if not affected.intersects(box(ox, oz, ox + size, oz + size)):
            chunks.append(chunk)
            continue
        positions, kinds = chunk['positions'].copy(), chunk['kinds'].copy()
        indices, ranges = [], []
        vertices = {(*positions[3*i:3*i+3], k): i for i, k in enumerate(kinds)}
        for cell, start, count in zip(chunk['cellRanges'][::3], chunk['cellRanges'][1::3], chunk['cellRanges'][2::3]):
            begin = len(indices)
            gx, gz = x0 + cell % (nx - 1) * step, z0 + cell // (nx - 1) * step
            if not affected.intersects(box(gx, gz, gx + step, gz + step)):
                indices.extend(chunk['indices'][start:start+count])
            else:
                for i in range(start, start+count, 3):
                    face = chunk['indices'][i:i+3]
                    plane = [(ox + positions[3*v], positions[3*v+1], oz + positions[3*v+2]) for v in face]
                    tri = Polygon([(x, z) for x, _, z in plane])
                    if not affected.intersects(tri):
                        indices.extend(face)
                        continue
                    pieces, rest = [], tri
                    old_kind = max(kinds[v] for v in face)
                    if replace_kinds is None or old_kind in replace_kinds:
                        for kind, mask in masks.items():
                            if kind == old_kind or not mask.intersects(rest):
                                continue
                            piece = rest.intersection(mask)
                            if piece.area > 1e-10:
                                totals[kind] += piece.area
                                pieces.append((piece, kind))
                                rest = rest.difference(piece)
                    pieces.append((rest, old_kind))
                    if not grades and all(kind == old_kind for _, kind in pieces):
                        indices.extend(face)
                        continue

                    def emit(shape, kind, grade=None):
                        for poly in _polys(shape):
                            for t in constrained_delaunay_triangles(poly).geoms:
                                if t.area <= 1e-10:
                                    continue
                                a, b, c = list(t.exterior.coords)[:3]
                                for x, z in (a, c, b) if t.exterior.is_ccw else (a, b, c):
                                    y = _triangle_height(plane, x, z)
                                    if grade:
                                        y = grade(Point(x, z), y)
                                    key = (x - ox, y, z - oz, kind)
                                    if key not in vertices:
                                        vertices[key] = len(kinds)
                                        kinds.append(kind)
                                        positions.extend(key[:3])
                                    indices.append(vertices[key])

                    for piece, kind in pieces:
                        for region, grade in grades:
                            if not piece.intersects(region):
                                continue
                            patch = piece.intersection(region)
                            if patch.area <= 1e-10:
                                continue
                            piece = piece.difference(patch)
                            # 同一世界网格切分，跨原地形面和分块的高程一致。
                            min_x, min_z, max_x, max_z = patch.bounds
                            delta = 2.5
                            for ix in range(math.floor(min_x/delta), math.ceil(max_x/delta)):
                                for iz in range(math.floor(min_z/delta), math.ceil(max_z/delta)):
                                    emit(patch.intersection(box(ix*delta, iz*delta, (ix+1)*delta, (iz+1)*delta)), kind, grade)
                        emit(piece, kind)
            ranges.extend((cell, begin, len(indices) - begin))
        if indices != chunk['indices']:
            chunk = {**chunk, 'positions': positions, 'kinds': kinds, 'indices': indices, 'cellRanges': ranges}
            changed.append(chunk['id'])
        chunks.append(chunk)
    return {**surface, 'chunks': chunks}, changed, totals


def restore_bay_paving(payload, report):
    """在既有双包上局部改材质，保留已完成的岸道标高、桥面与其余地面。"""
    paths = payload['shenzhenBay']['paths']
    masks, _, _ = bay_paving(paths, payload['roadGraph'])
    surface, changed, totals = _clip_terrain(payload['terrainSurface'], masks, [], replace_kinds={4, 5, 6, 7, 8, 9})
    payload['terrainSurface'] = surface
    for path in paths:
        path['material'] = path_material(path['tags'])
    bay_report = report['shenzhenBayWaterfront']
    bay_report['paths'] = [{key: value for key, value in path.items() if key != 'points'} for path in paths]
    bay_report['pavingM2'] = {name: round(totals[kind], 2) for name, kind in PAVING.items()}
    bay_report['materialRepairTerrainChunks'] = changed
    report['terrainSurface'].update(vertices=sum(len(c['kinds']) for c in surface['chunks']),
                                    triangles=sum(len(c['indices']) // 3 for c in surface['chunks']))


def _height_rows(line, sample, *, step=2):
    rows = []
    for x, z in _points(line, step):
        y = sample(x, z)
        if y is None:
            raise ValueError(f'Waterfront route has no support at {x:.2f}, {z:.2f}')
        rows.append([round(x, 4), round(y, 4), round(z, 4)])
    return rows


def compile_waterfront_routes(payload, osm, pbf, report):
    """按已审核源节点增量裁切地面路线；桥、台阶和岸坡仍由各自的结构方案接入。"""
    plan = json.loads(ROUTES.read_text())
    if plan['version'] != 1 or plan['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Waterfront routes require the reviewed OSM snapshot')
    waterfront = payload['waterfront']
    if 'extensions' in waterfront:
        raise ValueError('Rebuild the underlying terrain before replacing waterfront routes')
    specs = plan['routes']
    identities = {path[0] for spec in specs for path in spec['paths']}
    ways = {row['id']: row for row in osm['roads'] if row['id'] in identities}
    snapshots = _snapshots(pbf, identities)
    water = [_polygon(rings) for rings in [*payload['water'], *payload['wetland'], *payload['seaSurface']['polygons']]]
    wet = STRtree([poly if poly.is_valid else make_valid(poly) for poly in water])
    surface = payload['terrainSurface']
    routes, waters = [], {}
    changed_chunks = set()
    for spec in specs:
        rows = []
        for identity, start, end, mode, fallback in spec['paths']:
            way, source = ways[identity], snapshots[identity]
            tags = source['tags']
            highway = tags.get('highway')
            pedestrian = tags.get('foot') in (PUBLIC if highway != 'cycleway' else PUBLIC[1:])
            bicycle = tags.get('bicycle') in (PUBLIC if highway == 'cycleway' else PUBLIC[1:])
            if (highway not in ('path', 'footway', 'cycleway') or tags.get('access') not in PUBLIC
                    or any(tags.get(k, 'no') != 'no' for k in ('bridge', 'tunnel'))
                    or any(tags.get(k, '0') != '0' for k in ('layer', 'level'))
                    or 'opening_hours' in tags or any(k.endswith(':conditional') for k in tags)
                    or (mode in ('walk', 'shared') and not pedestrian)
                    or (mode in ('cycle', 'shared') and not bicycle)
                    or mode not in ('walk', 'cycle', 'shared')):
                raise ValueError(f'Unreviewed waterfront route access or level: {identity}')
            refs = way['nodeRefs']
            a, b = refs.index(start), refs.index(end)
            step = 1 if a < b else -1
            coords = _line(way).coords
            line = LineString([tuple(round(value, 4) for value in coords[i]) for i in range(a, b + step, step)])
            width = _num(tags.get('width'))
            if (width or fallback) <= 0:
                raise ValueError(f'Invalid waterfront path width: {identity}')
            rows.append({'osmId': identity, **source, 'nodes': [start, end], 'line': line, 'mode': mode,
                         'widthM': width or fallback, 'widthSource': 'osm' if width else 'estimate',
                         'material': path_material(tags), 'heightSource': 'terrain-derived-estimate'})

        line = _joined(rows)
        strips = unary_union([row['line'].buffer(row['widthM'] / 2, quad_segs=8) for row in rows])
        if len(wet.query(strips, predicate='intersects')):
            raise ValueError(f'Waterfront route enters water or wetland: {spec["id"]}')
        masks, _, _ = paving_masks([(row['line'], row['widthM'], row['tags']) for row in rows], payload['roadGraph'])
        surface, changed, _ = _clip_terrain(surface, masks, [], replace_kinds={0, 1, 2, 3, 8, 9, 10, 11})
        changed_chunks.update(changed)
        sample = _surface_sampler(surface, strips)
        water_height = spec.get('waterHeightM')
        if water_height is not None:
            water_index, _ = _water(payload, osm, spec['waterId'])
            if (water_index in waters and waters[water_index]['heightM'] != water_height
                    or any(row['waterIndex'] == water_index for row in waterfront['waters'])):
                raise ValueError(f'Conflicting waterfront water height: {spec["waterId"]}')
            waters[water_index] = {'id': spec['waterId'], 'waterIndex': water_index,
                                   'heightM': water_height, 'heightSource': 'estimate'}
        for row in rows:
            points = list(_points(row['line']))
            for (x, z), (nx, nz) in zip(points, points[1:]):
                length = math.hypot(nx - x, nz - z)
                if length < 1e-7:
                    continue
                offset = row['widthM'] * 0.42 / length
                for side in (-offset, 0, offset):
                    h1 = sample(x + side * (nz - z), z - side * (nx - x))
                    h2 = sample(nx + side * (nz - z), nz - side * (nx - x))
                    if (None in (h1, h2) or abs(h2 - h1) > 0.15 * length + 0.005
                            or water_height is not None and min(h1, h2) < water_height + 0.4):
                        raise ValueError(f'Unsupported waterfront width or grade: {row["osmId"]} at {x:.2f}, {z:.2f}')
        routes.append({**{k: v for k, v in spec.items() if k != 'paths'},
                       'points': _height_rows(line, sample), 'closed': line.is_ring,
                       'lengthM': round(line.length, 2),
                       'paths': [{**{k: v for k, v in row.items() if k != 'line'},
                                  'points': [list(p) for p in row['line'].coords]} for row in rows]})
    payload['terrainSurface'] = surface
    waterfront['extensions'] = routes
    waterfront['extensionWaters'] = list(waters.values())
    report['waterfrontRoutes'] = {'checkedAt': plan['checkedAt'], 'osmSnapshotSha256': plan['osmSnapshotSha256'],
                                  'routes': [{k: v for k, v in row.items() if k != 'points'} for row in routes],
                                  'waters': waterfront['extensionWaters'],
                                  'changedTerrainChunks': sorted(changed_chunks)}
    report['terrainSurface'].update(vertices=sum(len(c['kinds']) for c in surface['chunks']),
                                    triangles=sum(len(c['indices']) // 3 for c in surface['chunks']))


def _profile(line, water, sample, depth=0.45):
    """短跨水桥沿原路线，陆侧桥头按已有接触地坪。"""
    start, end = (sample(*p) for p in (line.coords[0], line.coords[-1]))
    if None in (start, end) or min(start, end) <= water + depth:
        raise ValueError(f'Unresolved waterfront footbridge portal at {line.coords[0]}, {line.coords[-1]}')
    return lambda x, z: start + (end - start) * line.project(Point(x, z)) / line.length


def _audit_crossings(osm, river, built_ids):
    rows = []
    area = box(*river.bounds)
    for road in osm['roads']:
        line = _line(road)
        if not area.intersects(line):
            continue
        wet = river.intersection(line).length
        if wet < 2:
            continue
        tags = road['tags']
        if tags.get('tunnel', 'no') != 'no':
            status = 'tunnel'
        elif tags.get('bridge', 'no') == 'no':
            status = 'unresolved-intersection'
        else:
            status = 'sample-bridge' if road['id'] in built_ids else 'tagged-bridge-candidate'
        rows.append({'osmId': road['id'], 'tags': tags, 'waterIntersectionM': round(wet, 2), 'status': status})
    return rows


def compile_waterfront(payload, osm, pbf, report):
    if 'waterfront' in payload:
        raise ValueError('Use the unmodified ground payload to rebuild waterfront samples')
    plan = json.loads(SOURCE.read_text())
    if plan['version'] != 1 or plan['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Waterfront requires the reviewed OSM snapshot')
    lake, river, coast = (plan[k] for k in ('lake', 'river', 'bay'))
    lake_index, lake_water = _water(payload, osm, lake['waterOsmId'])
    river_index, river_water = _water(payload, osm, river['waterOsmId'])
    def paths(spec):
        return _source_paths(spec, osm, pbf)

    ring = paths(lake['ring'])
    ring_line = _joined(ring)
    if not ring_line.is_ring or Polygon(ring_line).intersection(lake_water).area < lake_water.area * 0.97:
        raise ValueError('Lychee Lake route does not encircle the reviewed water polygon')
    branches = {name: paths(rows) for name, rows in lake['connections'].items()}
    if any(Point(_joined(rows).coords[-1]).distance(ring_line) > 0.001 for rows in branches.values()):
        raise ValueError('Lychee Lake entrance misses the loop')
    lake_rows = [*ring, *(row for rows in branches.values() for row in rows)]
    park = _to_local(next(row['geom'] for row in osm['green'] if row['id'] == lake['parkOsmId']))
    if any(not park.buffer(18).covers(row['line']) for row in lake_rows):
        raise ValueError('Lychee Lake walk leaves the reviewed park')
    if any(row['line'].intersection(lake_water).length > 0.45 for row in lake_rows if not row['bridge']):
        raise ValueError('Lychee Lake walk crosses water without a reviewed bridge')

    banks = {name: paths(rows) for name, rows in river['routes'].items()}
    bank_lines = {name: _joined(rows) for name, rows in banks.items()}
    if any(not 300 <= line.length <= 500 or line.intersects(river_water) for line in bank_lines.values()):
        raise ValueError('Invalid Dasha River bank sample')
    slow_bridges = paths(river['slowBridges'])
    graph = payload['roadGraph']
    road_bridges = []
    for identity in river['roadBridges']:
        edges = [i for i, meta in enumerate(graph['metadata']) if meta['osmId'] == identity]
        way = next(r for r in osm['roads'] if r['id'] == identity)
        if not edges or any(not graph['metadata'][i]['bridge'] or graph['metadata'][i]['tunnel'] for i in edges):
            raise ValueError(f'Unresolved Dasha River road bridge: {identity}')
        line = _line(way)
        if line.intersection(river_water).length < 35 or any(river_water.covers(Point(p)) for p in (line.coords[0], line.coords[-1])):
            raise ValueError(f'Dasha River road bridge lacks two banks: {identity}')
        road_bridges.append({'osmId': identity, 'lengthM': round(line.length, 2), 'heightM': river['deckHeightM'],
                             'girderDepthM': river['girderDepthM'], 'waterIndex': river_index,
                             'waterHeightM': river['waterHeightM'], 'edges': edges})

    ground = payload['terrainSurface']
    bay = payload['shenzhenBay']
    bay_path = next(row for row in bay['paths'] if row['osmId'] == coast['walkOsmId'])
    coast_line = LineString(bay_path['points'])
    coast_cut = substring(coast_line, coast['lowerFromM'], coast['lowerToM'])
    bay_influence = coast_cut.buffer(bay_path['widthM'] / 2 + coast['blendM'], quad_segs=6)
    bank_width = {name: max(row['widthM'] for row in rows) for name, rows in banks.items()}
    bank_influence = {name: line.buffer(bank_width[name]/2 + river['blendM'], quad_segs=6)
                      for name, line in bank_lines.items()}
    def fade(d, span, ramp):
        return max(0, min(1, d / ramp, (span - d) / ramp))

    def bay_grade(p, y):
        along = coast_line.project(p) - coast['lowerFromM']
        cross = max(0, p.distance(coast_cut) - bay_path['widthM']/2)
        return y - coast['dropM'] * fade(along, coast_cut.length, coast['rampM']) * max(0, 1-cross/coast['blendM'])

    portals = [Point(graph['nodes'][node*2:node*2+2])
               for bridge in road_bridges for edge in bridge['edges'] for node in graph['links'][edge][:2]]

    def bank_grade(name, line):
        def grade(p, y):
            cross = max(0, p.distance(line) - bank_width[name]/2)
            weight = fade(line.project(p), line.length, river['rampM']) * max(0, 1-cross/river['blendM'])
            portal_weight = min(1, max(0, (min(p.distance(q) for q in portals) - 1.5) / 3))
            return y - max(0, y-river['bankHeightM'])*weight*portal_weight
        return grade

    ground_rows = [*(row for row in lake_rows if not row['bridge']), *(row for rows in banks.values() for row in rows)]
    masks, paths_area, _ = paving_masks([(row['line'], row['widthM'], row['tags']) for row in ground_rows],
                                        graph, exclude=lake_water.union(river_water))
    # 深圳湾铺装已在前一步完成，这里只改变下沉岸道高程。
    grades = [(bay_influence, bay_grade), *((bank_influence[k], bank_grade(k, v)) for k, v in bank_lines.items())]
    surface, changed, paving = _clip_terrain(ground, masks, grades)
    lookup_area = unary_union([paths_area, bay_influence, *bank_influence.values(),
                              *(r['line'].buffer(2) for r in [*lake_rows, *slow_bridges])]).buffer(25)
    sample = _surface_sampler(surface, lookup_area)
    original = _surface_sampler(ground, lookup_area)
    for bridge in road_bridges:
        portals = []
        for edge in bridge['edges']:
            nodes = graph['links'][edge][:2]
            values = [sample(*graph['nodes'][i*2:i*2+2]) for i in nodes]
            if any(y is None for y in values):
                raise ValueError(f'Unsupported road bridge portal: {bridge["osmId"]}')
            portals.append({'edge': edge, 'heightsM': [round(y, 4) for y in values]})
        bridge['portals'] = portals
    routes, footbridges = [], []
    def record(name, rows, water_y, *, closed=False, bridge_height=None):
        stations = []
        for i, row in enumerate(rows):
            line = row['line']
            if row['bridge']:
                sampler = _profile(line, water_y, bridge_height or sample)
                if bridge_height:
                    sampler = bridge_height
                xyz = _height_rows(line, sampler)
                footbridges.append({'id': row['osmId'], 'widthM': row['widthM'], 'points': xyz, 'mode': row['mode'],
                                    'girderDepthM': 0.45, 'waterIndex': river_index if bridge_height else lake_index,
                                    'waterHeightM': water_y})
            else:
                xyz = _height_rows(line, sample)
            stations.extend(xyz if i == 0 else xyz[1:])
        routes.append({'id': name, 'closed': closed, 'mode': 'shared' if all(row['mode'] == 'shared' for row in rows) else 'walk',
                       'paths': [{**{k: v for k, v in r.items() if k != 'line'}, 'points': [list(p) for p in r['line'].coords]}
                                 for r in rows],
                       'points': stations, 'lengthM': round(_joined(rows).length, 2)})

    record('lychee-loop', ring, lake['waterHeightM'], closed=True)
    for name, rows in branches.items():
        record(f'lychee-{name}', rows, lake['waterHeightM'])
    for name, rows in banks.items():
        record(name, rows, river['waterHeightM'])
    for row in slow_bridges:
        record(f'baishi-{row["osmId"].split("/")[1]}', [row], river['waterHeightM'],
               bridge_height=lambda _x, _z: river['deckHeightM'])

    minimum_clearance = math.inf
    for identity in [*river['roadBridges'], *(r['osmId'] for r in slow_bridges)]:
        line = _line(next(r for r in osm['roads'] if r['id'] == identity))
        width = next((graph['links'][b['edges'][0]][3] for b in road_bridges if b['osmId'] == identity), 2.6)
        for name, bank in bank_lines.items():
            deck = line.buffer(width/2 + 0.5)
            for x, z in _points(bank, step=0.5):
                if deck.covers(Point(x, z)):
                    y = sample(x, z)
                    minimum_clearance = min(minimum_clearance, river['deckHeightM'] - river['girderDepthM'] - y)
    if not math.isfinite(minimum_clearance) or minimum_clearance < river['minClearanceM']:
        raise ValueError(f'Insufficient Dasha River bridge underpass clearance: {minimum_clearance:.2f} m')

    # 只在下沉区临水一侧和陡峭样段设栏杆，不闭合水域。
    rails = []
    def add_rail(id, line, wet, max_gap, *, offset, doors=()):
        stations = []
        for x, z in _points(line, step=2.5):
            p = Point(x, z)
            s = line.project(p)
            a, b = line.interpolate(max(0, s - 0.1)), line.interpolate(min(line.length, s + 0.1))
            dx, dz = b.x - a.x, b.y - a.y
            norm = math.hypot(dx, dz)
            if norm < 1e-7 or any(p.distance(door) < 3 for door in doors):
                stations.append(None)
                continue
            candidates = [Point(x + sign*dz/norm*offset, z - sign*dx/norm*offset) for sign in (-1, 1)]
            q = min(candidates, key=wet.distance)
            y = sample(q.x, q.y)
            if y is None or q.distance(wet) > max_gap or wet.covers(q):
                stations.append(None)
                continue
            stations.append([round(q.x, 4), round(y, 4), round(q.y, 4)])
        rails.append({'id': id, 'stations': stations})

    sea = unary_union([p for rings in payload['seaSurface']['polygons']
                       if (p := _polygon(rings)).intersects(bay_influence.buffer(100))])
    add_rail('bay-lower-rail', substring(coast_cut, coast['rampM'], coast_cut.length-coast['rampM']),
             sea, 28, offset=bay_path['widthM']/2+0.28)
    for name, line in bank_lines.items():
        add_rail(name, line, river_water, 5.5, offset=bank_width[name]/2 + 0.18,
                 doors=[Point(p) for row in slow_bridges for p in (row['line'].coords[0], row['line'].coords[-1])])

    coast_center = _height_rows(coast_cut, sample)
    bay['walkRoute'] = [[x, round(sample(x, z), 4), z] for x, _, z in bay['walkRoute']]
    drop = max(original(x, z) - y for x, y, z in coast_center)
    if not 1.4 < drop < 1.51 or min(p[1] for p in coast_center) < bay['seaHeightM'] + 0.75:
        raise ValueError('Coastal terrace is too low or lacks the reviewed local drop')
    payload['terrainSurface'] = surface
    payload['waterfront'] = {'version': 1, 'waters': [
        {'id': lake['waterOsmId'], 'waterIndex': lake_index, 'heightM': lake['waterHeightM'], 'heightSource': 'estimate'},
        {'id': river['waterOsmId'], 'waterIndex': river_index, 'heightM': river['waterHeightM'], 'heightSource': 'estimate'}],
        'routes': routes, 'roadBridges': road_bridges, 'footbridges': footbridges, 'rails': rails,
        'bayLower': {'points': coast_center, 'widthM': bay_path['widthM'], 'lengthM': round(coast_cut.length, 2), 'maxDropM': round(drop, 3)},
        'riverAccess': {key: river[key] for key in ('openingHours', 'cyclingRestriction')}}
    report['waterfrontSamples'] = {'status': 'pilot-generated', 'checkedAt': plan['checkedAt'], 'source': str(SOURCE.name),
        'verticalDatum': 'project-visual-reference; no tide or surveyed elevation',
        'waterLevels': payload['waterfront']['waters'], 'coast': {**coast, 'lengthM': round(coast_cut.length, 2)},
        'routes': [{k: row[k] for k in ('id', 'lengthM', 'closed', 'mode')} for row in routes],
        'roadBridges': road_bridges, 'slowBridges': [row['id'] for row in footbridges],
        'minimumSampledUnderpassClearanceM': round(minimum_clearance, 3), 'changedTerrainChunks': changed,
        'pavingM2': paving, 'crossingAudit': _audit_crossings(osm, river_water,
            {*river['roadBridges'], *(row['osmId'] for row in slow_bridges)})}
