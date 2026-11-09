"""地铁归属、裁切、换乘和来源回归。"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shapely.geometry import box
from geo import KX, KY, ORIGIN_LON, ORIGIN_LAT
from metro import NETWORK, _snapshot, compile_metro


def point(x, z):
    return [ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY]


def entity(identity, tags, x=0, z=0):
    return {'id': identity, 'tags': tags, 'point': point(x, z)}


def relation(identity, tags, members):
    return {'id': identity, 'tags': tags, 'members': members}


def fixture():
    nodes = {
        'node/1': entity('node/1', {'railway': 'stop'}),
        'node/2': entity('node/2', {'railway': 'station', 'station': 'subway', 'name': 'Transfer'}),
        'node/3': entity('node/3', {'railway': 'subway_entrance', 'ref': 'A'}, 1),
        'node/4': entity('node/4', {'railway': 'subway_entrance', 'ref': 'B'}, 2),
        'node/5': entity('node/5', {'railway': 'stop'}, 3),
        'node/6': entity('node/6', {'railway': 'subway_entrance', 'network': '港铁'}, 4),
    }
    tags = {'type': 'route', 'route': 'subway', 'network': NETWORK, 'ref': '2;8', 'colour': '#F06292'}
    relations = {
        'relation/1': relation('relation/1', tags, [('node/1', 'stop'), ('way/1', '')]),
        'relation/2': relation('relation/2', {**tags, 'ref': '7', 'colour': '#0035ad'}, [('node/5', 'stop'), ('way/1', '')]),
        'relation/3': relation('relation/3', {'public_transport': 'stop_area'}, [('node/1', 'stop'), ('node/2', ''), ('node/3', 'entrance'), ('node/6', 'entrance')]),
        'relation/4': relation('relation/4', {'public_transport': 'stop_area'}, [('node/5', 'stop'), ('node/2', '')]),
        'relation/5': relation('relation/5', {**tags, 'network': '广州地铁', 'ref': '99'}, [('way/1', '')]),
        'relation/6': relation('relation/6', {**tags, 'type': 'network', 'ref': '100'}, [('way/1', '')]),
    }
    ways = {'way/1': {'id': 'way/1', 'tags': {'railway': 'subway', 'layer': '-2', 'tunnel': 'yes'}, 'coords': [point(-20, 0), point(20, 0)]}}
    return {'relations': relations, 'nodes': nodes, 'ways': ways, 'source': {'sha256': 'fixture'}}


class MetroTests(unittest.TestCase):
    def build(self, raw=None):
        report = {}
        data = compile_metro(raw or fixture(), box(-10, -10, 10, 10), report)
        return data, report['metro']

    def test_strict_network_and_type_filter(self):
        data, report = self.build()
        self.assertEqual(report['routeRelations'], 2)
        self.assertEqual([v['ref'] for v in data['lines']], ['2', '7', '8'])
        self.assertEqual(data['lines'][1]['colour'], '#0035AD')

    def test_shared_track_is_clipped_deduplicated_and_height_not_invented(self):
        data, _ = self.build()
        self.assertEqual(len(data['segments']), 1)
        segment = data['segments'][0]
        self.assertEqual(segment['points'], [-10, 0, 10, 0])
        self.assertEqual(segment['lineRefs'], ['2', '7', '8'])
        self.assertEqual(segment['layer'], '-2')
        self.assertEqual(segment['elevationSource'], 'unresolved')
        self.assertNotIn('y', segment)

    def test_shared_station_transfers_and_entrance_evidence(self):
        data, _ = self.build()
        self.assertEqual(data['stations'][0]['lineRefs'], ['2', '7', '8'])
        self.assertEqual(len(data['entrances']), 1)
        entrance = data['entrances'][0]
        self.assertEqual(entrance['ref'], 'A')
        self.assertEqual(entrance['stationIds'], ['node/2'])
        self.assertEqual(entrance['lineRefs'], ['2', '7', '8'])
        self.assertEqual(entrance['association']['relationIds'], ['relation/3'])
        self.assertEqual(entrance['routeIds'], ['relation/1'])
        self.assertEqual([x['id'] for x in data['unassociatedCandidates']], ['node/4'])

    def test_missing_track_and_conflicting_colours_are_reported(self):
        raw = fixture()
        raw['relations']['relation/7'] = relation('relation/7', {**raw['relations']['relation/1']['tags'], 'colour': '#FFFFFF'}, [('way/99', '')])
        data, report = self.build(raw)
        self.assertIsNone(data['lines'][0]['colour'])
        self.assertEqual(len(report['excludedTrackMembers']), 1)
        self.assertEqual(report['excludedTrackMembers'][0]['memberId'], 'way/99')
        self.assertEqual(len(report['colourConflicts']), 2)

    def test_explicit_network_without_line_membership_remains_unassigned(self):
        raw = fixture()
        raw['nodes']['node/4']['tags']['network'] = NETWORK
        data, _ = self.build(raw)
        entrance = next(e for e in data['entrances'] if e['id'] == 'node/4')
        self.assertEqual(entrance['stationIds'], [])
        self.assertEqual(entrance['lineRefs'], [])
        self.assertEqual(entrance['association']['method'], 'explicit-network-tag')

    def test_marker_outside_clip_is_excluded(self):
        raw = fixture()
        raw['nodes']['node/3']['point'] = point(11, 0)
        data, _ = self.build(raw)
        self.assertEqual(data['entrances'], [])

    def test_snapshot_hash_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            pbf, manifest = Path(directory) / 'sample.pbf', Path(directory) / 'sources.json'
            pbf.write_bytes(b'fixture')
            manifest.write_text(json.dumps({'sources': [{'id': 'osm-guangdong', 'sha256': hashlib.sha256(b'fixture').hexdigest(), 'url': 'https://example.test/snapshot'}]}))
            self.assertEqual(_snapshot(pbf, manifest)['bytes'], 7)
            pbf.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'snapshot hash mismatch'):
                _snapshot(pbf, manifest)


if __name__ == '__main__':
    unittest.main()
