"""按已核对的路径关系编译大沙河生态长廊和滨海接驳。"""

import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point
from shapely.ops import linemerge, unary_union

from commercial_paving import ground_carriageway_mask
from land import _to_local
from roads import _num
from shenzhen_bay import PAVING, PUBLIC, _lines, _snapshots, _surface_sampler, path_material
from waterfront import _clip_terrain, _height_rows, _line, _profile, _water
from waterfront_parks import GREENWAY_PAVING, MANIFEST as PARK_MANIFEST, _layer, _route_ways, _valid, greenway_fixtures

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/dasha-greenway.json'


def _bank_rails(lines, river, routes, roads, wet, sample):
    """沿已建绿道靠水的一边摆放护栏。交叉路径和高差断开处留空。"""
    rows = []
    for line in _lines(linemerge(list(_lines(river.boundary)))):
        stations = []
        for i in range(1, math.floor(line.length / 3)):
            p = line.interpolate(i * 3)
            if lines.distance(p) > 5.0 or roads.distance(p) < 1.3:
                stations.append(None)
                continue
            a, b = (line.interpolate(i * 3 + d) for d in (-0.7, 0.7))
            length = a.distance(b)
            if length < 0.01:
                stations.append(None)
                continue
            nx, nz = (b.y - a.y) / length, (a.x - b.x) / length
            found = None
            for side in (1, -1):
                q = Point(p.x + nx * side * 0.6, p.y + nz * side * 0.6)
                if wet.distance(q) < 0.25 or routes.distance(q) < 0.35:
                    continue
                y = sample(q.x, q.y)
                if y is not None:
                    found = [round(q.x, 3), round(y, 3), round(q.y, 3)]
                    break
            stations.append(found)
        if any(a and b for a, b in zip(stations, stations[1:])):
            rows.append({'id': f'dasha-rail:{len(rows)}', 'stations': stations})
    return rows


def _bank_faces(water_shapes, river, sample):
    """从干地探测岸顶，把地形接到河水，并留出相邻水面的水口。"""
    faces = []
    for water, shape in water_shapes:
        height = water['heightM'] - 0.08
        for line in _lines(shape.boundary):
            stations = []
            length = line.length
            count = math.ceil(length / 2)
            for i in range(count + 1):
                along = (i % count) * length / count
                p = line.interpolate(along)
                a, b = [line.interpolate((along + d) % length) for d in (-0.30, 0.30)]
                chord = a.distance(b)
                hit = None
                if chord > 0.01:
                    nx, nz = (b.y - a.y) / chord, (a.x - b.x) / chord
                    for side in (1, -1):
                        toe = Point(p.x - side * nx * 0.40, p.y - side * nz * 0.40)
                        if not shape.covers(toe):
                            continue
                        for offset in (0.12, 0.35, 0.7, 1.3):
                            q = Point(p.x + side * nx * offset, p.y + side * nz * offset)
                            y = sample(q.x, q.y)
                            if y is not None and y > height + 0.20 and not river.covers(q):
                                hit = [round(v, 3) for v in (q.x, y, q.y, toe.x, toe.y)]
                                break
                        if hit:
                            break
                if hit:
                    stations.append(hit)
                else:
                    if len(stations) > 1:
                        faces.append({'waterId': water['id'], 'heightM': height, 'stations': stations})
                    stations = []
            if len(stations) > 1:
                faces.append({'waterId': water['id'], 'heightM': height, 'stations': stations})
    return faces


def compile_dasha_greenway(payload, osm, pbf, report):
    plan = json.loads(MANIFEST.read_text())
    if plan['version'] != 1 or plan['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Dasha Greenway requires the reviewed OSM snapshot')
    waterfront = payload['waterfront']
    if 'dasha' in waterfront:
        raise ValueError('Dasha Greenway is already compiled on this terrain')
    park = _valid(_to_local(next(r['geom'] for r in osm['green'] if r['id'] == plan['park'])))
    east, cycle = plan['walkingRelation'], plan['cyclingRelation']
    relations = _route_ways(pbf, [east, cycle])
    west_ways = set(plan['westWays'])
    ids = relations[east] | relations[cycle] | set(plan['connectors'])
    ways = {int(row['id'][4:]): row for row in osm['roads'] if int(row['id'][4:]) in ids}
    tags_by_way = _snapshots(pbf, {f'way/{i}' for i in ids}, extra_tags=('segregated',))
    graph = payload['roadGraph']
    wet = unary_union([_layer(payload['water']), _layer(payload['wetland']), _layer(payload['seaSurface']['polygons'])])
    surface = payload['terrainSurface']
    geometry = {i: _line(row) for i, row in ways.items()}
    extent = unary_union([park, *geometry.values()]).envelope.buffer(40)
    sample = _surface_sampler(surface, extent)
    water_rows = {}
    for identity, height in plan['waters'].items():
        index, rings = _water(payload, osm, identity)
        water_rows[identity] = {'id': identity, 'waterIndex': index, 'heightM': height, 'heightSource': 'estimate'}
    water_shapes = [(row, _layer([payload['water'][row['waterIndex']]])) for row in water_rows.values()]
    river = unary_union([shape for _, shape in water_shapes])
    existing_bridges = {r['id'] for r in waterfront['footbridges']}
    bay = waterfront['parkNetwork']
    bay_axes = {(p['osmId'], p['bridge']) for p in bay['bayPaths']}
    routes, bridges, gaps, roads = [], [], [], []
    for number in sorted(ids):
        identity = f'way/{number}'
        if (identity, False) in bay_axes or (identity, True) in bay_axes:
            continue
        source = tags_by_way.get(identity)
        if source is None or number not in geometry:
            gaps.append({'id': identity, 'reason': 'missing-source-way'})
            continue
        tags = source['tags']
        highway = tags.get('highway')
        bridge = tags.get('bridge', 'no') != 'no'
        line = geometry[number]
        if highway in ('unclassified', 'secondary', 'tertiary'):
            roads.append({'id': identity, 'reason': 'street-connection', 'lengthM': round(line.length, 1)})
            continue
        if (highway not in ('cycleway', 'footway', 'path', 'pedestrian')
                or tags.get('access') not in PUBLIC or tags.get('tunnel', 'no') != 'no'
                or tags.get('layer', '0') not in (('0', '1') if bridge else ('0',))
                or tags.get('level', '0') != '0' or 'opening_hours' in tags
                or any(k.endswith(':conditional') for k in tags)):
            gaps.append({'id': identity, 'reason': 'source-access-or-layer'})
            continue
        foot = tags.get('foot') in PUBLIC
        bicycle = tags.get('bicycle') in PUBLIC and (highway == 'cycleway' or tags.get('bicycle') is not None)
        if not (foot or bicycle):
            gaps.append({'id': identity, 'reason': 'source-access'})
            continue
        mode = 'shared' if foot and bicycle else 'cycle' if bicycle else 'walk'
        bank = 'west' if number in west_ways else 'east'
        width = _num(tags.get('width'))
        width = width if width and width > 0 else None
        material = path_material(tags)
        appearance, kind = GREENWAY_PAVING if bicycle and material in ('asphalt', 'unknown') else (material, PAVING[material])
        row = {'osmId': identity, **source, 'mode': mode, 'bank': bank, 'widthM': width or (3.1 if bicycle else 2.7),
               'widthSource': 'osm' if width else 'estimate', 'material': material, 'appearanceMaterial': appearance,
               'bridge': bridge, 'heightSource': 'portal-estimate' if bridge else 'terrain-derived-estimate'}
        if bridge:
            if identity in existing_bridges:
                continue
            near_water, _ = min(water_shapes, key=lambda pair: line.distance(pair[1]))
            level = near_water['heightM']
            try:
                height_at = _profile(line, level, sample)
                points = _height_rows(line, height_at, step=2)
            except ValueError:
                gaps.append({'id': identity, 'reason': 'unresolved-bridge-portals'})
                continue
            bridges.append({'id': identity, 'widthM': row['widthM'], 'girderDepthM': 0.45, 'mode': mode, 'bank': bank,
                            'points': points, 'waterIndex': near_water['waterIndex'], 'waterHeightM': level})
            routes.append((row, line, kind, points))
            continue
        parts = list(_lines(line.difference(wet))) if line.intersects(wet) else [line]
        if sum(p.length for p in parts) < line.length - 0.1:
            gaps.append({'id': identity, 'reason': 'water-or-wetland'})
        for part in parts:
            try:
                points = _height_rows(part, sample, step=3)
            except ValueError:
                gaps.append({'id': identity, 'reason': 'unsupported-ground'})
                continue
            routes.append((row, part, kind, points))

    # 城市车道在地面交会处继续使用道路网格，慢行桥单独登记活动表面。
    ground_routes = [(row, line) for row, line, _, _ in routes if not row['bridge']]
    strips = unary_union([line.buffer(row['widthM'] / 2) for row, line in ground_routes])
    carriageway, _ = ground_carriageway_mask(strips.buffer(15), graph)
    masks = {}
    for kind in (7, 4, GREENWAY_PAVING[1], 5, 8):
        mask = unary_union([line.buffer(row['widthM'] / 2, quad_segs=6)
                            for row, line, paving, _ in routes if not row['bridge'] and paving == kind])
        masks[kind] = mask.difference(wet).difference(carriageway).difference(unary_union(list(masks.values())))
    surface, changed, _ = _clip_terrain(surface, masks, [], replace_kinds={0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11})
    payload['terrainSurface'] = surface

    road_bridges = []
    for identity, water_id in plan['roadBridges'].items():
        water = water_rows[water_id]
        edges = [i for i, meta in enumerate(graph['metadata']) if meta['osmId'] == identity and meta['bridge']]
        portals = [{'edge': i, 'heightsM': [sample(*graph['nodes'][n * 2:n * 2 + 2])
                                           for n in graph['links'][i][:2]]} for i in edges]
        if not edges or any(None in p['heightsM'] for p in portals):
            gaps.append({'id': identity, 'reason': 'unresolved-road-bridge-portals'})
            continue
        heights = [y for p in portals for y in p['heightsM']]
        road_bridges.append({'osmId': identity, 'heightM': max(sum(heights) / len(heights), water['heightM'] + 2),
                             'girderDepthM': 0.55, 'waterIndex': water['waterIndex'], 'waterHeightM': water['heightM'],
                             'edges': edges, 'portals': portals})

    footprint = strips.union(carriageway).union(unary_union([
        line.buffer(row['widthM'] / 2) for row, line, _, _ in routes if row['bridge']
    ]))
    style = json.loads(PARK_MANIFEST.read_text())['bay']
    shore = river.boundary
    lamps, trees, shrubs = greenway_fixtures(ground_routes, shore, footprint, wet, park, sample, style)
    # 白石路桥下原有护栏保留，新增护栏从其两端之外接续。
    previous_rails = unary_union([LineString([p[::2] for p in r['stations'] if p]).buffer(4)
                                 for r in waterfront['rails'] if r['id'] in ('west-bank', 'east-bank')])
    rails = _bank_rails(strips, river, strips.union(previous_rails), carriageway, wet, sample)
    known = {w['waterIndex'] for w in waterfront['waters']}
    paths = [{'id': f'dasha:{row["osmId"]}:{i}', 'bank': row['bank'], 'points': points,
              'paths': [{**row, 'points': [list(p) for p in line.coords]}], 'lengthM': round(line.length, 2)}
             for i, (row, line, _, points) in enumerate(routes)]
    waterfront['footbridges'].extend(bridges)
    waterfront['roadBridges'].extend(road_bridges)
    waterfront['dasha'] = {'routes': paths, 'lamps': lamps, 'trees': trees, 'shrubs': shrubs, 'rails': rails,
                           'waters': [w for w in water_rows.values() if w['waterIndex'] not in known],
                           'banks': _bank_faces(water_shapes, river, sample)}
    report['dashaGreenway'] = {
        'checkedAt': plan['checkedAt'], 'sources': plan['sources'], 'osmSnapshotSha256': plan['osmSnapshotSha256'],
        'mappedLengthM': round(unary_union([line for _, line, _, _ in routes]).length, 1),
        'byBankM': {bank: round(unary_union([line for row, line, _, _ in routes if row['bank'] == bank]).length, 1)
                    for bank in ('east', 'west')},
        'paths': [{'id': row['osmId'], 'bank': row['bank'], 'mode': row['mode'], 'widthM': row['widthM'],
                   'widthSource': row['widthSource'], 'material': row['material'], 'heightSource': row['heightSource'],
                   'bridge': row['bridge'], 'lengthM': round(line.length, 1)} for row, line, _, _ in routes],
        'gaps': gaps, 'streetConnections': roads, 'bridges': [b['id'] for b in bridges],
        'roadBridges': [r['osmId'] for r in road_bridges], 'lamps': len(lamps), 'trees': len(trees),
        'changedTerrainChunks': changed,
    }
    report['terrainSurface'].update(vertices=sum(len(c['kinds']) for c in surface['chunks']),
                                    triangles=sum(len(c['indices']) // 3 for c in surface['chunks']))
