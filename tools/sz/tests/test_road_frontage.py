"""红树林步道和过街接近段的编译检查。"""

import sys
import unittest
from pathlib import Path

from shapely import LineString, Point, Polygon, box, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_frontage import _buffer, _junction_walk_surfaces
from arterial_corridors import _flower_beds


class ShennanFlowerBedsTest(unittest.TestCase):
    def test_repeats_wider_s_beds_with_doubled_turf_gaps(self):
        lawn = box(0, -10, 190, 10).difference(box(81, -11, 99, 11))
        beds = sorted(_flower_beds(lawn), key=lambda bed: bed.bounds[0])
        self.assertEqual(len(beds), 4)
        self.assertTrue(all(lawn.buffer(-0.99).covers(bed) for bed in beds))
        self.assertTrue(all(a.distance(b) >= 15.99 for a, b in zip(beds, beds[1:])))
        start, _, end, _ = beds[0].bounds
        quarters = [start + fraction * (end - start) for fraction in (0.25, 0.75)]
        centers = [beds[0].intersection(LineString([(x, -10), (x, 10)])).centroid.y for x in quarters]
        self.assertGreater(centers[0], 3)
        self.assertLess(centers[1], -3)
        middle = (start + end) / 2
        self.assertGreater(beds[0].intersection(LineString([(middle, -10), (middle, 10)])).length, 9)

    def test_leaves_narrow_and_short_medians_unplanted(self):
        self.assertEqual(list(_flower_beds(box(0, -3.5, 190, 3.5))), [])
        self.assertEqual(list(_flower_beds(box(0, -10, 23, 10))), [])


class HongshulinWalkSurfaceTest(unittest.TestCase):
    def test_source_crossing_connects_both_walks_with_matching_ramp_heights(self):
        paving = [
            ('way/1', _buffer(LineString([(-10, 0), (0, 0)]), 3)),
            ('way/2', _buffer(LineString([(0, 12), (10, 12)]), 3)),
        ]
        crossings = [('way/3', _buffer(LineString([(0, 0), (0, 12)]), 3))]
        buildings = box(5, 11, 6, 13)
        result = list(_junction_walk_surfaces('sample', paving, crossings, box(-12, -2, 12, 14), buildings,
                                              Polygon(), {'sidewalkRiseM': 0.12}))
        self.assertEqual([f['id'].split(':')[-1] for f in result], ['sidewalk', 'ramp', 'paving'])
        self.assertTrue(all(f['clipToRoadComplement'] for f in result))
        self.assertEqual(result[2]['sourceIds'], ['way/1', 'way/2', 'way/3'])
        self.assertEqual(result[0]['sourceIds'], ['way/1', 'way/2'])
        polygons = []
        for f in result:
            coords = f['trianglesXZ']
            polygons.append(unary_union([Polygon(zip(coords[i:i + 6:2], coords[i + 1:i + 6:2]))
                                         for i in range(0, len(coords), 6)]))
        self.assertTrue(polygons[2].covers(LineString([(0, 0), (0, 12)])))
        self.assertFalse(unary_union(polygons).covers(Point(5.5, 12)))
        for i, a in enumerate(polygons):
            for b in polygons[:i]:
                self.assertLess(a.intersection(b).area, 1e-6)
        ramp = result[1]
        self.assertEqual(len(ramp['vertexRisesM']), len(ramp['trianglesXZ']) // 2)
        for x, z, rise in zip(ramp['trianglesXZ'][::2], ramp['trianglesXZ'][1::2], ramp['vertexRisesM']):
            p = Point(x, z)
            if polygons[0].boundary.distance(p) < 0.001:
                self.assertEqual(rise, 0.12)
            if polygons[2].boundary.distance(p) < 0.001:
                self.assertEqual(rise, 0)


if __name__ == '__main__':
    unittest.main()
