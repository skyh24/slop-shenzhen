"""将 DEM 三角面按陆地、水体和已核实的排除区裁切，显示与接触共用输出网格。"""

import math
import time

import numpy as np
from shapely import box as grid_boxes
from shapely import constrained_delaunay_triangles, contains_xy, distance, intersects, points, prepare
from shapely.geometry import Polygon, box
from shapely.ops import unary_union


URBAN_HEIGHT_SOURCE = 'urban-datum'
RELIEF_EDGE_M = 45.0


def build_urban_grid(terrain, land, relief, datum, report):
    """由源网格另建游戏地面，统一提供给网格和仍读取格点的落地逻辑。"""
    step, nx, nz, scale = terrain['step'], terrain['nx'], terrain['nz'], terrain['heightScale']
    datum_m = datum['heightM']
    if isinstance(datum_m, bool) or not isinstance(datum_m, (float, int)) or not math.isfinite(datum_m):
        raise ValueError('Urban datum must be a finite height')
    datum_units = round(datum_m / scale)
    if not math.isclose(datum_units * scale, datum_m, abs_tol=1e-8):
        raise ValueError('Urban datum must align to the terrain height scale')
    original = np.asarray(terrain['heights'], dtype=np.int64).reshape(nz, nx)
    x, z = np.meshgrid(terrain['x0'] + np.arange(nx) * step, terrain['z0'] + np.arange(nz) * step)
    # 接触到岸线裁切三角面的外侧格点也须有城区高程。
    support = unary_union(land)
    prepare(support)
    cells = intersects(support, grid_boxes(x[:-1, :-1], z[:-1, :-1], x[1:, 1:], z[1:, 1:]))
    active = np.zeros(x.shape, dtype=bool)
    active[:-1, :-1] |= cells
    active[:-1, 1:] |= cells
    active[1:, :-1] |= cells
    active[1:, 1:] |= cells
    preserved = unary_union(relief)
    prepare(preserved)
    interior = active & contains_xy(preserved, x, z)
    urban = active & ~interior
    values = original.copy()
    values[urban] = datum_units
    dist = distance(preserved.boundary, points(x[interior], z[interior])) if interior.any() else np.empty(0)
    original_delta = (original[interior] - datum_units) * scale
    fraction = np.minimum(dist / RELIEF_EDGE_M, 1)
    blend = fraction**2 * (3 - 2 * fraction)
    values[interior] = datum_units + np.rint(original_delta * blend / scale).astype(np.int64)
    transition = np.zeros_like(interior)
    transition[interior] = dist < RELIEF_EDGE_M
    # 量测实际三角面坡度。边界带和山地内部的坡度分别统计，避免用天然陡坡稀释边界指标。
    metres = values * scale
    dx = np.diff(metres, axis=1) / step
    dz = np.diff(metres, axis=0) / step
    a, b, c, d = transition[:-1, :-1], transition[:-1, 1:], transition[1:, :-1], transition[1:, 1:]
    # 边界落在格间时，城市与保留区的相邻格点也属于过渡坡面。
    ia, ib, ic, id_ = interior[:-1, :-1], interior[:-1, 1:], interior[1:, :-1], interior[1:, 1:]
    upper = cells & (a | b | c | (ia != ib) | (ia != ic))
    lower = cells & (b | c | d | (id_ != ib) | (id_ != ic))
    upper_slope = np.hypot(dx[:-1], dz[:, :-1]) * 100
    lower_slope = np.hypot(dx[1:], dz[:, 1:]) * 100
    slope = np.concatenate((upper_slope[upper], lower_slope[lower]))
    def summary(samples):
        return {name: round(float(np.percentile(samples, q)), 3) if samples.size else None
                for name, q in [('p50', 50), ('p95', 95), ('max', 100)]}

    source = terrain['processing']['heightSource']
    marker = {'heightSource': URBAN_HEIGHT_SOURCE, 'sourceHeightSource': source, 'datumM': datum_m,
              'reference': datum['reference'], 'reliefEdgeM': RELIEF_EDGE_M,
              'reliefEdgeRule': 'smoothstep from datum to source inside the first 45 m; preserve the source grid beyond',
              'heightKind': 'derived-engineering-surface'}
    report['roadSurface'] = {**marker,
        'vertices': {'total': int(values.size), 'urban': int(urban.sum()),
                     'reliefUnchanged': int((interior & ~transition).sum()),
                     'transition': int(transition.sum()), 'changed': int((values != original).sum())},
        'transitionTriangles': int(slope.size), 'transitionSlopePercent': summary(slope),
        'transitionTrianglesOver10Percent': int((slope > 10).sum()),
        'transitionDistanceM': summary(dist[transition[interior]]),
        'deltaM': summary(np.abs(metres - original * scale)[active]),
    }
    if slope.size:
        upper_max = np.where(upper, upper_slope, -1)
        lower_max = np.where(lower, lower_slope, -1)
        extreme = upper_max if upper_max.max() >= lower_max.max() else lower_max
        row, col = np.unravel_index(extreme.argmax(), extreme.shape)
        report['roadSurface']['steepestTransitionCellXZ'] = [float(x[row, col]), float(z[row, col])]
    return {**terrain, 'heights': values.ravel().tolist(),
            'processing': {**terrain['processing'], 'heightSource': URBAN_HEIGHT_SOURCE, 'urbanDatum': marker}}


def _polygons(geometry):
    if geometry.geom_type == 'Polygon':
        yield geometry
    else:
        for part in getattr(geometry, 'geoms', []):
            yield from _polygons(part)


def _triangle_height(points, x, z):
    a, b, c = points
    denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator
    v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator
    return u * a[1] + v * b[1] + (1 - u - v) * c[1]


def build_terrain_surface(terrain, coverage, land, water, report, green=(), wetland=(), chunk_size=500, exclusions=(),
                          paving=()):
    """输入都是米制 Shapely 面，water/green/wetland/exclusions 为带 poly 的记录。"""
    started = time.perf_counter()
    step, nx, nz = terrain['step'], terrain['nx'], terrain['nz']
    x0, z0 = terrain['x0'], terrain['z0']
    if terrain['diagonal'] != 'ne-sw' or chunk_size <= 0 or abs(chunk_size / step - round(chunk_size / step)) > 1e-9:
        raise ValueError('Unsupported terrain surface grid or chunk size')
    if abs(x0 / step - round(x0 / step)) > 1e-9 or abs(z0 / step - round(z0 / step)) > 1e-9:
        raise ValueError('Terrain grid must align to chunk boundaries')
    heights = terrain['heights']
    if len(heights) != nx * nz:
        raise ValueError('Terrain height count mismatch')
    dry = unary_union(land).intersection(coverage).difference(unary_union([w['poly'] for w in water]))
    grid_bounds = box(x0, z0, x0 + (nx - 1) * step, z0 + (nz - 1) * step)
    dry = dry.intersection(grid_bounds)
    excluded = Polygon()
    removed = []
    removed_area = 0.0
    for exclusion in exclusions:
        polygon = exclusion['poly']
        if polygon.geom_type != 'Polygon' or polygon.is_empty or not polygon.is_valid or polygon.interiors:
            raise ValueError(f'Invalid ground exclusion: {exclusion["id"]}')
        area = dry.intersection(polygon).difference(excluded).area
        if area <= 1e-10:
            continue
        excluded = excluded.union(polygon)
        removed_area += area
        removed.append({**{key: value for key, value in exclusion.items() if key != 'poly'},
                        'areaM2': round(area, 6), 'boundsXZ': list(polygon.bounds),
                        'polygonXZ': [list(p) for p in polygon.exterior.coords[:-1]]})
    prepare(excluded)
    greens = unary_union([g['poly'] for g in green])
    wetlands = unary_union([g['poly'] for g in wetland])
    stone = unary_union(paving)
    prepare(greens)
    prepare(wetlands)
    prepare(stone)
    chunks = []
    surface_area = 0.0
    if dry.is_empty:
        report['terrainSurface'] = {'chunks': 0, 'vertices': 0, 'triangles': 0, 'areaKm2': 0}
        result = {'version': 1, 'chunkSize': chunk_size, 'chunks': [], 'heightSource': terrain['processing']['heightSource'],
                  'diagonal': 'ne-sw', 'waterSurface': 'not-generated: water level requires separate source',
                  'grid': {'x0': x0, 'z0': z0, 'step': step, 'nx': nx, 'nz': nz}}
        return result
    minx, minz, maxx, maxz = dry.bounds
    for cz in range(math.floor(minz / chunk_size), math.ceil(maxz / chunk_size)):
        for cx in range(math.floor(minx / chunk_size), math.ceil(maxx / chunk_size)):
            origin_x, origin_z = cx * chunk_size, cz * chunk_size
            chunk_box = box(origin_x, origin_z, origin_x + chunk_size, origin_z + chunk_size)
            region = dry.intersection(chunk_box)
            if region.is_empty or region.area <= 1e-9:
                continue
            prepare(region)
            full_chunk = region.covers(chunk_box)
            # 只对相交的三角形做差集，避免远处海岸网格因多边形环重排而改动。
            has_exclusion = bool(removed) and excluded.intersects(chunk_box)
            has_paving = stone.intersects(chunk_box)
            positions, indices, ranges, vertex_ids, stone_vertices = [], [], [], {}, []

            def vertex(point, paved):
                # 铺装边界的两边位置相同、颜色独立，裁切仍在同一个高程平面内。
                key = (*point, paved)
                if key not in vertex_ids:
                    vertex_ids[key] = len(positions) // 3
                    if paved:
                        stone_vertices.append(vertex_ids[key])
                    positions.extend([point[0] - origin_x, point[1], point[2] - origin_z])
                return vertex_ids[key]

            def emit(points, paved=False):
                nonlocal surface_area
                a, b, c = points
                signed_area = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])
                if abs(signed_area) <= 1e-10:
                    return
                if signed_area < 0:
                    points = [a, c, b]
                surface_area += abs(signed_area) * 0.5
                indices.extend(vertex(p, paved) for p in points)

            i0 = max(0, round((origin_x - x0) / step))
            i1 = min(nx - 1, round((origin_x + chunk_size - x0) / step))
            j0 = max(0, round((origin_z - z0) / step))
            j1 = min(nz - 1, round((origin_z + chunk_size - z0) / step))
            for j in range(j0, j1):
                z = z0 + j * step
                for i in range(i0, i1):
                    x = x0 + i * step
                    square = None if full_chunk and not (has_exclusion or has_paving) else box(x, z, x + step, z + step)
                    full_cell = full_chunk or region.covers(square)
                    if not full_cell and not region.intersects(square):
                        continue
                    cut_cell = has_exclusion and excluded.intersects(square)
                    paved_cell = has_paving and stone.intersects(square)
                    all_paved = paved_cell and stone.covers(square)
                    start = len(indices)
                    a = (x, heights[j * nx + i] * terrain['heightScale'], z)
                    b = (x + step, heights[j * nx + i + 1] * terrain['heightScale'], z)
                    c = (x, heights[(j + 1) * nx + i] * terrain['heightScale'], z + step)
                    d = (x + step, heights[(j + 1) * nx + i + 1] * terrain['heightScale'], z + step)
                    for triangle in ([a, c, b], [b, c, d]):
                        if full_cell and not cut_cell and (not paved_cell or all_paved):
                            emit(triangle, all_paved)
                            continue
                        clipped = Polygon([(p[0], p[2]) for p in triangle])
                        if not full_cell:
                            clipped = clipped.intersection(region)
                        if cut_cell and excluded.intersects(clipped):
                            clipped = clipped.difference(excluded)
                        elif full_cell and not paved_cell:
                            emit(triangle)
                            continue
                        if paved_cell and not all_paved and stone.intersects(clipped):
                            pieces = [(clipped.difference(stone), False), (clipped.intersection(stone), True)]
                        else:
                            pieces = [(clipped, all_paved)]
                        for piece, paved in pieces:
                            for poly in _polygons(piece):
                                if poly.area <= 1e-10:
                                    continue
                                for face in constrained_delaunay_triangles(poly).geoms:
                                    emit([(px, _triangle_height(triangle, px, pz), pz)
                                          for px, pz in list(face.exterior.coords)[:-1]], paved)
                    if len(indices) > start:
                        ranges.extend([j * (nx - 1) + i, start, len(indices) - start])
            if not indices:
                continue
            array = np.asarray(positions).reshape(-1, 3)
            xs, zs = array[:, 0] + origin_x, array[:, 2] + origin_z
            # 地类只影响顶点颜色，不修改几何或碰撞高程。
            kinds = np.zeros(len(array), dtype=np.uint8)
            kinds[contains_xy(greens, xs, zs)] = 1
            kinds[contains_xy(wetlands, xs, zs)] = 2
            kinds[stone_vertices] = 3
            chunks.append({'id': f'{cx},{cz}', 'origin': [origin_x, origin_z], 'positions': positions,
                           'indices': indices, 'cellRanges': ranges, 'kinds': kinds.tolist()})
    expected_area = dry.area - removed_area
    if not math.isclose(surface_area, expected_area, rel_tol=1e-8, abs_tol=1e-5):
        raise ValueError(f'Terrain surface area mismatch: {surface_area} != {expected_area}')
    result = {'version': 1, 'chunkSize': chunk_size, 'chunks': chunks,
              'heightSource': terrain['processing']['heightSource'], 'diagonal': 'ne-sw',
              'waterSurface': 'not-generated: water level requires separate source',
              'grid': {'x0': x0, 'z0': z0, 'step': step, 'nx': nx, 'nz': nz}}
    report['terrainSurface'] = {'chunks': len(chunks), 'vertices': sum(len(c['positions']) // 3 for c in chunks),
                                'triangles': sum(len(c['indices']) // 3 for c in chunks),
                                'areaKm2': round(surface_area / 1e6, 6), 'areaErrorM2': round(surface_area - expected_area, 8),
                                'seconds': round(time.perf_counter() - started, 2),
                                'waterLevelsGenerated': False, 'heightSource': result['heightSource']}
    if removed:
        result['exclusions'] = removed
        report['terrainSurface']['exclusions'] = removed
    if paving:
        report['terrainSurface']['stonePavingAreaM2'] = round(stone.intersection(dry).difference(excluded).area, 3)
    return result
