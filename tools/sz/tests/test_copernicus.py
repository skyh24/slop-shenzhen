"""点注册高程的插值、跨瓦片边界和来源校验。"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from copernicus import CopernicusSampler


class CopernicusTests(unittest.TestCase):
    def test_point_registration_and_bilinear_interpolation(self):
        sampler = CopernicusSampler('.', {})
        sampler.tiles[(114, 22)] = np.array([[0, 10], [20, 30]], dtype=float)
        self.assertEqual(sampler.sample(114, 23), 0)
        self.assertAlmostEqual(sampler.sample(114 + 0.5 / 3600, 23 - 0.5 / 3600), 15, places=6)

    def test_east_and_south_seams_use_neighbor_samples(self):
        sampler = CopernicusSampler('.', {})
        sampler.tiles[(113, 22)] = np.broadcast_to(np.array(10.0), (3600, 3600))
        sampler.tiles[(114, 22)] = np.broadcast_to(np.array(30.0), (3600, 3600))
        sampler.tiles[(113, 21)] = np.broadcast_to(np.array(50.0), (3600, 3600))
        self.assertAlmostEqual(sampler.sample(114 - 0.5 / 3600, 22.5), 20, places=6)
        self.assertAlmostEqual(sampler.sample(113.5, 22 + 0.5 / 3600), 30, places=6)
        self.assertEqual(sampler.sample(114, 22.5), 30)

    def test_missing_or_changed_source_fails_without_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            sampler = CopernicusSampler(folder, {'N22E114': 'bad'})
            with self.assertRaises(FileNotFoundError):
                sampler.sample(114.5, 22.5)
            (Path(folder) / 'N22E114.tif').write_bytes(b'not a source tile')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                sampler.sample(114.5, 22.5)

    def test_invalid_elevation_is_not_replaced_with_zero(self):
        sampler = CopernicusSampler('.', {})
        sampler.tiles[(114, 22)] = np.array([[float('nan')]])
        with self.assertRaisesRegex(ValueError, 'Invalid Copernicus'):
            sampler.sample(114, 23)
