"""追踪街道剖面的原始 DSM 像元和运行网格顶点，只读取源及城市包。"""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from shapely import affinity
from shapely.geometry import LineString, Point, box

from audit_terrain_candidates import lonlat, read_tiff
from copernicus import CopernicusSampler
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX, project
from osm import PBF, read_osm

ROOT = Path(__file__).resolve().parents[2]
QUALITY_FIELDS = {'edm': 'edmCode', 'flm': 'flmCode', 'hem': 'hemRawM', 'wbm': 'wbmCode'}
SITES = {
    'shennan-chegongmiao': {
        'bounds': [-3440, 755, -3180, 965],
        'ways': [40978183, 892901021, 837565287, 860523333, 879817607, 837565283],
        'observations': [
            ('browser-arrival', -3270.6653, 829.4291),
            ('node/1491790883', -3362.815, 851.174),
        ],
        'cuts': [
            ('arrival-fork', 837565287, -3270.6653, 829.4291, 70),
            ('xiangmihu-connector-rise', 860523333, -3224.088, 838.777, 60),
            ('d1-entrance-area', 40978183, -3362.815, 851.174, 65),
        ],
    },
    'beihuan-xinzhou': {
        'bounds': [-2050, -1900, -1850, -1740],
        'ways': [1468770634, 1466159023, 1466159024, 498524807],
        'observations': [
            ('node/549760265', -1947.21, -1828.03),
            ('browser-west-queue', -1943.9121, -1832.0650),
        ],
        'cuts': [
            ('east-pose-limit', 1468770634, -1948, -1806.5, 70),
            ('west-ramp-fork', 1466159023, -1943.9121, -1832.0650, 55),
        ],
    },
}


def local_geometry(geometry):
    translated = affinity.translate(geometry, -ORIGIN_LON, -ORIGIN_LAT)
    return affinity.scale(translated, KX, -KY, origin=(0, 0))


def line_parts(geometry):
    if geometry.geom_type == 'LineString' and not geometry.is_empty:
        yield geometry
    elif hasattr(geometry, 'geoms'):
        for part in geometry.geoms:
            yield from line_parts(part)


def vertical_relation(tags):
    if tags.get('bridge', 'no') not in ('no', 'false', '0'):
        return 'bridge-profile-unresolved'
    if tags.get('tunnel', 'no') not in ('no', 'false', '0') or tags.get('layer', '0') != '0':
        return 'separate-layer-profile-unresolved'
    return 'ground-tagged'


class ElevationTrace:
    def __init__(self, terrain, sampler):
        if (terrain['processing']['heightSource'] != 'copernicus-glo30-dsm'
                or terrain['diagonal'] != 'ne-sw' or terrain['heightScale'] != 0.1):
            raise ValueError('Audit requires the Copernicus ground grid')
        self.grid = terrain
        self.sampler = sampler
        self.pixels = {}
        self.vertices = {}

    def raw_weights(self, lon, lat):
        west, south = math.floor(lon), math.ceil(lat) - 1
        fx, fz = (lon - west) * 3600, (south + 1 - lat) * 3600
        col, row = math.floor(fx), math.floor(fz)
        u, v = fx - col, fz - row
        weights = {}
        for r, c, weight in ((row, col, (1 - u) * (1 - v)), (row, col + 1, u * (1 - v)),
                             (row + 1, col, (1 - u) * v), (row + 1, col + 1, u * v)):
            if not weight:
                continue
            tile_west, tile_south = west + c // 3600, south - r // 3600
            r, c = r % 3600, c % 3600
            tile = f'N{tile_south:02d}E{tile_west:03d}'
            identity = f'{tile}/{r}/{c}'
            if identity not in self.pixels:
                coordinates = (tile_west + c / 3600, tile_south + 1 - r / 3600)
                self.pixels[identity] = {'tile': tile, 'row': r, 'col': c, 'lonLat': coordinates,
                                         'xz': project(*coordinates),
                                         'heightM': self.sampler._pixel(tile_west, tile_south, r, c)}
            weights[identity] = weight
        return weights

    def grid_vertex(self, i, j):
        grid = self.grid
        identity = f'{i}/{j}'
        if identity not in self.vertices:
            x, z = grid['x0'] + i * grid['step'], grid['z0'] + j * grid['step']
            source = self.raw_weights(*lonlat(x, z))
            raw = sum(self.pixels[pixel]['heightM'] * weight for pixel, weight in source.items())
            quantized = grid['heights'][j * grid['nx'] + i]
            if round(raw * 10) != quantized:
                raise ValueError(f'City grid does not reproduce the locked source at {identity}')
            self.vertices[identity] = {'xz': [x, z], 'heightM': quantized * grid['heightScale'],
                                       'rawPixelWeights': source}
        return identity

    def point(self, x, z):
        grid = self.grid
        coordinates = lonlat(x, z)
        raw_weights = self.raw_weights(*coordinates)
        raw = sum(self.pixels[pixel]['heightM'] * weight for pixel, weight in raw_weights.items())
        fx, fz = (x - grid['x0']) / grid['step'], (z - grid['z0']) / grid['step']
        i, j = math.floor(fx), math.floor(fz)
        if not (0 <= i < grid['nx'] - 1 and 0 <= j < grid['nz'] - 1):
            raise ValueError('Audit point outside the built terrain grid')
        u, v = fx - i, fz - j
        if u + v <= 1:
            corners = ((i, j, 1 - u - v), (i + 1, j, u), (i, j + 1, v))
        else:
            corners = ((i + 1, j + 1, u + v - 1), (i, j + 1, 1 - u), (i + 1, j, 1 - v))
        vertices = {self.grid_vertex(a, b): w for a, b, w in corners if w > 0}
        runtime = sum(self.vertices[key]['heightM'] * weight for key, weight in vertices.items())
        effective = {}
        for key, grid_weight in vertices.items():
            for pixel, raw_weight in self.vertices[key]['rawPixelWeights'].items():
                effective[pixel] = effective.get(pixel, 0) + grid_weight * raw_weight
        return {'xz': [x, z], 'lonLat': coordinates, 'rawDSMHeightM': raw, 'runtimeHeightM': runtime,
                'rawPixelWeights': raw_weights, 'runtimeVertexWeights': vertices, 'runtimeRawPixelWeights': effective}


def profile(trace, line, step, station_origin=0):
    distances = [step * i for i in range(math.floor(line.length / step) + 1)]
    if line.length - distances[-1] > 1e-6:
        distances.append(line.length)
    samples = []
    for s in distances:
        p = line.interpolate(s)
        samples.append({'stationM': s - station_origin, **trace.point(p.x, p.y)})
    statistics = {}
    for key in ('rawDSMHeightM', 'runtimeHeightM'):
        grades = [100 * (b[key] - a[key]) / (b['stationM'] - a['stationM']) for a, b in zip(samples, samples[1:])]
        worst = max(range(len(grades)), key=lambda i: abs(grades[i]))
        values = [row[key] for row in samples]
        statistics[key] = {'minM': min(values), 'maxM': max(values), 'p95AbsGradePct': float(np.quantile(np.abs(grades), 0.95)),
                           'maxGradePct': grades[worst], 'steepInterval': [worst, worst + 1],
                           'maxHeightSample': values.index(max(values))}
    return {'lengthM': line.length, 'sampleStepM': step, 'statistics': statistics, 'samples': samples}


def footprint_candidates(pixels, osm):
    points = [Point(row['xz']) for row in pixels.values()]
    if not points:
        return
    half_x, half_z = KX / 7200, KY / 7200
    extent = box(min(p.x for p in points) - half_x, min(p.y for p in points) - half_z,
                 max(p.x for p in points) + half_x, max(p.y for p in points) + half_z)
    a, b = lonlat(extent.bounds[0], extent.bounds[3]), lonlat(extent.bounds[2], extent.bounds[1])
    nearby = box(*a, *b)
    groups = [('building', osm['buildings']), ('vegetated-area', osm['green']),
              ('mapped-bridge', [road for road in osm['roads'] if vertical_relation(road['tags']) == 'bridge-profile-unresolved'])]
    features = [(kind, feature, local_geometry(feature['geom'])) for kind, rows in groups for feature in rows
                if feature['geom'].intersects(nearby)]
    for pixel in pixels.values():
        x, z = pixel['xz']
        point = Point(x, z)
        half_step = box(x - half_x, z - half_z, x + half_x, z + half_z)
        overlaps = []
        for kind, feature, geometry in features:
            if not geometry.intersects(half_step):
                continue
            region = geometry.intersection(half_step)
            tags = feature['tags']
            overlaps.append({'osmId': feature['id'], 'kind': kind, 'tags': tags,
                             'pixelCenterInFeature': geometry.covers(point), 'distanceToFeatureM': geometry.distance(point),
                             'nearbyAreaM2': region.area, 'nearbyBridgeAxisM': region.length if kind == 'mapped-bridge' else 0})
        pixel['osmCandidates'] = overlaps


def read_quality(sources):
    masks, records = {}, []
    for source in sources:
        identity = source['id']
        if not identity.startswith('copernicus-aux-'):
            continue
        tile, code = identity.removeprefix('copernicus-aux-').split('-', 1)
        if code not in QUALITY_FIELDS:
            continue
        path = ROOT / source['file']
        with path.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != source['sha256']:
                raise ValueError(f'Copernicus quality mask hash mismatch: {identity}')
        raster = read_tiff(path)
        if (raster.data.shape != (3600, 3600) or raster.x != int(tile[4:])
                or raster.y != int(tile[1:3]) + 1):
            raise ValueError(f'Quality mask does not match the original tile grid: {identity}')
        masks.setdefault(tile, {})[QUALITY_FIELDS[code]] = raster.data
        records.append(source)
    return masks, records


def audit_site(spec, trace, osm, ways, masks):
    bounds = box(*spec['bounds'])
    profiles = []
    for source in spec['ways']:
        identity = f'way/{source}'
        row = ways[identity]
        for part in line_parts(local_geometry(row['geom']).intersection(bounds)):
            if part.length < 5:
                continue
            profiles.append({'osmId': identity, 'name': row['tags'].get('name'),
                             'verticalRelation': vertical_relation(row['tags']), **profile(trace, part, 5)})

    cuts = []
    for identity, way, x, z, half_width in spec['cuts']:
        osm_id = f'way/{way}'
        axis = local_geometry(ways[osm_id]['geom'])
        s = axis.project(Point(x, z))
        p = axis.interpolate(s)
        before = axis.interpolate(max(0, s - 1))
        after = axis.interpolate(min(axis.length, s + 1))
        distance = before.distance(after)
        right_x, right_z = -(after.y - before.y) / distance, (after.x - before.x) / distance
        line = LineString([(p.x - right_x * half_width, p.y - right_z * half_width),
                           (p.x + right_x * half_width, p.y + right_z * half_width)])
        cuts.append({'id': identity, 'osmAxisId': osm_id, 'anchorXZ': [p.x, p.y], 'rightUnitXZ': [right_x, right_z],
                     **profile(trace, line, 2.5, half_width)})
    observations = [{'id': identity, **trace.point(x, z)} for identity, x, z in spec['observations']]
    footprint_candidates(trace.pixels, osm)
    for pixel in trace.pixels.values():
        quality = masks.get(pixel['tile'], {})
        pixel['quality'] = {name: raster[pixel['row'], pixel['col']].item() for name, raster in quality.items()}
    return {'longitudinalBoundsXZ': spec['bounds'], 'longitudinal': profiles, 'transverse': cuts,
            'observations': observations, 'rawPixels': trace.pixels, 'runtimeVertices': trace.vertices}


def main():
    parser = argparse.ArgumentParser(description='Trace source DSM pixels for reviewed Shenzhen road profiles')
    parser.add_argument('--site', choices=SITES, help='only inspect the named road area')
    parser.add_argument('--no-cache', action='store_true', help='re-read the locked OSM PBF')
    args = parser.parse_args()
    sources = json.loads((ROOT / 'data/source/sources.json').read_text())['sources']
    osm_source = next(source for source in sources if source['id'] == 'osm-guangdong')
    with PBF.open('rb') as handle:
        if hashlib.file_digest(handle, 'sha256').hexdigest() != osm_source['sha256']:
            raise ValueError('Road source PBF does not match the locked snapshot')
    prefix = 'copernicus-dem-'
    hashes = {s['id'].removeprefix(prefix): s['sha256'] for s in sources if s['id'].startswith(prefix)}
    sampler = CopernicusSampler(ROOT / 'data/raw/terrain/copernicus', hashes)
    city = (ROOT / 'js/sz-city.json.gz').read_bytes()
    terrain = json.loads(gzip.decompress(city))['terrain']
    osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache)
    ways = {row['id']: row for row in osm['roads']}
    masks, quality_sources = read_quality(sources)
    selection = (args.site,) if args.site else SITES
    result = {key: audit_site(SITES[key], ElevationTrace(terrain, sampler), osm, ways, masks) for key in selection}
    print(json.dumps({'version': 1, 'citySha256': hashlib.sha256(city).hexdigest(), 'osmSource': osm_source,
                      'terrainSources': sampler.sources, 'qualitySources': quality_sources,
                      'sites': result}, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
