"""由 OSM S3 主线桥段生成前海、宝安沿岸的远景高架。"""

import math

from shapely.geometry import box

from geo import YANJIANG_ROUTE_ID, YANJIANG_SCENIC_BBOX
from land import _to_local


def build_yanjiang(osm, report):
    members = set(osm['yanjiangRouteMembers'])
    clip = _to_local(box(*YANJIANG_SCENIC_BBOX))
    deck_height, pier_spacing = 15, 42
    segments = []
    length = 0
    for entry in sorted(osm['yanjiangBridgeWays'], key=lambda row: row['id']):
        if entry['id'] not in members:
            continue
        line = _to_local(entry['geom']).intersection(clip)
        if line.is_empty:
            continue
        for part in getattr(line, 'geoms', [line]):
            if part.geom_type != 'LineString' or part.length < 1:
                continue
            # 局部收费广场的车道统计不能套用到整幅高架上。远景保留双幅位置，桥宽按常规主线估计。
            tagged_lanes = int(entry['lanes']) if (entry['lanes'] or '').isdigit() else 0
            lanes = min(tagged_lanes, 5) if tagged_lanes else 4
            segment = {'osmWayId': entry['id'], 'widthM': 3.75 * lanes + 2,
                       'stations': []}
            distance = 0
            for i, (x, z) in enumerate(part.coords):
                if i:
                    distance += math.dist(part.coords[i - 1], (x, z))
                if not segment['stations'] or round(distance, 3) > segment['stations'][-1]['stationM']:
                    segment['stations'].append({'stationM': round(distance, 3), 'x': round(x, 3),
                                                'z': round(z, 3), 'y': deck_height, 'lanes': lanes})
            segments.append(segment)
            length += distance

    if not segments:
        raise ValueError('No sourced Yanjiang expressway bridge ways in the scenic extent')
    source = {'osmSnapshotId': 'osm-guangdong', 'osmRelationId': YANJIANG_ROUTE_ID,
              'officialRoute': 'https://jtys.sz.gov.cn/zwgk/ggqsydw/gsgl/',
              'geometry': 'osm-motorway-bridge', 'heightSource': 'estimate',
              'verticalDatum': 'nominal-waterline-visual-reference', 'boundsWgs84': YANJIANG_SCENIC_BBOX}
    report['yanjiangExpressway'] = {'source': source, 'deckHeightM': deck_height, 'pierSpacingM': pier_spacing,
                                  'osmWayIds': sorted({part['osmWayId'] for part in segments}),
                                  'carriagewayLengthM': round(length, 1), 'playable': False}
    return {'source': source, 'pierSpacingM': pier_spacing, 'segments': segments}
