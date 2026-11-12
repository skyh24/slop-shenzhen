"""购物公园离线审计的面积和车行边界回归。"""

from pathlib import Path
import sys
import unittest

from shapely.geometry import LineString, Point, Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit_shopping_park import area_stats, boundary_lines, cut_block, surface_masks


class ShoppingParkAuditTests(unittest.TestCase):
    def test_counts_packaged_paving_only_from_all_kind_three_triangles(self):
        chunk = {
            'origin': [100, -20],
            'positions': [0, 8, 0, 4, 8, 0, 0, 8, 4, 4, 8, 4],
            'indices': [0, 1, 2, 2, 1, 3],
            'kinds': [3, 3, 3, 1],
        }
        road = {'origin': [100, -20], 'positions': [0, 8, 0, 0, 8, 2, 2, 8, 0]}
        sample = box(100, -20, 102, -16)
        paved, mixed, asphalt = surface_masks({'chunks': [chunk]}, [road, road], sample)

        self.assertAlmostEqual(paved.area, 6)
        self.assertAlmostEqual(mixed.area, 2)
        self.assertAlmostEqual(asphalt.area, 2)
        self.assertAlmostEqual(paved.intersection(asphalt).area, 2)

    def test_uses_union_for_area_under_overlapping_constraints(self):
        sample = box(0, 0, 10, 10)
        asphalt = box(0, 0, 3, 10)
        buildings = box(2, 0, 4, 10)
        green = box(6, 0, 7, 10)
        stats = area_stats(sample, sample, asphalt, buildings, green)

        self.assertEqual(stats['packagedPavingM2'], 100)
        self.assertEqual(stats['pavingOnAsphaltM2'], 30)
        self.assertEqual(stats['pavingUnderBuildingFootprintsM2'], 20)
        self.assertEqual(stats['pavingOnPackagedGreenM2'], 10)
        self.assertEqual(stats['pavingOutsideAsphaltBuildingsAndGreenM2'], 50)

    def test_builds_blocks_from_inner_carriageway_edges_and_leaves_median_outside(self):
        sample = box(-5, -5, 15, 30)
        north = box(0, 0, 10, 10)
        south = box(0, 14, 10, 24)
        road = north.boundary.buffer(1).union(south.boundary.buffer(1))
        road = road.union(box(4, 4, 6, 11))
        _, north_block, fragments = cut_block([LineString(north.exterior)], road, Point(2, 2))
        _, south_block, _ = cut_block([LineString(south.exterior)], road, Point(2, 17))

        self.assertTrue(sample.covers(north_block.union(south_block)))
        self.assertEqual(north_block.area, 54)
        self.assertEqual(fragments, 0)
        self.assertEqual(south_block.area, 64)
        self.assertFalse(north_block.union(south_block).covers(Point(5, 12)))
        self.assertEqual(north_block.union(south_block).intersection(road).area, 0)

    def test_rejects_open_ring_and_grade_separated_boundary(self):
        with self.assertRaisesRegex(ValueError, 'closed at-grade road ring'):
            cut_block([LineString([(0, 0), (5, 0), (5, 5)])], Polygon(), Point(1, 1))
        graph = {
            'nodes': [0, 0, 5, 0], 'names': ['Road'], 'links': [[0, 1, 0, 7, 2, 0, []]],
            'metadata': [{
                'osmId': 'way/1', 'heightSource': 'terrain', 'bridge': False, 'tunnel': True, 'layer': -1
            }],
        }
        with self.assertRaisesRegex(ValueError, 'Missing at-grade boundary'):
            boundary_lines(graph, ['way/1'], box(-1, -1, 6, 1))


if __name__ == '__main__':
    unittest.main()
