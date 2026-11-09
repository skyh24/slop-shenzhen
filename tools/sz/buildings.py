"""合并 OSM 和 Overture 建筑轮廓，按优先级确定楼高，并给出用途和立面类型。"""

import json
import math
import random
import re
import subprocess
from pathlib import Path

from shapely import STRtree
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.ops import transform
from shapely.validation import make_valid

from building_parent_review import apply_reviewed_building_parent_uses
from geo import project

ROOT = Path(__file__).resolve().parents[2]
OVERTURE = ROOT / 'data/raw/overture/buildings-2026-10-21.0.jsonl'
GLOBFP_DIR = ROOT / 'data/raw/globfp'
GLOBFP_SZ = GLOBFP_DIR / 'globfp-sz.jsonl'
LANDMARKS = ROOT / 'data/source/landmarks.json'
FOOTPRINT_REVIEWS = ROOT / 'data/source/building-footprint-reviews.json'
HEIGHT_OVERRIDES = ROOT / 'data/source/building-height-overrides.json'

LEVEL_HEIGHT = 3.2
MIN_AREA = 16.0
ESTIMATE_SEED = 20261118
UNDERGROUND_TAGS = ('name', 'building', 'building:part', 'building:levels', 'building:levels:underground',
                    'layer', 'location', 'height', 'min_height')

# 立面类型编号，和 js/sz-mvp/buildings.js 的 FACADE 表一一对应
FACADES = ['glass_tower', 'office', 'residential_tower', 'residential_low', 'village', 'industrial', 'public', 'landmark']
CATEGORIES = ['unknown', 'residential', 'commercial', 'industrial', 'public']
HEIGHT_SOURCES = ['landmark', 'osm-height', 'osm-levels', 'overture-height', 'overture-floors',
                  'globfp', 'globfp-overlap', 'estimate', 'published']

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


def _metres(value):
    match = re.fullmatch(r'\s*([0-9]+(?:\.[0-9]+)?)\s*(?:m\s*)?', str(value))
    number = float(match.group(1)) if match else None
    return number if number is not None and math.isfinite(number) else None


def _vertical_conflict(min_height, height):
    if min_height >= height:
        return 'minimum-not-below-top'
    if round(min_height, 1) >= round(height, 1):
        return 'interval-collapses-at-decimetre-precision'
    return None


def _underground_reason(tags):
    location = tags.get('location')
    if location == 'underground':
        return 'location-underground'
    levels = tags.get('building:levels', '').strip()
    zero_levels = re.fullmatch(r'0(?:\.0+)?', levels) is not None
    # 地下层数可以与地上体量共存，负 layer 只表示相对上下关系。
    if ((levels and not zero_levels) or (_num(tags.get('height')) or 0) > 0
            or (_num(tags.get('min_height')) or 0) > 0):
        return None
    if zero_levels and location not in ('surface', 'overground', 'roof'):
        if (_num(tags.get('building:levels:underground')) or 0) > 0:
            return 'zero-levels-with-underground-floors'
        if re.fullmatch(r'-[1-9]\d*', tags.get('layer', '').strip()):
            return 'zero-levels-with-negative-layer'
    return None


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


def load_height_overrides(path=HEIGHT_OVERRIDES):
    """读取逐个核实的楼高覆盖。没有文件时返回空表，不因缺文件改变默认生成结果。"""
    if not Path(path).exists():
        return {}
    data = json.loads(Path(path).read_text())
    if data.get('version') != 1:
        raise ValueError('Unsupported building height override version')
    overrides = {}
    for entry in data.get('entries', []):
        osm_id = entry.get('osmId')
        height = entry.get('heightM')
        if not isinstance(osm_id, str) or not osm_id or not isinstance(height, (int, float)) or height <= 0:
            raise ValueError(f'Invalid building height override: {entry}')
        if not entry.get('sources'):
            raise ValueError(f'Building height override has no sources: {osm_id}')
        overrides[osm_id] = {**entry, 'heightM': float(height)}
    return overrides


def ensure_globfp():
    if GLOBFP_SZ.exists():
        return
    shp = {
        '2265': '2265_113.75_22.5_115.0_23.75_HKMacauCN_guangdongCN.shp',
        '2269': '2269_112.5_20.0_115.0_22.5_HKMacauCN_guangdongCN.shp',
    }
    reads = ' UNION ALL '.join(
        f"SELECT 'globfp-{k}' AS sourceId, OGC_FID, Height, geom "
        f"FROM ST_Read('/vsizip/{GLOBFP_DIR / (k + '.zip')}/{v}')" for k, v in shp.items())
    sql = (
        "INSTALL spatial; LOAD spatial; "
        f"COPY (SELECT sourceId, OGC_FID, Height, ST_AsGeoJSON(geom) AS g FROM ({reads}) "
        "WHERE ST_XMin(geom) < 114.135 AND ST_XMax(geom) > 113.88 AND ST_YMin(geom) < 22.60 AND ST_YMax(geom) > 22.455) "
        f"TO '{GLOBFP_SZ}' (FORMAT JSON);"
    )
    subprocess.run(['duckdb', '-c', sql], check=True)


def load_globfp(clip_local, report):
    ensure_globfp()
    manifest = json.loads(FOOTPRINT_REVIEWS.read_text())
    if manifest['version'] != 1:
        raise ValueError('Unsupported building footprint review version')
    reviews = [entry for entry in manifest['globfpExclusions']
               if _to_local(box(*entry['bboxWgs84'])).intersects(clip_local)]
    polys, heights = [], []
    excluded = set()
    audit = []
    matched = set()
    with GLOBFP_SZ.open() as f:
        for line in f:
            rec = json.loads(line)
            h = rec.get('Height')
            if not h or h <= 0:
                continue
            g = rec['g']
            geographic = shape(json.loads(g) if isinstance(g, str) else g)
            geom = _to_local(geographic)
            if not geom.intersects(clip_local):
                continue
            fid = rec.get('OGC_FID')
            tile = rec.get('sourceId')
            review = next((entry for entry in reviews if (tile is None or tile == entry['sourceId'])
                           and (fid is None or fid == entry['sourceFid'])
                           and all(abs(a - b) < 1e-7 for a, b in zip(geographic.bounds, entry['bboxWgs84']))), None)
            if review:
                identity = (review['sourceId'], review['sourceFid'])
                if identity in matched or abs(h - review['rawHeightM']) > 1e-3:
                    raise ValueError(f'Reviewed GloBFP footprint has conflicting source records: {identity}')
                matched.add(identity)
            for p in _polygons(geom):
                index = len(polys)
                polys.append(p)
                heights.append(float(h))
                # 保留源序号。排除项同时退出补充楼体和其他楼的高度回填。
                if review:
                    excluded.add(index)
                    match = 'legacy-bounds-and-height' if fid is None else 'source-fid-and-bounds'
                    if tile is not None and fid is not None:
                        match = 'source-tile-fid-and-bounds'
                    audit.append({**review, 'id': f'globfp/{index}', 'heightSource': 'globfp',
                                  'match': match})
    missing = {(entry['sourceId'], entry['sourceFid']) for entry in reviews} - matched
    if missing:
        raise ValueError(f'Reviewed GloBFP footprints missing: {sorted(missing)}')
    report['excludedGlobfpFootprints'] = audit
    return polys, heights, excluded


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


def _estimate(category, area, identity):
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
    rng = random.Random(f'{ESTIMATE_SEED}:{identity}')
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


def build_buildings(osm, clip_local, report, *, reviewed_parent_uses=True, height_overrides=None):
    bindings = load_landmark_bindings()
    overrides = load_height_overrides() if height_overrides is None else height_overrides
    records = []
    underground = []
    vertical_conflicts = []
    withheld_footprints = []

    for b in osm['buildings']:
        t = b['tags']
        geom = _to_local(b['geom'])
        polygons = [p for p in _polygons(geom.intersection(clip_local)) if p.area >= MIN_AREA]
        if not polygons:
            continue
        reason = _underground_reason(t)
        if reason:
            entry = {'id': b['id'], 'reason': reason, 'tags': {key: t[key] for key in UNDERGROUND_TAGS if key in t}}
            if b['id'] in bindings:
                entry['landmark'] = bindings[b['id']]['landmark']
            # 正尺寸没有提供地上几何的证据，保留异义标签供复核。
            conflicts = {key: t[key] for key in ('building:levels', 'height', 'min_height') if (_num(t.get(key)) or 0) > 0}
            if conflicts:
                entry['conflicts'] = conflicts
            underground.append(entry)
            continue
        height, min_height, vertical_tags = _num(t.get('height')), 0.0, None
        if 'min_height' in t:
            vertical_tags = {key: t[key] for key in ('height', 'min_height') if key in t}
            height, min_height = _metres(t.get('height')), _metres(t['min_height'])
            if min_height is None or ('height' in t and height is None):
                reason = 'unresolved-explicit-metres'
            else:
                reason = _vertical_conflict(min_height, height) if height is not None else None
            if reason:
                # 异常部件不顶替父楼。保留轮廓用于去重，避免同一体量由遥感数据重新填实。
                vertical_conflicts.append({'id': b['id'], 'reason': reason, 'scope': 'osm-tags',
                                           'tags': vertical_tags, 'polygons': len(polygons)})
                withheld_footprints.extend(polygons)
                continue
        for poly in polygons:
            records.append({
                'id': b['id'], 'geom': poly, 'src': 'osm',
                'kind': t.get('building') or t.get('building:part'),
                'buildingType': t.get('building'), 'buildingPartType': t.get('building:part'),
                'explicitUse': t.get('building:use'),
                'height': height, 'levels': _num(t.get('building:levels')),
                'minHeight': min_height, 'verticalTags': vertical_tags, 'name': t.get('name'),
                'isPart': 'building:part' in t,
            })
    report['osmBuildings'] = len(records)
    report['excludedUndergroundBuildings'] = underground

    if reviewed_parent_uses:
        apply_reviewed_building_parent_uses(records, report)
    else:
        report['reviewedBuildingParentUses'] = {'status': 'disabled-for-comparison'}

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
                # 部件通常不带名称；名称标牌需要父楼名字，只做显示用的继承。
                if (r.get('name') or '').strip():
                    for i in idx:
                        if part_geoms[i].representative_point().within(r['geom']):
                            part_records[i].setdefault('name', r['name'])
                continue
        kept.append(r)
    records = kept

    osm_geoms = [r['geom'] for r in records] + withheld_footprints
    osm_tree = STRtree(osm_geoms)
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

    gb_polys, gb_heights, gb_excluded = load_globfp(clip_local, report)
    gb_tree = STRtree(gb_polys)
    report['globfpCandidates'] = len(gb_polys)

    # GloBFP 里和现有轮廓基本不重叠的，作为补充建筑（城中村等 OSM 和 Overture 漏掉的楼）
    all_geoms = [r['geom'] for r in records] + withheld_footprints
    all_tree = STRtree(all_geoms)
    gb_added = 0
    for i, g in enumerate(gb_polys):
        if i in gb_excluded or g.area < 30:
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

    out = []
    min_height_corrections = []
    applied_overrides = []
    matched_overrides = set()
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
                if i in gb_excluded:
                    continue
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
            height, source = _estimate(category, area, r['id']), 'estimate'
        override = overrides.get(r['id'])
        if override:
            matched_overrides.add(r['id'])
            applied_overrides.append({
                'id': r['id'], 'name': override.get('name'),
                'previousHeightM': round(height, 1), 'previousHeightSource': source,
                'heightM': override['heightM'], 'sources': override['sources'],
                'verifiedAt': override.get('verifiedAt'), 'note': override.get('note'),
            })
            height, source = override['heightM'], 'published'
        height = min(height, 650.0)
        min_height = r.get('minHeight', 0.0)
        reason = _vertical_conflict(min_height, height)
        if reason:
            vertical_conflicts.append({'id': r['id'], 'reason': reason, 'scope': 'resolved-top',
                                       'tags': r.get('verticalTags'), 'heightM': height, 'heightSource': source})
            continue
        rounded_min = round(min_height, 1)
        if r.get('verticalTags'):
            previous_min = round(min(min_height, height - 1), 1)
            if rounded_min != previous_min:
                min_height_corrections.append({'id': r['id'], 'tags': r['verticalTags'], 'heightSource': source,
                                               'heightM': round(height, 1), 'minHeightM': rounded_min,
                                               'previousMinHeightM': previous_min})
        counts[source] += 1
        landmark = binding['landmark'] if binding else None
        # 层数只作立面节奏与标牌位置的参考；缺失时写 -1，不反推楼高。
        levels = r.get('levels') or r.get('oFloors') or -1
        out.append({
            'id': r['id'], 'poly': poly, 'height': round(height, 1),
            'minHeight': rounded_min,
            'category': category, 'facade': _facade(category, height, area, landmark),
            'heightSource': source, 'landmark': landmark,
            'name': (r.get('name') or '').strip() or None,
            'levels': int(round(levels)) if levels and levels > 0 else -1,
        })
    report['buildings'] = len(out)
    report['heightSources'] = counts
    report['buildingMinHeightCorrections'] = min_height_corrections
    report['excludedBuildingVerticalBounds'] = vertical_conflicts
    report['heightEstimate'] = {'method': 'category-area-seeded-jitter', 'seed': ESTIMATE_SEED, 'seedBy': 'building-id'}
    report['buildingHeightOverrides'] = {
        'source': str(HEIGHT_OVERRIDES.relative_to(ROOT)),
        'applied': applied_overrides,
        'unused': sorted(set(overrides) - matched_overrides),
    }
    found = sorted({b['landmark'] for b in out if b['landmark']})
    expected = sorted({v['landmark'] for v in bindings.values()})
    report['landmarkBuildingsBound'] = found
    report['landmarksWithoutBuilding'] = [x for x in expected if x not in found]
    return out
