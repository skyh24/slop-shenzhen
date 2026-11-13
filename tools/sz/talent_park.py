"""锁定内湖与公开园路对象，编译南岸样段；附属铺装和设施只作模拟。"""

import json
import math
from pathlib import Path

from shapely import constrained_delaunay_triangles, make_valid
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring, unary_union

from geo import project_coords
from package_validation import ring_points
from road_frontage import (_asphalt_mask, _buffer, _encode_surface, _graph_lines, _ground,
                           _junction_design, _junction_walk_surfaces, _read_tags)
from shenzhen_bay import _surface_sampler

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/talent-park-waterfront.json'
SLIP_SITE = 'talent-park-southeast'


def _rounded(coords):
    return [[round(x, 3), round(z, 3)] for x, z in coords]


def _polygon(rings):
    return make_valid(Polygon(ring_points(rings[0]), [ring_points(ring) for ring in rings[1:]]))


def _source_segment(way, start, end):
    ids = way['nodeRefs']
    a, b = ids.index(start), ids.index(end)
    step = 1 if a < b else -1
    order = range(a, b + step, step)
    return [way['geom'].coords[i] for i in order], [ids[i] for i in order]


def _bridge_profile(row, lake, sample, water_y):
    line = LineString(row['points'])
    width = row['widthM']
    depth, clearance, slope = 0.32, 0.42, 0.055
    if line.intersection(lake).length < 3 or any(Point(p).distance(lake) < width / 2 + 1
                                                for p in (line.coords[0], line.coords[-1])):
        raise ValueError(f'Bridge does not join two dry portals: {row["osmId"]}')
    stations = [0.]
    for a, b in zip(line.coords, list(line.coords)[1:]):
        run = math.dist(a, b)
        start = stations[-1]
        count = math.ceil(run / 1.5)
        stations.extend(start + run * i / count for i in range(1, count + 1))
    floors = []
    for d in stations:
        p = line.interpolate(d)
        a, b = line.interpolate(d - min(d, 0.15)), line.interpolate(min(line.length, d + 0.15))
        dx, dz = (b.x - a.x) / a.distance(b), (b.y - a.y) / a.distance(b)
        edge_samples = []
        for offset in (-width / 2, 0, width / 2):
            x, z = p.x + dz * offset, p.y - dx * offset
            if lake.covers(Point(x, z)):
                edge_samples.append(water_y + depth + clearance)
            elif (y := sample(x, z)) is not None:
                edge_samples.append(y + 0.035)
        floors.append(max(edge_samples))
    portals = [sample(*line.coords[0]), sample(*line.coords[-1])]
    if any(y is None for y in portals):
        raise ValueError(f'Missing bridge portal support: {row["osmId"]}')
    # 纵坡上限约束桥底净空和陆侧地面，接地断面保留实际横坡。
    heights = [max(y - slope * abs(d - other) for y, other in zip(floors, stations, strict=True))
               for d in stations]
    if max(abs(heights[i] - portals[j]) for j, i in enumerate((0, -1))) > 0.25:
        raise ValueError(f'Bridge profile requires a longer approach: {row["osmId"]}')
    points = []
    for d, y in zip(stations, heights, strict=True):
        p = line.interpolate(d)
        points.append([round(p.x, 5), round(y, 5), round(p.y, 5)])
    return {'id': row['osmId'], 'widthM': width, 'points': points, 'mode': 'walk',
            'girderDepthM': depth, 'waterHeightM': water_y, 'profile': 'park-footbridge-estimate'}


def _compile_slip_crossings(payload, plan, osm_ways, pbf, report):
    # 过街锚点必须同时属于源步道与转向车道，且源节点标绘斑马线。
    reviews = plan['slipCrossings']
    _, nodes = _read_tags(pbf, set(), {r['node'] for r in reviews})
    for row in reviews:
        anchor = row['node']
        if (nodes[anchor][1].get('crossing') != 'uncontrolled'
                or nodes[anchor][1].get('crossing:markings') != 'zebra'
                or any(anchor not in osm_ways[row[k]]['nodeRefs'] for k in ('osmId', 'road'))):
            raise ValueError(f'Unresolved Talent Park slip crossing: {anchor}')
    crossing_ids = [row['osmId'] for row in reviews]
    sidewalk_ids = [row['osmId'] for row in plan['crossingApproaches']]
    route_ids = crossing_ids + sidewalk_ids
    if any(osm_ways[i]['tags'].get('highway') != 'footway'
           or osm_ways[i]['tags'].get('access') in ('private', 'no')
           or osm_ways[i]['tags'].get('bridge', 'no') != 'no'
           or osm_ways[i]['tags'].get('tunnel', 'no') != 'no'
           or osm_ways[i]['tags'].get('layer', '0') != '0' for i in route_ids):
        raise ValueError('Unresolved Talent Park crossing approaches')
    # 截到与已核过街相接的短段，避免把同一来源的远端整段改成新路侧面。
    selected = {i: osm_ways[i] for i in route_ids}
    for row in plan['crossingApproaches']:
        identity = row['osmId']
        points, _ = _source_segment(osm_ways[identity], row['from'], row['to'])
        selected[identity] = {**selected[identity], 'geom': LineString(points)}
    axes = {i: LineString(project_coords(selected[i]['geom'].coords)) for i in route_ids}
    clip = box(*unary_union(list(axes.values())).buffer(6).bounds)
    links = list(_graph_lines(payload['roadGraph'], clip.buffer(20)))
    ground = [link for link in links if _ground(link['meta'])]
    asphalt = _asphalt_mask(links, clip.buffer(20))
    building_mask = unary_union([shape for rings, base in zip(payload['buildings']['rings'],
                                payload['buildings']['minH'], strict=True)
                                if base < 0.3 and clip.intersects(shape := _polygon(rings))])
    style = {'sidewalkWidthM': 3.4, 'crossingWidthM': 3.2, 'sidewalkRiseM': 0.10}
    spec = {'id': SLIP_SITE, 'sidewalks': sidewalk_ids, 'crossings': crossing_ids,
            'junctionDesign': {'slipWays': [row['road'] for row in reviews], 'signalizedCrossings': []}}
    legs, zebra, _, waiting = _junction_design(spec, selected, ground, asphalt, building_mask, clip, None, style)
    if sorted(leg['osmId'] for leg in legs if leg['crossing']) != sorted(crossing_ids):
        raise ValueError('Talent Park slip crossings lack an at-grade span')
    for row in reviews:
        line = axes[row['osmId']]
        wet = line.intersection(asphalt)
        road = min(ground, key=lambda link: link['line'].distance(nodes[row['node']][0]))
        if (road['meta']['osmId'] != row['road'] or not 2.5 < wet.length < 9
                or wet.distance(nodes[row['node']][0]) > 0.05
                or min(Point(p).distance(asphalt) for p in (line.coords[0], line.coords[-1])) < 1.5):
            raise ValueError(f'Missing safe slip crossing landing: {row["osmId"]}')
    paving = [(i, axes[i].buffer(style['sidewalkWidthM'] / 2, quad_segs=4)) for i in route_ids]
    crossings = [(i, _buffer(axes[i].intersection(asphalt), style['crossingWidthM'])) for i in crossing_ids]
    features = list(_junction_walk_surfaces(SLIP_SITE, paving, crossings, clip, building_mask, waiting, style))
    features.append({'id': f'{SLIP_SITE}:paint', **_encode_surface('paint', crossing_ids, zebra)})
    frontage = payload['roadFrontage']
    corridor = {'id': SLIP_SITE, 'bounds': list(clip.bounds), 'roadIds': [], 'sidewalkIds': sidewalk_ids,
                'crossingIds': crossing_ids, 'walkLegs': legs, 'unresolvedVerticalWays': []}
    frontage['corridors'] = [c for c in frontage['corridors'] if c['id'] != SLIP_SITE] + [corridor]
    frontage['features'] = [f for f in frontage['features'] if not f['id'].startswith(SLIP_SITE + ':')] + features
    audit = report['roadFrontage']
    audit.update(corridors=frontage['corridors'], features=len(frontage['features']),
                 planarTriangles=sum(len(f['trianglesXZ']) // 6 for f in frontage['features']))


def _load_plan(osm, osm_source):
    plan = json.loads(SOURCE.read_text())
    if plan['osmSnapshotSha256'] != osm_source['sha256'] or osm['sourceSha256'] != osm_source['sha256']:
        raise ValueError('Talent Park requires the reviewed OSM snapshot')
    return plan


def compile_talent_crossings(payload, osm, osm_source, report, plan=None):
    if plan is None:
        plan = _load_plan(osm, osm_source)
    root = SOURCE.parents[2]
    _compile_slip_crossings(payload, plan, {r['id']: r for r in osm['roads']}, root / osm_source['file'], report)


def compile_talent_park(payload, osm, osm_source, report):
    plan = _load_plan(osm, osm_source)
    if not any(p['id'] == 'talent-park' and p['osmId'] == plan['parkOsmId'] for p in payload['parks']):
        raise ValueError('Talent Park membership unresolved')
    lake_source = next(row for row in osm['water'] if row['id'] == plan['lakeOsmId'])
    seed = lake_source['geom'].representative_point()
    lake_marker = Point(*project_coords([seed.coords[0]])[0])
    lake_index, lake = next((i, _polygon(rings)) for i, rings in enumerate(payload['water'])
                            if _polygon(rings).covers(lake_marker))
    if lake.geom_type != 'Polygon' or not 300_000 < lake.area < 370_000:
        raise ValueError('Unexpected Talent Park lake geometry')

    wanted = {row['osmId'] for row in [*plan['route'], *plan['entrances'],
                                     *(p for r in plan['bridgeRoutes'] for p in r['paths'])]}
    ways = {row['id']: row for row in osm['roads'] if row['id'] in wanted}
    def route(row):
        way = ways[row['osmId']]
        tags = way['tags']
        if (tags.get('highway') != ('steps' if row['kind'] == 'steps' else 'footway')
                or tags.get('access') in ('private', 'no') or tags.get('foot') in ('private', 'no')
                or tags.get('tunnel', 'no') != 'no'
                or (tags.get('bridge', 'no'), tags.get('layer', '0')) != (
                    ('yes', '1') if row['kind'] == 'bridge' else ('no', '0'))):
            raise ValueError(f'Talent Park route no longer has the reviewed access or level: {row["osmId"]}')
        coords, ids = _source_segment(way, row['from'], row['to'])
        return {**row, 'points': _rounded(project_coords(coords)), 'nodeIds': ids}

    main = [route(row) for row in plan['route']]
    entrances = [route(row) for row in plan['entrances']]
    if any(a['nodeIds'][-1] != b['nodeIds'][0] for a, b in zip(main, main[1:])):
        raise ValueError('Disconnected Talent Park route')
    points = {i: p for row in main for i, p in zip(row['nodeIds'], row['points'], strict=True)}
    view = points[plan['viewNode']]
    length = sum(LineString(row['points']).length for row in main + [entrances[0]])
    if not 300 <= length <= 500:
        raise ValueError('Talent Park pilot is outside the requested length')
    bridge_routes = [{'id': r['id'], 'paths': [route(p) for p in r['paths']]} for r in plan['bridgeRoutes']]
    for r in bridge_routes:
        paths = r['paths']
        if (any(a['to'] != b['from'] for a, b in zip(paths, paths[1:]))
                or any(n not in points for n in (paths[0]['from'], paths[-1]['to']))):
            raise ValueError(f'Unconnected Talent Park bridge route: {r["id"]}')
    bridge_rows = [p for r in bridge_routes for p in r['paths'] if p['kind'] == 'bridge']
    land_rows = main + entrances + [p for r in bridge_routes for p in r['paths'] if p['kind'] != 'bridge']
    for row in land_rows:
        if LineString(row['points']).intersects(lake):
            raise ValueError(f'Talent Park walk crosses water: {row["osmId"]}')
    extent = unary_union([LineString(r['points']) for r in land_rows + bridge_rows]).buffer(10)
    sample = _surface_sampler(payload['terrainSurface'], extent)
    footbridges = [{**_bridge_profile(r, lake, sample, plan['simulation']['lakeHeightM']),
                    'waterIndex': lake_index} for r in bridge_rows]

    # 先建立公共面，再裁掉真实内湖。材质之间取差集，避免重复绘制或接触面叠层。
    lake_keepout = lake.buffer(0.32)
    view_pad = Point(view).buffer(5.6, quad_segs=5).difference(lake_keepout)
    areas = {'gravel': view_pad}
    for row in land_rows:
        if row['kind'] == 'steps':
            continue
        line = LineString(row['points'])
        strip = line.buffer(row['widthM'] / 2, quad_segs=4).difference(lake_keepout)
        areas[row['kind']] = areas.get(row['kind'], Polygon()).union(strip)
    covered = Polygon()
    surfaces = []
    for material, shape in areas.items():
        usable = shape.difference(covered)
        covered = covered.union(shape)
        triangles = [round(v, 5) for tri in constrained_delaunay_triangles(usable).geoms
                     for coord in list(tri.exterior.coords)[:3] for v in coord]
        if triangles:
            surfaces.append({'material': material, 'trianglesXZ': triangles})

    # 只在样段中接近内湖的岸壁加边界；沿包中同一水陆边线向陆地偏置，桥头留开口。
    shoreline = LineString(lake.exterior.coords)
    land_edge = LineString(lake.buffer(plan['simulation']['edgeSetbackM'], join_style='mitre').exterior.coords)
    projected = [shoreline.interpolate(shoreline.project(Point(points[node]))) for node in plan['retainingEdgeNodes']]
    along = sorted(land_edge.project(p) for p in projected)
    border = substring(land_edge, *along)
    if not 25 < border.length < 125 or not border.disjoint(lake):
        raise ValueError('Unexpected Talent Park shore edge')
    center = plan['simulation']['airspaceCenter']
    if not lake.contains(Point(center['x'], center['z']).buffer(110)):
        raise ValueError('Talent Park airspace center lacks water clearance')

    result = {'version': 1, 'parkOsmId': plan['parkOsmId'], 'lakeOsmId': plan['lakeOsmId'],
              'lakeWaterIndex': lake_index, 'route': main, 'entrances': entrances, 'view': view,
              'viewNode': plan['viewNode'], 'lengthM': round(length, 2), 'surfaces': surfaces,
              'retainingEdge': _rounded(border.coords), 'simulation': plan['simulation'],
              'footbridges': footbridges, 'bridgeRoutes': bridge_routes}
    payload['talentPark'] = result
    compile_talent_crossings(payload, osm, osm_source, report, plan)
    report['talentPark'] = {'status': 'pilot-generated', 'parkOsmId': plan['parkOsmId'],
                            'lakeOsmId': plan['lakeOsmId'], 'lakeAreaM2': round(lake.area, 2),
                            'route': [row['osmId'] for row in main + entrances], 'lengthM': result['lengthM'],
                            'viewNode': result['viewNode'], 'viewXZ': view, 'borderLengthM': round(border.length, 2),
                            'materialSources': {'greenway': 'public-running-track; width-estimate',
                                                'promenade': 'source-footway; simulated-paving',
                                                'gravel': 'simulated-landscape'},
                            'bridges': [{'osmId': r['id'], 'heightSource': r['profile']} for r in footbridges],
                            'bridgeApproachUnresolved': plan['unresolvedBridges'],
                            'slipCrossings': plan['slipCrossings'],
                            'terrainAndBuildingsChanged': False}
    return result
