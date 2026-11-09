"""地面建筑与地下源对象的分流回归。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buildings import build_buildings
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON


def footprint(x, z, size):
    return box(ORIGIN_LON + x / KX, ORIGIN_LAT - (z + size) / KY,
               ORIGIN_LON + (x + size) / KX, ORIGIN_LAT - z / KY)


def feature(identity, geom, tags):
    return {'id': f'way/{identity}', 'geom': geom, 'tags': tags}


class BuildingTests(unittest.TestCase):
    def build(self, features, overture=(), bindings=None):
        report = {}
        with tempfile.TemporaryDirectory() as directory:
            overture_file = Path(directory) / 'buildings.jsonl'
            overture_file.write_text('\n'.join(map(json.dumps, overture)))
            with (patch('buildings.OVERTURE', overture_file), patch('buildings.load_globfp', return_value=([], [])),
                  patch('buildings.load_landmark_bindings', return_value=bindings or {})):
                output = build_buildings({'buildings': features}, box(-1, -1, 200, 200), report)
        return {item['id']: item for item in output}, report

    def test_underground_boundaries_stay_in_audit_and_keep_surface_parts(self):
        station = footprint(0, 0, 100)
        tower = footprint(5, 5, 20)
        shell = footprint(120, 0, 30)
        features = [
            feature(1, station, {'building': 'train_station', 'location': 'underground', 'name': 'Station'}),
            feature(2, tower, {'building': 'office', 'building:levels': '20', 'building:levels:underground': '2', 'layer': '-1'}),
            feature(3, shell, {'building': 'yes', 'height': '12'}),
            feature(4, shell, {'building:part': 'yes', 'building:levels': '0', 'layer': '-1'}),
            feature(5, footprint(5, 120, 15), {'building': 'roof', 'building:levels': '0', 'layer': '1'}),
            feature(6, footprint(25, 120, 15), {'building': 'yes', 'building:levels': '0', 'layer': '-1', 'location': 'surface'}),
            feature(7, footprint(45, 120, 15), {'building:part': 'yes', 'building:levels': '0', 'layer': '-1', 'min_height': '4', 'height': '9'}),
            feature(8, footprint(65, 120, 15), {'building': 'retail', 'building:levels': '0', 'building:levels:underground': '2'}),
            feature(9, footprint(85, 120, 15), {'building': 'yes', 'location': 'underground', 'height': '10', 'building:levels': '1'}),
        ]
        overture = [
            {'id': 'entrance', 'geom': mapping(footprint(55, 30, 8)), 'height': 4},
            {'id': 'station', 'geom': mapping(station), 'is_underground': True},
        ]
        by_id, report = self.build(features, overture, {'way/1': {'landmark': 'station', 'height': 15}})
        self.assertEqual(set(by_id), {'way/2', 'way/3', 'way/5', 'way/6', 'way/7', 'overture/entrance'})
        self.assertEqual(by_id['way/2']['height'], 64)
        self.assertEqual(by_id['way/7']['minHeight'], 4)
        self.assertEqual(by_id['overture/entrance']['heightSource'], 'overture-height')
        self.assertEqual(report['landmarksWithoutBuilding'], ['station'])
        self.assertEqual([(entry['id'], entry['reason']) for entry in report['excludedUndergroundBuildings']], [
            ('way/1', 'location-underground'), ('way/4', 'zero-levels-with-negative-layer'),
            ('way/8', 'zero-levels-with-underground-floors'), ('way/9', 'location-underground'),
        ])
        station_entry = report['excludedUndergroundBuildings'][0]
        self.assertEqual(station_entry['landmark'], 'station')
        self.assertEqual(station_entry['tags'], features[0]['tags'])
        self.assertEqual(report['excludedUndergroundBuildings'][-1]['conflicts'], {'height': '10', 'building:levels': '1'})

    def test_estimated_heights_follow_source_id_when_unrelated_features_change(self):
        first = feature(1, footprint(0, 0, 12), {'building': 'yes'})
        other = feature(2, footprint(20, 20, 12), {'building': 'yes'})
        with_both, _ = self.build([first, other])
        without_first, _ = self.build([other])
        self.assertEqual(with_both['way/2']['height'], without_first['way/2']['height'])
        self.assertEqual(with_both['way/2']['heightSource'], 'estimate')
