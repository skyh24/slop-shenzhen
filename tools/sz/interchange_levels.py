"""应用有明确范围的城区立交估计地面，接入原地形三角网。"""

import json
from pathlib import Path

from shapely.geometry import LineString, box

from keyuan_underpass import _restore_roof
from tunnel_portals import CORRIDOR_MARGIN_M, MIN_TUNNEL_WIDTH_M, _source_points
from waterfront import _clip_terrain

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/interchange-levels.json'


def apply_interchange_levels(payload, report):
    specs = json.loads(SOURCE.read_text())
    original = payload['terrainSurface']
    if original.get('interchangeLevels') == specs:
        return
    if 'interchangeLevels' in original:
        raise ValueError('Rebuild the base terrain before replacing interchange levels')

    surface = original
    graph = payload['roadGraph']
    rows = []
    for spec in specs:
        area = spec['groundArea']
        core = box(area['minX'], area['minZ'], area['maxX'], area['maxZ'])
        datum = spec['groundY']
        filled = 0
        for edge, meta in zip(graph['links'], graph['metadata'], strict=True):
            if not meta['tunnel'] or meta['osmId'] not in spec['groundWays']:
                continue
            half_width = (max(edge[3], MIN_TUNNEL_WIDTH_M) + CORRIDOR_MARGIN_M) / 2
            corridor = LineString(_source_points(graph, edge)).buffer(half_width + 2)
            surface, area_m2 = _restore_roof(surface, corridor, datum)
            filled += area_m2
        blend = 65

        def grade(point, height):
            t = min(1, point.distance(core) / blend)
            weight = t * t * (3 - 2 * t)
            return datum + (height - datum) * weight

        surface, changed, _ = _clip_terrain(surface, {}, [(core.buffer(blend), grade)], grade_step=16)
        rows.append({'id': spec['id'], 'groundY': datum, 'heightSource': 'estimate',
                     'changedTerrainChunks': changed, 'restoredOpeningsM2': round(filled, 3)})
    payload['terrainSurface'] = {**surface, 'interchangeLevels': specs}
    report['interchangeLevels'] = rows
    report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                                    triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']))
