"""树木管线的确定性、来源标签、避让规则和上限回归。"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import LineString, Point, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import trees
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project


def lonlat(x, z):
    """本地米制坐标反投影成经纬度，和真实 osm['roads'] 的几何口径一致。"""
    return (ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY)


def road(identity, points, tags, node_refs=()):
    return {'id': identity, 'tags': tags,
            'geom': LineString([lonlat(*point) for point in points]),
            'nodeRefs': list(node_refs)}


def make_scene():
    """合成一个小范围：主/次干路、住宅路、桥、水体、湿地、绿地、公园、建筑和步道。"""
    osm = {'roads': [
        road('way/1', [(-500, 0), (400, 0)], {'highway': 'primary', 'width': '16'}, [1, 2]),
        road('way/2', [(400, 0), (500, 0)], {'highway': 'primary', 'width': '16'}, [2, 7]),
        road('way/3', [(-500, -300), (-100, -300)], {'highway': 'secondary', 'width': '12'}, [3, 4]),
        road('way/4', [(-500, 300), (500, 300)], {'highway': 'residential'}, [8, 9]),
        road('way/5', [(-500, 500), (500, 500)], {'highway': 'primary', 'bridge': 'yes'}, [10, 11]),
        road('way/6', [(400, 0), (400, 300)], {'highway': 'residential'}, [2, 12]),
        road('way/7', [(400, 0), (500, 400)], {'highway': 'residential'}, [2, 13]),
        road('way/8', [(100, -250), (400, -250)], {'highway': 'footway'}, [14, 15]),
    ]}
    water = [{'id': 'way/600', 'poly': box(150, 100, 250, 200), 'name': 'pond'}]
    wetland = [{'id': 'way/601', 'poly': box(-100, -550, 100, -350), 'name': 'mangrove'}]
    green = [
        {'id': 'way/700', 'poly': box(-400, -500, 400, -150), 'name': 'green'},
        {'id': 'way/701', 'poly': box(300, 400, 340, 440), 'name': 'pocket'},
        {'id': 'way/702', 'poly': box(50, 50, 70, 70), 'name': 'too-small'},
    ]
    parks = [{'id': 'test-park', 'osmId': 'way/800', 'source': 'https://www.openstreetmap.org/way/800',
              'areas': [{'osmId': 'way/800', 'name': 'park', 'polygon': box(100, -500, 400, -200),
                         'arrivals': []}]}]
    streetscape = {'paths': [{'segments': [{'points': [(-450, -250), (450, -250)], 'nodeIds': [None, None]}]}]}
    buildings = [{'id': 'way/900', 'poly': box(-200, -30, -120, 30)}]
    osm_trees = [
        {'osmId': 'node/1', 'x': -450, 'z': -300, 'source': 'osm-node',
         'tags': {'natural': 'tree', 'height': '10', 'diameter_crown': '7'}},
        {'osmId': 'node/2', 'x': -440, 'z': -300, 'source': 'osm-node',
         'tags': {'natural': 'tree', 'species': 'Ficus microcarpa'}},
        {'osmId': 'way/9', 'x': -430, 'z': -300, 'source': 'osm-row', 'tags': {'natural': 'tree_row'}},
    ]
    return {'osm': osm, 'clip': box(-600, -600, 600, 600), 'land': [], 'water': water, 'wetland': wetland,
            'green': green, 'parks': parks, 'streetscape': streetscape, 'buildings': buildings,
            'osm_trees': osm_trees}


def build(scene=None, **overrides):
    scene = scene or make_scene()
    report = {}
    payload = trees.build_trees(scene['osm'], scene['clip'], scene['land'], scene['water'], scene['wetland'],
                                scene['green'], scene['parks'], scene['streetscape'], scene['buildings'],
                                report, osm_trees=scene['osm_trees'], **overrides)
    return payload, report


def points_of(payload, source_name):
    index = payload['sources'].index(source_name)
    return [(payload['x'][i] / 10, payload['z'][i] / 10)
            for i in range(payload['count']) if payload['source'][i] == index]


class TreePipelineTests(unittest.TestCase):
    def test_payload_arrays_are_aligned_and_deterministic(self):
        first, first_report = build()
        second, second_report = build()
        self.assertIsNotNone(first)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        self.assertEqual(first_report['trees'], second_report['trees'])
        count = first['count']
        self.assertGreater(count, 0)
        self.assertLessEqual(count, 60000)
        for field in ('x', 'z', 'height', 'crown', 'species', 'source', 'appearance'):
            self.assertEqual(len(first[field]), count, field)
        self.assertTrue(all(isinstance(value, int) for value in first['x'] + first['z']))
        self.assertTrue(all(value > 0 for value in first['height'] + first['crown']))
        self.assertTrue(all(0 <= value < len(first['speciesNames']) for value in first['species']))
        self.assertTrue(all(0 <= value < len(first['sources']) for value in first['source']))
        self.assertTrue(all(0 <= value < len(first['appearanceSources']) for value in first['appearance']))
        stats = first['stats']
        self.assertEqual(stats['kept'], count)
        self.assertEqual(stats['requested'], count + sum(stats['dropped'].values()))
        self.assertEqual(sum(stats['countsBySource'].values()), count)
        self.assertEqual(sum(stats['speciesCounts'].values()), count)

    def test_osm_identities_survive_and_appearance_is_tagged(self):
        payload, report = build()
        osm = dict(payload['osm'])
        self.assertEqual(set(osm.values()), {'node/1', 'node/2', 'way/9'})
        self.assertEqual(sorted(osm.keys()), list(range(3)))
        tagged = [index for index, identity in osm.items() if identity == 'node/1'][0]
        self.assertEqual(payload['appearanceSources'][payload['appearance'][tagged]], 'osm-tags')
        self.assertIn(payload['speciesNames'][payload['species'][tagged]], payload['speciesNames'])
        species_index = [index for index, identity in osm.items() if identity == 'node/2'][0]
        self.assertEqual(payload['speciesNames'][payload['species'][species_index]], 'ficus')
        self.assertEqual(payload['appearanceSources'][payload['appearance'][species_index]], 'species-estimate')
        self.assertEqual(report['trees']['osmSource']['treeNodes'], 2)
        self.assertEqual(report['trees']['osmSource']['treeRowPositions'], 1)
        self.assertEqual(report['trees']['osmSource']['kept'], 3)
        self.assertEqual(report['trees']['appearanceSources']['osm-tags'], 1)

    def test_simulated_trees_avoid_water_wetland_buildings_and_paths(self):
        payload, _report = build()
        scene = make_scene()
        water = scene['water'][0]['poly']
        wetland = scene['wetland'][0]['poly']
        building = scene['buildings'][0]['poly']
        footway = LineString(scene['streetscape']['paths'][0]['segments'][0]['points'])
        raw = [(payload['x'][i] / 10, payload['z'][i] / 10, payload['sources'][payload['source'][i]])
               for i in range(payload['count'])]
        for x, z, source in raw:
            point = Point(x, z)
            self.assertFalse(water.covers(point), (x, z, source))
            self.assertFalse(wetland.covers(point), (x, z, source))
        for x, z, source in raw:
            if source.startswith('simulated'):
                self.assertFalse(building.covers(Point(x, z)), (x, z, source))
            if source == 'simulated-park':
                self.assertGreater(footway.distance(Point(x, z)), 1.4, (x, z))
        osm_points = points_of(payload, 'osm-node') + points_of(payload, 'osm-row')
        self.assertEqual(len(osm_points), 3)
        for x, z in osm_points:
            self.assertTrue(building.distance(Point(x, z)) >= 0)

    def test_street_rows_use_class_spacing_offsets_and_junction_clearance(self):
        payload, report = build()
        street = points_of(payload, 'simulated-street')
        self.assertGreater(len(street), 20)
        # 主干路宽 16 m：两侧行道树在中心线外 8 + 2.5 = 10.5 m。
        primary = [(x, z) for x, z in street if abs(z) < 20]
        self.assertGreater(len(primary), 10)
        self.assertTrue(all(abs(abs(z) - 10.5) < 0.2 for x, z in primary))
        # 次干路宽 12 m：偏距 6 + 2.5 = 8.5 m。
        secondary = [(x, z) for x, z in street if abs(z + 300) < 20]
        self.assertGreater(len(secondary), 5)
        self.assertTrue(all(abs(abs(z + 300) - 8.5) < 0.2 for x, z in secondary))
        # 400 m 处四路交汇：18 m 内不种树。
        self.assertTrue(all((x - 400) ** 2 + z * z >= 18 ** 2 for x, z in street))
        # 住宅路和桥面不种行道树。
        self.assertTrue(all(abs(z - 300) > 20 for x, z in street))
        self.assertTrue(all(abs(z - 500) > 20 for x, z in street))
        # 建筑退让 2 m：建筑范围两侧的树被丢弃。
        self.assertTrue(all(not (-202 <= x <= -118 and -32 <= z <= 32) for x, z in street))
        self.assertAlmostEqual(report['trees']['streetLengthM'], 1400.0, places=1)
        self.assertGreater(report['trees']['dropped']['street-junction'], 0)
        self.assertGreater(report['trees']['dropped']['street-building'], 0)

    def test_park_sampling_respects_min_area_and_paths(self):
        payload, report = build()
        park = points_of(payload, 'simulated-park')
        self.assertGreater(len(park), 20)
        tiny = box(50, 50, 70, 70)
        self.assertTrue(all(not tiny.covers(Point(x, z)) for x, z in park))
        park_polygon = box(100, -500, 400, -200)
        self.assertTrue(any(park_polygon.covers(Point(x, z)) for x, z in park))
        self.assertGreater(report['trees']['parkKept']['destination'], 0)
        self.assertGreater(report['trees']['parkAreaM2'], 0)

    def test_cap_is_enforced_with_even_sampling(self):
        with patch.object(trees, 'CAP', 20):
            payload, report = build()
        self.assertEqual(payload['count'], 20)
        self.assertGreater(report['trees']['dropped']['total-cap'], 0)
        self.assertLessEqual(report['trees']['countsBySource']['osm-node'], 2)
        self.assertEqual(report['trees']['countsBySource']['osm-node'] + report['trees']['countsBySource']['osm-row'], 3)

    def test_report_documents_rules_species_and_limitations(self):
        payload, report = build()
        entry = report['trees']
        self.assertEqual(entry['status'], 'generated')
        species_ids = [item['id'] for item in entry['species']]
        for required in ('ficus', 'phoenix', 'bauhinia', 'royal-palm', 'camphor'):
            self.assertIn(required, species_ids)
        self.assertEqual(payload['speciesNames'], species_ids)
        self.assertEqual(entry['rules']['streetSpacingM']['trunk'], 22.0)
        self.assertEqual(entry['rules']['junctionClearM'], 18.0)
        self.assertEqual(entry['rules']['cap'], 60000)
        self.assertTrue(entry['limitations'])
        self.assertEqual(payload['limitations'], entry['limitations'])
        self.assertIn('simulated', entry['limitations'][0])
        self.assertNotIn('/Users/', json.dumps(entry))
        self.assertEqual(entry['appearanceSources']['osm-tags'] + entry['appearanceSources']['species-estimate'],
                         payload['count'])

    def test_missing_osm_source_returns_none(self):
        scene = make_scene()
        report = {}
        payload = trees.build_trees(scene['osm'], scene['clip'], scene['land'], scene['water'], scene['wetland'],
                                    scene['green'], scene['parks'], scene['streetscape'], scene['buildings'],
                                    report, osm_trees=None, pbf=None)
        self.assertIsNone(payload)
        self.assertEqual(report['trees']['status'], 'skipped-no-osm-tree-source')

    def test_seed_matches_javascript_fnv1a(self):
        # 和 js/sz-building-layout.js 的 buildingSeed 同构：ASCII 标识结果一致。
        self.assertAlmostEqual(trees._seed('way/123'), 0.7748544362839311, places=12)
        self.assertNotEqual(trees._seed('way/123'), trees._seed('way/124'))


if __name__ == '__main__':
    unittest.main()
