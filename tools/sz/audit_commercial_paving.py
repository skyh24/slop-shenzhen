"""对照商业源范围与正式包铺装、沥青及建筑足迹，结果写到标准输出。"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

from shapely import make_valid
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from geo import ORIGIN_LAT, ORIGIN_LON, project, project_coords
from package_validation import ring_points

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'data/source/urban-datum.json'
PACKAGE = ROOT / 'js/sz-city.json.gz'
ROAD_AUDIT = Path(__file__).with_name('audit_commercial_paving_roads.cjs')


def source_parcels(manifest):
    result = []
    for entry in manifest['commercial']:
        outer, *holes = [project_coords(ring) for ring in entry['polygonWgs84']]
        parcel = Polygon(outer, holes)
        if not parcel.is_valid or parcel.area <= 0:
            raise ValueError(f'Invalid commercial source polygon: {entry["osmId"]}')
        result.append((entry, parcel))
    if not result or len({entry['osmId'] for entry, _ in result}) != len(result):
        raise ValueError('Expected unique commercial source IDs')
    return result


def pilot_core(payload):
    # 以包内生效的样区为准，便于区分早于地坪样板的基线包。
    report = payload['terrain']['processing'].get('urbanDatum', {})
    return unary_union([box(*row['boundsXZ']) for row in report.get('pilots', {}).values()])


def paving_polygons(surface, extent):
    size = surface['chunkSize']
    for chunk in surface['chunks']:
        ox, oz = chunk['origin']
        if not extent.intersects(box(ox, oz, ox + size, oz + size)):
            continue
        positions, indices, kinds = chunk['positions'], chunk['indices'], chunk['kinds']
        for i in range(0, len(indices), 3):
            triangle = indices[i:i + 3]
            if len(triangle) == 3 and all(kinds[index] == 3 for index in triangle):
                yield Polygon([(positions[index * 3] + ox, positions[index * 3 + 2] + oz) for index in triangle])


def building_polygons(buildings, extent):
    for encoded in buildings['rings']:
        outer, *holes = [ring_points(ring) for ring in encoded]
        polygon = Polygon(outer, holes)
        if extent.intersects(polygon.envelope):
            yield polygon if polygon.is_valid else make_valid(polygon)


def measure(parcel, core, paving, asphalt, buildings):
    paved = paving.intersection(parcel)
    return {
        'sourceAreaM2': parcel.area,
        'pilotCoreAreaM2': parcel.intersection(core).area,
        'emittedPavingM2': paved.area,
        'pavingAsphaltOverlapM2': paved.intersection(asphalt).area,
        'pavingBuildingFootprintOverlapM2': paved.intersection(buildings).area,
    }


def audit(package, parcels):
    compressed = package.read_bytes()
    raw = gzip.decompress(compressed)
    payload = json.loads(raw)
    if payload['version'] != 2 or payload['origin'] != [ORIGIN_LON, ORIGIN_LAT]:
        raise ValueError('Expected a Shenzhen JSON v2 city package with the current origin')
    whole = unary_union([parcel for _, parcel in parcels])
    extent = whole.envelope
    core = pilot_core(payload)
    paving = unary_union(list(paving_polygons(payload['terrainSurface'], extent)))
    relevant = paving.intersection(extent).envelope
    if relevant.is_empty:
        asphalt, buildings = Polygon(), Polygon()
    else:
        road_result = subprocess.run(
            ['node', str(ROAD_AUDIT), json.dumps(relevant.bounds)], input=raw, capture_output=True,
        )
        if road_result.returncode:
            raise RuntimeError(road_result.stderr.decode().strip())
        asphalt = unary_union([Polygon(triangle) for triangle in json.loads(road_result.stdout)])
        buildings = unary_union(list(building_polygons(payload['buildings'], relevant)))
    return {
        'package': str(package),
        'sha256': hashlib.sha256(compressed).hexdigest(),
        'terrainGridStepM': payload['terrainSurface']['grid']['step'],
        'parcels': {entry['osmId']: measure(parcel, core, paving, asphalt, buildings) for entry, parcel in parcels},
        'union': measure(whole, core, paving, asphalt, buildings),
    }


def rounded(value):
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    return round(value, 2) if isinstance(value, float) else value


def main():
    parser = argparse.ArgumentParser(description='Audit commercial paving in Shenzhen JSON city packages')
    parser.add_argument('--package', type=Path, default=PACKAGE)
    parser.add_argument('--baseline', type=Path, help='Compare with another gzip JSON v2 package')
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    args = parser.parse_args()
    raw_manifest = args.manifest.read_bytes()
    manifest = json.loads(raw_manifest)
    parcels = source_parcels(manifest)
    current = audit(args.package, parcels)
    result = {
        'manifestSha256': hashlib.sha256(raw_manifest).hexdigest(),
        'reviewedOsmSnapshotSha256': manifest['osmSnapshotSha256'],
        'sourceObjects': {entry['osmId']: {key: entry[key] for key in ('name', 'tag', 'sourceUrl')} for entry, _ in parcels},
        'current': current,
    }
    if args.baseline:
        baseline = audit(args.baseline, parcels)
        result['baseline'] = baseline
        result['deltaM2'] = {
            'parcels': {identity: {metric: area - baseline['parcels'][identity][metric] for metric, area in metrics.items()}
                        for identity, metrics in current['parcels'].items()},
            'union': {metric: area - baseline['union'][metric] for metric, area in current['union'].items()},
        }
    print(json.dumps(rounded(result), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
