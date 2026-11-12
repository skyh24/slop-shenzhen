"""核对商业铺装裁切使用生产车行边界并保留分层结构。"""

import sys
import unittest
from pathlib import Path

from shapely.geometry import Point, Polygon, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from commercial_paving import cut_commercial_paving, ground_carriageway_mask


class CommercialPavingTests(unittest.TestCase):
    def test_ground_road_uses_asymmetric_section_and_keeps_other_layers(self):
        graph = {
            'nodes': [0, 10, 20, 10, 0, 15, 20, 15, 0, 17, 20, 17, 0, 19, 20, 19],
            'links': [[0, 1, 0, 4, 1, 1, []], [2, 3, 0, 2, 1, 1, []],
                      [4, 5, 0, 2, 1, 1, []], [6, 7, 0, 2, 1, 1, []]],
            'metadata': [
                {'osmId': 'way/1', 'heightSource': 'terrain', 'crossSection': {'points': [0, 10, 1, 20, 10, 1]}},
                {'osmId': 'way/2', 'heightSource': 'terrain', 'bridge': True},
                {'osmId': 'way/3', 'heightSource': 'terrain', 'tunnel': True},
                {'osmId': 'way/4', 'heightSource': 'terrain', 'layer': 1},
            ],
        }
        parcel = Polygon(box(5, 5, 15, 20).exterior.coords, [box(6, 14, 7, 16).exterior.coords])
        mask, details = ground_carriageway_mask(parcel, graph)
        self.assertTrue(mask.equals(parcel.intersection(box(5, 9, 15, 13))))
        self.assertEqual(details['roadOsmIds'], ['way/1'])
        self.assertEqual(details['carriagewayMaskAreaM2'], 40)

    def test_junction_fills_between_arms_without_cutting_unrelated_paving(self):
        graph = {
            'nodes': [10, 10, 20, 10, 10, 20],
            'links': [[0, 1, 0, 4, 1, 1, []], [0, 2, 0, 4, 1, 1, []]],
            'metadata': [{'osmId': 'way/1', 'heightSource': 'terrain'},
                         {'osmId': 'way/2', 'heightSource': 'terrain'}],
        }
        parcel = box(5, 5, 15, 15)
        mask, details = ground_carriageway_mask(parcel, graph)
        self.assertTrue(mask.covers(Point(9.5, 9.5)))
        self.assertFalse(mask.covers(Point(8.5, 8.5)))
        self.assertFalse(mask.covers(Point(14, 14)))
        self.assertEqual(details['roadOsmIds'], ['way/1', 'way/2'])
        self.assertAlmostEqual(mask.area, details['carriagewayMaskAreaM2'])

    def test_cut_paving_keeps_support_non_paved_faces_and_unaffected_chunks(self):
        chunk = {'origin': [0, 0], 'positions': [0, 2, 0, 0, 12, 10, 10, 12, 0, 10, 22, 10],
                 'kinds': [3, 3, 3, 1], 'indices': [0, 1, 2, 2, 1, 3], 'cellRanges': [0, 0, 6]}
        outside = {**chunk, 'origin': [0, 10]}
        surface, area = cut_commercial_paving({'chunkSize': 10, 'chunks': [chunk, outside]}, box(2, 2, 4, 4))
        self.assertEqual(area, 4)
        self.assertIs(surface['chunks'][1], outside)
        cut = surface['chunks'][0]
        self.assertEqual(cut['indices'][-3:], [2, 1, 3])
        self.assertEqual(cut['cellRanges'], [0, 0, len(cut['indices'])])
        face_areas = {0: 0, 3: 0}
        for i in range(0, len(cut['indices']) - 3, 3):
            face = cut['indices'][i:i + 3]
            self.assertEqual(len({cut['kinds'][v] for v in face}), 1)
            points = [cut['positions'][v * 3:v * 3 + 3] for v in face]
            for x, y, z in points:
                self.assertAlmostEqual(y, 2 + x + z)
            face_areas[cut['kinds'][face[0]]] += Polygon([(x, z) for x, _, z in points]).area
        self.assertAlmostEqual(face_areas[0], 4)
        self.assertAlmostEqual(face_areas[3], 46)
        result, repeated = cut_commercial_paving(surface, box(2, 2, 4, 4))
        self.assertEqual(repeated, 0)
        self.assertIs(result['chunks'][0], cut)
