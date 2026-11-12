"""锁定内湖与公开园路对象，编译南岸样段；附属铺装和设施只作模拟。"""

import json
from pathlib import Path

from shapely import constrained_delaunay_triangles, make_valid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import substring, unary_union

from geo import project_coords
from package_validation import ring_points

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/talent-park-waterfront.json'


def _rounded(coords):
    return [[round(x, 3), round(z, 3)] for x, z in coords]


def _polygon(rings):
    return make_valid(Polygon(ring_points(rings[0]), [ring_points(ring) for ring in rings[1:]]))


def compile_talent_park(payload, osm, osm_source, report):
    plan = json.loads(SOURCE.read_text())
    if plan['osmSnapshotSha256'] != osm_source['sha256'] or osm['sourceSha256'] != osm_source['sha256']:
        raise ValueError('Talent Park requires the reviewed OSM snapshot')
    if not any(p['id'] == 'talent-park' and p['osmId'] == plan['parkOsmId'] for p in payload['parks']):
        raise ValueError('Talent Park membership unresolved')
    lake_source = next(row for row in osm['water'] if row['id'] == plan['lakeOsmId'])
    seed = lake_source['geom'].representative_point()
    lake_marker = Point(*project_coords([seed.coords[0]])[0])
    lake_index, lake = next((i, _polygon(rings)) for i, rings in enumerate(payload['water'])
                            if _polygon(rings).covers(lake_marker))
    if lake.geom_type != 'Polygon' or not 300_000 < lake.area < 370_000:
        raise ValueError('Unexpected Talent Park lake geometry')

    wanted = {row['osmId'] for row in [*plan['route'], *plan['entrances']]}
    ways = {row['id']: row for row in osm['roads'] if row['id'] in wanted}
    def route(row):
        way = ways[row['osmId']]
        tags = way['tags']
        if (tags.get('highway') != ('steps' if row['kind'] == 'steps' else 'footway')
                or tags.get('access') in ('private', 'no') or tags.get('bridge', 'no') != 'no'
                or tags.get('layer', '0') != '0'):
            raise ValueError(f'Talent Park route no longer has the reviewed access or level: {row["osmId"]}')
        ids = way['nodeRefs']
        a, b = ids.index(row['from']), ids.index(row['to'])
        order = range(a, b + (1 if a < b else -1), 1 if a < b else -1)
        return {**row, 'points': _rounded(project_coords([way['geom'].coords[i] for i in order])),
                'nodeIds': [ids[i] for i in order]}

    main = [route(row) for row in plan['route']]
    entrances = [route(row) for row in plan['entrances']]
    if any(a['nodeIds'][-1] != b['nodeIds'][0] for a, b in zip(main, main[1:])):
        raise ValueError('Disconnected Talent Park route')
    points = {i: p for row in main for i, p in zip(row['nodeIds'], row['points'], strict=True)}
    view = points[plan['viewNode']]
    length = sum(LineString(row['points']).length for row in main + [entrances[0]])
    if not 300 <= length <= 500:
        raise ValueError('Talent Park pilot is outside the requested length')
    for row in main + entrances:
        if LineString(row['points']).intersects(lake):
            raise ValueError(f'Talent Park walk crosses water: {row["osmId"]}')

    # 先建立公共面，再裁掉真实内湖。材质之间取差集，避免重复绘制或接触面叠层。
    lake_keepout = lake.buffer(0.32)
    view_pad = Point(view).buffer(5.6, quad_segs=5).difference(lake_keepout)
    areas = {'gravel': view_pad}
    for row in main + entrances:
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
              'retainingEdge': _rounded(border.coords), 'simulation': plan['simulation']}
    payload['talentPark'] = result
    report['talentPark'] = {'status': 'pilot-generated', 'parkOsmId': plan['parkOsmId'],
                            'lakeOsmId': plan['lakeOsmId'], 'lakeAreaM2': round(lake.area, 2),
                            'route': [row['osmId'] for row in main + entrances], 'lengthM': result['lengthM'],
                            'viewNode': result['viewNode'], 'viewXZ': view, 'borderLengthM': round(border.length, 2),
                            'materialSources': {'greenway': 'public-running-track; width-estimate',
                                                'promenade': 'source-footway; simulated-paving',
                                                'gravel': 'simulated-landscape'},
                            'bridgeApproachUnresolved': plan['bridgeApproachOsmIds'],
                            'terrainAndBuildingsChanged': False}
    return result
