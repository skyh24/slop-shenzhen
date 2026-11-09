"""地形数据的方向、掩膜和异常输入回归。"""
import gzip
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project
from terrain import HgtSampler, build_terrain


class TerrainTests(unittest.TestCase):
    def test_origin_and_landmark_projection(self):
        self.assertEqual(project(ORIGIN_LON, ORIGIN_LAT), (0, 0))
        x, z = project(ORIGIN_LON + 0.001, ORIGIN_LAT + 0.001)
        self.assertGreater(x, 100)
        self.assertLess(z, -110)

    def test_hgt_north_south_orientation_and_void(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'N22E114.hgt.gz'
            tile = np.repeat(np.arange(5, dtype='>i2')[:, None] * 100, 5, axis=1).astype('>i2')
            path.write_bytes(gzip.compress(tile.tobytes()))
            sampler = HgtSampler(folder)
            self.assertEqual(sampler.sample(114.5, 22.75), 100)
            self.assertEqual(sampler.sample(114.5, 22.25), 300)
            self.assertEqual(sampler.sample(114.5, 22.625), 150)
            tile[:] = -32768
            path.write_bytes(gzip.compress(tile.tobytes()))
            with self.assertRaisesRegex(ValueError, 'HGT void'):
                HgtSampler(folder).sample(114.5, 22.5)
            path.write_bytes(gzip.compress(b'bad'))
            with self.assertRaisesRegex(ValueError, 'Invalid HGT'):
                HgtSampler(folder).sample(114.5, 22.5)

    def test_mask_water_and_missing_regions(self):
        class ConstantSampler:
            def sample(self, lon, lat):
                return 100
        geom = box(ORIGIN_LON - 200 / KX, ORIGIN_LAT - 200 / KY,
                   ORIGIN_LON + 200 / KX, ORIGIN_LAT + 200 / KY)
        osm = {'green': [{'id': 'way/41281446', 'geom': geom}]}
        clip = box(-300, -300, 300, 300)
        report = {}
        grid = build_terrain(osm, clip, [clip], [{'poly': box(-25, -25, 25, 25)}],
                             report, sampler=ConstantSampler())
        def height(x, z):
            i, j = round((x - grid['x0']) / 25), round((z - grid['z0']) / 25)
            return grid['heights'][j * grid['nx'] + i] * grid['heightScale']
        self.assertEqual(height(0, 0), 0)
        self.assertEqual(height(250, 0), 0)
        self.assertEqual(height(100, 100), 100)
        self.assertGreater(height(175, 0), 0)
        self.assertLess(height(175, 0), 100)
        self.assertEqual(report['terrain']['missingMaskIds'], ['way/98999987'])
