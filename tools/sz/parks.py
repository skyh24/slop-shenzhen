"""从同一 OSM 快照按精确成员身份提取公园及步行落点候选。"""

from collections import defaultdict

import osmium
from shapely.geometry import Point
from shapely.ops import nearest_points, unary_union

from geo import project
from land import _polys
from osm import PBF


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
