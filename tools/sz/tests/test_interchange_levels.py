"""立交地坪扩展保留既有过渡坡与其他立交。"""

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import interchange_levels as module


class ExpansionTest(unittest.TestCase):
    def test_expansion_preserves_previous_blend_and_other_interchanges(self):
        specs = json.loads(module.SOURCE.read_text())
        old = copy.deepcopy(specs)
        old[0]['groundArea']['maxZ'] = 1570
        surface = {'interchangeLevels': old, 'chunks': [{'kinds': [1], 'indices': [0, 0, 0]}]}
        payload = {'terrainSurface': surface, 'roadGraph': {'links': [], 'metadata': []}}
        report = {'terrainSurface': {}, 'interchangeLevels': []}
        calls = []

        def clip(surface, masks, grades, **kwargs):
            calls.append(grades)
            grade = grades[0][1]
            self.assertEqual(grade(Point(-3031, 1600), 9.9), 8)
            self.assertAlmostEqual(grade(Point(-3550, 1500), 10), 10)
            self.assertAlmostEqual(grade(Point(-3031, 1760), 20), 20)
            self.assertAlmostEqual(grade(Point(-3031, 1722.5), 20), 14)
            return surface, [], {}

        with patch.object(module, '_clip_terrain', clip), patch.object(
                module, '_restore_obsolete_cuts', lambda *args: (args[0], 0, 0)):
            module.apply_interchange_levels(payload, report)
        self.assertEqual(len(calls), 1)

    def test_shrinking_previous_ground_area_requires_base_rebuild(self):
        specs = json.loads(module.SOURCE.read_text())
        old = copy.deepcopy(specs)
        old[0]['groundArea']['maxZ'] += 1
        with self.assertRaisesRegex(ValueError, 'Rebuild the base terrain'):
            module.apply_interchange_levels({'terrainSurface': {'interchangeLevels': old}}, {})


if __name__ == '__main__':
    unittest.main()
