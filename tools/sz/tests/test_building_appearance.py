"""近邻样本冻结、来源保护和用途后备回归。"""

from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import enc_poly
from building_appearance import apply_building_appearance
from buildings import CATEGORIES, FACADES, HEIGHT_SOURCES, LEVEL_HEIGHT, ROLES, _category
from shapely.geometry import box


class BuildingAppearanceTests(unittest.TestCase):
    def test_named_unknown_apartments_use_matching_compound_peers_without_overwriting_sources(self):
        rows = [(f'known-{i}', 100 + i * 30, 20, 22.4, 'osm-levels', {'building': 'apartments'})
                for i in range(3)]
        rows += [('missing', 200, 20, 10.2, 'estimate', {'building': 'yes', 'name': '9栋'}),
                 ('shed', 230, 6, 8, 'estimate', {'building': 'shed', 'name': '门卫房'}),
                 ('unknown', 250, 20, 12, 'estimate', {'building': 'yes'})]
        region = {'id': 'osm:estate', 'name': '示例小区', 'type': 'residential', 'level': 'place',
                  'areaM2': 15000, 'buildingRefs': list(range(6))}
        payload, osm = self.fixture(rows, regions=[region])
        report = {}
        apply_building_appearance(payload, osm, report)
        self.assertEqual(payload['buildings']['h'][:4], [22.4] * 4)
        self.assertEqual(payload['buildings']['cat'][3], CATEGORIES.index('residential'))
        self.assertEqual(payload['buildings']['src'][3], HEIGHT_SOURCES.index('estimate'))
        self.assertEqual(payload['buildings']['lv'][3], -1)
        self.assertEqual(report['heightEstimate']['groups']['residential-peers:osm:estate']['buildings'], ['missing'])
        self.assertIn('unknown', report['residentialHeightCoverage']['unknownEstimatedRecords'])
        self.assertEqual(payload['buildings']['cat'][5], CATEGORIES.index('unknown'))

    def test_villa_design_estimates_three_storeys_and_preserves_sourced_two_storeys(self):
        rows = [('villa', 100, 12, 8, 'estimate', {'building': 'detached'}),
                ('known', 130, 12, 9.6, 'osm-levels', {'building': 'house', 'building:levels': '3'}),
                ('two-storeys', 160, 12, 6.4, 'osm-levels', {'building': 'house', 'building:levels': '2'}),
                ('apartment', 190, 12, 22.4, 'osm-levels', {'building': 'apartments'})]
        payload, osm = self.fixture(rows)
        payload['buildings']['lv'][2] = 2
        report = {}
        apply_building_appearance(payload, osm, report)
        self.assertEqual(payload['buildings']['h'], [11.4, 9.6, 6.4, 22.4])
        self.assertEqual([payload['enums']['facade'][index] for index in payload['buildings']['facade'][:2]], ['villa'] * 2)
        self.assertNotEqual(payload['enums']['facade'][payload['buildings']['facade'][2]], 'villa')
        self.assertEqual(report['residentialVillas']['appearanceSource'], 'design')
        self.assertEqual(payload['buildings']['lv'][0], -1)

    def test_campus_dormitories_use_residential_references_instead_of_public_low_default(self):
        rows = [(f'known-{i}', 40 + i * 35, 20, 60, 'osm-levels', {'building': 'dormitory'})
                for i in range(4)]
        rows += [('dorm', 200, 20, 11, 'estimate', {'building': 'dormitory'}),
                 ('school', 230, 20, 12, 'estimate', {'building': 'school'})]
        region = {'id': 'osm:campus', 'name': '示例校园', 'type': 'public', 'level': 'place',
                  'areaM2': 30000, 'buildingRefs': list(range(6))}
        payload, osm = self.fixture(rows, regions=[region])
        report = {}
        apply_building_appearance(payload, osm, report)
        self.assertGreaterEqual(payload['buildings']['h'][4], 24)
        self.assertLess(payload['buildings']['h'][5], 20)

    def fixture(self, rows, regions=()):
        columns = dict(id=[], h=[], rings=[], minH=[], cat=[], facade=[], lm=[], lv=[], role=[], src=[])
        osm = {'buildings': []}
        for identity, x, width, height, source, tags in rows:
            for key, value in dict(id=identity, h=height, rings=enc_poly(box(x, 80, x + width, 80 + width)),
                                   minH=0, cat=CATEGORIES.index(_category(tags.get('building'))), facade=1,
                                   lm=-1, lv=-1, role=0, src=HEIGHT_SOURCES.index(source)).items():
                columns[key].append(value)
            osm['buildings'].append({'id': identity, 'tags': tags})
        return {'buildings': columns, 'mapRegions': {'regions': regions},
                'enums': {'category': CATEGORIES, 'facade': FACADES, 'heightSource': HEIGHT_SOURCES,
                          'buildingRole': ROLES}}, osm

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

    def test_mapped_block_shares_expanded_reference_across_grid_edges(self):
        tags = {'building': 'apartments'}
        rows = [
            ('west', 215, 22, 18, 'estimate', tags), ('east', 255, 22, 18, 'estimate', tags),
            ('one', 520, 22, 72, 'osm-height', tags), ('two', 570, 22, 84, 'osm-levels', tags),
            ('three', 620, 22, 96, 'overture-height', tags), ('four', 670, 22, 108, 'published', tags),
            ('outlier', 600, 22, 16, 'osm-height', tags),
            ('fake', 320, 22, 140, 'estimate', tags),
        ]
        payload, osm = self.fixture(rows, regions=[{
            'id': 'block:test', 'type': 'unknown', 'level': 'block', 'areaM2': 6400,
            'anchors': [[250, 91, 40]], 'buildingRefs': [0, 1, 7],
        }])
        report = {}
        apply_building_appearance(payload, osm, report)
        group = report['heightEstimate']['groups']['nearby:residential:2:block:test']
        self.assertEqual(group['radiusM'], 650)
        self.assertEqual(group['medianM'], 90)
        self.assertEqual(set(group['buildings']), {'west', 'east', 'fake'})
        self.assertEqual({row[0] for row in group['samples']}, {'one', 'two', 'three', 'four'})
        self.assertTrue(all(36 <= payload['buildings']['h'][i] <= 54 for i in (0, 1, 7)))
        self.assertEqual(payload['buildings']['h'][2:7], [72, 84, 96, 108, 16])

    def test_named_residential_compound_shares_one_estimated_height(self):
        apartment = {'building': 'apartments'}
        rows = [
            ('first', 100, 20, 16, 'estimate', apartment),
            ('second', 130, 40, 18, 'estimate', apartment),
            ('known', 180, 20, 22.4, 'osm-levels', apartment),
            ('predicted', 210, 20, 25, 'globfp', apartment),
            ('shed', 240, 15, 8, 'estimate', {'building': 'shed'}),
            ('tiny', 270, 6, 8, 'estimate', apartment),
            ('house', 300, 20, 8, 'estimate', {'building': 'house'}),
            ('unnamed-area', 330, 20, 16, 'estimate', apartment),
            ('another', 360, 20, 16, 'estimate', apartment),
        ]
        regions = [
            {'id': 'osm:small', 'name': '示例住宅区', 'type': 'residential', 'level': 'place',
             'areaM2': 6000, 'anchors': [[200, 90, 50]], 'buildingRefs': list(range(7))},
            {'id': 'osm:unnamed', 'type': 'residential', 'level': 'place',
             'areaM2': 4500, 'anchors': [[340, 90, 20]], 'buildingRefs': [7]},
            {'id': 'osm:another', 'name': '另一个住宅区', 'type': 'residential', 'level': 'place',
             'areaM2': 4000, 'anchors': [[370, 90, 20]], 'buildingRefs': [8]},
        ]
        payload, osm = self.fixture(rows, regions=regions)
        columns, report = payload['buildings'], {}
        apply_building_appearance(payload, osm, report)
        groups = report['heightEstimate']['groups']
        group = groups['residential-compound:osm:small']
        self.assertEqual(group['buildings'], ['first', 'second'])
        self.assertIn(group['levels'], range(30, 36))
        self.assertEqual(columns['h'][:2], [round(group['levels'] * LEVEL_HEIGHT, 1)] * 2)
        self.assertEqual(columns['h'][2:4], [22.4, 25])
        self.assertTrue(all(height < 30 for height in columns['h'][4:8]))
        self.assertEqual(groups['residential-compound:osm:another']['buildings'], ['another'])
        self.assertIn(groups['residential-compound:osm:another']['levels'], range(30, 36))
        self.assertEqual(HEIGHT_SOURCES[columns['src'][0]], 'estimate')
        self.assertEqual(columns['lv'][:2], [-1, -1])
        result = deepcopy(payload)
        apply_building_appearance(payload, osm, {})
        self.assertEqual(payload, result)

    def test_protected_sites_and_known_low_rise_do_not_borrow_tower_heights(self):
        rows = [
            ('park', 40, 22, 18, 'estimate', {'building': 'yes'}),
            ('ancient', 80, 22, 18, 'estimate', {'building': 'yes'}),
            ('school', 120, 22, 18, 'estimate', {'building': 'yes', 'amenity': 'school'}),
            ('house', 160, 22, 18, 'estimate', {'building': 'detached', 'building:use': 'residential'}),
            ('factory', 200, 22, 18, 'estimate', {'building': 'factory'}),
            ('landmark-part', 240, 22, 18, 'estimate', {'building:part': 'yes'}),
            ('with-levels', 280, 22, 18, 'estimate', {'building': 'yes', 'building:levels': '3'}),
            ('ordinary', 320, 22, 18, 'estimate', {'building': 'yes'}),
            ('very-small', 360, 6, 6, 'estimate', {'building': 'yes'}),
        ]
        payload, osm = self.fixture(rows, regions=[{
            'id': 'osm:park', 'type': 'park', 'level': 'place', 'areaM2': 1000,
            'anchors': [[55, 91, 10]], 'buildingRefs': [0],
        }])
        payload['sites'] = {'sites': {'nantou-ancient-city': {'site': {
            'osmId': 'way/219961346', 'polygons': [enc_poly(box(75, 75, 110, 115))],
        }}}}
        report = {}
        apply_building_appearance(payload, osm, report)
        groups = report['heightEstimate']['groups']
        self.assertEqual(groups['protected-default:park:12']['areas']['osm:park'], ['park'])
        self.assertEqual(groups['protected-default:historic-or-low-rise:12']['areas']['way/219961346'], ['ancient'])
        self.assertEqual(groups['protected-default:public:12']['buildings'], ['school'])
        self.assertEqual(groups['villa-design']['buildings'], ['house'])
        self.assertEqual(payload['buildings']['h'][3], 11.4)
        self.assertEqual(groups['protected-default:industrial:14']['buildings'], ['factory'])
        self.assertEqual(groups['existing-special-or-vertical-tag']['buildings'], ['landmark-part', 'with-levels'])
        self.assertEqual(payload['buildings']['h'][5:7], [18, 18])
        self.assertEqual(groups['use-default:unknown:2:28']['buildings'], ['ordinary'])
        self.assertEqual(groups['use-default:unknown:0:14']['buildings'], ['very-small'])

    def test_sparse_exact_size_uses_neighboring_size_but_never_other_building_uses(self):
        rows = [('target', 20, 21, 18, 'estimate', {'building': 'office'})]
        rows += [(f'residential-{i}', 40 + i * 20, 20, 22, 'osm-height', {'building': 'apartments'})
                 for i in range(4)]
        rows += [(f'office-{i}', 80 + i * 40, 16, 60 + i * 2, 'osm-height', {'building': 'office'})
                 for i in range(4)]
        payload, osm = self.fixture(rows)
        report = {}
        apply_building_appearance(payload, osm, report)
        group = report['heightEstimate']['groups']['nearby:office:2:grid:0:0']
        self.assertEqual(group['sizeClasses'], [1, 2, 3])
        self.assertEqual(group['medianM'], 63)
        self.assertEqual({row[0] for row in group['samples']}, {f'office-{i}' for i in range(4)})
