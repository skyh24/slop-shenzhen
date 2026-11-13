"""在锁定源地块内，把同一地形三角面划分为保留地类、草坪和石材。"""

import hashlib
import json
from pathlib import Path

import osmium
from shapely import STRtree, constrained_delaunay_triangles, prepare, union_all, wkb
from shapely.algorithms.polylabel import polylabel
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, substring

from audit_shopping_park import boundary_lines, packaged_polygon
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project
from land import _to_local
from map_regions import parts, road_footprints, valid_area
from terrain_surface import _triangle_height

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'data/source/urban-paving.json'
STONE, LAWN = 10, 11
RESTRICTED = {'no', 'private', 'customers', 'permit', 'delivery', 'destination'}
OFF_GROUND = {'underground', 'underwater', 'roof', 'rooftop', 'indoor'}
LAND_USE = {'railway', 'construction', 'brownfield', 'industrial', 'cemetery', 'military', 'reservoir',
            'basin', 'forest', 'grass', 'meadow', 'recreation_ground', 'village_green', 'allotments',
            'plant_nursery', 'farmland', 'orchard', 'flowerbed', 'quarry', 'landfill'}
LINE_WALKS = {'footway', 'path', 'cycleway', 'pedestrian', 'steps', 'track', 'bridleway', 'corridor'}
AREA_AMENITIES = {'parking', 'parking_space', 'bicycle_parking', 'school', 'kindergarten', 'hospital',
                  'fuel', 'marketplace', 'bus_station', 'fountain', 'grave_yard', 'place_of_worship'}
AREA_KEYS = ('access', 'foot', 'natural', 'leisure', 'landuse', 'amenity', 'highway', 'railway',
             'waterway', 'aeroway', 'tourism', 'man_made', 'military', 'sport', 'barrier',
             'place', 'surface', 'opening_hours')


def _at_grade(tags):
    return (tags.get('location') not in OFF_GROUND and tags.get('indoor') not in ('yes', 'room', 'corridor')
            and tags.get('layer', '0') == '0' and tags.get('level', '0') == '0'
            and tags.get('bridge', 'no') == 'no' and tags.get('tunnel', 'no') == 'no')


def _restricted(tags):
    return (tags.get('access') in RESTRICTED or tags.get('foot') in RESTRICTED
            or any(tags.get(key) for key in ('access:conditional', 'foot:conditional')))


def _known_area(tags):
    return (any(tags.get(key) for key in ('leisure', 'sport', 'aeroway', 'military', 'waterway'))
            or tags.get('natural') not in (None, 'tree', 'tree_row')
            or tags.get('landuse') in LAND_USE or tags.get('amenity') in AREA_AMENITIES
            or tags.get('highway') in LINE_WALKS or tags.get('railway') not in (None, 'abandoned', 'razed')
            or tags.get('barrier') in ('fence', 'wall', 'hedge')
            or tags.get('man_made') in ('planter', 'pier', 'wastewater_plant')
            or tags.get('tourism') in ('camp_site', 'caravan_site', 'picnic_site')
            or tags.get('place') in ('square', 'plaza'))


def _line_width(tags):
    highway = tags.get('highway')
    if tags.get('tunnel', 'no') != 'no' and highway in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'service'):
        # 保留隧道口，地面可以跨越已明确处在地下的中段。
        return 0
    if not _at_grade(tags):
        return None
    if tags.get('railway') in ('rail', 'light_rail', 'tram', 'subway', 'narrow_gauge'):
        return 4
    if tags.get('waterway') in ('river', 'stream', 'drain', 'canal', 'ditch'):
        return 3
    if tags.get('barrier') in ('fence', 'wall', 'hedge'):
        return 0.5
    if highway in LINE_WALKS or highway == 'service' or _restricted(tags):
        try:
            return max(1.5, min(8, float(tags.get('width', 6 if highway == 'service' else 2.5)) / 2 + 0.25))
        except ValueError:
            pass
        return 3 if highway == 'service' else 1.5
    return None


def _source_masks(pbf, frame, parcels, *, frontage_uses=(), walk_exclusions=None):
    bounds = [(ORIGIN_LON + a / KX, ORIGIN_LAT - d / KY, ORIGIN_LON + c / KX, ORIGIN_LAT - b / KY)
              for a, b, c, d in (part.bounds for part in parts(frame))]

    def near(nodes):
        if not nodes:
            return False
        xs, ys = zip(*nodes)
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        return any(x0 <= east and x1 >= west and y0 <= north and y1 >= south
                   for west, south, east, north in bounds)

    areas, paths, portals, records = [], [], [], {}
    factory = osmium.geom.WKBFactory()
    source = (osmium.FileProcessor(str(pbf)).with_locations().with_areas()
              .with_filter(osmium.filter.KeyFilter(*AREA_KEYS, 'entrance', 'crossing', 'shop')))
    for item in source:
        tags = dict(item.tags)
        if item.is_node():
            if not item.location.valid() or not _at_grade(tags):
                continue
            coords = [(item.lon, item.lat)]
            if near(coords) and (tags.get('entrance') not in (None, 'no') or tags.get('highway') == 'crossing'
                                 or tags.get('barrier') in ('gate', 'lift_gate', 'bollard')):
                portals.append(Point(project(*coords[0])).buffer(2.5 if tags.get('highway') == 'crossing' else 1.25))
        elif item.is_way():
            width = _line_width(tags)
            if width is None:
                continue
            coords = [(node.lon, node.lat) for node in item.nodes if node.location.valid()]
            if len(coords) < 2 or not near(coords):
                continue
            points = [project(*p) for p in coords]
            if width:
                shape = LineString(points).buffer(width, cap_style='square')
                paths.append(shape)
                if walk_exclusions is not None and (_restricted(tags) or tags.get('barrier') or
                        tags.get('railway') or tags.get('waterway')):
                    walk_exclusions.append(shape.intersection(frame))
            else:
                portals.extend(Point(p).buffer(12) for p in (points[0], points[-1]))
        elif item.is_area():
            identity = f"{'way' if item.from_way() else 'relation'}/{item.orig_id()}"
            frontage = tags.get('landuse') in frontage_uses
            if (not _at_grade(tags) or tags.get('area') == 'no'
                    or not (identity in parcels or frontage or _restricted(tags) or _known_area(tags))):
                continue
            if not any(near([(n.lon, n.lat) for n in ring if n.location.valid()]) for ring in item.outer_rings()):
                continue
            shape = valid_area(_to_local(wkb.loads(factory.create_multipolygon(item), hex=True)))
            if identity in parcels or frontage:
                records[identity] = (shape, tags)
            if _restricted(tags) or _known_area(tags):
                areas.append(shape.intersection(frame))
            if walk_exclusions is not None and (_restricted(tags)
                    or tags.get('leisure') in ('pitch', 'nature_reserve', 'golf_course', 'playground')
                    or tags.get('landuse') in ('construction', 'military', 'railway', 'flowerbed', 'allotments')
                    or tags.get('amenity') in ('parking', 'parking_space', 'fountain')
                    or tags.get('man_made') == 'planter' or tags.get('barrier') in ('fence', 'wall', 'hedge')):
                walk_exclusions.append(shape.intersection(frame))
    return records, union_all(areas), union_all([shape.intersection(frame) for shape in paths + portals])


def _lines(shape):
    if shape.geom_type == 'LineString':
        yield shape
    for item in getattr(shape, 'geoms', ()):
        yield from _lines(item)


def _divider(graph, ids, frame):
    side, main = [boundary_lines(graph, [identity], frame)[0] for identity in ids]
    strips = []
    for a in side:
        for b in main:
            for parallel in _lines(a.intersection(b.buffer(32))):
                if parallel.length < 35:
                    continue
                edge = substring(parallel, 5, parallel.length - 5)
                begin, end = (b.project(Point(p)) for p in (edge.coords[0], edge.coords[-1]))
                other = substring(b, begin, end)
                if other.geom_type == 'LineString':
                    strips.append(valid_area(Polygon(list(edge.coords) + list(other.coords)[::-1])))
    return union_all(strips).intersection(frame)


def _frontage_reservations(payload, frame, *, include_paths=True):
    shapes = []
    frontage = payload.get('roadFrontage', {})
    for feature in [*frontage.get('features', []),
                    *(payload.get('roadStructures', {}).get('landscape') or {}).get('patches', [])]:
        if feature['kind'] == 'paint':
            continue
        coords = feature['trianglesXZ']
        for i in range(0, len(coords), 6):
            tri = coords[i:i + 6]
            shape = Polygon(zip(tri[::2], tri[1::2], strict=True))
            if frame.intersects(shape):
                shapes.append(shape)
    for corridor in frontage.get('corridors', []) if include_paths else []:
        for axis in corridor.get('crossingAxes', []):
            points = axis.get('points', [])
            if len(points) >= 2 and isinstance(points[0], list):
                shapes.append(LineString(points).buffer(2.5))
    for path in (payload.get('streetscape') or {}).get('paths', []):
        for segment in path['segments']:
            if len(segment['points']) >= 2:
                shapes.append(LineString(segment['points']).buffer(path['widthM'] / 2 + .25))
    paths = [*payload.get('shenzhenBay', {}).get('paths', []), *payload.get('iecPaths', []),
             *(p for route in payload.get('waterfront', {}).get('routes', []) for p in route['paths'])]
    if path := (payload.get('roadStructures', {}).get('landscape') or {}).get('publicPath'):
        paths.append(path)
    for path in paths:
        if not path.get('bridge') and len(path['points']) >= 2:
            line = LineString(path['points'])
            if frame.intersects(line):
                shapes.append(line.buffer(path['widthM'] / 2))
    # 已建中心二路西侧至东南门的独立步行面和花箱，沿相同的设计线预留。
    shapes.extend([LineString([(-467.2, 1142), (-465.3, 1152), (-463.4, 1171), (-464.1, 1177.4),
                               (-488.6, 1164.2), (-489.65, 1163.65)]).buffer(2.2),
                   box(-478.75, 1173, -476.85, 1174.4)])
    return union_all([valid_area(shape) for shape in shapes if frame.intersects(shape)])


def _candidates(payload, osm_source, specs):
    graph, buildings = payload['roadGraph'], payload['buildings']
    frames = [Point(spec['seedXZ']).buffer(120, quad_segs=1).envelope for spec in specs]
    frame = union_all([shape.buffer(35) for shape in frames])
    parcels = {spec['parcel'] for spec in specs if 'parcel' in spec}
    records, known, paths = _source_masks(ROOT / osm_source['file'], frame, parcels)
    floors = [valid_area(packaged_polygon(rings)) for rings, base in
              zip(buildings['rings'], buildings['minH'], strict=True) if base < 2.4]
    index = STRtree(floors)
    trees = payload.get('trees', {})
    trees_at = STRtree([Point(x / 10, z / 10) for x, z in zip(trees.get('x', []), trees.get('z', []), strict=True)])
    dry = union_all([valid_area(packaged_polygon(rings)) for rings in payload['land']])
    natural = union_all([valid_area(packaged_polygon(rings)) for key in ('water', 'wetland', 'green')
                         for rings in payload[key] if frame.intersects(box(*packaged_polygon(rings).bounds))])
    for spec, local in zip(specs, frames, strict=True):
        identity, kind = spec['id'], spec['kind']
        local = local.buffer(30, join_style='mitre')
        asphalt = union_all(road_footprints(graph, local.bounds))
        nearby = union_all([floors[i] for i in index.query(local, predicate='intersects')])
        existing = union_all([known.intersection(local), natural.intersection(local),
                              paths.intersection(local), _frontage_reservations(payload, local)])
        protect = union_all([asphalt.buffer(.25), existing, nearby])
        route = None
        if kind == 'lawn':
            lines, _ = boundary_lines(graph, spec['roads'], local)
            rings = [ring for ring in polygonize(union_all(lines)) if ring.contains(Point(spec['seedXZ']))]
            if len(rings) != 1:
                raise ValueError(f'Expected one closed road face for {identity}')
            area = rings[0]
            if area.difference(asphalt).intersection(nearby).area > 1:
                raise ValueError(f'Built-up road face for {identity}')
        elif kind == 'divider':
            area = _divider(graph, spec['roads'], local.buffer(-30))
        else:
            parcel, tags = records[spec['parcel']]
            if _restricted(tags) or tags.get('landuse') != 'retail':
                raise ValueError(f'Unexpected frontage use for {identity}')
            if 'publicRoute' in spec:
                route = LineString(spec['publicRoute']['pointsXZ'])
                if not parcel.buffer(2).covers(route) or route.distance(asphalt) < 1.6:
                    raise ValueError(f'Unsafe public frontage for {identity}')
            area = parcel.intersection(nearby.buffer(9)).intersection(asphalt.buffer(28))
            if route:
                area = area.union(route.buffer(3).intersection(parcel.buffer(2)))
        # 地块可以超出源物件与车行面查询窗口。仅填充窗口内已经完成排除检查的地面。
        area = area.intersection(local)
        surface = area.intersection(dry).difference(protect)
        minimum = 100 if kind == 'lawn' else 15
        surface = union_all([part for part in parts(surface) if part.area >= minimum
                             and not part.buffer(-(.65 if kind == 'divider' else 1.15)).is_empty])
        if surface.is_empty:
            yield spec, surface, None, [], {'status': 'excluded-by-source-or-clearance'}
            continue
        if route:
            # 通行带还可接到已有开放铺装。门内及未核实区域没有 NPC 通行权。
            clearance = route.buffer(spec['publicRoute']['widthM'] / 2)
            conflicts = {key: round(clearance.intersection(mask).area, 3)
                         for key, mask in (('buildings', nearby), ('road', asphalt), ('known use', known))}
            if max(conflicts.values()) > 0.01:
                raise ValueError(f'Obstructed public frontage for {identity}: {conflicts}')
        pilot_trees = []
        if kind == 'lawn':
            for part in sorted(parts(surface), key=lambda part: -part.area):
                plantable = part.buffer(-4)
                if plantable.area < 80:
                    continue
                point = polylabel(max(parts(plantable), key=lambda p: p.area), tolerance=1)
                if not len(trees_at.query(point.buffer(6), predicate='intersects')):
                    pilot_trees.append({'id': f'{identity}:tree-{len(pilot_trees) + 1}',
                                        'x': round(point.x, 2), 'z': round(point.y, 2),
                                        'height': 6.5, 'crown': 4.2, 'speciesName': 'camphor'})
                if len(pilot_trees) == 2:
                    break
        yield spec, surface, route, pilot_trees, {
            'status': 'built', 'candidateAreaM2': round(area.area, 2),
            'protectedAreaM2': round(area.intersection(protect).area, 2),
            'overlapM2': round(surface.intersection(protect).area, 6)}


def _partition(chunk, candidates, covered):
    ox, oz = chunk['origin']
    positions, kinds = chunk['positions'].copy(), chunk['kinds'].copy()
    vertex_ids = {(*positions[3 * i:3 * i + 3], kind): i for i, kind in enumerate(kinds)}
    indices, ranges = [], []
    original = chunk['indices']

    def emit(shape, plane, kind):
        for piece in parts(shape):
            for tri in constrained_delaunay_triangles(piece).geoms:
                if tri.area <= 1e-10:
                    continue
                a, b, c = list(tri.exterior.coords)[:3]
                for x, z in (a, c, b) if tri.exterior.is_ccw else (a, b, c):
                    y = _triangle_height(plane, x, z)
                    key = (x - ox, y, z - oz, kind)
                    if key not in vertex_ids:
                        vertex_ids[key] = len(kinds)
                        positions.extend(key[:3])
                        kinds.append(kind)
                    indices.append(vertex_ids[key])

    changed = False
    for cell, start, count in zip(*[iter(chunk['cellRanges'])] * 3, strict=True):
        first = len(indices)
        for i in range(start, start + count, 3):
            face = original[i:i + 3]
            face_kinds = {kinds[v] for v in face}
            base = next(iter(face_kinds)) if len(face_kinds) == 1 else (None if face_kinds <= {0, 1} else -1)
            if not any(base in spec.get('baseKinds', (0, 3)) for spec, _ in candidates):
                indices.extend(face)
                continue
            plane = [(ox + positions[3 * v], positions[3 * v + 1], oz + positions[3 * v + 2]) for v in face]
            triangle = Polygon([(x, z) for x, _, z in plane])
            remaining = triangle
            for spec, mask in candidates:
                kind = spec.get('surfaceKind', STONE if spec['kind'] == 'stone' else LAWN)
                if (base not in spec.get('baseKinds', (0, 3)) or base == kind
                        or (base == 3 and kind == LAWN) or not mask.intersects(remaining)):
                    continue
                overlap = remaining.intersection(mask)
                if overlap.area <= 1e-10:
                    continue
                covered[spec['id']].extend(parts(overlap))
                emit(overlap, plane, kind)
                remaining = remaining.difference(overlap)
            if remaining is triangle:
                indices.extend(face)
            else:
                changed = True
                # 地形的绿地边沿可能共享不同色的顶点；切分后保留绿地侧的底色。
                emit(remaining, plane, base if base is not None else 1)
        ranges.extend([cell, first, len(indices) - first])
    return ({**chunk, 'positions': positions, 'kinds': kinds, 'indices': indices, 'cellRanges': ranges}
            if changed else chunk)


def compile_urban_paving(payload, osm_source, report, *, pilot_only=False):
    source = MANIFEST.read_bytes()
    manifest = json.loads(source)
    if manifest['version'] != 1 or manifest['osmSnapshotSha256'] != osm_source['sha256']:
        raise ValueError('Urban paving requires the reviewed OSM snapshot')
    previous = payload.get('urbanPaving')
    digest = hashlib.sha256(source).hexdigest()
    extending = False
    if previous:
        if previous.get('manifestSha256') != digest or (pilot_only and not previous['pilotOnly']):
            raise ValueError('Rebuild the underlying ground before replacing urban paving')
        if previous['pilotOnly'] == pilot_only:
            return
        extending = True
    specs = manifest['sites']
    if pilot_only or extending:
        specs = [spec for spec in specs if bool(spec.get('pilot')) == pilot_only]
    candidates = list(_candidates(payload, osm_source, specs))
    covered = {spec['id']: [] for spec in specs}
    chunks, changed = [], []
    surface = payload['terrainSurface']
    size = surface['chunkSize']
    for _, mask, *_ in candidates:
        prepare(mask)
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        frame = box(ox, oz, ox + size, oz + size)
        masks = [(spec, mask) for spec, mask, *_ in candidates if mask.intersects(frame)]
        updated = _partition(chunk, masks, covered) if masks else chunk
        chunks.append(updated)
        if updated is not chunk:
            changed.append(chunk['id'])
    old_report = report['urbanPaving'] if extending else {}
    public_routes = list(old_report.get('publicRoutes', []))
    trees = list(old_report.get('trees', []))
    sites = list(old_report.get('sites', []))
    for spec, _, route, proposed_trees, statistics in candidates:
        identity = spec['id']
        paving = union_all(covered[identity])
        if paving.is_empty:
            if spec.get('pilot'):
                raise ValueError(f'No eligible ground for pilot: {identity}')
            statistics['status'] = 'excluded-by-source-or-clearance'
        sites.append({**spec, **statistics, 'builtAreaM2': round(paving.area, 2)})
        for tree in proposed_trees:
            if paving.covers(Point(tree['x'], tree['z']).buffer(1)):
                trees.append(tree)
        if route:
            if paving.intersection(route).length < route.length * 0.85:
                raise ValueError(f'Incomplete stone approach for {identity}')
            public_routes.append({'id': identity, **spec['publicRoute']})
    payload['terrainSurface'] = {**surface, 'chunks': chunks}
    payload['urbanPaving'] = {'version': 1, 'manifestSha256': digest, 'pilotOnly': pilot_only,
                              'publicRoutes': public_routes, 'trees': trees}
    report['urbanPaving'] = {**payload['urbanPaving'], 'sites': sites, 'rebuiltChunks': sorted(set(changed + old_report.get('rebuiltChunks', []))),
                             'groundHeightSource': 'original-terrain-triangle',
                             'materialSource': 'simulation-estimate',
                             'osmSnapshotSha256': osm_source['sha256']}
    if 'terrainSurface' in report:
        report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in chunks),
                                        triangles=sum(len(chunk['indices']) // 3 for chunk in chunks))
