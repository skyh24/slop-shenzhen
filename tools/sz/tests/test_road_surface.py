"""派生路面：平台平顺、坡度限制、只降不升、排除区、确定性和输入校验测试。"""

import math
import sys
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from road_surface import MAX_TRANSITION_M, PLATEAU_BUFFER_STEPS, RAISE_CAP_M, build_road_surface


def make_terrain(nx, nz, step, height_fn, scale=0.1, x0=0.0, z0=0.0):
    """按高度函数生成整数量化地形网格。height_fn 必须支持 numpy 数组。"""
    xs = x0 + np.arange(nx) * step
    zs = z0 + np.arange(nz) * step
    mesh_x, mesh_z = np.meshgrid(xs, zs)
    values = height_fn(mesh_x, mesh_z)
    values = np.broadcast_to(values, mesh_x.shape) if np.ndim(values) == 0 else values
    heights = np.rint(values / scale).astype(np.int64).ravel().tolist()
    return {'x0': x0, 'z0': z0, 'step': step, 'nx': nx, 'nz': nz, 'heightScale': scale,
            'heights': heights, 'processing': {'heightSource': 'fixture-dsm'}}


def world_sampler(height_fn):
    """把 (lon, lat) 采样转成局部坐标高度函数；height_fn 返回标量或 None。"""
    def sample(lon, lat):
        x = (lon - ORIGIN_LON) * KX
        z = (ORIGIN_LAT - lat) * KY
        value = height_fn(x, z)
        return None if value is None else float(value)
    return sample


def sample_terrain(terrain, x, z):
    """按 ne-sw 对角线双线性采样地形网格（与运行时一致）。"""
    step, nx, nz = terrain['step'], terrain['nx'], terrain['nz']
    heights = np.asarray(terrain['heights'], dtype=float) * terrain['heightScale']
    fx, fz = (x - terrain['x0']) / step, (z - terrain['z0']) / step
    i, j = math.floor(fx), math.floor(fz)
    if i < 0 or j < 0 or i >= nx - 1 or j >= nz - 1:
        return None
    u, v = fx - i, fz - j
    a, b = heights[j * nx + i], heights[j * nx + i + 1]
    c, d = heights[(j + 1) * nx + i], heights[(j + 1) * nx + i + 1]
    return a + (b - a) * u + (c - a) * v if u + v <= 1 else d + (c - d) * (1 - u) + (b - d) * (1 - v)


def road_link(start, end, width, inner=(), name=0):
    coords = [value for point in inner for value in point]
    return [start, end, name, width, 0, 0, coords]


def road_meta(osm_id, highway='primary', **overrides):
    row = {'osmId': osm_id, 'highway': highway, 'layer': 0, 'bridge': False,
           'tunnel': False, 'heightSource': 'terrain'}
    row.update(overrides)
    return row


def road_graph(nodes, links, metadata, names=('Test Road',)):
    return {'nodes': [value for point in nodes for value in point],
            'nodeIds': [f'node/{index}' for index in range(len(nodes))],
            'links': links, 'metadata': metadata, 'names': list(names)}


def changed_vertices(terrain, result):
    old = np.asarray(terrain['heights'], dtype=np.int64)
    new = np.asarray(result['heights'], dtype=np.int64)
    return old, new, new != old


def distance_to_segment(segment, x, z):
    return LineString(segment).distance(Point(x, z))


class StraightRoadTests(unittest.TestCase):
    def setUp(self):
        # 路沿 x 轴、z=200：DSM 在 x=100 附近有 10 m 楼顶污染；FABDEM 在 300..380 m 有 10% 坡段。
        def dsm(x, z):
            bump = 10.0 * np.exp(-(((x - 100.0) ** 2 + (z - 200.0) ** 2) / (2.0 * 25.0 ** 2)))
            return 30.0 + bump

        def fabdem(x, z):
            if x <= 300.0:
                return 20.0
            if x <= 380.0:
                return 20.0 + (x - 300.0) * 0.10
            return 28.0

        self.fabdem = fabdem
        self.terrain = make_terrain(61, 41, 10.0, dsm)
        self.original_heights = list(self.terrain['heights'])
        self.graph = road_graph([(50.0, 200.0), (450.0, 200.0)],
                                [road_link(0, 1, 20.0)], [road_meta('way/1')], ['Fixture Road'])
        self.report = {}
        self.result = build_road_surface(self.terrain, self.graph, self.report,
                                         sampler=world_sampler(fabdem))

    def test_plateau_is_flat_across_the_carriageway(self):
        for x in (120, 200, 260, 320, 400):
            heights = [sample_terrain(self.result, x, z) for z in (190, 200, 210)]
            self.assertLess(max(heights) - min(heights), 0.25, f'cross-section not flat at x={x}')

    def test_longitudinal_grade_is_clamped_to_the_class_limit(self):
        self.assertAlmostEqual(self.fabdem(360.0, 200.0) - self.fabdem(350.0, 200.0), 1.0, places=6)
        profile = [sample_terrain(self.result, x, 200.0) for x in range(50, 451, 10)]
        grades = [abs(b - a) / 10.0 * 100.0 for a, b in zip(profile, profile[1:])]
        self.assertLessEqual(max(grades), 7.0 + 1e-6)

    def test_band_outside_the_corridor_is_untouched(self):
        segment = [(50.0, 200.0), (450.0, 200.0)]
        radius = 10.0 + PLATEAU_BUFFER_STEPS * self.terrain['step'] + MAX_TRANSITION_M
        old, new, changed = changed_vertices(self.terrain, self.result)
        for index in range(old.size):
            x = self.terrain['x0'] + (index % self.terrain['nx']) * self.terrain['step']
            z = self.terrain['z0'] + (index // self.terrain['nx']) * self.terrain['step']
            distance = distance_to_segment(segment, x, z)
            if changed[index]:
                self.assertLessEqual(distance, radius + 1e-6, f'changed vertex far from corridor at {x},{z}')
            elif distance > radius + 1e-6:
                self.assertEqual(new[index], old[index])

    def test_derived_surface_never_raises_above_the_dsm(self):
        old, new, _ = changed_vertices(self.terrain, self.result)
        raise_metres = (new - old) * self.terrain['heightScale']
        self.assertLessEqual(float(raise_metres.max()), RAISE_CAP_M + 1e-9)

    def test_report_labels_rule_and_large_deltas(self):
        self.assertEqual(self.result['heights'] != self.original_heights, True)
        surface = self.report['roadSurface']
        self.assertEqual(surface['status'], 'applied')
        self.assertEqual(surface['heightSource'], 'derived-road')
        self.assertEqual(surface['baseline']['sourceId'], 'fabdem-bristol-v1.2')
        self.assertEqual(surface['baseline']['heightSource'], 'derived-road')
        self.assertEqual(surface['rule']['stationSpacingM'], 10.0)
        self.assertEqual(surface['rule']['raiseCapM'], RAISE_CAP_M)
        self.assertEqual(surface['links']['resolved'], 1)
        self.assertGreater(surface['stations']['filteredLinks'], 0)
        self.assertGreaterEqual(surface['vertices']['changed'], 1)
        self.assertLess(surface['vertices']['changed'], surface['vertices']['total'])
        self.assertLessEqual(surface['vertices']['maxAdjacentDeltaM'], 2.0)
        self.assertEqual(surface['vertices']['adjacentStepsOver5M'], 0)
        self.assertIn('raisedCapped', surface['vertices'])
        self.assertIn('primary', surface['classes'])
        self.assertTrue(surface['largeDeltas'])
        delta = surface['largeDeltas'][0]
        for key in ('osmId', 'name', 'class', 'lengthM', 'maxAbsDeltaM'):
            self.assertIn(key, delta)
        self.assertGreater(delta['maxAbsDeltaM'], 5.0)
        self.assertEqual(self.result['processing']['roadSurface']['heightSource'], 'derived-road')

    def test_input_terrain_is_not_mutated(self):
        self.assertEqual(self.terrain['heights'], self.original_heights)
        self.assertIsNot(self.result, self.terrain)


class SpikeAndRaiseCapTests(unittest.TestCase):
    def test_single_fabdem_spike_cannot_raise_or_shift_the_surface(self):
        def dsm(x, z):
            return 5.0

        def fabdem(x, z):
            return 45.0 if (abs(x - 200.0) < 1e-6 and abs(z - 200.0) < 1e-6) else 6.0

        terrain = make_terrain(41, 41, 25.0, dsm)
        graph = road_graph([(50.0, 200.0), (400.0, 200.0)],
                           [road_link(0, 1, 20.0)], [road_meta('way/spike')])
        report = {}
        result = build_road_surface(terrain, graph, report, sampler=world_sampler(fabdem))
        surface = report['roadSurface']
        self.assertGreaterEqual(surface['stations']['maxRejectedSpikeM'], 30.0)
        self.assertGreaterEqual(surface['stations']['spikeSamplesOverLimit'], 1)
        for x in (150, 200, 250, 300):
            height = sample_terrain(result, x, 200.0)
            self.assertLessEqual(abs(height - 5.0), 0.2, f'spike leaked into the plateau at x={x}')
        old, new, _ = changed_vertices(terrain, result)
        raise_metres = (new - old) * terrain['heightScale']
        self.assertLessEqual(float(raise_metres.max()), RAISE_CAP_M + 1e-9)

    def test_tower_adjacent_road_cannot_be_raised_by_upward_fabdem_bias(self):
        # 路北 40 m 处有 388 m 楼顶单元；FABDEM 整体比 DSM 高 32 m（上偏），派生面不得跟着抬高。
        def dsm(x, z):
            tower = np.where((np.abs(x - 250.0) < 1e-6) & (np.abs(z - 160.0) < 1e-6), 388.0, 0.0)
            spill = 40.0 * np.exp(-(((x - 250.0) ** 2 + (z - 160.0) ** 2) / (2.0 * 40.0 ** 2)))
            return 8.0 + spill + tower

        def fabdem(x, z):
            return 40.0

        terrain = make_terrain(41, 41, 25.0, dsm)
        graph = road_graph([(50.0, 200.0), (400.0, 200.0)],
                           [road_link(0, 1, 20.0)], [road_meta('way/tower')])
        report = {}
        result = build_road_surface(terrain, graph, report, sampler=world_sampler(fabdem))
        old, new, _ = changed_vertices(terrain, result)
        raise_metres = (new - old) * terrain['heightScale']
        self.assertLessEqual(float(raise_metres.max()), RAISE_CAP_M + 1e-9)
        reference_median = report['roadSurface']['links']['reference']['medianBiasM']
        self.assertLessEqual(reference_median, 0.0)
        for x in (150, 200, 250, 300):
            derived = sample_terrain(result, x, 200.0)
            original = sample_terrain(terrain, x, 200.0)
            self.assertLessEqual(derived, original + RAISE_CAP_M + 1e-9)
            self.assertLess(derived, 40.0)

    def test_cap_clamps_local_raises_and_reports_them(self):
        # 路网范围内 DSM 有一个窄坑（站点之间），插值出的平台会高于坑底，必须被抬高上限压住。
        def dsm(x, z):
            pit = 2.0 * np.exp(-(((x - 325.0) ** 2 + (z - 200.0) ** 2) / (2.0 * 8.0 ** 2)))
            return 5.0 - pit

        def fabdem(x, z):
            return 6.0

        terrain = make_terrain(41, 41, 25.0, dsm)
        graph = road_graph([(50.0, 200.0), (400.0, 200.0)],
                           [road_link(0, 1, 20.0)], [road_meta('way/pit')])
        report = {}
        result = build_road_surface(terrain, graph, report, sampler=world_sampler(fabdem))
        surface = report['roadSurface']
        old, new, _ = changed_vertices(terrain, result)
        raise_metres = (new - old) * terrain['heightScale']
        self.assertLessEqual(float(raise_metres.max()), RAISE_CAP_M + 1e-9)
        self.assertGreaterEqual(surface['vertices']['raisedCapped'], 1)


class ExclusionPolygonTests(unittest.TestCase):
    def setUp(self):
        # 主路沿 z=300，污染堆在路北 40 m（仍在平台半径内），排除区只盖污染堆、不含路中心线。
        # 污染堆要足够平缓，否则会被陡坡保护规则排除，测不到排除区本身。
        def dsm(x, z):
            bump = 8.0 * np.exp(-(((x - 250.0) ** 2 + (z - 340.0) ** 2) / (2.0 * 45.0 ** 2)))
            return 5.0 + bump

        def fabdem(x, z):
            return 5.0

        self.terrain = make_terrain(61, 41, 25.0, dsm)
        self.graph = road_graph([(50.0, 300.0), (450.0, 300.0)],
                                [road_link(0, 1, 20.0)], [road_meta('way/main')])
        self.exclusion = {'id': 'yard', 'poly': box(200.0, 310.0, 320.0, 380.0)}

    def test_exclusion_vertices_keep_the_original_height(self):
        plain_report, excluded_report = {}, {}
        plain = build_road_surface(self.terrain, self.graph, plain_report,
                                   sampler=world_sampler(lambda x, z: 5.0))
        excluded = build_road_surface(self.terrain, self.graph, excluded_report,
                                      sampler=world_sampler(lambda x, z: 5.0),
                                      excluded_polygons=[self.exclusion])
        old, plain_new, _ = changed_vertices(self.terrain, plain)
        _, excluded_new, _ = changed_vertices(self.terrain, excluded)
        inside, changed_inside = [], 0
        for index in range(old.size):
            x = self.terrain['x0'] + (index % self.terrain['nx']) * self.terrain['step']
            z = self.terrain['z0'] + (index // self.terrain['nx']) * self.terrain['step']
            if self.exclusion['poly'].contains(Point(x, z)):
                inside.append(index)
                self.assertEqual(excluded_new[index], old[index])
                changed_inside += int(plain_new[index] != old[index])
        self.assertTrue(inside)
        self.assertGreater(changed_inside, 0)
        self.assertGreater(excluded_report['roadSurface']['vertices']['excluded'], 0)
        self.assertGreater(excluded_report['roadSurface']['vertices']['changed'], 0)
        self.assertLess(excluded_report['roadSurface']['vertices']['changed'],
                        plain_report['roadSurface']['vertices']['changed'])

    def test_link_with_a_station_inside_the_exclusion_is_unresolved(self):
        terrace = box(600.0, 200.0, 800.0, 300.0)
        graph = {'nodes': [650.0, 250.0, 750.0, 250.0], 'nodeIds': ['a', 'b'],
                 'names': ['Yard Road'],
                 'links': [road_link(0, 1, 8.0)],
                 'metadata': [road_meta('way/yard', 'service')]}
        report = {}
        result = build_road_surface(self.terrain, graph, report,
                                    sampler=world_sampler(lambda x, z: 5.0),
                                    excluded_polygons=[terrace])
        surface = report['roadSurface']
        self.assertEqual(surface['links']['excludedTerrain'], 1)
        self.assertEqual(surface['links']['resolved'], 0)
        self.assertEqual(surface['unresolvedLinks'][0]['reason'], 'terrainExclusion')
        self.assertEqual(result['heights'], self.terrain['heights'])


class CrossingRoadTests(unittest.TestCase):
    def test_shared_junction_keeps_one_level_and_steps_stay_bounded(self):
        def dsm(x, z):
            return 25.0 + 0.010 * x + 0.005 * z

        def fabdem(x, z):
            return 22.0 + 0.009 * x + 0.004 * z

        terrain = make_terrain(51, 51, 10.0, dsm)
        nodes = [(50.0, 250.0), (250.0, 250.0), (450.0, 250.0),
                 (250.0, 50.0), (250.0, 450.0)]
        links = [road_link(0, 1, 16.0), road_link(1, 2, 16.0),
                 road_link(3, 1, 12.0), road_link(1, 4, 12.0)]
        metadata = [road_meta('way/a1'), road_meta('way/a2'),
                    road_meta('way/b1', 'secondary'), road_meta('way/b2', 'secondary')]
        report = {}
        result = build_road_surface(terrain, road_graph(nodes, links, metadata), report,
                                    sampler=world_sampler(fabdem))
        probes = [sample_terrain(result, x, z)
                  for x, z in ((250, 250), (240, 250), (260, 250), (250, 240), (250, 260))]
        self.assertLess(max(probes) - min(probes), 1.0)
        surface = report['roadSurface']
        self.assertLessEqual(surface['vertices']['maxAdjacentDeltaM'], 2.0)
        self.assertLessEqual(surface['vertices']['plateauAdjacentDeltaM'], 2.0)
        self.assertEqual(surface['vertices']['adjacentStepsOver5M'], 0)


class ExcludedAndUnresolvedLinkTests(unittest.TestCase):
    def test_bridge_tunnel_layer_and_unresolved_links_keep_original_terrain(self):
        terrain = make_terrain(121, 61, 10.0, lambda x, z: 20.0 + 0.02 * x)

        def fabdem(x, z):
            if abs(z - 500.0) < 25.0 and 90.0 < x < 510.0:
                return None
            return 20.0 + 0.02 * x

        bands = {'ground': 100.0, 'bridge': 200.0, 'tunnel': 300.0, 'layer': 400.0, 'missing': 500.0}
        nodes, links, metadata = [], [], []
        for name, z in bands.items():
            index = len(nodes)
            nodes.extend([(100.0, z), (500.0, z)])
            links.append(road_link(index, index + 1, 20.0))
            overrides = {}
            if name == 'bridge':
                overrides = {'bridge': True, 'heightSource': 'unresolved'}
            elif name == 'tunnel':
                overrides = {'tunnel': True, 'heightSource': 'unresolved'}
            elif name == 'layer':
                overrides = {'layer': 1, 'heightSource': 'unresolved'}
            metadata.append(road_meta(f'way/{name}', 'primary', **overrides))
        report = {}
        result = build_road_surface(terrain, road_graph(nodes, links, metadata), report,
                                    sampler=world_sampler(fabdem))
        surface = report['roadSurface']
        self.assertEqual(surface['links']['resolved'], 1)
        self.assertEqual(surface['links']['excluded']['bridge'], 1)
        self.assertEqual(surface['links']['excluded']['tunnel'], 1)
        self.assertEqual(surface['links']['excluded']['layer'], 1)
        self.assertEqual(surface['links']['unresolved'], 1)
        self.assertEqual(surface['unresolvedLinks'][0]['reason'], 'fabdemSampleMissing')

        old, new, changed = changed_vertices(terrain, result)
        for name in ('bridge', 'tunnel', 'layer', 'missing'):
            segment = [(100.0, bands[name]), (500.0, bands[name])]
            for index in range(old.size):
                x = terrain['x0'] + (index % terrain['nx']) * terrain['step']
                z = terrain['z0'] + (index // terrain['nx']) * terrain['step']
                if distance_to_segment(segment, x, z) <= 35.0:
                    self.assertEqual(new[index], old[index], f'{name} corridor changed at {x},{z}')
        radius = 10.0 + PLATEAU_BUFFER_STEPS * terrain['step'] + MAX_TRANSITION_M
        segment = [(100.0, bands['ground']), (500.0, bands['ground'])]
        for index in np.flatnonzero(changed):
            x = terrain['x0'] + (index % terrain['nx']) * terrain['step']
            z = terrain['z0'] + (index // terrain['nx']) * terrain['step']
            self.assertLessEqual(distance_to_segment(segment, x, z), radius + 1e-6)


class NoCandidateTests(unittest.TestCase):
    def test_only_bridge_links_leave_the_terrain_untouched(self):
        terrain = make_terrain(21, 21, 25.0, lambda x, z: 10.0)
        graph = road_graph([(100.0, 100.0), (300.0, 100.0)],
                           [road_link(0, 1, 20.0)],
                           [road_meta('way/bridge', bridge=True, heightSource='unresolved')])
        report = {}
        result = build_road_surface(terrain, graph, report, sampler=world_sampler(lambda x, z: 9.0))
        surface = report['roadSurface']
        self.assertEqual(surface['status'], 'skipped')
        self.assertEqual(surface['links']['eligible'], 0)
        self.assertEqual(surface['links']['excluded']['bridge'], 1)
        self.assertEqual(result['heights'], terrain['heights'])


class DeterminismAndValidationTests(unittest.TestCase):
    def scenario(self):
        def dsm(x, z):
            return 20.0 + np.exp(-(((x - 120.0) ** 2 + (z - 200.0) ** 2) / (2.0 * 20.0 ** 2)))

        terrain = make_terrain(41, 41, 10.0, dsm)
        graph = road_graph([(50.0, 200.0), (400.0, 200.0)],
                           [road_link(0, 1, 20.0)], [road_meta('way/1')])
        return terrain, graph

    def test_two_runs_are_deterministic_and_quantized(self):
        terrain, graph = self.scenario()
        first_report, second_report = {}, {}
        first = build_road_surface(terrain, graph, first_report,
                                   sampler=world_sampler(lambda x, z: 19.0))
        second = build_road_surface(terrain, graph, second_report,
                                    sampler=world_sampler(lambda x, z: 19.0))
        self.assertEqual(first['heights'], second['heights'])
        for report in (first_report, second_report):
            report['roadSurface'].pop('timing')
        self.assertEqual(first_report['roadSurface'], second_report['roadSurface'])
        for height in first['heights']:
            self.assertIsInstance(height, int)
            self.assertAlmostEqual(height * terrain['heightScale'] * 10, round(height * terrain['heightScale'] * 10))

    def test_invalid_inputs_raise_clear_errors(self):
        terrain, graph = self.scenario()
        cases = []
        broken = dict(terrain)
        broken.pop('heights')
        cases.append((broken, graph, {}, {}, {}, 'terrain is missing keys'))
        broken = {**terrain, 'heights': terrain['heights'][:-1]}
        cases.append((broken, graph, {}, {}, {}, 'does not match nx \\* nz'))
        broken = {**terrain, 'step': 0.0}
        cases.append((broken, graph, {}, {}, {}, 'step must be positive'))
        broken = {**terrain, 'heights': [0.5] * (terrain['nx'] * terrain['nz'])}
        cases.append((broken, graph, {}, {}, {}, 'heights must be integers'))
        broken = {**graph, 'metadata': graph['metadata'][:-1]}
        cases.append((terrain, broken, {}, {}, {}, 'same length'))
        broken = {**graph, 'links': [[0, 99, 0, 20.0, 0, 0, []]]}
        cases.append((terrain, broken, {}, {}, {}, 'node indices must be integers in range'))
        broken = {**graph, 'names': None}
        cases.append((terrain, broken, {}, {}, {}, 'links, metadata and names must be lists'))
        cases.append((terrain, graph, None, {}, {}, 'report must be a dict'))
        cases.append((terrain, graph, {}, {'sampler': 5}, {}, 'sampler must be callable'))
        cases.append((terrain, graph, {}, {}, {'excluded_polygons': 5}, 'excluded_polygons must be a list'))
        for terrain_case, graph_case, report_case, kwargs, extra, pattern in cases:
            kwargs = dict(kwargs)
            kwargs.update(extra)
            with self.assertRaisesRegex(ValueError, pattern):
                build_road_surface(terrain_case, graph_case, report_case, **kwargs)


if __name__ == '__main__':
    unittest.main()
