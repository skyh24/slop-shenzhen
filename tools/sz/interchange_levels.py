"""应用有明确范围的城区立交估计地面，接入原地形三角网。"""

import json
from pathlib import Path

from shapely.geometry import LineString, box
from shapely.ops import polygonize, unary_union

from keyuan_underpass import _restore_roof
from tunnel_portals import CORRIDOR_MARGIN_M, MIN_TUNNEL_WIDTH_M, _source_points
from waterfront import _clip_terrain

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/interchange-levels.json'


def _restore_obsolete_cuts(surface, core, datum):
    walls = surface.get('cutWalls')
    if not walls or not walls['triangles']:
        return surface, 0, 0.0
    positions = walls['positions']
    edges = {}
    for offset in range(0, len(positions), 9):
        triangle = positions[offset:offset + 9]
        ends = sorted(set(zip(triangle[::3], triangle[2::3])))
        if len(ends) == 2 and core.covers(LineString(ends)):
            edges.setdefault(tuple(ends), []).append(offset)
    floating = {edge: offsets for edge, offsets in edges.items()
                if all(min(positions[offset + 1:offset + 9:3]) > datum for offset in offsets)}
    rings = list(polygonize([LineString(edge) for edge in floating]))
    if not rings:
        return surface, 0, 0.0
    footprint = unary_union(rings)
    removed = {offset for edge, offsets in floating.items() if footprint.boundary.covers(LineString(edge))
               for offset in offsets}
    if not removed:
        return surface, 0, 0.0
    surface, area = _restore_roof(surface, footprint.buffer(0.01).intersection(core), datum)
    retained = [value for offset in range(0, len(positions), 9) if offset not in removed
                for value in positions[offset:offset + 9]]
    return {**surface, 'cutWalls': {**walls, 'positions': retained, 'triangles': len(retained) // 9,
            'minY': min(retained[1::3], default=0.0), 'maxY': max(retained[1::3], default=0.0)}}, len(removed), area


def apply_interchange_levels(payload, report):
    specs = json.loads(SOURCE.read_text())
    original = payload['terrainSurface']
    leveled = original.get('interchangeLevels') == specs
    if 'interchangeLevels' in original and not leveled:
        raise ValueError('Rebuild the base terrain before replacing interchange levels')

    surface = original
    graph = payload['roadGraph']
    rows = []
    for spec in specs:
        area = spec['groundArea']
        core = box(area['minX'], area['minZ'], area['maxX'], area['maxZ'])
        datum = spec['groundY']
        surface, removed, restored = _restore_obsolete_cuts(surface, core, datum)
        audit = {'removedCutWallTriangles': removed, 'restoredElevatedCutM2': round(restored, 3)}
        if leveled:
            previous = next((row for row in report.get('interchangeLevels', []) if row['id'] == spec['id']), {})
            rows.append({**previous, 'id': spec['id'], **(audit if removed else {})})
            continue
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
                     'changedTerrainChunks': changed, 'restoredOpeningsM2': round(filled, 3), **audit})
    if leveled and surface is original:
        return
    payload['terrainSurface'] = {**surface, 'interchangeLevels': specs}
    report['interchangeLevels'] = rows
    if 'elevatedCut' in report and 'cutWalls' in surface:
        report['elevatedCut']['wallTriangles'] = surface['cutWalls']['triangles']
    report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                                    triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']))
