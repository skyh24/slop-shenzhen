"""一条命令从原始快照生成 MVP 运行数据：js/sz-mvp/data/sz-mvp.json.gz 和 data/source/build-report.json。"""

import argparse
import gzip
import json
import time
from pathlib import Path

from shapely.geometry import box

from buildings import CATEGORIES, FACADES, HEIGHT_SOURCES, build_buildings
from geo import ORIGIN_LAT, ORIGIN_LON, PHASE1_BBOX, phase1_clip_local, project
from land import build_land
from osm import read_osm
from roads import CLASSES, build_roads
from terrain import build_terrain

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'js/sz-mvp/data/sz-mvp.json.gz'
REPORT = ROOT / 'data/source/build-report.json'
LANDMARKS = ROOT / 'data/source/landmarks.json'
AIR = ROOT / 'data/source/air-routes.json'

FORMAT_VERSION = 1
FAR_PAD = 30000


def enc_ring(coords):
    """坐标转成分米整数，再做差分，压缩后体积小很多。"""
    flat, px, pz = [], 0, 0
    pts = list(coords)
    if len(pts) > 1 and pts[0] == pts[-1]:
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


def landmark_entries():
    data = json.loads(LANDMARKS.read_text())
    out = []
    for lm in data['landmarks']:
        lat, lon = lm['center']
        x, z = project(lon, lat)
        h = lm.get('heightM') or max(lm.get('heights', {}).values(), default=0)
        out.append({'id': lm['id'], 'name': lm['name'], 'phase': lm['phase'],
                    'x': round(x, 1), 'z': round(z, 1), 'height': h})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-cache', action='store_true', help='re-read the OSM PBF instead of the pickle cache')
    args = ap.parse_args()

    t0 = time.time()
    report = {'formatVersion': FORMAT_VERSION, 'origin': [ORIGIN_LON, ORIGIN_LAT], 'bbox': PHASE1_BBOX}
    clip = phase1_clip_local()
    osm = read_osm(PHASE1_BBOX, use_cache=not args.no_cache)
    print(f'osm loaded in {time.time() - t0:.1f}s', flush=True)

    buildings = build_buildings(osm, clip, report)
    print(f'buildings: {len(buildings)} in {time.time() - t0:.1f}s', flush=True)
    land, water, wetland, green = build_land(osm, clip, buildings, report)
    roads = build_roads(osm, clip, report)
    terrain = build_terrain(osm, clip, land, water, report)

    landmarks = landmark_entries()
    lm_index = {lm['id']: i for i, lm in enumerate(landmarks)}

    minx, minz, maxx, maxz = clip.bounds
    # 范围外的远景地面：北、东、西三面是陆地，南面（深圳湾）保持海面
    far_land = box(minx - FAR_PAD, minz - FAR_PAD, maxx + FAR_PAD, maxz).difference(clip)
    payload = {
        'version': FORMAT_VERSION,
        'terrain': terrain,
        'origin': [ORIGIN_LON, ORIGIN_LAT],
        'bounds': [round(minx), round(minz), round(maxx), round(maxz)],
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
            'pts': [enc_ring(r['line'].coords) for r in roads],
        },
        'buildings': {
            'rings': [enc_poly(b['poly']) for b in buildings],
            'h': [b['height'] for b in buildings],
            'minH': [b['minHeight'] for b in buildings],
            'cat': [CATEGORIES.index(b['category']) for b in buildings],
            'facade': [FACADES.index(b['facade']) for b in buildings],
            'src': [HEIGHT_SOURCES.index(b['heightSource']) for b in buildings],
            'lm': [lm_index.get(b['landmark'], -1) for b in buildings],
        },
        'landmarks': landmarks,
        'air': json.loads(AIR.read_text()),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    OUT.write_bytes(gzip.compress(raw, 9, mtime=0))
    report['outputBytes'] = OUT.stat().st_size
    report['seconds'] = round(time.time() - t0, 1)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
