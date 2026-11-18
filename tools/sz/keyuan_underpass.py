"""从科苑路双幅源断面派生估计引道，原地保留与深南大道相连的四条横路。"""

import json
import math
from pathlib import Path

from shapely import constrained_delaunay_triangles
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

from commercial_paving import cut_ground_openings
from terrain_surface import _polygons
from tunnel_portals import _SurfaceSampler, _source_points
from waterfront import _clip_terrain

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/keyuan-underpass.json'
EDGE_PAD_M = 1
SHOULDER_M = 1
SEAM_OVERLAP_M = 0.075


def _restore_roof(surface, mask, datum):
    """补回被旧裁口移除的地面，只填现有三角面未覆盖的部分。"""
    grid = surface['grid']
    step, x0, z0, columns = grid['step'], grid['x0'], grid['z0'], grid['nx'] - 1
    chunks, area = [], 0
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        size = surface['chunkSize']
        clipped = mask.intersection(box(ox, oz, ox + size, oz + size))
        if clipped.area <= 1e-8:
            chunks.append(chunk)
            continue
        min_x, min_z, max_x, max_z = clipped.bounds
        column_range = range(max(0, math.floor((min_x - x0) / step)), min(columns, math.ceil((max_x - x0) / step)))
        row_range = range(max(0, math.floor((min_z - z0) / step)), min(grid['nz'] - 1, math.ceil((max_z - z0) / step)))
        ranges_by_cell = dict(zip(chunk['cellRanges'][::3], zip(chunk['cellRanges'][1::3], chunk['cellRanges'][2::3])))
        candidate_cells = {row * columns + column for row in row_range for column in column_range}
        positions, kinds = chunk['positions'].copy(), chunk['kinds'].copy()
        indices, ranges = [], []
        changed = False
        for cell in sorted(candidate_cells.union(ranges_by_cell)):
            start, count = ranges_by_cell.get(cell, (0, 0))
            begin = len(indices)
            faces = chunk['indices'][start:start + count]
            indices.extend(faces)
            if cell in candidate_cells:
                x, z = x0 + cell % columns * step, z0 + cell // columns * step
                piece = clipped.intersection(box(x, z, x + step, z + step))
                polygons = [Polygon([(ox + positions[v * 3], oz + positions[v * 3 + 2])
                                     for v in faces[i:i + 3]]) for i in range(0, count, 3)]
                missing = piece.difference(unary_union(polygons))
                for polygon in _polygons(missing):
                    for face in constrained_delaunay_triangles(polygon).geoms:
                        if face.area <= 1e-8:
                            continue
                        a, b, c = list(face.exterior.coords)[:3]
                        for px, pz in (a, c, b) if face.exterior.is_ccw else (a, b, c):
                            indices.append(len(kinds))
                            kinds.append(0)
                            positions.extend((px - ox, datum, pz - oz))
                        area += face.area
                        changed = True
            if len(indices) > begin:
                ranges.extend((cell, begin, len(indices) - begin))
        chunks.append({**chunk, 'positions': positions, 'kinds': kinds, 'indices': indices, 'cellRanges': ranges}
                      if changed else chunk)
    return {**surface, 'chunks': chunks}, area


def apply_keyuan_underpass(payload, report):
    spec = json.loads(SOURCE.read_text())
    surface = payload['terrainSurface']
    if surface.get('keyuanUnderpass') == spec:
        return
    if 'keyuanUnderpass' in surface:
        raise ValueError('Rebuild the underlying terrain before replacing the Keyuan underpass')
    graph = payload['roadGraph']
    links = {}
    for edge, meta in zip(graph['links'], graph['metadata'], strict=True):
        links.setdefault(meta['osmId'], []).append((edge, meta))
    if not set(spec['tunnels']) <= links.keys():
        return
    tunnels = [links[identity][0] for identity in spec['tunnels']]
    if any(not meta['tunnel'] or meta['layer'] != -1 or len(links[meta['osmId']]) != 1 for _, meta in tunnels):
        raise ValueError('Missing unique source edges for both Keyuan tunnel bores')
    ends = {node for edge, _ in tunnels for node in edge[:2]}
    feeders = [edge for identity in spec['feeders'] for edge, meta in links[identity]
               if ends.intersection(edge[:2]) and meta['heightSource'] == 'terrain']
    if len(feeders) != 4 or not ends <= {node for edge in feeders for node in edge[:2]}:
        raise ValueError('Keyuan tunnel feeders lack four shared source nodes')
    merge_edges = [edge for edge, meta in links[spec['southMerge']] if meta['heightSource'] == 'terrain'
                   and any(node in feeder[:2] for feeder in feeders for node in edge[:2])]
    if len(merge_edges) != 1:
        raise ValueError('Keyuan south approach is missing its source merge')

    def corridor(edge):
        return LineString(_source_points(graph, edge)).buffer(edge[3] / 2 + EDGE_PAD_M, cap_style='flat')

    roadway = unary_union([corridor(edge) for edge, _ in tunnels] + [corridor(edge) for edge in feeders])
    tunnel_width = unary_union([corridor(edge) for edge, _ in tunnels])
    minx, _, maxx, _ = roadway.bounds
    north, south = spec['northPortalZ'], spec['southPortalZ']
    datum, floor, grade = spec['datumM'], spec['boreFloorM'], spec['approachGrade']
    approach_length = (datum - floor) / grade
    north_region = box(minx - 2, north - approach_length, maxx + 2, north)
    south_region = box(minx - 170, south, maxx + 2, south + approach_length)
    roof = box(minx - 2, north, maxx + 2, south)
    protected = unary_union([LineString(_source_points(graph, edge)).buffer(edge[3] / 2)
                             for identity in spec['crossings'] for edge, _ in links[identity]])
    merge_corridor = corridor(merge_edges[0])
    core = roadway.intersection(north_region.union(south_region)).union(merge_corridor.intersection(south_region))
    region = core.buffer(SHOULDER_M).intersection(north_region.union(south_region))
    if protected.intersection(region).area > 1e-6:
        raise ValueError('Keyuan approaches would grade a source crossing')
    sampler = _SurfaceSampler(surface)
    for edge, _ in tunnels:
        line = LineString(_source_points(graph, edge))
        mid = line.interpolate(line.length / 2)
        if not math.isclose(sampler(mid.x, mid.y) or 0, datum, abs_tol=0.01):
            raise ValueError('Keyuan roof repair requires the reviewed local flat datum')

    west = min(point[0] for edge in feeders for point in _source_points(graph, edge)
               if south < point[1] < south + approach_length + 1) - 8 - EDGE_PAD_M
    merge_grade = spec['mergeGrade']
    shift = grade / math.sqrt(merge_grade ** 2 - grade ** 2)

    def elevation(point):
        x, z = point.x, point.y
        if z <= north:
            return floor + grade * (north - z)
        # 南端斜向合流只有向西超出主断面时才改用三维纵断面连续的距离包络。
        branch_x = max(0, west - x)
        branch_z = max(south, z - branch_x * shift)
        return floor + grade * (branch_z - south) + merge_grade * math.hypot(branch_x, z - branch_z)

    def shoulder_height(point, height):
        weight = max(0, 1 - point.distance(core) / SHOULDER_M)
        return height - max(0, height - elevation(point)) * weight

    seams = []
    for edge, _ in tunnels:
        points = _source_points(graph, edge)
        for center, inner in [(points[0], points[1]), (points[-1], points[-2])]:
            x, z = center
            length = math.dist(center, inner)
            half = edge[3] / 2 + EDGE_PAD_M + SEAM_OVERLAP_M
            nx, nz = (inner[1] - z) * half / length, (x - inner[0]) * half / length
            seams.append(LineString([(x + nx, z + nz), (x - nx, z - nz)])
                         .buffer(SEAM_OVERLAP_M, cap_style='flat'))
    seams = unary_union(seams)
    repair = tunnel_width.buffer(0.30).intersection(roof).union(seams)
    surface, repaired_area = _restore_roof(surface, repair, datum)
    surface, _, _ = _clip_terrain(surface, {}, [
        (core, lambda point, height: min(height, elevation(point))),
        (region, shoulder_height)
    ], grade_step=1)
    surface, cut_area = cut_ground_openings(surface, tunnel_width.difference(roof.union(seams)))
    original = payload['terrainSurface']
    changed = [chunk['id'] for chunk, old in zip(surface['chunks'], original['chunks'], strict=True) if chunk is not old]
    payload['terrainSurface'] = {**surface, 'keyuanUnderpass': spec}
    report['keyuanUnderpass'] = {**spec, 'changedTerrainChunks': changed,
                                'restoredRoofM2': round(repaired_area, 3), 'cutM2': round(cut_area, 3)}
    report['terrainSurface'].update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                                    triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']))
