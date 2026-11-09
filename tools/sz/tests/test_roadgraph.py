"""路网拓扑和方向回归，不依赖联网服务。"""
import sys
import unittest
from pathlib import Path
from shapely.geometry import LineString, box
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo import KX, KY, ORIGIN_LON, ORIGIN_LAT
from roadgraph import build_roadgraph, graph_components
from roads import road_direction, build_roads
from build import enc_ring
from turn_restrictions import collect_turn_restrictions


def road(identity, refs, points, **tags):
    return {'id': identity, 'nodeRefs': refs,
            'geom': LineString([(ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY) for x, z in points]),
            'tags': {'highway': 'primary', **tags}}


class RoadGraphTests(unittest.TestCase):
    def build(self, roads, clip=None):
        report = {}
        graph = build_roadgraph({'roads': roads}, clip if clip is not None else box(-100, -100, 100, 100), report)
        return graph, report['roadGraph']

    def test_shared_identity_connects_but_crossing_coordinates_do_not(self):
        rows = [road('way/1', [1, 2, 3], [(-50, 0), (0, 0), (50, 0)]),
                road('way/2', [4, 2], [(0, -50), (0, 0)]),
                road('way/3', [5, 6, 7], [(0, -60), (0, 0), (0, 60)], bridge='yes', layer='1')]
        graph, report = self.build(rows)
        self.assertEqual(len(graph['links']), 4)
        junction = graph['nodeIds'].index('node/2')
        self.assertEqual(sum(junction in link[:2] for link in graph['links']), 3)
        self.assertEqual(report['bridgeLinks'], 1)
        self.assertEqual(report['connectivity']['components'], 2)
        self.assertEqual(graph['metadata'][-1]['heightSource'], 'unresolved')

    def test_bridge_and_ramp_join_only_at_shared_osm_endpoint(self):
        graph, report = self.build([road('way/1', [1, 2], [(-50, 0), (0, 0)], bridge='yes', layer='1'),
                                   road('way/2', [2, 3], [(0, 0), (50, 0)], highway='primary_link')])
        self.assertEqual(report['nodes'], 3)
        self.assertEqual(report['connectivity']['largestNodeFraction'], 1)

    def test_explicit_oneway_overrides_and_reverse_geometry(self):
        self.assertEqual(road_direction({'highway': 'motorway', 'oneway': 'no'}), 0)
        self.assertEqual(road_direction({'highway': 'primary', 'oneway': '-1'}), -1)
        self.assertEqual(road_direction({'junction': 'roundabout'}), 1)
        self.assertIsNone(road_direction({'oneway': 'reversible'}))
        row = road('way/1', [1, 2], [(-50, 0), (50, 0)], oneway='-1')
        graph, report = self.build([row])
        self.assertEqual(graph['links'][0][5], -1)
        preview = build_roads({'roads': [row]}, box(-100, -100, 100, 100), {})
        self.assertGreater(preview[0]['line'].coords[0][0], preview[0]['line'].coords[-1][0])

    def test_clipping_does_not_join_unrelated_boundary_endpoints(self):
        graph, report = self.build([road('way/1', [1, 2], [(-200, 0), (50, 0)]),
                                   road('way/2', [3, 4], [(-200, 0), (50, 0)], layer='1')])
        self.assertEqual(report['nodes'], 4)
        self.assertEqual(report['connectivity']['components'], 2)
        self.assertEqual(graph['nodes'][0], -100)

    def test_loop_retains_direction_and_shape(self):
        graph, report = self.build([road('way/1', [1, 2, 3, 4, 1],
                                        [(0, 0), (50, 0), (50, 50), (0, 50), (0, 0)], junction='roundabout')])
        self.assertEqual(report['connectivity']['largestNodeFraction'], 1)
        self.assertTrue(all(link[0] != link[1] and link[5] == 1 for link in graph['links']))
        self.assertEqual(sum(len(link[6]) for link in graph['links']), 4)

    def test_access_precedence_and_missing_identity(self):
        rows = [road('way/1', [1, 2], [(0, 0), (50, 0)], access='private'),
                road('way/2', [3, 4], [(0, 50), (50, 50)], access='private', motorcar='yes')]
        graph, report = self.build(rows)
        self.assertEqual(report['skipped']['accessRestricted'], 1)
        self.assertEqual(len(graph['links']), 1)
        del rows[1]['nodeRefs']
        with self.assertRaisesRegex(ValueError, 'Missing OSM'):
            self.build(rows)

    def test_lollipop_road_keeps_its_internal_loop(self):
        graph, report = self.build([road('way/1', [1, 2, 3, 4, 5, 2],
                                        [(-50, 0), (0, 0), (50, 0), (50, 50), (0, 50), (0, 0)])])
        self.assertEqual(len(graph['links']), 3)
        self.assertTrue(all(link[0] != link[1] for link in graph['links']))
        self.assertEqual(report['connectivity']['largestNodeFraction'], 1)

    def test_road_encoding_preserves_roundabout_closure(self):
        points = [(0, 0), (50, 0), (0, 50), (0, 0)]
        encoded = enc_ring(points, strip_closure=False)
        self.assertEqual(len(encoded), 8)
        self.assertEqual(sum(encoded[::2]), 0)
        self.assertEqual(sum(encoded[1::2]), 0)

    def test_connectivity_respects_oneway(self):
        links = [[0, 1, 0, 7, 1, 1, []], [1, 2, 0, 7, 1, 1, []]]
        self.assertEqual(graph_components(3, links)['largestNodes'], 1)
        links.append([2, 0, 0, 7, 1, 1, []])
        self.assertEqual(graph_components(3, links)['largestNodes'], 3)

    def test_turn_relations_preserve_osm_identity_and_conservative_via_approach(self):
        graph, _ = self.build([road('way/1', [1, 2], [(-50, 0), (0, 0)], oneway='yes'),
                               road('way/2', [2, 3], [(0, 0), (50, 0)], oneway='yes'),
                               road('way/3', [2, 4], [(0, 0), (0, 40)], oneway='yes'),
                               road('way/4', [4, 5], [(0, 40), (50, 40)], oneway='yes')])
        members = [('from', 'w', 1), ('via', 'n', 2), ('to', 'w', 2)]
        generic = {'type': 'restriction', 'restriction': 'only_straight_on'}
        report = {}
        extracted = collect_turn_restrictions([
            ('relation/11', generic, members),
            ('relation/12', {**generic, 'except': 'bicycle; motorcar'}, members),
            ('relation/13', {'type': 'restriction', 'restriction': 'no_right_turn'},
             [('from', 'w', 1), ('via', 'w', 3), ('to', 'w', 4)]),
            ('relation/14', generic, members[:-1]),
            ('relation/15', {**generic, 'restriction:motorcar': 'no_straight_on'}, members),
        ], graph, report)
        self.assertEqual(extracted['source'], 'osm-guangdong')
        self.assertEqual([(r['osmId'], r['viaNodeId'], r['viaWayIds'], r['restriction']) for r in extracted['rules']],
                         [('relation/11', 'node/2', [], 'only_straight_on'),
                          ('relation/13', 'node/2', ['way/3'], 'no_right_turn'),
                          ('relation/15', 'node/2', [], 'no_straight_on')])
        self.assertEqual(report['turnRestrictions']['incompleteOsmIds'], ['relation/14'])
        self.assertEqual(report['turnRestrictions']['relations']['notApplicableToCar'], 1)
