"""通用隧道洞口裁地形的单元测试。

合成三类场景：平地 layer 0、无共享端、单/双共享端；覆盖 cover 与地形无关、缺地形跳过、
窄源宽加宽、裁切后三角面减少且坐标有限。pytest 与 unittest 都能直接运行。
"""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import Point  # noqa: E402
from elevated_cut import apply_elevated_cut  # noqa: E402

from tunnel_portals import (COVER_MAX_M, COVER_MIN_M, MIN_TUNNEL_WIDTH_M,  # noqa: E402
                            CORRIDOR_MARGIN_M, _SurfaceSampler, apply_tunnel_portal_cut,
                            plan_tunnel_portal_mask)

STEP = 4.0
ORIGIN_X = 80.0
ORIGIN_Z = 80.0
CHUNK_SIZE = 900.0
START = (100.0, 100.0)
END = (300.0, 100.0)


def terrain_surface(heights, x0=ORIGIN_X, z0=ORIGIN_Z, columns=56, rows=11):
    """按 build_terrain_surface 的方格规则生成一块 terrainSurface，两三角面/格。"""
    positions, indices, ranges = [], [], []
    for row in range(rows - 1):
        for column in range(columns - 1):
            start = len(indices)
            corners = [(column, row), (column + 1, row), (column, row + 1), (column + 1, row + 1)]
            ids = []
            for corner_column, corner_row in corners:
                x = x0 + corner_column * STEP
                z = z0 + corner_row * STEP
                ids.append(len(positions) // 3)
                positions.extend([x - 0, heights(x, z), z - 0])
            a, b, c, d = ids
            indices.extend([a, c, b, b, c, d])
            ranges.extend([row * (columns - 1) + column, start, len(indices) - start])
    chunk = {'id': '0,0', 'origin': [0.0, 0.0], 'positions': positions, 'indices': indices,
             'kinds': [0] * (len(positions) // 3), 'cellRanges': ranges}
    return {'version': 1, 'chunkSize': CHUNK_SIZE, 'chunks': [chunk], 'heightSource': 'test',
            'diagonal': 'ne-sw', 'weightSurface': 'not-generated',
            'grid': {'x0': x0, 'z0': z0, 'step': STEP, 'nx': columns, 'nz': rows}}


def flat(height=5.0):
    return lambda x, z: height


class GraphBuilder:
    def __init__(self):
        self.nodes, self.node_ids, self.links, self.metadata = [], [], [], []
        self.names = ['测试路']

    def node(self, x, z):
        index = len(self.node_ids)
        self.nodes.extend([x, z])
        self.node_ids.append(f'node-{index}')
        return index

    def add_link(self, a, b, width=10.0, inner=(), **overrides):
        metadata = {'osmId': len(self.links), 'highway': 'primary', 'layer': 0, 'bridge': False,
                    'tunnel': False, 'heightSource': 'terrain', 'widthSource': 'tag',
                    'lengthM': 1.0}
        metadata.update(overrides)
        self.links.append([a, b, 0, width, 3, 0, list(inner)])
        self.metadata.append(metadata)
        return metadata

    def graph(self):
        return {'nodes': self.nodes, 'nodeIds': self.node_ids, 'links': self.links,
                'names': self.names, 'metadata': self.metadata}


def tunnel_graph(shared_start=True, shared_end=True, layer=1, width=10.0):
    builder = GraphBuilder()
    a = builder.node(*START)
    b = builder.node(*END)
    builder.add_link(a, b, width=width, tunnel=True, layer=layer, heightSource='estimate')
    if shared_start:
        builder.add_link(a, builder.node(START[0] - 60, START[1]))
    if shared_end:
        builder.add_link(b, builder.node(END[0] + 60, END[1]))
    return builder.graph()


class ElevatedCutTest(unittest.TestCase):
    def test_g4_cuts_side_slope_to_rendered_deck_width(self):
        graph = GraphBuilder()
        graph.names[0] = '京港澳高速'
        a, b = (graph.node(*point) for point in (START, END))
        graph.add_link(a, b, width=9.8, bridge=True, layer=1, highway='motorway', heightSource='unresolved')
        graph.links[0][5] = 1
        # 中线低于桥面，只有侧坡进入加宽后的桥面。裁口保留两端与走廊外地形。
        source = terrain_surface(lambda x, z: 11.0 if 184 <= x <= 216 and z >= 104 else 5.0)
        old_wall = {'positions': [100, 1, 88, 100, 5, 88, 105, 5, 88], 'triangles': 1, 'minY': 1, 'maxY': 5}
        source['cutWalls'] = old_wall
        report = {}
        cut = apply_elevated_cut(source, graph.graph(), report)
        height_at = _SurfaceSampler(cut)
        self.assertIsNone(height_at(200, 105.7))
        self.assertEqual(height_at(200, 108), 11.0)
        self.assertEqual(height_at(*START), 5.0)
        self.assertEqual(height_at(*END), 5.0)
        self.assertEqual(report['elevatedCut']['links'], 1)
        self.assertGreater(cut['cutWalls']['triangles'], old_wall['triangles'])
        self.assertEqual(cut['cutWalls']['positions'][:9], old_wall['positions'])
        self.assertIs(apply_elevated_cut(cut, graph.graph(), report), cut)


class TunnelPortalCutTest(unittest.TestCase):
    def setUp(self):
        self.surface = terrain_surface(flat())

    def test_layer_zero_tunnel_is_not_cut(self):
        graph = tunnel_graph(layer=0)
        report = {}
        mask = plan_tunnel_portal_mask(graph, self.surface, report)
        self.assertTrue(mask.is_empty)
        self.assertEqual(report['tunnelPortals'], {'links': 0, 'portalSpans': 0, 'cutM2': 0.0,
                                                   'genericCutM2': 0.0})
        self.assertIs(apply_tunnel_portal_cut(self.surface, graph, report), self.surface)

    def test_tunnel_without_shared_end_is_not_cut(self):
        report = {}
        mask = plan_tunnel_portal_mask(tunnel_graph(shared_start=False, shared_end=False),
                                       self.surface, report)
        self.assertTrue(mask.is_empty)
        self.assertEqual(report['tunnelPortals']['links'], 0)

    def test_shared_start_opens_one_span(self):
        report = {}
        mask = plan_tunnel_portal_mask(tunnel_graph(shared_end=False), self.surface, report)
        self.assertEqual(report['tunnelPortals']['links'], 1)
        self.assertEqual(report['tunnelPortals']['portalSpans'], 1)
        self.assertGreater(report['tunnelPortals']['cutM2'], 0)
        # layer 1 埋深 6 m，cover 在 12 m 过渡带内从 0 涨到 6，开敞段是 0.1–11.2 m。
        self.assertTrue(mask.contains(Point(START[0] + 0.2, START[1])))
        self.assertTrue(mask.contains(Point(START[0] + 11.0, START[1])))
        self.assertFalse(mask.contains(Point(START[0] + 0.05, START[1])))
        self.assertFalse(mask.contains(Point(START[0] + 12.0, START[1])))
        self.assertLess(mask.bounds[2], START[0] + 12.0)
        self.assertGreater(mask.bounds[0], START[0])

    def test_both_shared_ends_open_two_spans(self):
        report = {}
        mask = plan_tunnel_portal_mask(tunnel_graph(), self.surface, report)
        self.assertEqual(report['tunnelPortals']['portalSpans'], 2)
        self.assertGreater(mask.bounds[2], END[0] - 12.0)

    def test_cover_does_not_depend_on_terrain(self):
        flat_report, hill_report = {}, {}
        flat_mask = plan_tunnel_portal_mask(tunnel_graph(), self.surface, flat_report)
        hill_mask = plan_tunnel_portal_mask(tunnel_graph(), terrain_surface(lambda x, z: 40.0),
                                            hill_report)
        self.assertEqual(flat_report['tunnelPortals'], hill_report['tunnelPortals'])
        self.assertAlmostEqual(flat_mask.area, hill_mask.area, places=6)

    def test_layer_scales_the_open_band(self):
        report = {}
        plan_tunnel_portal_mask(tunnel_graph(shared_end=False, layer=2), self.surface, report)
        # layer 2 埋深 12 m：cover 在 d = 12 * cover / 12 = cover，开敞段缩到 0.05–5.6 m。
        self.assertEqual(report['tunnelPortals']['portalSpans'], 1)
        mask = plan_tunnel_portal_mask(tunnel_graph(shared_end=False, layer=2), self.surface)
        self.assertGreater(mask.bounds[0], START[0])
        self.assertLess(mask.bounds[2], START[0] + 6.0)

    def test_narrow_link_uses_minimum_width_and_margin(self):
        mask = plan_tunnel_portal_mask(tunnel_graph(shared_end=False, width=3.0), self.surface)
        width = mask.bounds[3] - mask.bounds[1]
        self.assertAlmostEqual(width, MIN_TUNNEL_WIDTH_M + CORRIDOR_MARGIN_M, delta=0.05)

    def test_missing_terrain_skips_the_link(self):
        surface = terrain_surface(flat(), columns=36)  # 只覆盖到 x = 220，隧道端点无地形。
        report = {}
        mask = plan_tunnel_portal_mask(tunnel_graph(), surface, report)
        self.assertTrue(mask.is_empty)
        self.assertEqual(report['tunnelPortals']['links'], 0)

    @staticmethod
    def _area(surface):
        total = 0.0
        for chunk in surface['chunks']:
            positions, indices = chunk['positions'], chunk['indices']
            for cursor in range(0, len(indices), 3):
                ax, az = positions[3 * indices[cursor]], positions[3 * indices[cursor] + 2]
                bx, bz = positions[3 * indices[cursor + 1]], positions[3 * indices[cursor + 1] + 2]
                cx, cz = positions[3 * indices[cursor + 2]], positions[3 * indices[cursor + 2] + 2]
                total += abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2
        return total

    def test_cut_removes_surface_and_keeps_finite_vertices(self):
        graph = tunnel_graph()
        report = {}
        mask = plan_tunnel_portal_mask(graph, self.surface)
        before = self._area(self.surface)
        cut = apply_tunnel_portal_cut(self.surface, graph, report)
        after = self._area(cut)
        # 走廊内的三角面被删或重三角化，投影面积必须减少；边界碎片会让面数不降反升。
        self.assertLess(after, before - report['tunnelPortals']['genericCutM2'] * 0.5)
        self.assertGreater(report['tunnelPortals']['genericCutM2'], 0)
        self.assertLessEqual(report['tunnelPortals']['genericCutM2'],
                             report['tunnelPortals']['cutM2'] + 1e-6)
        for chunk in cut['chunks']:
            self.assertTrue(all(math.isfinite(value) for value in chunk['positions']))
        # 裁后不应再有三角面落在走廊内部（边界碎片允许贴边）。
        for chunk in cut['chunks']:
            positions, indices = chunk['positions'], chunk['indices']
            for cursor in range(0, len(indices), 3):
                points = [(positions[3 * indices[cursor + k]], positions[3 * indices[cursor + k] + 2])
                          for k in range(3)]
                centroid = (sum(p[0] for p in points) / 3, sum(p[1] for p in points) / 3)
                self.assertFalse(mask.contains(Point(*centroid)))
        # 重复裁切不应再切掉东西。
        again = apply_tunnel_portal_cut(cut, graph, {})
        self.assertAlmostEqual(self._area(again), after, places=6)

    def test_cover_boundaries_match_thresholds(self):
        mask = plan_tunnel_portal_mask(tunnel_graph(shared_end=False), self.surface)
        # 开敞段端点由 cover ∈ (0.05, 5.6) 解出：d = 0.1 与 d = 11.2。
        self.assertGreater(COVER_MAX_M, COVER_MIN_M)
        self.assertTrue(mask.contains(Point(START[0] + 0.12, START[1])))
        self.assertTrue(mask.contains(Point(START[0] + 11.18, START[1])))
        self.assertFalse(mask.contains(Point(START[0] + 0.08, START[1])))
        self.assertFalse(mask.contains(Point(START[0] + 11.25, START[1])))
        self.assertIsNotNone(COVER_MAX_M)


if __name__ == '__main__':
    unittest.main()
