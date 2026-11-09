"""按车公庙试点抽取 Overture 原始字段，核对父部件和道路引用。"""

import argparse
from collections import Counter
from datetime import date
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

import osmium
from shapely import union_all
from shapely.geometry import box, shape

from audit_road_elevations import local_geometry
from osm import PBF

ROOT = Path(__file__).resolve().parents[2]
RELEASE = '2026-10-21.0'
PILOT = 'shennan-chegongmiao'
RAW = ROOT / 'data/raw/overture' / f'chegongmiao-{RELEASE}'
BUCKET = f's3://overturemaps-us-west-2/release/{RELEASE}'
STAC = f'https://stac.overturemaps.org/{RELEASE}'
# 核对四个 STAC collection 的全部 item 包围盒后，以下分片覆盖本试点及一跳邻接。
PARTITIONS = {
    'building': ('buildings', '00377', '7a68e55e-d7b0-5b63-b213-4f79883b2211'),
    'building_part': ('buildings', '00000', 'bd282a3b-17f8-59d2-be35-2c8995e1f976'),
    'segment': ('transportation', '00111', '0bf28189-3e7a-5965-8a3b-c1992c2dd907'),
    'connector': ('transportation', '00027', 'd5e495fe-4d3b-5ad0-90c1-740ae0ec5ace'),
}
ASSET_COVERAGE = box(114.012, 22.534, 114.030, 22.545)
CONNECTOR_COVERAGE = box(114.0095, 22.5345, 114.029, 22.549)


def sha(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def core_region():
    source = ROOT / 'data/source/road-frontage-pilot.json'
    return box(*next(row['bounds'] for row in json.loads(source.read_text())['corridors'] if row['id'] == PILOT))


def read_rows(path):
    with path.open() as handle:
        return [json.loads(line) for line in handle]


def sample_id(kind):
    return f'overture-chegongmiao-{kind.replace("_", "-")}'


def verify_sample(path, kind, sources):
    record = sources.get(sample_id(kind))
    if record and (record['release'] != RELEASE or path.stat().st_size != record['bytes'] or sha(path) != record['sha256']):
        raise ValueError(f'Overture sample does not match its locked extract: {kind}')


def paths(kind):
    theme, shard, uuid = PARTITIONS[kind]
    return (f'{BUCKET}/theme={theme}/type={kind}/part-{shard}-{uuid}-c000.zstd.parquet',
            f'{STAC}/{theme}/{kind}/{shard}/{shard}.json')


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def sql_ids(identities):
    return '[' + ','.join(map(quote, sorted(set(identities)))) + ']'


def bounds_filter(bounds, coverage=ASSET_COVERAGE):
    w, s, e, n = bounds
    if not coverage.covers(box(w, s, e, n)):
        raise ValueError('Overture query exceeds the audited STAC coverage')
    return f'bbox.xmin <= {e} AND bbox.xmax >= {w} AND bbox.ymin <= {n} AND bbox.ymax >= {s}'


def exact_filter(bounds):
    return bounds_filter(bounds) + ' AND ST_Intersects(geometry, ST_MakeEnvelope(' + ','.join(map(str, bounds)) + '))'


def query(kind, where, output):
    sql = f"""LOAD httpfs; LOAD spatial; SET s3_region='us-west-2'; SET threads=4;
COPY (SELECT * EXCLUDE (geometry), ST_AsGeoJSON(geometry)::JSON AS geom
      FROM read_parquet({quote(paths(kind)[0])}, hive_partitioning=1) WHERE {where} ORDER BY id)
TO {quote(output)} (FORMAT JSON);"""
    subprocess.run(['duckdb', '-bail', '-c', sql], check=True)
    return read_rows(output)


def closure_ids(segments):
    connectors = {ref['connector_id'] for row in segments for ref in row['connectors']}
    turn_segments = set()
    for row in segments:
        for turn in row['prohibited_transitions'] or []:
            for member in turn['sequence']:
                if member.get('connector_id'):
                    connectors.add(member['connector_id'])
                if member.get('segment_id'):
                    turn_segments.add(member['segment_id'])
    return connectors, turn_segments


def envelope(rows):
    bounds = [shape(row['geom']).bounds for row in rows]
    w, s = (min(row[axis] for row in bounds) for axis in (0, 1))
    e, n = (max(row[axis] for row in bounds) for axis in (2, 3))
    return (w - 0.00001, s - 0.00001, e + 0.00001, n + 0.00001)


def require_ids(wanted, rows, kind):
    found = {row['id'] for row in rows}
    if len(found) != len(rows) or wanted - found:
        raise ValueError(f'Incomplete or duplicate Overture {kind} references: {sorted(wanted - found)}')


def extract(region, sources):
    RAW.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=RAW) as temp:
        stage = Path(temp)
        part_path = stage / 'building_part.jsonl'
        core_parts = query('building_part', exact_filter(region.bounds), part_path)
        parents = {row['building_id'] for row in core_parts}
        rows = query('building', f'{bounds_filter(region.bounds)} AND id IN {sql_ids(parents)}', stage / 'building.jsonl')
        require_ids(parents, rows, 'building parent')
        if rows:
            part_scope = envelope([*core_parts, *rows])
            parts = query('building_part', f'{bounds_filter(part_scope)} AND building_id IN {sql_ids(parents)}', part_path)
            require_ids({row['id'] for row in core_parts}, parts, 'building part')

        roads = "subtype = 'road'"
        seeds = query('segment', f'{roads} AND {exact_filter(region.bounds)}', stage / 'segment-core.jsonl')
        refs, turn_segments = closure_ids(seeds)
        where = (f'{roads} AND {bounds_filter(envelope(seeds))} AND '
                 f'(list_has_any(list_transform(connectors, lambda item: item.connector_id), {sql_ids(refs)}) '
                 f'OR id IN {sql_ids(turn_segments)})')
        segments = query('segment', where, stage / 'segment.jsonl')
        require_ids({row['id'] for row in seeds} | turn_segments, segments, 'segment')
        needed, turns = closure_ids(segments)
        connector_extent = bounds_filter(envelope(segments), CONNECTOR_COVERAGE)
        connectors = query('connector', f'{connector_extent} AND id IN {sql_ids(needed)}', stage / 'connector.jsonl')
        require_ids(needed, connectors, 'connector')
        require_ids(turns, segments, 'turn segment')

        for kind in PARTITIONS:
            verify_sample(stage / f'{kind}.jsonl', kind, sources)
        for kind in PARTITIONS:
            name = f'{kind}.jsonl'
            (stage / name).replace(RAW / name)


def osm_ref(source):
    if source['dataset'] != 'OpenStreetMap':
        return None
    match = re.fullmatch(r'([nwr])(\d+)@(\d+)', source.get('record_id') or '')
    if not match:
        return None
    kind, number, version = match.groups()
    return f'{kind}{number}', int(version)


def source_refs(row):
    return [ref for source in row.get('sources') or [] if (ref := osm_ref(source))]


def raw_osm(rows):
    wanted = {identity for row in rows for identity, _ in source_refs(row)}
    selection = [int(identity[1:]) for identity in wanted]
    result = {}
    reader = osmium.FileProcessor(str(PBF)).with_filter(osmium.filter.IdFilter(selection))
    for obj in reader:
        identity = f'{obj.type_str()}{obj.id}'
        if identity in wanted:
            result[identity] = {'version': obj.version, 'tags': dict(obj.tags)}
    return result


def current_part(identity, city, index):
    ids = {'w': 'way', 'r': 'relation'}
    if not identity or identity[0] not in ids:
        return None
    number = index.get(f'{ids[identity[0]]}/{identity[1:]}')
    if number is None:
        return None
    b = city['buildings']
    return {'id': b['id'][number], 'heightM': b['h'][number], 'minHeightM': b['minH'][number],
            'heightSource': city['enums']['heightSource'][b['src'][number]],
            'category': city['enums']['category'][b['cat'][number]], 'facade': city['enums']['facade'][b['facade'][number]]}


def audit_buildings(rows, parts, region, sources, city):
    cached = sources['overture-buildings']
    cache_path = ROOT / cached['file']
    if sha(cache_path) != cached['sha256']:
        raise ValueError('Local Overture building cache hash mismatch')
    with cache_path.open() as handle:
        candidate_count = sum(shape(json.loads(line)['geom']).intersects(region) for line in handle)
    index = {identity: i for i, identity in enumerate(city['buildings']['id'])}
    groups = []
    for parent in rows:
        geo = local_geometry(shape(parent['geom']))
        parent_source = next(iter(source_refs(parent)), (None, None))
        children = []
        for child in parts:
            if child['building_id'] != parent['id']:
                continue
            geometry = local_geometry(shape(child['geom']))
            source = next(iter(source_refs(child)), (None, None))
            children.append({'id': child['id'], 'osmRef': source, 'areaM2': geometry.area,
                             'partInsideParentFraction': geometry.intersection(geo).area / geometry.area,
                             'values': {key: child[key] for key in ('height', 'num_floors', 'min_height', 'min_floor', 'roof_shape')},
                             'runtime': current_part(source[0], city, index)})
        coverage = union_all([local_geometry(shape(row['geom'])) for row in parts if row['building_id'] == parent['id']])
        groups.append({'id': parent['id'], 'name': parent['names']['primary'], 'osmRef': parent_source,
                       'class': parent['class'], 'subtype': parent['subtype'], 'parentAreaM2': geo.area,
                       'parentCoveredFraction': coverage.intersection(geo).area / geo.area,
                       'runtimeParent': current_part(parent_source[0], city, index), 'parts': children})
    return {'candidateParentsInCache': candidate_count, 'groups': groups}


def audit(region, sources):
    for kind in PARTITIONS:
        verify_sample(RAW / f'{kind}.jsonl', kind, sources)
    rows = {kind: read_rows(RAW / f'{kind}.jsonl') for kind in PARTITIONS}
    require_ids({row['building_id'] for row in rows['building_part']}, rows['building'], 'building parent')
    refs, turns = closure_ids(rows['segment'])
    require_ids(refs, rows['connector'], 'connector')
    require_ids(turns, rows['segment'], 'turn segment')
    core = [row for row in rows['segment'] if shape(row['geom']).intersects(region)]
    osm = raw_osm([row for group in rows.values() for row in group])
    city_path = ROOT / 'js/sz-city.json.gz'
    city = json.loads(gzip.decompress(city_path.read_bytes()))
    points = {row['id']: local_geometry(shape(row['geom'])) for row in rows['connector']}
    deviations = []
    for segment in rows['segment']:
        line = local_geometry(shape(segment['geom']))
        deviations.extend(line.distance(points[ref['connector_id']]) for ref in segment['connectors'])
    fields = ('width_rules', 'prohibited_transitions', 'level_rules', 'speed_limits', 'road_flags', 'road_surface', 'access_restrictions')
    return {'release': RELEASE, 'bounds': region.bounds, 'citySha256': sha(city_path),
            'buildings': audit_buildings(rows['building'], rows['building_part'], region, sources, city),
            'transportation': {'coreSegments': len(core), 'contextSegments': len(rows['segment']) - len(core),
                               'coreFields': {key: sum(bool(row[key]) for row in core) for key in fields},
                               'connectors': len(points), 'connectorMaxDistanceM': max(deviations, default=0)},
            'sourceDatasets': {key: Counter(source['dataset'] for row in group for source in row.get('sources') or [])
                               for key, group in rows.items()},
            'osmReferenceVersions': {key: dict(Counter('same' if osm.get(i, {}).get('version') == v
                                                      else 'different' if i in osm else 'missing'
                                                      for row in group for i, v in source_refs(row)))
                                     for key, group in rows.items()}}


def source_records():
    for kind in PARTITIONS:
        file = RAW / f'{kind}.jsonl'
        asset, stac = paths(kind)
        yield {'id': sample_id(kind), 'file': str(file.relative_to(ROOT)),
               'url': asset, 'stacItem': stac, 'release': RELEASE, 'downloadedAt': date.today().isoformat(),
               'extract': f'{PILOT} identity-closed sample, tools/sz/audit_overture_chegongmiao.py',
               'features': len(read_rows(file)), 'bytes': file.stat().st_size, 'sha256': sha(file), 'license': 'ODbL-1.0'}


def main():
    parser = argparse.ArgumentParser(description='Audit the pinned Chegongmiao Overture sample')
    parser.add_argument('--refresh', action='store_true', help='extract four local samples from pinned public partitions')
    parser.add_argument('--source-records', type=Path, help='write source entries for review')
    args = parser.parse_args()
    if args.source_records and not args.refresh:
        parser.error('--source-records requires --refresh')
    region = core_region()
    sources = {row['id']: row for row in json.loads((ROOT / 'data/source/sources.json').read_text())['sources']}
    if sha(PBF) != sources['osm-guangdong']['sha256']:
        raise ValueError('OSM PBF does not match the locked snapshot')
    if args.refresh:
        extract(region, sources)
    result = audit(region, sources)
    if args.source_records:
        args.source_records.write_text(json.dumps(list(source_records()), ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
