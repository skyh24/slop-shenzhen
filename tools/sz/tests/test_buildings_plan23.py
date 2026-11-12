"""23 号方案第 1 步回归：删除 GloBFP 半覆盖继承高度，给补充轮廓加占道门槛。

对应 docs/23-BUILDING-AND-STREET-PLAN.md 第 3、8 节第 1 步：
1. 尺寸不相称的 GloBFP 轮廓不得再把楼高借给小底面，只能走 estimate；
2. 补充轮廓被道路中心线穿过，或落在估算车行道（半宽，不加 1 米缓冲）里的比例
   达到 50%，就暂缓进场景并写进构建报告；OSM 已标注的楼永不自动删。

单元测试用临时 JSONL 和 mock 复现数据管线；集成测试直接读正式共享包和构建报告，
在重建产物之前会失败，失败信息带上当前统计。
"""

import gzip
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import LineString, box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from buildings import HEIGHT_SOURCES, build_buildings
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON

ROOT = Path(__file__).resolve().parents[3]
CITY_PACKAGE = ROOT / 'js/sz-city.json.gz'
BUILD_REPORT = ROOT / 'data/source/build-report.json'

WHITE_BUILDING_ID = 'overture/f090af25-fa60-4bc9-99da-2bdfee0566c1'
THIN_POLE_ID = 'overture/ebf91e15-f0b2-4e0f-a517-088e8f500c33'
SAME_BUILDING_ID = 'way/612995515'
WHITE_BUILDING_CENTROID = (-966.5, 121.7)
WHITE_BUILDING_AREA = 94.3
THIN_POLE_CENTROID = (-1171.0, 59.4)
THIN_POLE_AREA = 33.6
SAME_BUILDING_AREA = 1652.8

DEFERRED_OBJECT_FIELDS = {'id', 'areaM2', 'reason', 'roadId', 'roadWidthM',
                          'roadWidthSource', 'imageryChecked'}


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


def local_road(identity, points, half_width):
    """filter_road_conflicts 直接输入：局部米制中心线加半宽。"""
    return {'id': identity, 'geom': LineString(points), 'halfWidthM': half_width}


def ring_points(flat):
    """共享包的 ring：分米整数、逐点差分；还原成局部米制点。"""
    x = z = 0
    points = []
    for dx, dz in zip(flat[::2], flat[1::2]):
        x += dx
        z += dz
        points.append((x / 10.0, z / 10.0))
    return points


def polygon_area(points):
    total = 0.0
    for (x1, z1), (x2, z2) in zip(points, points[1:] + points[:1]):
        total += x1 * z2 - x2 * z1
    return abs(total) / 2.0


def polygon_centroid(points):
    double_area = cx = cz = 0.0
    for (x1, z1), (x2, z2) in zip(points, points[1:] + points[:1]):
        cross = x1 * z2 - x2 * z1
        double_area += cross
        cx += (x1 + x2) * cross
        cz += (z1 + z2) * cross
    area = double_area / 2.0
    return cx / (6 * area), cz / (6 * area)


def polygon_contains(points, point):
    """射线法判断点是否在轮廓内；先用包围盒挡掉绝大多数楼。"""
    px, pz = point
    xs = [item[0] for item in points]
    zs = [item[1] for item in points]
    if not (min(xs) <= px <= max(xs) and min(zs) <= pz <= max(zs)):
        return False
    inside = False
    for (x1, z1), (x2, z2) in zip(points, points[1:] + points[:1]):
        if (z1 > pz) != (z2 > pz):
            cross_x = x1 + (pz - z1) * (x2 - x1) / (z2 - z1)
            if cross_x > px:
                inside = not inside
    return inside


def segment_distance(point, start, end):
    px, pz = point
    ax, az = start
    bx, bz = end
    dx, dz = bx - ax, bz - az
    if dx == 0 and dz == 0:
        return math.hypot(px - ax, pz - az)
    t = ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)
    t = min(1.0, max(0.0, t))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def road_conflict_filter():
    """实现落地前这里抛 ImportError，测试失败原因一目了然。"""
    from buildings import filter_road_conflicts
    return filter_road_conflicts


# ------------------------------------------------------- 单元测试：楼高匹配

class _TemporaryBuildMixin:
    """用临时 JSONL 替代原始数据快照，跑完整 build_buildings。"""

    def build(self, osm_buildings=(), roads=(), green=(), plaza=(), overture=(), globfp=(),
              reviews=(), clip=(-50, -50, 300, 300)):
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
                output = build_buildings(osm, box(*clip), report,
                                         overture_path=overture_file, globfp_path=globfp_file)
        return {item['id']: item for item in output}, report


class BuildingHeightMatchingTests(_TemporaryBuildMixin, unittest.TestCase):
    """23 号第 8 节第 1 步 A：只保留严格同楼匹配，删掉半覆盖继承。"""

    def test_height_source_enum_no_longer_contains_globfp_overlap(self):
        self.assertNotIn('globfp-overlap', HEIGHT_SOURCES)

    def test_size_mismatched_globfp_overlap_does_not_supply_height(self):
        """4.6 x 7.5 m 的细杆底面被 48 x 48 m 的 GloBFP 轮廓盖住，也不得继承 118.5 m。"""
        pole = osm_feature('way/3344551', wgs_box(10, 10, 4.6, 7.5), {'building': 'yes'})
        huge = globfp_entry(wgs_box(-11.7, -10.25, 48, 48), 118.5)
        by_id, report = self.build(osm_buildings=[pole], globfp=[huge])
        self.assertIn('way/3344551', by_id)
        self.assertEqual(by_id['way/3344551']['heightSource'], 'estimate')
        self.assertNotAlmostEqual(by_id['way/3344551']['height'], 118.5, places=1)
        self.assertEqual(report['heightSources'].get('globfp-overlap', 0), 0,
                         f"heightSources 里仍有 globfp-overlap：{report['heightSources']}")

    def test_true_same_building_still_gets_globfp_height(self):
        """面积比、交并比、中心距都满足的真同楼仍取 GloBFP 高度（回归不能一起删掉）。"""
        same = osm_feature('way/7788991', wgs_box(0, 0, 20, 20), {'building': 'commercial'})
        matched = globfp_entry(wgs_box(0, 0, 20, 20), 80)
        by_id, report = self.build(osm_buildings=[same], globfp=[matched])
        self.assertEqual(by_id['way/7788991']['heightSource'], 'globfp')
        self.assertEqual(by_id['way/7788991']['height'], 80)
        # GloBFP 轮廓和 OSM 楼几乎完全重叠，不应再生成一栋补充楼
        self.assertNotIn('globfp/0', by_id)


# --------------------------------------------- 单元测试：补充轮廓占道门槛接线

class RoadConflictBuildTests(_TemporaryBuildMixin, unittest.TestCase):
    """filter_road_conflicts 在 build_buildings 里对 GloBFP 和 Overture 两条补充路径的接线。"""

    def assert_deferred_section(self, section, *, count, candidates, kept):
        self.assertIsInstance(section['rule'], str)
        self.assertTrue(section['rule'])
        self.assertEqual(section['roadWidthSource'], 'estimated')
        self.assertIs(section['imageryChecked'], False)
        self.assertEqual(section['count'], count)
        self.assertEqual(section['candidates'], candidates)
        self.assertEqual(section['kept'], kept)
        self.assertIs(section['truncated'], False)
        for entry in section['objects']:
            self.assertTrue(DEFERRED_OBJECT_FIELDS <= set(entry), f'暂缓对象缺字段：{entry}')

    def test_overture_only_footprint_on_carriageway_is_deferred(self):
        """Overture 独有轮廓有 59% 落在估算车行道里就暂缓，不写进输出，两类报告都要有。"""
        road = ground_road('way/road4001', wgs_line(-20, 0, 120, 0), 'tertiary', 12)
        # 10 x 10 m 轮廓只压在车行道一侧 6 m 中的 5.9 m：无 1 米缓冲时占 59%，
        # 加 1 米缓冲后占 69% < 80%，所以能穿过旧的误识别过滤，正好由新门槛接住。
        overture = [overture_entry('road-box', wgs_box(10, 0.1, 10, 10))]
        by_id, report = self.build(overture=overture, roads=[road])
        self.assertNotIn('overture/road-box', by_id)
        for key in ('globfpRoadConflicts', 'overtureRoadConflicts', 'deferredFootprints'):
            self.assertIn(key, report, f'build_buildings 没有写占道报告段 {key}')
        section = report['overtureRoadConflicts']
        self.assert_deferred_section(section, count=1, candidates=1, kept=0)
        entry = section['objects'][0]
        self.assertEqual(entry['id'], 'overture/road-box')
        self.assertEqual(entry['reason'], 'road-carriageway')
        self.assertAlmostEqual(entry['areaM2'], 100.0)
        self.assertEqual(entry['roadId'], 'way/road4001')
        self.assertAlmostEqual(entry['roadWidthM'], 12.0)
        self.assertEqual(entry['roadWidthSource'], 'estimated')
        self.assertIs(entry['imageryChecked'], False)
        # 没有 GloBFP 候选时报告段也要写，count 为 0
        self.assertEqual(report['globfpRoadConflicts']['count'], 0)
        combined = report['deferredFootprints']
        self.assertEqual(combined['count'], 1)
        self.assertAlmostEqual(combined['areaM2'], 100.0)
        self.assertEqual(combined['bySource'], {'globfp': 0, 'overture': 1})
        self.assertEqual(combined['roadWidthSource'], 'estimated')
        self.assertIs(combined['imageryChecked'], False)
        self.assertIs(combined['truncated'], False)
        self.assertEqual([item['id'] for item in combined['objects']], ['overture/road-box'])
        self.assertEqual(combined['objects'][0]['source'], 'overture')
        self.assertEqual(combined['objects'][0]['reason'], 'road-carriageway')

    def test_centerline_crossing_defers_even_below_carriageway_share(self):
        """窄路中心线穿过轮廓内部时，车行道占比只有 40% 也暂缓，理由优先记中心线。"""
        road = ground_road('way/road4002', wgs_line(-20, 0, 120, 0), 'residential', 4)
        overture = [overture_entry('crossing', wgs_box(10, -5, 10, 10))]
        by_id, report = self.build(overture=overture, roads=[road])
        self.assertNotIn('overture/crossing', by_id)
        self.assertIn('overtureRoadConflicts', report, 'build_buildings 没有写占道报告段')
        entry = report['overtureRoadConflicts']['objects'][0]
        self.assertEqual(entry['id'], 'overture/crossing')
        self.assertEqual(entry['reason'], 'road-centerline')
        self.assertAlmostEqual(entry['roadWidthM'], 4.0)
        self.assertAlmostEqual(report['deferredFootprints']['areaM2'], 100.0)

    def test_osm_mapped_building_on_carriageway_is_never_auto_removed(self):
        """OSM 已标注的楼压在车行道上也保留；占道门槛只作用于遥感补充轮廓。"""
        road = ground_road('way/road4003', wgs_line(-50, 80, 200, 80), 'primary', 20)
        mapped = osm_feature('way/1122334', wgs_box(20, 70, 20, 20), {'building': 'yes'})
        by_id, report = self.build(osm_buildings=[mapped], roads=[road])
        self.assertIn('way/1122334', by_id)
        self.assertEqual(by_id['way/1122334']['heightSource'], 'estimate')
        for key in ('globfpRoadConflicts', 'overtureRoadConflicts', 'deferredFootprints'):
            self.assertIn(key, report, f'build_buildings 没有写占道报告段 {key}')
        self.assertEqual(report['globfpRoadConflicts']['count'], 0)
        self.assertEqual(report['overtureRoadConflicts']['count'], 0)
        self.assertEqual(report['deferredFootprints']['count'], 0)
        self.assertEqual(report['deferredFootprints']['bySource'], {'globfp': 0, 'overture': 0})
        self.assertEqual(report['deferredFootprints']['objects'], [])

    def test_globfp_only_footprint_on_carriageway_is_deferred_and_reported(self):
        """GloBFP 补充路径同样接占道门槛：400 m2 轮廓覆盖车行道 57.5% 就暂缓。"""
        road = ground_road('way/road4101', wgs_line(-50, 0, 200, 0), 'primary', 24)
        # 面积 >= 300 m2，旧的误识别过滤不按面积删，交给新的占道门槛判断
        big = globfp_entry(wgs_box(10, 0.5, 20, 20), 60)
        by_id, report = self.build(globfp=[big], roads=[road])
        self.assertNotIn('globfp/0', by_id)
        self.assertIn('globfpRoadConflicts', report, 'build_buildings 没有写占道报告段')
        section = report['globfpRoadConflicts']
        self.assert_deferred_section(section, count=1, candidates=1, kept=0)
        entry = section['objects'][0]
        self.assertEqual(entry['id'], 'globfp/0')
        self.assertEqual(entry['reason'], 'road-carriageway')
        self.assertAlmostEqual(entry['areaM2'], 400.0)
        self.assertAlmostEqual(entry['roadWidthM'], 24.0)
        combined = report['deferredFootprints']
        self.assertEqual(combined['bySource'], {'globfp': 1, 'overture': 0})
        self.assertEqual(combined['objects'][0]['id'], 'globfp/0')
        self.assertEqual(combined['objects'][0]['source'], 'globfp')


# ------------------------------------- 单元测试：filter_road_conflicts 直接调用

class RoadConflictHelperTests(unittest.TestCase):
    """契约字段、两条规则和优先顺序；候选和中心线都用局部米制坐标。"""

    def run_filter(self, candidates, roads, *, report_key='globfpRoadConflicts',
                   source_label='GloBFP-only', report=None):
        report = {} if report is None else report
        kept, deferred = road_conflict_filter()(candidates, roads, report,
                                                report_key=report_key, source_label=source_label)
        return kept, deferred, report

    def test_footprint_fully_inside_carriageway_is_deferred(self):
        candidate = {'id': 'overture/inside', 'geom': box(10, 2, 20, 12)}
        roads = [local_road('way/road', [(-20, 0), (120, 0)], 12.0)]
        kept, deferred, report = self.run_filter([candidate], roads)
        self.assertEqual(kept, [])
        self.assertEqual([item['id'] for item in deferred], ['overture/inside'])
        self.assertEqual(deferred[0]['reason'], 'road-carriageway')
        self.assertAlmostEqual(deferred[0]['areaM2'], 100.0)
        self.assertTrue(DEFERRED_OBJECT_FIELDS <= set(deferred[0]))
        section = report['globfpRoadConflicts']
        self.assertEqual(section['count'], 1)
        self.assertEqual(section['candidates'], 1)
        self.assertEqual(section['kept'], 0)
        self.assertEqual(section['roadWidthSource'], 'estimated')
        self.assertIs(section['imageryChecked'], False)
        self.assertIs(section['truncated'], False)
        self.assertIsInstance(section['rule'], str)
        self.assertTrue(section['rule'])

    def test_carriageway_share_below_half_and_no_crossing_is_kept(self):
        # 轮廓从 z=0.5 起，中心线 z=0 不进入内部；半宽 5 时覆盖率 45% < 50%
        candidate = {'id': 'overture/edge', 'geom': box(10, 0.5, 20, 10.5)}
        roads = [local_road('way/road', [(-20, 0), (120, 0)], 5.0)]
        kept, deferred, report = self.run_filter([candidate], roads)
        self.assertEqual([item['id'] for item in kept], ['overture/edge'])
        self.assertEqual(deferred, [])
        self.assertEqual(report['globfpRoadConflicts']['count'], 0)
        self.assertEqual(report['globfpRoadConflicts']['areaM2'], 0.0)
        self.assertEqual(report['globfpRoadConflicts']['objects'], [])

    def test_centerline_crossing_is_checked_before_carriageway_share(self):
        # 轮廓同时被中心线穿过、又完全落在车行道里，理由必须记中心线
        candidate = {'id': 'overture/both', 'geom': box(10, -5, 20, 5)}
        roads = [local_road('way/road', [(-20, 0), (120, 0)], 10.0)]
        _, deferred, _ = self.run_filter([candidate], roads)
        self.assertEqual(deferred[0]['reason'], 'road-centerline')

    def test_crossing_length_threshold_is_half_a_metre(self):
        # 中心线在轮廓内的长度 0.4 m 不触发，0.8 m 触发
        narrow = {'id': 'overture/shallow', 'geom': box(10, -3, 10.4, 3)}
        deep = {'id': 'overture/deep', 'geom': box(30, -3, 30.8, 3)}
        ruler = local_road('way/road', [(-20, 0), (120, 0)], 0.5)
        kept, deferred, _ = self.run_filter([narrow, deep], [ruler])
        self.assertEqual([item['id'] for item in kept], ['overture/shallow'])
        self.assertEqual([(item['id'], item['reason']) for item in deferred],
                         [('overture/deep', 'road-centerline')])

    def test_report_keeps_full_count_when_the_object_list_is_capped(self):
        candidates = [{'id': f'globfp/{index}', 'geom': box(index * 12, 0, index * 12 + 10, 10)}
                      for index in range(305)]
        roads = [local_road('way/road', [(-100, 5), (5000, 5)], 20.0)]
        kept, deferred, report = self.run_filter(candidates, roads)
        self.assertEqual(kept, [])
        self.assertEqual(len(deferred), 305)
        section = report['globfpRoadConflicts']
        self.assertEqual(section['count'], 305)
        self.assertEqual(len(section['objects']), 300)
        self.assertTrue(section['truncated'])
        self.assertAlmostEqual(section['areaM2'], 305 * 100.0)
        self.assertEqual(section['candidates'], 305)
        self.assertEqual(section['kept'], 0)

    def test_overture_report_key_and_label_are_used(self):
        candidate = {'id': 'overture/labelled', 'geom': box(10, 2, 20, 12)}
        roads = [local_road('way/road', [(-20, 0), (120, 0)], 12.0)]
        _, deferred, report = self.run_filter(
            [candidate], roads, report_key='overtureRoadConflicts',
            source_label='Overture-only (no OSM building)')
        self.assertEqual(deferred[0]['reason'], 'road-carriageway')
        self.assertNotIn('globfpRoadConflicts', report)
        self.assertTrue(report['overtureRoadConflicts']['rule'])


# ------------------------------------------------------ 集成测试：正式产物

class SharedPackageRegressionTests(unittest.TestCase):
    """读正式共享包和构建报告；重建前失败属预期，失败信息带当前统计。"""

    @classmethod
    def setUpClass(cls):
        cls.city = json.loads(gzip.decompress(CITY_PACKAGE.read_bytes()))
        cls.report = json.loads(BUILD_REPORT.read_text())
        buildings = cls.city['buildings']
        cls.ids = buildings['id']
        cls.id_set = set(cls.ids)
        cls.id_index = {}
        for index, identity in enumerate(cls.ids):
            cls.id_index.setdefault(identity, index)
        cls.sources = [cls.city['enums']['heightSource'][index] for index in buildings['src']]

    def building_ring(self, identity):
        index = self.id_index[identity]
        return ring_points(self.city['buildings']['rings'][index][0])

    def test_shared_package_and_report_have_no_globfp_overlap(self):
        overlap = [identity for identity, source in zip(self.ids, self.sources)
                   if source == 'globfp-overlap']
        # 只报数量和样例，避免断言失败时把 8000 多个 ID 全打印出来
        self.assertEqual(len(overlap), 0,
                         f'{len(overlap)} 栋楼仍是 globfp-overlap，例如 {overlap[:5]}')
        count = self.report['heightSources'].get('globfp-overlap', 0)
        self.assertEqual(count, 0,
                         f"build-report.json 的 heightSources 仍记 globfp-overlap={count}；"
                         f"当前统计 {self.report['heightSources']}")
        self.assertNotIn('globfp-overlap', self.city['enums']['heightSource'])
        # 严格同楼匹配必须保留，否则就不是“只删半覆盖后备”
        self.assertGreater(self.report['heightSources'].get('globfp', 0), 0)

    def test_fuzhong_third_road_white_building_is_deferred(self):
        """福中三路白楼：不进场景，进暂缓报告；按位置和面积确认是同一对象。"""
        self.assertFalse(WHITE_BUILDING_ID in self.id_set,
                         '白楼仍在共享包里；重建前这是预期失败')
        # 位置核验一：包内没有别的楼的轮廓包含白楼中心点 (-966.5, 121.7)
        occupying = []
        for identity, rings in zip(self.ids, self.city['buildings']['rings']):
            if polygon_contains(ring_points(rings[0]), WHITE_BUILDING_CENTROID):
                occupying.append(identity)
        self.assertEqual(occupying, [],
                         f'白楼位置仍被轮廓占据：{occupying[:5]}')
        # 位置核验二：福中三路中心线距该点约 4.0 m、路宽 9 m，和暂缓对象对得上
        roads = self.named_roads('福中三路')
        self.assertTrue(roads, '共享包里找不到福中三路的中心线，无法按位置核验')
        nearest = min(segment_distance(WHITE_BUILDING_CENTROID, start, end)
                      for points, _width in roads
                      for start, end in zip(points, points[1:]))
        self.assertLessEqual(nearest, 6.0,
                             f'白楼位置距福中三路中心线 {nearest:.1f} m，位置核验不成立')
        self.assertIn(9.0, [width for _points, width in roads],
                      '福中三路估算宽度不是 9 m，与暂缓报告的 roadWidthM 对不上')
        combined = self.report.get('deferredFootprints')
        self.assertIsNotNone(combined, 'build-report.json 没有 deferredFootprints 段落')
        self.assertIs(combined['truncated'], False)
        self.assertEqual(combined['roadWidthSource'], 'estimated')
        self.assertIs(combined['imageryChecked'], False)
        self.assertGreater(combined['count'], 0)
        self.assertGreater(combined['bySource']['overture'], 0)
        self.assertEqual(set(combined['bySource']), {'globfp', 'overture'})
        entries = [item for item in combined['objects'] if item['id'] == WHITE_BUILDING_ID]
        self.assertEqual(len(entries), 1,
                         f'deferredFootprints 里没有白楼 {WHITE_BUILDING_ID}；'
                         f"count={combined['count']} bySource={combined['bySource']}")
        entry = entries[0]
        self.assertTrue(DEFERRED_OBJECT_FIELDS <= set(entry), f'暂缓对象缺字段：{entry}')
        self.assertEqual(entry['reason'], 'road-carriageway')
        self.assertAlmostEqual(entry['areaM2'], WHITE_BUILDING_AREA, delta=1.0)
        self.assertAlmostEqual(entry['roadWidthM'], 9.0, places=1)
        self.assertEqual(entry['roadWidthSource'], 'estimated')
        self.assertIs(entry['imageryChecked'], False)
        self.assertEqual(entry['source'], 'overture')
        # 触发暂缓的是白楼旁约 4 m 的福中三路地面路段，路宽 9 m；固定 ID 也是位置证据
        self.assertEqual(entry['roadId'], 'way/616988561')
        # 分来源段落同样要在（对象可能被 300 条上限截掉，只查计数）
        section = self.report['overtureRoadConflicts']
        self.assertEqual(section['roadWidthSource'], 'estimated')
        self.assertIs(section['imageryChecked'], False)
        self.assertGreater(section['count'], 0)

    def test_fuzhong_third_road_thin_pole_no_longer_118_5(self):
        """细杆必须还在原地（面积 33.6 m2、中心 (-1171.0, 59.4)），只是高度改成 estimate。"""
        self.assertTrue(THIN_POLE_ID in self.id_index,
                        '细杆不见了：这是删除而不是修正，回归无法证明是同一对象')
        index = self.id_index[THIN_POLE_ID]
        points = self.building_ring(THIN_POLE_ID)
        self.assertAlmostEqual(polygon_area(points), THIN_POLE_AREA, delta=0.5)
        centroid = polygon_centroid(points)
        self.assertAlmostEqual(centroid[0], THIN_POLE_CENTROID[0], delta=1.5)
        self.assertAlmostEqual(centroid[1], THIN_POLE_CENTROID[1], delta=1.5)
        height = self.city['buildings']['h'][index]
        source = self.sources[index]
        self.assertNotAlmostEqual(height, 118.5, places=1)
        self.assertNotEqual(source, 'globfp-overlap')
        self.assertEqual(source, 'estimate',
                         f'细杆高度来源是 {source}（高度 {height} m），应为 estimate')
        # 细杆周围没有车行道冲突，必须留在场景里而不是被占道门槛暂缓
        deferred_ids = {item['id'] for item in self.report.get('deferredFootprints', {}).get('objects', [])}
        self.assertFalse(THIN_POLE_ID in deferred_ids, '细杆被占道门槛误暂缓了')

    def test_true_same_building_keeps_globfp_height_in_shared_package(self):
        """京地大厦（way/612995515）通过严格匹配，必须继续拿 GloBFP 高度。"""
        self.assertTrue(SAME_BUILDING_ID in self.id_index, '京地大厦不在共享包里')
        index = self.id_index[SAME_BUILDING_ID]
        self.assertEqual(self.city['buildings']['h'][index], 108.0)
        self.assertEqual(self.sources[index], 'globfp')
        points = self.building_ring(SAME_BUILDING_ID)
        self.assertAlmostEqual(polygon_area(points), SAME_BUILDING_AREA, delta=3.0)

    def named_roads(self, keyword):
        """从正式有向路网读取道路中心线和车行宽度。"""
        graph = self.city['roadGraph']
        nodes = list(zip(graph['nodes'][::2], graph['nodes'][1::2]))
        return [
            ([nodes[start], *zip(inner[::2], inner[1::2]), nodes[end]], width)
            for start, end, name, width, _, _, inner in graph['links']
            if keyword in graph['names'][name]
        ]


if __name__ == '__main__':
    unittest.main()
