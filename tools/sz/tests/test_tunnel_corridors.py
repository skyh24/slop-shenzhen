"""隧道补地保留水域，避免把跨水洞顶补成陆地。"""

import sys
import unittest
from pathlib import Path

from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commercial_paving import cut_ground_openings
from highway_corridors import _apply_tunnel_corridors
from terrain_surface import build_terrain_surface
from tunnel_portals import _SurfaceSampler


def rings(polygon):
    result, x, z = [], 0, 0
    for px, pz in polygon.exterior.coords:
        nx, nz = round(px * 10), round(pz * 10)
        result.extend((nx - x, nz - z))
        x, z = nx, nz
    return [result]


class TunnelCorridorTests(unittest.TestCase):
    def test_roof_restoration_fills_land_holes_without_filling_water(self):
        grid = {'x0': 0, 'z0': 0, 'step': 25, 'nx': 3, 'nz': 3, 'heightScale': 0.1,
                'diagonal': 'ne-sw', 'heights': [80] * 9, 'processing': {'heightSource': 'fixture'}}
        land, water = box(0, 0, 50, 50), box(25, 0, 50, 50)
        surface = build_terrain_surface(grid, land, [land], [{'poly': water}], {})
        surface, _ = cut_ground_openings(surface, box(5, 20, 45, 30))
        payload = {'terrain': grid, 'land': [rings(land)], 'water': [rings(water)],
                   'seaSurface': {'polygons': []}, 'roadGraph': {'metadata': [{'osmId': 'way/1'}]},
                   'roadStructures': {'records': [{'route': 'fixture', 'index': 0, 'way': 'way/1',
                       'coverM': [0, 40], 'stations': [0, 5, 3, 25, 5, 29, 5, 21,
                                                     40, 45, 3, 25, 45, 29, 45, 21]}]}}
        result, report = _apply_tunnel_corridors(surface, payload,
            {'tunnelReferenceRoutes': ['fixture'], 'heightSource': 'estimate'})
        sample = _SurfaceSampler(result)
        self.assertEqual(sample(15, 25), 8)
        self.assertIsNone(sample(35, 25))
        self.assertGreater(report['restoredM2'], 0)


if __name__ == '__main__':
    unittest.main()
