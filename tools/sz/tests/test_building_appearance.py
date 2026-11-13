"""近邻样本冻结、来源保护和用途后备回归。"""

from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import enc_poly
from building_appearance import apply_building_appearance
from buildings import CATEGORIES, FACADES, HEIGHT_SOURCES, ROLES
from shapely.geometry import box


class BuildingAppearanceTests(unittest.TestCase):
    def test_shared_median_excludes_non_reliable_and_protected_sources(self):
        heights = [100, 100, 100, 100, 250, 100, 90, 16, 14, 18, 10]
        sources = ['osm-height'] * 5 + ['globfp', 'landmark'] + ['estimate'] * 4
        identities = [f'way/{i}' for i in range(len(heights))]
        columns = dict(id=identities, h=heights, rings=[enc_poly(box(x, 80, x + 20, 100))
                                                      for x in range(20, 20 + 20 * len(heights), 20)],
                       minH=[0] * len(heights), cat=[2] * len(heights), facade=[1] * len(heights),
                       lm=[-1] * 6 + [0] + [-1] * 4, lv=[-1] * len(heights),
                       role=[0] * len(heights), src=[HEIGHT_SOURCES.index(s) for s in sources])
        payload = {'buildings': columns, 'mapRegions': {'regions': []},
                   'enums': {'category': CATEGORIES, 'facade': FACADES, 'heightSource': HEIGHT_SOURCES,
                             'buildingRole': ROLES}}
        features = [{'id': identity, 'tags': {'building': 'office'}} for identity in identities]
        features[9]['tags'] = {'building': 'school'}
        columns['cat'][9] = CATEGORIES.index('public')
        features[10]['tags'] = {'building': 'office', 'shop': 'bakery'}
        osm = {'buildings': features}
        report = {}
        apply_building_appearance(payload, osm, report)
        self.assertEqual(columns['h'][:7], [100, 100, 100, 100, 250, 100, 90])
        self.assertTrue(all(40 <= columns['h'][i] <= 60 for i in (7, 8, 10)))
        self.assertLess(columns['h'][9], 20)
        self.assertEqual(payload['retailBuildings'], [['way/10', 1]])
        reference = next(row for key, row in report['heightEstimate']['groups'].items() if key.startswith('nearby:'))
        self.assertEqual(reference['medianM'], 100)
        self.assertEqual({row[0] for row in reference['samples']}, set(identities[:4]))
        result = deepcopy(payload)
        apply_building_appearance(payload, osm, {})
        self.assertEqual(payload, result)
