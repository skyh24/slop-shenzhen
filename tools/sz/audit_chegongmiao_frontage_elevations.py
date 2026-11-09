"""核对车公庙 D1 图纸和中国有色大厦北侧高程证据，只读源和城市包。"""

import gzip
import hashlib
import json
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points

from audit_road_elevations import ElevationTrace, profile, read_quality
from copernicus import CopernicusSampler
from geo import project

ROOT = Path(__file__).resolve().parents[2]
D1 = 1491790883
WAYS = {
    'side-road-centerline': 1155178377,
    'sidewalk-centerline': 958548497,
    'runyuan-centerline': 854919710,
    'nonferrous-footprint': 135907001,
    'nonferrous-north-podium': 1163682857,
    'metro-property-footprint': 1163682854,
}
POINT_TAGS = ('ref', 'railway', 'highway', 'name', 'building', 'building:part', 'height', 'min_height',
              'layer', 'ele', 'source:ele', 'ele:source', 'ele:datum', 'vertical_datum')

# 图纸点位由锁定 PDF 的标高符号读出。原点在纸面左上，单位为 PDF 点。
PAPER_MARKS = {
    13: [
        ('municipal-turn-area', 'municipal', 835.76, 421.60, 6.145),
        ('garden-path-west', 'design', 417.95, 525.54, 7.045),
        ('garden-path-east', 'design', 607.39, 525.54, 6.450),
        ('driveway-curb-north-top', 'design', 707.12, 512.51, 6.620),
        ('driveway-curb-north-bottom', 'design', 707.12, 512.51, 6.470),
        ('driveway-curb-south-top', 'design', 706.41, 613.48, 6.600),
        ('driveway-curb-south-bottom', 'design', 706.41, 613.48, 6.450),
    ],
    23: [
        ('landing-north', 'original-spot', 90.34, 195.74, 7.040),
        ('landing-south', 'original-spot', 90.34, 418.52, 7.150),
        ('green-north-west', 'original-spot', 263.48, 242.71, 7.015),
        ('green-north-east', 'original-spot', 569.22, 288.68, 6.410),
        ('green-middle-west', 'original-spot', 261.45, 456.92, 7.045),
        ('green-middle-east', 'original-spot', 574.04, 448.92, 6.450),
        ('green-south-west', 'original-spot', 261.45, 648.55, 7.070),
        ('green-south-east', 'original-spot', 574.04, 656.32, 6.490),
    ],
}


def locked_source(source):
    path = ROOT / source['file']
    with path.open('rb') as handle:
        if hashlib.file_digest(handle, 'sha256').hexdigest() != source['sha256']:
            raise ValueError(f'Source does not match the locked snapshot: {source["id"]}')
    return path


def point_tags(entity):
    return {key: entity.tags[key] for key in POINT_TAGS if key in entity.tags}


def read_features(pbf):
    roles = {way: role for role, way in WAYS.items()}
    processor = (osmium.FileProcessor(str(pbf)).with_locations()
                 .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY))
                 .with_filter(osmium.filter.IdFilter([D1, *roles])))
    features = {}
    for entity in processor:
        if entity.is_node() and entity.id == D1:
            features['d1'] = (Point(*project(entity.lon, entity.lat)), point_tags(entity), entity.version)
        elif entity.is_way() and entity.id in roles:
            coordinates = [project(node.lon, node.lat) for node in entity.nodes]
            is_building = 'building' in entity.tags or 'building:part' in entity.tags
            geometry = Polygon(coordinates) if is_building else LineString(coordinates)
            features[roles[entity.id]] = (geometry, point_tags(entity), entity.version)
    if set(features) != {'d1', *WAYS}:
        raise ValueError('Reviewed frontage feature is missing from the locked snapshot')
    return features


def nearby_osm_elevations(pbf, extent):
    nodes = (osmium.FileProcessor(str(pbf))
             .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE))
             .with_filter(osmium.filter.KeyFilter('ele')))
    candidates = []
    for node in nodes:
        x, z = project(node.lon, node.lat)
        if extent.covers(Point(x, z)):
            candidates.append({'osmId': f'node/{node.id}', 'version': node.version, 'xz': [x, z],
                               'lonLat': [node.lon, node.lat], 'tags': point_tags(node)})
    return candidates


def northern_intersection(geometry, x):
    _, z_min, _, z_max = geometry.bounds
    hit = geometry.intersection(LineString([(x, z_min - 1), (x, z_max + 1)]))
    if hit.is_empty:
        raise ValueError('Audit section no longer intersects its reviewed source feature')
    return Point(x, hit.bounds[1])


def audit_paper(source):
    marks = {page: [{'id': identity, 'kind': kind, 'paperPt': [u, v], 'sourceHeightM': height}
                    for identity, kind, u, v, height in entries] for page, entries in PAPER_MARKS.items()}
    original = {row['id']: row['sourceHeightM'] for row in marks[23]}
    drops = {cross: round(original[f'green-{cross}-west'] - original[f'green-{cross}-east'], 3)
             for cross in ('north', 'middle', 'south')}
    length, labeled_grade = 12.6, 4.54
    ramp_drop = marks[13][1]['sourceHeightM'] - marks[13][2]['sourceHeightM']
    return {'source': source, 'publicationDate': '2022-01-25', 'surveyDate': None,
            'asBuiltVerified': False, 'planCrs': None, 'verticalDatum': None, 'projectTransform': None,
            'marksByPage': marks, 'originalWestToEastDropsM': drops,
            'gardenPathDesign': {'lengthM': length, 'widthM': 2.5, 'printedGradePercent': labeled_grade,
                                 'candidateEndpointGradePercent': round(100 * ramp_drop / length, 4),
                                 'candidateEndpointResidualM': round(ramp_drop - length * labeled_grade / 100, 4)},
            'curbDesignHeightM': 0.15}


def main():
    sources = {source['id']: source for source in json.loads((ROOT / 'data/source/sources.json').read_text())['sources']}
    pdf, osm = sources['chegongmiao-d1-landscape-2022'], sources['osm-guangdong']
    locked_source(pdf)
    pbf = locked_source(osm)
    city = (ROOT / 'js/sz-city.json.gz').read_bytes()
    terrain = json.loads(gzip.decompress(city))['terrain']
    prefix = 'copernicus-dem-'
    hashes = {identity.removeprefix(prefix): source['sha256']
              for identity, source in sources.items() if identity.startswith(prefix)}
    sampler = CopernicusSampler(ROOT / 'data/raw/terrain/copernicus', hashes)
    trace = ElevationTrace(terrain, sampler)
    features = read_features(pbf)
    entrance, tags, version = features['d1']
    d1 = {'osmId': f'node/{D1}', 'version': version, 'tags': tags, **trace.point(entrance.x, entrance.y)}
    nearby = []
    for role, way in WAYS.items():
        geometry, tags, version = features[role]
        nearest = nearest_points(entrance, geometry)[1]
        nearby.append({'role': role, 'osmId': f'way/{way}', 'version': version, 'tags': tags,
                       'distanceFromD1M': entrance.distance(nearest), **trace.point(nearest.x, nearest.y)})

    cuts = []
    footprint = features['nonferrous-footprint'][0]
    x_min, z_min, x_max, _ = footprint.bounds
    cut_roles = ('side-road-centerline', 'sidewalk-centerline', 'runyuan-centerline', 'nonferrous-footprint')
    for label, fraction in (('west', 0.2), ('middle', 0.5), ('east', 0.8)):
        x = x_min + fraction * (x_max - x_min)
        points = [northern_intersection(features[role][0], x) for role in cut_roles]
        cuts.append({'id': label, 'features': [{'role': role, **trace.point(point.x, point.y)}
                                                for role, point in zip(cut_roles, points, strict=True)],
                     **profile(trace, LineString([points[0], points[-1]]), 2.5)})

    extent = box(x_min - 30, z_min - 70, x_max + 60, z_min + 30)
    masks, quality_sources = read_quality(sources.values())
    for pixel in trace.pixels.values():
        pixel['quality'] = {key: raster[pixel['row'], pixel['col']].item()
                            for key, raster in masks[pixel['tile']].items()}
        pixel['distanceToNonferrousFootprintM'] = footprint.distance(Point(*pixel['xz']))
    result = {'version': 1, 'status': 'needs-georeferenced-control-survey', 'usableAbsoluteControls': [],
              'citySha256': hashlib.sha256(city).hexdigest(), 'osmSource': osm, 'paperEvidence': audit_paper(pdf),
              'terrainVerticalDatum': 'EGM2008', 'terrainSources': sampler.sources, 'qualitySources': quality_sources,
              'entrance': d1, 'nearbySourceFeatures': nearby, 'frontageTransects': cuts,
              'osmElevationSearchBoundsXZ': extent.bounds, 'osmNodesWithElevation': nearby_osm_elevations(pbf, extent),
              'rawPixels': trace.pixels, 'runtimeVertices': trace.vertices}
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
