"""从已审核的地面断面和公园边界生成局部种植与步行样段。"""

import math

from shapely.geometry import LineString, Polygon, box
from shapely.ops import linemerge, unary_union

from commercial_paving import ground_carriageway_mask
from package_validation import ring_points
from road_frontage import _encode_surface, _lines, _polys


def decoded_polygon(rings):
    outer, *holes = map(ring_points, rings)
    return Polygon(outer, holes)


def between(first, second, bounds):
    axes = []
    for line in (first, second):
        points = list(max(_lines(line.intersection(bounds)), key=lambda part: part.length).coords)
        axes.append(points if points[0][0] < points[-1][0] else points[::-1])
    return Polygon(axes[0] + axes[1][::-1])


def compile_landscape(payload, spec, graph, road_lines):
    if not spec:
        return None
    frontage = payload['roadFrontage']
    by_id = {row['id']: row for row in frontage['features']}
    by_way = {}
    for i, (link, meta) in enumerate(zip(graph['links'], graph['metadata'], strict=True)):
        if meta['heightSource'] == 'terrain':
            by_way.setdefault(meta['osmId'], []).append(road_lines[i])
    patches, trees = [], []
    median = by_id['beihuan-xinzhou:median']
    ring = Polygon(list(zip(median['outlines'][0][::2], median['outlines'][0][1::2])))
    seed = ring.buffer(-0.45)
    flower = unary_union([part.buffer(-0.26) for part in _polys(seed) if part.area > 4])
    if not flower.is_empty:
        patches.append(dict(_encode_surface('flower-band', median['sourceIds'], flower),
                            id='beihuan-xinzhou:flower-bed', color='flowers', offsetM=median['riseM'] + 0.02))
    for row in spec['treeBelts']:
        main, side = [max(_lines(linemerge([line for way in chain for line in by_way[way]])),
                          key=lambda line: line.length) for chain in row['axes']]
        bounds = box(*row['boundsXZ'])
        space = between(main, side, bounds)
        occupied, _ = ground_carriageway_mask(space, graph)
        belt = space.difference(occupied.buffer(4.6)).buffer(-0.7)
        if not belt.is_valid:
            raise ValueError(f"Invalid tree belt: {row['id']}")
        patches.append(dict(_encode_surface('median', sum(row['axes'], []), belt), id=row['id'],
                            color='grass', offsetM=0.015))
        for part in sorted(_polys(belt), key=lambda p: p.bounds):
            if part.area < 60:
                continue
            for x in range(math.ceil(part.bounds[0] / 16) * 16, int(part.bounds[2]), 16):
                section = part.intersection(LineString([(x, part.bounds[1] - 1), (x, part.bounds[3] + 1)]))
                for run in _lines(section):
                    if run.length < 5:
                        continue
                    point = run.interpolate(0.5, normalized=True)
                    trees.append({'id': f"{row['id']}:{len(trees)}", 'x': round(point.x, 2), 'z': round(point.y, 2),
                                  'height': 7.2, 'crown': 5.2, 'speciesName': 'ficus',
                                  'positionSource': 'simulated-road-greenbelt', 'appearanceSource': 'species-estimate'})
    park = spec['park']
    # 源公园边界只用于确认覆盖与用地。园内走线是本项目的连接设计。
    source = next(row for row in payload['mapRegions']['regions'] if row['id'] == f"osm:{park['areaWay']}")
    area = unary_union([decoded_polygon(rings) for rings in source['rings']])
    path = LineString(park['pathXZ'])
    if not area.buffer(15).covers(LineString(park['pathXZ'][:-1])):
        raise ValueError('The park route leaves the reviewed area')
    paving = path.buffer(2.0, cap_style='flat', join_style='round')
    occupied, _ = ground_carriageway_mask(paving, graph)
    if occupied.area > 0.01:
        raise ValueError('The park route crosses a ground carriageway')
    patches.append(dict(_encode_surface('paving', [park['areaWay'], park['connectionWay']], paving),
                        id=park['id'], color='path', offsetM=0.025))
    return {'patches': [patch for patch in patches if patch['trianglesXZ']], 'trees': trees,
            'publicPath': {'id': park['id'], 'points': park['pathXZ'], 'widthM': 4, 'mode': 'walk'}}
