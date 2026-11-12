"""一条命令从原始快照生成共享城市数据和审计报告。"""

import argparse
import gzip
import hashlib
import json
import time
from pathlib import Path

from shapely import make_valid, transform
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

from beihuan import apply_beihuan_sections
from bridges import build_bridges
from buildings import (CATEGORIES, CONFIDENCE_LEVELS, FACADES, HEIGHT_SOURCES, ROLES,
                       UPSTREAM_FAMILIES, build_buildings, ensure_globfp)
from geo import ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX, phase1_clip_local, project, project_coords
from land import build_land
from landmark_sites import build_landmark_sites
from osm import read_osm
from parks import build_parks
from road_frontage import build_road_frontage
from roads import CLASSES, build_roads
from roadgraph import build_roadgraph
from sea_surface import build_sea_surface
from streetscape import build_streetscape
from terrain import build_terrain
from terrain_exclusions import chunjian_exclusions
from terrain_surface import apply_city_datum, apply_urban_datum, build_terrain_surface
from road_surface import build_road_surface
from trees import build_trees
from metro import build_metro
from turn_restrictions import build_turn_restrictions
from fastpack import encode_city
from package_validation import CORE_SOURCES, audit_payload, require_matching_snapshot, ring_points, verify_sources

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'js/sz-city.json.gz'
REPORT = ROOT / 'data/source/build-report.json'
LANDMARKS = ROOT / 'data/source/landmarks.json'
AIR = ROOT / 'data/source/air-routes.json'
URBAN_DATUM = ROOT / 'data/source/urban-datum.json'
FAST_OUT = ROOT / 'js/sz-city.szc.gz'
VALIDATION_REPORT = ROOT / 'data/source/data-validation-report.json'

FORMAT_VERSION = 2
FAR_PAD = 30000


def enc_ring(coords, strip_closure=True):
    """坐标转成分米整数，再做差分，压缩后体积小很多。"""
    flat, px, pz = [], 0, 0
    pts = list(coords)
    if strip_closure and len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    for x, z in pts:
        ix, iz = round(x * 10), round(z * 10)
        flat += [ix - px, iz - pz]
        px, pz = ix, iz
    return flat


def enc_poly(poly):
    rings = [enc_ring(poly.exterior.coords)]
    rings += [enc_ring(r.coords) for r in poly.interiors if len(r.coords) >= 4]
    return rings


def landmark_entries(landmarks):
    out = []
    for lm in landmarks:
        lat, lon = lm['center']
        x, z = project(lon, lat)
        h = lm.get('heightM') or max(lm.get('heights', {}).values(), default=0)
        out.append({'id': lm['id'], 'name': lm['name'], 'phase': lm['phase'],
                    'x': round(x, 1), 'z': round(z, 1), 'height': h})
    return out


def write_fast_package(payload, raw, sources):
    validation = audit_payload(payload, raw, sources)
    packed, stats = encode_city(payload)
    compressed = gzip.compress(packed, 9, mtime=0)
    stats['compressedBytes'] = len(compressed)
    stats['compressedSha256'] = hashlib.sha256(compressed).hexdigest()
    validation['output'] = stats
    # 校验和编码全部成功后才替换产物；失败保留上一次可用包。
    temporary = FAST_OUT.with_suffix('.tmp')
    temporary.write_bytes(compressed)
    temporary.replace(FAST_OUT)
    VALIDATION_REPORT.write_text(json.dumps(validation, ensure_ascii=False, indent=2) + '\n')
    return stats


def engineering_ground(graph, sites, engineering, step):
    required = set(engineering['bridgeWayIds'])
    found = set()
    anchors = []
    nodes = graph['nodes']
    # 保留桥宽、桥头外延和接触采样涉及的整个栅格单元。
    for link, metadata in zip(graph['links'], graph['metadata'], strict=True):
        osm_id = metadata['osmId']
        if osm_id not in required or metadata.get('tunnel') or not (metadata.get('bridge') or metadata.get('layer')):
            continue
        start, end, _, width, _, _, inner = link
        line = LineString([nodes[2 * start:2 * start + 2], *zip(inner[::2], inner[1::2]), nodes[2 * end:2 * end + 2]])
        anchors.append(line.buffer(max(width / 2, 3.25) + 2 * step + 10))
        found.add(osm_id)
    if found != required:
        raise ValueError(f'Missing ground anchor for bridge ways: {sorted(required - found)}')
    for entry in engineering['landmarkSites']:
        source = sites['sites'][entry['id']][entry['role']]
        if source['osmId'] != entry['osmId']:
            raise ValueError(f'Unexpected ground anchor for site: {entry["id"]}')
        for outer, *holes in source['polygons']:
            polygon = Polygon(ring_points(outer), [ring_points(ring) for ring in holes])
            anchors.append(make_valid(polygon).buffer(2 * step))
    return unary_union(anchors)


def compile_ground(terrain, clip, land, water, green, wetland, exclusions, graph, sites, osm, osm_source, report):
    manifest = json.loads(URBAN_DATUM.read_text())
    if manifest['version'] != 1 or manifest['osmSnapshotSha256'] != osm_source['sha256']:
        raise ValueError('Urban datum needs the reviewed OSM snapshot')
    dry = unary_union(land).difference(unary_union([feature['poly'] for feature in water]))
    mapped_green = {entry['id']: entry for entry in osm['green']}
    relief_by_id = {}
    for entry in manifest['relief']:
        osm_id = entry['osmId']
        if 'polygonWgs84' in entry:
            outer, *holes = entry['polygonWgs84']
            polygon = Polygon(project_coords(outer), [project_coords(ring) for ring in holes])
            if not polygon.is_valid or polygon.is_empty:
                raise ValueError(f'Invalid relief area: {osm_id}')
        else:
            source = mapped_green[osm_id]
            if any(source['tags'].get(key) != value for key, value in entry['tag'].items()):
                raise ValueError(f'Unexpected tag on relief area: {osm_id}')
            polygon = transform(source['geom'], project, interleaved=False)
        relief_by_id[osm_id] = (entry.get('transition', entry['kind']), polygon)
    exclusions_polys = [entry['poly'] for entry in exclusions]
    previous_protected = unary_union([relief_by_id[osm_id][1] for osm_id in manifest['structuralBaselineReliefIds']]
                                    + exclusions_polys)
    pilots = []
    for row in manifest['structuralBaselinePilots']:
        west, south, east, north = row['boundsWgs84']
        pilots.append((row, box(*project(west, north), *project(east, south))))
    widths = manifest['transitionsM']
    parks = unary_union([polygon for kind, polygon in relief_by_id.values() if kind == 'park'])
    mountains = unary_union([polygon for kind, polygon in relief_by_id.values() if kind == 'mountain'])
    hills = unary_union([polygon for kind, polygon in relief_by_id.values() if kind == 'hillPark'])
    # 普通公园在边界内起坡，避免插值延伸到园外车道；已核实的山体和丘陵公园用更长的山脚过渡。
    relief = [(parks.buffer(-terrain['step']), *widths['park']), (hills, *widths['hillPark']),
              (mountains, *widths['mountain'])]
    anchors = engineering_ground(graph, sites, manifest['engineering'], terrain['step'])
    commercial = []
    for row in manifest['commercial']:
        outer, *holes = row['polygonWgs84']
        polygon = Polygon(project_coords(outer), [project_coords(ring) for ring in holes])
        if not polygon.is_valid:
            raise ValueError(f'Invalid commercial area: {row["osmId"]}')
        commercial.append(polygon)
    planted = unary_union([entry['poly'] for entry in [*green, *wetland]] + [parks, hills, mountains]
                          + exclusions_polys)
    paving = unary_union(commercial).intersection(dry).difference(planted)
    terrain = build_road_surface(terrain, graph, report, excluded_polygons=exclusions)
    structural_baseline = apply_urban_datum(terrain, pilots, manifest['datum'], dry, previous_protected, {})
    terrain = apply_city_datum(terrain, manifest['datum'], dry, relief, (anchors, 0, widths['engineering']),
                               structural_baseline, report)
    report['urbanDatum']['commercialPaving'] = {'osmIds': [row['osmId'] for row in manifest['commercial']],
        'source': manifest['pavingSource'], 'areaM2': round(paving.intersection(dry).area, 2)}
    surface = build_terrain_surface(terrain, clip, land, water, report, green=green, wetland=wetland,
                                    exclusions=exclusions, paving=[paving])
    return terrain, surface


def write_city_packages(payload, report, sources, started):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    compressed = gzip.compress(raw, 9, mtime=0)
    temporary = OUT.with_suffix('.tmp')
    temporary.write_bytes(compressed)
    try:
        report['fastPackage'] = write_fast_package(payload, raw, sources)
        temporary.replace(OUT)
    finally:
        temporary.unlink(missing_ok=True)
    report['outputBytes'] = len(compressed)
    report['outputSha256'] = hashlib.sha256(compressed).hexdigest()
    report['seconds'] = round(time.time() - started, 1)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


def rebuild_ground(terrain_source, sources, osm, osm_source, report, started):
    raw = gzip.decompress(OUT.read_bytes())
    validation = json.loads(VALIDATION_REPORT.read_text())
    require_matching_snapshot(raw, validation, sources)
    payload = json.loads(raw)
    report.update(json.loads(REPORT.read_text()))
    clip = phase1_clip_local()
    if (payload['origin'] != [ORIGIN_LON, ORIGIN_LAT]
            or payload['coverage'] != [enc_poly(p) for p in getattr(clip, 'geoms', [clip])]):
        raise ValueError('Ground rebuild requires the current city origin and coverage')

    def polygons(key):
        for outer, *holes in payload[key]:
            polygon = Polygon(ring_points(outer), [ring_points(ring) for ring in holes])
            yield polygon if polygon.is_valid else make_valid(polygon)

    previous = payload['terrainSurface']
    exclusions = [{**{key: value for key, value in item.items() if key not in ('areaM2', 'boundsXZ', 'polygonXZ')},
                   'poly': Polygon(item['polygonXZ'])} for item in previous.get('exclusions', [])]
    land = list(polygons('land'))
    water, green, wetland = [[{'poly': poly} for poly in polygons(key)] for key in ('water', 'green', 'wetland')]
    source = build_terrain(clip, report, source=terrain_source)
    terrain, surface = compile_ground(source, clip, land, water, green, wetland, exclusions,
                                      payload['roadGraph'], payload['sites'], osm, osm_source, report)
    if previous['grid'] != surface['grid'] or previous['chunkSize'] != surface['chunkSize']:
        raise ValueError('Ground rebuild changed the city terrain grid')
    report['groundRebuild'] = {'basePayloadSha256': validation['payloadSha256'],
        'changedSections': ['terrain', 'terrainSurface'], 'rebuiltChunks': [chunk['id'] for chunk in surface['chunks']]}
    payload['terrain'], payload['terrainSurface'] = terrain, surface
    write_city_packages(payload, report, sources, started)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-cache', action='store_true', help='rebuild OSM and GloBFP extraction caches from the verified snapshots')
    ap.add_argument('--without-building-use-review', action='store_true',
                    help='reproduce the pre-review appearance for the scoped building pilot')
    ap.add_argument('--terrain-source', choices=['copernicus', 'hgt'], default='copernicus',
                    help='select a traceable elevation product without modifying source heights')
    ap.add_argument('--footprint-source', choices=['all', 'osm'], default='all',
                    help='all = OSM + Overture + GloBFP footprints; osm = only map-marked OSM footprints')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--repack-existing', action='store_true',
                    help='validate the existing shared snapshot and generate lossless SZC1 without rebuilding geometry')
    mode.add_argument('--rebuild-ground', action='store_true',
                      help='rebuild the ground pilot from the current verified payload and snapshots')
    args = ap.parse_args()

    if args.repack_existing:
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        report = json.loads(VALIDATION_REPORT.read_text())
        require_matching_snapshot(raw, report, sources)
        print(json.dumps(write_fast_package(payload, raw, report['sourceIntegrity']), indent=2))
        return

    terrain_ids = ('copernicus-dem-N22E113', 'copernicus-dem-N22E114') if args.terrain_source == 'copernicus' else ('terrain-N22E113', 'terrain-N22E114')
    sources = verify_sources(source_ids=(*CORE_SOURCES, *terrain_ids))
    inputs = {source['id']: source for source in sources}
    osm_source = inputs['osm-guangdong']
    pbf = ROOT / osm_source['file']

    t0 = time.time()
    report = {'formatVersion': FORMAT_VERSION, 'origin': [ORIGIN_LON, ORIGIN_LAT], 'bbox': PHASE1_BBOX}
    clip = phase1_clip_local()
    osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache, pbf=pbf, source_sha256=osm_source['sha256'])
    print(f'osm loaded in {time.time() - t0:.1f}s', flush=True)
    if args.rebuild_ground:
        rebuild_ground(args.terrain_source, sources, osm, osm_source, report, t0)
        return

    buildings = build_buildings(osm, clip, report, reviewed_parent_uses=not args.without_building_use_review,
                                include_remote_footprints=args.footprint_source == 'all',
                                overture_path=ROOT / inputs['overture-buildings']['file'],
                                globfp_path=ensure_globfp(inputs, use_cache=not args.no_cache))
    print(f'buildings: {len(buildings)} in {time.time() - t0:.1f}s', flush=True)
    land, water, wetland, green = build_land(osm, clip, buildings, report)
    roads = build_roads(osm, clip, report)
    terrain = build_terrain(clip, report, source=args.terrain_source)
    sea_surface = build_sea_surface(osm, clip, land, terrain, report)
    road_graph = build_roadgraph(osm, clip, report)
    apply_beihuan_sections(road_graph, report)
    road_graph['turnRestrictions'] = build_turn_restrictions(pbf, road_graph, report)
    landmark_manifest = json.loads(LANDMARKS.read_text())['landmarks']
    sites = build_landmark_sites(landmark_manifest, report, pbf=pbf)
    # 春茧两座封闭厅是已核实的地面裁除区：派生路面不得改写馆内格点，先按原始 DSM 求出并复用。
    exclusions = chunjian_exclusions(buildings, terrain, osm['roads'])
    terrain, terrain_surface = compile_ground(terrain, clip, land, water, green, wetland, exclusions,
                                              road_graph, sites, osm, osm_source, report)
    road_frontage = build_road_frontage(pbf, osm, road_graph, buildings, report)
    metro = build_metro(clip, report, use_cache=not args.no_cache, pbf=pbf, verified_source=osm_source)

    landmarks = landmark_entries(landmark_manifest)
    parks = build_parks(landmark_manifest, green, land, water, report)
    streetscape = build_streetscape(pbf, osm, parks, report)
    trees = build_trees(osm, clip, land, water, wetland, green, parks, streetscape, buildings, report,
                        pbf=pbf, road_graph=road_graph)
    bridges = build_bridges(pbf, landmark_manifest, report)
    lm_index = {lm['id']: i for i, lm in enumerate(landmarks)}

    minx, minz, maxx, maxz = clip.bounds
    # 范围外的远景地面：北、东、西三面是陆地，南面（深圳湾）保持海面
    far_land = box(minx - FAR_PAD, minz - FAR_PAD, maxx + FAR_PAD, maxz).difference(clip)
    # 楼名去重成字符串表，运行时按索引取，避免每条记录重复存中文串。
    name_ids = {}
    names = []

    def name_index(value):
        if not value:
            return -1
        if value not in name_ids:
            name_ids[value] = len(names)
            names.append(value)
        return name_ids[value]

    payload = {
        'version': FORMAT_VERSION,
        'terrain': terrain,
        'terrainSurface': terrain_surface,
        'metro': metro,
        'roadGraph': road_graph,
        'roadFrontage': road_frontage,
        'origin': [ORIGIN_LON, ORIGIN_LAT],
        'bounds': [round(minx), round(minz), round(maxx), round(maxz)],
        'coverage': [enc_poly(p) for p in getattr(clip, 'geoms', [clip])],
        'enums': {'facade': FACADES, 'category': CATEGORIES, 'heightSource': HEIGHT_SOURCES,
                  'buildingRole': ROLES, 'upstreamFamily': UPSTREAM_FAMILIES,
                  'confidence': CONFIDENCE_LEVELS, 'roadClass': CLASSES},
        'land': [enc_poly(p) for p in land],
        'farLand': [enc_poly(p) for p in getattr(far_land, 'geoms', [far_land])],
        'water': [enc_poly(w['poly']) for w in water],
        'wetland': [enc_poly(w['poly']) for w in wetland],
        'green': [enc_poly(g['poly']) for g in green],
        'roads': {
            'cls': [CLASSES.index(r['cls']) for r in roads],
            'width': [r['width'] for r in roads],
            'oneway': [1 if r['oneway'] else 0 for r in roads],
            'elevated': [1 if r['elevated'] else 0 for r in roads],
            'name': [r['name'] or '' for r in roads],
            'pts': [enc_ring(r['line'].coords, strip_closure=False) for r in roads],
        },
        'buildings': {
            'id': [b['id'] for b in buildings],
            'rings': [enc_poly(b['poly']) for b in buildings],
            'h': [b['height'] for b in buildings],
            'minH': [b['minHeight'] for b in buildings],
            'cat': [CATEGORIES.index(b['category']) for b in buildings],
            'facade': [FACADES.index(b['facade']) for b in buildings],
            'src': [HEIGHT_SOURCES.index(b['heightSource']) for b in buildings],
            'lm': [lm_index.get(b['landmark'], -1) for b in buildings],
            'name': [name_index(b.get('name')) for b in buildings],
            'lv': [b.get('levels', -1) for b in buildings],
            'role': [ROLES.index(b['role']) for b in buildings],
            'upstream': [UPSTREAM_FAMILIES.index(b['upstream']) for b in buildings],
            'fpConf': [CONFIDENCE_LEVELS.index(b['footprintConfidence']) for b in buildings],
            'hConf': [CONFIDENCE_LEVELS.index(b['heightConfidence']) for b in buildings],
            'eraConf': [CONFIDENCE_LEVELS.index(b['eraConfidence']) for b in buildings],
        },
        'names': names,
        'landmarks': landmarks,
        'parks': [{**park, 'areas': [{**area, 'polygon': enc_poly(area['polygon'])}
                                    for area in park['areas']]} for park in parks],
        'bridges': bridges,
        'sites': sites,
        'air': json.loads(AIR.read_text()),
    }
    if sea_surface:
        payload['seaSurface'] = {**sea_surface, 'polygons': [enc_poly(p) for p in sea_surface['polygons']]}
    if streetscape:
        payload['streetscape'] = streetscape
    if trees:
        payload['trees'] = trees

    report['buildingNames'] = {
        'uniqueNames': len(names),
        'namedBuildings': sum(1 for b in buildings if b.get('name')),
        'buildingsWithLevels': sum(1 for b in buildings if b.get('levels', -1) > 0),
    }

    write_city_packages(payload, report, sources, t0)


if __name__ == '__main__':
    main()
