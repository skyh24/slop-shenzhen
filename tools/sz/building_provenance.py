"""建筑融合缓存与离线报告；运行包仍只携带原有紧凑字段。"""

from collections import Counter
import gzip
import hashlib
import json
import pickle
from pathlib import Path
from tempfile import NamedTemporaryFile

import shapely

from buildings import FOOTPRINT_REVIEWS, ROOT, build_buildings
from package_validation import CORE_SOURCES, sha256

CACHE_VERSION = 1
CACHE_DIR = ROOT / 'data/raw/cache'
RULES = (
    'tools/sz/buildings.py', 'tools/sz/building_provenance.py', 'tools/sz/building_parent_review.py',
    'tools/sz/geo.py', 'tools/sz/osm.py', 'tools/sz/roads.py',
    'data/source/building-footprint-reviews.json', 'data/source/building-height-overrides.json',
    'data/source/landmarks.json', 'data/source/chegongmiao-parent-review.json', 'data/source/road-structures.json',
)


def read_retirement_review(reviews, identity, geometry):
    # 上游重发时只认同一个源 ID 和已审核几何；旧裁决仍保留供重新核对。
    return reviews.get((identity, geometry))


def fingerprint(sources, clip, options):
    rules = {path: sha256(ROOT / path) for path in RULES}
    inputs = {key: sources[key]['sha256'] for key in CORE_SOURCES}
    data = {'version': CACHE_VERSION, 'inputs': inputs, 'rules': rules, 'options': options,
            'clipSha256': hashlib.sha256(clip.wkb).hexdigest(), 'geosVersion': shapely.geos_version_string}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(), data


def build_cached_buildings(osm, clip, report, sources, *, overture_path, globfp_path,
                           use_cache, include_overture_footprints, include_globfp_footprints,
                           reviewed_parent_uses, road_cover_ids):
    options = {'overtureFootprints': include_overture_footprints, 'globfpFootprints': include_globfp_footprints,
               'reviewedParentUses': reviewed_parent_uses, 'roadCoverIds': sorted(road_cover_ids),
               'overtureExtractSha256': sha256(overture_path), 'globfpExtractSha256': sha256(globfp_path)}
    identity, inputs = fingerprint(sources, clip, options)
    cache = CACHE_DIR / f'building-fusion-{identity}.pkl'
    if use_cache and cache.is_file():
        with cache.open('rb') as file:
            buildings, audit = pickle.load(file)
    else:
        audit = {}
        buildings = build_buildings(osm, clip, audit, reviewed_parent_uses=reviewed_parent_uses,
                                    overture_path=overture_path, globfp_path=globfp_path,
                                    include_overture_footprints=include_overture_footprints,
                                    include_globfp_footprints=include_globfp_footprints,
                                    road_cover_ids=road_cover_ids, provenance=True)
        if use_cache:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(dir=CACHE_DIR, delete=False) as file:
                temp = Path(file.name)
                try:
                    pickle.dump((buildings, audit), file)
                    file.close()
                    temp.replace(cache)
                finally:
                    temp.unlink(missing_ok=True)
    report.update(audit)
    report['buildingFusionInputs'] = {'fingerprint': identity, **inputs}
    return buildings


def geometry_hash(rings):
    return hashlib.sha256(json.dumps(rings, separators=(',', ':')).encode()).hexdigest()


def write_building_provenance(payload, report, sources, provenance, *, local_output=None):
    table, enums = payload['buildings'], payload['enums']
    counts = Counter(table['id'])
    revisions = {row['id']: row['release'] for row in sources}
    reviews = json.loads(FOOTPRINT_REVIEWS.read_text())
    reviewed = {(row['id'], row['geometrySha256']): row for row in reviews.get('objectReviews', [])}
    retirement = reviews.get('globfpFootprintRetirement')
    basis = {'osm-height': 'explicit-height', 'osm-levels': 'levels-times-3.2m',
             'overture-height': 'provider-height', 'overture-floors': 'levels-times-3.2m',
             'globfp': 'model-prediction', 'estimate': 'scene-estimate', 'published': 'published-review',
             'landmark': 'landmark-binding'}
    methods = {identity: group for group, row in report['heightEstimate'].get('groups', {}).items()
               for identity in row['buildings'] if counts[identity] == 1}
    match_rows, identities = [], []
    footprint_counts = Counter()
    source_keys = {'osm': 'osm-guangdong', 'overture': 'overture-buildings'}
    # 用于报告的短表按 ID 关联；多面对象再用量化轮廓哈希区分。
    for i, identity in enumerate(table['id']):
        rings = table['rings'][i]
        geom = geometry_hash(rings)
        record = provenance[(identity, geom)]
        height_source = enums['heightSource'][table['src'][i]]
        footprint = record['footprint']
        footprint_counts[footprint['source']] += 1
        source_key = source_keys.get(footprint['source'], footprint.get('sourceId'))
        match = record['heightMatch']
        entity = identity if counts[identity] == 1 else f'{identity}#{geom}'
        if match:
            match_rows.append([entity, match['sourceId'], match['sourceFid'], match['part'],
                               match['iou'], match['areaRatio'], match['centroidDistanceM'], match['rawHeightM']])
        if local_output:
            identities.append({
                'entityId': entity, 'id': identity, 'geometrySha256': geom,
                'isPart': record['isPart'], 'parentId': record['parentId'], 'role': enums['buildingRole'][table['role'][i]],
                'footprint': {**footprint, 'sourceId': source_key, 'version': revisions.get(source_key)},
                'height': {'metres': table['h'][i], 'source': height_source, 'method': basis[height_source],
                           'referenceYear': 2020 if height_source == 'globfp' else None, 'match': match,
                           'estimateGroup': methods.get(identity)},
                'use': {'category': enums['category'][table['cat'][i]], 'sourceUse': record['sourceUse'],
                        'evidence': record['categoryEvidence']},
                'appearance': {'template': enums['facade'][table['facade'][i]],
                               'basis': 'landmark' if table['lm'][i] >= 0 else 'category-height-area'},
                'landmarkPart': record['landmarkPart'],
                'decision': 'retain', 'review': read_retirement_review(reviewed, identity, geom),
            })
    report['buildingProvenance'] = {
        'version': 1, 'reviewManifest': FOOTPRINT_REVIEWS.relative_to(ROOT).as_posix(),
        'reviewVersion': reviews['version'], 'reviewRevision': reviews.get('revision', 1),
        'footprintSources': {key: footprint_counts[key] for key in ('osm', 'overture', 'globfp')},
        'globfpHeight': {'method': 'model-prediction', 'referenceYear': 2020,
                         'thresholds': {'minIou': 0.6, 'minAreaRatio': 0.65, 'maxCentroidDistanceM': 12},
                         'columns': ['entityId', 'sourceId', 'sourceFid', 'part',
                                     'iou', 'areaRatio', 'centroidDistanceM', 'rawHeightM'],
                         'matches': match_rows},
        'objectReviews': list(reviewed.values()),
        'globfpFootprintRetirement': retirement,
        'sharedUpstream': 'Overture and GloBFP East Asia may share upstream evidence; do not count as independent.',
    }
    if local_output:
        with gzip.open(local_output, 'wt') as file:
            for row in identities:
                file.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
