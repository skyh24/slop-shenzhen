"""landmark_sites 的请求收集、编码与缺失记录测试。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from landmark_sites import _encode_ring, compile_sites, collect_requests


class RequestTests(unittest.TestCase):
    def test_collects_way_and_relation_roles_and_skips_nodes(self):
        landmarks = [
            {'id': 'a', 'osm': {'site': 'way/1', 'route': 'relation/2', 'hotel': 'node/3',
                                'parts': ['way/4', 'way/1', None, 'bad', 'node/5']}},
            {'id': 'b', 'osm': {'lake': 'way/9'}},
            {'id': 'c'},
        ]
        requests = collect_requests(landmarks)
        self.assertEqual(requests[('way', 1)], [('a', 'site'), ('a', 'parts')])
        self.assertEqual(requests[('relation', 2)], [('a', 'route')])
        self.assertEqual(requests[('way', 4)], [('a', 'parts')])
        self.assertEqual(requests[('way', 9)], [('b', 'lake')])
        self.assertNotIn(('node', 3), requests)
        self.assertEqual(len(requests), 4)

    def test_ring_encoding_is_delta_in_decimetres(self):
        flat = _encode_ring([(1.0, 2.0), (3.5, 2.0), (3.5, 4.25), (1.0, 2.0)])
        # 闭合点被去掉，只留三边增量。
        self.assertEqual(flat, [10, 20, 25, 0, 0, 22])


class CompileTests(unittest.TestCase):
    def test_missing_objects_are_recorded_and_roles_share_geometry(self):
        requests = {('way', 1): [('a', 'site')], ('way', 2): [('b', 'lake'), ('c', 'lake')],
                    ('way', 3): [('d', 'site')]}
        areas = {('way', 1): {'osmId': 'way/1', 'polygons': [[[0, 0, 10, 0, 0, 10]]]},
                 ('way', 2): {'osmId': 'way/2', 'polygons': [[[0, 0, 5, 0, 0, 5]]]}}
        sites, missing = compile_sites([{'id': 'a'}, {'id': 'b'}, {'id': 'c'}, {'id': 'd'}], areas, requests)
        self.assertEqual(sorted(sites), ['a', 'b', 'c'])
        self.assertEqual(sites['b']['lake']['osmId'], 'way/2')
        self.assertEqual(sites['c']['lake']['osmId'], 'way/2')
        self.assertEqual([item['osmId'] for item in missing], ['way/3'])
        self.assertEqual(missing[0]['roles'], ['d:site'])


if __name__ == '__main__':
    unittest.main()
