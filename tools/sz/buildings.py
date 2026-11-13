"""合并 OSM 和 Overture 建筑轮廓，按优先级确定楼高，并给出用途和立面类型。"""

import hashlib
import json
import math
import random
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from shapely import STRtree
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform, unary_union
from shapely.validation import make_valid

from building_parent_review import apply_reviewed_building_parent_uses
from geo import LEGACY_PHASE1_BOXES, phase1_clip_local, project
from package_validation import verify_sources
from roads import CLASS_OF, DEFAULT_WIDTH, LANE_WIDTH

ROOT = Path(__file__).resolve().parents[2]
GLOBFP_DIR = ROOT / 'data/raw/globfp'
GLOBFP_SHP = {
    'globfp-2265': '2265_113.75_22.5_115.0_23.75_HKMacauCN_guangdongCN.shp',
    'globfp-2269': '2269_112.5_20.0_115.0_22.5_HKMacauCN_guangdongCN.shp',
}
# 提取条件变化时更新版本，以免复用旧 JSONL。
GLOBFP_EXTRACT_VERSION = 1
LANDMARKS = ROOT / 'data/source/landmarks.json'
FOOTPRINT_REVIEWS = ROOT / 'data/source/building-footprint-reviews.json'
HEIGHT_OVERRIDES = ROOT / 'data/source/building-height-overrides.json'

LEVEL_HEIGHT = 3.2
MIN_AREA = 16.0
ESTIMATE_SEED = 20261118
UNDERGROUND_TAGS = ('name', 'building', 'building:part', 'building:levels', 'building:levels:underground',
                    'layer', 'location', 'height', 'min_height')

# 卫星轮廓误识别过滤阈值，规则见 docs/02-DATA-PIPELINE.md 第 4 节
MISIDENTIFIED_MAX_AREA = 300.0
PLAZA_GREEN_SHARE = 0.6
CARRIAGEWAY_SHARE = 0.8
CARRIAGEWAY_BUFFER = 1.0
MISIDENTIFIED_REPORT_LIMIT = 300
# 补充轮廓占道暂缓门槛，见 docs/23-BUILDING-AND-STREET-PLAN.md 第 3 节
ROAD_OVERLAP_SHARE = 0.5
ROAD_CENTERLINE_MIN_LENGTH = 0.5

# 立面类型编号，和 js/sz-materials.js 的 FACADE_PROFILES 顺序一一对应
FACADES = ['glass_tower', 'office', 'residential_tower', 'residential_low', 'village', 'industrial', 'public', 'landmark']
CATEGORIES = ['unknown', 'residential', 'commercial', 'industrial', 'public']
HEIGHT_SOURCES = ['landmark', 'osm-height', 'osm-levels', 'overture-height', 'overture-floors',
                  'globfp', 'estimate', 'published']

# 23 号第 3 节的建筑记录字段：角色、上游族、分项可信度
ROLES = ['main', 'podium', 'canopy', 'bridge', 'unknown']
UPSTREAM_FAMILIES = ['osm', 'overture-eastasia', 'globfp-eastasia', 'eastasia-shared', 'unknown']
CONFIDENCE_LEVELS = ['unknown', 'low', 'medium', 'high']
# 高度来源到可信度的固定映射；只有 published 是个案核实值
HEIGHT_CONFIDENCE = {'landmark': 'medium', 'osm-height': 'medium', 'osm-levels': 'medium',
                     'overture-height': 'medium', 'overture-floors': 'medium',
                     'globfp': 'low', 'estimate': 'low', 'published': 'high'}
BRIDGE_TYPES = {'bridge'}
CANOPY_TYPES = {'roof', 'canopy', 'carport', 'awning', 'shelter', 'roofing'}

REMOTE_FOOTPRINT_PREFIXES = ('overture/', 'globfp/')

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


def _local_areas(entries, clip_local):
    """把 OSM 缓存里的经纬度面转成局部米制坐标，供误识别过滤使用。"""
    out = []
    for entry in entries:
        geom = _to_local(entry['geom']).intersection(clip_local)
        if geom.is_empty:
            continue
        out.append({'id': entry.get('id'), 'geom': geom})
    return out


def _road_half_width(tags):
    """车行道半宽：优先 OSM width，其次车道数，最后按道路等级取默认值。"""
    width = _num(tags.get('width'))
    if width and width > 0:
        return width / 2
    lanes = _num(tags.get('lanes'))
    if lanes and lanes >= 1:
        return lanes * LANE_WIDTH / 2
    return DEFAULT_WIDTH.get(CLASS_OF.get(tags.get('highway')), 7.0) / 2


def _local_carriageways(entries):
    """只取地表车行道；桥面和隧道不代表地面轮廓所在的铺装。"""
    out = []
    for entry in entries:
        tags = entry.get('tags', {})
        if tags.get('bridge', 'no') not in ('no', 'false', '0'):
            continue
        if tags.get('tunnel', 'no') not in ('no', 'false', '0'):
            continue
        out.append({'id': entry.get('id'), 'geom': _to_local(entry['geom']),
                    'halfWidthM': _road_half_width(tags)})
    return out


def _indexed(entries):
    """统一 {id, geom} 和裸几何两种输入，返回条目列表和空间索引。"""
    items = []
    for entry in entries:
        if isinstance(entry, BaseGeometry):
            items.append({'id': None, 'geom': entry})
        else:
            items.append({**entry, 'id': entry.get('id')})
    geoms = [item['geom'] for item in items]
    return items, (STRtree(geoms) if geoms else None)


def _covered_share(polygon, items, tree):
    """多边形被索引面覆盖的比例和命中的来源 id；重叠面先求并集，避免重复计数。"""
    if tree is None:
        return 0.0, []
    pieces, ids = [], []
    for index in tree.query(polygon, predicate='intersects'):
        intersection = items[index]['geom'].intersection(polygon)
        if intersection.is_empty or intersection.area <= 0:
            continue
        pieces.append(intersection)
        identity = items[index]['id']
        if identity and identity not in ids:
            ids.append(identity)
    if not pieces:
        return 0.0, []
    return min(unary_union(pieces).area / polygon.area, 1.0), ids


def _carriageway_share(polygon, items, tree, buffer_m, buffers, reach):
    """多边形落在车行道范围（半宽 + 1 米浮动缓冲）内的比例；缓冲按道路惰性缓存。"""
    if tree is None:
        return 0.0, []
    pieces, ids = [], []
    for index in tree.query(polygon.buffer(reach), predicate='intersects'):
        buffered = buffers.get(index)
        if buffered is None:
            buffered = items[index]['geom'].buffer(items[index]['halfWidthM'] + buffer_m)
            buffers[index] = buffered
        intersection = polygon.intersection(buffered)
        if intersection.is_empty or intersection.area <= 0:
            continue
        pieces.append(intersection)
        identity = items[index]['id']
        if identity and identity not in ids:
            ids.append(identity)
    if not pieces:
        return 0.0, []
    return min(unary_union(pieces).area / polygon.area, 1.0), ids


def filter_misidentified_footprints(candidates, plaza_geoms, green_geoms, road_lines, report, *,
                                    counterpart_geoms=(), max_area_m2=MISIDENTIFIED_MAX_AREA,
                                    plaza_green_share=PLAZA_GREEN_SHARE,
                                    carriageway_share=CARRIAGEWAY_SHARE, buffer_m=CARRIAGEWAY_BUFFER,
                                    report_key='globfpMisidentified', source_label='GloBFP-only'):
    """按 docs/02-DATA-PIPELINE.md 第 4 节的规则筛掉只来自某个补充来源（GloBFP 或 Overture）的广场设施/路面误识别轮廓。

    输入几何都是局部米制坐标。candidates 是某一补充来源的候选（GlobFP 或 Overture）；
    counterpart_geoms 为已有对照轮廓，命中即保留，绝不因为误识别规则丢掉有对照的楼。
    返回 (kept, dropped)，所有丢弃项连同原因写进 report[report_key]，不静默丢对象。
    GlobFP 和 Overture 两条补充路径共用这份规则，用 report_key / source_label 区分报告段落。
    """
    plaza_items, plaza_tree = _indexed(plaza_geoms)
    green_items, green_tree = _indexed(green_geoms)
    surface_items, surface_tree = _indexed(plaza_items + green_items)
    road_items, road_tree = _indexed(road_lines)
    _counterpart_items, counterpart_tree = _indexed(counterpart_geoms)
    # 查询半径只和道路总最大半宽有关，循环外算一次，否则每个候选都要扫一遍全部道路
    road_reach = max((item['halfWidthM'] for item in road_items), default=0.0) + buffer_m
    road_buffers = {}
    kept, dropped = [], []
    for candidate in candidates:
        polygon = candidate['geom']
        area = polygon.area
        if area >= max_area_m2:
            kept.append(candidate)
            continue
        # numpy 数组不能用布尔判断（索引 0 会被当成 False），按长度判断是否命中
        if counterpart_tree is not None and len(counterpart_tree.query(polygon, predicate='intersects')) > 0:
            kept.append(candidate)
            continue
        surface_share, surface_ids = _covered_share(polygon, surface_items, surface_tree)
        plaza_share, _ = _covered_share(polygon, plaza_items, plaza_tree)
        green_share, _ = _covered_share(polygon, green_items, green_tree)
        reasons = []
        if surface_share >= plaza_green_share:
            if plaza_share >= plaza_green_share:
                reasons.append('plaza')
            if green_share >= plaza_green_share:
                reasons.append('green')
            if not reasons:
                reasons.append('plaza-green')
        road_share, road_ids = _carriageway_share(polygon, road_items, road_tree, buffer_m, road_buffers, road_reach)
        if road_share >= carriageway_share:
            reasons.append('carriageway')
        if not reasons:
            kept.append(candidate)
            continue
        labels = [f'plaza-or-green:{identity}' for identity in surface_ids[:4]]
        labels += [f'road:{identity}' for identity in road_ids[:4]]
        dropped.append({'id': candidate.get('id'), 'areaM2': round(area, 1),
                        'reason': '+'.join(reasons), 'inside': labels})
    report[report_key] = {
        'rule': (f'{source_label}, area<{max_area_m2:g} m2, and (>= {plaza_green_share:.0%} inside OSM plaza/green '
                 f'or >= {carriageway_share:.0%} inside ground carriageway buffer {buffer_m:g} m)'),
        'count': len(dropped),
        'areaM2': round(sum(item['areaM2'] for item in dropped), 1),
        'objects': dropped[:MISIDENTIFIED_REPORT_LIMIT],
        'candidates': len(candidates),
        'kept': len(kept),
        'truncated': len(dropped) > MISIDENTIFIED_REPORT_LIMIT,
    }
    return kept, dropped


def _road_conflict(polygon, road_items, road_tree, road_buffers, road_reach):
    """判断轮廓是否占道：中心线穿入优先，其次看落在估算车行道半宽内的面积占比。

    几何都是局部米制；road_items 来自 _local_carriageways，宽度是估算值。
    返回 (road, reason) 或 None。OSM 已标注的楼只调用它做待核标记，不据此删除。
    """
    if road_tree is None:
        return None
    for index in road_tree.query(polygon, predicate='intersects'):
        road = road_items[index]
        if road['geom'].intersection(polygon).length > ROAD_CENTERLINE_MIN_LENGTH:
            return road, 'road-centerline'
    pieces, widest = [], None
    area = polygon.area
    if area <= 0:
        return None
    for index in road_tree.query(polygon.buffer(road_reach), predicate='intersects'):
        road = road_items[index]
        buffered = road_buffers.get(index)
        if buffered is None:
            # 只用估算半宽，不再额外加 1 米浮动缓冲
            buffered = road['geom'].buffer(road['halfWidthM'])
            road_buffers[index] = buffered
        intersection = polygon.intersection(buffered)
        if intersection.is_empty or intersection.area <= 0:
            continue
        pieces.append(intersection)
        if widest is None or intersection.area > widest[0]:
            widest = (intersection.area, road)
    share = min(unary_union(pieces).area / area, 1.0) if pieces else 0.0
    if share >= ROAD_OVERLAP_SHARE:
        return widest[1], 'road-carriageway'
    return None


def filter_road_conflicts(candidates, road_lines, report, *, report_key, source_label):
    """把落在估算车行道上的补充轮廓暂缓出正式场景，规则见 docs/23-BUILDING-AND-STREET-PLAN.md 第 3 节。

    输入几何都是局部米制坐标；road_lines 来自 _local_carriageways，宽度是估算值，不是实测。
    只给遥感补充来源（GloBFP 独有 / Overture 独有）用，OSM 已标注的楼不经过这里、永远不自动删。
    先看中心线是否穿入轮廓，再看轮廓落在车行道半宽内的面积占比，两个门槛都写进报告段。
    返回 (kept, deferred)；没有候选时也写报告段，避免结论被误读成“没有检查”。
    """
    road_items, road_tree = _indexed(road_lines)
    road_buffers = {}
    road_reach = max((item['halfWidthM'] for item in road_items), default=0.0)
    kept, deferred = [], []
    for candidate in candidates:
        polygon = candidate['geom']
        area = polygon.area
        hit = None if area <= 0 else _road_conflict(
            polygon, road_items, road_tree, road_buffers, road_reach)
        if hit is None:
            kept.append(candidate)
            continue
        road, reason = hit
        deferred.append({
            'id': candidate.get('id'), 'areaM2': round(area, 1), 'reason': reason,
            'roadId': road['id'], 'roadWidthM': round(2 * road['halfWidthM'], 1),
            'roadWidthSource': 'estimated', 'imageryChecked': False,
        })
    report[report_key] = {
        'rule': (f'{source_label}, supplemental footprints only: defer when a road centerline crosses '
                 f'more than {ROAD_CENTERLINE_MIN_LENGTH:g} m inside the footprint, or when at least '
                 f'{ROAD_OVERLAP_SHARE:.0%} of the footprint lies inside the estimated carriageway '
                 f'(road half width, no extra buffer); OSM-mapped buildings are never removed'),
        'roadWidthSource': 'estimated',
        'imageryChecked': False,
        'count': len(deferred),
        'areaM2': round(sum(item['areaM2'] for item in deferred), 1),
        'objects': deferred[:MISIDENTIFIED_REPORT_LIMIT],
        'candidates': len(candidates),
        'kept': len(kept),
        'truncated': len(deferred) > MISIDENTIFIED_REPORT_LIMIT,
    }
    return kept, deferred


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


def ensure_globfp(sources, use_cache=True):
    signature = [GLOBFP_EXTRACT_VERSION, [(key, sources[key]['sha256']) for key in GLOBFP_SHP]]
    digest = hashlib.sha256(json.dumps(signature).encode()).hexdigest()
    target = GLOBFP_DIR / f'globfp-sz-{digest}.jsonl'
    if use_cache and target.is_file():
        return target

    def sql_path(path):
        return str(path).replace("'", "''")

    reads = ' UNION ALL '.join(
        f"SELECT '{key}' AS sourceId, OGC_FID, Height, geom "
        f"FROM ST_Read('/vsizip/{sql_path(ROOT / sources[key]['file'])}/{member}')"
        for key, member in GLOBFP_SHP.items())
    GLOBFP_DIR.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=GLOBFP_DIR) as directory:
        temporary = Path(directory) / target.name
        sql = (
            "INSTALL spatial; LOAD spatial; "
            f"COPY (SELECT sourceId, OGC_FID, Height, ST_AsGeoJSON(geom) AS g FROM ({reads}) "
            "WHERE ST_XMin(geom) < 114.135 AND ST_XMax(geom) > 113.88 AND ST_YMin(geom) < 22.60 AND ST_YMax(geom) > 22.455) "
            f"TO '{sql_path(temporary)}' (FORMAT JSON);"
        )
        subprocess.run(['duckdb', '-c', sql], check=True)
        temporary.replace(target)
    return target


def load_globfp(clip_local, report, path=None, *, identities=None):
    if path is None:
        path = ensure_globfp({source['id']: source for source in verify_sources(source_ids=GLOBFP_SHP)})
    manifest = json.loads(FOOTPRINT_REVIEWS.read_text())
    if manifest['version'] != 1:
        raise ValueError('Unsupported building footprint review version')
    reviews = [entry for entry in manifest['globfpExclusions']
               if _to_local(box(*entry['bboxWgs84'])).intersects(clip_local)]
    legacy_clip = phase1_clip_local(LEGACY_PHASE1_BOXES)
    legacy_index = 0
    polys, heights = [], []
    excluded = set()
    audit = []
    matched = set()
    with path.open() as f:
        for line in f:
            rec = json.loads(line)
            h = rec.get('Height')
            if not h or h <= 0:
                continue
            g = rec['g']
            geographic = shape(json.loads(g) if isinstance(g, str) else g)
            geom = _to_local(geographic)
            parts = list(_polygons(geom))
            legacy = geom.intersects(legacy_clip)
            legacy_start = legacy_index
            if legacy:
                legacy_index += len(parts)
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
            for part_index, p in enumerate(parts):
                index = len(polys)
                if legacy:
                    building_id = f'globfp/{legacy_start + part_index}'
                elif tile is not None and fid is not None:
                    building_id = f'globfp/{tile}/{fid}/{part_index}'
                else:
                    building_id = f'globfp/extension/{index}'
                polys.append(p)
                heights.append(float(h))
                if identities is not None:
                    identities.append(building_id)
                # 保留源序号。排除项同时退出补充楼体和其他楼的高度回填。
                if review:
                    excluded.add(index)
                    match = 'legacy-bounds-and-height' if fid is None else 'source-fid-and-bounds'
                    if tile is not None and fid is not None:
                        match = 'source-tile-fid-and-bounds'
                    audit.append({**review, 'id': building_id, 'heightSource': 'globfp',
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
            if h is not None and lm.get('heightSource') == 'published':
                bindings[osm_id]['heightSource'] = 'published'
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


def _record_top(record):
    """记录自身顶面高度；没有显式高度或层数时返回 None，不反推。"""
    if record.get('height'):
        return record['height']
    if record.get('levels'):
        return record['levels'] * LEVEL_HEIGHT
    return None


def _record_role(record):
    """23 号第 3 节的角色：桥梁、雨棚优先；裙房只在被替换的外框内成立。"""
    if record.get('src') != 'osm':
        # 遥感补充轮廓没有角色证据，一律记未知
        return 'unknown'
    types = (record.get('buildingType'), record.get('buildingPartType'), record.get('explicitUse'))
    if any(value in BRIDGE_TYPES for value in types if value):
        return 'bridge'
    if any(value in CANOPY_TYPES for value in types if value):
        return 'canopy'
    if record.get('isPart'):
        parent_top = record.get('parentTop')
        own_top = _record_top(record)
        if (parent_top and own_top is not None and own_top <= 0.5 * parent_top
                and record['geom'].area >= 0.5 * record['parentArea']):
            return 'podium'
        return 'unknown'
    return 'main'


def _record_upstream(record, height_source):
    """上游族：Overture 轮廓借用 GloBFP 高度时同属一个上游，不算两次独立核实。"""
    src = record.get('src')
    if src == 'osm':
        return 'osm'
    if src == 'globfp':
        return 'globfp-eastasia'
    return 'eastasia-shared' if height_source == 'globfp' else 'overture-eastasia'


def _record_confidence(record, height_source):
    """分项可信度：轮廓按来源，高度按实际取值来源，年代只有 OSM 标注可追溯。"""
    src = record.get('src')
    if src == 'osm':
        era = 'medium'
    elif src == 'globfp':
        era = 'low'
    else:
        era = 'unknown'
    return {'footprint': 'medium' if src == 'osm' else 'low',
            'height': HEIGHT_CONFIDENCE[height_source], 'era': era}


def build_pending_review(buildings, road_lines, globfp_deferred, overture_deferred, size_mismatches):
    """23 号第 3 节的待核清单：同一 id 合并理由，计数保持全量，样本按固定配额截取。

    buildings 是最终进场景的记录；暂缓轮廓不在其中，只能从两条补充路径的 deferred 列表来。
    OSM 已标注的楼占道只登记待核、不删除，所以要从 buildings 里再查一遍。
    """
    road_items, road_tree = _indexed(road_lines)
    road_buffers = {}
    road_reach = max((item['halfWidthM'] for item in road_items), default=0.0)
    osm_kept = []
    for building in buildings:
        if building['id'].startswith(REMOTE_FOOTPRINT_PREFIXES):
            continue
        if _road_conflict(building['poly'], road_items, road_tree, road_buffers, road_reach):
            osm_kept.append({'id': building['id'], 'areaM2': round(building['poly'].area, 1),
                             'heightM': building['height'], 'heightSource': building['heightSource']})
    deferred = list(globfp_deferred) + list(overture_deferred)
    by_reason = {
        'road-conflict-deferred': len(deferred),
        'road-conflict-osm-kept': len(osm_kept),
        'height-source-size-mismatch': len(size_mismatches),
    }
    count = len({item['id'] for item in deferred} | {item['id'] for item in osm_kept}
                | {item['id'] for item in size_mismatches})
    # 配额：两条补充来源各取暂缓顺序前 50 条，其余两类各取记录顺序前 100 条；计数不受配额影响
    samples = [(item, 'road-conflict-deferred') for item in globfp_deferred[:50]]
    samples += [(item, 'road-conflict-deferred') for item in overture_deferred[:50]]
    samples += [(item, 'road-conflict-osm-kept') for item in osm_kept[:100]]
    samples += [(item, 'height-source-size-mismatch') for item in size_mismatches[:100]]
    objects, indexed = [], {}
    for item, reason in samples:
        identity = item['id']
        if identity in indexed:
            if reason not in indexed[identity]['reasons']:
                indexed[identity]['reasons'].append(reason)
            continue
        entry = {'id': identity, 'reasons': [reason], 'areaM2': item.get('areaM2'),
                 'heightM': item.get('heightM'), 'heightSource': item.get('heightSource')}
        indexed[identity] = entry
        objects.append(entry)
    return {
        'rule': ('ambiguous or deferred building records: road-conflict-deferred = supplemental footprints '
                 'kept out of the scene by the road gate; road-conflict-osm-kept = OSM-mapped buildings '
                 'overlapping the estimated carriageway that stay in the scene; '
                 'height-source-size-mismatch = no own height and GloBFP overlap of at least half the '
                 'footprint, but the strict same-building match failed (former globfp-overlap population); '
                 'counts are complete, samples use a fixed quota'),
        'count': count,
        'byReason': by_reason,
        'objects': objects,
        'truncated': count > len(objects),
    }


def build_buildings(osm, clip_local, report, *, reviewed_parent_uses=True, height_overrides=None,
                    include_remote_footprints=True, overture_path=None, globfp_path=None):
    bindings = load_landmark_bindings()
    overrides = load_height_overrides() if height_overrides is None else height_overrides
    report['remoteFootprints'] = {'enabled': include_remote_footprints}
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
                # 裙房判定要用父楼顶面和外框面积：顶面优先取核实过的地标高度。
                binding = bindings.get(r['id'])
                parent_top = binding['height'] if binding and binding['height'] else _record_top(r)
                parent_area = r['geom'].area
                for i in idx:
                    if not part_geoms[i].representative_point().within(r['geom']):
                        continue
                    part_records[i].setdefault('parentTop', parent_top)
                    part_records[i].setdefault('parentArea', parent_area)
                    # 外框被部件替代时，地标身份交给落在外框里的部件
                    if binding:
                        part_records[i].setdefault('parentId', r['id'])
                # 部件通常不带名称；名称标牌需要父楼名字，只做显示用的继承。
                if (r.get('name') or '').strip():
                    for i in idx:
                        if part_geoms[i].representative_point().within(r['geom']):
                            part_records[i].setdefault('name', r['name'])
                continue
        kept.append(r)
    records = kept

    # 误识别过滤共用的 OSM 面/线只转一次局部坐标，GlobFP 和 Overture 两条补充路径共用
    plaza_local = _local_areas(osm.get('plaza', []), clip_local)
    green_local = _local_areas(osm.get('green', []), clip_local)
    carriageways = _local_carriageways(osm.get('roads', []))

    osm_geoms = [r['geom'] for r in records] + withheld_footprints
    osm_tree = STRtree(osm_geoms)
    duplicates = 0
    overture_candidates = []
    if include_remote_footprints:
        if overture_path is None:
            overture_path = ROOT / verify_sources(source_ids=('overture-buildings',))[0]['file']
        with overture_path.open() as f:
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
                        duplicates += 1
                        continue
                    record = {
                        'id': 'overture/' + rec['id'], 'geom': poly, 'src': 'overture',
                        'kind': rec.get('subtype') or rec.get('class'),
                        'oHeight': rec.get('height'), 'oFloors': rec.get('num_floors'),
                        'minHeight': 0.0, 'name': (rec.get('name') or None), 'isPart': False,
                    }
                    records.append(record)
                    overture_candidates.append(record)
    report['overtureDuplicates'] = duplicates

    gb_identities = []
    gb_polys, gb_heights, gb_excluded = load_globfp(clip_local, report, globfp_path, identities=gb_identities)
    gb_tree = STRtree(gb_polys)
    report['globfpCandidates'] = len(gb_polys)

    # GloBFP 里和现有轮廓基本不重叠的，作为补充建筑（城中村等 OSM 和 Overture 漏掉的楼）
    all_geoms = [r['geom'] for r in records] + withheld_footprints
    all_tree = STRtree(all_geoms)
    gb_candidates = []
    for i, g in enumerate(gb_polys):
        if not include_remote_footprints:
            break
        if i in gb_excluded or g.area < 30:
            continue
        idx = all_tree.query(g, predicate='intersects')
        if sum(all_geoms[j].intersection(g).area for j in idx) > 0.15 * g.area:
            continue
        clipped = g.intersection(clip_local)
        if clipped.area < 30:
            continue
        gb_candidates.append({
            'id': gb_identities[i], 'geom': clipped, 'src': 'globfp', 'kind': None,
            'gbHeight': gb_heights[i], 'minHeight': 0.0, 'name': None, 'isPart': False,
        })
    # 只对 GloBFP 补充路径做误识别过滤；广场设施、车棚等不能生成楼体，全部列进构建报告
    kept_candidates, _dropped_candidates = filter_misidentified_footprints(
        gb_candidates, plaza_local, green_local, carriageways, report, counterpart_geoms=all_geoms,
    )
    # 再按占道门槛暂缓：暂缓对象不进场景，globfpAdded 只统计真正进场景的补充楼
    kept_candidates, gb_deferred = filter_road_conflicts(
        kept_candidates, carriageways, report,
        report_key='globfpRoadConflicts', source_label='GloBFP-only',
    )
    records.extend(kept_candidates)
    gb_added = len(kept_candidates)
    report['globfpAdded'] = gb_added

    # Overture-only 补充楼同样按 docs/02-DATA-PIPELINE.md 第 4 节的规则过滤广场设施/路面误识别；
    # 有 OSM 轮廓对照的楼一律保留（counterpart_geoms 只给 OSM，不含其他 Overture 轮廓）。
    # 放在 GlobFP 之后执行，GlobFP 候选的去重对照集仍是全部 Overture 补充记录，globfpMisidentified 口径不变。
    kept_overture, _dropped_overture = filter_misidentified_footprints(
        overture_candidates, plaza_local, green_local, carriageways, report,
        counterpart_geoms=osm_geoms,
        report_key='overtureMisidentified', source_label='Overture-only (no OSM building)',
    )
    # 同样的占道门槛；暂缓对象按对象身份从 records 里移除，overtureAdded 只统计进场景的楼
    kept_overture, overture_deferred = filter_road_conflicts(
        kept_overture, carriageways, report,
        report_key='overtureRoadConflicts', source_label='Overture-only (no OSM building)',
    )
    kept_overture_ids = {id(record) for record in kept_overture}
    records = [record for record in records
               if record.get('src') != 'overture' or id(record) in kept_overture_ids]
    report['overtureAdded'] = len(kept_overture)

    out = []
    min_height_corrections = []
    applied_overrides = []
    matched_overrides = set()
    counts = {s: 0 for s in HEIGHT_SOURCES}
    size_mismatches = []
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
        size_mismatch = False
        if binding and binding['height']:
            height, source = binding['height'], binding.get('heightSource', 'landmark')
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
            overlap_area = 0.0
            for i in idx:
                if i in gb_excluded:
                    continue
                g = gb_polys[i]
                inter = g.intersection(poly).area
                if inter <= 0:
                    continue
                overlap_area += inter
                iou = inter / g.union(poly).area
                ratio = min(g.area, area) / max(g.area, area)
                dist = g.centroid.distance(poly.centroid)
                # 只保留严格同楼匹配；尺寸不相称或中心偏离时不借高度，落到 estimate 或待核。
                if iou >= 0.6 and ratio >= 0.65 and dist <= 12 and (best is None or iou > best[0]):
                    best = (iou, gb_heights[i])
            if best:
                height, source = best[1], 'globfp'
            elif overlap_area >= 0.5 * area:
                # 原 globfp-overlap 后备覆盖过的那批楼：有 GloBFP 轮廓盖住一半以上但尺寸不相称，
                # 高度保持未知并进待核清单；不再按重叠面积加权继承高度。
                size_mismatch = True
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
        if size_mismatch:
            size_mismatches.append({'id': r['id'], 'areaM2': round(area, 1),
                                    'heightM': round(height, 1), 'heightSource': source})
        landmark = binding['landmark'] if binding else None
        # 层数只作立面节奏与标牌位置的参考；缺失时写 -1，不反推楼高。
        levels = r.get('levels') or r.get('oFloors') or -1
        confidence = _record_confidence(r, source)
        out.append({
            'id': r['id'], 'poly': poly, 'height': round(height, 1),
            'minHeight': rounded_min,
            'category': category, 'facade': _facade(category, height, area, landmark),
            'heightSource': source, 'landmark': landmark,
            'name': (r.get('name') or '').strip() or None,
            'levels': int(round(levels)) if levels and levels > 0 else -1,
            'role': _record_role(r), 'upstream': _record_upstream(r, source),
            'footprintConfidence': confidence['footprint'],
            'heightConfidence': confidence['height'], 'eraConfidence': confidence['era'],
        })
    # 遥感补充楼（Overture / GloBFP）质量过滤：这些楼不在地图上标注，只保留可信足迹。
    # 规则只作用于补充楼；OSM 已标注的楼永远保留。命中水面/湿地、公园深处或孤立小棚的
    # 足迹多半是树冠、围墙、临时建筑或遥感误检，删除并写报告，避免在空地上凭空出现楼。
    def is_remote(building):
        return building['id'].startswith(REMOTE_FOOTPRINT_PREFIXES)

    def cover_geoms(entries):
        out_geoms = []
        for entry in entries:
            try:
                geom = _to_local(entry['geom']).intersection(clip_local)
            except Exception:
                continue
            if not geom.is_empty:
                out_geoms.extend(_polygons(geom))
        return out_geoms

    cover = cover_geoms(osm.get('water', [])) + cover_geoms(osm.get('wetland', []))
    green_geoms = cover_geoms(osm.get('green', []))
    cover_tree = STRtree(cover)
    green_tree = STRtree(green_geoms)

    def cover_ratio(poly, tree, geoms):
        idx = tree.query(poly, predicate='intersects')
        if not len(idx) or poly.area <= 0:
            return 0.0
        return sum(geoms[i].intersection(poly).area for i in idx) / poly.area

    osm_polys = [building['poly'] for building in out if not is_remote(building)]
    osm_tree = STRtree(osm_polys)

    def nearest_osm_distance(poly):
        idx = osm_tree.query(poly.buffer(200), predicate='intersects')
        if not len(idx):
            return 999.0
        return min(poly.distance(osm_polys[i]) for i in idx)

    footprint_filter = {'waterOverlap': [], 'parkIsolated': [], 'smallIsolated': []}
    filtered = []
    for building in out:
        if not is_remote(building):
            filtered.append(building)
            continue
        poly = building['poly']
        water_ratio = cover_ratio(poly, cover_tree, cover)
        if water_ratio > 0.2:
            footprint_filter['waterOverlap'].append({'id': building['id'], 'areaM2': round(poly.area, 1),
                                                     'overlap': round(water_ratio, 2)})
            continue
        green_ratio = cover_ratio(poly, green_tree, green_geoms)
        distance = nearest_osm_distance(poly)
        # 大体积建筑即使落在绿地/公园里也保留，避免误删场馆、宿舍等真实建筑（与主分支 area>=300 口径一致）。
        if poly.area < 300 and green_ratio > 0.6 and distance > 60:
            footprint_filter['parkIsolated'].append({'id': building['id'], 'areaM2': round(poly.area, 1),
                                                     'greenOverlap': round(green_ratio, 2),
                                                     'osmDistanceM': round(distance, 1)})
            continue
        if poly.area < 60 and distance > 50:
            footprint_filter['smallIsolated'].append({'id': building['id'], 'areaM2': round(poly.area, 1),
                                                      'osmDistanceM': round(distance, 1)})
            continue
        filtered.append(building)
    out = filtered
    report['buildingFootprintFilter'] = {
        'rule': 'remote-added footprints only: water/wetland overlap >20%; green overlap >60% and >60m from OSM; '
                'area <60m2 and >50m from OSM',
        'removed': {key: len(value) for key, value in footprint_filter.items()},
        'removedTotal': sum(len(value) for value in footprint_filter.values()),
        'examples': footprint_filter,
    }

    counts = {source: 0 for source in HEIGHT_SOURCES}
    for building in out:
        counts[building['heightSource']] += 1
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
    # 两条补充路径的占道暂缓对象合成一段；对象列表不截断，每条自带来源，供人工逐条核对。
    deferred_objects = [{'source': 'globfp', **item} for item in gb_deferred]
    deferred_objects += [{'source': 'overture', **item} for item in overture_deferred]
    report['deferredFootprints'] = {
        'rule': ('supplemental GloBFP and Overture footprints only: defer when a road centerline crosses '
                 f'more than {ROAD_CENTERLINE_MIN_LENGTH:g} m inside the footprint, or when at least '
                 f'{ROAD_OVERLAP_SHARE:.0%} of the footprint lies inside the estimated carriageway '
                 '(road half width, no extra buffer); OSM-mapped buildings are never auto-removed'),
        'roadWidthSource': 'estimated',
        'imageryChecked': False,
        'count': len(deferred_objects),
        'areaM2': round(sum(item['areaM2'] for item in deferred_objects), 1),
        'bySource': {'globfp': len(gb_deferred), 'overture': len(overture_deferred)},
        'objects': deferred_objects,
        'truncated': False,
    }
    # 23 号第 3 节：记录分项统计和待核清单。暂缓对象不进场景，只在清单里留位置和理由。
    role_counts = {role: 0 for role in ROLES}
    upstream_counts = {family: 0 for family in UPSTREAM_FAMILIES}
    confidence_counts = {aspect: {level: 0 for level in CONFIDENCE_LEVELS}
                         for aspect in ('footprint', 'height', 'era')}
    for building in out:
        role_counts[building['role']] += 1
        upstream_counts[building['upstream']] += 1
        confidence_counts['footprint'][building['footprintConfidence']] += 1
        confidence_counts['height'][building['heightConfidence']] += 1
        confidence_counts['era'][building['eraConfidence']] += 1
    report['buildingRecords'] = {'roles': role_counts, 'upstreamFamilies': upstream_counts,
                                 'confidence': confidence_counts}
    report['pendingReview'] = build_pending_review(
        out, carriageways, gb_deferred, overture_deferred, size_mismatches)
    return out
