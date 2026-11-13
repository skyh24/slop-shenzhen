"""在已融合的建筑载荷上派生普通楼估高和首层商业用途。"""

from collections import defaultdict
import math
import random
from statistics import median, quantiles

from shapely import STRtree
from shapely.geometry import Point

from buildings import (ESTIMATE_SEED, FACADES, _facade, _num, CANOPY_TYPES)
from audit_shopping_park import packaged_polygon

CELL_M = 250
RADII_M = (180, 350, 650)
MIN_SAMPLES = 4
MAX_SAMPLES = 12
RELIABLE = {'osm-height', 'osm-levels', 'overture-height', 'overture-floors', 'published'}
RETAIL = {'retail', 'mall', 'supermarket'}
LOW_RESIDENTIAL = {'house', 'detached', 'terrace', 'semidetached_house', 'cabin', 'hut', 'bungalow'}


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
    samples, pending = defaultdict(list), defaultdict(list)
    retail = {}
    estimate_rows = defaultdict(list)
    methods = {}
    trees = {}

    def set_height(i, height, method):
        height = round(height, 1)
        b['h'][i] = height
        category = enums['category'][b['cat'][i]]
        b['facade'][i] = FACADES.index(_facade(category, height, areas[i], None))
        estimate_rows[method].append(b['id'][i])

    areas = {}
    for i, identity in enumerate(b['id']):
        tags = tags_by_id.get(identity, {})
        kind = tags.get('building:use') or tags.get('building') or tags.get('building:part')
        category = enums['category'][b['cat'][i]]
        source = enums['heightSource'][b['src'][i]]
        landmark = b['lm'][i] >= 0
        part = 'building:part' in tags and enums['buildingRole'][b['role'][i]] != 'podium'
        special = landmark or b['minH'][i] > 0 or part or identity in foundations or kind in CANOPY_TYPES | {'bridge'}
        if (not special and i not in protected and category not in {'residential', 'industrial', 'public'}
                and tags.get('building') not in LOW_RESIDENTIAL):
            shop = tags.get('shop')
            if kind in RETAIL or tags.get('building') in RETAIL:
                retail[identity] = 2
            elif shop not in (None, 'no', 'vacant') or (i in retail_areas and kind == 'commercial'):
                retail.setdefault(identity, 1)

        if source != 'estimate':
            if (source not in RELIABLE or special or i in protected
                    or category in {'industrial', 'public'} or kind in LOW_RESIDENTIAL):
                continue
        elif special or b['lv'][i] > 0 or (_num(tags.get('building:levels')) or 0) > 0 or (_num(tags.get('height')) or 0) > 0:
            estimate_rows['existing-special-or-vertical-tag'].append(identity)
            continue

        polygon = packaged_polygon(b['rings'][i])
        if polygon.is_empty or not polygon.is_valid:
            if source == 'estimate':
                estimate_rows['existing-unusable-footprint'].append(identity)
            continue
        area = areas[i] = polygon.area
        if source == 'estimate' and (i in protected or kind in LOW_RESIDENTIAL
                                     or category in {'industrial', 'public'} or kind in {'temple', 'ruins', 'gatehouse'}):
            base = (14 if area < 3000 else 20) if category == 'industrial' else (
                8 if kind in LOW_RESIDENTIAL or area < 160 else 12)
            factor = random.Random(f'{ESTIMATE_SEED}:{identity}').uniform(0.8, 1.2)
            reason = 'protected-area' if i in protected else kind or category
            method = f'use-default:{reason}:{base}'
            methods[method] = {'baseM': base}
            set_height(i, base * factor, method)
            continue

        # 用途一致，再按体量区分附属小楼、普通楼和大足迹；商场和办公楼分开取样。
        use = 'retail' if kind in RETAIL else kind if kind in {'office', 'hotel'} else category
        size = 0 if area < 90 else 1 if area < 320 else 2 if area < 1400 else 3
        group = (use, size)
        center = polygon.centroid
        if source != 'estimate':
            height = b['h'][i]
            if 4 <= height < 150 and height <= 6 * math.sqrt(area):
                samples[group].append((center, identity, height, source))
        else:
            cell = (math.floor(center.x / CELL_M), math.floor(center.y / CELL_M))
            pending[(group, cell)].append(i)

    for group, cell in sorted(pending):
        rows = samples[group]
        if len(rows) >= MIN_SAMPLES and group not in trees:
            trees[group] = STRtree([row[0] for row in rows])
        tree = trees.get(group)
        center = Point(*[(index + 0.5) * CELL_M for index in cell])
        reference = []
        for radius in RADII_M if tree is not None else ():
            indices = tree.query(center, predicate='dwithin', distance=radius)
            ordered = sorted((rows[i] for i in indices), key=lambda row: (center.distance(row[0]), row[1]))
            distinct = {row[1]: row for row in reversed(ordered)}
            if len(distinct) < MIN_SAMPLES:
                continue
            first, _, third = quantiles([row[2] for row in distinct.values()], method='inclusive')
            spread = max(3, (third - first) * 1.5)
            reference = [row for row in ordered if distinct.get(row[1]) is row and first - spread <= row[2] <= third + spread]
            if len(reference) >= MIN_SAMPLES:
                reference = reference[:MAX_SAMPLES]
                break
            reference = []
        use, size = group
        if reference:
            median_m = median(row[2] for row in reference)
            base = median_m * 0.5
            method = f'nearby:{use}:{size}:{cell[0]}:{cell[1]}'
            methods[method] = {'radiusM': radius, 'medianM': median_m, 'baseM': base,
                               'samples': [[identity, height, source] for _, identity, height, source in reference]}
        else:
            base = {'residential': (12, 20, 32, 48), 'commercial': (12, 22, 34, 42),
                    'office': (14, 25, 40, 55), 'hotel': (14, 24, 36, 48),
                    'retail': (8, 12, 17, 23), 'unknown': (10, 16, 22, 30)}[use][size]
            method = f'use-default:{use}:{size}:{base}'
            methods[method] = {'baseM': base}
        for i in pending[(group, cell)]:
            factor = random.Random(f"{ESTIMATE_SEED}:{b['id'][i]}").uniform(0.8, 1.2)
            set_height(i, base * factor, method)

    payload['retailBuildings'] = [list(row) for row in sorted(retail.items())]
    report['heightEstimate'] = {
        'method': 'median-of-reliable-local-buildings-or-use-default', 'cellM': CELL_M,
        'radiiM': RADII_M, 'minSamples': MIN_SAMPLES, 'maxSamples': MAX_SAMPLES,
        'scale': 0.5, 'jitter': [0.8, 1.2], 'seed': ESTIMATE_SEED, 'seedBy': 'building-id',
        'groups': {key: {**methods.get(key, {}), 'buildings': identities}
                   for key, identities in sorted(estimate_rows.items())},
    }
    report['retailBuildings'] = {'groundFloor': sum(mode == 1 for mode in retail.values()),
                                 'retailBuilding': sum(mode == 2 for mode in retail.values())}
