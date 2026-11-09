"""从 HGT 生成声明山体内的地形；不把城市回波当作全城地面。"""

import gzip
import math
from pathlib import Path

import numpy as np
from shapely.geometry import Point
from shapely.ops import transform, unary_union

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON

ROOT = Path(__file__).resolve().parents[2]
MASKS = {'way/41281446': '莲花山公园', 'way/98999987': '笔架山公园'}
VOID = -32768


class HgtSampler:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.tiles = {}

    def sample(self, lon, lat):
        west, south = math.floor(lon), math.floor(lat)
        key = (west, south)
        if key not in self.tiles:
            name = f'{"N" if south >= 0 else "S"}{abs(south):02d}{"E" if west >= 0 else "W"}{abs(west):03d}'
            path = self.directory / f'{name}.hgt.gz'
            raw = gzip.decompress(path.read_bytes())
            size = math.isqrt(len(raw) // 2)
            if size < 2 or len(raw) != size * size * 2:
                raise ValueError(f'Invalid HGT dimensions: {name}')
            self.tiles[key] = np.frombuffer(raw, dtype='>i2').reshape(size, size)
        tile = self.tiles[key]
        size = tile.shape[0]
        # HGT 从北向南逐行排列；先在原生像元做中值滤波，再双线性取样。
        fx, fz = (lon - west) * (size - 1), (south + 1 - lat) * (size - 1)
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j

        def median(row, col):
            row, col = min(size - 1, row), min(size - 1, col)
            block = tile[max(0, row - 1):min(size, row + 2), max(0, col - 1):min(size, col + 2)]
            valid = block[block != VOID]
            if not valid.size:
                raise ValueError(f'HGT void near {lon:.6f}, {lat:.6f}')
            return float(np.median(valid))

        a, b, c, d = median(j, i), median(j, i + 1), median(j + 1, i), median(j + 1, i + 1)
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz


def build_terrain(osm, clip, land, water, report, sampler=None, step=25):
    sampler = sampler or HgtSampler(ROOT / 'data/raw/terrain')
    selected = [g for g in osm['green'] if g['id'] in MASKS]
    masks = [transform(lambda lon, lat, z=None: ((lon - ORIGIN_LON) * KX, -(lat - ORIGIN_LAT) * KY), g['geom']) for g in selected]
    dry = unary_union(land).difference(unary_union([w['poly'] for w in water]))
    mask = unary_union(masks).intersection(clip).intersection(dry)
    minx, minz, maxx, maxz = clip.bounds
    x0, z0 = math.floor(minx / step) * step, math.floor(minz / step) * step
    nx, nz = math.ceil((maxx - x0) / step) + 1, math.ceil((maxz - z0) / step) + 1
    values = np.zeros((nz, nx), dtype=np.int16)
    for j in range(nz):
        z = z0 + j * step
        for i in range(nx):
            x = x0 + i * step
            point = Point(x, z)
            if not mask.contains(point):
                continue
            # 边缘 75 米羽化是显示近似，不是测绘高程；不按目标山高缩放 DEM。
            weight = min(1, point.distance(mask.boundary) / 75)
            weight = weight * weight * (3 - 2 * weight)
            height = max(0, sampler.sample(ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY))
            values[j, i] = round(height * weight * 10)
    terrain = {
        'x0': x0, 'z0': z0, 'step': step, 'nx': nx, 'nz': nz,
        'heightScale': 0.1, 'heights': values.ravel().tolist(),
        'diagonal': 'ne-sw',
        'sourceIds': ['terrain-N22E113', 'terrain-N22E114'],
        'processing': {'filter': 'native 3x3 median, bilinear resampling',
                       'maskIds': [g['id'] for g in selected], 'featherM': 75,
                       'outsideMask': 'flat pending verified mountain masks',
                       'heightSource': 'dem-derived-display-estimate'},
    }
    report['terrain'] = {
        'stepM': step, 'samples': nx * nz, 'raisedSamples': int(np.count_nonzero(values)),
        'maxHeightM': round(float(values.max()) / 10, 1),
        'masks': [{'id': g['id'], 'name': MASKS[g['id']]} for g in selected],
        'missingMaskIds': sorted(set(MASKS) - {g['id'] for g in selected}),
        'pendingRegions': ['塘朗山', '银湖山'],
        'limitations': ['Only declared park masks; Bijiashan is clipped by phase-one boundary',
                        'Terrain not yet connected to runtime surfaces or controllers',
                        'Coarse DEM includes canopy; feathered edges are display estimates'],
    }
    return terrain
