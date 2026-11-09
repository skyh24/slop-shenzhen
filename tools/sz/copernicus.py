"""读取 Copernicus GLO-30 点注册 GeoTIFF，不依赖 GDAL。"""

import hashlib
import math
from pathlib import Path

import numpy as np
import tifffile


class CopernicusSampler:
    def __init__(self, directory, expected_hashes):
        self.directory = Path(directory)
        self.expected_hashes = expected_hashes
        self.tiles = {}
        self.sources = {}

    def _load(self, west, south):
        key = (west, south)
        if key not in self.tiles:
            name = f'{"N" if south >= 0 else "S"}{abs(south):02d}{"E" if west >= 0 else "W"}{abs(west):03d}'
            path = self.directory / f'{name}.tif'
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if self.expected_hashes.get(name) != digest:
                raise ValueError(f'Copernicus source hash mismatch: {name}')
            with tifffile.TiffFile(path) as file:
                page = file.pages[0]
                scale = page.tags['ModelPixelScaleTag'].value
                tie = page.tags['ModelTiepointTag'].value
                keys = page.tags['GeoKeyDirectoryTag'].value
                codes = {keys[i]: keys[i + 3] for i in range(4, len(keys), 4)}
                # 此读取器只接受已核对的 WGS84、RasterPixelIsPoint、1 角秒瓦片。
                if codes.get(2048) != 4326 or codes.get(1025) != 2 or page.shape != (3600, 3600):
                    raise ValueError(f'Unsupported Copernicus grid: {name}')
                if not np.allclose(scale[:2], [1 / 3600, 1 / 3600], rtol=0, atol=1e-12) or tuple(tie) != (0, 0, 0, west, south + 1, 0):
                    raise ValueError(f'Unexpected Copernicus georeferencing: {name}')
                self.tiles[key] = page.asarray()
            self.sources[name] = {'id': f'copernicus-dem-{name}', 'sha256': digest,
                                  'samplesPerSide': 3600, 'sampleSpacingArcSeconds': 1,
                                  'verticalDatum': 'EGM2008', 'productType': 'DSM'}
        return self.tiles[key]

    def _pixel(self, west, south, row, col):
        # AWS COG 删去了东侧/南侧重复像元，边界插值必须读相邻瓦片，不夹住边缘。
        if col >= 3600:
            west, col = west + 1, col - 3600
        if row >= 3600:
            south, row = south - 1, row - 3600
        value = float(self._load(west, south)[row, col])
        if not math.isfinite(value) or value <= -32767:
            raise ValueError('Invalid Copernicus elevation sample')
        return value

    def sample(self, lon, lat):
        west, south = math.floor(lon), math.ceil(lat) - 1
        fx, fz = (lon - west) * 3600, (south + 1 - lat) * 3600
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j
        value = 0.0
        for row, col, weight in ((j, i, (1 - tx) * (1 - tz)), (j, i + 1, tx * (1 - tz)),
                                 (j + 1, i, (1 - tx) * tz), (j + 1, i + 1, tx * tz)):
            if weight:
                value += self._pixel(west, south, row, col) * weight
        return value
