"""从同一 OSM 快照按精确成员身份提取公园及步行落点候选。"""

from collections import defaultdict

import osmium
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union

from geo import project
from land import _polys
from osm import PBF


PARK_WALK_TAGS = (
    'name', 'leisure', 'highway', 'footway', 'entrance', 'barrier', 'crossing', 'foot', 'access',
    'foot:conditional', 'access:conditional', 'motor_vehicle', 'opening_hours', 'surface',
    'width', 'incline', 'step_count', 'handrail', 'ramp:bicycle', 'bridge', 'tunnel', 'layer',
    'level', 'ele', 'source',
)


def read_park_walk_sources(pbf, pilot, roads):
    way_ids = {pilot['parkOsmId'], pilot['approachWayId'], *pilot['evidenceWayIds'],
               *(leg['osmId'] for leg in pilot['legs'])}
    route_ids = {leg['osmId'] for leg in pilot['legs']}
    node_ids = {ref for way in roads if way['id'] in route_ids for ref in way['nodeRefs']}
    ids = node_ids | {int(osm_id.split('/')[1]) for osm_id in way_ids}
    ways, nodes = {}, {}
    reader = (osmium.FileProcessor(str(pbf), osmium.osm.WAY | osmium.osm.NODE)
              .with_filter(osmium.filter.IdFilter(ids)))
    for obj in reader:
        tags = {key: obj.tags[key] for key in PARK_WALK_TAGS if key in obj.tags}
        if obj.is_way() and f'way/{obj.id}' in way_ids:
            ways[f'way/{obj.id}'] = {'version': obj.version, 'tags': tags,
                                    'nodeRefs': [node.ref for node in obj.nodes]}
        elif obj.is_node() and obj.id in node_ids and obj.location.valid():
            nodes[obj.id] = {'version': obj.version, 'tags': tags, 'lonLat': (obj.lon, obj.lat)}
    return ways, nodes


def _has_foot_restriction(tags):
    return (tags.get('foot', tags.get('access')) not in (None, 'yes', 'permissive', 'designated')
            or 'foot:conditional' in tags or 'access:conditional' in tags)


def _at_grade(tags):
    return (tags.get('layer', '0') == '0' and tags.get('level', '0') == '0'
            and tags.get('bridge', 'no') == 'no' and tags.get('tunnel', 'no') == 'no')


def compile_park_walk(pilot, park, ways, nodes):
    source = ways.get(pilot['parkOsmId'])
    if not park or not source or source['tags'].get('leisure') != 'park':
        return {'status': 'park-source-unresolved'}
    if _has_foot_restriction(source['tags']) or source['tags'].get('access') != 'yes':
        return {'status': 'park-access-unresolved'}
    area = unary_union([item['polygon'] for item in park['areas'] if item['osmId'] == pilot['parkOsmId']])
    if area.is_empty:
        return {'status': 'park-area-unresolved'}
    approach = ways.get(pilot['approachWayId'])
    start = pilot['legs'][0]['fromNode']
    if (not approach or approach['tags'].get('footway') != 'sidewalk' or start not in approach['nodeRefs']
            or _has_foot_restriction(approach['tags']) or not _at_grade(approach['tags'])
            or nodes.get(start, {}).get('tags', {}).get('highway') != 'crossing'):
        return {'status': 'sidewalk-crossing-unresolved'}
    entrance, gate = pilot['entranceNode'], pilot['gateNode']
    if (nodes.get(entrance, {}).get('tags', {}).get('entrance') != 'yes'
            or nodes.get(gate, {}).get('tags', {}).get('barrier') != 'gate'):
        return {'status': 'entrance-or-gate-unresolved'}

    legs = []
    for leg in pilot['legs']:
        way = ways.get(leg['osmId'])
        start, end = leg['fromNode'], leg['toNode']
        gap = {'status': 'route-unresolved', 'osmId': leg['osmId'], 'fromNode': start, 'toNode': end}
        if legs and start != legs[-1]['toNode']:
            return {**gap, 'reason': 'no-shared-source-node'}
        if not way or way['tags'].get('highway') != leg['highway']:
            return {**gap, 'reason': 'source-way-unresolved'}
        if _has_foot_restriction(way['tags']) or not _at_grade(way['tags']):
            return {**gap, 'reason': 'access-or-layer-unresolved'}
        refs = way['nodeRefs']
        if start == end or refs.count(start) != 1 or refs.count(end) != 1:
            return {**gap, 'reason': 'source-endpoints-unresolved'}
        i, j = refs.index(start), refs.index(end)
        refs = refs[i:j + 1] if i < j else list(reversed(refs[j:i + 1]))
        if not legs and (entrance not in refs[:-1] or end != gate):
            return {**gap, 'reason': 'entrance-and-gate-not-on-approach'}
        if any(ref not in nodes for ref in refs):
            return {**gap, 'reason': 'source-node-unresolved'}
        if any(_has_foot_restriction(nodes[ref]['tags']) or not _at_grade(nodes[ref]['tags'])
               or ('barrier' in nodes[ref]['tags'] and ref != gate) for ref in refs):
            return {**gap, 'reason': 'node-access-or-layer-unresolved'}
        points = [project(*nodes[ref]['lonLat']) for ref in refs]
        line = LineString(points)
        if line.length == 0 or (legs and not area.covers(line)):
            return {**gap, 'reason': 'route-outside-park-or-empty'}
        foot_access_source = next((f'osm-{key}' for key in ('foot', 'access') if key in way['tags']), 'unknown')
        legs.append({**leg, 'wayVersion': way['version'], 'wayForward': i < j, 'tags': way['tags'],
                     'footAccessSource': foot_access_source,
                     'lengthM': round(line.length, 2), 'outsideParkM': round(line.difference(area).length, 2),
                     'nodes': [{'osmId': f'node/{ref}', **nodes[ref],
                                'xzM': [round(v, 2) for v in point]} for ref, point in zip(refs, points)],
                     'verticalProfileSource': 'unknown'})

    return {'status': 'source-route-connected', 'parkVersion': source['version'], 'parkTags': source['tags'],
            'approach': {'wayVersion': approach['version'], 'tags': approach['tags'],
                         'sharedNode': legs[0]['nodes'][0]['osmId']},
            'lengthM': round(sum(leg['lengthM'] for leg in legs), 2), 'legs': legs,
            'evidenceOnly': {osm_id: ways.get(osm_id) for osm_id in pilot['evidenceWayIds']}}


def build_park_walk(pbf, osm, parks, pilot):
    if osm.get('sourceSha256') != pilot['osmSnapshotSha256']:
        return {**pilot, 'status': 'snapshot-mismatch'}
    park = next((park for park in parks if park['osmId'] == pilot['parkOsmId']), None)
    ways, nodes = read_park_walk_sources(pbf, pilot, osm['roads'])
    return {**pilot, **compile_park_walk(pilot, park, ways, nodes)}


def read_park_site_members(source_ids, pbf=PBF):
    wanted = {int(source_id.split('/')[1]): source_id for source_id in source_ids
              if source_id.startswith('relation/')}
    members = {}
    if not wanted:
        return members
    for relation in osmium.FileProcessor(str(pbf), osmium.osm.RELATION):
        source_id = wanted.pop(relation.id, None)
        if source_id is None:
            continue
        if relation.tags.get('type') == 'site' and relation.tags.get('leisure') == 'park':
            kinds = {'w': 'way', 'r': 'relation'}
            members[source_id] = sorted({f'{kinds[m.type]}/{m.ref}'
                                         for m in relation.members if m.type in kinds})
        if not wanted:
            break
    return members


def compile_parks(landmarks, green, land, water, site_members):
    by_id = defaultdict(list)
    for item in green:
        by_id[item['id']].append(item)
    dry = unary_union(land).difference(unary_union([item['poly'] for item in water]))
    parks = []
    for landmark in landmarks:
        source_id = landmark.get('osm', {}).get('park')
        if landmark['phase'] != 1 or not source_id:
            continue
        lat, lon = landmark['center']
        anchor = Point(*project(lon, lat))
        areas = []
        for member_id in site_members.get(source_id, [source_id]):
            for item in by_id.get(member_id, []):
                polygon = item['poly']
                # 给步行脚印和分米量化保留边缘余量，运行时还须按实际渲染地形复核。
                interior = polygon.intersection(dry).buffer(-1.5)
                points = set()
                for part in _polys(interior):
                    for point in (nearest_points(part, anchor)[0], part.representative_point()):
                        points.add((round(point.x, 1), round(point.y, 1)))
                areas.append({'osmId': member_id, 'name': item['name'],
                              'polygon': polygon, 'arrivals': sorted(points)})
        if areas:
            parks.append({'id': landmark['id'], 'osmId': source_id,
                          'source': f'https://www.openstreetmap.org/{source_id}', 'areas': areas})
    return parks


def build_parks(landmarks, green, land, water, report):
    sources = {landmark['osm']['park'] for landmark in landmarks
               if landmark['phase'] == 1 and landmark.get('osm', {}).get('park')}
    parks = compile_parks(landmarks, green, land, water, read_park_site_members(sources))
    report['parks'] = {
        'parks': [{'id': park['id'], 'osmId': park['osmId'], 'areas': len(park['areas']),
                   'arrivalSamples': sum(len(area['arrivals']) for area in park['areas'])}
                  for park in parks],
        'unresolvedSourceIds': sorted(sources - {park['osmId'] for park in parks}),
    }
    return parks
