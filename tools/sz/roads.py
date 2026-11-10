"""把 OSM highway 整理成带宽度、等级、方向的折线，供路面和沿线车流使用，不建路口拓扑。"""

import re

from shapely.ops import transform

from geo import project

# 等级编号按本表顺序写进共享包的 enums.roadClass（tools/sz/build.py），后续改动必须保持顺序
CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'local', 'service', 'pedestrian']

CLASS_OF = {
    'motorway': 'motorway', 'motorway_link': 'motorway',
    'trunk': 'trunk', 'trunk_link': 'trunk',
    'primary': 'primary', 'primary_link': 'primary',
    'secondary': 'secondary', 'secondary_link': 'secondary',
    'tertiary': 'tertiary', 'tertiary_link': 'tertiary',
    'unclassified': 'local', 'residential': 'local', 'living_street': 'local',
    'service': 'service',
    'pedestrian': 'pedestrian', 'footway': 'pedestrian', 'cycleway': 'pedestrian',
}

DEFAULT_WIDTH = {
    'motorway': 24, 'trunk': 22, 'primary': 16, 'secondary': 12, 'tertiary': 9,
    'local': 7, 'service': 4.5, 'pedestrian': 3,
}
LINK_WIDTH = 6.5
LANE_WIDTH = 3.25


def _num(v):
    if v is None:
        return None
    m = re.match(r'^\s*(-?[0-9]+(?:\.[0-9]+)?)', str(v))
    return float(m.group(1)) if m else None


def road_direction(tags):
    value = tags.get('oneway')
    if value in ('no', '0', 'false'):
        return 0
    if value == '-1':
        return -1
    if value in ('yes', '1', 'true'):
        return 1
    if value in ('reversible', 'alternating'):
        return None
    return 1 if tags.get('junction') == 'roundabout' or tags.get('highway') in ('motorway', 'motorway_link') else 0


def road_dimensions(tags):
    hw = tags['highway']
    width, lanes = _num(tags.get('width')), _num(tags.get('lanes'))
    lanes = int(lanes) if lanes and lanes >= 1 else 0
    if width and width > 0:
        return round(width, 1), lanes, 'osm-width'
    if lanes:
        return round(lanes * LANE_WIDTH, 1), lanes, 'estimate-from-lanes'
    return LINK_WIDTH if hw.endswith('_link') else DEFAULT_WIDTH[CLASS_OF[hw]], 0, 'estimate-from-class'


def build_roads(osm, clip_local, report):
    out = []
    for r in osm['roads']:
        t = r['tags']
        hw = t.get('highway')
        cls = CLASS_OF.get(hw)
        if cls is None or t.get('tunnel') in ('yes', 'building_passage'):
            continue
        line = transform(lambda x, y, z=None: project(x, y), r['geom']).intersection(clip_local)
        if line.is_empty:
            continue
        parts = list(getattr(line, 'geoms', [line]))
        width, lanes, width_source = road_dimensions(t)
        direction = road_direction(t)
        oneway = direction in (-1, 1)
        elevated = t.get('bridge') == 'yes' or _num(t.get('layer')) not in (None, 0.0)
        for p in parts:
            if p.geom_type != 'LineString' or p.length < 4:
                continue
            out.append({
                'id': r['id'], 'line': p.reverse().simplify(0.5) if direction == -1 else p.simplify(0.5), 'cls': cls, 'width': round(width, 1),
                'widthSource': width_source,
                'lanes': int(lanes) if lanes else None, 'oneway': oneway, 'elevated': elevated,
                'name': t.get('name'),
            })
    report['roads'] = len(out)
    report['roadKm'] = round(sum(r['line'].length for r in out) / 1000, 1)
    return out
