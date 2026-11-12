"""从锁定的高程产品重采样地形，不人为调整山高、低地或公园边界。"""

import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from shapely import intersects_xy

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from copernicus import CopernicusSampler

ROOT = Path(__file__).resolve().parents[2]
VOID = -32768


class HgtSampler:
    def __init__(self, directory, expected_hashes=None):
        self.directory = Path(directory)
        self.expected_hashes = expected_hashes
        self.tiles = {}
        self.sources = {}

    def sample(self, lon, lat):
        west, south = math.floor(lon), math.floor(lat)
        key = (west, south)
        if key not in self.tiles:
            name = f'{"N" if south >= 0 else "S"}{abs(south):02d}{"E" if west >= 0 else "W"}{abs(west):03d}'
            path = self.directory / f'{name}.hgt.gz'
            compressed = path.read_bytes()
            digest = hashlib.sha256(compressed).hexdigest()
            if self.expected_hashes is not None and self.expected_hashes.get(name) != digest:
                raise ValueError(f'HGT source hash mismatch: {name}')
            raw = gzip.decompress(compressed)
            size = math.isqrt(len(raw) // 2)
            if size < 2 or len(raw) != size * size * 2:
                raise ValueError(f'Invalid HGT dimensions: {name}')
            self.tiles[key] = np.frombuffer(raw, dtype='>i2').reshape(size, size)
            self.sources[name] = {'id': f'terrain-{name}', 'sha256': digest,
                                  'samplesPerSide': size, 'sampleSpacingArcSeconds': 3600 / (size - 1)}
        tile = self.tiles[key]
        size = tile.shape[0]
        # HGT 从北向南逐行排列。仅重采样，不平滑、压峰或给低地归零。
        fx, fz = (lon - west) * (size - 1), (south + 1 - lat) * (size - 1)
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j
        height = 0.0
        for row, col, weight in ((j, i, (1 - tx) * (1 - tz)), (j, i + 1, tx * (1 - tz)),
                                 (j + 1, i, (1 - tx) * tz), (j + 1, i + 1, tx * tz)):
            if weight == 0:
                continue
            value = int(tile[min(size - 1, row), min(size - 1, col)])
            if value == VOID:
                raise ValueError(f'HGT void near {lon:.6f}, {lat:.6f}')
            height += value * weight
        return height


def build_terrain(clip, report, sampler=None, step=25, source='copernicus', *, excluded=None):
    if step <= 0 or not math.isfinite(step):
        raise ValueError('Terrain step must be finite and positive')
    if sampler is None:
        sources = json.loads((ROOT / 'data/source/sources.json').read_text())['sources']
        if source == 'copernicus':
            prefix = 'copernicus-dem-'
            hashes = {s['id'].removeprefix(prefix): s['sha256'] for s in sources if s['id'].startswith(prefix)}
            sampler = CopernicusSampler(ROOT / 'data/raw/terrain/copernicus', hashes)
        elif source == 'hgt':
            hashes = {s['id'].removeprefix('terrain-'): s['sha256'] for s in sources if s['id'].startswith('terrain-')}
            sampler = HgtSampler(ROOT / 'data/raw/terrain', hashes)
        else:
            raise ValueError(f'Unsupported terrain source: {source}')
    minx, minz, maxx, maxz = clip.bounds
    x0, z0 = math.floor(minx / step) * step, math.floor(minz / step) * step
    nx, nz = math.ceil((maxx - x0) / step) + 1, math.ceil((maxz - z0) / step) + 1
    values = []
    # 边界内侧保留一个插值单元的邻点。矩形网格其余被排除点以 0 占位，不生成地面。
    skipped = None
    if excluded is not None:
        x, z = np.meshgrid(x0 + np.arange(nx) * step, z0 + np.arange(nz) * step)
        skipped = intersects_xy(excluded.difference(clip.buffer(math.sqrt(2) * step)), x, z)
    for j in range(nz):
        lat = ORIGIN_LAT - (z0 + j * step) / KY
        for i in range(nx):
            if skipped is not None and skipped[j, i]:
                values.append(0)
                continue
            lon = ORIGIN_LON + (x0 + i * step) / KX
            height = sampler.sample(lon, lat)
            if not math.isfinite(height):
                raise ValueError('Non-finite terrain elevation')
            values.append(round(height * 10))
    source_records = list(getattr(sampler, 'sources', {}).values())
    def extreme(value):
        index = values.index(value)
        x, z = x0 + (index % nx) * step, z0 + (index // nx) * step
        return {'heightM': value / 10, 'lon': round(ORIGIN_LON + x / KX, 7),
                'lat': round(ORIGIN_LAT - z / KY, 7), 'x': x, 'z': z}

    terrain = {
        'x0': x0, 'z0': z0, 'step': step, 'nx': nx, 'nz': nz,
        'heightScale': 0.1, 'heights': values, 'diagonal': 'ne-sw',
        'sourceIds': [s['id'] for s in source_records], 'sources': source_records,
        'processing': {'resampling': 'bilinear', 'filter': 'none', 'featherM': 0,
                       'verticalOffsetM': 0, 'verticalScale': 1, 'quantizationM': 0.1,
                       'heightSource': 'copernicus-glo30-dsm' if source == 'copernicus' else 'terrain-tiles-dem',
                       'voidPolicy': 'fail-build',
                       'coverage': 'full bounding rectangle; render with separate land and water polygons'},
    }
    if skipped is not None:
        terrain['processing']['coverage'] = 'bounding grid with Hong Kong interior masked; outside points store zero placeholders'
    report['terrain'] = {
        'stepM': step, 'samples': nx * nz, 'nonzeroSamples': sum(v != 0 for v in values),
        'minHeightM': min(values) / 10, 'maxHeightM': max(values) / 10,
        'extrema': {'minimum': extreme(min(values)), 'maximum': extreme(max(values))},
        'belowSeaLevelSamples': sum(v < 0 for v in values),
        'qualityStatus': 'source-preserved; geographic plausibility review pending',
        'sources': source_records, 'processing': terrain['processing'],
        'limitations': ['25 m output grid does not increase native source resolution',
                        'Source snapshot is not a current ground survey; buildings and canopy may affect DEM',
                        'Terrain not yet connected to runtime surfaces or controllers',
                        'Water surface and bridge deck elevations require separate source data'],
    }
    if skipped is not None:
        report['terrain']['excludedSamples'] = int(skipped.sum())
    return terrain
