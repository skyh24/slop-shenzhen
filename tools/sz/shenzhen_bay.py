"""中湾阅海样段。用锁定 OSM 节点、海岸及地表三角面派生局部慢行铺装和护岸。"""

import json
import math
from pathlib import Path

import osmium
from shapely import constrained_delaunay_triangles, prepare
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, substring, unary_union

from commercial_paving import ground_carriageway_mask
from geo import project
from land import _polys
from package_validation import ring_points
from roads import _num
from terrain_surface import _triangle_height

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/shenzhen-bay-waterfront.json'
ACCESS_TAGS = ('highway', 'width', 'surface', 'access', 'foot', 'bicycle', 'lit', 'bridge', 'tunnel',
               'layer', 'level', 'opening_hours', 'access:conditional', 'foot:conditional',
               'bicycle:conditional')
PUBLIC = (None, 'yes', 'designated', 'permissive')
PAVING = {'walk': 4, 'cycle': 5, 'crossing': 6, 'cycle-stone': 7}


def _polygon(rings):
    outer, *holes = map(ring_points, rings)
    return Polygon(outer, holes)


def _lines(shape):
    if shape.geom_type == 'LineString' and shape.length > 0:
        yield shape
    for child in getattr(shape, 'geoms', ()):
        yield from _lines(child)


def _snapshots(pbf, path_ids):
    reader = osmium.FileProcessor(str(pbf), osmium.osm.WAY).with_filter(
        osmium.filter.IdFilter({int(identity.split('/')[1]) for identity in path_ids}))
    return {f'way/{way.id}': {'version': way.version, 'tags': {key: way.tags[key] for key in ACCESS_TAGS
                                                            if key in way.tags}} for way in reader}


def _paths(manifest, osm, pbf):
    ids = {path['id'] for path in manifest['paths']}
    ways = {way['id']: way for way in osm['roads'] if way['id'] in ids}
    snapshots = _snapshots(pbf, ids)
    paths = []
    for spec in manifest['paths']:
        identity = spec['id']
        way, source = ways[identity], snapshots[identity]
        tags = source['tags']
        mode = spec['mode']
        mode_key = 'foot' if mode == 'walk' else 'bicycle'
        allowed = ('footway', 'path') if mode == 'walk' else ('cycleway',)
        if (tags.get('highway') not in allowed or tags.get('access') not in PUBLIC
                or tags.get(mode_key) not in PUBLIC
                or any(f'{key}:conditional' in tags for key in (mode_key, 'access'))
                or tags.get('bridge', 'no') != 'no' or tags.get('tunnel', 'no') != 'no'
                or tags.get('layer', '0') != '0' or tags.get('level', '0') != '0'):
            raise ValueError(f'Unexpected waterfront access or structure: {identity}')
        refs = way['nodeRefs']
        start, end = refs.index(spec['from']), refs.index(spec['to'])
        sequence = range(start, end + 1) if start < end else range(start, end - 1, -1)
        points = [tuple(round(value, 4) for value in project(*way['geom'].coords[i])) for i in sequence]
        nodes = [refs[i] for i in sequence]
        width = _num(tags.get('width'))
        material = ('walk' if mode == 'walk' else 'cycle-stone' if tags.get('surface') == 'paving_stones' else 'cycle')
        paths.append({**source, 'osmId': identity, 'mode': mode, 'material': material, 'nodes': nodes, 'points': points,
                      'widthM': width or spec['widthM'], 'widthSource': 'osm-width' if width else 'visual-estimate'})
    return paths


def _terrain_boundary(surface, extent):
    faces = []
    size = surface['chunkSize']
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        if not extent.intersects(box(ox, oz, ox + size, oz + size)):
            continue
        positions, indices = chunk['positions'], chunk['indices']
        for i in range(0, len(indices), 3):
            triangle = Polygon([(ox + positions[3 * v], oz + positions[3 * v + 2]) for v in indices[i:i + 3]])
            if extent.intersects(triangle):
                faces.append(triangle)
    return unary_union(faces).boundary


def _coast_profiles(manifest, osm, surface):
    ways = {way['id']: way for way in osm['coastline']}
    raw_profiles = []
    for spec in manifest['shore']:
        coords = ways[spec['id']]['geom'].coords
        raw_profiles.append(LineString([project(*p) for p in coords[spec['fromIndex']:spec['toIndex'] + 1]]))
    raw = linemerge(raw_profiles)
    if raw.geom_type != 'LineString':
        raise ValueError('Waterfront source shoreline must be connected')
    # 沿实际渲染地面贴边；岸界包的分米量化可比原地表裁切线偏移数厘米。
    boundary = _terrain_boundary(surface, box(*raw.bounds).buffer(25))
    pieces = list(_lines(boundary.intersection(raw.buffer(1.7, cap_style='flat'))))
    if not pieces:
        raise ValueError('Waterfront shore missing from terrain')
    edge = max(_lines(linemerge(pieces)), key=lambda part: part.length)
    if abs(edge.length - raw.length) > 6:
        raise ValueError('Waterfront shore does not match the packaged terrain')
    if raw_profiles[0].distance(Point(edge.coords[0])) > raw_profiles[0].distance(Point(edge.coords[-1])):
        edge = edge.reverse()
    cuts = [0, *(edge.project(Point(line.coords[-1])) for line in raw_profiles[:-1]), edge.length]
    return [(spec, substring(edge, a, b)) for spec, a, b in zip(manifest['shore'], cuts[:-1], cuts[1:], strict=True)]


def _cut_paving(chunk, grade, masks, area, grid):
    ox, oz = chunk['origin']
    original, base_kinds = chunk['positions'], chunk['kinds']
    positions = original.copy()
    kinds = base_kinds.copy()
    for i in range(0, len(positions), 3):
        x, y, z = positions[i:i + 3]
        positions[i + 1] = grade(ox + x, y, oz + z)
    vertices = {(*positions[3 * i:3 * i + 3], kind): i for i, kind in enumerate(kinds)}
    indices, ranges = [], []
    totals = {key: 0.0 for key in masks}
    nx, x0, z0, step = (grid[key] for key in ('nx', 'x0', 'z0', 'step'))

    def emit(piece, plane, kind):
        for shape in _polys(piece):
            for tri in constrained_delaunay_triangles(shape).geoms:
                if tri.area <= 1e-10:
                    continue
                a, b, c = list(tri.exterior.coords)[:3]
                for x, z in (a, c, b) if tri.exterior.is_ccw else (a, b, c):
                    y = _triangle_height(plane, x, z)
                    key = (x - ox, y, z - oz, kind)
                    if key not in vertices:
                        vertices[key] = len(kinds)
                        positions.extend(key[:3])
                        kinds.append(kind)
                    indices.append(vertices[key])

    original_indices = chunk['indices']
    for i in range(0, len(chunk['cellRanges']), 3):
        cell, start, count = chunk['cellRanges'][i:i + 3]
        first = len(indices)
        x, z = x0 + cell % (nx - 1) * step, z0 + cell // (nx - 1) * step
        if not area.intersects(box(x, z, x + step, z + step)):
            indices.extend(original_indices[start:start + count])
        else:
            for offset in range(start, start + count, 3):
                face = original_indices[offset:offset + 3]
                plane = [(ox + positions[3 * v], positions[3 * v + 1], oz + positions[3 * v + 2]) for v in face]
                triangle = Polygon([(x, z) for x, _, z in plane])
                remaining = triangle
                for key, mask in masks.items():
                    if not mask.intersects(remaining):
                        continue
                    overlap = mask.intersection(remaining)
                    if overlap.area <= 1e-10:
                        continue
                    totals[key] += overlap.area
                    emit(overlap, plane, PAVING[key])
                    remaining = remaining.difference(overlap)
                if remaining is triangle:
                    indices.extend(face)
                elif not remaining.is_empty:
                    # 新顶点沿原面的地类归属；面外既有绿化和铺装保持原样。
                    emit(remaining, plane, max(base_kinds[v] for v in face))
        ranges.extend([cell, first, len(indices) - first])
    return {**chunk, 'positions': positions, 'indices': indices, 'kinds': kinds, 'cellRanges': ranges}, totals


def _surface_sampler(surface, extent):
    grid = surface['grid']
    size = surface['chunkSize']
    chunks = {chunk['id']: (chunk, {cell: (start, count) for cell, start, count in zip(
        chunk['cellRanges'][::3], chunk['cellRanges'][1::3], chunk['cellRanges'][2::3])})
        for chunk in surface['chunks'] if extent.intersects(box(
            chunk['origin'][0], chunk['origin'][1], chunk['origin'][0] + size, chunk['origin'][1] + size))}
    x0, z0, step, nx = (grid[key] for key in ('x0', 'z0', 'step', 'nx'))

    def sample(x, z):
        i, j = math.floor((x - x0) / step), math.floor((z - z0) / step)
        for row in (j, j - 1, j + 1):
            for col in (i, i - 1, i + 1):
                chunk_id = f'{math.floor((x0 + (col + .5) * step) / size)},{math.floor((z0 + (row + .5) * step) / size)}'
                if chunk_id not in chunks:
                    continue
                chunk, cells = chunks[chunk_id]
                start, count = cells.get(row * (nx - 1) + col, (0, 0))
                ox, oz = chunk['origin']
                positions, indices = chunk['positions'], chunk['indices']
                for index in range(start, start + count, 3):
                    plane = [(ox + positions[3 * v], positions[3 * v + 1], oz + positions[3 * v + 2])
                             for v in indices[index:index + 3]]
                    tri = Polygon([(px, pz) for px, _, pz in plane])
                    if tri.distance(Point(x, z)) < 1e-6 and tri.area > 1e-10:
                        return _triangle_height(plane, x, z)
        return None
    return sample


def _shore_stations(line, sample, grid):
    x0, z0, step = (grid[key] for key in ('x0', 'z0', 'step'))
    points = []
    for a, b in zip(line.coords, list(line.coords)[1:]):
        ax, az = a
        bx, bz = b
        count = max(1, math.ceil(math.dist(a, b) / 4))
        cuts = {i / count for i in range(count)}
        for start, end, origin in ((ax, bx, x0), (az, bz, z0), (ax + az, bx + bz, x0 + z0)):
            for index in range(math.floor((min(start, end) - origin) / step) + 1,
                               math.ceil((max(start, end) - origin) / step)):
                cuts.add((origin + index * step - start) / (end - start))
        points.extend((ax + t * (bx - ax), az + t * (bz - az)) for t in sorted(cuts))
    points.append(line.coords[-1])
    stations = []
    for x, z in points:
        y = sample(x, z)
        if y is None:
            raise ValueError(f'Unsupported waterfront crest at {x:.3f}, {z:.3f}')
        stations.append([round(x, 4), round(y, 4), round(z, 4)])
    return stations


def _public_route(paths, manifest, sample):
    approach, entry, coast = (paths[i] for i in manifest['walkRoute'])
    if approach['nodes'][-1] != entry['nodes'][0] or entry['nodes'][-1] not in coast['nodes']:
        raise ValueError('Waterfront public route has no shared source node')
    view = coast['nodes'].index(manifest['viewNode'])
    points = [*approach['points'], *entry['points'][1:], *coast['points'][view + 1:]]
    stations = []
    for a, b in zip(points, points[1:]):
        count = max(1, math.ceil(math.dist(a, b) / 2))
        stations.extend((a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)
                        for i in range(count))
    stations.append(points[-1])
    heights = [sample(*point) for point in stations]
    if any(y is None for y in heights):
        raise ValueError('Waterfront walking route has a support gap')
    return [[round(x, 4), round(y, 4), round(z, 4)] for (x, z), y in zip(stations, heights, strict=True)]


def build_shenzhen_bay(payload, osm, pbf, report):
    if 'shenzhenBay' in payload:
        raise ValueError('Use the unmodified city payload or a full build to rebuild the waterfront')
    manifest = json.loads(MANIFEST.read_text())
    if manifest['version'] != 1 or manifest['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Waterfront requires the reviewed OSM snapshot')
    park = next(p for p in payload['parks'] if p['osmId'] == manifest['parkOsmId'])
    park_area = unary_union([_polygon(area['polygon']) for area in park['areas']
                             if area['osmId'] == manifest['areaOsmId']])
    if park_area.is_empty:
        raise ValueError('Missing reviewed waterfront park boundary')
    surface = payload['terrainSurface']
    shore = _coast_profiles(manifest, osm, surface)
    coastline = linemerge([line for _, line in shore])
    if coastline.geom_type != 'LineString':
        raise ValueError('Waterfront shoreline must be connected')
    ends = [Point(coastline.coords[0]), Point(coastline.coords[-1])]
    paths = _paths(manifest, osm, pbf)
    arrival = next(row for row in payload['metro']['entrances'] if row['id'] == manifest['arrivalReference'])
    arrival_gap = math.dist(paths[0]['points'][0], (arrival['x'], arrival['z']))
    if arrival_gap > 8 or any(LineString(path['points']).difference(park_area.buffer(8)).length > 0.01
                             for path in paths[1:]):
        raise ValueError('Waterfront path leaves the reviewed park or station approach')
    strips = {kind: unary_union([LineString(path['points']).buffer(path['widthM'] / 2, quad_segs=8)
                                 for path in paths if path['material'] == kind])
              for kind in ('walk', 'cycle', 'cycle-stone')}
    pavement = unary_union(list(strips.values()))
    road_mask, roads = ground_carriageway_mask(pavement, payload['roadGraph'])
    crossing = strips['walk'].intersection(strips['cycle'].union(strips['cycle-stone']))
    masks = {mode: strip.difference(road_mask) for mode, strip in
             (('crossing', crossing), ('walk', strips['walk'].difference(crossing)),
              ('cycle', strips['cycle'].difference(crossing)),
              ('cycle-stone', strips['cycle-stone'].difference(crossing)))}
    for mask in masks.values():
        prepare(mask)

    estimate = manifest['estimates']
    influence = coastline.buffer(estimate['gradeBlendM'])
    prepare(influence)

    def grade(x, y, z):
        point = Point(x, z)
        if not influence.covers(point):
            return y
        transverse = max(0, 1 - point.distance(coastline) / estimate['gradeBlendM'])
        fade = min(1, min(point.distance(end) for end in ends) / estimate['endBlendM'])
        return y - max(0, y - estimate['coastalCrestM']) * transverse * fade

    affected = influence.union(pavement)
    chunks, rebuilt, paving_m2 = [], [], {key: 0.0 for key in masks}
    for chunk in surface['chunks']:
        x, z = chunk['origin']
        size = surface['chunkSize']
        if affected.intersects(box(x, z, x + size, z + size)):
            chunk, areas = _cut_paving(chunk, grade, masks, pavement, surface['grid'])
            rebuilt.append(chunk['id'])
            for key, area in areas.items():
                paving_m2[key] += area
        chunks.append(chunk)
    payload['terrainSurface'] = {**surface, 'chunks': chunks}
    sample = _surface_sampler(payload['terrainSurface'], affected)
    route = _public_route(paths, manifest, sample)
    shore_rows = [{**spec, 'lengthM': round(line.length, 2),
                   'stations': _shore_stations(line, sample, surface['grid'])} for spec, line in shore]
    path_rows = [{**path, 'lengthM': round(LineString(path['points']).length, 2)} for path in paths]
    payload['shenzhenBay'] = {'version': 1, 'areaOsmId': manifest['areaOsmId'],
                              'paths': path_rows, 'shore': shore_rows, 'walkRoute': route,
                              'viewNode': manifest['viewNode'], 'estimates': estimate,
                              'arrivalReference': manifest['arrivalReference'],
                              'seaHeightM': payload['seaSurface']['heightM']}
    report['shenzhenBayWaterfront'] = {
        'status': 'pilot-generated', 'checkedAt': manifest['checkedAt'], 'parkOsmId': manifest['parkOsmId'],
        'areaOsmId': manifest['areaOsmId'], 'sources': manifest['sources'], 'estimates': estimate,
        'shore': [{key: value for key, value in row.items() if key != 'stations'} for row in shore_rows],
        'paths': [{key: value for key, value in row.items() if key != 'points'} for row in path_rows],
        'walkRouteM': round(sum(math.dist((a[0], a[2]), (b[0], b[2])) for a, b in zip(route, route[1:])), 2),
        'arrivalReference': {'osmId': arrival['id'], 'distanceToApproachM': round(arrival_gap, 2)},
        'changedTerrainChunks': rebuilt, 'pavingM2': {key: round(area, 2) for key, area in paving_m2.items()},
        'roadMask': roads, 'sourceHeight': 'local-visual-estimate-on-existing-terrain'
    }
