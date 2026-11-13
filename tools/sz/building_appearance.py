"""在已融合的建筑载荷上派生普通楼估高和首层商业用途。"""

from collections import Counter, defaultdict
import json
import math
import random
from pathlib import Path
from statistics import median, quantiles

from shapely import STRtree, make_valid
from shapely.geometry import Point, Polygon

from audit_shopping_park import packaged_polygon
from buildings import (CANOPY_TYPES, ESTIMATE_SEED, FACADES, _category, _facade, _num)
from geo import project_coords
from land import _to_local

CELL_M = 250
RADII_M = (180, 350, 650, 1000, 1500)
MIN_SAMPLES = 4
MAX_SAMPLES = 12
MAX_REFERENCE_HEIGHT = 150
RELIABLE = {'osm-height', 'osm-levels', 'overture-height', 'overture-floors', 'published'}
RETAIL = {'retail', 'mall', 'supermarket'}
LOW_RESIDENTIAL = {'house', 'detached', 'terrace', 'semidetached_house', 'cabin', 'hut', 'bungalow'}
HISTORIC_BUILDINGS = {'temple', 'ruins', 'gatehouse', 'shrine'}
PUBLIC_AMENITIES = {'school', 'college', 'university', 'kindergarten', 'hospital', 'library',
                    'townhall', 'community_centre', 'arts_centre', 'theatre', 'fire_station', 'police'}
PROTECTED_REGIONS = {'public', 'park', 'village'}
BLOCK_USES = {'residential': 'residential', 'office': 'office', 'retail': 'retail'}
DEFAULT_HEIGHTS = {
    'residential': (15, 23, 34, 48), 'commercial': (15, 24, 35, 44),
    'office': (16, 26, 40, 55), 'hotel': (16, 25, 37, 48),
    'retail': (9, 13, 18, 24), 'unknown': (14, 21, 28, 36),
}
URBAN_DATUM = Path(__file__).resolve().parents[2] / 'data/source/urban-datum.json'


def _size_class(area):
    return 0 if area < 90 else 1 if area < 320 else 2 if area < 1400 else 3


def _protected_areas(payload, osm):
    # 用已核山体边界和现有公园/广场面；不把整片城区的高海拔当成山地。
    manifest = json.loads(URBAN_DATUM.read_text())
    relief = {row['osmId']: row for row in manifest['relief']}
    rows = []
    for entry in [*osm.get('green', []), *osm.get('plaza', [])]:
        identity, tags = entry['id'], entry['tags']
        if identity in relief and 'polygonWgs84' in relief[identity]:
            continue
        if (identity in relief or tags.get('leisure') in {'park', 'garden', 'nature_reserve', 'golf_course'}
                or tags.get('landuse') == 'park' or tags.get('place') in {'square', 'plaza'}
                or tags.get('highway') == 'pedestrian'):
            kind = relief.get(identity, {}).get('kind', 'public-space')
            rows.append((identity, kind, _to_local(entry['geom'])))
    for identity, row in relief.items():
        if 'polygonWgs84' in row:
            outer, *holes = row['polygonWgs84']
            rows.append((identity, row['kind'], Polygon(project_coords(outer), [project_coords(ring) for ring in holes])))
    sites = payload.get('sites', {}).get('sites', {})
    ancient = sites.get('nantou-ancient-city', {}).get('site')
    if ancient:
        rows += [(ancient['osmId'], 'historic', packaged_polygon(rings)) for rings in ancient['polygons']]
    return [(identity, kind, shape if shape.is_valid else make_valid(shape)) for identity, kind, shape in rows]


def _nearby_reference(center, sample_trees, use, size):
    # 先找同用途、同档体量；仍不足时仅放宽到相邻体量档，同用途不放宽。
    # 微小足迹不与普通楼互借，避免附属小屋影响街区高度。
    compatible = [size] if size == 0 else [n for n in range(1, 4) if abs(n - size) <= 1]
    tiers = [(size,)] + ([tuple(compatible)] if len(compatible) > 1 else [])
    pools_by_tier = [(sizes, [sample_trees[(use, n)] for n in sizes if (use, n) in sample_trees])
                     for sizes in tiers]
    for radius in RADII_M:
        for sizes, pools in pools_by_tier:
            if sum(len(rows) for rows, _ in pools) < MIN_SAMPLES:
                continue
            nearby = [rows[i] for rows, tree in pools
                      for i in tree.query(center, predicate='dwithin', distance=radius)]
            if len(nearby) < MIN_SAMPLES:
                continue
            first, _, third = quantiles([row[2] for row in nearby], method='inclusive')
            spread = max(3, (third - first) * 1.5)
            retained = [row for row in nearby if first - spread <= row[2] <= third + spread]
            if len(retained) >= MIN_SAMPLES:
                retained.sort(key=lambda row: (center.distance(row[0]), row[1]))
                return retained[:MAX_SAMPLES], radius, sizes
    return [], None, ()


def _height(identity, base, median_m=None):
    factor = random.Random(f'{ESTIMATE_SEED}:{identity}').uniform(0.8, 1.2)
    rounded = round(base * factor, 1)
    if median_m is None:
        return rounded
    # 十分米量化后仍在中位数的 40%–60% 内。
    return max(math.ceil(median_m * 4 - 1e-9) / 10, min(rounded, math.floor(median_m * 6 + 1e-9) / 10))


def _apply_building_heights(payload, osm, report, tags_by_id, foundations):
    b, enums = payload['buildings'], payload['enums']
    region_use, blocks, protected = {}, {}, {}
    for region in sorted(payload['mapRegions']['regions'], key=lambda row: (row.get('areaM2', 0), row['id'])):
        kind, level, refs = region['type'], region['level'], region['buildingRefs']
        if kind in PROTECTED_REGIONS:
            for i in refs:
                protected.setdefault(i, (region['id'], kind))
        if level == 'place' and kind in BLOCK_USES:
            for i in refs:
                region_use.setdefault(i, BLOCK_USES[kind])
        if region.get('anchors') and (level == 'block' or
                                      level == 'place' and kind in BLOCK_USES and region['areaM2'] <= CELL_M ** 2):
            for i in refs:
                blocks.setdefault(i, (region['id'], tuple(region['anchors'][0][:2])))

    areas = _protected_areas(payload, osm)
    protection_tree = STRtree([row[2] for row in areas])
    samples, pending = defaultdict(list), defaultdict(list)
    groups = {}
    identities = Counter(b['id'])
    roles = enums['buildingRole']

    def record(i, method, data=None, height=None, protection=None):
        row = groups.setdefault(method, {**(data or {}), 'buildings': []})
        row['buildings'].append(b['id'][i])
        if protection is not None:
            row.setdefault('areas', {}).setdefault(protection, []).append(b['id'][i])
        if identities[b['id'][i]] > 1:
            row.setdefault('multipartRecords', []).append({'id': b['id'][i], 'row': i,
                                                           'heightM': b['h'][i] if height is None else height})
        if height is not None:
            b['h'][i] = height
            b['facade'][i] = enums['facade'].index(_facade(enums['category'][b['cat'][i]], height, footprint_areas[i], None))

    footprint_areas = {}
    for i, identity in enumerate(b['id']):
        tags = tags_by_id.get(identity, {})
        building_type = tags.get('building')
        part_type = tags.get('building:part')
        use_tag = tags.get('building:use')
        kind = use_tag or building_type or part_type
        category = enums['category'][b['cat'][i]]
        source = enums['heightSource'][b['src'][i]]
        role = roles[b['role'][i]]
        special = (b['lm'][i] >= 0 or b['minH'][i] > 0 or bool(part_type) or identity in foundations
                   or role in {'podium', 'canopy', 'bridge'} or kind in CANOPY_TYPES | {'bridge'})
        if source == 'estimate':
            if special or b['lv'][i] > 0 or any((_num(tags.get(k)) or 0) > 0 for k in ('building:levels', 'height')):
                record(i, 'existing-special-or-vertical-tag')
                continue
        elif source not in RELIABLE or special or identities[identity] > 1:
            continue

        polygon = packaged_polygon(b['rings'][i])
        if polygon.is_empty or not polygon.is_valid or polygon.area <= 0:
            if source == 'estimate':
                record(i, 'existing-unusable-footprint')
            continue
        area = footprint_areas[i] = polygon.area
        size = _size_class(area)
        place = protected.get(i)
        if not place:
            matches = [(areas[j][0], areas[j][1]) for j in protection_tree.query(polygon, predicate='intersects')
                       if areas[j][2].intersection(polygon).area >= area * 0.5]
            place = min(matches, key=lambda row: (row[1] != 'historic', row[1] != 'mountain', row[0])) if matches else None
        tags_to_check = {building_type, use_tag}
        local_default = None
        if category == 'industrial' or any(_category(tag) == 'industrial' for tag in tags_to_check):
            local_default = ('industrial', 14 if area < 3000 else 20)
        elif tags_to_check & LOW_RESIDENTIAL:
            local_default = ('low-residential', 8)
        elif (place and place[1] in {'historic', 'village'} or tags_to_check & HISTORIC_BUILDINGS
              or tags.get('historic') not in (None, 'no')):
            local_default = ('historic-or-low-rise', 8 if area < 160 else 12)
        elif place or category == 'public' or tags.get('amenity') in PUBLIC_AMENITIES or _category(use_tag) == 'public':
            local_default = (place[1] if place else 'public', 8 if area < 160 else 12)
        if local_default:
            if source == 'estimate':
                reason, base = local_default
                record(i, f'protected-default:{reason}:{base}', {'baseM': base}, _height(identity, base),
                       place[0] if place else None)
            continue

        # 有标签先用标签；对无用途的足迹仅用核实面内的用途作取样线索。
        explicit_category = _category(use_tag)
        use = ('retail' if kind in RETAIL else kind if kind in {'office', 'hotel'} else
               explicit_category if explicit_category != 'unknown' else category)
        if use == 'unknown':
            use = region_use.get(i, use)
        center = polygon.centroid
        if source != 'estimate':
            height = b['h'][i]
            # 排除低附属体、超高层及异常高宽比，已有数据本身仍原样保留。
            if 12 <= height < MAX_REFERENCE_HEIGHT and height <= 6 * math.sqrt(area):
                samples[use, size].append((center, identity, height, source))
        else:
            cell = (math.floor(center.x / CELL_M), math.floor(center.y / CELL_M))
            anchor = blocks.get(i, (f'grid:{cell[0]}:{cell[1]}', tuple((n + 0.5) * CELL_M for n in cell)))
            pending[(use, size, anchor)].append(i)

    # 样本索引只含原有可靠记录；后续写回估计高度不会回流。
    trees = {group: (rows, STRtree([row[0] for row in rows])) for group, rows in samples.items()}
    for (use, size, (anchor_id, center)), indices in sorted(pending.items()):
        reference, radius, sizes = _nearby_reference(Point(*center), trees, use, size)
        if reference:
            median_m = median(row[2] for row in reference)
            base = median_m * 0.5
            method = f'nearby:{use}:{size}:{anchor_id}'
            data = {'anchor': list(center), 'radiusM': radius, 'sizeClasses': list(sizes),
                    'medianM': median_m, 'baseM': base,
                    'samples': [[identity, height, source] for _, identity, height, source in reference]}
        else:
            median_m = None
            base = DEFAULT_HEIGHTS[use][size]
            method = f'use-default:{use}:{size}:{base}'
            data = {'baseM': base, 'reason': 'insufficient-reliable-samples'}
        for i in indices:
            record(i, method, data, _height(b['id'][i], base, median_m))

    # 更新报告中能唯一定位的样本，多个部件同 ID 时保留审核时的数值。
    if 'pendingReview' in report:
        heights = {identity: (b['h'][i], enums['heightSource'][b['src'][i]]) for i, identity in enumerate(b['id'])
                   if identities[identity] == 1}
        for item in report['pendingReview']['objects']:
            if item['id'] in heights:
                item['heightM'], item['heightSource'] = heights[item['id']]

    report['heightEstimate'] = {
        'method': 'shared-block-median-or-use-default', 'cellM': CELL_M,
        'radiiM': RADII_M, 'minSamples': MIN_SAMPLES, 'maxSamples': MAX_SAMPLES,
        'maxReferenceHeightExclusiveM': MAX_REFERENCE_HEIGHT,
        'scale': 0.5, 'jitter': [0.8, 1.2], 'seed': ESTIMATE_SEED, 'seedBy': 'building-id',
        'groups': {key: {**row, 'buildings': sorted(row['buildings'])} for key, row in sorted(groups.items())},
    }


def apply_building_appearance(payload, osm, report):
    b, enums = payload['buildings'], payload['enums']
    tags_by_id = {row['id']: row['tags'] for row in osm['buildings']}
    retail_areas, protected = set(), set()
    for region in payload['mapRegions']['regions']:
        if region['type'] == 'retail':
            retail_areas.update(region['buildingRefs'])
        if region['id'] == 'osm:way/219961346' or region['type'] == 'public' and region['level'] == 'place':
            protected.update(region['buildingRefs'])
    foundations = {row['id'] for row in payload.get('golfCourse', {}).get('foundations', [])}
    retail = {}
    for i, identity in enumerate(b['id']):
        tags = tags_by_id.get(identity, {})
        kind = tags.get('building:use') or tags.get('building') or tags.get('building:part')
        category = enums['category'][b['cat'][i]]
        part = 'building:part' in tags and enums['buildingRole'][b['role'][i]] != 'podium'
        special = b['lm'][i] >= 0 or b['minH'][i] > 0 or part or identity in foundations or kind in CANOPY_TYPES | {'bridge'}
        if (not special and i not in protected and category not in {'residential', 'industrial', 'public'}
                and tags.get('building') not in LOW_RESIDENTIAL):
            shop = tags.get('shop')
            if kind in RETAIL or tags.get('building') in RETAIL:
                retail[identity] = 2
            elif shop not in (None, 'no', 'vacant') or (i in retail_areas and kind == 'commercial'):
                retail.setdefault(identity, 1)
    payload['retailBuildings'] = [list(row) for row in sorted(retail.items())]
    report['retailBuildings'] = {'groundFloor': sum(mode == 1 for mode in retail.values()),
                                 'retailBuilding': sum(mode == 2 for mode in retail.values())}
    _apply_building_heights(payload, osm, report, tags_by_id, foundations)
