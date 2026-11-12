"""按生产车行几何裁切已核对的商业铺装源。"""

import json
from pathlib import Path
import subprocess

from shapely import constrained_delaunay_triangles, prepare
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from terrain_surface import _polygons, _triangle_height

FOOTPRINT_HELPER = Path(__file__).with_suffix('.cjs')


def ground_carriageway_mask(parcel, graph):
    """求目标用地和生产地面车行范围的交集。"""
    result = subprocess.run(['node', str(FOOTPRINT_HELPER), json.dumps(parcel.bounds)],
                            input=json.dumps(graph, separators=(',', ':')), capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'Cannot derive ground road footprints: {result.stderr.strip()}')
    affected, osm_ids = [], set()
    for entry in json.loads(result.stdout):
        footprint = Polygon(entry['ring'])
        overlap = parcel.intersection(footprint)
        if overlap.area > 0:
            affected.append(overlap)
            osm_ids.update(entry['osmIds'])
    carriageway = unary_union(affected)
    return carriageway, {
        'source': 'visitGroundRoadFootprints',
        'roadOsmIds': sorted(osm_ids),
        'carriagewayMaskAreaM2': round(carriageway.area, 6),
    }


def _cut_chunk(chunk, mask):
    ox, oz = chunk['origin']
    original_positions, original_kinds = chunk['positions'], chunk['kinds']
    positions, kinds = original_positions.copy(), original_kinds.copy()
    vertex_ids = {(*positions[3 * i:3 * i + 3], kind): i for i, kind in enumerate(kinds)}
    original_indices, original_ranges = chunk['indices'], chunk['cellRanges']
    indices, ranges = [], []
    removed_area = 0.0

    def vertex(x, y, z, kind):
        key = (x - ox, y, z - oz, kind)
        if key not in vertex_ids:
            vertex_ids[key] = len(kinds)
            positions.extend(key[:3])
            kinds.append(kind)
        return vertex_ids[key]

    for offset in range(0, len(original_ranges), 3):
        cell, start, count = original_ranges[offset:offset + 3]
        first = len(indices)
        for i in range(start, start + count, 3):
            face = original_indices[i:i + 3]
            if any(original_kinds[v] != 3 for v in face):
                indices.extend(face)
                continue
            points = [(original_positions[3 * v] + ox, original_positions[3 * v + 1],
                       original_positions[3 * v + 2] + oz) for v in face]
            triangle = Polygon([(x, z) for x, _, z in points])
            overlap = triangle.intersection(mask) if mask.intersects(triangle) else Polygon()
            if overlap.area <= 1e-10:
                indices.extend(face)
                continue
            removed_area += overlap.area
            if mask.covers(triangle):
                indices.extend(vertex(x, y, z, 0) for x, y, z in points)
                continue
            # 沿原三角面的高程平面切分，保留两侧支撑及分块内现有网格索引顺序。
            for pieces, kind in ((triangle.difference(mask), 3), (overlap, 0)):
                for piece in _polygons(pieces):
                    for part in constrained_delaunay_triangles(piece).geoms:
                        if part.area <= 1e-10:
                            continue
                        a, b, c = list(part.exterior.coords)[:-1]
                        oriented = (a, c, b) if part.exterior.is_ccw else (a, b, c)
                        indices.extend(vertex(x, _triangle_height(points, x, z), z, kind) for x, z in oriented)
        ranges.extend([cell, first, len(indices) - first])
    if not removed_area:
        return chunk, 0.0
    return {**chunk, 'positions': positions, 'kinds': kinds, 'indices': indices, 'cellRanges': ranges}, removed_area


def cut_commercial_paving(surface, mask):
    """只把目标车行范围内的铺装面改为普通地面，底面位置不变。"""
    if mask.is_empty:
        return surface, 0.0
    prepare(mask)
    size = surface['chunkSize']
    chunks, removed_area = [], 0.0
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        if mask.intersects(box(ox, oz, ox + size, oz + size)):
            chunk, area = _cut_chunk(chunk, mask)
            removed_area += area
        chunks.append(chunk)
    return {**surface, 'chunks': chunks}, removed_area
