"""显示网格的岸线、水洞、三角面共面和分块接缝测试。"""

import gzip
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import rebuild_ground
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from terrain_exclusions import SOURCE, _footprint_signature, chunjian_exclusions
from terrain_surface import apply_urban_datum, build_terrain_surface


def grid():
    return {'x0': 0, 'z0': 0, 'step': 25, 'nx': 3, 'nz': 3, 'heightScale': 0.1,
            'diagonal': 'ne-sw', 'heights': [0, 100, 300, 200, 500, 400, 600, 200, 100],
            'processing': {'heightSource': 'fixture-dem'}}


def sample(g, x, z):
    fx, fz = x / 25, z / 25
    i, j = min(int(fx), 1), min(int(fz), 1)
    u, v = fx - i, fz - j
    a, b, c, d = [g['heights'][k] / 10 for k in [j * 3 + i, j * 3 + i + 1, (j + 1) * 3 + i, (j + 1) * 3 + i + 1]]
    return a + (b - a) * u + (c - a) * v if u + v <= 1 else d + (c - d) * (1 - u) + (b - d) * (1 - v)


def faces(surface):
    for chunk in surface['chunks']:
        vertices = [chunk['positions'][i:i + 3] for i in range(0, len(chunk['positions']), 3)]
        for i in range(0, len(chunk['indices']), 3):
            yield [(vertices[k][0] + chunk['origin'][0], vertices[k][1], vertices[k][2] + chunk['origin'][1])
                   for k in chunk['indices'][i:i + 3]]


class TerrainSurfaceTests(unittest.TestCase):
    def test_scoped_ground_rebuild_rejects_an_unbound_base_package(self):
        with TemporaryDirectory() as directory:
            base = Path(directory) / 'city.json.gz'
            validation = Path(directory) / 'data-validation-report.json'
            base.write_bytes(gzip.compress(b'{}'))
            validation.write_text(json.dumps({'payloadSha256': 'stale-hash', 'sourceIntegrity': []}))
            with patch('build.OUT', base), patch('build.VALIDATION_REPORT', validation):
                with self.assertRaisesRegex(ValueError, 'does not match its validation report'):
                    rebuild_ground('copernicus', [], {}, {}, {}, 0)

    def test_commercial_stone_replaces_unverified_green_without_changing_contact(self):
        terrain = grid()
        coverage = box(0, 0, 50, 50)
        stone = box(6, 11, 19, 38).difference(box(8, 21, 12, 29))
        report = {}
        surface = build_terrain_surface(terrain, coverage, [coverage], [], report,
            green=[{'poly': box(-1, -1, 51, 51)}], paving=[stone])
        paved = []
        for chunk in surface['chunks']:
            positions = chunk['positions']
            for i in range(0, len(chunk['indices']), 3):
                indices = chunk['indices'][i:i + 3]
                kinds = {chunk['kinds'][k] for k in indices}
                self.assertIn(kinds, ({1}, {3}))
                vertices = [positions[k * 3:k * 3 + 3] for k in indices]
                for x, y, z in vertices:
                    self.assertAlmostEqual(y, sample(terrain, x, z), places=8)
                if kinds == {3}:
                    paved.append(Polygon([(x, z) for x, y, z in vertices]))
        self.assertAlmostEqual(unary_union(paved).symmetric_difference(stone).area, 0, places=8)
        self.assertEqual(report['terrainSurface']['stonePavingAreaM2'], stone.area)

    def test_urban_pilot_levels_the_core_and_preserves_protected_and_distant_ground(self):
        source = {**grid(), 'nx': 6, 'nz': 2, 'heights': [200] * 12}
        dry = box(0, 0, 125, 25)
        park = box(50, -1, 75, 26)
        pilot = ({'id': 'test-pilot', 'transitionM': 50}, box(0, 0, 50, 25))
        report = {}
        derived = apply_urban_datum(source, [pilot], {'heightM': 8, 'reference': {}}, dry, park, report)
        self.assertEqual(source['heights'], [200] * 12)
        self.assertEqual(derived['heights'], [80, 140, 200, 200, 200, 200] * 2)
        self.assertEqual(derived['processing']['heightSource'], 'fixture-dem')
        self.assertEqual(report['urbanDatum']['heightSource'], 'urban-datum')
        self.assertEqual(report['urbanDatum']['pilots']['test-pilot']['levelVertices'], 2)

    def test_exact_l_shaped_coverage_and_subcell_water_channel(self):
        g = grid()
        coverage = Polygon([(0, 0), (50, 0), (50, 25), (25, 25), (25, 50), (0, 50)])
        water = box(11, 0, 13, 50)
        expected = coverage.difference(water)
        report = {}
        surface = build_terrain_surface(g, coverage, [box(0, 0, 50, 50)], [{'poly': water}], report, chunk_size=25)
        polys = []
        for face in faces(surface):
            poly = Polygon([(x, z) for x, y, z in face])
            polys.append(poly)
            self.assertLess(poly.difference(expected).area, 1e-8)
            for x, y, z in face:
                self.assertAlmostEqual(y, sample(g, x, z), places=8)
            center = tuple(sum(p[k] for p in face) / 3 for k in range(3))
            self.assertAlmostEqual(center[1], sample(g, center[0], center[2]), places=8)
        self.assertAlmostEqual(unary_union(polys).area, expected.area, places=8)
        self.assertAlmostEqual(sum(p.area for p in polys), expected.area, places=8)
        self.assertEqual(report['terrainSurface']['waterLevelsGenerated'], False)

    def test_lake_hole_island_remains_land(self):
        coverage = box(0, 0, 50, 50)
        lake = Polygon([(5, 5), (45, 5), (45, 45), (5, 45)], [[(20, 20), (30, 20), (30, 30), (20, 30)]])
        surface = build_terrain_surface(grid(), coverage, [coverage], [{'poly': lake}], {}, chunk_size=25)
        actual = unary_union([Polygon([(p[0], p[2]) for p in face]) for face in faces(surface)])
        self.assertAlmostEqual(actual.symmetric_difference(coverage.difference(lake)).area, 0, places=8)

    def test_chunk_boundaries_share_heights_and_upward_winding(self):
        surface = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {}, chunk_size=25)
        points = {}
        self.assertEqual(len(surface['chunks']), 4)
        for face in faces(surface):
            a, b, c = face
            self.assertGreater((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), 0)
            for x, y, z in face:
                self.assertAlmostEqual(points.setdefault((x, z), y), y, places=8)

    def test_landuse_changes_colors_without_changing_geometry(self):
        plain = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {})
        colored = build_terrain_surface(grid(), box(0, 0, 50, 50), [box(0, 0, 50, 50)], [], {},
                                        green=[{'poly': box(-1, -1, 51, 51)}])
        self.assertEqual(plain['chunks'][0]['positions'], colored['chunks'][0]['positions'])
        self.assertEqual(plain['chunks'][0]['indices'], colored['chunks'][0]['indices'])
        self.assertTrue(all(kind == 1 for kind in colored['chunks'][0]['kinds']))

    def test_enclosed_cut_preserves_original_planes_across_chunks_and_water(self):
        g = grid()
        original = g['heights'].copy()
        coverage = box(0, 0, 50, 50)
        water = box(5, 11, 21, 32)
        mask = Polygon([(18, 16), (33, 21), (29, 33), (19, 27)])
        exclusion = {'id': 'hall', 'poly': mask, 'interiorGround': 'unknown'}
        report = {}
        surface = build_terrain_surface(g, coverage, [coverage], [{'poly': water}], report,
                                        chunk_size=25, exclusions=[exclusion])
        expected = coverage.difference(water.union(mask))
        polygons = []
        for face in faces(surface):
            polygon = Polygon([(x, z) for x, y, z in face])
            polygons.append(polygon)
            self.assertAlmostEqual(polygon.intersection(mask).area, 0, places=8)
            for x, y, z in face:
                self.assertAlmostEqual(y, sample(g, x, z), places=8)
        self.assertAlmostEqual(unary_union(polygons).symmetric_difference(expected).area, 0, places=8)
        self.assertEqual(g['heights'], original)
        self.assertEqual(surface['heightSource'], 'fixture-dem')
        self.assertEqual(surface['exclusions'], report['terrainSurface']['exclusions'])
        removal = surface['exclusions'][0]
        self.assertEqual(removal['interiorGround'], 'unknown')
        self.assertAlmostEqual(removal['areaM2'], mask.difference(water).area, places=6)
        self.assertTrue(Polygon(removal['polygonXZ']).equals(mask))


class ChunjianExclusionTests(unittest.TestCase):
    def setUp(self):
        self.pool = box(-65, -75, 65, 75)
        self.gym = box(90, -80, 230, 80)
        self.concourse = box(240, -75, 320, 75).difference(box(260, -12, 290, 12))
        stadium = box(330, -100, 500, 100).difference(box(350, -80, 470, 80))
        self.buildings = [dict(id=id_, poly=poly, minHeight=0) for id_, poly in [
            ('way/665408866', self.pool), ('way/665408865', self.gym),
            ('relation/9244351', self.concourse), ('relation/9244350', stadium)
        ]]
        self.old_dsm = {'x0': -75, 'z0': -75, 'step': 25, 'nx': 14, 'nz': 7, 'heightScale': 0.1,
                        'heights': [325] * (14 * 7), 'processing': {'heightSource': 'copernicus-glo30-dsm'}}
        self.manifest = json.loads(SOURCE.read_text())
        self.manifest['chunjian']['requiredFootprints'] = {building['id']: _footprint_signature(building['poly'])
                                                            for building in self.buildings}

    def exclusions(self, buildings, terrain=None, roads=()):
        with patch('terrain_exclusions.SOURCE') as source:
            source.read_text.return_value = json.dumps(self.manifest)
            return chunjian_exclusions(buildings, self.old_dsm if terrain is None else terrain, roads)

    def test_chunjian_exclusions_require_old_dsm_complete_halls_and_route_clearance(self):
        other_dem = {**self.old_dsm, 'processing': {'heightSource': 'different-dem'}}
        self.assertEqual(self.exclusions(self.buildings, other_dem), [])
        self.assertEqual(self.exclusions(self.buildings[:-1]), [])
        self.assertEqual(self.exclusions([*self.buildings, self.buildings[0]]), [])
        masks = self.exclusions(self.buildings)
        self.assertEqual([mask['sourceId'] for mask in masks], ['way/665408866', 'way/665408865'])
        self.assertTrue(self.pool.contains_properly(masks[0]['poly']))
        self.assertTrue(self.gym.contains_properly(masks[1]['poly']))
        self.assertEqual(masks[0]['dsmGridSamples']['minM'], 32.5)

        points = [(ORIGIN_LON + x / KX, ORIGIN_LAT - 46 / KY) for x in [-60, 60]]
        route = {'id': 'way/1', 'geom': LineString(points)}
        self.assertEqual([mask['sourceId'] for mask in self.exclusions(self.buildings, roads=[route])], ['way/665408865'])

    def test_chunjian_withholds_source_footprint_drift_including_a_shifted_opening(self):
        pool, gym, arch, stadium = self.buildings
        shifted_opening = box(240, -75, 320, 75).difference(box(262, -12, 292, 12))
        self.assertEqual(shifted_opening.bounds, self.concourse.bounds)
        self.assertEqual(shifted_opening.area, self.concourse.area)
        self.assertEqual(len(shifted_opening.interiors), len(self.concourse.interiors))
        self.assertEqual(self.exclusions([pool, gym, {**arch, 'poly': shifted_opening}, stadium]), [])
        self.assertEqual(self.exclusions([{**pool, 'poly': box(-50, -75, 50, 75)}, gym, arch, stadium]), [])

    def test_chunjian_requires_clearance_from_glazing_even_with_a_reviewed_footprint(self):
        pool, *others = self.buildings
        for half_width in [50, 60]:
            with self.subTest(half_width=half_width):
                revised = box(-half_width, -75, half_width, 75)
                self.manifest['chunjian']['requiredFootprints'][pool['id']] = _footprint_signature(revised)
                masks = self.exclusions([{**pool, 'poly': revised}, *others])
                self.assertEqual([mask['sourceId'] for mask in masks], ['way/665408865'])
