"""从候选高程原始瓦片或原样窗口做同点审计，不写城市包。"""

from dataclasses import dataclass
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import tifffile
from shapely import contains_xy, union_all
from shapely.geometry import Polygon

from copernicus import CopernicusSampler
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from terrain import HgtSampler

ROOT = Path(__file__).resolve().parents[2]
PROFILE_WAYS = ('way/616988561', 'way/853566733')
LANDMARKS = {'chunsun', 'chunjian', 'tencent-binhai', 'dji-sky-city', 'lianhuashan',
             'talent-park', 'ping-an', 'chegongmiao', 'shenzhen-bay-park'}


@dataclass
class Raster:
    data: np.ndarray
    x: float
    y: float
    dx: float
    dy: float
    nodata: float | None
    scale: float = 1.0

    def neighbors(self, lon, lat):
        fx, fy = (lon - self.x) / self.dx, (lat - self.y) / self.dy
        i, j = math.floor(fx), math.floor(fy)
        if i < 0 or j < 0 or i + 1 >= self.data.shape[1] or j + 1 >= self.data.shape[0]:
            return None
        return self.data[j:j + 2, i:i + 2], fx - i, fy - j

    def sample(self, lon, lat):
        neighbors = self.neighbors(lon, lat)
        if neighbors is None:
            return None
        values, x, y = neighbors
        if not np.isfinite(values).all() or (values == self.nodata).any():
            return None
        return float(np.array([1 - y, y]) @ values @ np.array([1 - x, x]) * self.scale)

    def codes(self, lon, lat):
        neighbors = self.neighbors(lon, lat)
        return sorted(set(neighbors[0].ravel().tolist())) if neighbors is not None else []


def verified_path(record):
    path = ROOT / record['path']
    if path.stat().st_size != record['bytes']:
        raise ValueError(f'Unexpected candidate byte count: {path.name}')
    with path.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    if digest != record['sha256']:
        raise ValueError(f'Candidate raster hash mismatch: {path.name}')
    return path


def read_tiff(path):
    with tifffile.TiffFile(path) as file:
        page = file.pages[0]
        tags = page.tags
        sx, sy, _ = tags['ModelPixelScaleTag'].value
        tie = tags['ModelTiepointTag'].value
        keys = tags['GeoKeyDirectoryTag'].value
        codes = {keys[i]: keys[i + 3] for i in range(4, len(keys), 4)}
        if codes.get(2048) != 4326 or codes.get(1025) not in (1, 2) or tuple(tie[:3]) != (0, 0, 0):
            raise ValueError(f'Unexpected candidate raster registration: {path.name}')
        if not np.allclose([sx, sy], [1 / 3600, 1 / 3600], atol=1e-12, rtol=0):
            raise ValueError(f'Unexpected candidate raster spacing: {path.name}')
        # PixelIsArea 的左上角是像元边缘，PixelIsPoint 的左上角就是样点。
        center = 0.5 if codes[1025] == 1 else 0
        nodata = tags.get('GDAL_NODATA')
        return Raster(page.asarray(), tie[3] + center * sx, tie[4] - center * sy,
                      sx, -sy, float(nodata.value) if nodata else None)


def read_tile_strip(records, source_id):
    tiles = sorted((read_tiff(verified_path(record)) for record in records), key=lambda tile: tile.x)
    first = tiles[0]
    next_x = first.x
    for tile in tiles:
        if (not np.allclose([tile.x, tile.y, tile.dx, tile.dy], [next_x, first.y, first.dx, first.dy],
                            rtol=0, atol=1e-10)
                or tile.data.shape[0] != first.data.shape[0] or tile.nodata != first.nodata):
            raise ValueError(f'Candidate tiles do not share a grid: {source_id}')
        next_x += tile.dx * tile.data.shape[1]
    return Raster(np.concatenate([tile.data for tile in tiles], axis=1),
                  first.x, first.y, first.dx, first.dy, first.nodata)


def read_candidate(source):
    if source['format'] == 'geotiff':
        return read_tile_strip(source['files'], source['id'])
    if source['format'] != 'cog-window-npz' or len(source['files']) != 1:
        raise ValueError(f'Unsupported candidate raster format: {source["format"]}')
    # 窗口保留源 COG 样点，仅读取矩形范围，没有重采样或滤波。
    with np.load(verified_path(source['files'][0]), allow_pickle=False) as window:
        dx, rx, x, rz, dy, y = window['transform']
        if rx != 0 or rz != 0:
            raise ValueError('Candidate window must use an unrotated grid')
        return Raster(window['data'], x + dx / 2, y + dy / 2, dx, dy,
                      float(window['nodata']), float(window['scale']))


def lonlat(x, z):
    return ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY


def runtime_height(terrain, lon, lat):
    x, z = (lon - ORIGIN_LON) * KX, (ORIGIN_LAT - lat) * KY
    fx = (x - terrain['x0']) / terrain['step']
    fz = (z - terrain['z0']) / terrain['step']
    i, j = math.floor(fx), math.floor(fz)
    nx, nz = terrain['nx'], terrain['nz']
    if i < 0 or i >= nx - 1 or j < 0 or j >= nz - 1:
        return None
    u, v = fx - i, fz - j
    idx = j * nx + i
    a, b, c, d = (terrain['heights'][idx + offset] * terrain['heightScale'] for offset in (0, 1, nx, nx + 1))
    return a + (b - a) * u + (c - a) * v if u + v <= 1 else d + (c - d) * (1 - u) + (b - d) * (1 - v)


def point_rows(samplers, masks):
    landmarks = json.loads((ROOT / 'data/source/landmarks.json').read_text())['landmarks']
    points = [('origin', ORIGIN_LON, ORIGIN_LAT), ('legacy-min', 113.94926188498734, 22.528013547562107)]
    points += [(lm['id'], lm['center'][1], lm['center'][0]) for lm in landmarks if lm['id'] in LANDMARKS]
    return [{'id': name, 'lon': lon, 'lat': lat, 'elevationM': {
        key: round(value, 3) if (value := sample(lon, lat)) is not None else None
        for key, sample in samplers.items()},
        'maskCodes': {key: mask.codes(lon, lat) for key, mask in masks.items()}}
        for name, lon, lat in points]


def profiles(graph, samplers, masks):
    rows = []
    for way in PROFILE_WAYS:
        _, link = max((meta['lengthM'], link) for meta, link in zip(graph['metadata'], graph['links']) if meta['osmId'] == way)
        a, b, name, _, _, _, inner = link
        nodes = graph['nodes']
        path = np.asarray(nodes[a * 2:a * 2 + 2] + inner + nodes[b * 2:b * 2 + 2]).reshape(-1, 2)
        distances = np.insert(np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1)), 0, 0)
        s = np.arange(0, distances[-1], 10)
        coords = [lonlat(x, z) for x, z in zip(np.interp(s, distances, path[:, 0]), np.interp(s, distances, path[:, 1]))]
        results = {}
        for key, sample in samplers.items():
            elevation = np.asarray([sample(lon, lat) for lon, lat in coords], dtype=float)
            grades = np.abs(np.diff(elevation)) * 10
            results[key] = {
                'minM': round(float(np.nanmin(elevation)), 3), 'maxM': round(float(np.nanmax(elevation)), 3),
                'maxGradePercent': round(float(np.nanmax(grades)), 3),
                'p95GradePercent': round(float(np.nanquantile(grades, 0.95)), 3),
                'elevationM': [round(float(y), 3) if np.isfinite(y) else None for y in elevation]}
        rows.append({'osmWay': way, 'name': graph['names'][name], 'lengthM': round(float(distances[-1]), 3),
                     'spacingM': 10, 'sampleLonLat': coords, 'sources': results,
                     'maskCodes': {key: sorted({code for point in coords for code in mask.codes(*point)})
                                   for key, mask in masks.items()}})
    return rows


def polygon(rings):
    points = [np.cumsum(np.asarray(ring, dtype=float).reshape(-1, 2), axis=0) / 10 for ring in rings]
    return Polygon(points[0], points[1:])


def dry_grid(raw, samplers, datums):
    def layer(name):
        return union_all([polygon(shape) for shape in raw[name]])

    dry = layer('coverage').intersection(layer('land')).difference(layer('water'))
    x0, z0, x1, z1 = raw['bounds']
    x, z = np.meshgrid(np.arange(math.ceil(x0 / 100) * 100, x1, 100), np.arange(math.ceil(z0 / 100) * 100, z1, 100))
    mask = contains_xy(dry, x, z)
    points = [lonlat(px, pz) for px, pz in zip(x[mask], z[mask])]
    result = {}
    baseline = np.asarray([samplers['copernicus'](*p) for p in points], dtype=float)
    for key, sample in samplers.items():
        y = np.asarray([sample(*p) for p in points], dtype=float)
        good = y[np.isfinite(y)]
        stats = {'sampleCount': len(good), 'minM': round(float(good.min()), 3), 'maxM': round(float(good.max()), 3),
                 'belowMinus5M': int((good < -5).sum())}
        if datums[key] == 'EGM2008':
            diff = np.abs(y - baseline)
            stats['medianAbsDiffToCopernicusM'] = round(float(np.nanmedian(diff)), 3)
            stats['p95AbsDiffToCopernicusM'] = round(float(np.nanquantile(diff, 0.95)), 3)
        result[key] = stats
    return {'spacingM': 100, 'pointCount': len(points), 'sources': result}


def main():
    candidates = json.loads((ROOT / 'data/source/terrain-candidates.json').read_text())
    base_sources = json.loads((ROOT / 'data/source/sources.json').read_text())['sources']

    def hashes(prefix):
        return {source['id'].removeprefix(prefix): source['sha256'] for source in base_sources if source['id'].startswith(prefix)}

    raw = json.loads(gzip.decompress((ROOT / 'js/sz-city.json.gz').read_bytes()))
    source_root = ROOT / 'data/raw/terrain'
    copernicus = CopernicusSampler(source_root / 'copernicus', hashes('copernicus-dem-'))
    hgt = HgtSampler(source_root, hashes('terrain-'))
    samplers = {'copernicus': copernicus.sample, 'old-hgt': hgt.sample,
                'runtime-grid': lambda lon, lat: runtime_height(raw['terrain'], lon, lat)}
    datums = {'copernicus': 'EGM2008', 'old-hgt': 'legacy source, not normalized',
              'runtime-grid': raw['terrain']['sources'][0].get('verticalDatum')}
    masks = {}
    for source in candidates['sources']:
        samplers[source['id']] = read_candidate(source).sample
        datums[source['id']] = source['verticalDatum']
        if source.get('maskFiles'):
            masks[source['id']] = read_tile_strip(source['maskFiles'], source['id'])

    result = {'checkedAt': candidates['checkedAt'], 'status': candidates['status'], 'verticalDatums': datums,
              'points': point_rows(samplers, masks), 'profiles': profiles(raw['roadGraph'], samplers, masks),
              'dryGrid': dry_grid(raw, samplers, datums)}
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
