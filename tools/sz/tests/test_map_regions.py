"""地图区域应保留源语义、真实路缘和面内标注。"""

from collections import Counter
import gzip
import json
from pathlib import Path
import sys
import unittest

from shapely import union_all
from shapely.geometry import Point, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit_shopping_park import packaged_polygon, wgs84_box
from map_regions import Masks, map_shape, region_type, road_footprints

ROOT = Path(__file__).resolve().parents[3]


class RegionTests(unittest.TestCase):
    def test_only_explicit_land_use_classifies_a_source_area(self):
        self.assertEqual(region_type({'leisure': 'park'}), ('park', 'place'))
        self.assertEqual(region_type({'landuse': 'residential'}), ('residential', 'place'))
        self.assertEqual(region_type({'residential': 'urban_village'}), ('village', 'place'))
        self.assertEqual(region_type({'amenity': 'school'}), ('public', 'place'))
        self.assertEqual(region_type({'building': 'office'}), ('office', 'building'))
        self.assertIsNone(region_type({'landuse': 'commercial', 'name': 'Nearby Office'}))
        self.assertIsNone(region_type({'landuse': 'retail', 'location': 'underground'}))
        self.assertIsNone(region_type({'building:part': 'office', 'office': 'yes'}))

    def test_curved_ground_edge_and_water_cut_but_bridge_does_not(self):
        graph = {
            'nodes': [-2, 12, 42, 12, -2, 31, 42, 31],
            'links': [[0, 1, 0, 4, 1, 1, [12, 17, 25, 19]], [2, 3, 0, 3, 1, 1, []]],
            'metadata': [{'osmId': 'way/1', 'heightSource': 'terrain'},
                         {'osmId': 'way/2', 'heightSource': 'terrain', 'bridge': True}],
        }
        dry = box(0, 0, 40, 40)
        water = box(6, 25, 9, 29)
        road = road_footprints(graph, dry.bounds)
        shape = map_shape(dry, dry, Masks([water]), Masks(road))
        self.assertEqual(len(shape.geoms), 2)
        self.assertEqual(sum(len(p.interiors) for p in shape.geoms), 1)
        self.assertFalse(shape.intersects(water))
        self.assertEqual(shape.intersection(union_all(road)).area, 0)
        self.assertFalse(shape.covers(Point(12, 17)))
        self.assertTrue(shape.covers(Point(12, 12)))
        self.assertTrue(shape.covers(Point(12, 31)))

    def test_published_pilot_uses_linked_parcels_and_clear_label_anchors(self):
        with gzip.open(ROOT / 'js/sz-city.json.gz', 'rt') as file:
            city = json.load(file)
        regions = city['mapRegions']
        rows = {row['id']: row for row in regions['regions']}
        north = rows['osm:way/529086160']
        south = rows['osm:way/546582690']
        self.assertIn('shopping-park-station', north['placeIds'])
        self.assertIn('shopping-park-station', south['placeIds'])
        self.assertEqual(north['name'], '购物公园')
        self.assertIsNone(rows['block:shopping-park-north-of-fuhua']['name'])
        self.assertGreater(len(rows['osm:way/776141699']['rings']), 1)
        self.assertEqual(regions['coverage']['village'], 0)
        sample = wgs84_box(regions['pilot']['boundsWgs84'])
        roads = Masks(road_footprints(city['roadGraph'], sample.bounds))
        water = Masks([packaged_polygon(poly) for poly in city['water']])
        pilot = Counter()
        for row in rows.values():
            polygons = [packaged_polygon(poly) for poly in row['rings']]
            self.assertTrue(all(poly.is_valid for poly in polygons), row['id'])
            for x, z, clearance in row['anchors']:
                point = Point(x, z)
                self.assertTrue(any(poly.contains(point) and poly.boundary.distance(point) + 0.02 >= clearance
                                    for poly in polygons), row['id'])
            overlap = union_all(polygons).intersection(sample)
            if overlap.area < 1:
                continue
            pilot[row['type']] += 1
            self.assertAlmostEqual(sum(overlap.intersection(road).area for road in roads.overlapping(overlap)),
                                   0, delta=0.01, msg=row['id'])
            self.assertAlmostEqual(sum(overlap.intersection(pond).area for pond in water.overlapping(overlap)),
                                   0, delta=0.01, msg=row['id'])
        self.assertEqual(set(pilot), {'retail', 'public', 'park', 'residential', 'office', 'unknown'})
