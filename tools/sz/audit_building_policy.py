"""对照两份已生成城市包；面积表示轮廓覆盖，不推断现实建筑是否存在。"""

import argparse
from collections import Counter, defaultdict
import csv
import gzip
from hashlib import sha256
import json
from math import floor
from pathlib import Path

from shapely import STRtree, make_valid, union_all
from shapely.geometry import Polygon, box, mapping

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project
from package_validation import ring_points

SAMPLES = {
    'super-hq': (113.96272, 22.52383, 180),
    'baishizhou': (113.9692, 22.54315, 180),
    'nantou': (113.91589, 22.54624, 180),
    'qianhai': (113.8959, 22.53725, 210),
    'north-edge': (114.049, 22.59987, 200),
}


def load(path):
    return json.loads(gzip.decompress(path.read_bytes()))


def polygon(rings):
    outer, *holes = [ring_points(ring) for ring in rings]
    raw = Polygon(outer, holes)
    return raw if raw.is_valid else make_valid(raw)


def digest(value):
    return sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()


def source(identity):
    return identity.split('/')[0] if identity.startswith(('globfp/', 'overture/')) else 'osm'


def rows(city):
    for i, row in enumerate(zip(*city['buildings'].values(), strict=True)):
        item = dict(zip(city['buildings'], row, strict=True))
        for key, enum in [('src', 'heightSource'), ('cat', 'category'), ('facade', 'facade'),
                          ('role', 'buildingRole'), ('upstream', 'upstreamFamily'),
                          ('fpConf', 'confidence'), ('hConf', 'confidence'), ('eraConf', 'confidence')]:
            item[key] = city['enums'][enum][item[key]]
        item['name'] = city['names'][item['name']] if item['name'] >= 0 else None
        item['lm'] = city['landmarks'][item['lm']]['id'] if item['lm'] >= 0 else None
        item.update(row=i, footprintSource=source(item['id']), geometryHash=digest(item['rings']))
        yield item


def key(row):
    return row['id'], row['geometryHash']


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def write_rows(path, data):
    with gzip.open(path, 'wt') as file:
        for row in data:
            file.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')


def summary(records, part_ids):
    counts = Counter(row['id'] for row in records)
    parts = sum(row['id'] in part_ids for row in records)
    return {
        'records': len(records), 'uniqueIds': len(counts),
        'buildingPartRows': parts, 'nonPartRows': len(records) - parts,
        'partIds': len(counts.keys() & part_ids), 'nonPartIds': len(counts.keys() - part_ids),
        'repeatedIds': {identity: n for identity, n in counts.items() if n > 1},
        'footprintSources': Counter(row['footprintSource'] for row in records),
        'heightSources': Counter(row['src'] for row in records),
        'roles': Counter(row['role'] for row in records),
    }


def group_index(report):
    result = defaultdict(list)
    for group, row in report.get('heightEstimate', {}).get('groups', {}).items():
        fields = {k: v for k, v in row.items() if k not in ('buildings', 'areas', 'multipartRecords')}
        for identity in set(row['buildings']):
            result[identity].append([group, fields])
    return result


def compare(before, after, before_report, after_report, part_ids, output):
    old, new = list(rows(before)), list(rows(after))
    kept = [row for row in new if row['footprintSource'] != 'globfp']
    old_by_key, new_by_key = defaultdict(list), defaultdict(list)
    for index, data in ((old_by_key, old), (new_by_key, new)):
        for row in data:
            index[key(row)].append(row)
    if any(len(items) > 1 for items in [*old_by_key.values(), *new_by_key.values()]):
        raise ValueError('Ambiguous ID and geometry pair')
    removed = [row for row in old if key(row) not in new_by_key]
    added = [row for row in new if key(row) not in old_by_key]
    shifts = []
    old_groups, new_groups = group_index(before_report), group_index(after_report)
    estimate_shifts = []
    for row in new:
        prior = old_by_key.get(key(row))
        if not prior:
            continue
        changed = {k: [prior[0][k], v] for k, v in row.items() if k != 'row' and prior[0][k] != v}
        if changed:
            shifts.append({'id': row['id'], 'geometryHash': row['geometryHash'], 'fields': changed})
        identity = row['id']
        if row['src'] == 'estimate' and old_groups[identity] != new_groups[identity]:
            estimate_shifts.append({'id': identity, 'before': old_groups[identity], 'after': new_groups[identity]})
    write_json(output / 'retained-changes.json', shifts)
    write_json(output / 'estimate-group-changes.json', estimate_shifts)
    write_rows(output / 'before.jsonl.gz', old)
    write_rows(output / 'after.jsonl.gz', new)

    old_regions = {r['id']: {key(old[i]) for i in r['buildingRefs']} for r in before['mapRegions']['regions']}
    new_regions = {r['id']: {key(new[i]) for i in r['buildingRefs']} for r in after['mapRegions']['regions']}
    region_changes = {r: {'removed': sorted(old_regions.get(r, set()) - new_regions.get(r, set())),
                          'added': sorted(new_regions.get(r, set()) - old_regions.get(r, set()))}
                      for r in sorted(old_regions.keys() | new_regions.keys())
                      if old_regions.get(r) != new_regions.get(r)}
    write_json(output / 'region-link-changes.json', region_changes)
    shapes = [polygon(row['rings']) for row in kept]
    tree = STRtree(shapes)
    grids = defaultdict(Counter)
    def cell(shape):
        p = shape.centroid
        return floor(p.x / 1000), floor(p.y / 1000)
    for label, records in (('before', old), ('after', new)):
        for row in records:
            grids[cell(polygon(row['rings']))][label] += 1
    detail = []
    coverage = Counter()
    for row in removed:
        geom = polygon(row['rings'])
        hits = defaultdict(list)
        replacements = defaultdict(set)
        for i in tree.query(geom, predicate='intersects'):
            part = shapes[i].intersection(geom)
            if part.area > 0:
                label = kept[i]['footprintSource']
                hits[label].append(part)
                replacements[label].add(kept[i]['id'])
        covered = union_all([p for parts in hits.values() for p in parts])
        uncovered = geom.difference(covered)
        label = ('no-replacement-overlap' if covered.area < 0.01 else
                 'fully-overlapped' if uncovered.area < 0.01 else 'partially-overlapped')
        coverage[label] += 1
        p = geom.centroid
        detail.append({**row, 'x': round(p.x, 2), 'z': round(p.y, 2),
                       'lon': round(ORIGIN_LON + p.x / KX, 8), 'lat': round(ORIGIN_LAT - p.y / KY, 8),
                       'areaM2': round(geom.area, 2), 'coveredM2': round(covered.area, 2),
                       'uncoveredM2': round(uncovered.area, 2),
                       'coveredBySourceM2': {k: round(union_all(v).area, 2) for k, v in hits.items()},
                       'overlapIds': {k: sorted(v) for k, v in replacements.items()},
                       'coverage': label, 'uncoveredGeometryXZ': mapping(uncovered),
                       'decision': 'retired-from-package', 'realityStatus': 'unknown'})
        grids[cell(geom)]['removed'] += 1
        grids[cell(geom)]['uncoveredM2'] += uncovered.area
    write_rows(output / 'removed.jsonl.gz', detail)
    write_rows(output / 'added.jsonl.gz', added)
    clip = union_all([polygon(rings) for rings in after['coverage']])
    fields = ['gridX', 'gridZ', 'coverageKm2', 'before', 'after', 'removed', 'densityDeltaPerKm2', 'uncoveredM2']
    with (output / 'grid-1km.csv').open('w', newline='') as file:
        writer = csv.writer(file)
        writer.writerow(fields)
        for (x, z), n in sorted(grids.items()):
            area = clip.intersection(box(x*1000, z*1000, (x+1)*1000, (z+1)*1000)).area / 1e6
            writer.writerow([x, z, round(area, 5), n['before'], n['after'], n['removed'],
                             round((n['after'] - n['before']) / area, 2) if area else '', round(n['uncoveredM2'], 2)])
    minx, minz, maxx, maxz = clip.bounds
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx-500} {minz-1200} {maxx-minx+1000} {maxz-minz+1750}">',
           f'<rect x="{minx-500}" y="{minz-1200}" width="{maxx-minx+1000}" height="{maxz-minz+1750}" fill="#f4f6f7"/>',
           f'<text x="{minx}" y="{minz-625}" font-size="430" font-family="sans-serif">GloBFP 退包分布 · 每格 1 km · 北向上 · 浅色为低密度</text>']
    for (x, z), n in sorted(grids.items()):
        colour = '#b03a25' if n['removed'] else '#6c8292'
        alpha = min(0.92, 0.10 + n['removed'] / 280) if n['removed'] else 0.12
        svg.append(f'<rect x="{x*1000}" y="{z*1000}" width="980" height="980" fill="{colour}" opacity="{alpha:.3f}"/>')
        if n['removed']:
            svg.append(f'<text x="{x*1000+100}" y="{z*1000+570}" font-size="290" font-family="sans-serif">{n["removed"]}</text>')
    (output / 'distribution.svg').write_text('\n'.join([*svg, '</svg>']))
    sample_data = {}
    for identity, (lon, lat, r) in SAMPLES.items():
        x, z = project(lon, lat)
        candidates = [row for row in detail if abs(row['x'] - x) <= r and abs(row['z'] - z) <= r]
        sample_data[identity] = {'center': [lon, lat], 'halfWidthM': r,
                                 'removed': len(candidates), 'coverage': Counter(row['coverage'] for row in candidates),
                                 'sample': sorted(candidates, key=lambda row: (row['x'] - x)**2 + (row['z'] - z)**2)[:8]}
    write_json(output / 'sample-candidates.json', sample_data)
    return {'before': summary(old, part_ids), 'after': summary(new, part_ids),
            'removed': summary(removed, part_ids), 'added': summary(added, part_ids),
            'overlapClasses': coverage, 'areaM2': {k: round(sum(row[k] for row in detail), 2)
                                                   for k in ('areaM2', 'coveredM2', 'uncoveredM2')},
            'overlapAreaBySourceM2': {source: round(sum(row['coveredBySourceM2'].get(source, 0)
                                                       for row in detail), 2)
                                      for source in ('osm', 'overture')},
            'changedRetainedRows': len(shifts), 'changedFields': Counter(k for row in shifts for k in row['fields']),
            'changedEstimateGroups': len(estimate_shifts),
            'changedRegionLinks': len(region_changes),
            'regionAddedRetainedLinks': sum(len(v['added']) for v in region_changes.values()),
            'nonBuildingPayloadChanges': [k for k in sorted(before.keys() | after.keys())
                                          if k != 'buildings' and before.get(k) != after.get(k)],
            'samples': {k: {a: b for a, b in v.items() if a != 'sample'} for k, v in sample_data.items()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('before', type=Path)
    ap.add_argument('after', type=Path)
    ap.add_argument('output', type=Path)
    args = ap.parse_args()
    from geo import PHASE1_BBOX
    from osm import read_osm
    from package_validation import ROOT, verify_sources
    osm, = verify_sources(source_ids=('osm-guangdong',))
    inputs = read_osm(PHASE1_BBOX, pbf=ROOT / osm['file'], source_sha256=osm['sha256'])
    part_ids = {row['id'] for row in inputs['buildings'] if 'building:part' in row['tags']}
    args.output.mkdir(parents=True, exist_ok=True)
    def payload_and_report(root):
        return load(root / 'js/sz-city.json.gz'), json.loads((root / 'data/source/build-report.json').read_text())
    before, before_report = payload_and_report(args.before)
    after, after_report = payload_and_report(args.after)
    result = compare(before, after, before_report, after_report, part_ids, args.output)
    write_json(args.output / 'summary.json', result)


if __name__ == '__main__':
    main()
