"""把 OSM highway 整理成带宽度、等级、方向的折线。MVP 只做显示和沿线车流，不建路口拓扑。"""

import re

from shapely.ops import transform

from geo import project

# 等级编号，和 js/sz-mvp/roads.js 的 ROAD_CLASS 表一一对应
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
        width = _num(t.get('width'))
        lanes = _num(t.get('lanes'))
        if not width:
            if lanes:
                width = lanes * LANE_WIDTH
            elif hw.endswith('_link'):
                width = LINK_WIDTH
            else:
                width = DEFAULT_WIDTH[cls]
        oneway = t.get('oneway') == 'yes' or hw in ('motorway', 'motorway_link')
        elevated = t.get('bridge') == 'yes' or _num(t.get('layer')) not in (None, 0.0)
        for p in parts:
            if p.geom_type != 'LineString' or p.length < 4:
                continue
            out.append({
                'id': r['id'], 'line': p.simplify(0.5), 'cls': cls, 'width': round(width, 1),
                'lanes': int(lanes) if lanes else None, 'oneway': oneway, 'elevated': elevated,
                'name': t.get('name'),
            })
    report['roads'] = len(out)
    report['roadKm'] = round(sum(r['line'].length for r in out) / 1000, 1)
    return out
