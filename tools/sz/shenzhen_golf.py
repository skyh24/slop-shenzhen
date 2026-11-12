"""原深高球场和北侧配套别墅带的局部地表派生。"""

import json
import math
from collections import Counter
from heapq import heapify, heappop, heappush
from pathlib import Path

import numpy as np
import osmium
from shapely import constrained_delaunay_triangles, contains_xy
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from land import _polys, _to_local
from package_validation import ring_points
from road_surface import CANDIDATES_PATH, _load_baseline_raster, _sample_raster
from roadgraph import graph_components
from roads import _num

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/shenzhen-golf-course.json'
PATH_WIDTH = {'service': 2.8, 'path': 1.55, 'footway': 1.8, 'residential': 4.2, 'unclassified': 3.6}
PAVED = {'asphalt', 'concrete', 'paving_stones', 'paved', 'sett', 'concrete:plates'}
UNPAVED = {'gravel', 'fine_gravel', 'compacted', 'ground', 'dirt', 'unpaved', 'sand', 'grass'}
RETAINED_TAGS = ('highway', 'surface', 'width', 'incline', 'bridge', 'tunnel', 'layer', 'service', 'oneway',
                 'access', 'foot', 'vehicle', 'motor_vehicle', 'motorcar', 'access:conditional',
                 'foot:conditional', 'motor_vehicle:conditional', 'opening_hours')


def _polygon(rings):
    outer, *holes = map(ring_points, rings)
    return Polygon(outer, holes)


def _lines(shape):
    if shape.geom_type == 'LineString' and shape.length >= 0.5:
        yield shape
    elif hasattr(shape, 'geoms'):
        for part in shape.geoms:
            yield from _lines(part)


def _site(osm, source):
    entry = next(item for item in osm['green'] if item['id'] == source['osmId'])
    if entry['tags'].get('leisure') != 'golf_course':
        raise ValueError('Unexpected Shenzhen Golf Course land-use tag')
    course = _to_local(entry['geom'])
    villa_ids = set(source['villaWays'])
    local_roads = {}
    for way in osm['roads']:
        tags = way['tags']
        if way['id'] in villa_ids or (tags.get('highway') in ('service', 'path', 'footway')
                                     and way['geom'].intersects(entry['geom'])):
            line = _to_local(way['geom'])
            if way['id'] in villa_ids or line.intersection(course).length >= 0.5:
                local_roads[way['id']] = line
    if not villa_ids <= local_roads.keys():
        raise ValueError('Missing reviewed villa lanes')
    # 球场北边的绿地源边界绕开了别墅带；用已审核的内部道路界定狭长范围。
    villas = unary_union([local_roads[identity] for identity in sorted(villa_ids)]).buffer(47).convex_hull
    return course, course.union(villas), local_roads


def _path_tags(pbf, ids):
    reader = osmium.FileProcessor(str(pbf), osmium.osm.WAY).with_filter(
        osmium.filter.IdFilter({int(identity.split('/')[1]) for identity in ids}))
    result = {}
    for way in reader:
        identity = f'way/{way.id}'
        result[identity] = {'version': way.version, 'tags': {key: way.tags[key] for key in RETAINED_TAGS
                                                           if key in way.tags}}
    if result.keys() != ids:
        raise ValueError('Missing reviewed golf course way tags')
    return result


def _compile_paths(pbf, course, extent, roads, villa_ids, approach_ids, obstacles):
    snapshots = _path_tags(pbf, set(roads))
    paths, areas = [], {'paved': [], 'aggregate': []}
    for identity, line in sorted(roads.items()):
        snapshot = snapshots[identity]
        tags = snapshot['tags']
        villa = identity in villa_ids
        boundary = extent if villa or identity in approach_ids else course
        kind = tags['highway']
        tagged_width = _num(tags.get('width'))
        width = tagged_width if tagged_width and tagged_width > 0 else PATH_WIDTH[kind]
        surface = tags.get('surface')
        material = ('paved' if surface in PAVED or (surface not in UNPAVED and villa) else 'aggregate')
        # 图示保留原线。桥缺独立支撑面时只记录源线，不用沿地铺装替代。
        elevated = tags.get('bridge', 'no') != 'no' or tags.get('tunnel', 'no') != 'no' or tags.get('layer', '0') != '0'
        geometry = line.intersection(boundary)
        segments = [[round(value, 3) for point in part.coords for value in point] for part in _lines(geometry)]
        if not elevated:
            strip = geometry.buffer(width / 2, quad_segs=3).intersection(boundary).difference(obstacles)
            areas[material].append(strip)
        paths.append({'osmId': identity, **snapshot, 'kind': 'garden-path',
                      'widthM': width, 'widthSource': 'osm-width' if tagged_width and tagged_width > 0 else 'visual-estimate',
                      'material': material, 'materialSource': 'osm-surface' if surface in PAVED | UNPAVED else 'visual-estimate',
                      'heightSource': 'unresolved-structure' if elevated else 'terrain',
                      'publicAccess': 'restricted' if tags.get('foot', tags.get('access')) in ('no', 'private') else 'unverified',
                      'serviceAccess': next((tags[key] for key in ('motorcar', 'motor_vehicle', 'vehicle')
                                             if key in tags), 'unverified'),
                      'segments': segments})
    # 同材质求并集，异材质只在接缝相接，避免路口重叠闪烁。
    paved = unary_union(areas['paved'])
    footprints = {'paved': paved, 'aggregate': unary_union(areas['aggregate']).difference(paved)}
    surfaces = []
    for material, geometry in footprints.items():
        triangles = [round(v, 4) for part in _polys(geometry) if part.area > 1e-6
                     for tri in constrained_delaunay_triangles(part).geoms
                     for xy in list(tri.exterior.coords)[:3] for v in xy]
        if triangles:
            surfaces.append({'id': f'golf-path:{material}', 'material': material, 'trianglesXZ': triangles,
                             'sourceIds': [path['osmId'] for path in paths if path['material'] == material
                                           and path['heightSource'] == 'terrain']})
    return paths, surfaces, unary_union(list(footprints.values()))


def _distance_weight(distance, span):
    value = min(1, max(0, distance / span))
    return value * value * (3 - 2 * value)


def _terrain_y(terrain, x, z):
    step, nx = terrain['step'], terrain['nx']
    gx, gz = (x - terrain['x0']) / step, (z - terrain['z0']) / step
    i, j = math.floor(gx), math.floor(gz)
    u, v = gx - i, gz - j
    a = j * nx + i
    h = terrain['heights']
    if u + v <= 1:
        y = (1 - u - v) * h[a] + u * h[a + 1] + v * h[a + nx]
    else:
        y = (1 - v) * h[a + 1] + (1 - u) * h[a + nx] + (u + v - 1) * h[a + nx + 1]
    return y * terrain['heightScale']


def _shore_probes(polygon, terrain):
    step, x0, z0 = (terrain[key] for key in ('step', 'x0', 'z0'))
    for ring in [polygon.exterior, *polygon.interiors]:
        points = []
        for (ax, az), (bx, bz) in zip(ring.coords, list(ring.coords)[1:]):
            cuts = {0.0}
            # 沿岸线在格点边界和东北—西南对角线处切分，岸顶复用对应的地表三角形。
            for a, b, origin in ((ax, bx, x0), (az, bz, z0), (ax + az, bx + bz, x0 + z0)):
                for index in range(math.floor((min(a, b) - origin) / step) + 1,
                                   math.ceil((max(a, b) - origin) / step)):
                    cuts.add((origin + step * index - a) / (b - a))
            points.extend((ax + t * (bx - ax), az + t * (bz - az)) for t in sorted(cuts))
        yield points


def _limit_relief_grade(target, baseline, nx, scale, step):
    # 向未改动边界和相邻格点限制单元高差；估计过渡不引入新台阶或挡土墙。
    neighbors = [(dz * nx + dx, math.floor(0.115 * step * math.hypot(dx, dz) / scale))
                 for dz in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dz]
    for index in target:
        target[index] = min([target[index], *(baseline[index + offset] + rise for offset, rise in neighbors
                                              if index + offset not in target)])
    queue = [(height, index) for index, height in target.items()]
    heapify(queue)
    while queue:
        height, index = heappop(queue)
        if height != target[index]:
            continue
        for offset, rise in neighbors:
            adjacent = index + offset
            if adjacent in target and target[adjacent] > height + rise:
                target[adjacent] = height + rise
                heappush(queue, (height + rise, adjacent))


def _relief(payload, extent, protected, ponds, source, previous):
    terrain = payload['terrain']
    step, nx, x0, z0 = (terrain[key] for key in ('step', 'nx', 'x0', 'z0'))
    heights = terrain['heights']
    boundary = extent.boundary
    # 每个变化格点所支撑的四个相邻单元全部位于样区；整条外围车行断面也留出一圈单元。
    support = step * math.sqrt(2)
    minx, minz, maxx, maxz = extent.bounds
    candidates = []
    for j in range(math.ceil((minz - z0) / step), math.floor((maxz - z0) / step) + 1):
        z = z0 + j * step
        for i in range(math.ceil((minx - x0) / step), math.floor((maxx - x0) / step) + 1):
            x = x0 + i * step
            if not contains_xy(extent, x, z):
                continue
            point = Point(x, z)
            weight = _distance_weight(min(point.distance(boundary), point.distance(protected)) - support, 80)
            if weight:
                candidates.append((j * nx + i, x, z, weight))
    if not candidates:
        raise ValueError('Missing golf terrain support cells')
    x, z = np.asarray([(x, z) for _, x, z, _ in candidates]).T
    samples = json.loads(CANDIDATES_PATH.read_text())['sources']
    records = [next(record for record in samples if record['id'] == source[key])
               for key in ('terrainSource', 'terrainComparison')]
    raster, comparison_raster = map(_load_baseline_raster, records)
    lons, lats = ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY
    dtm = _sample_raster(raster, lons, lats)
    comparison = _sample_raster(comparison_raster, lons, lats)
    if not np.isfinite(dtm).all() or not np.isfinite(comparison).all():
        raise ValueError('Missing modelled terrain samples in golf course')
    # 提取 FABDEM 低频起伏；两套模型的中位差用于视觉高程对齐。
    smooth = np.zeros_like(dtm)
    for dx in range(-2 * step, 2 * step + 1, step):
        for dz in range(-2 * step, 2 * step + 1, step):
            smooth += _sample_raster(raster, ORIGIN_LON + (x + dx) / KX, ORIGIN_LAT - (z + dz) / KY)
    adjustment = float(np.median(dtm - comparison)) / 2
    smooth = smooth / 25 - adjustment
    previous = {int(index): value for index, value in dict(previous).items()}
    for index, original in previous.items():
        heights[index] = original
    scale = terrain['heightScale']
    target = {index: round(heights[index] + (elevation / scale - heights[index]) * weight)
              for (index, _, _, weight), elevation in zip(candidates, smooth, strict=True)}
    _limit_relief_grade(target, heights, nx, scale, step)
    preliminary = heights.copy()
    for index, height in target.items():
        preliminary[index] = height
    preliminary_terrain = {**terrain, 'heights': preliminary}
    shore_probes = {}
    # 每塘独立取模型中心估值；仅在高出近岸时向下校正水位。
    for pond in ponds:
        point = pond['polygon'].representative_point()
        value = raster.sample(ORIGIN_LON + point.x / KX, ORIGIN_LAT - point.y / KY)
        if value is None:
            raise ValueError(f'Missing pond level estimate: {pond["osmId"]}')
        probes = list(_shore_probes(pond['polygon'], terrain))
        shore_probes[pond['osmId']] = probes
        shoreline = [_terrain_y(preliminary_terrain, px, pz) for ring in probes for px, pz in ring]
        pond['heightM'] = round(min(value - adjustment, float(np.percentile(shoreline, 15))) - 0.18, 2)
        pond['heightSource'] = 'fabdem-pond-centre-visual-estimate'
    for index, px, pz, weight in candidates:
        point = Point(px, pz)
        # 按最近一处源岸线做短距离收边；水面本身为单独的水平几何。
        nearest = min(ponds, key=lambda pond: pond['polygon'].boundary.distance(point))
        distance = nearest['polygon'].boundary.distance(point)
        if distance < 35:
            bank = (nearest['heightM'] + 0.25) / scale
            target[index] = round(target[index] + (bank - target[index]) * weight
                                  * (1 - _distance_weight(distance, 35)))
    _limit_relief_grade(target, heights, nx, scale, step)
    edits = {}
    for index, height in target.items():
        original = heights[index]
        if height != original:
            edits[index] = original
            heights[index] = height
    for pond in ponds:
        bank = [[(px, _terrain_y(terrain, px, pz), pz) for px, pz in ring] for ring in shore_probes[pond['osmId']]]
        min_bank = min(y for ring in bank for _, y, _ in ring)
        pond['heightM'] = min(pond['heightM'], math.floor((min_bank - 0.05) * 100) / 100)
        pond['banks'] = [[round(v, 5) for point in ring for v in point] for ring in bank]
    if not edits:
        raise ValueError('Golf course terrain did not change')
    changed = edits.keys() | previous.keys()
    changed_bounds = box(min(x0 + index % nx * step for index in changed) - step,
                         min(z0 + index // nx * step for index in changed) - step,
                         max(x0 + index % nx * step for index in changed) + step,
                         max(z0 + index // nx * step for index in changed) + step)
    chunks = []
    for chunk in payload['terrainSurface']['chunks']:
        cx, cz = chunk['origin']
        size = payload['terrainSurface']['chunkSize']
        if not box(cx, cz, cx + size, cz + size).intersects(changed_bounds):
            continue
        positions = chunk['positions']
        affected = False
        for offset in range(0, len(positions), 3):
            px, pz = cx + positions[offset], cz + positions[offset + 2]
            i, j = math.floor((px - x0) / step), math.floor((pz - z0) / step)
            a = j * nx + i
            if any(index in changed for index in (a, a + 1, a + nx, a + nx + 1)):
                positions[offset + 1] = _terrain_y(terrain, px, pz)
                affected = True
        if affected:
            chunks.append(chunk['id'])
    return {'gridOriginalHeights': {str(index): edits[index] for index in sorted(edits)}, 'changedChunks': chunks,
            'beforeRangeM': [round(min(edits.values()) * terrain['heightScale'], 2),
                             round(max(edits.values()) * terrain['heightScale'], 2)],
            'afterRangeM': [round(min(heights[i] for i in edits) * terrain['heightScale'], 2),
                            round(max(heights[i] for i in edits) * terrain['heightScale'], 2)],
            'visualDatumAdjustmentM': round(adjustment, 2),
            'comparisonMedianAbsoluteDifferenceM': round(float(np.median(np.abs(dtm - comparison))), 2),
            'comparisonP90AbsoluteDifferenceM': round(float(np.percentile(np.abs(dtm - comparison), 90)), 2),
            'comparisonCorrelation': round(float(np.corrcoef(dtm, comparison)[0, 1]), 3)}


def _foundations(buildings, terrain):
    result = []
    step, x0, z0 = (terrain[key] for key in ('step', 'x0', 'z0'))
    for identity, shape in buildings:
        if not shape.is_valid:
            continue
        minx, minz, maxx, maxz = shape.bounds
        heights = []
        for j in range(math.floor((minz - z0) / step), math.ceil((maxz - z0) / step)):
            z = z0 + j * step
            for i in range(math.floor((minx - x0) / step), math.ceil((maxx - x0) / step)):
                x = x0 + i * step
                a, b, c, d = (x, z), (x + step, z), (x, z + step), (x + step, z + step)
                for points in ((a, b, c), (b, c, d)):
                    for part in _polys(shape.intersection(Polygon(points))):
                        heights.extend(_terrain_y(terrain, px, pz) for px, pz in part.exterior.coords)
        if heights and max(heights) - min(heights) >= 0.12:
            result.append({'id': identity, 'baseY': math.ceil(max(heights) * 100) / 100,
                           'bottomY': (math.floor(min(heights) * 100) - 2) / 100})
    return result


def build_shenzhen_golf(payload, osm, pbf, report, *, previous=()):
    source = json.loads(MANIFEST.read_text())
    if source['version'] != 1 or source['osmSnapshotSha256'] != osm['sourceSha256']:
        raise ValueError('Golf course requires the reviewed OSM snapshot')
    course, extent, roads = _site(osm, source)
    villa_ids = set(source['villaWays'])
    approach_ids = set(source['approachWays'])
    if not approach_ids <= roads.keys():
        raise ValueError('Missing reviewed golf course approaches')
    graph = payload['roadGraph']
    kept, protected, removed = [], [], []
    nodes = graph['nodes']
    nearby = extent.buffer(50)
    for link, meta in zip(graph['links'], graph['metadata'], strict=True):
        if meta['osmId'] in villa_ids:
            removed.append(meta)
            continue
        kept.append((link, meta))
        start, end, _, width, _, _, inner = link
        line = LineString([nodes[2 * start:2 * start + 2], *zip(inner[::2], inner[1::2]), nodes[2 * end:2 * end + 2]])
        if line.intersects(nearby):
            protected.append(line.buffer(width / 2 + 5))
    if removed:
        graph['links'], graph['metadata'] = map(list, zip(*kept, strict=True))
        meta = graph['metadata']
        report['roadGraph'].update(links=len(meta), lengthKm=round(sum(row['lengthM'] for row in meta) / 1000, 2),
                                   widthSources=dict(Counter(row['widthSource'] for row in meta)),
                                   connectivity=graph_components(len(graph['nodeIds']), graph['links']))
    retained_nodes = {graph['nodeIds'][node] for link in graph['links'] for node in link[:2]}
    building_rows = payload['buildings']
    buildings = []
    minx, minz, maxx, maxz = extent.bounds
    for identity, rings, height in zip(building_rows['id'], building_rows['rings'], building_rows['minH'], strict=True):
        x, z = (value / 10 for value in rings[0][:2])
        if minx - 150 <= x <= maxx + 150 and minz - 150 <= z <= maxz + 150:
            polygon = _polygon(rings)
            if polygon.is_valid and extent.intersects(polygon):
                buildings.append((identity, polygon, height))

    ponds = []
    mapped = [(way['id'], _to_local(way['geom'])) for way in osm['water']
              if way['geom'].bounds and _to_local(way['geom'].envelope).intersects(course)]
    for rings in payload['water']:
        x, z = (value / 10 for value in rings[0][:2])
        if not (minx <= x <= maxx and minz <= z <= maxz):
            continue
        polygon = _polygon(rings)
        if not polygon.is_valid or not course.covers(polygon.representative_point()):
            continue
        identity, area = max(mapped, key=lambda row: row[1].intersection(polygon).area)
        if area.intersection(polygon).area < 0.95 * polygon.area:
            raise ValueError('Golf pond source polygon did not match the city shoreline')
        ponds.append({'osmId': identity, 'rings': rings, 'polygon': polygon})
    if not ponds:
        raise ValueError('Missing golf course ponds')
    built = unary_union([shape for _, shape, height in buildings if height == 0])
    city_roads = unary_union(protected)
    obstacles = built.union(city_roads).union(unary_union([pond['polygon'] for pond in ponds]))
    paths, surfaces, paving = _compile_paths(pbf, course, extent, roads, villa_ids, approach_ids, obstacles)
    relief = _relief(payload, extent, city_roads, ponds, source, previous)
    foundations = _foundations([(identity, shape) for identity, shape, height in buildings
                                if height == 0 and extent.covers(shape)], payload['terrain'])
    pond_records = [{key: value for key, value in pond.items() if key != 'polygon'} for pond in ponds]
    payload['golfCourse'] = {'version': 1, 'osmId': source['osmId'], 'publicAccess': source['publicAccess'],
                             'paths': paths, 'surfaces': surfaces, 'ponds': pond_records, 'foundations': foundations}
    report['shenzhenGolfCourse'] = {**source, 'boundsXZ': list(extent.bounds), 'boundsWgs84': [
        ORIGIN_LON + minx / KX, ORIGIN_LAT - maxz / KY, ORIGIN_LON + maxx / KX, ORIGIN_LAT - minz / KY],
        'courseAreaM2': round(course.area, 2), 'terrain': relief,
        'paths': [{**{key: value for key, value in path.items() if key != 'segments'},
                   'segmentCount': len(path['segments'])} for path in paths],
        'pavingAreaM2': round(paving.area, 2), 'suppressedDriveWayIds': sorted(villa_ids),
        'unverifiedGateNodeIds': sorted(retained_nodes.intersection(
            f'node/{ref}' for way in osm['roads'] if way['id'] in roads for ref in way['nodeRefs'])),
        'ponds': [{key: value for key, value in pond.items() if key not in ('rings', 'banks')} for pond in pond_records],
        'foundations': foundations}
