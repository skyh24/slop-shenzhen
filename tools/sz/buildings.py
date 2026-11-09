"""合并 OSM 和 Overture 建筑轮廓，按优先级确定楼高，并给出用途和立面类型。"""

import json
import random
import re
import subprocess
from pathlib import Path

from shapely import STRtree
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import transform
from shapely.validation import make_valid

from geo import project

ROOT = Path(__file__).resolve().parents[2]
OVERTURE = ROOT / 'data/raw/overture/buildings-2026-10-21.0.jsonl'
GLOBFP_DIR = ROOT / 'data/raw/globfp'
GLOBFP_SZ = GLOBFP_DIR / 'globfp-sz.jsonl'
LANDMARKS = ROOT / 'data/source/landmarks.json'

LEVEL_HEIGHT = 3.2
MIN_AREA = 16.0

# 立面类型编号，和 js/sz-mvp/buildings.js 的 FACADE 表一一对应
FACADES = ['glass_tower', 'office', 'residential_tower', 'residential_low', 'village', 'industrial', 'public', 'landmark']
CATEGORIES = ['unknown', 'residential', 'commercial', 'industrial', 'public']
HEIGHT_SOURCES = ['landmark', 'osm-height', 'osm-levels', 'overture-height', 'overture-floors',
                  'globfp', 'globfp-overlap', 'estimate']

RESIDENTIAL = {'residential', 'apartments', 'house', 'dormitory', 'detached', 'terrace', 'semidetached_house'}
COMMERCIAL = {'commercial', 'office', 'retail', 'hotel', 'supermarket', 'mall'}
INDUSTRIAL = {'industrial', 'warehouse', 'factory', 'manufacture', 'storage_tank'}
PUBLIC = {'school', 'university', 'college', 'hospital', 'public', 'civic', 'government', 'train_station',
          'kindergarten', 'stadium', 'sports_centre', 'museum', 'library', 'education', 'medical',
          'transportation', 'religious', 'entertainment'}


def _num(value):
    if value is None:
        return None
    m = re.match(r'^\s*([0-9]+(?:\.[0-9]+)?)', str(value))
    return float(m.group(1)) if m else None


def _category(kind):
    if not kind:
        return 'unknown'
    kind = kind.lower()
    if kind in RESIDENTIAL:
        return 'residential'
    if kind in COMMERCIAL:
        return 'commercial'
    if kind in INDUSTRIAL:
        return 'industrial'
    if kind in PUBLIC:
        return 'public'
    return 'unknown'


def _to_local(geom):
    return transform(lambda x, y, z=None: project(x, y), geom)


def _polygons(geom):
    geom = make_valid(geom)
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, 'geoms', []) if isinstance(g, Polygon)]


def ensure_globfp():
    if GLOBFP_SZ.exists():
        return
    shp = {
        '2265': '2265_113.75_22.5_115.0_23.75_HKMacauCN_guangdongCN.shp',
        '2269': '2269_112.5_20.0_115.0_22.5_HKMacauCN_guangdongCN.shp',
    }
    reads = ' UNION ALL '.join(
        f"SELECT * FROM ST_Read('/vsizip/{GLOBFP_DIR / (k + '.zip')}/{v}')" for k, v in shp.items())
    sql = (
        "INSTALL spatial; LOAD spatial; "
        f"COPY (SELECT Height, ST_AsGeoJSON(geom) AS g FROM ({reads}) "
        "WHERE ST_XMin(geom) < 114.135 AND ST_XMax(geom) > 113.88 AND ST_YMin(geom) < 22.60 AND ST_YMax(geom) > 22.455) "
        f"TO '{GLOBFP_SZ}' (FORMAT JSON);"
    )
    subprocess.run(['duckdb', '-c', sql], check=True)


def load_globfp(clip_local):
    ensure_globfp()
    polys, heights = [], []
    with GLOBFP_SZ.open() as f:
        for line in f:
            rec = json.loads(line)
            h = rec.get('Height')
            if not h or h <= 0:
                continue
            g = rec['g']
            geom = _to_local(shape(json.loads(g) if isinstance(g, str) else g))
            if not geom.intersects(clip_local):
                continue
            for p in _polygons(geom):
                polys.append(p)
                heights.append(float(h))
    return polys, heights


def load_landmark_bindings():
    data = json.loads(LANDMARKS.read_text())
    bindings = {}
    for lm in data['landmarks']:
        heights = lm.get('heights', {})
        parts = {}

        def walk(prefix, value):
            if isinstance(value, str):
                parts[value] = prefix
            elif isinstance(value, list):
                for v in value:
                    walk(prefix, v)
            elif isinstance(value, dict):
                for k, v in value.items():
                    walk(k, v)

        walk('site', lm.get('osm', {}))
        for osm_id, part in parts.items():
            h = heights.get(part)
            if h is None and part in ('building', 'tower') and 'heightM' in lm:
                h = lm['heightM']
            bindings[osm_id] = {'landmark': lm['id'], 'part': part, 'height': h}
    return bindings


def _estimate(category, area, rng):
    if category == 'industrial':
        base = 14 if area < 3000 else 20
    elif category == 'residential':
        base = 18 if area < 250 else (36 if area < 600 else 90)
    elif category == 'commercial':
        base = 24 if area < 800 else 60
    elif category == 'public':
        base = 18
    else:
        base = 9 if area < 120 else (15 if area < 400 else (24 if area < 1500 else 30))
    return round(base * rng.uniform(0.8, 1.25), 1)


def _facade(category, height, area, landmark):
    if landmark:
        return 'landmark'
    if category == 'industrial':
        return 'industrial'
    if category == 'public':
        return 'public'
    if category == 'commercial':
        return 'glass_tower' if height >= 60 else 'office'
    if category == 'residential':
        if height >= 40:
            return 'residential_tower'
        return 'village' if area < 300 else 'residential_low'
    if height >= 80:
        return 'glass_tower'
    if height >= 40:
        return 'residential_tower'
    if area < 260 and height < 30:
        return 'village'
    return 'office' if area > 1500 else 'residential_low'


def build_buildings(osm, clip_local, report):
    bindings = load_landmark_bindings()
    records = []

    for b in osm['buildings']:
        t = b['tags']
        geom = _to_local(b['geom'])
        for poly in _polygons(geom.intersection(clip_local)):
            if poly.area < MIN_AREA:
                continue
            records.append({
                'id': b['id'], 'geom': poly, 'src': 'osm',
                'kind': t.get('building') or t.get('building:part'),
                'height': _num(t.get('height')), 'levels': _num(t.get('building:levels')),
                'minHeight': _num(t.get('min_height')) or 0.0, 'name': t.get('name'),
                'isPart': 'building:part' in t,
            })
    report['osmBuildings'] = len(records)

    # 有 building:part 的建筑外框只留部件，避免外框和部件叠在一起
    part_tree = STRtree([r['geom'] for r in records if r['isPart']])
    part_geoms = [r['geom'] for r in records if r['isPart']]
    part_records = [r for r in records if r['isPart']]
    kept = []
    for r in records:
        if not r['isPart'] and part_geoms:
            idx = part_tree.query(r['geom'], predicate='intersects')
            covered = sum(part_geoms[i].intersection(r['geom']).area for i in idx)
            if covered > 0.5 * r['geom'].area:
                # 外框被部件替代时，地标身份交给落在外框里的部件
                if r['id'] in bindings:
                    for i in idx:
                        if part_geoms[i].representative_point().within(r['geom']):
                            part_records[i].setdefault('parentId', r['id'])
                continue
        kept.append(r)
    records = kept

    osm_tree = STRtree([r['geom'] for r in records])
    osm_geoms = [r['geom'] for r in records]
    dropped = added = 0
    with OVERTURE.open() as f:
        for line in f:
            rec = json.loads(line)
            if rec.get('is_underground'):
                continue
            geom = _to_local(shape(rec['geom']))
            if not geom.intersects(clip_local):
                continue
            for poly in _polygons(geom.intersection(clip_local)):
                if poly.area < MIN_AREA:
                    continue
                idx = osm_tree.query(poly, predicate='intersects')
                if any(osm_geoms[i].intersection(poly).area > 0.25 * poly.area for i in idx):
                    dropped += 1
                    continue
                records.append({
                    'id': 'overture/' + rec['id'], 'geom': poly, 'src': 'overture',
                    'kind': rec.get('subtype') or rec.get('class'),
                    'oHeight': rec.get('height'), 'oFloors': rec.get('num_floors'),
                    'minHeight': 0.0, 'name': (rec.get('name') or None), 'isPart': False,
                })
                added += 1
    report['overtureAdded'] = added
    report['overtureDuplicates'] = dropped

    gb_polys, gb_heights = load_globfp(clip_local)
    gb_tree = STRtree(gb_polys)
    report['globfpCandidates'] = len(gb_polys)

    # GloBFP 里和现有轮廓基本不重叠的，作为补充建筑（城中村等 OSM 和 Overture 漏掉的楼）
    all_tree = STRtree([r['geom'] for r in records])
    all_geoms = [r['geom'] for r in records]
    gb_added = 0
    for i, g in enumerate(gb_polys):
        if g.area < 30:
            continue
        idx = all_tree.query(g, predicate='intersects')
        if sum(all_geoms[j].intersection(g).area for j in idx) > 0.15 * g.area:
            continue
        clipped = g.intersection(clip_local)
        if clipped.area < 30:
            continue
        records.append({
            'id': f'globfp/{i}', 'geom': clipped, 'src': 'globfp', 'kind': None,
            'gbHeight': gb_heights[i], 'minHeight': 0.0, 'name': None, 'isPart': False,
        })
        gb_added += 1
    report['globfpAdded'] = gb_added

    rng = random.Random(20261118)
    out = []
    counts = {s: 0 for s in HEIGHT_SOURCES}
    for r in records:
        pieces = _polygons(r['geom'].simplify(0.3, preserve_topology=True))
        if not pieces:
            continue
        poly = max(pieces, key=lambda p: p.area)
        if poly.area < MIN_AREA:
            continue
        area = poly.area
        category = _category(r.get('kind'))
        binding = bindings.get(r['id'])
        if binding is None and r.get('parentId'):
            parent = bindings[r['parentId']]
            binding = {'landmark': parent['landmark'], 'part': 'part',
                       'height': None if (r.get('height') or r.get('levels')) else parent['height']}
        height = source = None
        if binding and binding['height']:
            height, source = binding['height'], 'landmark'
        elif r.get('height'):
            height, source = r['height'], 'osm-height'
        elif r.get('levels'):
            height, source = r['levels'] * LEVEL_HEIGHT, 'osm-levels'
        elif r.get('oHeight'):
            height, source = float(r['oHeight']), 'overture-height'
        elif r.get('oFloors'):
            height, source = float(r['oFloors']) * LEVEL_HEIGHT, 'overture-floors'
        elif r.get('gbHeight'):
            height, source = r['gbHeight'], 'globfp'
        else:
            idx = gb_tree.query(poly, predicate='intersects')
            best = None
            overlap_h = overlap_a = 0.0
            for i in idx:
                g = gb_polys[i]
                inter = g.intersection(poly).area
                if inter <= 0:
                    continue
                overlap_h += gb_heights[i] * inter
                overlap_a += inter
                iou = inter / g.union(poly).area
                ratio = min(g.area, area) / max(g.area, area)
                dist = g.centroid.distance(poly.centroid)
                if iou >= 0.6 and ratio >= 0.65 and dist <= 12 and (best is None or iou > best[0]):
                    best = (iou, gb_heights[i])
            if best:
                height, source = best[1], 'globfp'
            elif overlap_a >= 0.5 * area:
                height, source = overlap_h / overlap_a, 'globfp-overlap'
        if not height or height < 2.5:
            height, source = _estimate(category, area, rng), 'estimate'
        height = min(height, 650.0)
        counts[source] += 1
        landmark = binding['landmark'] if binding else None
        out.append({
            'id': r['id'], 'poly': poly, 'height': round(height, 1),
            'minHeight': round(min(r.get('minHeight', 0.0), height - 1), 1),
            'category': category, 'facade': _facade(category, height, area, landmark),
            'heightSource': source, 'landmark': landmark, 'name': r.get('name'),
        })
    report['buildings'] = len(out)
    report['heightSources'] = counts
    found = sorted({b['landmark'] for b in out if b['landmark']})
    expected = sorted({v['landmark'] for v in bindings.values()})
    report['landmarkBuildingsBound'] = found
    report['landmarksWithoutBuilding'] = [x for x in expected if x not in found]
    return out
