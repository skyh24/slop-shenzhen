"""从锁定 OSM 快照生成深圳地铁；成员身份是关联依据，不按最近车站硬配。"""

import hashlib
import json
import pickle
import re
from collections import defaultdict
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point, Polygon

from geo import project

ROOT = Path(__file__).resolve().parents[2]
PBF = ROOT / 'data/raw/guangdong-latest.osm.pbf'
CACHE = ROOT / 'data/raw/cache/metro-network.pkl'
CACHE_VERSION = 1
NETWORK = '深圳地铁'
KIND = {'n': 'node', 'w': 'way', 'r': 'relation'}


def _identity(kind, ref):
    return f'{KIND[kind]}/{ref}'


def _refs(value):
    return sorted({part.strip() for part in (value or '').split(';') if part.strip()}, key=_line_sort)


def _line_sort(value):
    match = re.match(r'^(\d+)(.*)$', value)
    return (int(match[1]), match[2]) if match else (9999, value)


def _is_route(tags):
    # 同时存在 route=subway 的 network 容器不是一个行车方向。
    return tags.get('type') == 'route' and tags.get('route') == 'subway' and tags.get('network') == NETWORK


def _is_station(tags):
    return tags.get('railway') == 'station' and tags.get('station') == 'subway'


def _is_entrance(tags):
    return tags.get('railway') == 'subway_entrance'


def _snapshot(pbf, source_manifest):
    data = json.loads(Path(source_manifest).read_text())
    source = next(s for s in data['sources'] if s['id'] == 'osm-guangdong')
    digest = hashlib.sha256(Path(pbf).read_bytes()).hexdigest()
    if source['sha256'] != digest:
        raise ValueError('Metro OSM snapshot hash mismatch')
    return {'sourceId': source['id'], 'sha256': digest, 'bytes': Path(pbf).stat().st_size,
            'snapshotAt': source.get('lastModified'), 'url': source.get('resolved', source['url'])}


def read_metro(pbf=PBF, use_cache=True, cache=CACHE, source_manifest=ROOT / 'data/source/sources.json'):
    source = _snapshot(pbf, source_manifest)
    cache = Path(cache)
    if use_cache and cache.exists():
        with cache.open('rb') as stream:
            result = pickle.load(stream)
        if result.get('cacheVersion') == CACHE_VERSION and result.get('source') == source:
            return result
    relations = {}
    for item in osmium.FileProcessor(str(pbf)).with_filter(osmium.filter.EntityFilter(osmium.osm.RELATION)):
        tags = dict(item.tags)
        if not (tags.get('route') == 'subway' or tags.get('route_master') == 'subway'
                or tags.get('public_transport') in ('stop_area', 'stop_area_group')):
            continue
        relations[f'relation/{item.id}'] = {'id': f'relation/{item.id}', 'tags': tags,
                                           'members': [(_identity(m.type, m.ref), m.role) for m in item.members]}
    routes = [r for r in relations.values() if _is_route(r['tags'])]
    referenced = {member for route in routes for member, _ in route['members']}
    nodes, ways = {}, {}
    for item in (osmium.FileProcessor(str(pbf))
                 .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE))
                 .with_filter(osmium.filter.KeyFilter('railway', 'public_transport'))):
        tags = dict(item.tags)
        identity = f'node/{item.id}'
        if identity not in referenced and not (_is_station(tags) or _is_entrance(tags)):
            continue
        if not item.location.valid():
            continue
        nodes[identity] = {'id': identity, 'tags': tags, 'point': [item.location.lon, item.location.lat]}
    for item in (osmium.FileProcessor(str(pbf)).with_locations()
                 .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
                 .with_filter(osmium.filter.KeyFilter('railway', 'public_transport'))):
        tags = dict(item.tags)
        identity = f'way/{item.id}'
        if identity not in referenced and not (_is_station(tags) or _is_entrance(tags)):
            continue
        try:
            coords = [(node.lon, node.lat) for node in item.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(coords) < 2:
            continue
        ways[identity] = {'id': identity, 'tags': tags, 'coords': coords}
        if _is_station(tags) or _is_entrance(tags):
            geometry = Polygon(coords) if len(coords) >= 4 and coords[0] == coords[-1] else LineString(coords)
            point = geometry.representative_point()
            ways[identity]['point'] = [point.x, point.y]
            ways[identity]['positionSource'] = 'osm-geometry-representative-point'
    result = {'cacheVersion': CACHE_VERSION, 'source': source,
              'relations': relations, 'nodes': nodes, 'ways': ways}
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix('.tmp')
    with temporary.open('wb') as stream:
        pickle.dump(result, stream)
    temporary.replace(cache)
    return result


def compile_metro(raw, clip, report):
    relations, nodes, ways = raw['relations'], raw['nodes'], raw['ways']
    entities = {**nodes, **ways}
    routes = {key: relation for key, relation in relations.items() if _is_route(relation['tags'])}
    served = defaultdict(set)
    route_lines, line_routes = {}, defaultdict(set)
    missing_ref = []
    for identity, route in routes.items():
        refs = _refs(route['tags'].get('ref'))
        if not refs:
            missing_ref.append(identity)
        route_lines[identity] = refs
        for ref in refs:
            line_routes[ref].add(identity)
        for member, role in route['members']:
            if role.startswith('stop') or role.startswith('platform'):
                served[member].add(identity)
    # stop_area 中的 route 成员先证明网络归属，stop_area_group 只沿显式成员关系扩展。
    areas = {identity: rel for identity, rel in relations.items()
             if rel['tags'].get('public_transport') == 'stop_area'
             and rel['tags'].get('network', NETWORK) == NETWORK}
    area_routes = {identity: set().union(*(served[member] for member, _ in rel['members']))
                   for identity, rel in areas.items()}
    groups = {identity: rel for identity, rel in relations.items()
              if rel['tags'].get('public_transport') == 'stop_area_group'
              and rel['tags'].get('network', NETWORK) == NETWORK}
    group_routes = {}
    for identity, group in groups.items():
        associated = set().union(*(area_routes.get(member, set()) for member, _ in group['members']))
        if associated:
            group_routes[identity] = associated
    entity_routes, entity_areas, area_stations = defaultdict(set), defaultdict(set), {}
    for identity, associated in area_routes.items():
        if not associated:
            continue
        members = areas[identity]['members']
        area_stations[identity] = {member for member, _ in members
                                   if member in entities and _is_station(entities[member]['tags'])
                                   and entities[member]['tags'].get('network', NETWORK) == NETWORK}
        for member, _ in members:
            entity_routes[member].update(associated)
            entity_areas[member].add(identity)
    # 车公庙等换乘站以共同 station 节点合并线路，出口保留原始 stop_area 证据。
    station_routes = {identity: set(associated) for identity, associated in entity_routes.items()
                      if identity in entities and _is_station(entities[identity]['tags'])}
    group_stations = {}
    for identity in group_routes:
        group_stations[identity] = set().union(*(area_stations.get(member, set())
                                                 for member, _ in groups[identity]['members']))
    station_ids_for_entity = defaultdict(set)
    for identity, associated in area_routes.items():
        if associated:
            for member, _ in areas[identity]['members']:
                station_ids_for_entity[member].update(area_stations[identity])
    for identity, associated in group_routes.items():
        for station in group_stations[identity]:
            station_routes.setdefault(station, set()).update(associated)
            entity_areas[station].add(identity)
        for member, _ in groups[identity]['members']:
            if member in entities:
                entity_routes[member].update(associated)
                entity_areas[member].add(identity)
                station_ids_for_entity[member].update(group_stations[identity])

    def line_refs(route_ids):
        return sorted({ref for route in route_ids for ref in route_lines[route]}, key=_line_sort)

    def marker(entity, route_ids):
        lon, lat = entity['point']
        x, z = project(lon, lat)
        tags = entity['tags']
        return {'id': entity['id'], 'entityType': 'station' if _is_station(tags) else 'entrance', 'name': tags.get('name', tags.get('name:zh', '')),
                'nameEn': tags.get('name:en', ''), 'ref': tags.get('ref'),
                'x': round(x, 2), 'z': round(z, 2), 'lon': lon, 'lat': lat,
                'lineRefs': line_refs(route_ids), 'routeIds': sorted(route_ids),
                'source': f'https://www.openstreetmap.org/{entity["id"]}',
                'positionSource': entity.get('positionSource', 'osm-node'),
                'association': {'method': 'stop-area-route-membership' if route_ids else 'explicit-network-tag',
                                'relationIds': sorted(entity_areas[entity['id']])}}

    stations, entrances, unassociated = [], [], []
    for identity, entity in sorted(entities.items()):
        tags = entity['tags']
        if not (_is_station(tags) or _is_entrance(tags)) or 'point' not in entity:
            continue
        if not clip.covers(Point(project(*entity['point']))):
            continue
        if tags.get('network', NETWORK) != NETWORK:
            continue
        associated = station_routes.get(identity, entity_routes[identity]) if _is_station(tags) else entity_routes[identity]
        if not associated and tags.get('network') != NETWORK:
            candidate = marker(entity, set())
            candidate['association'] = {'method': 'unresolved-network', 'relationIds': []}
            unassociated.append(candidate)
            continue
        entry = marker(entity, associated)
        if _is_station(tags):
            stations.append(entry)
        else:
            station_ids = sorted(station_ids_for_entity[identity])
            entry['stationIds'] = station_ids
            entry['stationNames'] = sorted({entities[s]['tags'].get('name', '') for s in station_ids})
            # 同一站节点表示共享站厅，所有该站线路可从此入口进入；不推断独立站点间换乘。
            entry['lineRefs'] = line_refs(set(associated).union(*(station_routes.get(s, set()) for s in station_ids)))
            entrances.append(entry)

    segments, segment_routes, route_segments, excluded_members = {}, defaultdict(set), defaultdict(list), []
    for identity, route in routes.items():
        for member, role in route['members']:
            if not member.startswith('way/') or role.startswith(('stop', 'platform')):
                continue
            way = ways.get(member)
            if not way or way['tags'].get('railway') != 'subway':
                excluded_members.append({'routeId': identity, 'memberId': member, 'reason': 'missing-or-non-subway-track'})
                continue
            line = LineString([project(*point) for point in way['coords']]).intersection(clip)
            for index, part in enumerate(getattr(line, 'geoms', [line])):
                if part.geom_type != 'LineString' or part.length <= 0:
                    continue
                segment_id = f'{member}/{index}'
                if segment_id not in segments:
                    tags = way['tags']
                    segments[segment_id] = {'id': segment_id, 'osmId': member,
                        'points': [round(v, 2) for point in part.coords for v in point],
                        'bridge': tags.get('bridge'), 'tunnel': tags.get('tunnel'),
                        'layer': tags.get('layer'), 'level': tags.get('level'),
                        'elevationSource': 'unresolved', 'source': f'https://www.openstreetmap.org/{member}'}
                segment_routes[segment_id].add(identity)
                route_segments[identity].append({'id': segment_id, 'role': role})
    for identity, segment in segments.items():
        segment['routeIds'] = sorted(segment_routes[identity])
        segment['lineRefs'] = line_refs(segment_routes[identity])
    route_output = []
    for identity, route in routes.items():
        tags = route['tags']
        route_output.append({'id': identity, 'name': tags.get('name', ''), 'ref': tags.get('ref'),
                             'lineRefs': route_lines[identity], 'from': tags.get('from'), 'to': tags.get('to'),
                             'service': tags.get('service'), 'openingHours': tags.get('opening_hours'),
                             'segments': route_segments[identity],
                             'source': f'https://www.openstreetmap.org/{identity}'})
    lines, colour_conflicts = [], []
    masters = [rel for rel in relations.values() if rel['tags'].get('route_master') == 'subway'
               and rel['tags'].get('network') == NETWORK]
    for ref in sorted(line_routes, key=_line_sort):
        relevant = [routes[r] for r in sorted(line_routes[ref])]
        master = next((rel for rel in masters if _refs(rel['tags'].get('ref')) == [ref]), None)
        colours = {rel['tags']['colour'].upper() for rel in relevant if re.fullmatch(r'#[0-9a-fA-F]{6}', rel['tags'].get('colour', ''))}
        if len(colours) != 1:
            colour_conflicts.append({'lineRef': ref, 'colours': sorted(colours)})
        line_segments = sorted(sid for sid, segment in segments.items() if ref in segment['lineRefs'])
        line_stations = sorted(station['id'] for station in stations if ref in station['lineRefs'])
        source_rel = master or relevant[0]
        lines.append({'id': ref, 'ref': ref, 'name': source_rel['tags'].get('name', ''),
                      'nameEn': source_rel['tags'].get('name:en', ''),
                      'colour': next(iter(colours)) if len(colours) == 1 else None,
                      'colourSource': 'osm-route-colour', 'routeIds': sorted(line_routes[ref]),
                      'segmentIds': line_segments, 'stationIds': line_stations,
                      'hasCoverage': bool(line_segments or line_stations),
                      'source': f'https://www.openstreetmap.org/{source_rel["id"]}'})
    station_ids = {station['id'] for station in stations}
    orphan_station_refs = sorted({s for entry in entrances for s in entry['stationIds'] if s not in station_ids})
    result = {'version': 1, 'network': NETWORK, 'snapshot': raw['source'], 'lines': lines,
              'routes': route_output, 'segments': list(segments.values()), 'stations': stations,
              'entrances': entrances, 'unassociatedCandidates': unassociated}
    report['metro'] = {'network': NETWORK, 'snapshot': raw['source'], 'routeRelations': len(routes),
                       'lineRefs': [line['ref'] for line in lines],
                       'coveredLineRefs': [line['ref'] for line in lines if line['hasCoverage']],
                       'segments': len(segments), 'stations': len(stations), 'entrances': len(entrances),
                       'unassociatedCandidates': len(unassociated), 'missingRouteRefs': missing_ref,
                       'colourConflicts': colour_conflicts, 'excludedTrackMembers': excluded_members,
                       'outsideCoverageStationRefs': orphan_station_refs,
                       'chegongmiao': {'stations': [s for s in stations if s['name'] == '车公庙'],
                                      'entrances': [e for e in entrances if '车公庙' in e['stationNames']]},
                       'limitations': ['OSM snapshot membership, not a live operator station/entrance inventory',
                                       'Unassociated candidates are excluded from confirmed station and entrance layers',
                                       'Combined ref 2;8 services retain both line references on shared track',
                                       'Vertical track elevations are unresolved; layer and level are not metres',
                                       'Not yet attached to scene or maps']}
    return result


def build_metro(clip, report, use_cache=True):
    return compile_metro(read_metro(use_cache=use_cache), clip, report)


if __name__ == '__main__':
    from geo import phase1_clip_local
    summary = {}
    result = build_metro(phase1_clip_local(), summary)
    print(json.dumps({k: v for k, v in summary['metro'].items() if k != 'chegongmiao'}, ensure_ascii=False, indent=2))
    print(json.dumps(summary['metro']['chegongmiao'], ensure_ascii=False, indent=2))
