"""用精确 OSM 节点验证入口、园路、步道和台阶的连接。"""

from pathlib import Path
import sys
import unittest

from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from parks import build_park_walk, compile_park_walk


class ParkWalkTests(unittest.TestCase):
    def setUp(self):
        self.pilot = {
            'parkOsmId': 'way/1', 'approachWayId': 'way/6',
            'entranceNode': 11, 'gateNode': 12, 'evidenceWayIds': ['way/5'],
            'legs': [
                {'osmId': 'way/2', 'highway': 'service', 'fromNode': 10, 'toNode': 12},
                {'osmId': 'way/3', 'highway': 'footway', 'fromNode': 12, 'toNode': 13},
                {'osmId': 'way/4', 'highway': 'steps', 'fromNode': 13, 'toNode': 14},
            ],
            'osmSnapshotSha256': 'reviewed-snapshot',
        }
        self.park = {'areas': [{'osmId': 'way/1', 'polygon': box(0, -50, 50, 50)}]}
        self.nodes = {
            i: {'version': 1, 'lonLat': (114.0545 + (i - 11) / 10000, 22.5463), 'tags': {}}
            for i in range(10, 15)
        }
        self.nodes[10]['tags']['highway'] = 'crossing'
        self.nodes[11]['tags']['entrance'] = 'yes'
        self.nodes[12]['tags']['barrier'] = 'gate'
        self.ways = {
            'way/1': {'version': 3, 'tags': {'leisure': 'park', 'access': 'yes'}},
            'way/2': {'version': 1, 'tags': {'highway': 'service', 'motor_vehicle': 'private'},
                      'nodeRefs': [10, 11, 12]},
            'way/3': {'version': 1, 'tags': {'highway': 'footway', 'foot': 'yes'}, 'nodeRefs': [13, 12]},
            'way/4': {'version': 1, 'tags': {'highway': 'steps', 'incline': 'up'}, 'nodeRefs': [13, 14]},
            'way/5': {'version': 1, 'tags': {'highway': 'footway', 'bridge': 'yes', 'layer': '1'},
                      'nodeRefs': [12, 13]},
            'way/6': {'version': 1, 'tags': {'highway': 'footway', 'footway': 'sidewalk'},
                      'nodeRefs': [9, 10]},
        }

    def compile(self):
        return compile_park_walk(self.pilot, self.park, self.ways, self.nodes)

    def test_keeps_ordered_source_nodes_and_unknown_stair_profile(self):
        result = self.compile()
        self.assertEqual(result['status'], 'source-route-connected')
        entry, footway, steps = result['legs']
        self.assertGreater(entry['outsideParkM'], 0)
        self.assertEqual(footway['outsideParkM'], 0)
        self.assertEqual(result['approach']['sharedNode'], 'node/10')
        self.assertEqual(entry['footAccessSource'], 'unknown')
        self.assertEqual(footway['footAccessSource'], 'osm-foot')
        self.assertFalse(footway['wayForward'])
        self.assertEqual([node['osmId'] for node in footway['nodes']], ['node/12', 'node/13'])
        self.assertEqual(steps['tags']['incline'], 'up')
        self.assertEqual(steps['verticalProfileSource'], 'unknown')
        self.assertEqual(result['evidenceOnly']['way/5']['tags']['layer'], '1')

    def test_coincident_coordinates_do_not_join_different_node_ids(self):
        self.nodes[15] = self.nodes[13]
        self.ways['way/4']['nodeRefs'][0] = 15
        self.pilot['legs'][2]['fromNode'] = 15
        self.assertEqual(self.compile()['reason'], 'no-shared-source-node')

    def test_requires_a_shared_sidewalk_crossing_node(self):
        self.ways['way/6']['nodeRefs'] = [9, 15]
        self.assertEqual(self.compile()['status'], 'sidewalk-crossing-unresolved')

    def test_shared_source_nodes_do_not_join_an_unresolved_bridge(self):
        self.pilot['legs'][1]['osmId'] = 'way/5'
        self.assertEqual(self.compile()['reason'], 'access-or-layer-unresolved')

    def test_rejects_a_gate_with_restricted_foot_access(self):
        self.nodes[12]['tags']['foot'] = 'private'
        self.assertEqual(self.compile()['reason'], 'node-access-or-layer-unresolved')

    def test_requires_reviewed_snapshot_before_reading_sources(self):
        result = build_park_walk(None, {'sourceSha256': 'other-snapshot'}, [], self.pilot)
        self.assertEqual(result['status'], 'snapshot-mismatch')
