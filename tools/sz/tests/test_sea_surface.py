"""有方向的海岸线、潮滩和高程来源回归。"""

import sys
import unittest
from pathlib import Path

from shapely.geometry import LineString, Point, box
from shapely.ops import transform, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from sea_surface import build_sea_surface


def feature(identity, shape):
    lonlat = transform(lambda x, z: (ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY), shape)
    return {'id': f'way/{identity}', 'geom': lonlat}


class SeaSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.clip = box(-10, -10, 10, 10)
        self.osm = {'coastline': [feature(1, LineString([(-20, 0), (20, 0)])),
                                  feature(2, LineString([(-2, 4), (-2, 6), (0, 6), (0, 4), (-2, 4)]))],
                    'shoreWetlands': [feature(3, box(2, 1, 4, 4))]}
        self.terrain = {'processing': {'heightSource': 'copernicus-glo30-dsm'}, 'sources': [{'verticalDatum': 'EGM2008'}]}

    def test_seaward_geometry_retains_island_and_wetland_holes(self):
        report = {}
        surface = build_sea_surface(self.osm, self.clip, [box(-10, -10, 10, -0.1)], self.terrain, report)
        sea = unary_union(surface['polygons'])
        self.assertAlmostEqual(sea.area, 190, places=4)
        self.assertTrue(sea.covers(Point(0, 8)))
        for point in [(0, -2), (-1, 5), (3, 2), (0, 11)]:
            self.assertFalse(sea.covers(Point(point)))
        self.assertEqual(surface['heightM'], 0)
        self.assertEqual(surface['source']['coastlineIds'], ['way/1', 'way/2'])
        self.assertEqual(surface['source']['excludedWetlandIds'], ['way/3'])
        self.assertEqual(report['seaSurface']['contextAreaKm2'], 0)

    def test_incomplete_coastline_does_not_assign_the_surrounding_face(self):
        self.osm['coastline'].append(feature(4, LineString([(1, 8), (2, 8)])))
        report = {}
        self.assertIsNone(build_sea_surface(self.osm, self.clip, [], self.terrain, report))
        self.assertEqual(report['seaSurface']['status'], 'seaward-face-unresolved')

    def test_other_vertical_datum_does_not_inherit_ocean_editing(self):
        self.terrain['sources'][0]['verticalDatum'] = 'EGM96'
        report = {}
        self.assertIsNone(build_sea_surface(self.osm, self.clip, [], self.terrain, report))
        self.assertEqual(report['seaSurface']['status'], 'ocean-editing-datum-unavailable')
