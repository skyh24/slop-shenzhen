"""从锁定 OSM 快照提取跨边界主线，以工程相对尺寸生成远景桥的断面输入。"""

import json
import math
from bisect import bisect_right
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point

from geo import project


BRIDGES = Path(__file__).resolve().parents[2] / 'data/source/bridges.json'
STATION_STEP_M = 12


def _read_snapshot(pbf, spec):
    relation_id = spec['osmRelationId']
    way_ids = set(spec['primary']['wayIds'] + spec['opposite']['wayIds'])
    pylon_ids = {span['towerNodeId'] for span in spec['spans']}
    members = set()
    ways = {}
    for obj in (osmium.FileProcessor(str(pbf), osmium.osm.WAY | osmium.osm.RELATION)
                .with_filter(osmium.filter.IdFilter(list(way_ids | {relation_id})))):
        if obj.is_relation() and obj.id == relation_id and obj.tags.get('type') == 'street':
            members = {member.ref for member in obj.members if member.type == 'w' and member.role == 'street'}
        if obj.is_way() and obj.id in way_ids:
            if obj.tags.get('bridge') != 'yes' or obj.tags.get('oneway') != 'yes':
                raise ValueError(f'Bridge way {obj.id} no longer has the reviewed bridge and direction tags')
            lanes = int(obj.tags.get('lanes', '0'))
            if lanes < 1:
                raise ValueError(f'Bridge way {obj.id} has no reviewed lane count')
            ways[obj.id] = ([node.ref for node in obj.nodes], lanes)
    if not way_ids <= members or way_ids - ways.keys():
        raise ValueError(f'Bridge relation {relation_id} is missing reviewed main-line ways')

    needed = pylon_ids | {ref for refs, _ in ways.values() for ref in refs}
    coords = {}
    for node in (osmium.FileProcessor(str(pbf), osmium.osm.NODE)
                 .with_filter(osmium.filter.IdFilter(list(needed)))):
        if node.id in pylon_ids and (node.tags.get('bridge:support') != 'pylon'
                                     or node.tags.get('bridge:structure') != 'cable_stayed'):
            raise ValueError(f'Bridge pylon node {node.id} no longer has the reviewed structure tags')
        coords[node.id] = project(node.lon, node.lat)
        if len(coords) == len(needed):
            break
    if missing := needed - coords.keys():
        raise ValueError(f'Bridge nodes missing from snapshot: {sorted(missing)}')
    return ways, coords


def _carriageway(spec, ways, coords):
    # 保留源单向道路的通行方向，断面桩号统一按地理北到南排列。
    refs = []
    lane_knots = []
    northbound = spec['direction'] == 'northbound'
    path = spec['wayIds'][::-1] if northbound else spec['wayIds']
    for way_id in path:
        nodes, lanes = ways[way_id]
        ordered = nodes[::-1] if northbound else nodes
        if refs and refs[-1] != ordered[0]:
            raise ValueError(f'Bridge way {way_id} is disconnected from the reviewed main line')
        lane_knots.append((max(0, len(refs) - 1), lanes))
        refs += ordered[1:] if refs else ordered

    points = [coords[ref] for ref in refs]
    stations = [0.0]
    for a, b in zip(points, points[1:]):
        stations.append(stations[-1] + math.dist(a, b))
    line = LineString(points)
    boundary = stations[refs.index(spec['boundaryNodeId'])]
    return line, boundary, stations, [(stations[index], lanes) for index, lanes in lane_knots]


def _lanes_at(knots, distance):
    return knots[bisect_right(knots, (distance + 0.001, math.inf)) - 1][1]


def _interpolate(x, a, b):
    return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])


def _piecewise_linear(x, knots):
    return _interpolate(x, *knots[:2]) if x <= knots[1][0] else _interpolate(x, *knots[1:])


def _height_profile(knots):
    # 同号坡度用调和平均连接，过顶处设平切线。输入全部是公开相对尺寸或显式估计。
    gradients = [(b[1] - a[1]) / (b[0] - a[0]) for a, b in zip(knots, knots[1:])]
    tangents = [gradients[0]]
    tangents += [2 * a * b / (a + b) if a * b > 0 else 0 for a, b in zip(gradients, gradients[1:])]
    tangents.append(gradients[-1])

    def height(station):
        i = min(len(knots) - 2, bisect_right(knots, (station, math.inf)) - 1)
        a, b = knots[i:i + 2]
        distance = b[0] - a[0]
        t = (station - a[0]) / distance
        mix = t * t * (3 - 2 * t)
        return (a[1] * (1 - mix) + b[1] * mix
                + distance * t * (1 - t) * (tangents[i] * (1 - t) - tangents[i + 1] * t))

    return height


def _build_bridge(bridge_id, spec, ways, coords):
    line, boundary, points, lanes = _carriageway(spec['primary'], ways, coords)
    other, other_boundary, other_points, other_lanes = _carriageway(spec['opposite'], ways, coords)
    start, end = round(-boundary, 3), round(line.length - boundary, 3)
    other_start = spec['opposite']['resolvedStartStationM']
    other_end = round(line.project(Point(other.coords[-1])) - boundary, 3)
    other_mapping = [(other_start, other.project(line.interpolate(boundary + other_start))),
                     (0, other_boundary), (other_end, other.length)]
    other_reverse = [(distance, station) for station, distance in other_mapping]
    crossings = line.intersection(other)
    if crossings.geom_type != 'Point' or line.project(crossings) - boundary >= other_start:
        raise ValueError('Main-line crossing has moved into the resolved bridge section')

    spans = []
    y_knots = [(start, spec['approach']['northEndDeckY'])]
    for span in spec['spans']:
        node_id = span['towerNodeId']
        x, z = coords[node_id]
        tower_station = round(line.project(Point(x, z)) - boundary, 3)
        supports = [round(tower_station + offset, 3) for offset in span['supportOffsetsM']]
        cap_y = span['assumedCapY']
        deck_y = span.get('deckYApproxM', cap_y + span.get('deckAboveCapM', 0))
        y0, y1 = span['estimatedDeckEndOffsetsM']
        y_knots += [(supports[0], deck_y + y0), (tower_station, deck_y), (supports[-1], deck_y + y1)]
        spans.append({
            'id': span['id'], 'startM': supports[0], 'endM': supports[-1], 'supportStationsM': supports,
            'deckWidthM': span['deckWidthM'], 'girderDepthM': span['girderDepthM'],
            'mainSpanM': span['mainSpanM'], 'mainDirection': span['mainDirection'],
            'backSpanM': span['backSpanM'], 'stayPairs': span['stayPairs'],
            'stayLayout': {key: span[key] for key in ('stayMainSpacingM', 'stayBackSpacingM',
                                                    'estimatedFirstMainAnchorM', 'estimatedLastBackAnchorM')},
            'tower': {'osmNodeId': node_id, 'stationM': tower_station, 'x': round(x, 3), 'z': round(z, 3),
                      'y': deck_y, 'capY': cap_y, 'topY': cap_y + span['towerHeightAboveCapM'],
                      'lean': -span['mainDirection'] * span['leanRiseRatio'],
                      'baseSectionM': span['towerBaseSectionM'], 'topSectionM': span['towerTopSectionM'],
                      'pileCapPlanM': span.get('pileCapPlanM')},
        })
    y_knots.append((end, spec['approach']['southEndDeckY']))
    if any(a[0] >= b[0] for a, b in zip(y_knots, y_knots[1:])):
        raise ValueError('Cable spans and approach profile are out of order')
    height = _height_profile(y_knots)

    stations = {start, end, other_start, other_end, 0}
    stations.update(round(distance - boundary, 3) for distance in points)
    stations.update(round(_piecewise_linear(distance, other_reverse), 3) for distance in other_points
                    if other_mapping[0][1] <= distance <= other.length)
    stations.update(range(math.ceil(start / STATION_STEP_M) * STATION_STEP_M, math.ceil(end), STATION_STEP_M))
    for span in spans:
        stations.update(span['supportStationsM'])
    rows = []
    for station in sorted(stations):
        distance = boundary + station
        p = line.interpolate(max(0, min(line.length, distance)))
        row = {'stationM': station, 'x': round(p.x, 3), 'y': round(height(station), 3), 'z': round(p.y, 3),
               'lanes': _lanes_at(lanes, distance)}
        if other_start <= station <= other_end:
            other_distance = _piecewise_linear(station, other_mapping)
            q = other.interpolate(other_distance)
            row.update(oppositeX=round(q.x, 3), oppositeZ=round(q.y, 3),
                       oppositeLanes=_lanes_at(other_lanes, other_distance))
        rows.append(row)

    source = {'osmRelationId': spec['osmRelationId'], 'osmSnapshotId': spec['osmSnapshotId'],
              'checkedOn': spec['checkedOn'], 'verticalDatum': spec['verticalDatum'], 'engineering': spec['sources'],
              'designLengthM': spec['designLengthM'], 'primary': spec['primary'], 'opposite': spec['opposite']}
    bridge = {'id': bridge_id, 'source': source, 'stations': rows, 'spans': spans,
              'approach': spec['approach'], 'lighting': spec['lighting']}
    audit = {'id': bridge_id, 'osmRelationId': spec['osmRelationId'], 'stations': len(rows),
             'verticalDatum': spec['verticalDatum'], 'absoluteDeckHeightsResolved': False, 'playable': False,
             'designLengthM': spec['designLengthM'], 'primaryLengthM': round(line.length, 2),
             'oppositeLengthM': round(other.length, 2), 'omittedPortCrossingStationM': round(line.project(crossings) - boundary, 2),
             'resolvedOppositeStartM': other_start, 'resolvedOppositeEndM': other_end,
             'towers': [{'id': span['tower']['osmNodeId'], 'stationM': span['tower']['stationM'],
                         'mainSpanM': span['mainSpanM'], 'stayPairs': span['stayPairs']} for span in spans]}
    return bridge, audit


def build_bridges(pbf, landmarks, report):
    specs = json.loads(BRIDGES.read_text())
    bridges, records = [], []
    for landmark in landmarks:
        bridge_id = landmark['id']
        if bridge_id not in specs:
            continue
        spec = specs[bridge_id]
        if landmark.get('osm', {}).get('route') != f"relation/{spec['osmRelationId']}":
            raise ValueError(f'Bridge {bridge_id} differs from the landmark catalog source identity')
        bridge, record = _build_bridge(bridge_id, spec, *_read_snapshot(pbf, spec))
        bridges.append(bridge)
        records.append(record)
    report['bridges'] = records
    return bridges
