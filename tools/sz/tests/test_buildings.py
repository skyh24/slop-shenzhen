"""建筑源对象的高程、覆盖和分流回归。"""

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
    def build(self, features, overture=(), bindings=None, globfp=(), reviews=(), height_overrides=None,
              water=(), include_remote_footprints=True):
        report = {}
        osm = {'buildings': features}
        if water:
            osm['water'] = [{'id': f'way/{9000 + i}', 'tags': {}, 'geom': geom} for i, geom in enumerate(water)]
        with tempfile.TemporaryDirectory() as directory:
            overture_file = Path(directory) / 'buildings.jsonl'
            overture_file.write_text('\n'.join(map(json.dumps, overture)))
            globfp_file = Path(directory) / 'globfp.jsonl'
            globfp_file.write_text('\n'.join(map(json.dumps, globfp)))
            reviews_file = Path(directory) / 'reviews.json'
            reviews_file.write_text(json.dumps({'version': 1, 'globfpExclusions': reviews}))
            with (patch('buildings.FOOTPRINT_REVIEWS', reviews_file),
                  patch('buildings.load_landmark_bindings', return_value=bindings or {})):
                output = build_buildings(osm, box(-1, -1, 200, 200), report,
                                         height_overrides=height_overrides, overture_path=overture_file, globfp_path=globfp_file,
                                         include_remote_footprints=include_remote_footprints)
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

    def test_explicit_bridge_clearance_survives_decimetre_encoding_without_thickening(self):
        bridge = feature(1484673350, footprint(10, 10, 8), {'building': 'bridge', 'height': '6.33',
                                                         'min_height': '5.4', 'location': 'overground', 'layer': '1'})
        part = feature(183019558, footprint(30, 10, 8), {'building:part': 'service', 'height': '10 m', 'min_height': '4.2 m'})
        by_id, report = self.build([bridge, part])
        self.assertEqual((by_id[bridge['id']]['minHeight'], by_id[bridge['id']]['height']), (5.4, 6.3))
        self.assertEqual((by_id[part['id']]['minHeight'], by_id[part['id']]['height']), (4.2, 10))
        self.assertEqual(report['buildingMinHeightCorrections'], [
            {'id': bridge['id'], 'tags': {'height': '6.33', 'min_height': '5.4'}, 'heightSource': 'osm-height',
             'heightM': 6.3, 'minHeightM': 5.4, 'previousMinHeightM': 5.3}
        ])
        self.assertEqual(report['excludedBuildingVerticalBounds'], [])

    def test_vertical_conflicts_keep_the_valid_parent_and_prevent_duplicate_solid_fallback(self):
        parent = footprint(10, 10, 8)
        roof = footprint(30, 10, 8)
        features = [
            feature(1, parent, {'building': 'yes', 'height': '12'}),
            feature(2, parent, {'building:part': 'yes', 'height': '9', 'min_height': '10'}),
            feature(3, roof, {'building': 'roof', 'height': '6.33', 'min_height': '6.31'}),
            feature(4, footprint(50, 10, 8), {'building': 'bridge', 'height': '8', 'min_height': '8'}),
            feature(5, footprint(70, 10, 8), {'building': 'bridge', 'height': '9', 'min_height': '4 ft'}),
            feature(6, footprint(90, 10, 8), {'building': 'bridge', 'building:levels': '1', 'min_height': '4'}),
        ]
        by_id, report = self.build(features, [{'id': 'same-roof', 'geom': mapping(roof), 'height': 8}],
                                   globfp=[{'Height': 10, 'g': mapping(roof)}])
        self.assertEqual(list(by_id), ['way/1'])
        self.assertEqual(by_id['way/1']['height'], 12)
        self.assertEqual(report['overtureDuplicates'], 1)
        conflicts = report['excludedBuildingVerticalBounds']
        self.assertEqual([(row['id'], row['scope'], row['reason']) for row in conflicts], [
            ('way/2', 'osm-tags', 'minimum-not-below-top'),
            ('way/3', 'osm-tags', 'interval-collapses-at-decimetre-precision'),
            ('way/4', 'osm-tags', 'minimum-not-below-top'),
            ('way/5', 'osm-tags', 'unresolved-explicit-metres'),
            ('way/6', 'resolved-top', 'minimum-not-below-top'),
        ])
        self.assertEqual(conflicts[1]['tags'], {'height': '6.33', 'min_height': '6.31'})
        self.assertEqual(conflicts[-1]['heightSource'], 'osm-levels')

    def test_review_excludes_only_the_anchored_footprint_and_cannot_supply_another_building_height(self):
        target = footprint(10, 10, 10)
        nearby = footprint(40, 10, 10)
        raw = [{'sourceId': 'globfp-tile', 'OGC_FID': 9, 'Height': 80, 'g': mapping(target)},
               {'sourceId': 'globfp-nearby', 'OGC_FID': 9, 'Height': 80, 'g': mapping(nearby)}]
        review = {'sourceId': 'globfp-tile', 'sourceFid': 9, 'bboxWgs84': target.bounds,
                  'rawHeightM': 80, 'reason': 'reviewed-open-road'}
        by_id, report = self.build([], globfp=raw, reviews=[review])
        self.assertEqual(list(by_id), ['globfp/1'])
        self.assertEqual(by_id['globfp/1']['height'], 80)
        self.assertEqual(report['excludedGlobfpFootprints'], [{**review, 'bboxWgs84': list(target.bounds), 'id': 'globfp/0',
                                                               'heightSource': 'globfp', 'match': 'source-tile-fid-and-bounds'}])
        existing = feature(1, target, {'building': 'yes'})
        by_id, _ = self.build([existing], globfp=raw, reviews=[review])
        self.assertEqual(by_id['way/1']['heightSource'], 'estimate')
        self.assertEqual(by_id['globfp/1']['heightSource'], 'globfp')

    def test_review_rejects_conflicting_source_identity_and_accepts_the_exact_legacy_cache_record(self):
        target = footprint(10, 10, 10)
        legacy = {'Height': 8, 'g': mapping(target)}
        review = {'sourceId': 'globfp-tile', 'sourceFid': 9, 'bboxWgs84': target.bounds, 'rawHeightM': 8}
        with self.assertRaisesRegex(ValueError, 'footprints missing'):
            self.build([], globfp=[{**legacy, 'OGC_FID': 10}], reviews=[review])
        with self.assertRaisesRegex(ValueError, 'footprints missing'):
            self.build([], globfp=[{**legacy, 'sourceId': 'globfp-nearby', 'OGC_FID': 9}], reviews=[review])
        with self.assertRaisesRegex(ValueError, 'conflicting source records'):
            self.build([], globfp=[legacy, legacy], reviews=[review])
        by_id, report = self.build([], globfp=[legacy], reviews=[review])
        self.assertEqual(by_id, {})
        self.assertEqual(report['excludedGlobfpFootprints'][0]['match'], 'legacy-bounds-and-height')

    def test_published_height_overrides_replace_source_height_and_report_previous_value(self):
        tower = feature(1, footprint(0, 0, 20), {'building': 'commercial', 'height': '100', 'building:levels': '25'})
        overrides = {'way/1': {'osmId': 'way/1', 'name': '测试塔', 'heightM': 123.4,
                               'sources': ['https://example.test/tower'], 'verifiedAt': '2026-11-09'}}
        by_id, report = self.build([tower], height_overrides=overrides)
        self.assertEqual(by_id['way/1']['height'], 123.4)
        self.assertEqual(by_id['way/1']['heightSource'], 'published')
        applied = report['buildingHeightOverrides']['applied']
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]['previousHeightM'], 100.0)
        self.assertEqual(applied[0]['previousHeightSource'], 'osm-height')
        self.assertEqual(applied[0]['heightM'], 123.4)
        self.assertEqual(report['buildingHeightOverrides']['unused'], [])

    def test_unused_published_overrides_are_reported_instead_of_silently_ignored(self):
        building = feature(1, footprint(0, 0, 12), {'building': 'yes', 'height': '20'})
        overrides = {'way/999': {'osmId': 'way/999', 'name': '不存在', 'heightM': 200.0,
                                 'sources': ['https://example.test/missing']}}
        _, report = self.build([building], height_overrides=overrides)
        self.assertEqual(report['buildingHeightOverrides']['unused'], ['way/999'])

    def test_remote_footprint_on_water_is_removed_and_reported(self):
        building = feature(1, footprint(0, 0, 20), {'building': 'yes', 'height': '30'})
        water = box(ORIGIN_LON + 40 / KX, ORIGIN_LAT - 100 / KY,
                    ORIGIN_LON + 100 / KX, ORIGIN_LAT - 40 / KY)
        overture = [{'id': 'on-water', 'geom': mapping(footprint(50, 50, 20))}]
        by_id, report = self.build([building], overture=overture, water=[water])
        self.assertNotIn('overture/on-water', by_id)
        self.assertEqual(report['buildingFootprintFilter']['removed']['waterOverlap'], 1)
        self.assertEqual(report['buildingFootprintFilter']['removedTotal'], 1)

    def test_osm_only_mode_skips_remote_footprints(self):
        building = feature(1, footprint(0, 0, 20), {'building': 'yes', 'height': '30'})
        overture = [{'id': 'remote', 'geom': mapping(footprint(50, 50, 20))}]
        by_id, report = self.build([building], overture=overture, include_remote_footprints=False)
        self.assertNotIn('overture/remote', by_id)
        self.assertFalse(report['remoteFootprints']['enabled'])
