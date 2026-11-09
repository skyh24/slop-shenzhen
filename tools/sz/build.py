"""一条命令从原始快照生成共享城市数据和审计报告。"""

import argparse
import gzip
import json
import time
from pathlib import Path

from shapely.geometry import box

from beihuan import apply_beihuan_sections
from bridges import build_bridges
from buildings import CATEGORIES, FACADES, HEIGHT_SOURCES, build_buildings
from geo import ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX, phase1_clip_local, project
from land import build_land
from landmark_sites import build_landmark_sites
from osm import PBF, read_osm
from parks import build_parks
from road_frontage import build_road_frontage
from roads import CLASSES, build_roads
from roadgraph import build_roadgraph
from sea_surface import build_sea_surface
from streetscape import build_streetscape
from terrain import build_terrain
from terrain_exclusions import chunjian_exclusions
from terrain_surface import build_terrain_surface
from road_surface import build_road_surface
from trees import build_trees
from metro import build_metro
from turn_restrictions import build_turn_restrictions

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'js/sz-city.json.gz'
REPORT = ROOT / 'data/source/build-report.json'
LANDMARKS = ROOT / 'data/source/landmarks.json'
AIR = ROOT / 'data/source/air-routes.json'

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-cache', action='store_true', help='re-read the OSM PBF instead of the pickle cache')
    ap.add_argument('--without-building-use-review', action='store_true',
                    help='reproduce the pre-review appearance for the scoped building pilot')
    ap.add_argument('--terrain-source', choices=['copernicus', 'hgt'], default='copernicus',
                    help='select a traceable elevation product without modifying source heights')
    args = ap.parse_args()

    t0 = time.time()
    report = {'formatVersion': FORMAT_VERSION, 'origin': [ORIGIN_LON, ORIGIN_LAT], 'bbox': PHASE1_BBOX}
    clip = phase1_clip_local()
    osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache)
    print(f'osm loaded in {time.time() - t0:.1f}s', flush=True)

    buildings = build_buildings(osm, clip, report, reviewed_parent_uses=not args.without_building_use_review)
    print(f'buildings: {len(buildings)} in {time.time() - t0:.1f}s', flush=True)
    land, water, wetland, green = build_land(osm, clip, buildings, report)
    roads = build_roads(osm, clip, report)
    terrain = build_terrain(clip, report, source=args.terrain_source)
    sea_surface = build_sea_surface(osm, clip, land, terrain, report)
    road_graph = build_roadgraph(osm, clip, report)
    apply_beihuan_sections(road_graph, report)
    road_graph['turnRestrictions'] = build_turn_restrictions(PBF, road_graph, report)
    # 春茧两座封闭厅是已核实的地面裁除区：派生路面不得改写馆内格点，先按原始 DSM 求出并复用。
    exclusions = chunjian_exclusions(buildings, terrain, osm['roads'])
    # 路面走廊用 FABDEM 基线派生平滑高程；原始 DSM 在走廊外不变，报告记录逐段前后高差。
    terrain = build_road_surface(terrain, road_graph, report,
                                 excluded_polygons=[exclusion['poly'] for exclusion in exclusions])
    road_frontage = build_road_frontage(PBF, osm, road_graph, buildings, report)
    terrain_surface = build_terrain_surface(terrain, clip, land, water, report, green=green, wetland=wetland,
                                          exclusions=exclusions)
    metro = build_metro(clip, report, use_cache=not args.no_cache)

    landmark_manifest = json.loads(LANDMARKS.read_text())['landmarks']
    landmarks = landmark_entries(landmark_manifest)
    parks = build_parks(landmark_manifest, green, land, water, report)
    streetscape = build_streetscape(PBF, osm, parks, report)
    trees = build_trees(osm, clip, land, water, wetland, green, parks, streetscape, buildings, report,
                        pbf=PBF, road_graph=road_graph)
    bridges = build_bridges(PBF, landmark_manifest, report)
    sites = build_landmark_sites(landmark_manifest, report)
    lm_index = {lm['id']: i for i, lm in enumerate(landmarks)}

    minx, minz, maxx, maxz = clip.bounds
    # 范围外的远景地面：北、东、西三面是陆地，南面（深圳湾）保持海面
    far_land = box(minx - FAR_PAD, minz - FAR_PAD, maxx + FAR_PAD, maxz).difference(clip)
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
        'enums': {'facade': FACADES, 'category': CATEGORIES, 'heightSource': HEIGHT_SOURCES, 'roadClass': CLASSES},
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
        },
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

    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    OUT.write_bytes(gzip.compress(raw, 9, mtime=0))
    report['outputBytes'] = OUT.stat().st_size
    report['seconds'] = round(time.time() - t0, 1)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    # 共享包成功写出后移除旧产物，避免正式版与预览读取不同快照。
    (ROOT / 'js/sz-mvp/data/sz-mvp.json.gz').unlink(missing_ok=True)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
