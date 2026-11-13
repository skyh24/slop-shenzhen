"""检查同一地形面的多类裁切，避免覆盖绿地或改变脚底高程。"""

import sys
import unittest
from pathlib import Path

from shapely.geometry import Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from urban_paving import LAWN, STONE, _partition


class UrbanPavingTests(unittest.TestCase):
    def test_partitions_materials_without_double_surface_or_height_change(self):
        chunk = {'origin': [500, -500], 'positions': [0, 8, 0, 0, 11, 10, 10, 10, 0,
                                                        10, 13, 10, 20, 12, 0, 20, 15, 10],
                 'kinds': [0, 0, 0, 1, 1, 1], 'indices': [0, 1, 2, 1, 3, 2, 3, 5, 4],
                 'cellRanges': [0, 0, 6, 1, 6, 3]}
        stone = {'id': 'stone', 'kind': 'stone'}
        lawn = {'id': 'lawn', 'kind': 'lawn'}
        cover = {'stone': [], 'lawn': []}
        result = _partition(chunk, [(stone, box(501, -499, 506, -497)), (lawn, box(504, -500, 520, -490))], cover)
        self.assertAlmostEqual(unary_union(cover['stone']).intersection(unary_union(cover['lawn'])).area, 0)
        faces = []
        for offset in range(0, len(result['indices']), 3):
            indices = result['indices'][offset:offset + 3]
            vertices = [result['positions'][i * 3:i * 3 + 3] for i in indices]
            kinds = {result['kinds'][i] for i in indices}
            for x, y, z in vertices:
                self.assertAlmostEqual(y, 8 + 0.2 * x + 0.3 * z)
            face = Polygon([(x, z) for x, _, z in vertices])
            faces.append(face)
            if kinds & {LAWN, STONE}:
                self.assertEqual(len(kinds), 1)
                self.assertTrue(Polygon([(0, 0), (0, 10), (10, 0)]).covers(face))
        self.assertAlmostEqual(sum(face.area for face in faces), 150)
        self.assertAlmostEqual(unary_union(faces).area, 150)
        self.assertEqual(result['indices'][-6:], chunk['indices'][-6:])
        self.assertEqual(chunk['kinds'], [0, 0, 0, 1, 1, 1])
