"""地形数据的方向、保真度和异常输入回归。"""
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

    def test_source_heights_are_not_flattened_or_feathered(self):
        class ConstantSampler:
            def sample(self, lon, lat):
                return -12.3
        report = {}
        grid = build_terrain(box(-300, -300, 300, 300), report, sampler=ConstantSampler())
        self.assertTrue(all(h == -123 for h in grid['heights']))
        self.assertEqual(grid['processing']['featherM'], 0)
        self.assertEqual(grid['processing']['verticalScale'], 1)
        self.assertEqual(grid['processing']['verticalOffsetM'], 0)
        self.assertEqual(report['terrain']['minHeightM'], -12.3)

    def test_boundary_mask_preserves_interpolation_neighbors_and_omits_interior(self):
        class ConstantSampler:
            def sample(self, lon, lat):
                return 5
        excluded = box(50, 50, 150, 150)
        clip = box(0, 0, 150, 150).difference(excluded)
        report = {}
        grid = build_terrain(clip, report, sampler=ConstantSampler(), excluded=excluded)
        self.assertEqual(grid['heights'][3 * grid['nx'] + 3], 50)
        self.assertEqual(grid['heights'][5 * grid['nx'] + 5], 0)
        self.assertGreater(report['terrain']['excludedSamples'], 0)

    def test_peak_is_preserved_and_hash_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'N22E114.hgt.gz'
            tile = np.zeros((5, 5), dtype='>i2')
            tile[2, 2] = 106
            path.write_bytes(gzip.compress(tile.tobytes()))
            self.assertEqual(HgtSampler(folder).sample(114.5, 22.5), 106)
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                HgtSampler(folder, {'N22E114': 'incorrect'}).sample(114.5, 22.5)
