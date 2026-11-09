"""把北环资料的标准断面约束到复核过的 OSM 有向主线边。"""

import json
import math
from collections import Counter
from pathlib import Path

from shapely.geometry import LineString, Point
from shapely.ops import linemerge

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/beihuan-profile.json'


def _line(nodes, link):
    a, b, _, _, _, _, inner = link
    points = [nodes[a * 2:a * 2 + 2], *zip(inner[::2], inner[1::2]), nodes[b * 2:b * 2 + 2]]
    return LineString(points)


def _stations(line, other, section):
    step = section['maxStationStepM']
    distances = {0.0, line.length, *[line.project(Point(p)) for p in line.coords], *range(step, math.ceil(line.length), step)}
    low, high = section['innerWidthLimitsM']
    rows = []
    for s in sorted(distances):
        p = line.interpolate(s)
        inner = max(low, min(high, (p.distance(other) - section['medianTargetEstimateM']) / 2))
        row = [round(p.x, 3), round(p.y, 3), round(inner, 3)]
        if not rows or rows[-1][:2] != row[:2]:
            rows.append(row)
    return rows


def apply_beihuan_sections(road_graph, report):
    spec = json.loads(MANIFEST.read_text())
    links, metadata, node_ids = (road_graph[key] for key in ('links', 'metadata', 'nodeIds'))
    by_key = {(m['osmId'], node_ids[link[0]], node_ids[link[1]]): i for i, (link, m) in enumerate(zip(links, metadata))}
    selected = []
    for direction in spec['directions']:
        rows = []
        for key in direction['links']:
            index = by_key.get(tuple(key))
            if index is None:
                raise ValueError(f'Reviewed Beihuan ground link is missing: {key}')
            link, m = links[index], metadata[index]
            if (link[5] != 1 or road_graph['names'][link[2]] != '北环大道' or m['heightSource'] != 'terrain'
                    or m['bridge'] or m['tunnel'] or m['layer'] or m['widthSource'] != 'estimate-from-class'):
                raise ValueError(f'Reviewed Beihuan source tags changed: {key}')
            rows.append((index, _line(road_graph['nodes'], link)))
        selected.append(rows)
    axes = [linemerge([line for _, line in rows]) for rows in selected]
    if any(line.geom_type != 'LineString' for line in axes):
        raise ValueError('Reviewed Beihuan carriageway is disconnected')

    section = spec['section']
    lanes, lane_width, shoulder = (section[key] for key in ('lanesPerDirection', 'laneWidthEstimateM', 'outerShoulderEstimateM'))
    width = lanes * lane_width + shoulder
    counts, inner_widths = [], []
    for i, direction in enumerate(selected):
        for index, line in direction:
            rows = _stations(line, axes[1 - i], section)
            counts.append(len(rows))
            inner_widths.extend(row[2] for row in rows)
            links[index][3:5] = [width, lanes]
            metadata[index]['widthSource'] = 'reviewed-cross-section-estimate'
            metadata[index]['crossSection'] = {'id': spec['id'], 'laneWidthM': lane_width, 'outerShoulderM': shoulder,
                                                'laneCountSource': 'municipal-design-and-relative-imagery',
                                                'points': [value for row in rows for value in row]}
    if 'roadGraph' in report:
        report['roadGraph']['widthSources'] = dict(Counter(m['widthSource'] for m in metadata))
    report['beihuanCrossSection'] = {'id': spec['id'], 'sourceSnapshot': spec['osmSnapshotId'], 'directedLinks': len(counts),
                                    'stations': sum(counts), 'pavedWidthEstimateM': width, 'laneCount': lanes,
                                    'innerWidthRangeM': [min(inner_widths), max(inner_widths)],
                                    'medianTargetEstimateM': section['medianTargetEstimateM'],
                                    'captureDate': spec['imagery']['captureDate'], 'publicationDate': spec['imagery']['publicationDate']}
