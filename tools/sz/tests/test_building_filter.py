"""卫星轮廓误识别过滤回归：只丢 GloBFP 独有的小轮廓，全部记进构建报告。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import LineString, box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buildings import (CARRIAGEWAY_SHARE, MISIDENTIFIED_MAX_AREA, PLAZA_GREEN_SHARE, _local_carriageways,
                       _road_half_width, build_buildings, filter_misidentified_footprints)
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from osm import CACHE_VERSION, KEEP_TAGS, _classify_area, _is_plaza


def wgs_box(x, z, width, height):
    """局部米制矩形转 OSM 缓存用的经纬度多边形。"""
    return box(ORIGIN_LON + x / KX, ORIGIN_LAT - (z + height) / KY,
               ORIGIN_LON + (x + width) / KX, ORIGIN_LAT - z / KY)


def wgs_line(x0, z0, x1, z1):
    return LineString([(ORIGIN_LON + x0 / KX, ORIGIN_LAT - z0 / KY),
                       (ORIGIN_LON + x1 / KX, ORIGIN_LAT - z1 / KY)])


def footprint(identity, x, z, width, height):
    """局部米制矩形的 GloBFP 候选记录。"""
    return {'id': f'globfp/{identity}', 'geom': box(x, z, x + width, z + height)}


def area(identity, x, z, width, height):
    return {'id': identity, 'geom': box(x, z, x + width, z + height)}


def road(identity, points, half):
    return {'id': identity, 'geom': LineString(points), 'halfWidthM': half}


def run(candidates, *, plaza=(), green=(), roads=(), counterparts=(), **options):
    report = {}
    key = options.get('report_key', 'globfpMisidentified')
    kept, dropped = filter_misidentified_footprints(candidates, list(plaza), list(green), list(roads), report,
                                                    counterpart_geoms=list(counterparts), **options)
    return kept, dropped, report[key]


class MisidentifiedFootprintTests(unittest.TestCase):
    def test_small_globfp_only_box_inside_plaza_is_dropped_and_reported(self):
        kept, dropped, report = run([footprint(1, 0, 0, 10, 20)], plaza=[area('way/plaza', -5, -5, 30, 40)])
        self.assertEqual(kept, [])
        self.assertEqual(report['count'], 1)
        self.assertEqual(report['areaM2'], 200.0)
        self.assertEqual(report['candidates'], 1)
        self.assertEqual(report['kept'], 0)
        self.assertFalse(report['truncated'])
        entry = report['objects'][0]
        self.assertEqual(entry['id'], 'globfp/1')
        self.assertEqual(entry['areaM2'], 200.0)
        self.assertEqual(entry['reason'], 'plaza')
        self.assertEqual(entry['inside'], ['plaza-or-green:way/plaza'])
        self.assertIn('GloBFP-only', report['rule'])
        self.assertIn('300', report['rule'])
        self.assertEqual(dropped[0]['id'], 'globfp/1')

    def test_box_at_or_above_the_area_threshold_is_kept(self):
        kept, dropped, report = run([footprint(2, 0, 0, 20, 20)], plaza=[area('way/plaza', -5, -5, 40, 40)])
        self.assertEqual([item['id'] for item in kept], ['globfp/2'])
        self.assertEqual(dropped, [])
        self.assertEqual(report['count'], 0)
        self.assertEqual(report['objects'], [])
        self.assertEqual(MISIDENTIFIED_MAX_AREA, 300.0)

    def test_globfp_box_overlapping_an_existing_osm_or_overture_footprint_is_kept(self):
        kept, dropped, report = run([footprint(3, 0, 0, 10, 20)], plaza=[area('way/plaza', -5, -5, 30, 40)],
                                    counterparts=[box(5, 5, 15, 15)])
        self.assertEqual([item['id'] for item in kept], ['globfp/3'])
        self.assertEqual(report['count'], 0)

    def test_small_globfp_box_in_a_normal_block_is_kept(self):
        kept, dropped, report = run([footprint(4, 100, 100, 10, 20)])
        self.assertEqual([item['id'] for item in kept], ['globfp/4'])
        self.assertEqual(report, {'rule': report['rule'], 'count': 0, 'areaM2': 0.0, 'objects': [],
                                  'candidates': 1, 'kept': 1, 'truncated': False})

    def test_small_box_inside_a_park_green_area_is_dropped_as_green(self):
        kept, dropped, report = run([footprint(5, 0, 0, 10, 20)], green=[area('way/park', -5, -5, 30, 40)])
        self.assertEqual(kept, [])
        self.assertEqual(report['objects'][0]['reason'], 'green')
        self.assertEqual(report['objects'][0]['inside'], ['plaza-or-green:way/park'])

    def test_plaza_and_green_together_reach_the_share_without_either_alone(self):
        # 候选 20x10 一半落在广场、一半落在绿地，各自都不到 60%，合起来正好覆盖全部
        candidate = footprint(6, 0, 0, 20, 10)
        kept, dropped, report = run([candidate], plaza=[area('way/plaza', 0, 0, 10, 10)],
                                    green=[area('way/park', 10, 0, 10, 10)])
        self.assertEqual(kept, [])
        self.assertEqual(report['objects'][0]['reason'], 'plaza-green')
        self.assertEqual(report['objects'][0]['inside'],
                         ['plaza-or-green:way/plaza', 'plaza-or-green:way/park'])

    def test_box_on_a_carriageway_is_dropped_and_buffer_width_comes_from_the_road(self):
        kept, dropped, report = run([footprint(7, 20, -5, 10, 10)], roads=[road('way/road', [(0, 0), (100, 0)], 8.0)])
        self.assertEqual(kept, [])
        self.assertEqual(report['objects'][0]['reason'], 'carriageway')
        self.assertEqual(report['objects'][0]['inside'], ['road:way/road'])
        # 离开车行道（半宽 8 + 1 米缓冲）之外的同尺寸轮廓保留
        kept, dropped, report = run([footprint(8, 20, 20, 10, 10)],
                                    roads=[road('way/road', [(0, 0), (100, 0)], 8.0)])
        self.assertEqual([item['id'] for item in kept], ['globfp/8'])
        self.assertEqual(report['count'], 0)

    def test_box_on_a_bridge_or_tunnel_line_is_not_treated_as_surface_carriageway(self):
        bridge = {'id': 'way/bridge', 'tags': {'highway': 'primary', 'bridge': 'yes'},
                  'geom': LineString([(0, 0), (100, 0)])}
        tunnel = {'id': 'way/tunnel', 'tags': {'highway': 'primary', 'tunnel': 'yes'},
                  'geom': LineString([(0, 100), (100, 100)])}
        carriageways = _local_carriageways([bridge, tunnel])
        self.assertEqual(carriageways, [])

    def test_report_keeps_full_count_when_the_object_list_is_capped(self):
        candidates = [footprint(index, 0, 0, 10, 20) for index in range(305)]
        kept, dropped, report = run(candidates, plaza=[area('way/plaza', -1, -1, 20, 30)])
        self.assertEqual(report['count'], 305)
        self.assertEqual(len(report['objects']), 300)
        self.assertTrue(report['truncated'])
        self.assertEqual(len(dropped), 305)

    def test_filter_is_deterministic_for_the_same_inputs(self):
        candidates = [footprint(index, index * 40, 0, 10, 20) for index in range(6)]
        plaza = [area('way/plaza', -5, -5, 30, 40)]
        roads = [road('way/road', [(0, 100), (400, 100)], 6.0)]
        first = run(candidates, plaza=plaza, roads=roads)
        second = run(candidates, plaza=plaza, roads=roads)
        self.assertEqual([item['id'] for item in first[0]], [item['id'] for item in second[0]])
        self.assertEqual(first[2], second[2])

    def test_road_half_width_prefers_width_then_lanes_then_class_default(self):
        self.assertEqual(_road_half_width({'highway': 'primary', 'width': '20'}), 10.0)
        self.assertEqual(_road_half_width({'highway': 'primary', 'lanes': '4'}), 6.5)
        self.assertEqual(_road_half_width({'highway': 'primary'}), 8.0)
        self.assertEqual(_road_half_width({'highway': 'service'}), 2.25)

    def test_thresholds_match_the_improvement_plan(self):
        self.assertEqual(PLAZA_GREEN_SHARE, 0.6)
        self.assertEqual(CARRIAGEWAY_SHARE, 0.8)


class OvertureReportSectionTests(unittest.TestCase):
    def test_helper_writes_the_same_rule_into_the_overture_section(self):
        kept, dropped, report = run([footprint(9, 0, 0, 10, 20)], plaza=[area('way/plaza', -5, -5, 30, 40)],
                                    report_key='overtureMisidentified',
                                    source_label='Overture-only (no OSM building)')
        self.assertEqual(kept, [])
        self.assertEqual(dropped[0]['id'], 'globfp/9')
        self.assertTrue(report['rule'].startswith('Overture-only (no OSM building), area<300 m2'))
        self.assertEqual(report['count'], 1)
        self.assertEqual(report['objects'][0]['reason'], 'plaza')

    def test_default_call_still_targets_globfp_misidentified(self):
        _, _, report = run([footprint(10, 0, 0, 10, 20)], plaza=[area('way/plaza', -5, -5, 30, 40)])
        self.assertTrue(report['rule'].startswith('GloBFP-only, area<300 m2'))


class OsmPlazaClassificationTests(unittest.TestCase):
    def test_plaza_tags_do_not_change_building_green_or_water_classification(self):
        self.assertIsNone(_classify_area({'highway': 'pedestrian'}))
        self.assertIsNone(_classify_area({'place': 'square'}))
        self.assertEqual(_classify_area({'building': 'yes', 'highway': 'pedestrian'}), 'building')
        self.assertEqual(_classify_area({'leisure': 'park', 'place': 'square'}), 'green')
        self.assertEqual(_classify_area({'landuse': 'forest', 'highway': 'pedestrian'}), 'green')
        self.assertEqual(_classify_area({'natural': 'water', 'place': 'plaza'}), 'water')
        self.assertEqual(_classify_area({'building:part': 'yes', 'place': 'square'}), 'building')

    def test_plaza_detection_accepts_only_pedestrian_areas_and_square_places(self):
        self.assertTrue(_is_plaza({'highway': 'pedestrian'}))
        self.assertTrue(_is_plaza({'place': 'square'}))
        self.assertTrue(_is_plaza({'place': 'plaza'}))
        self.assertFalse(_is_plaza({'highway': 'primary'}))
        self.assertFalse(_is_plaza({'highway': 'footway'}))
        self.assertFalse(_is_plaza({}))

    def test_cache_version_includes_coverage_and_plaza_sources(self):
        self.assertGreaterEqual(CACHE_VERSION, 7)
        self.assertIn('place', KEEP_TAGS)


class OvertureMisidentifiedBuildTests(unittest.TestCase):
    """Overture-only 补充路径的过滤接线：丢广场设施/车内小方块，保留有 OSM 对照的楼。"""

    def build(self, overture=(), osm_buildings=(), green=(), plaza=(), roads=()):
        report = {}
        clip = box(-50, -50, 500, 500)
        with tempfile.TemporaryDirectory() as directory:
            overture_file = Path(directory) / 'overture.jsonl'
            overture_file.write_text('\n'.join(map(json.dumps, overture)))
            globfp_file = Path(directory) / 'globfp.jsonl'
            globfp_file.write_text('')
            reviews_file = Path(directory) / 'reviews.json'
            reviews_file.write_text(json.dumps({'version': 1, 'globfpExclusions': []}))
            with (patch('buildings.FOOTPRINT_REVIEWS', reviews_file),
                  patch('buildings.load_landmark_bindings', return_value={})):
                output = build_buildings({'buildings': list(osm_buildings), 'green': list(green),
                                          'plaza': list(plaza), 'roads': list(roads)}, clip, report,
                                         overture_path=overture_file, globfp_path=globfp_file)
        return {item['id']: item for item in output}, report

    def test_overture_only_small_boxes_in_park_and_plaza_are_dropped_and_reported(self):
        green = [{'id': 'way/park', 'tags': {'leisure': 'park'}, 'geom': wgs_box(30, -10, 60, 50)}]
        plaza = [{'id': 'way/plaza', 'tags': {'highway': 'pedestrian'}, 'geom': wgs_box(200, -10, 40, 40)}]
        overture = [
            {'id': 'park-box', 'geom': mapping(wgs_box(40, 0, 10, 20))},
            {'id': 'plaza-box', 'geom': mapping(wgs_box(210, 0, 10, 20))},
            {'id': 'large-park-box', 'geom': mapping(wgs_box(40, 25, 20, 20))},
            {'id': 'normal-box', 'geom': mapping(wgs_box(150, 150, 10, 20))}
        ]
        by_id, report = self.build(overture, osm_buildings=[], green=green, plaza=plaza)
        self.assertEqual(set(by_id), {'overture/large-park-box', 'overture/normal-box'})
        section = report['overtureMisidentified']
        self.assertTrue(section['rule'].startswith('Overture-only (no OSM building), area<300 m2'))
        self.assertEqual(section['count'], 2)
        self.assertEqual(section['areaM2'], 400.0)
        self.assertEqual([entry['id'] for entry in section['objects']], ['overture/park-box', 'overture/plaza-box'])
        self.assertEqual([entry['reason'] for entry in section['objects']], ['green', 'plaza'])
        self.assertEqual(report['overtureAdded'], 2)
        self.assertEqual(report['overtureDuplicates'], 0)
        self.assertEqual(report['globfpMisidentified']['count'], 0)
        self.assertEqual(report['globfpMisidentified']['objects'], [])

    def test_overture_box_overlapping_an_osm_footprint_is_kept(self):
        overture = [{'id': 'osm-overlap', 'geom': mapping(wgs_box(18, 0, 10, 10))}]
        osm_buildings = [{'id': 'way/1', 'geom': wgs_box(0, 0, 20, 20), 'tags': {'building': 'yes'}}]
        by_id, report = self.build(overture, osm_buildings=osm_buildings,
                                   green=[{'id': 'way/park', 'tags': {'leisure': 'park'}, 'geom': wgs_box(30, -10, 60, 50)}])
        self.assertIn('overture/osm-overlap', by_id)
        self.assertEqual(report['overtureMisidentified']['count'], 0)
        self.assertEqual(report['overtureAdded'], 1)

    def test_overture_box_on_a_carriageway_is_dropped(self):
        roads = [{'id': 'way/road', 'tags': {'highway': 'primary', 'width': '20'},
                  'geom': wgs_line(-20, 80, 120, 80)}]
        overture = [{'id': 'road-box', 'geom': mapping(wgs_box(20, 74, 10, 12))},
                    {'id': 'clear-box', 'geom': mapping(wgs_box(20, 140, 10, 12))}]
        by_id, report = self.build(overture, roads=roads)
        self.assertEqual(set(by_id), {'overture/clear-box'})
        self.assertEqual(report['overtureMisidentified']['count'], 1)
        self.assertEqual(report['overtureMisidentified']['objects'][0]['id'], 'overture/road-box')
        self.assertEqual(report['overtureMisidentified']['objects'][0]['reason'], 'carriageway')

    def test_empty_overture_input_still_writes_the_report_section(self):
        by_id, report = self.build()
        self.assertEqual(by_id, {})
        self.assertEqual(report['overtureAdded'], 0)
        section = report['overtureMisidentified']
        self.assertEqual(section['count'], 0)
        self.assertEqual(section['areaM2'], 0.0)
        self.assertEqual(section['objects'], [])
        self.assertFalse(section['truncated'])
        self.assertTrue(section['rule'].startswith('Overture-only (no OSM building)'))

    def test_overture_reports_are_deterministic(self):
        green = [{'id': 'way/park', 'tags': {'leisure': 'park'}, 'geom': wgs_box(30, -10, 60, 50)}]
        overture = [{'id': f'box-{index}', 'geom': mapping(wgs_box(40 + index, 0, 5, 10))} for index in range(4)]
        first = self.build(overture, green=green)
        second = self.build(overture, green=green)
        self.assertEqual(first[1]['overtureMisidentified'], second[1]['overtureMisidentified'])
        self.assertEqual(list(first[0]), list(second[0]))


if __name__ == '__main__':
    unittest.main()
