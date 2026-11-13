"""一条命令从原始快照生成共享城市数据和审计报告。"""

import argparse
import gzip
import hashlib
import json
import time
from pathlib import Path

from shapely import make_valid, set_precision, transform
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from air_cruises import build_air_cruises
from beihuan import apply_beihuan_sections
from bridges import build_bridges
from building_appearance import apply_building_appearance
from buildings import (CATEGORIES, CONFIDENCE_LEVELS, FACADES, HEIGHT_SOURCES, ROLES,
                       UPSTREAM_FAMILIES, build_buildings, ensure_globfp, load_globfp)
from commercial_paving import cut_commercial_paving, ground_carriageway_mask
from geo import (HONG_KONG_BOUNDARY_ID, ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX, phase1_clip_local,
                 project, project_coords)
from land import _polys, _to_local, build_land
from landmark_sites import build_landmark_sites, read_site_areas
from osm import read_osm
from map_regions import build_map_regions
from parks import build_parks
from road_frontage import build_road_frontage
from roads import CLASSES, build_roads
from roadgraph import apply_drive_rules, build_roadgraph
from sea_surface import build_sea_surface
from shenzhen_bay import build_shenzhen_bay
from shenzhen_golf import build_shenzhen_golf
from shenzhen_north_rail import build_shenzhen_north
from streetscape import build_iec_paths, build_streetscape
from talent_park import compile_talent_park
from terrain import build_terrain
from terrain_exclusions import chunjian_exclusions
from terrain_surface import apply_city_datum, apply_urban_datum, build_terrain_surface
from road_surface import build_road_surface
from road_structures import compile_road_structures
from trees import build_trees
from metro import build_metro
from turn_restrictions import build_turn_restrictions
from waterfront import compile_waterfront, compile_waterfront_routes, restore_bay_paving
from waterfront_parks import compile_waterfront_parks
from dasha_greenway import compile_dasha_greenway
from urban_paving import compile_urban_paving
from yanjiang import build_yanjiang
from fastpack import encode_city
from package_validation import CORE_SOURCES, audit_payload, require_matching_snapshot, ring_points, verify_sources

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'js/sz-city.json.gz'
REPORT = ROOT / 'data/source/build-report.json'
LANDMARKS = ROOT / 'data/source/landmarks.json'
AIR = ROOT / 'data/source/air-routes.json'
URBAN_DATUM = ROOT / 'data/source/urban-datum.json'
ROAD_STRUCTURES = ROOT / 'data/source/road-structures.json'
FAST_OUT = ROOT / 'js/sz-city.szc.gz'
VALIDATION_REPORT = ROOT / 'data/source/data-validation-report.json'

FORMAT_VERSION = 2


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
        entry = {'id': lm['id'], 'name': lm['name'], 'phase': lm['phase'],
                 'x': round(x, 1), 'z': round(z, 1), 'height': h}
        for key in ('short', 'aliases', 'mapPriority'):
            if key in lm:
                entry[key] = lm[key]
        out.append(entry)
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


def civic_paving(osm, spec):
    sources = {item['id']: item for item in osm['plaza'] if item['id'] in spec['osmIds']}
    if sources.keys() != set(spec['osmIds']) or any(item['tags'].get('highway') != 'pedestrian'
                                                     for item in sources.values()):
        raise ValueError('Missing reviewed Civic Square paving sources')
    return set_precision(unary_union([transform(item['geom'], project, interleaved=False)
                                      for item in sources.values()]), 0.1)


def apply_commercial_carriageway(surface, manifest, graph, report):
    masks = []
    details = {}
    for row in manifest['commercial']:
        if not row.get('excludeGroundCarriageway'):
            continue
        outer, *holes = row['polygonWgs84']
        parcel = Polygon(project_coords(outer), [project_coords(ring) for ring in holes])
        if not parcel.is_valid or parcel.is_empty:
            raise ValueError(f'Invalid reviewed commercial area: {row["osmId"]}')
        mask, details[row['osmId']] = ground_carriageway_mask(parcel, graph)
        masks.append(mask)
    if not masks:
        return surface

    surface, removed = cut_commercial_paving(surface, unary_union(masks))
    paving = report['urbanDatum']['commercialPaving']
    paving['groundCarriagewayExclusions'] = details
    summary = report['terrainSurface']
    summary.update(vertices=sum(len(chunk['kinds']) for chunk in surface['chunks']),
                   triangles=sum(len(chunk['indices']) // 3 for chunk in surface['chunks']),
                   groundCarriagewayRemovedPavingM2=round(summary.get('groundCarriagewayRemovedPavingM2', 0) + removed, 3))
    return surface


def compile_ground(terrain, clip, land, water, green, wetland, exclusions, graph, sites, osm, osm_source, report,
                   manifest, civic):
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
    civic = civic.intersection(dry).difference(unary_union(exclusions_polys))
    report['urbanDatum']['civicPaving'] = {**manifest['civicPaving'], 'areaM2': round(civic.area, 2)}
    surface = build_terrain_surface(terrain, clip, land, water, report, green=green, wetland=wetland,
                                    exclusions=exclusions, paving=[paving, civic])
    return terrain, apply_commercial_carriageway(surface, manifest, graph, report)


def read_road_covers(manifest, osm_source, osm=None):
    covers = {cover['osmId']: cover for cover in manifest.get('roadCovers', [])}
    if not covers:
        return {}
    if osm is None:
        osm = read_osm(PHASE1_BBOX, pbf=ROOT / osm_source['file'], source_sha256=osm_source['sha256'])
    shapes = {}
    for row in osm['buildings']:
        cover = covers.get(row['id'])
        if cover is None:
            continue
        if any(row['tags'].get(key) != value for key, value in cover['osmTags'].items()):
            raise ValueError(f"Reviewed road cover source tags changed: {row['id']}")
        shapes[row['id']] = _to_local(row['geom'])
    if shapes.keys() != covers.keys():
        raise ValueError('Missing reviewed road cover in locked OSM snapshot')
    return shapes


def exclude_packaged_road_covers(payload, report, shapes):
    b = payload['buildings']
    removed = [i for i, identity in enumerate(b['id']) if identity in shapes]
    if not removed:
        return
    enums = payload['enums']
    stats = report['buildingRecords']
    for i in removed:
        if b['lm'][i] >= 0 or b['name'][i] >= 0 or enums['upstreamFamily'][b['upstream'][i]] != 'osm':
            raise ValueError(f"Reviewed road cover is not an anonymous OSM building: {b['id'][i]}")
        report['heightSources'][enums['heightSource'][b['src'][i]]] -= 1
        stats['upstreamFamilies'][enums['upstreamFamily'][b['upstream'][i]]] -= 1
        stats['roles'][enums['buildingRole'][b['role'][i]]] -= 1
        for aspect, column in [('footprint', 'fpConf'), ('height', 'hConf'), ('era', 'eraConf')]:
            stats['confidence'][aspect][enums['confidence'][b[column][i]]] -= 1
    keep = [i for i, identity in enumerate(b['id']) if identity not in shapes]
    payload['buildings'] = {key: [column[i] for i in keep] for key, column in b.items()}
    payload['retailBuildings'] = [row for row in payload.get('retailBuildings', []) if row[0] not in shapes]
    report['buildings'] = len(keep)
    report['osmBuildings'] -= len(removed)


def write_city_packages(payload, report, sources, started, *, refresh_regions=True, appearance_osm=None, structure_base=None):
    payload.pop('roads', None)
    osm_source = next(row for row in sources if row['id'] == 'osm-guangdong')
    if refresh_regions:
        regions = build_map_regions(payload, osm_source, enc_poly)
        payload['mapRegions'] = regions
        report['mapRegions'] = {key: regions[key] for key in ('version', 'source', 'pilot', 'coverage')}
        payload['airCruises'], report['airCruises'] = build_air_cruises(payload['roadGraph'], osm_source)
    manifest = json.loads(ROAD_STRUCTURES.read_text())
    cover_shapes = read_road_covers(manifest, osm_source, appearance_osm)
    exclude_packaged_road_covers(payload, report, cover_shapes)
    compile_road_structures(payload, manifest, report, base=structure_base, cover_shapes=cover_shapes or None)
    if appearance_osm is not None:
        apply_building_appearance(payload, appearance_osm, report)
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


def remove_reviewed_globfp_footprints(payload, report, clip, inputs, reason):
    audit = {}
    load_globfp(clip, audit, ensure_globfp(inputs))
    reviewed = [row for row in audit['excludedGlobfpFootprints'] if row['reason'] == reason]
    excluded = {row['id'] for row in reviewed}
    buildings = payload['buildings']
    removed = [i for i, identity in enumerate(buildings['id']) if identity in excluded]
    enums = payload['enums']
    stats = report['buildingRecords']
    for i in removed:
        if buildings['name'][i] >= 0 or buildings['lm'][i] >= 0 or buildings['lv'][i] >= 0:
            raise ValueError(f'Reviewed footprint is not an anonymous supplemental volume: {buildings["id"][i]}')
        report['heightSources'][enums['heightSource'][buildings['src'][i]]] -= 1
        stats['upstreamFamilies'][enums['upstreamFamily'][buildings['upstream'][i]]] -= 1
        stats['roles'][enums['buildingRole'][buildings['role'][i]]] -= 1
        for aspect, column in (('footprint', 'fpConf'), ('height', 'hConf'), ('era', 'eraConf')):
            stats['confidence'][aspect][enums['confidence'][buildings[column][i]]] -= 1
    keep = [i for i, identity in enumerate(buildings['id']) if identity not in excluded]
    payload['buildings'] = {key: [column[i] for i in keep] for key, column in buildings.items()}
    if 'retailBuildings' in payload:
        payload['retailBuildings'] = [row for row in payload['retailBuildings'] if row[0] not in excluded]
    report['buildings'] = len(keep)
    report['globfpAdded'] -= len(removed)
    report['excludedGlobfpFootprints'] = [row for row in report['excludedGlobfpFootprints'] if row['id'] not in excluded] + reviewed
    return [buildings['id'][i] for i in removed]


def remove_civic_paving_trees(trees, report, civic):
    removed, keep = [], []
    for i, (x, z, source) in enumerate(zip(trees['x'], trees['z'], trees['source'], strict=True)):
        simulated = trees['sources'][source].startswith('simulated-')
        (removed if simulated and civic.covers(Point(x / 10, z / 10)) else keep).append(i)
    summary = report['trees']
    for i in removed:
        source = trees['sources'][trees['source'][i]]
        species = trees['speciesNames'][trees['species'][i]]
        appearance = trees['appearanceSources'][trees['appearance'][i]]
        for stats in (trees['stats'], summary):
            stats['countsBySource'][source] -= 1
            stats['speciesCounts'][species] -= 1
        summary['appearanceSources'][appearance] -= 1
        if source == 'simulated-park':
            summary['parkKept']['otherGreen'] -= 1
    for key in ('x', 'z', 'height', 'crown', 'species', 'source', 'appearance'):
        trees[key] = [trees[key][i] for i in keep]
    references = dict(trees['osm'])
    trees['osm'] = [[new, references[old]] for new, old in enumerate(keep) if old in references]
    trees['count'] = len(keep)
    for stats in (trees['stats'], summary):
        stats['kept'] = len(keep)
        if removed:
            stats['dropped']['civic-stone-paving'] = stats['dropped'].get('civic-stone-paving', 0) + len(removed)
    return len(removed)


def rebuild_ground(terrain_source, sources, osm, osm_source, report, started, clip, excluded, *,
                   civic_review=False, commercial_review=False, golf_only=False):
    raw = gzip.decompress(OUT.read_bytes())
    validation = json.loads(VALIDATION_REPORT.read_text())
    require_matching_snapshot(raw, validation, sources)
    payload = json.loads(raw)
    report.update(json.loads(REPORT.read_text()))
    if (payload['origin'] != [ORIGIN_LON, ORIGIN_LAT]
            or payload['coverage'] != [enc_poly(p) for p in getattr(clip, 'geoms', [clip])]):
        raise ValueError('Ground rebuild requires the current city origin and coverage')

    pbf = ROOT / osm_source['file']
    if golf_only:
        previous = report.get('shenzhenGolfCourse', {}).get('terrain', {}).get('gridOriginalHeights', [])
        build_shenzhen_golf(payload, osm, pbf, report, previous=previous)
        write_city_packages(payload, report, sources, started)
        return

    previous = payload['terrainSurface']
    manifest = json.loads(URBAN_DATUM.read_text())
    if commercial_review:
        if manifest['version'] != 1 or manifest['osmSnapshotSha256'] != osm_source['sha256']:
            raise ValueError('Commercial ground needs the reviewed OSM snapshot')
        surface = apply_commercial_carriageway(previous, manifest, payload['roadGraph'], report)
        rebuilt = [chunk['id'] for chunk, old in zip(surface['chunks'], previous['chunks'], strict=True) if chunk is not old]
        report['groundRebuild'] = {'basePayloadSha256': validation['payloadSha256'],
                                   'changedSections': ['terrainSurface'], 'rebuiltChunks': rebuilt}
        payload['terrainSurface'] = surface
        write_city_packages(payload, report, sources, started)
        return

    def polygon(rings):
        outer, *holes = rings
        shape = Polygon(ring_points(outer), [ring_points(ring) for ring in holes])
        return shape if shape.is_valid else make_valid(shape)

    def polygons(key):
        return map(polygon, payload[key])

    exclusions = [{**{key: value for key, value in item.items() if key not in ('areaM2', 'boundsXZ', 'polygonXZ')},
                   'poly': Polygon(item['polygonXZ'])} for item in previous.get('exclusions', [])]
    land = list(polygons('land'))
    water, green, wetland = [[{'poly': poly} for poly in polygons(key)] for key in ('water', 'green', 'wetland')]
    civic = civic_paving(osm, manifest['civicPaving'])
    changed = ['terrain', 'terrainSurface']
    if civic_review:
        removed_buildings = remove_reviewed_globfp_footprints(payload, report, clip, {row['id']: row for row in sources},
                                                           'reviewed-shennan-median-lawn')
        removed_trees = remove_civic_paving_trees(payload['trees'], report, civic)
        # 仅重编码与铺装相交的绿地，其他地区保持原包的分米轮廓。
        clipped = []
        for rings in payload['green']:
            shape = polygon(rings)
            if shape.intersection(civic).area > 0:
                clipped.extend(enc_poly(part) for part in _polys(shape.difference(civic)) if not part.is_empty)
            else:
                clipped.append(rings)
        payload['green'] = clipped
        report['green'] = len(clipped)
        green = [{'poly': shape} for shape in polygons('green')]
        b = payload['buildings']
        frontage_buildings = [{'poly': polygon(rings), 'minHeight': height}
                              for rings, height in zip(b['rings'], b['minH'], strict=True)]
        payload['roadFrontage'] = build_road_frontage(ROOT / osm_source['file'], osm, payload['roadGraph'],
                                                     frontage_buildings, report)
        changed += ['buildings', 'green', 'roadFrontage', 'trees']
        report['civicRebuild'] = {'removedMedianBuildings': removed_buildings, 'removedPavingTrees': removed_trees}
    source = build_terrain(clip, report, source=terrain_source, excluded=excluded)
    terrain, surface = compile_ground(source, clip, land, water, green, wetland, exclusions,
                                      payload['roadGraph'], payload['sites'], osm, osm_source, report, manifest, civic)
    if previous['grid'] != surface['grid'] or previous['chunkSize'] != surface['chunkSize']:
        raise ValueError('Ground rebuild changed the city terrain grid')
    report['groundRebuild'] = {'basePayloadSha256': validation['payloadSha256'],
        'changedSections': changed, 'rebuiltChunks': [chunk['id'] for chunk in surface['chunks']]}
    payload['terrain'], payload['terrainSurface'] = terrain, surface
    payload.pop('roadStructures', None)
    build_shenzhen_golf(payload, osm, pbf, report)
    payload.pop('shenzhenBay', None)
    build_shenzhen_bay(payload, osm, pbf, report)
    payload.pop('waterfront', None)
    compile_waterfront(payload, osm, pbf, report)
    compile_waterfront_routes(payload, osm, pbf, report)
    compile_waterfront_parks(payload, osm, pbf, report)
    compile_dasha_greenway(payload, osm, pbf, report)
    payload.pop('urbanPaving', None)
    compile_urban_paving(payload, osm_source, report)
    changed.append('urbanPaving')
    write_city_packages(payload, report, sources, started)


def city_clip(osm):
    envelope = phase1_clip_local()
    boundary = osm['hongKongBoundary']
    if boundary is None or boundary.is_empty or not boundary.is_valid:
        raise ValueError('The locked OSM snapshot is missing a valid Hong Kong boundary')
    excluded = _to_local(boundary)
    # 岸线简化与分米量化可能跨过原边线，留出小于源分辨率的内缩量。
    boundary_inset = 1.2
    clip = envelope.difference(excluded.buffer(boundary_inset))
    coverage = {'excludedOsmId': f'relation/{HONG_KONG_BOUNDARY_ID}',
                'excludedAreaKm2': round(envelope.difference(clip).area / 1e6, 3),
                'boundaryInsetM': boundary_inset, 'areaKm2': round(clip.area / 1e6, 3)}
    return envelope, excluded, clip, coverage


def export_road_preview(use_cache):
    # 离线审核保留旧预览口径，包括非机动车道；运行时只读有向路网。
    sources = verify_sources(source_ids=('osm-guangdong',))
    source = sources[0]
    osm = read_osm(PHASE1_BBOX, use_cache=use_cache, pbf=ROOT / source['file'], source_sha256=source['sha256'])
    _, _, clip, coverage = city_clip(osm)
    counts = {}
    roads = build_roads(osm, clip, counts)
    encoded = [{**{key: value for key, value in road.items() if key != 'line'},
                'pts': enc_ring(road['line'].coords, strip_closure=False)} for road in roads]
    print(json.dumps({'origin': [ORIGIN_LON, ORIGIN_LAT], 'coverage': coverage,
                      'sourceIntegrity': sources, **counts, 'preview': encoded}, ensure_ascii=False))


def rebuild_road_frontage(corridor_ids, *, crossing_axis_ids=(), use_cache=True):
    """仅替换已核走廊的前场面，锁住信号、路网、地坪及其他样区。"""
    started = time.time()
    raw = gzip.decompress(OUT.read_bytes())
    payload = json.loads(raw)
    validation = json.loads(VALIDATION_REPORT.read_text())
    sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
    require_matching_snapshot(raw, validation, sources)
    report = json.loads(REPORT.read_text())
    frontage = payload['roadFrontage']
    ids = set(corridor_ids)
    axis_ids = set(crossing_axis_ids)
    if not (ids | axis_ids) <= {row['id'] for row in frontage['corridors']} or ids & axis_ids:
        raise ValueError('Frontage rebuild requires existing reviewed corridors')
    osm_source = next(row for row in sources if row['id'] == 'osm-guangdong')
    pbf = ROOT / osm_source['file']
    osm = read_osm(PHASE1_BBOX, use_cache=use_cache, pbf=pbf, source_sha256=osm_source['sha256'])
    buildings = []
    for rings, height in zip(payload['buildings']['rings'], payload['buildings']['minH'], strict=True):
        outer, *holes = map(ring_points, rings)
        shape = Polygon(outer, holes)
        buildings.append({'poly': shape if shape.is_valid else make_valid(shape), 'minHeight': height})
    compiled_report = {key: report[key] for key in ('beihuanCrossSection',) if key in report}
    compiled = build_road_frontage(pbf, osm, payload['roadGraph'], buildings, compiled_report)
    compiled_audit = compiled_report['roadFrontage']
    audit = report['roadFrontage']
    if (compiled['version'] != frontage['version'] or compiled['entrances'] != frontage['entrances']
            or compiled_audit['unresolvedPedestrianWays'] != audit['unresolvedPedestrianWays']):
        raise ValueError('Frontage source connectivity changed; review before rebuilding')

    by_corridor = {row['id']: row for row in compiled['corridors']}
    if not (ids | axis_ids) <= by_corridor.keys():
        raise ValueError('Missing compiled frontage corridor')
    if any(not by_corridor[identity].get('crossingAxes') for identity in axis_ids):
        raise ValueError('Missing compiled crossing axes')
    # 净空只需要源过街轴的走廊，保留已发布的步道、标线和原有局部几何。
    for index, row in enumerate(frontage['corridors']):
        identity = row['id']
        if identity in ids:
            frontage['corridors'][index] = by_corridor[identity]
        elif identity in axis_ids:
            if row['crossingIds'] != by_corridor[identity]['crossingIds']:
                raise ValueError('Crossing axes no longer match the reviewed crossings')
            frontage['corridors'][index] = {**row, 'crossingAxes': by_corridor[identity]['crossingAxes']}
    features = {}
    for row in compiled['features']:
        corridor = row['id'].split(':', 1)[0]
        if corridor in ids:
            features.setdefault(corridor, []).append(row)
    merged = []
    pending = ids.copy()
    for row in frontage['features']:
        corridor = row['id'].split(':', 1)[0]
        if corridor not in ids:
            merged.append(row)
        elif corridor in pending:
            merged.extend(features.get(corridor, ()))
            pending.remove(corridor)
    for corridor in sorted(pending):
        merged.extend(features.get(corridor, ()))

    bounds = [by_corridor[identity]['bounds'] for identity in ids]

    def in_scope(point):
        x, z = point
        return any(min_x <= x <= max_x and min_z <= z <= max_z for min_x, min_z, max_x, max_z in bounds)

    old_shrubs = [point for point in frontage['shrubSites'] if in_scope(point)]
    new_shrubs = [point for point in compiled['shrubSites'] if in_scope(point)]
    if old_shrubs != new_shrubs:
        frontage['shrubSites'] = [point for point in frontage['shrubSites'] if not in_scope(point)] + new_shrubs
    frontage['features'] = merged
    frontage['source']['evidence'].update(compiled['source']['evidence'])
    audit.update(corridors=frontage['corridors'], features=len(merged),
                 planarTriangles=sum(len(row['trianglesXZ']) // 6 for row in merged),
                 medianShrubsEstimated=len(frontage['shrubSites']))
    report['frontageRebuild'] = {'basePayloadSha256': validation['payloadSha256'], 'corridors': sorted(ids),
                                 'crossingAxisCorridors': sorted(axis_ids)}
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
    mode.add_argument('--rebuild-building-appearance', action='store_true',
                      help='refresh estimated building heights and retail use on the verified city package')
    mode.add_argument('--build-shenzhen-bay', action='store_true',
                      help='apply the reviewed Shenzhen Bay waterfront to an unmodified verified city package')
    mode.add_argument('--rebuild-drive-rules', action='store_true',
                      help='refresh navigation rules from the verified OSM snapshot without rebuilding geometry')
    mode.add_argument('--repack-existing', action='store_true',
                    help='validate the snapshot and repack SZC1; migrate legacy road preview out of both packages')
    mode.add_argument('--audit-road-preview', action='store_true',
                      help='write the offline OSM road preview audit as JSON to stdout')
    mode.add_argument('--rebuild-map-regions', action='store_true',
                      help='regenerate map regions from the verified city package and OSM snapshot')
    mode.add_argument('--rebuild-road-structures', type=Path, nargs='?', const=True, metavar='UNCUT_CITY_PACKAGE',
                      help='compile reviewed structures and cut portals into the verified city surface')
    mode.add_argument('--rebuild-air-cruises', action='store_true',
                      help='regenerate air cruises from the verified city road graph')
    mode.add_argument('--rebuild-ground', action='store_true',
                      help='rebuild the ground pilot from the current verified payload and snapshots')
    mode.add_argument('--rebuild-civic-ground', action='store_true',
                      help='apply the reviewed Civic Square paving and Shennan median to the verified package')
    mode.add_argument('--rebuild-road-frontage', nargs='+', metavar='CORRIDOR',
                      help='replace only the selected road frontage corridors in the verified package')
    ap.add_argument('--refresh-frontage-crossing-axes', nargs='+', metavar='CORRIDOR', default=[],
                    help='with --rebuild-road-frontage, copy only crossing axes for these additional corridors')
    mode.add_argument('--rebuild-commercial-ground', action='store_true',
                      help='rebuild reviewed commercial paving chunks on the verified terrain and road graph')
    mode.add_argument('--rebuild-golf-course', action='store_true',
                      help='apply the reviewed Shenzhen Golf Course site to the verified package')
    mode.add_argument('--rebuild-shenzhen-north', action='store_true',
                      help='compile only Shenzhen North rail on the verified city package')
    mode.add_argument('--rebuild-iec', action='store_true',
                      help='add reviewed Xiangmi Lake paths and reflecting pool to the current verified snapshot')
    mode.add_argument('--rebuild-talent-park', action='store_true',
                      help='compile the reviewed Talent Park waterfront on the verified package')
    mode.add_argument('--rebuild-waterfront', action='store_true',
                      help='compile the reviewed lake, bay and river samples on the verified package')
    mode.add_argument('--restore-bay-paving', action='store_true',
                      help='restore source paving on the existing Shenzhen Bay surface')
    mode.add_argument('--extend-waterfront', action='store_true',
                      help='compile reviewed waterfront routes on the verified city surface')
    mode.add_argument('--rebuild-urban-paving', action='store_true',
                      help='apply reviewed ground-cover sites to the verified package')
    mode.add_argument('--build-waterfront-parks', action='store_true',
                      help='add the reviewed park waterfront network to the verified city package')
    mode.add_argument('--build-dasha-greenway', action='store_true',
                      help='add the reviewed Dasha greenway to the verified city package')
    ap.add_argument('--urban-paving-pilot-only', action='store_true',
                    help='with --rebuild-urban-paving, compile only the three comparison sites')
    args = ap.parse_args()
    if args.urban_paving_pilot_only and not args.rebuild_urban_paving:
        ap.error('--urban-paving-pilot-only requires --rebuild-urban-paving')
    if args.refresh_frontage_crossing_axes and not args.rebuild_road_frontage:
        ap.error('--refresh-frontage-crossing-axes requires --rebuild-road-frontage')

    if args.audit_road_preview:
        export_road_preview(not args.no_cache)
        return

    if args.rebuild_drive_rules or args.repack_existing or args.rebuild_map_regions or args.rebuild_air_cruises or args.rebuild_road_structures:
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        report = json.loads(VALIDATION_REPORT.read_text())
        require_matching_snapshot(raw, report, sources)
        if args.rebuild_drive_rules:
            report = json.loads(REPORT.read_text())
            osm_source = next(row for row in sources if row['id'] == 'osm-guangdong')
            apply_drive_rules(ROOT / osm_source['file'], payload['roadGraph'], report)
            write_city_packages(payload, report, sources, started, refresh_regions=False)
        elif 'roads' in payload or args.rebuild_map_regions or args.rebuild_air_cruises or args.rebuild_road_structures:
            structure_base = None
            if isinstance(args.rebuild_road_structures, Path):
                base = json.loads(gzip.decompress(args.rebuild_road_structures.read_bytes()))
                if 'roadStructures' in base or any(base.get(key) != payload.get(key)
                                                  for key in ('origin', 'coverage', 'terrain', 'roadGraph')):
                    raise ValueError('Portal rebuild requires the matching uncut city surface')
                structure_base = base['terrainSurface']
            build_report = json.loads(REPORT.read_text())
            if args.rebuild_road_structures:
                remove_reviewed_globfp_footprints(payload, build_report, phase1_clip_local(),
                                                {row['id']: row for row in sources}, 'reviewed-nantou-open-viaduct')
            write_city_packages(payload, build_report, sources, started, structure_base=structure_base,
                                refresh_regions=not args.rebuild_road_structures)
        else:
            print(json.dumps(write_fast_package(payload, raw, report['sourceIntegrity']), indent=2))
        return

    if args.rebuild_road_frontage:
        rebuild_road_frontage(args.rebuild_road_frontage, crossing_axis_ids=args.refresh_frontage_crossing_axes,
                              use_cache=not args.no_cache)
        return

    if args.rebuild_urban_paving:
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        report = json.loads(REPORT.read_text())
        osm_source = next(source for source in sources if source['id'] == 'osm-guangdong')
        compile_urban_paving(payload, osm_source, report, pilot_only=args.urban_paving_pilot_only)
        write_city_packages(payload, report, sources, started, refresh_regions=False)
        return

    if args.rebuild_building_appearance:
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        osm_source = next(source for source in sources if source['id'] == 'osm-guangdong')
        osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache, pbf=ROOT / osm_source['file'],
                       source_sha256=osm_source['sha256'])
        write_city_packages(payload, json.loads(REPORT.read_text()), sources, started,
                            refresh_regions=False, appearance_osm=osm)
        return

    if args.rebuild_shenzhen_north:
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        osm_source = next(source for source in sources if source['id'] == 'osm-guangdong')
        report = json.loads(REPORT.read_text())
        payload['shenzhenNorthRail'] = build_shenzhen_north(ROOT / osm_source['file'], report)
        write_city_packages(payload, report, sources, started)
        return

    if args.restore_bay_paving:
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        report = json.loads(REPORT.read_text())
        restore_bay_paving(payload, report)
        write_city_packages(payload, report, sources, started, refresh_regions=False)
        return

    if (args.rebuild_talent_park or args.rebuild_waterfront or args.extend_waterfront
            or args.build_waterfront_parks or args.build_dasha_greenway):
        started = time.time()
        raw = gzip.decompress(OUT.read_bytes())
        payload = json.loads(raw)
        sources = verify_sources(source_ids=(*CORE_SOURCES, *payload['terrain']['sourceIds']))
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        osm_source = next(source for source in sources if source['id'] == 'osm-guangdong')
        osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache, pbf=ROOT / osm_source['file'],
                       source_sha256=osm_source['sha256'])
        report = json.loads(REPORT.read_text())
        if args.build_dasha_greenway:
            compile_dasha_greenway(payload, osm, ROOT / osm_source['file'], report)
        elif args.build_waterfront_parks:
            compile_waterfront_parks(payload, osm, ROOT / osm_source['file'], report)
        elif args.extend_waterfront:
            compile_waterfront_routes(payload, osm, ROOT / osm_source['file'], report)
        elif args.rebuild_waterfront:
            compile_waterfront(payload, osm, ROOT / osm_source['file'], report)
        else:
            compile_talent_park(payload, osm, osm_source, report)
        write_city_packages(payload, report, sources, started,
                            refresh_regions=not (args.extend_waterfront or args.build_waterfront_parks or args.build_dasha_greenway))
        return

    terrain_ids = ('copernicus-dem-N22E113', 'copernicus-dem-N22E114') if args.terrain_source == 'copernicus' else ('terrain-N22E113', 'terrain-N22E114')
    sources = verify_sources(source_ids=(*CORE_SOURCES, *terrain_ids))
    inputs = {source['id']: source for source in sources}
    osm_source = inputs['osm-guangdong']
    pbf = ROOT / osm_source['file']

    t0 = time.time()
    report = {'formatVersion': FORMAT_VERSION, 'origin': [ORIGIN_LON, ORIGIN_LAT], 'bbox': PHASE1_BBOX}
    osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache, pbf=pbf, source_sha256=osm_source['sha256'])
    if args.build_shenzhen_bay:
        raw = gzip.decompress(OUT.read_bytes())
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        payload = json.loads(raw)
        report = json.loads(REPORT.read_text())
        build_shenzhen_bay(payload, osm, pbf, report)
        write_city_packages(payload, report, sources, t0)
        return
    envelope, excluded, clip, report['coverage'] = city_clip(osm)
    landmark_manifest = json.loads(LANDMARKS.read_text())['landmarks']
    if args.rebuild_iec:
        raw = gzip.decompress(OUT.read_bytes())
        require_matching_snapshot(raw, json.loads(VALIDATION_REPORT.read_text()), sources)
        payload = json.loads(raw)
        report = json.loads(REPORT.read_text())
        payload['iecPaths'] = build_iec_paths(landmark_manifest, osm, report)
        landmark = next(row for row in landmark_manifest if row['id'] == 'iec-xiangmihu')
        pool = ('way', int(landmark['osm']['reflectingPool'].split('/')[1]))
        role = payload['sites']['sites'][landmark['id']]
        if 'reflectingPool' not in role:
            for count in ('requestedObjects', 'resolvedObjects', 'roles'):
                report['landmarkSites'][count] += 1
        role['reflectingPool'] = read_site_areas({pool: None}, pbf)[pool]
        write_city_packages(payload, report, sources, t0)
        return

    print(f'osm loaded in {time.time() - t0:.1f}s', flush=True)
    if args.rebuild_ground or args.rebuild_civic_ground or args.rebuild_commercial_ground or args.rebuild_golf_course:
        rebuild_ground(args.terrain_source, sources, osm, osm_source, report, t0, clip, excluded,
                       civic_review=args.rebuild_civic_ground, commercial_review=args.rebuild_commercial_ground,
                       golf_only=args.rebuild_golf_course)
        return

    datum_manifest = json.loads(URBAN_DATUM.read_text())
    civic = civic_paving(osm, datum_manifest['civicPaving'])
    buildings = build_buildings(osm, clip, report, reviewed_parent_uses=not args.without_building_use_review,
                                road_cover_ids=read_road_covers(json.loads(ROAD_STRUCTURES.read_text()), osm_source, osm),
                                include_remote_footprints=args.footprint_source == 'all',
                                overture_path=ROOT / inputs['overture-buildings']['file'],
                                globfp_path=ensure_globfp(inputs, use_cache=not args.no_cache))
    print(f'buildings: {len(buildings)} in {time.time() - t0:.1f}s', flush=True)
    land, water, wetland, green = build_land(osm, clip, buildings, report, paving=civic)
    build_roads(osm, clip, report)  # 保留离线道路数量与公里数。
    terrain = build_terrain(clip, report, source=args.terrain_source, excluded=excluded)
    sea_surface = build_sea_surface(osm, envelope, land, terrain, report)
    road_graph = build_roadgraph(osm, clip, report)
    apply_beihuan_sections(road_graph, report)
    apply_drive_rules(pbf, road_graph, report)
    road_graph['turnRestrictions'] = build_turn_restrictions(pbf, road_graph, report)
    sites = build_landmark_sites(landmark_manifest, report, pbf=pbf, area_entries=osm['buildings'])
    # 春茧两座封闭厅是已核实的地面裁除区：派生路面不得改写馆内格点，先按原始 DSM 求出并复用。
    exclusions = chunjian_exclusions(buildings, terrain, osm['roads'])
    terrain, terrain_surface = compile_ground(terrain, clip, land, water, green, wetland, exclusions,
                                              road_graph, sites, osm, osm_source, report, datum_manifest, civic)
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
        'farLand': [],
        'water': [enc_poly(w['poly']) for w in water],
        'wetland': [enc_poly(w['poly']) for w in wetland],
        'green': [enc_poly(g['poly']) for g in green],
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
        'iecPaths': build_iec_paths(landmark_manifest, osm, report),
        'parks': [{**park, 'areas': [{**area, 'polygon': enc_poly(area['polygon'])}
                                    for area in park['areas']]} for park in parks],
        'bridges': bridges,
        'yanjiangExpressway': build_yanjiang(osm, report),
        'sites': sites,
        'shenzhenNorthRail': build_shenzhen_north(pbf, report),
        'air': json.loads(AIR.read_text()),
    }
    if sea_surface:
        payload['seaSurface'] = {**sea_surface, 'polygons': [enc_poly(p) for p in sea_surface['polygons']]}
    if streetscape:
        payload['streetscape'] = streetscape
    compile_talent_park(payload, osm, osm_source, report)
    if trees:
        payload['trees'] = trees

    report['buildingNames'] = {
        'uniqueNames': len(names),
        'namedBuildings': sum(1 for b in buildings if b.get('name')),
        'buildingsWithLevels': sum(1 for b in buildings if b.get('levels', -1) > 0),
    }

    build_shenzhen_golf(payload, osm, pbf, report)
    build_shenzhen_bay(payload, osm, pbf, report)
    payload.pop('waterfront', None)
    compile_waterfront(payload, osm, pbf, report)
    compile_waterfront_routes(payload, osm, pbf, report)
    compile_waterfront_parks(payload, osm, pbf, report)
    compile_dasha_greenway(payload, osm, pbf, report)
    compile_urban_paving(payload, osm_source, report)
    write_city_packages(payload, report, sources, t0, appearance_osm=osm)


if __name__ == '__main__':
    main()
