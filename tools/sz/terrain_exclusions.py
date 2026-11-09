"""按室内封闭证据标记不应当作地面的旧 DSM，保留室内标高未知。"""

import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project_coords

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/terrain-exclusions.json'


def _footprint_signature(footprint):
    # 环序标准化后按毫米取整，内环挪动也能使已审核足迹失效。
    ordered = footprint.normalize()
    rings_mm = [[(round(x * 1000), round(z * 1000)) for x, z in ring.coords]
                for ring in [ordered.exterior, *ordered.interiors]]
    return {'boundsXZ': [round(value, 3) for value in footprint.bounds], 'areaM2': round(footprint.area, 3),
            'holes': len(footprint.interiors),
            'ringSha256': hashlib.sha256(json.dumps(rings_mm, separators=(',', ':')).encode('ascii')).hexdigest()}


def _ellipse(bounds, center_offset_x, radii):
    west, north, east, south = bounds
    cx = (west + east) / 2 + (east - west) * center_offset_x
    cz = (south + north) / 2
    rx, rz = radii
    return Polygon([
        (round(cx + rx * math.cos(math.tau * i / 36), 6),
         round(cz + rz * math.sin(math.tau * i / 36), 6))
        for i in range(36)
    ])


def _glazing_envelope(footprint, hall):
    # 建筑包以分米编码。这里使用同一包围盒和 JS 封闭围护的半轴比例。
    bounds = [round(value * 10) / 10 for value in footprint.bounds]
    west, north, east, south = bounds
    rx_fraction, rz_fraction = hall['glazingRadiiFractions']
    return _ellipse(bounds, hall['centerOffsetXFraction'], ((east - west) * rx_fraction, (south - north) * rz_fraction))


def _grid_samples(terrain, mask):
    x0, z0, step = (terrain[k] for k in ('x0', 'z0', 'step'))
    nx, nz = terrain['nx'], terrain['nz']
    west, north, east, south = mask.bounds
    min_i, max_i = max(0, math.ceil((west - x0) / step)), min(nx - 1, math.floor((east - x0) / step))
    min_j, max_j = max(0, math.ceil((north - z0) / step)), min(nz - 1, math.floor((south - z0) / step))
    return [
        round(terrain['heights'][j * nx + i] * terrain['heightScale'], 4)
        for j in range(min_j, max_j + 1) for i in range(min_i, max_i + 1)
        if mask.covers(Point(x0 + i * step, z0 + j * step))
    ]


def _nearest_route(mask, osm_roads, distance):
    west, north, east, south = mask.buffer(distance).bounds
    lon0, lon1 = ORIGIN_LON + west / KX, ORIGIN_LON + east / KX
    lat0, lat1 = ORIGIN_LAT - south / KY, ORIGIN_LAT - north / KY
    nearest = None
    for road in osm_roads:
        w, s, e, n = road['geom'].bounds
        if e < lon0 or w > lon1 or n < lat0 or s > lat1:
            continue
        separation = mask.distance(LineString(project_coords(road['geom'].coords)))
        if separation <= distance and (nearest is None or (separation, road['id']) < nearest):
            nearest = separation, road['id']
    return nearest


def chunjian_exclusions(buildings, terrain, osm_roads=()):
    """给地面生成器提供两馆室内排除面；有源路径冲突时保守保留该馆旧地形。"""
    manifest = json.loads(SOURCE.read_text())
    if manifest['version'] != 2:
        raise ValueError('Unsupported terrain exclusion manifest')
    source = manifest['chunjian']
    if terrain.get('processing', {}).get('heightSource') != source['heightSource']:
        return []

    required = source['requiredFootprints']
    by_id = defaultdict(list)
    for building in buildings:
        if building['id'] in required:
            by_id[building['id']].append(building)
    for id_, expected in required.items():
        if len(by_id[id_]) != 1:
            return []
        polygon = by_id[id_][0]['poly']
        if polygon.geom_type != 'Polygon' or not polygon.is_valid or _footprint_signature(polygon) != expected:
            return []

    masks = []
    for hall in source['halls']:
        building = by_id[hall['sourceId']][0]
        footprint = building['poly']
        mask = _ellipse(footprint.bounds, hall['centerOffsetXFraction'], hall['radiiM'])
        if building['minHeight'] != 0 or not mask.is_valid or not footprint.contains_properly(mask):
            continue
        glazing = _glazing_envelope(footprint, hall)
        if not glazing.contains_properly(mask) or glazing.exterior.distance(mask) <= source['minGlazingMarginM']:
            continue
        nearest = _nearest_route(mask, osm_roads, 50)
        if nearest and nearest[0] < source['routeGuardM']:
            continue
        samples = _grid_samples(terrain, mask)
        if not samples:
            continue
        masks.append({
            'id': hall['id'], 'sourceId': hall['sourceId'], 'landmarkId': 'chunjian', 'poly': mask,
            'reason': 'enclosed-hall-dsm-return', 'boundarySource': 'conservative-plan-and-source-footprint',
            'interiorGround': 'unknown', 'verifiedAt': source['verifiedAt'], 'evidence': hall['evidence'],
            'dsmGridSamples': {'stepM': terrain['step'], 'count': len(samples), 'minM': min(samples), 'maxM': max(samples)},
            'nearestSourceRoute': {'id': nearest[1], 'distanceM': round(nearest[0], 3)} if nearest else None,
        })
    return masks
