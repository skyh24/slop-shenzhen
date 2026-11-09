"""显示网格的岸线、水洞、三角面共面和分块接缝测试。"""

import sys
import unittest
from pathlib import Path

from shapely.geometry import Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terrain_surface import build_terrain_surface


def grid():
    return {'x0': 0, 'z0': 0, 'step': 25, 'nx': 3, 'nz': 3, 'heightScale': 0.1,
            'diagonal': 'ne-sw', 'heights': [0, 100, 300, 200, 500, 400, 600, 200, 100],
            'processing': {'heightSource': 'fixture-dem'}}


def sample(g, x, z):
    fx, fz = x / 25, z / 25
    i, j = min(int(fx), 1), min(int(fz), 1)
    u, v = fx - i, fz - j
    a, b, c, d = [g['heights'][k] / 10 for k in [j * 3 + i, j * 3 + i + 1, (j + 1) * 3 + i, (j + 1) * 3 + i + 1]]
    return a + (b - a) * u + (c - a) * v if u + v <= 1 else d + (c - d) * (1 - u) + (b - d) * (1 - v)


def faces(surface):
    for chunk in surface['chunks']:
        vertices = [chunk['positions'][i:i + 3] for i in range(0, len(chunk['positions']), 3)]
        for i in range(0, len(chunk['indices']), 3):
            yield [(vertices[k][0] + chunk['origin'][0], vertices[k][1], vertices[k][2] + chunk['origin'][1])
                   for k in chunk['indices'][i:i + 3]]


class TerrainSurfaceTests(unittest.TestCase):
    def test_exact_l_shaped_coverage_and_subcell_water_channel(self):
        g = grid()
        coverage = Polygon([(0, 0), (50, 0), (50, 25), (25, 25), (25, 50), (0, 50)])
        water = box(11, 0, 13, 50)
        expected = coverage.difference(water)
        report = {}
        surface = build_terrain_surface(g, coverage, [box(0, 0, 50, 50)], [{'poly': water}], report, chunk_size=25)
        polys = []
        for face in faces(surface):
            poly = Polygon([(x, z) for x, y, z in face])
            polys.append(poly)
            self.assertLess(poly.difference(expected).area, 1e-8)
            for x, y, z in face:
                self.assertAlmostEqual(y, sample(g, x, z), places=8)
            center = tuple(sum(p[k] for p in face) / 3 for k in range(3))
            self.assertAlmostEqual(center[1], sample(g, center[0], center[2]), places=8)
        self.assertAlmostEqual(unary_union(polys).area, expected.area, places=8)
        self.assertAlmostEqual(sum(p.area for p in polys), expected.area, places=8)
        self.assertEqual(report['terrainSurface']['waterLevelsGenerated'], False)

    def test_lake_hole_island_remains_land(self):
        coverage = box(0, 0, 50, 50)
        lake = Polygon([(5, 5), (45, 5), (45, 45), (5, 45)], [[(20, 20), (30, 20), (30, 30), (20, 30)]])
        surface = build_terrain_surface(grid(), coverage, [coverage], [{'poly': lake}], {}, chunk_size=25)
        actual = unary_union([Polygon([(p[0], p[2]) for p in face]) for face in faces(surface)])
        self.assertAlmostEqual(actual.symmetric_difference(coverage.difference(lake)).area, 0, places=8)

    def test_chunk_boundaries_share_heights_and_upward_winding(self):
        surface = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {}, chunk_size=25)
        points = {}
        self.assertEqual(len(surface['chunks']), 4)
        for face in faces(surface):
            a, b, c = face
            self.assertGreater((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), 0)
            for x, y, z in face:
                self.assertAlmostEqual(points.setdefault((x, z), y), y, places=8)

    def test_landuse_changes_colors_without_changing_geometry(self):
        plain = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {})
        colored = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {},
                                        green=[{'poly': box(-1, -1, 51, 51)}])
        self.assertEqual(plain['chunks'][0]['positions'], colored['chunks'][0]['positions'])
        self.assertEqual(plain['chunks'][0]['indices'], colored['chunks'][0]['indices'])
        self.assertTrue(all(kind == 1 for kind in colored['chunks'][0]['kinds']))
