"""父级用途仅作用于审核清单中的指定建筑部件。"""

import json
import pickle
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import osmium
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from building_parent_review import apply_reviewed_building_parent_uses
from buildings import build_buildings
from geo import BAY_CONTEXT_BBOX, KX, KY, ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX
from osm import CACHE_VERSION, read_osm


PARENT = 'way/135907001'
PART_IDS = ('way/1163682856', 'way/1163682857', 'way/1163682858')


def record(identity, geometry, kind, floors, *, part=True):
    return {'id': identity, 'geom': geometry, 'src': 'osm', 'kind': kind, 'levels': floors, 'isPart': part,
            'height': floors * 3.2, 'minHeight': 0}


def spec(row):
    return {'osmId': row['id'], 'areaM2': row['geom'].area, 'boundsXZ': row['geom'].bounds}


class BuildingParentReviewTests(unittest.TestCase):
    def setUp(self):
        parent = record(PARENT, box(0, 0, 30, 20), 'commercial', 26, part=False)
        parts = [record(PART_IDS[0], box(0, 0, 20, 20), 'yes', 26),
                 record(PART_IDS[1], box(20, 0, 30, 10), 'yes', 6),
                 record(PART_IDS[2], box(20, 10, 30, 20), None, 6)]
        other = record('way/9999', box(31, 3, 37, 9), 'yes', 4)
        self.records = [parent, *parts, other]
        self.manifest = {'version': 1, 'useSource': 'derived-parent-source',
                         'parent': {**spec(parent), 'sourceUse': 'commercial'},
                         'parts': [{**spec(part), 'numFloorsOsm': part['levels']} for part in parts]}

    def apply(self, records=None):
        report = {}
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'review.json'
            path.write_text(json.dumps(self.manifest))
            with patch('building_parent_review.MANIFEST', path):
                apply_reviewed_building_parent_uses(self.records if records is None else records, report)
        return report['reviewedBuildingParentUses']

    def test_inherits_only_the_three_reviewed_uses_and_keeps_geometry(self):
        original = [row.copy() for row in self.records]
        audit = self.apply()
        self.assertEqual(audit['status'], 'applied')
        self.assertEqual(audit['partIds'], list(PART_IDS))
        self.assertEqual(audit['objects'], [{'id': identity, 'kind': 'commercial', 'status': 'applied',
                                            'useSource': 'derived-parent-source'} for identity in PART_IDS])
        self.assertEqual(self.records[0], original[0])
        self.assertEqual(self.records[-1], original[-1])
        for row, before in zip(self.records[1:4], original[1:4], strict=True):
            self.assertEqual(row, {**before, 'kind': 'commercial', 'kindSource': 'derived-parent-source'})
            self.assertIs(row['geom'], before['geom'])

    def test_explicit_part_use_takes_precedence(self):
        self.records[2].update(kind='retail', kindSource='osm-part-tag')
        self.records[3]['explicitUse'] = 'commercial'
        original = self.records[2].copy()
        audit = self.apply()
        self.assertEqual(audit['partIds'], [PART_IDS[0]])
        self.assertEqual(self.records[2], original)
        self.assertIsNone(self.records[3]['kind'])
        self.assertEqual(audit['objects'][2]['reason'], 'explicit-building-use-matches-parent')

    def test_osm_building_tags_are_retained_from_pbf_and_gate_only_reviewed_parts(self):
        uses = {PART_IDS[0]: 'residential', 'way/9999': 'industrial'}
        with TemporaryDirectory() as directory:
            directory = Path(directory)
            pbf = directory / 'fixture.osm.pbf'
            ways = []
            with osmium.SimpleWriter(str(pbf)) as writer:
                node_id = 0
                for row in self.records:
                    identity = row['id']
                    nodes = []
                    for x, z in list(row['geom'].exterior.coords)[:-1]:
                        node_id += 1
                        writer.add_node(osmium.osm.mutable.Node(id=node_id, version=1,
                                                               location=(ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY)))
                        nodes.append(node_id)
                    tags = {'building:part' if row['isPart'] else 'building': row['kind'] or 'yes',
                            'building:levels': str(row['levels'])}
                    if identity in uses:
                        tags['building:use'] = uses[identity]
                    if identity == PART_IDS[1]:
                        tags.update({'building': 'yes', 'building:part': 'retail'})
                    ways.append(osmium.osm.mutable.Way(id=int(identity.split('/')[1]), version=1, tags=tags,
                                                       nodes=[*nodes, nodes[0]]))
                for way in sorted(ways, key=lambda way: way.id):
                    writer.add_way(way)

            cache = directory / 'old.pkl'
            cache.write_bytes(pickle.dumps({'bbox': PHASE1_BBOX, 'bayContextBbox': BAY_CONTEXT_BBOX,
                                            'cacheVersion': 4, 'buildings': []}))
            with patch('osm.PBF', pbf), patch('osm.CACHE', cache):
                parsed = read_osm(PHASE1_BBOX)
                self.assertEqual(parsed['cacheVersion'], CACHE_VERSION)
                cached = read_osm(PHASE1_BBOX)
                self.assertEqual(parsed, cached)
                changed = directory / 'changed.osm.pbf'
                with osmium.SimpleWriter(str(changed)) as writer:
                    writer.add_node(osmium.osm.mutable.Node(id=1, version=1, location=(ORIGIN_LON, ORIGIN_LAT)))
                changed.replace(pbf)
                refreshed = read_osm(PHASE1_BBOX)
                self.assertNotEqual(parsed['sourceSha256'], refreshed['sourceSha256'])
                self.assertEqual(refreshed['buildings'], [])
            self.assertEqual({row['id']: row['tags']['building:use'] for row in parsed['buildings']
                              if 'building:use' in row['tags']}, uses)

            manifest = directory / 'review.json'
            manifest.write_text(json.dumps(self.manifest))
            overture = directory / 'overture.jsonl'
            overture.touch()
            report = {}
            with (patch('building_parent_review.MANIFEST', manifest),
                  patch('buildings.load_globfp', return_value=([], [], set())),
                  patch('buildings.load_landmark_bindings', return_value={})):
                built = build_buildings(cached, box(-1, -1, 38, 21), report, overture_path=overture)
        by_id = {row['id']: row['category'] for row in built}
        self.assertEqual(by_id, {PART_IDS[0]: 'unknown', PART_IDS[1]: 'unknown', PART_IDS[2]: 'commercial',
                                 'way/9999': 'unknown'})
        audit = report['reviewedBuildingParentUses']
        self.assertEqual(audit['partIds'], [PART_IDS[2]])
        self.assertEqual(audit['objects'], [
            {'id': PART_IDS[0], 'kind': 'yes', 'status': 'withheld', 'explicitUse': 'residential',
             'reason': 'explicit-building-use-conflicts-with-parent'},
            {'id': PART_IDS[1], 'kind': 'yes', 'status': 'withheld', 'typeTags': {'building': 'yes', 'building:part': 'retail'},
             'reason': 'explicit-building-or-part-type-conflicts-with-parent'},
            {'id': PART_IDS[2], 'kind': 'commercial', 'status': 'applied', 'useSource': 'derived-parent-source'},
        ])

    def test_source_identity_floor_or_geometry_changes_withhold_the_whole_review(self):
        cases = [('id', 'way/123', 'reviewed-source-identities-changed'),
                 ('levels', 7, 'reviewed-part-changed'),
                 ('geom', box(21, 10, 31, 20), 'reviewed-part-changed')]
        for field, value, reason in cases:
            with self.subTest(field=field):
                rows = [row.copy() for row in self.records]
                rows[3][field] = value
                before = [row.copy() for row in rows]
                audit = self.apply(rows)
                self.assertEqual(audit['status'], 'withheld')
                self.assertEqual(audit['reason'], reason)
                self.assertEqual(rows, before)

    def test_unknown_review_manifest_version_is_rejected(self):
        self.manifest['version'] = 2
        with self.assertRaisesRegex(ValueError, 'Unsupported building parent review version'):
            self.apply()


if __name__ == '__main__':
    unittest.main()
