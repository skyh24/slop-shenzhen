"""购物公园基线离线审计，读取正式 JSON 包和实际沥青几何。"""

import argparse
import gzip
import json
from pathlib import Path
import subprocess

from shapely import get_parts, make_valid, union_all
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.ops import polygonize

from geo import ORIGIN_LAT, ORIGIN_LON, project, project_coords
from package_validation import ring_points, sha256

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'data/source'
PRECISION_M = 0.001


def wgs84_box(bounds):
    west, south, east, north = bounds
    return box(*project(west, north), *project(east, south))


def source_polygon(rings):
    outer, *holes = [project_coords(ring) for ring in rings]
    shape = Polygon(outer, holes)
    if not shape.is_valid or shape.is_empty:
        raise ValueError('Invalid source polygon')
    return shape


def packaged_polygon(rings):
    outer, *holes = [ring_points(ring) for ring in rings]
    return Polygon(outer, holes)


def clip_polygon(shape, sample):
    if shape.is_empty or not sample.intersects(box(*shape.bounds)):
        return Polygon()
    # 正式包保留少数退化轮廓。计入可还原的面，忽略零面积的线和点。
    if not shape.is_valid:
        shape = make_valid(shape)
        shape = union_all([part for part in get_parts(shape) if part.geom_type in ('Polygon', 'MultiPolygon')])
    return shape.intersection(sample)


def triangle(chunk, indices):
    ox, oz = chunk['origin']
    positions = chunk['positions']
    return Polygon([(ox + positions[i], oz + positions[i + 2]) for i in indices])


def surface_masks(terrain, road_chunks, sample):
    paved, mixed, asphalt = [], [], []
    for chunk in terrain['chunks']:
        for a, b, c in zip(*[iter(chunk['indices'])] * 3, strict=True):
            count = sum(chunk['kinds'][i] == 3 for i in (a, b, c))
            if count:
                shape = clip_polygon(triangle(chunk, (3 * a, 3 * b, 3 * c)), sample)
                if shape.area > 0:
                    (paved if count == 3 else mixed).append(shape)
    for chunk in road_chunks:
        for i in range(0, len(chunk['positions']), 9):
            shape = clip_polygon(triangle(chunk, (i, i + 3, i + 6)), sample)
            if shape.area > 0:
                asphalt.append(shape)
    return tuple(union_all(parts, grid_size=PRECISION_M) for parts in (paved, mixed, asphalt))


def boundary_lines(graph, osm_ids, sample):
    lines = []
    widths = set()
    for link, meta in zip(graph['links'], graph['metadata'], strict=True):
        identity = meta['osmId']
        if identity not in osm_ids or meta['heightSource'] != 'terrain' or any(
            meta[key] for key in ('bridge', 'tunnel', 'layer')
        ):
            continue
        a, b, name, width, _, _, inner = link
        coords = graph['nodes'][2 * a:2 * a + 2] + inner + graph['nodes'][2 * b:2 * b + 2]
        line = LineString(zip(coords[::2], coords[1::2], strict=True))
        if line.intersects(sample):
            lines.append(line)
            widths.add((identity, graph['names'][name], width, meta['widthSource']))
    if set(osm_ids) != {row[0] for row in widths}:
        raise ValueError('Missing at-grade boundary road in the sample')
    return lines, [
        {'osmId': identity, 'name': name, 'widthM': width, 'widthSource': source}
        for identity, name, width, source in sorted(widths)
    ]


def cut_block(lines, asphalt, seed):
    candidates = [ring for ring in polygonize(union_all(lines)) if ring.contains(seed)]
    if len(candidates) != 1:
        raise ValueError('Expected one closed at-grade road ring for the block seed')
    ring = candidates[0]
    # 取靠近街块内部的一侧车行边。两块之间的双向车道与中央分隔带均留在走廊。
    off_road = ring.difference(asphalt)
    block = next((part for part in get_parts(off_road) if part.contains(seed)), None)
    if block is None:
        raise ValueError('The block seed is on asphalt')
    return ring, block, off_road.area - block.area


def rounded(value):
    return round(value, 3)


def area_stats(area, paved, asphalt, buildings, green):
    generated = area.intersection(paved)
    occupied = union_all([asphalt, buildings, green])
    return {
        'areaM2': rounded(area.area),
        'asphaltM2': rounded(area.intersection(asphalt).area),
        'buildingFootprintM2': rounded(area.intersection(buildings).area),
        'packagedGreenM2': rounded(area.intersection(green).area),
        'packagedPavingM2': rounded(generated.area),
        'pavingOnAsphaltM2': rounded(generated.intersection(asphalt).area),
        'pavingUnderBuildingFootprintsM2': rounded(generated.intersection(buildings).area),
        'pavingOnPackagedGreenM2': rounded(generated.intersection(green).area),
        'pavingOutsideAsphaltBuildingsAndGreenM2': rounded(generated.difference(occupied).area),
    }


def sample_buildings(city, sample):
    table = city['buildings']
    rows = []
    for i, rings in enumerate(table['rings']):
        shape = clip_polygon(packaged_polygon(rings), sample)
        if shape.area > 0:
            name_index = table['name'][i]
            rows.append((shape, {
                'id': table['id'][i],
                'name': city['names'][name_index] if name_index >= 0 else None,
                'role': city['enums']['buildingRole'][table['role'][i]],
                'upstreamFamily': city['enums']['upstreamFamily'][table['upstream'][i]],
                'heightSource': city['enums']['heightSource'][table['src'][i]],
                'minHeightM': table['minH'][i],
            }))
    return rows


def surface_report(city, spec, datum, terrain, road_chunks, sample):
    paved, mixed, asphalt = surface_masks(terrain, road_chunks, sample)
    if asphalt.is_empty:
        raise ValueError('No rendered at-grade asphalt in the audit sample')
    green = union_all([clip_polygon(packaged_polygon(rings), sample) for rings in city['green']])
    building_rows = sample_buildings(city, sample)
    buildings = union_all([shape for shape, _ in building_rows])
    pilot = next(row for row in datum['structuralBaselinePilots'] if row['id'] == spec['structuralPilotId'])
    pilot_area = wgs84_box(pilot['boundsWgs84'])
    source_rows = {row['osmId']: row for row in datum['commercial']}
    blocks, source_areas = [], []
    covered = []
    for block in spec['blocks']:
        seed = Point(project(*block['seedWgs84']))
        lines, roads = boundary_lines(city['roadGraph'], block['boundaryWayIds'], sample)
        ring, shape, fragments_area = cut_block(lines, asphalt, seed)
        if not sample.covers(ring):
            raise ValueError(f'Block crosses the audit boundary: {block["id"]}')
        if any(shape.intersection(previous).area > PRECISION_M ** 2 for previous in covered):
            raise ValueError('Street blocks overlap')
        covered.append(shape)
        row = source_rows[block['sourceAreaOsmId']]
        source = source_polygon(row['polygonWgs84']).intersection(sample)
        stats = area_stats(source, paved, asphalt, buildings, green)
        overlap = [
            {**identity, 'footprintInSourceM2': rounded(within_source.area),
             'pavingOverlapM2': rounded(within_source.intersection(paved).area)}
            for footprint, identity in building_rows
            if (within_source := footprint.intersection(source)).area > 0
        ]
        source_areas.append(source)
        blocks.append({
            'id': block['id'], 'boundaryRoads': roads, 'boundaryXZ': mapping(shape),
            'centerlineRingM2': rounded(ring.area), 'blockM2': rounded(shape.area),
            'disconnectedNonAsphaltM2': rounded(fragments_area),
            'boundaryCenterlineWithoutAsphaltM': rounded(ring.boundary.difference(asphalt.buffer(PRECISION_M)).length),
            'source': {'osmId': row['osmId'], 'tag': row['tag'], 'sourceUrl': row['sourceUrl'],
                       **stats, 'insideDerivedBlockM2': rounded(source.intersection(shape).area),
                       'insideStructuralPilotM2': rounded(source.intersection(pilot_area).area),
                       'pavingInsideStructuralPilotM2': rounded(source.intersection(pilot_area).intersection(paved).area)},
            'buildingRecords': overlap,
            # 无带边界的公开开放地面证据时，未知值不能由包内铺装或建筑差集填充。
            'publicWalkableAreaM2': None,
        })
    return {
        'sample': {**area_stats(sample, paved, asphalt, buildings, green),
                   'mixedPavingTriangleM2': rounded(mixed.area),
                   'pavingOutsideSourceAreasM2': rounded(paved.difference(union_all(source_areas)).area)},
        'blocks': blocks,
        'metroEntrances': [entry for entry in city['metro']['entrances']
                           if entry['id'] in spec['metroEntranceOsmIds']],
    }


def main():
    parser = argparse.ArgumentParser(description='Audit the Shopping Park city package without rebuilding it.')
    parser.add_argument('--output', type=Path, help='Optional local JSON report path')
    args = parser.parse_args()
    spec = json.loads((SOURCE / 'shopping-park-audit.json').read_text())
    datum = json.loads((SOURCE / 'urban-datum.json').read_text())
    if (datum['osmSnapshotId'], datum['osmSnapshotSha256']) != (spec['snapshot']['id'], spec['snapshot']['sha256']):
        raise ValueError('Urban datum and audit refer to different OSM snapshots')
    hashes = {name: sha256(ROOT / 'js' / name) for name in spec['baseline']['cityPackages']}
    if hashes != spec['baseline']['cityPackages']:
        raise ValueError('City packages do not match the registered Shopping Park baseline')
    with gzip.open(ROOT / 'js/sz-city.json.gz', 'rt') as stream:
        city = json.load(stream)
    if city['origin'] != [ORIGIN_LON, ORIGIN_LAT] or city['version'] != 2:
        raise ValueError('Expected the Shenzhen metre frame and JSON v2 city package')
    sample = wgs84_box(spec['boundsWgs84'])
    surface = city['terrainSurface']
    size = surface['chunkSize']
    chunks = [chunk for chunk in surface['chunks']
              if sample.intersects(box(*chunk['origin'], *(coordinate + size for coordinate in chunk['origin'])))]
    terrain = {**surface, 'chunks': chunks}
    roads = subprocess.run(
        ['node', str(Path(__file__).with_name('shopping-park-road-surface.mjs'))],
        input=json.dumps({'roadGraph': city['roadGraph'], 'terrainSurface': terrain}),
        text=True, stdout=subprocess.PIPE, check=True,
    )
    report = {
        'baseline': spec['baseline'], 'checkedAt': spec['checkedAt'], 'boundsWgs84': spec['boundsWgs84'],
        'originWgs84': city['origin'], 'areaUnits': 'm²', 'areaPlane': 'XZ', 'unionPrecisionM': PRECISION_M,
        **surface_report(city, spec, datum, terrain, json.loads(roads.stdout), sample),
    }
    result = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(result)
    else:
        print(result, end='')


if __name__ == '__main__':
    main()
