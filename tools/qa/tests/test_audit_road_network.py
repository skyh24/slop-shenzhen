import runpy
from pathlib import Path
import unittest

from shapely.geometry import LineString


audit_elevated_roads = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'audit-road-network.py'))[
    'audit_elevated_roads']


class ElevatedRoadAuditTests(unittest.TestCase):
    def setUp(self):
        links = [[0, 1], [1, 2], [2, 3]]
        self.payload = {'roadGraph': {'links': links},
                        'water': [[[20, -50, 60, 0, 0, 100, -60, 0]]]}
        self.edges = [
            {'index': i, 'osmId': f'way/{i}', 'name': '', 'nodes': [str(a), str(b)],
             'highway': 'primary', 'layer': int(i == 1), 'bridge': i == 1, 'tunnel': False,
             'lanes': 2, 'lengthM': 10, 'structure': 'bridge' if i == 1 else 'ground',
             'direction': 1, 'runtimeDirections': [] if i == 1 else [1]}
            for i, (a, b) in enumerate(links)]
        self.lines = [LineString([(x, 0), (x + 10, 0)]) for x in (-10, 0, 10)]
        self.incidence = [[0], [0, 1], [1, 2], [2]]
        self.runtime = {'deckSurfaces': [], 'groundPortals': [(1, 8), (2, 9)], 'movements': {}}

    def row(self):
        return audit_elevated_roads(self.payload, self.edges, self.lines, self.incidence, self.runtime)[0]

    def test_source_bridge_with_dry_directional_approaches_is_a_candidate(self):
        row = self.row()
        self.assertEqual((row['status'], row['candidate']), ('missing-deck', 'cross-water-deck'))
        self.assertEqual(row['groundApproaches'], [[0], [2]])
        self.assertEqual(row['waterOverlapM'], 6)

    def test_layer_only_ramp_and_reversed_approach_are_not_bridge_candidates(self):
        for field, value in [('bridge', False), ('highway', 'primary_link')]:
            old = self.edges[1][field]
            self.edges[1][field] = value
            self.assertNotIn('candidate', self.row())
            self.edges[1][field] = old
        self.edges[2]['runtimeDirections'] = [-1]
        self.assertNotIn('candidate', self.row())

    def test_built_bridge_requires_a_vehicle_edge_and_both_movements(self):
        self.runtime['deckSurfaces'] = [(1, 'deck')]
        self.assertEqual(self.row()['status'], 'missing-vehicle-route')
        self.edges[1]['runtimeDirections'] = [1]
        self.runtime['movements'] = {(0, 1): {(1, 1)}}
        self.assertEqual(self.row()['openEnds'], [{'direction': 1, 'entry': False, 'exit': True}])
        self.runtime['movements'][(1, 1)] = {(2, 1)}
        self.assertEqual(self.row()['status'], 'connected')


if __name__ == '__main__':
    unittest.main()
