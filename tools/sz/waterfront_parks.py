"""按锁定路线关系、海岸和公园水面编译滨水场景。"""

import json
import math
from pathlib import Path

import osmium
from shapely import STRtree, make_valid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, unary_union

from commercial_paving import ground_carriageway_mask
from land import _polys, _to_local
from package_validation import ring_points
from roads import _num
from shenzhen_bay import PAVING, PUBLIC, _lines, _polygon, _shore_stations, _snapshots, _surface_sampler, _terrain_boundary, path_material
from waterfront import _clip_terrain, _height_rows, _line, _points, _profile, _water

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/waterfront-park-network.json'


def _valid(shape):
    return shape if shape.is_valid else make_valid(shape)


def _layer(rings):
    return unary_union([_valid(_polygon(row)) for row in rings])


def _route_ways(pbf, relations):
    reader = osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(osmium.filter.IdFilter(set(relations)))
    result = {row.id: {m.ref for m in row.members if m.type == 'w'} for row in reader}
    if set(result) != set(relations):
        raise ValueError('Missing waterfront route relation')
    return result


def _bay_routes(plan, osm, pbf, sample, wet, sea_height):
    cycle, walk = plan['cyclingRelation'], plan['walkingRelation']
    relations = _route_ways(pbf, [cycle, walk])
    cycle_ways = relations[cycle] | set(plan['cycleConnections'])
    walk_ways = relations[walk]
    ids = cycle_ways | walk_ways
    identities = {f'way/{i}' for i in ids}
    ways = {row['id']: row for row in osm['roads'] if row['id'] in identities}
    tags_by_way = _snapshots(pbf, identities, extra_tags=('segregated',))
    routes, bridges, gaps = [], [], []
    for number in sorted(ids):
        identity = f'way/{number}'
        if number in plan['unbuiltWays'] or identity not in ways:
            gaps.append({'id': identity, 'reason': 'unresolved-source-way'})
            continue
        source = tags_by_way[identity]
        tags = source['tags']
        bridge = tags.get('bridge', 'no') != 'no'
        foot = tags.get('foot') in PUBLIC and (number in walk_ways or tags.get('foot') is not None)
        bicycle = number in cycle_ways and tags.get('bicycle') in PUBLIC
        if (tags.get('highway') not in ('cycleway', 'footway', 'path', 'pedestrian')
                or tags.get('access') not in PUBLIC or not (foot or bicycle)
                or tags.get('layer', '0') not in (('0', '1') if bridge else ('0',))
                or tags.get('tunnel', 'no') != 'no' or tags.get('level', '0') != '0'
                or 'opening_hours' in tags or any(k.endswith(':conditional') for k in tags)):
            gaps.append({'id': identity, 'reason': 'access-or-layer'})
            continue
        line = _line(ways[identity])
        mode = 'shared' if bicycle and foot else 'cycle' if bicycle else 'walk'
        width = _num(tags.get('width'))
        width = width if width and width > 0 else None
        row = {'osmId': identity, **source, 'mode': mode, 'widthM': width or plan['cycleWidthM' if bicycle else 'walkWidthM'],
               'widthSource': 'osm' if width else 'estimate', 'material': path_material(tags),
               'bridge': bridge, 'heightSource': 'portal-estimate' if bridge else 'terrain-derived-estimate'}
        if bridge:
            try:
                height_at = _profile(line, sea_height, sample)
                points = _height_rows(line, height_at, step=3)
            except ValueError:
                gaps.append({'id': identity, 'reason': 'missing-bridge-portal'})
                continue
            # 桥面随两端实际地坪接入，渲染和接触使用现有慢行桥计划。
            bridges.append({'id': identity, 'widthM': row['widthM'], 'girderDepthM': 0.55,
                            'mode': mode, 'points': points, 'waterHeightM': sea_height, 'coastal': True})
            parts = [line]
        else:
            # 保留原中心线，穿湿地或无地面支撑的普通路径留缺口。
            parts = list(_lines(line.difference(wet.buffer(0.35)))) if line.intersects(wet) else [line]
            if not parts or sum(p.length for p in parts) < line.length - 0.4:
                gaps.append({'id': identity, 'reason': 'water-or-wetland'})
        for part in parts:
            if part.length < 0.75:
                continue
            try:
                if not bridge:
                    _height_rows(part, sample, step=4)
            except ValueError:
                gaps.append({'id': identity, 'reason': 'unsupported-ground'})
                continue
            routes.append((row, part))
    return routes, bridges, gaps


def _shorelines(plan, osm, surface, wetland, park, old_shore):
    ways = {int(row['id'].split('/')[1]): row for row in osm['coastline']}
    routes = [(ways[i]['id'], _line(ways[i]).intersection(park.buffer(50)).difference(wetland.buffer(2)))
              for i in plan['coastWays']]
    # 已有中湾精细护岸保留。其他已建岸段贴实际地形边，湿地和内湖水口留空。
    preserved = unary_union([LineString([(x, z) for x, _, z in row['stations']]).buffer(1.7) for row in old_shore])
    band = unary_union([line.buffer(1.45, cap_style='flat') for _, line in routes])
    edge = _terrain_boundary(surface, band.buffer(28)).intersection(band).difference(preserved)
    sample = _surface_sampler(surface, band.buffer(30))
    source_lines = STRtree([line for _, line in routes])
    rows = []
    for line in _lines(linemerge(list(_lines(edge)))):
        if line.length < 4:
            continue
        identity = routes[source_lines.nearest(line.interpolate(0.5, normalized=True))][0]
        points = _shore_stations(line, sample, surface['grid'])
        rows.append({'id': identity, 'profile': 'seawall', 'stations': points, 'lengthM': round(line.length, 2)})
    return rows


def _height_parts(line, sample, *, max_grade=0.22):
    """将岸边道路按可连续落脚的区间分开，保留真实水口和陡坡。"""
    parts, points = [], []
    for x, z in _points(line, step=2):
        y = sample(x, z)
        if y is None or (points and abs(y - points[-1][1]) > 0.025 + max_grade * math.hypot(x - points[-1][0], z - points[-1][2])):
            if len(points) > 2:
                parts.append(points)
            points = []
        if y is not None:
            points.append([round(x, 4), round(y, 4), round(z, 4)])
    if len(points) > 2:
        parts.append(points)
    return parts


def _lake_routes(specs, payload, osm, sample, obstacles):
    waterfront = payload['waterfront']
    known = {row['waterIndex'] for key in ('waters', 'extensionWaters') for row in waterfront.get(key, [])}
    known.add(payload.get('talentPark', {}).get('lakeWaterIndex'))
    parks = {row['id']: _valid(_to_local(row['geom'])) for row in osm['green']
             if row['id'] in {s.get('park') for s in specs}}
    routes, lamps, waters, report = [], [], [], []
    for spec in specs:
        if 'route' in spec:
            existing = next(row for row in waterfront['routes'] if row['id'] == spec['route'])
            lamps.append({'id': spec['id'], 'points': existing['points'], 'spacingM': spec['lampSpacingM'],
                          'side': 'alternate', 'widthM': max(p['widthM'] for p in existing['paths'])})
            for row in existing['paths']:
                if not row['bridge'] and row['tags'].get('surface') is None:
                    routes.append((row | {'material': 'paving_stones'}, LineString(row['points'])))
            continue
        for identity in spec['waterIds']:
            index, polygon = _water(payload, osm, identity)
            polygon = max(_polys(_valid(polygon)), key=lambda p: p.area)
            width = spec['widthM']
            # 只在选定公园里做展示石路，两湖窄夹岸、建筑、车道和湿地留出距离。
            outer = polygon.buffer(spec['setbackM'], quad_segs=4).simplify(0.35).exterior
            margin = width / 2 + 0.12
            admissible = parks[spec['park']].buffer(-margin).difference(obstacles.buffer(margin))
            line = LineString(outer.coords)
            pieces = linemerge(list(_lines(line.intersection(admissible))))
            lines = []
            for part in _lines(pieces):
                for points in _height_parts(part, sample):
                    path = LineString([(x, z) for x, _, z in points])
                    if path.length < 7:
                        continue
                    row = {'osmId': identity, 'mode': 'walk', 'widthM': width, 'widthSource': 'visual-estimate',
                           'material': 'paving_stones', 'heightSource': 'terrain-derived-estimate', 'geometrySource': 'shore-outline-design'}
                    routes.append((row, path))
                    lamps.append({'id': f'{spec["id"]}:{identity}:{len(lines)}', 'points': points, 'spacingM': spec['lampSpacingM'],
                                  'side': 'alternate', 'widthM': width})
                    lines.append(path)
            if lines and index not in known:
                shoreline = [sample(p.x, p.y) for p in (line.interpolate(d) for d in range(0, math.ceil(line.length), 12))]
                heights = [y for y in shoreline if y is not None]
                if heights:
                    waters.append({'id': identity, 'waterIndex': index, 'heightM': round(min(heights) - 0.65, 2),
                                   'heightSource': 'estimate'})
                    known.add(index)
            report.append({'id': identity, 'source': spec['source'], 'geometrySource': 'shore-outline-design',
                           'outlineM': round(line.length, 1), 'builtM': round(sum(p.length for p in lines), 1),
                           'closed': len(lines) == 1 and lines[0].is_ring})
    return routes, lamps, waters, report


def _bay_fixtures(rows, coastline, clearance, wet, park, sample, plan):
    lines = unary_union([line for row, line in rows if row['mode'] != 'walk' and not row['bridge']])
    park = park.buffer(2)
    lamps, plants = [], []
    for line in _lines(linemerge(list(_lines(lines)))):
        if line.length < 8:
            continue
        for spacing, target in ((plan['lampSpacingM'], lamps), (plan['plantSpacingM'], plants)):
            for i in range(int(line.length / spacing)):
                d = (i + 0.5) * spacing
                at = line.interpolate(d)
                a, b = (line.interpolate(d + delta) for delta in (-0.8, 0.8))
                length = a.distance(b)
                if length < 0.01 or at.distance(coastline) > 100:
                    continue
                nx, nz = (b.y - a.y) / length, (a.x - b.x) / length
                plus, minus = (Point(at.x + side * nx * 4, at.y + side * nz * 4) for side in (1, -1))
                seaward = 1 if plus.distance(coastline) < minus.distance(coastline) else -1
                for offset in ((3.2, 4.6, 6.2) if target is lamps else (4.5, 6.0, 8.0, 10.5)):
                    side = -seaward if target is lamps else seaward
                    q = Point(at.x + side * nx * offset, at.y + side * nz * offset)
                    pad = 0.65 if target is lamps else 1.65
                    if wet.distance(q) < pad or not park.covers(q) or clearance.distance(q) < pad:
                        continue
                    height = sample(q.x, q.y)
                    if height is None:
                        continue
                    target.append([round(q.x, 3), round(height, 3), round(q.y, 3),
                                   round(at.x, 3), round(at.y, 3)])
                    break
    return lamps, plants


def compile_waterfront_parks(payload, osm, pbf, report):
    plan = json.loads(MANIFEST.read_text())
    if plan['version'] != 1 or plan['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Park waterfront requires the reviewed OSM snapshot')
    waterfront = payload['waterfront']
    if 'parkNetwork' in waterfront:
        raise ValueError('Rebuild the underlying terrain before replacing park waterfront')
    surface = payload['terrainSurface']
    park = unary_union([_valid(_polygon(r['polygon'])) for park in payload['parks']
                        if park['id'] == 'shenzhen-bay-park' for r in park['areas']])
    sample = _surface_sampler(surface, park.envelope.buffer(200))
    water = _layer(payload['water'])
    wetlands = _layer(payload['wetland'])
    sea = _layer(payload['seaSurface']['polygons'])
    wet = unary_union([water, wetlands, sea])
    bay = plan['bay']
    bay_routes, bridges, gaps = _bay_routes(bay, osm, pbf, sample, wet, payload['seaSurface']['heightM'])
    bay_data = payload['shenzhenBay']
    shore = _shorelines(bay, osm, surface, wetlands, park, bay_data['shore'])
    coast = unary_union([LineString([(x, z) for x, _, z in row['stations']]) for row in [*bay_data['shore'], *shore]])
    bay_strips = unary_union([line.buffer(row['widthM'] / 2) for row, line in bay_routes])
    lake_bounds = unary_union([_to_local(row['geom']).envelope.buffer(45) for row in osm['water']
                              if row['id'] in {w for s in plan['lakes'] for w in s['waterIds']}])
    b = payload['buildings']
    buildings = []
    for rings, floor in zip(b['rings'], b['minH'], strict=True):
        outer = ring_points(rings[0])
        if floor < 2.5 and lake_bounds.intersects(Point(outer[0])):
            buildings.append(_valid(Polygon(outer)))
    road_mask, _ = ground_carriageway_mask(lake_bounds.union(bay_strips), payload['roadGraph'])
    lake_sample = _surface_sampler(surface, lake_bounds)
    lake_paths, lake_lamps, waters, lake_report = _lake_routes(plan['lakes'], payload, osm, lake_sample,
                                                               unary_union([wet, road_mask, *buildings]))
    masks = {}
    all_paths = [(row, line) for row, line in bay_routes if not row['bridge']] + lake_paths
    for name, kind in PAVING.items():
        mask = unary_union([line.buffer(row['widthM'] / 2, quad_segs=6) for row, line in all_paths
                            if row['material'] == name]).difference(road_mask).difference(wet)
        if masks:
            mask = mask.difference(unary_union(list(masks.values())))
        masks[kind] = mask
    surface, changed, _ = _clip_terrain(surface, masks, [], replace_kinds={0, 1, 2, 3, 8, 9, 10, 11})
    payload['terrainSurface'] = surface
    bay_data['shore'].extend(shore)
    waterfront['footbridges'].extend(bridges)
    avoid = bay_strips.union(unary_union([LineString(p['points']).buffer(p['widthM'] / 2) for p in bay_data['paths']]))
    bay_lamps, plants = _bay_fixtures(bay_routes, coast, avoid.union(road_mask), wet, park, sample, bay)
    bay_paths = [{**row, 'points': [list(p) for p in line.coords]} for row, line in bay_routes]
    lake_overlay = [{**row, 'points': [list(p) for p in line.coords]} for row, line in lake_paths
                    if row.get('geometrySource') == 'shore-outline-design']
    waterfront['parkNetwork'] = {'bayPaths': bay_paths, 'lakePaths': lake_overlay, 'bayLamps': bay_lamps,
                                 'bayPlants': plants, 'lakeLamps': lake_lamps, 'waters': waters,
                                 'openingHours': bay['openingHours']}
    report['waterfrontParkNetwork'] = {'checkedAt': plan['checkedAt'], 'osmSnapshotSha256': plan['osmSnapshotSha256'],
        'sources': bay['sources'], 'coastM': round(coast.length, 1), 'bayCycleM': round(unary_union([
            line for row, line in bay_routes if row['mode'] != 'walk']).length, 1),
        'bayPathCount': len(bay_paths), 'bayBridges': [r['id'] for r in bridges],
        'bayLamps': len(bay_lamps), 'bayPlants': len(plants), 'bayGaps': gaps, 'lakes': lake_report,
        'changedTerrainChunks': changed}
    report['terrainSurface'].update(vertices=sum(len(c['kinds']) for c in surface['chunks']),
                                    triangles=sum(len(c['indices']) // 3 for c in surface['chunks']))
