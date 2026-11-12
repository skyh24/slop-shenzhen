"""日出剧场慢行路径、深圳湾公园树点及莲花山入口路线审计。"""

import json
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from geo import project
from parks import build_park_walk
from roads import _num

PILOT = Path(__file__).resolve().parents[2] / 'data/source/streetscape-pilot.json'
PATH_TAGS = ('highway', 'foot', 'bicycle', 'access', 'segregated', 'surface', 'width',
             'incline', 'lit', 'source', 'bridge', 'tunnel', 'layer')
TREE_TAGS = ('natural', 'genus', 'species', 'height', 'diameter_crown')


def read_streetscape_sources(pbf, path_ids, park):
    ways, trees = {}, []
    area = unary_union([item['polygon'] for item in park['areas']])
    bounds = area.bounds
    reader = (osmium.FileProcessor(str(pbf), osmium.osm.WAY | osmium.osm.NODE)
              .with_filter(osmium.filter.TagFilter(('natural', 'tree'), ('highway', 'footway'), ('highway', 'cycleway'))))
    for obj in reader:
        if obj.is_way():
            identity = f'way/{obj.id}'
            if identity in path_ids:
                ways[identity] = {key: obj.tags[key] for key in PATH_TAGS if key in obj.tags}
        elif obj.tags.get('natural') == 'tree':
            x, z = project(obj.lon, obj.lat)
            if bounds[0] <= x <= bounds[2] and bounds[1] <= z <= bounds[3] and area.covers(Point(x, z)):
                trees.append({'osmId': f'node/{obj.id}', 'x': round(x, 2), 'z': round(z, 2),
                              'tags': {key: obj.tags[key] for key in TREE_TAGS if key in obj.tags}})
    return ways, trees


def compile_streetscape(pilot, park, osm_roads, path_tags, trees, report):
    pilot_areas = [area['polygon'] for area in park['areas'] if area['osmId'] == pilot['areaOsmId']]
    if not pilot_areas:
        report['streetscape'] = {'status': 'pilot-member-unresolved'}
        return None
    footprint = unary_union(pilot_areas)
    roads = {item['id']: item for item in osm_roads}
    paths = []
    excluded = []
    for candidate in pilot['paths']:
        identity = candidate['osmId']
        tags = path_tags.get(identity, {})
        way = roads.get(identity)
        if not way or tags.get('highway') != candidate['kind']:
            excluded.append({'osmId': identity, 'reason': 'source-way-unresolved'})
            continue
        if (tags.get('access') in ('no', 'private')
                or tags.get('bridge', 'no') != 'no' or tags.get('tunnel', 'no') != 'no'
                or tags.get('layer', '0') != '0'):
            excluded.append({'osmId': identity, 'reason': 'access-or-vertical-profile-unresolved'})
            continue
        coords = [project(*point) for point in way['geom'].coords]
        line = LineString(coords)
        nodes = {tuple(round(v, 2) for v in p): f'node/{ref}' for p, ref in zip(coords, way['nodeRefs'], strict=True)}
        selected = line.intersection(footprint)
        width = _num(tags.get('width'))
        segments = []
        for part in getattr(selected, 'geoms', [selected]):
            if part.geom_type != 'LineString' or part.length < 1:
                continue
            points = list(part.coords)
            if line.project(Point(points[0])) > line.project(Point(points[-1])):
                points.reverse()
            points = [tuple(round(v, 2) for v in p) for p in points]
            segments.append({'points': points, 'nodeIds': [nodes.get(p) for p in points]})
        if not segments:
            excluded.append({'osmId': identity, 'reason': 'no-path-in-pilot-member'})
            continue
        paths.append({'osmId': identity, 'kind': candidate['kind'], 'tags': tags,
                      'widthM': width or candidate['widthEstimateM'], 'widthSource': 'osm-width' if width else 'visual-estimate',
                      'heightSource': 'terrain', 'segments': segments})

    tree_sites = []
    for tree in trees:
        point = Point(tree['x'], tree['z'])
        area = next((area for area in park['areas'] if area['polygon'].covers(point)), None)
        if area:
            tree_sites.append({**tree, 'areaOsmId': area['osmId'], 'positionSource': 'osm-node',
                               'appearanceSource': 'visual-estimate'})
    result = {'version': 1, 'source': {k: pilot[k] for k in ('osmSnapshotId', 'parkId', 'parkOsmId', 'areaOsmId', 'checkedAt', 'source')},
              'arrivalWayId': pilot['arrivalWayId'], 'paths': paths, 'trees': tree_sites}
    report['streetscape'] = {'status': 'pilot-generated', 'parkOsmId': pilot['parkOsmId'], 'areaOsmId': pilot['areaOsmId'],
                             'paths': [{k: path[k] for k in ('osmId', 'kind', 'widthM', 'widthSource', 'heightSource')} for path in paths],
                             'trees': len(tree_sites), 'excludedPaths': excluded}
    return result


def build_streetscape(pbf, osm, parks, report):
    pilot = json.loads(PILOT.read_text())
    # 莲花山路线先供构建审计，台阶和桥头需要单独解出接触表面。
    report['parkWalkPilot'] = build_park_walk(pbf, osm, parks, pilot['parkWalkAudit'])
    park = next((park for park in parks if park['id'] == pilot['parkId'] and park['osmId'] == pilot['parkOsmId']), None)
    if not park:
        report['streetscape'] = {'status': 'park-source-unresolved'}
        return None
    path_ids = {item['osmId'] for item in pilot['paths']}
    path_tags, trees = read_streetscape_sources(pbf, path_ids, park)
    return compile_streetscape(pilot, park, osm['roads'], path_tags, trees, report)
