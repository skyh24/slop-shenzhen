"""将 DEM 三角面按陆地、水体和已核实的排除区裁切，显示与接触共用输出网格。"""

import math
import time

import numpy as np
from shapely import box as grid_boxes
from shapely import constrained_delaunay_triangles, contains_xy, distance, intersects, points, prepare
from shapely.geometry import Polygon, box
from shapely.ops import unary_union


def _datum_grid(terrain, dry):
    step, nx, nz = (terrain[key] for key in ('step', 'nx', 'nz'))
    original = np.asarray(terrain['heights'], dtype=np.int64).reshape(nz, nx)
    x, z = np.meshgrid(terrain['x0'] + np.arange(nx) * step, terrain['z0'] + np.arange(nz) * step)
    # 裁切到岸边的三角面也用水侧格点插值，覆盖参与岸边三角面的四个角。
    prepare(dry)
    dry_cells = intersects(dry, grid_boxes(x[:-1, :-1], z[:-1, :-1], x[1:, 1:], z[1:, 1:]))
    coverage = np.zeros((nz, nx), dtype=bool)
    coverage[:-1, :-1] |= dry_cells
    coverage[:-1, 1:] |= dry_cells
    coverage[1:, :-1] |= dry_cells
    coverage[1:, 1:] |= dry_cells
    return original, x, z, dry_cells, coverage


def apply_urban_datum(terrain, pilots, datum, dry, protected, report):
    """复现原样区地坪，用来保留已有桥头和台地的接触标高。"""
    step, scale = terrain['step'], terrain['heightScale']
    height = datum['heightM']
    target = round(height / scale)
    if not math.isclose(height, target * scale, abs_tol=1e-8):
        raise ValueError('Urban datum must align to the terrain height scale')
    original, x, z, _, coverage = _datum_grid(terrain, dry)
    xy = points(x, z)
    nz, nx = original.shape
    blend = np.zeros((nz, nx), dtype=np.float64)
    by_pilot = {}
    for pilot, polygon in pilots:
        width = pilot['transitionM']
        if not math.isfinite(width) or width < step:
            raise ValueError('Urban datum transition must cover at least one grid cell')
        west, north, east, south = polygon.bounds
        near = coverage & (x >= west - width) & (x <= east + width) & (z >= north - width) & (z <= south + width)
        ratio = np.clip(1 - distance(polygon, xy[near]) / width, 0, 1)
        if not protected.is_empty:
            # 公园及保护边缘接回已有地面，避免场景地坪侵入已有自然起伏。
            ratio = np.minimum(ratio, np.clip(distance(protected, xy[near]) / width, 0, 1))
        blend[near] = np.maximum(blend[near], ratio)
        by_pilot[pilot['id']] = {'boundsXZ': list(polygon.bounds), 'transitionM': width,
                                 'levelVertices': int((ratio == 1).sum())}
    influence = blend * blend * (3 - 2 * blend)
    values = original + np.rint((target - original) * influence).astype(np.int64)
    delta = (values - original) * scale
    modified = values != original
    ramp = (blend > 0) & (blend < 1)
    y = values * scale
    dx, dz = np.diff(y, axis=1) / step, np.diff(y, axis=0) / step
    first = ramp[:-1, :-1] | ramp[1:, :-1] | ramp[:-1, 1:]
    last = ramp[1:, 1:] | ramp[1:, :-1] | ramp[:-1, 1:]
    slopes = np.concatenate((np.hypot(dx[:-1], dz[:, :-1])[first], np.hypot(dx[1:], dz[:, 1:])[last])) * 100
    details = {'heightSource': 'urban-datum', 'heightM': height, 'reference': datum['reference'], 'pilots': by_pilot,
               'changedVertices': int(modified.sum()), 'maxDeltaM': round(float(np.abs(delta).max()), 3),
               'transitionSlopePercent': {'p95': round(float(np.percentile(slopes, 95)), 3) if slopes.size else 0,
                                          'max': round(float(slopes.max()), 3) if slopes.size else 0}}
    report['urbanDatum'] = details
    return {**terrain, 'heights': values.ravel().tolist(),
            'processing': {**terrain['processing'], 'urbanDatum': details}}


def apply_city_datum(terrain, datum, dry, relief, fixed, fixed_terrain, report):
    """统一普通城区地坪，保留已核山地、公园核心和既有工程接点。"""
    step, scale = terrain['step'], terrain['heightScale']
    height = datum['heightM']
    target = round(height / scale)
    if not math.isclose(height, target * scale, abs_tol=1e-8):
        raise ValueError('Urban datum must align to the terrain height scale')
    original, x, z, cells, coverage = _datum_grid(terrain, dry)
    xy = points(x, z)

    def weights(polygon, inside, outside):
        weight = np.zeros(x.shape)
        if polygon.is_empty:
            return weight
        min_x, min_z, max_x, max_z = polygon.bounds
        near = coverage & (x >= min_x - outside) & (x <= max_x + outside) & (
            z >= min_z - outside) & (z <= max_z + outside)
        local = xy[near]
        if inside:
            sign = np.where(contains_xy(polygon, x[near], z[near]), 1, -1)
            edge = sign * distance(polygon.boundary, local)
            ratio = np.clip((edge + outside) / (inside + outside), 0, 1)
        else:
            ratio = np.clip(1 - distance(polygon, local) / outside, 0, 1)
        weight[near] = ratio * ratio * (3 - 2 * ratio)
        return weight

    def smooth_transition(values, band):
        # 城区与保留区的锚点不动，带内迭代去掉 DSM 屋顶、树冠造成的碎波纹。
        for _ in range(12):
            padded = np.pad(values, 1, mode='edge')
            average = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
            values[band] = (values[band] + average[band]) / 2
        return values

    natural = np.zeros(x.shape)
    for polygon, inside, outside in relief:
        np.maximum(natural, weights(polygon, inside, outside), out=natural)
    natural_band = (natural > 0) & (natural < 1)
    base = np.where(coverage, target + (original - target) * natural, original)
    base = smooth_transition(base, natural_band)

    engineering = weights(*fixed)
    engineering_band = (engineering > 0) & (engineering < 1)
    legacy = np.asarray(fixed_terrain['heights']).reshape(original.shape)
    values = np.rint(smooth_transition(base + (legacy - base) * engineering, engineering_band)).astype(np.int64)
    urban = coverage & (natural == 0) & (engineering == 0)
    ramp = (natural_band | engineering_band) & (engineering < 1)
    dx, dz = np.diff(values, axis=1) * scale / step, np.diff(values, axis=0) * scale / step
    first = cells & (ramp[:-1, :-1] | ramp[1:, :-1] | ramp[:-1, 1:])
    last = cells & (ramp[1:, 1:] | ramp[1:, :-1] | ramp[:-1, 1:])
    slopes = np.concatenate((np.hypot(dx[:-1], dz[:, :-1])[first], np.hypot(dx[1:], dz[:, 1:])[last])) * 100
    source = terrain['processing']['heightSource']
    details = {'heightSource': 'urban-datum', 'sourceHeightSource': source, 'heightM': height,
               'reference': datum['reference'], 'coverage': 'phase1-dry-land',
               'urbanVertices': int(urban.sum()), 'naturalCoreVertices': int(((natural == 1) & (engineering == 0)).sum()),
               'engineeringVertices': int((engineering == 1).sum()), 'transitionVertices': int(ramp.sum()),
               'changedVertices': int((values != legacy).sum()), 'maxDeltaM': round(float(np.abs(values - legacy).max() * scale), 3),
               'transitionSlopePercent': {'p95': round(float(np.percentile(slopes, 95)), 3) if slopes.size else 0,
                                          'max': round(float(slopes.max()), 3) if slopes.size else 0}}
    report['urbanDatum'] = details
    return {**terrain, 'heights': values.ravel().tolist(),
            'processing': {**terrain['processing'], 'heightSource': 'urban-datum', 'urbanDatum': details}}


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
