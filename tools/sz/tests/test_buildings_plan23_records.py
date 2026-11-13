"""23 号方案第 2 步回归：建筑记录的角色、上游族、分项可信度与待核清单。

对应 docs/23-BUILDING-AND-STREET-PLAN.md 第 3 节：每条记录分开写轮廓、高度和年代的可信度，
并标出是否与另一来源共用同一套建筑数据；不确定的对象进待核清单，报告写明理由和样本。

单元测试用临时 JSONL 和 mock 复现数据管线；集成测试读重建后的共享包与构建报告，
在实现/重建落地之前会失败，失败信息带上当前统计。
"""

import gzip
import json
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import LineString, box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buildings import (CONFIDENCE_LEVELS, ROLES, UPSTREAM_FAMILIES, build_buildings)
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON

ROOT = Path(__file__).resolve().parents[3]
CITY_PACKAGE = ROOT / 'js/sz-city.json.gz'
BUILD_REPORT = ROOT / 'data/source/build-report.json'

THIN_POLE_ID = 'overture/ebf91e15-f0b2-4e0f-a517-088e8f500c33'
WHITE_BUILDING_ID = 'overture/f090af25-fa60-4bc9-99da-2bdfee0566c1'
SAME_BUILDING_ID = 'way/612995515'

# 输出建筑记录必须带的五个新字段；待核对象必须带的字段
RECORD_FIELDS = ('role', 'upstream', 'footprintConfidence', 'heightConfidence', 'eraConfidence')
PENDING_FIELDS = {'id', 'reasons', 'areaM2', 'heightM', 'heightSource'}
PENDING_REASONS = ('road-conflict-deferred', 'road-conflict-osm-kept', 'height-source-size-mismatch')


# ---------------------------------------------------------------- 几何小工具

def wgs_box(x, z, width, height):
    """局部米制矩形转经纬度多边形；z 向南为正，和 geo.project 的约定一致。"""
    return box(ORIGIN_LON + x / KX, ORIGIN_LAT - (z + height) / KY,
               ORIGIN_LON + (x + width) / KX, ORIGIN_LAT - z / KY)


def wgs_line(x0, z0, x1, z1):
    """局部米制折线两点的经纬度形式。"""
    return LineString([(ORIGIN_LON + x0 / KX, ORIGIN_LAT - z0 / KY),
                       (ORIGIN_LON + x1 / KX, ORIGIN_LAT - z1 / KY)])


def osm_feature(identity, geom, tags):
    return {'id': identity, 'geom': geom, 'tags': tags}


def ground_road(identity, wgs_geom, highway, width):
    """地面道路条目：桥和隧道会被 _local_carriageways 排除，这里只造地表路。"""
    return {'id': identity, 'geom': wgs_geom, 'tags': {'highway': highway, 'width': str(width)}}


def overture_entry(identity, wgs_geom, **extra):
    """Overture jsonl 记录；geom 是经纬度多边形，读取时再投到局部米制坐标。"""
    return {'id': identity, 'geom': mapping(wgs_geom), **extra}


def globfp_entry(wgs_geom, height):
    """GloBFP JSONL 缓存记录：Height 和经纬度几何 g。"""
    return {'Height': height, 'g': mapping(wgs_geom)}


class _RecordBuildMixin:
    """用临时 JSONL 替代原始数据快照，跑完整 build_buildings。"""

    def build(self, osm_buildings=(), roads=(), green=(), plaza=(), overture=(), globfp=(),
              reviews=(), height_overrides=None, clip=(-60, -60, 320, 320)):
        report = {}
        osm = {'buildings': list(osm_buildings), 'roads': list(roads)}
        if green:
            osm['green'] = list(green)
        if plaza:
            osm['plaza'] = list(plaza)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            overture_file = directory / 'buildings.jsonl'
            overture_file.write_text('\n'.join(map(json.dumps, overture)))
            globfp_file = directory / 'globfp.jsonl'
            globfp_file.write_text('\n'.join(map(json.dumps, globfp)))
            reviews_file = directory / 'reviews.json'
            reviews_file.write_text(json.dumps({'version': 1, 'globfpExclusions': list(reviews)}))
            with (patch('buildings.FOOTPRINT_REVIEWS', reviews_file),
                  patch('buildings.load_landmark_bindings', return_value={})):
                output = build_buildings(osm, box(*clip), report, height_overrides=height_overrides,
                                         overture_path=overture_file, globfp_path=globfp_file,
                                         include_globfp_footprints=True)
        return {item['id']: item for item in output}, output, report

    def pending_objects(self, report):
        """待核清单对象按 id 建索引，便于断言理由合并结果。"""
        return {entry['id']: entry for entry in report['pendingReview']['objects']}


# ------------------------------------------------------------ 单元测试：角色

class BuildingRoleTests(_RecordBuildMixin, unittest.TestCase):
    """23 号第 3 节：主楼、裙房、雨棚、连桥、未知分开记。"""

    def test_plain_building_is_main_roof_is_canopy_bridge_is_bridge(self):
        features = [
            osm_feature('way/101', wgs_box(0, 0, 20, 20), {'building': 'yes'}),
            osm_feature('way/102', wgs_box(40, 0, 20, 20), {'building': 'roof'}),
            osm_feature('way/103', wgs_box(80, 0, 20, 20), {'building': 'bridge'}),
        ]
        by_id, output, report = self.build(osm_buildings=features)
        self.assertEqual(by_id['way/101']['role'], 'main')
        self.assertEqual(by_id['way/102']['role'], 'canopy')
        self.assertEqual(by_id['way/103']['role'], 'bridge')
        for building in output:
            for field in RECORD_FIELDS:
                self.assertIn(field, building, f'输出建筑缺字段 {field}')

    def test_remote_supplemental_footprint_is_unknown(self):
        by_id, _, _ = self.build(overture=[overture_entry('remote', wgs_box(120, 0, 10, 10))])
        self.assertEqual(by_id['overture/remote']['role'], 'unknown')
        self.assertEqual(by_id['overture/remote']['upstream'], 'overture-eastasia')

    def test_low_part_of_removed_parent_shell_is_podium(self):
        # 外框 20x20 高 100；部件 20x15 高 20，盖住外框 75% 面积 -> 外框被移除，部件满足裙房条件
        parent = osm_feature('way/201', wgs_box(0, 60, 20, 20), {'building': 'yes', 'height': '100'})
        part = osm_feature('way/202', wgs_box(0, 60, 20, 15), {'building:part': 'yes', 'height': '20'})
        by_id, _, _ = self.build(osm_buildings=[parent, part])
        self.assertNotIn('way/201', by_id, '外框应被部件替代')
        self.assertEqual(by_id['way/202']['role'], 'podium')

    def test_part_without_podium_evidence_stays_unknown(self):
        # 部件同样盖住外框，但顶面 80 > 外框 100 的一半 -> 不是裙房，只能记未知
        parent = osm_feature('way/211', wgs_box(40, 60, 20, 20), {'building': 'yes', 'height': '100'})
        part = osm_feature('way/212', wgs_box(40, 60, 20, 20), {'building:part': 'yes', 'height': '80'})
        by_id, _, _ = self.build(osm_buildings=[parent, part])
        self.assertNotIn('way/211', by_id, '外框应被部件替代')
        self.assertEqual(by_id['way/212']['role'], 'unknown')


# ---------------------------------------------------------- 单元测试：上游族

class UpstreamFamilyTests(_RecordBuildMixin, unittest.TestCase):
    """23 号第 1、3 节：Overture 和 GloBFP 的东亚轮廓算同一上游族，不能当两次独立核实。"""

    def test_osm_footprint_with_globfp_height_stays_osm(self):
        same = osm_feature('way/301', wgs_box(0, 0, 20, 20), {'building': 'yes'})
        by_id, _, _ = self.build(osm_buildings=[same], globfp=[globfp_entry(wgs_box(0, 0, 20, 20), 80)])
        self.assertEqual(by_id['way/301']['heightSource'], 'globfp')
        self.assertEqual(by_id['way/301']['upstream'], 'osm')

    def test_overture_with_matching_globfp_polygon_is_eastasia_shared(self):
        by_id, _, _ = self.build(overture=[overture_entry('shared', wgs_box(40, 0, 20, 20))],
                                 globfp=[globfp_entry(wgs_box(40, 0, 20, 20), 80)])
        self.assertEqual(by_id['overture/shared']['heightSource'], 'globfp')
        self.assertEqual(by_id['overture/shared']['upstream'], 'eastasia-shared')

    def test_overture_with_its_own_height_is_overture_eastasia(self):
        by_id, _, _ = self.build(overture=[overture_entry('own-height', wgs_box(80, 0, 20, 20), height=50)])
        self.assertEqual(by_id['overture/own-height']['heightSource'], 'overture-height')
        self.assertEqual(by_id['overture/own-height']['upstream'], 'overture-eastasia')

    def test_globfp_supplement_is_globfp_eastasia(self):
        by_id, _, _ = self.build(globfp=[globfp_entry(wgs_box(120, 60, 40, 40), 60)])
        self.assertEqual(by_id['globfp/0']['heightSource'], 'globfp')
        self.assertEqual(by_id['globfp/0']['upstream'], 'globfp-eastasia')


# ------------------------------------------------------- 单元测试：可信度分项

class ConfidenceTests(_RecordBuildMixin, unittest.TestCase):
    """轮廓、高度、年代分开记可信度，估计值不能写成实测值。"""

    def test_published_override_is_high_height_confidence(self):
        tower = osm_feature('way/401', wgs_box(0, 0, 20, 20), {'building': 'commercial', 'height': '100'})
        overrides = {'way/401': {'osmId': 'way/401', 'name': '测试塔', 'heightM': 123.4,
                                 'sources': ['https://example.test/tower'], 'verifiedAt': '2026-11-09'}}
        by_id, _, _ = self.build(osm_buildings=[tower], height_overrides=overrides)
        self.assertEqual(by_id['way/401']['heightSource'], 'published')
        self.assertEqual(by_id['way/401']['heightConfidence'], 'high')

    def test_osm_levels_is_medium_and_estimate_is_low(self):
        leveled = osm_feature('way/411', wgs_box(0, 0, 20, 20), {'building': 'yes', 'building:levels': '10'})
        estimated = osm_feature('way/412', wgs_box(40, 0, 20, 20), {'building': 'yes'})
        by_id, _, _ = self.build(osm_buildings=[leveled, estimated])
        self.assertEqual(by_id['way/411']['heightSource'], 'osm-levels')
        self.assertEqual(by_id['way/411']['heightConfidence'], 'medium')
        self.assertEqual(by_id['way/412']['heightSource'], 'estimate')
        self.assertEqual(by_id['way/412']['heightConfidence'], 'low')

    def test_remote_footprint_has_low_footprint_confidence(self):
        features = [osm_feature('way/421', wgs_box(0, 0, 20, 20), {'building': 'yes'})]
        by_id, _, _ = self.build(osm_buildings=features,
                                 overture=[overture_entry('remote', wgs_box(80, 0, 10, 10))])
        self.assertEqual(by_id['way/421']['footprintConfidence'], 'medium')
        self.assertEqual(by_id['way/421']['eraConfidence'], 'medium')
        self.assertEqual(by_id['overture/remote']['footprintConfidence'], 'low')
        self.assertEqual(by_id['overture/remote']['heightConfidence'], 'low')
        self.assertEqual(by_id['overture/remote']['eraConfidence'], 'unknown')


# ------------------------------------------------- 单元测试：报告与待核清单

class BuildingRecordReportTests(_RecordBuildMixin, unittest.TestCase):
    """report['buildingRecords'] 统计和 report['pendingReview'] 待核清单。"""

    def test_building_records_counts_sum_to_output_length(self):
        features = [
            osm_feature('way/501', wgs_box(0, 0, 20, 20), {'building': 'yes'}),
            osm_feature('way/502', wgs_box(40, 0, 20, 20), {'building': 'yes', 'building:levels': '8'}),
        ]
        overture = [overture_entry('remote', wgs_box(80, 0, 10, 10))]
        globfp = [globfp_entry(wgs_box(120, 60, 40, 40), 60)]
        _, output, report = self.build(osm_buildings=features, overture=overture, globfp=globfp)
        records = report['buildingRecords']
        self.assertEqual(set(records), {'roles', 'upstreamFamilies', 'confidence'})
        self.assertEqual(set(records['confidence']), {'footprint', 'height', 'era'})
        self.assertLessEqual(set(records['roles']), set(ROLES))
        self.assertEqual(sum(records['roles'].values()), len(output))
        self.assertLessEqual(set(records['upstreamFamilies']), set(UPSTREAM_FAMILIES))
        self.assertEqual(sum(records['upstreamFamilies'].values()), len(output))
        for aspect in ('footprint', 'height', 'era'):
            counts = records['confidence'][aspect]
            self.assertLessEqual(set(counts), set(CONFIDENCE_LEVELS))
            self.assertEqual(sum(counts.values()), len(output))

    def test_deferred_footprint_enters_pending_review_with_reason(self):
        road = ground_road('way/road5001', wgs_line(-20, 0, 120, 0), 'tertiary', 12)
        overture = [overture_entry('road-box', wgs_box(10, 0.1, 10, 10))]
        _, _, report = self.build(overture=overture, roads=[road])
        review = report['pendingReview']
        self.assertEqual(set(review), {'rule', 'count', 'byReason', 'objects', 'truncated'})
        self.assertIsInstance(review['rule'], str)
        self.assertTrue(review['rule'])
        self.assertEqual(set(review['byReason']), set(PENDING_REASONS))
        self.assertEqual(review['byReason']['road-conflict-deferred'], 1)
        self.assertEqual(review['byReason']['road-conflict-osm-kept'], 0)
        self.assertEqual(review['byReason']['height-source-size-mismatch'], 0)
        self.assertEqual(review['count'], 1)
        self.assertIs(review['truncated'], False)
        entry = self.pending_objects(report)['overture/road-box']
        self.assertTrue(PENDING_FIELDS <= set(entry), f'待核对象缺字段：{entry}')
        self.assertEqual(entry['reasons'], ['road-conflict-deferred'])

    def test_pending_review_keeps_every_small_deferred_set(self):
        """待核样本有配额，但少量暂缓对象必须全部列出且 truncated 为 False。"""
        road = ground_road('way/road5002', wgs_line(-20, 0, 200, 0), 'tertiary', 12)
        overture = [overture_entry(f'road-box-{index}', wgs_box(10 + index * 30, 0.1, 10, 10))
                    for index in range(3)]
        _, _, report = self.build(overture=overture, roads=[road])
        review = report['pendingReview']
        self.assertEqual(review['byReason']['road-conflict-deferred'], 3)
        self.assertEqual(review['count'], 3)
        self.assertIs(review['truncated'], False)
        listed = {entry['id']: entry for entry in review['objects']}
        self.assertEqual(set(listed), {f'overture/road-box-{index}' for index in range(3)})
        for entry in listed.values():
            self.assertEqual(entry['reasons'], ['road-conflict-deferred'])

    def test_size_mismatched_globfp_overlap_enters_pending_review(self):
        small = osm_feature('way/601', wgs_box(10, 10, 4.6, 7.5), {'building': 'yes'})
        huge = globfp_entry(wgs_box(-11.7, -10.25, 48, 48), 118.5)
        by_id, _, report = self.build(osm_buildings=[small], globfp=[huge])
        self.assertEqual(by_id['way/601']['heightSource'], 'estimate')
        review = report['pendingReview']
        self.assertEqual(review['byReason']['height-source-size-mismatch'], 1)
        entry = self.pending_objects(report)['way/601']
        self.assertTrue(PENDING_FIELDS <= set(entry), f'待核对象缺字段：{entry}')
        self.assertEqual(entry['reasons'], ['height-source-size-mismatch'])
        self.assertAlmostEqual(entry['areaM2'], 34.5, places=1)
        self.assertEqual(entry['heightSource'], 'estimate')
        self.assertIsNotNone(entry['heightM'])

    def test_pending_review_merges_reasons_for_the_same_building(self):
        """同一栋楼同时占道又高度待核时，只合成一条记录，两个理由都保留。"""
        road = ground_road('way/road5004', wgs_line(-50, 0, 200, 0), 'tertiary', 12)
        # 楼只占车行道一侧 54%，中心线不穿入；巨大 GloBFP 轮廓盖住它但尺寸对不上
        building = osm_feature('way/621', wgs_box(20, 0.6, 10, 10), {'building': 'yes'})
        huge = globfp_entry(wgs_box(0, 0.5, 80, 100), 118.5)
        by_id, _, report = self.build(osm_buildings=[building], roads=[road], globfp=[huge])
        self.assertIn('way/621', by_id)
        review = report['pendingReview']
        self.assertEqual(review['count'], 1, '同一 id 只算一条待核记录')
        self.assertEqual(review['byReason']['road-conflict-osm-kept'], 1)
        self.assertEqual(review['byReason']['height-source-size-mismatch'], 1)
        entry = self.pending_objects(report)['way/621']
        self.assertEqual(set(entry['reasons']),
                         {'road-conflict-osm-kept', 'height-source-size-mismatch'})

    def test_osm_footprint_on_carriageway_stays_and_is_flagged(self):
        road = ground_road('way/road5003', wgs_line(-50, 80, 200, 80), 'primary', 20)
        mapped = osm_feature('way/611', wgs_box(20, 70, 20, 20), {'building': 'yes'})
        by_id, _, report = self.build(osm_buildings=[mapped], roads=[road])
        self.assertIn('way/611', by_id, 'OSM 已标注的楼不能因占道被删')
        review = report['pendingReview']
        self.assertEqual(review['byReason']['road-conflict-osm-kept'], 1)
        self.assertEqual(review['byReason']['road-conflict-deferred'], 0)
        entry = self.pending_objects(report)['way/611']
        self.assertEqual(entry['reasons'], ['road-conflict-osm-kept'])
        self.assertEqual(entry['heightSource'], 'estimate')


# ------------------------------------------------------ 集成测试：正式产物

class BuildingRecordsPackageTests(unittest.TestCase):
    """读重建后的共享包和构建报告；实现与重建落地前失败属预期。"""

    @classmethod
    def setUpClass(cls):
        cls.city = json.loads(gzip.decompress(CITY_PACKAGE.read_bytes()))
        cls.report = json.loads(BUILD_REPORT.read_text())
        cls.buildings = cls.city['buildings']
        cls.enums = cls.city['enums']
        ids = cls.buildings['id']
        cls.id_set = set(ids)
        cls.id_index = {}
        for index, identity in enumerate(ids):
            cls.id_index.setdefault(identity, index)

    def building_record(self, identity):
        index = self.id_index[identity]
        b = self.buildings
        enums = self.enums
        return {
            'height': b['h'][index],
            'heightSource': enums['heightSource'][b['src'][index]],
            'role': enums['buildingRole'][b['role'][index]],
            'upstreamFamily': enums['upstreamFamily'][b['upstream'][index]],
            'footprintConfidence': enums['confidence'][b['fpConf'][index]],
            'heightConfidence': enums['confidence'][b['hConf'][index]],
            'eraConfidence': enums['confidence'][b['eraConf'][index]],
        }

    def pending_objects(self):
        return {entry['id']: entry for entry in self.report['pendingReview']['objects']}

    def test_package_arrays_and_enums_are_present_and_valid(self):
        self.assertEqual(self.enums.get('buildingRole'), ROLES)
        self.assertEqual(self.enums.get('upstreamFamily'), UPSTREAM_FAMILIES)
        self.assertEqual(self.enums.get('confidence'), CONFIDENCE_LEVELS)
        b = self.buildings
        for field, enum_name in (('role', 'buildingRole'), ('upstream', 'upstreamFamily'),
                                 ('fpConf', 'confidence'), ('hConf', 'confidence'),
                                 ('eraConf', 'confidence')):
            self.assertIn(field, b, f'共享包 building 数组缺 {field}')
            values = b[field]
            self.assertEqual(len(values), len(b['h']), f'{field} 长度和 h 不一致')
            limit = len(self.enums[enum_name])
            self.assertTrue(all(isinstance(value, int) and 0 <= value < limit for value in values),
                            f'{field} 有非法枚举下标')

    def test_report_counts_match_package_arrays(self):
        records = self.report['buildingRecords']
        b = self.buildings
        enums = self.enums
        total = len(b['h'])
        roles = Counter(enums['buildingRole'][index] for index in b['role'])
        self.assertLessEqual(set(records['roles']), set(ROLES), 'report 角色统计出现非法键')
        for role in ROLES:
            self.assertEqual(records['roles'].get(role, 0), roles.get(role, 0),
                             f'角色 {role} 的计数和共享包不一致')
        self.assertEqual(sum(records['roles'].values()), total)
        families = Counter(enums['upstreamFamily'][index] for index in b['upstream'])
        self.assertLessEqual(set(records['upstreamFamilies']), set(UPSTREAM_FAMILIES),
                             'report 上游族统计出现非法键')
        for family in UPSTREAM_FAMILIES:
            self.assertEqual(records['upstreamFamilies'].get(family, 0), families.get(family, 0),
                             f'上游族 {family} 的计数和共享包不一致')
        self.assertEqual(sum(records['upstreamFamilies'].values()), total)
        counters = {
            'footprint': Counter(enums['confidence'][index] for index in b['fpConf']),
            'height': Counter(enums['confidence'][index] for index in b['hConf']),
            'era': Counter(enums['confidence'][index] for index in b['eraConf']),
        }
        for aspect, counter in counters.items():
            counts = records['confidence'][aspect]
            self.assertLessEqual(set(counts), set(CONFIDENCE_LEVELS),
                                 f'report {aspect} 可信度出现非法键')
            for level in CONFIDENCE_LEVELS:
                self.assertEqual(counts.get(level, 0), counter.get(level, 0),
                                 f'{aspect} 的 {level} 计数不一致')
            self.assertEqual(sum(counts.values()), total)

    def test_pole_record_is_unknown_overture_with_low_confidence(self):
        self.assertTrue(THIN_POLE_ID in self.id_index,
                        '细杆不见了：无法验证记录字段')
        record = self.building_record(THIN_POLE_ID)
        self.assertEqual(record['heightSource'], 'estimate')
        self.assertEqual(record['role'], 'unknown')
        self.assertEqual(record['upstreamFamily'], 'overture-eastasia')
        self.assertEqual(record['footprintConfidence'], 'low')
        self.assertEqual(record['heightConfidence'], 'low')
        self.assertEqual(record['eraConfidence'], 'unknown')

    def test_white_building_is_deferred_and_listed_in_pending_review(self):
        self.assertFalse(WHITE_BUILDING_ID in self.id_set,
                         '白楼仍在共享包里；重建前这是预期失败')
        deferred = self.report['deferredFootprints']
        deferred_ids = [item['id'] for item in deferred['objects']]
        self.assertIn(WHITE_BUILDING_ID, deferred_ids,
                      'deferredFootprints 里没有白楼（该段不封顶，必须能逐条核对）')
        review = self.report['pendingReview']
        self.assertEqual(review['byReason']['road-conflict-deferred'], deferred['count'])
        entry = self.pending_objects().get(WHITE_BUILDING_ID)
        self.assertIsNotNone(entry, 'pendingReview.objects 没有白楼（Overture 暂缓样本应占配额）')
        self.assertEqual(entry['reasons'], ['road-conflict-deferred'])

    def test_same_building_record_is_main_osm_with_globfp_height(self):
        self.assertTrue(SAME_BUILDING_ID in self.id_index, '京地大厦不在共享包里')
        record = self.building_record(SAME_BUILDING_ID)
        self.assertEqual(record['height'], 108.0)
        self.assertEqual(record['heightSource'], 'globfp')
        self.assertEqual(record['role'], 'main')
        self.assertEqual(record['upstreamFamily'], 'osm')
        self.assertEqual(record['heightConfidence'], 'low')
        self.assertEqual(record['footprintConfidence'], 'medium')
        self.assertEqual(record['eraConfidence'], 'medium')

    def test_pending_review_summary_is_consistent(self):
        review = self.report['pendingReview']
        self.assertEqual(set(review), {'rule', 'count', 'byReason', 'objects', 'truncated'})
        self.assertIsInstance(review['rule'], str)
        self.assertTrue(review['rule'])
        self.assertEqual(set(review['byReason']), set(PENDING_REASONS))
        for reason in PENDING_REASONS:
            self.assertIsInstance(review['byReason'][reason], int)
            self.assertGreaterEqual(review['byReason'][reason], 0)
        self.assertGreater(review['count'], 0)
        self.assertGreater(review['byReason']['height-source-size-mismatch'], 0)
        self.assertEqual(review['byReason']['road-conflict-deferred'],
                         self.report['deferredFootprints']['count'])
        objects = review['objects']
        self.assertLessEqual(len(objects), 300)
        self.assertEqual(review['truncated'], review['count'] > len(objects))
        self.assertEqual(len({entry['id'] for entry in objects}), len(objects),
                         '待核清单里同一个 id 必须合并成一条')
        listed = self.pending_objects()
        for reason in PENDING_REASONS:
            flagged = sum(1 for entry in objects if reason in entry['reasons'])
            self.assertLessEqual(flagged, review['byReason'][reason],
                                 f'{reason} 的样本条数超过全量计数')
        for entry in objects:
            self.assertTrue(PENDING_FIELDS <= set(entry), f'待核对象缺字段：{entry}')
            self.assertIsInstance(entry['reasons'], list)
            self.assertTrue(entry['reasons'])
            self.assertLessEqual(set(entry['reasons']), set(PENDING_REASONS))
        self.assertEqual(set(listed), {entry['id'] for entry in objects})


if __name__ == '__main__':
    unittest.main()
