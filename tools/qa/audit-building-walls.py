"""从锁定城市包离线筛查共边墙体。审计报告不修改场景或数据包。"""

import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
import math
from pathlib import Path
import struct
import subprocess

from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]


def load_relations():
    output = subprocess.check_output(['node', '--input-type=module', '-e',
        "import { BUILDING_ENVELOPE_RELATIONS as rows } from './js/sz-building-envelope-relations.js';"
        'console.log(JSON.stringify(rows));'], cwd=ROOT, text=True)
    return json.loads(output)


def ring(encoded):
    x, z = encoded[:2]
    points = [(x / 10, z / 10)]
    for dx, dz in zip(encoded[2::2], encoded[3::2]):
        x += dx
        z += dz
        points.append((x / 10, z / 10))
    return points


def terrain_height(grid, x, z):
    # 与 sz-terrain.js 使用同一格网对角线和足迹包围盒中心。
    fx, fz = (x - grid['x0']) / grid['step'], (z - grid['z0']) / grid['step']
    nx, nz = grid['nx'], grid['nz']
    if not (0 <= fx <= nx - 1 and 0 <= fz <= nz - 1):
        return None
    i, j = min(math.floor(fx), nx - 2), min(math.floor(fz), nz - 2)
    u, v = fx - i, fz - j
    a, b, c, d = (grid['heights'][row * nx + col] * grid['heightScale']
                  for row, col in ((j, i), (j, i + 1), (j + 1, i), (j + 1, i + 1)))
    if u + v <= 1:
        return a + (b - a) * u + (c - a) * v
    return d + (c - d) * (1 - u) + (b - d) * (1 - v)


def same_side_wall(a, b, shared):
    if shared.geom_type == 'LineString':
        points = list(shared.coords)
        for (x0, z0), (x1, z1) in zip(points, points[1:]):
            length = math.hypot(x1 - x0, z1 - z0)
            if length < 0.05:
                continue
            nx, nz = (z1 - z0) * 0.001 / length, (x0 - x1) * 0.001 / length
            x, z = (x0 + x1) / 2, (z0 + z1) / 2
            sides = [Point(x + nx, z + nz), Point(x - nx, z - nz)]
            if any(a.contains(point) and b.contains(point) for point in sides):
                return True
    return any(same_side_wall(a, b, part) for part in getattr(shared, 'geoms', ()))


def classify(a, b, shared, ordinary_ids, relation):
    if ordinary_ids is not None and any(row['id'] not in ordinary_ids for row in (a, b)):
        return 'reviewed-scene-takeover' if relation else 'not-in-ordinary-scene'
    if any(row['landmark'] or row['foundation'] or row['role'] in ('bridge', 'canopy') for row in (a, b)):
        return 'landmark-or-special-structure'
    if a['worldY'] is None or b['worldY'] is None:
        return 'missing-placement'
    bottom = max(a['worldY'][0], b['worldY'][0])
    top = min(a['worldY'][1], b['worldY'][1])
    if top <= bottom:
        return 'vertically-separated'
    if not same_side_wall(a['polygon'], b['polygon'], shared):
        return 'no-same-side-wall'
    duplicate = a['worldY'] == b['worldY'] and a['polygon'].equals(b['polygon'])
    if relation:
        if relation['kind'] == 'duplicate-volume' and not duplicate:
            return 'reviewed-duplicate-drift'
        return 'reviewed-' + relation['kind']
    if duplicate:
        return 'unreviewed-duplicate-volume'
    if a['relativeY'][0] > 0 or b['relativeY'][0] > 0:
        return 'unreviewed-raised-part'
    return 'unreviewed-overlap'


def scan(raw, relations, ordinary_ids):
    buildings, enums = raw['buildings'], raw['enums']
    foundations = {row['id']: row['baseY'] for row in raw.get('golfCourse', {}).get('foundations', [])}
    relation_by_id = {source: row for row in relations for source in row['sourceIds']}
    rows, invalid = [], []
    for i, (building_id, rings) in enumerate(zip(buildings['id'], buildings['rings'])):
        shape = Polygon(ring(rings[0]), [ring(hole) for hole in rings[1:]])
        if not shape.is_valid or shape.is_empty:
            invalid.append(building_id)
            continue
        x0, z0, x1, z1 = shape.bounds
        ground = terrain_height(raw['terrain'], (x0 + x1) / 2, (z0 + z1) / 2)
        base = foundations.get(building_id, ground)
        low, high = buildings['minH'][i], buildings['h'][i]
        world_y = None if base is None else [base + low, struct.unpack('f', struct.pack('f', base + high))[0]]
        rows.append(dict(id=building_id, polygon=shape, worldY=world_y, relativeY=[low, high],
                         landmark=buildings['lm'][i] >= 0, foundation=building_id in foundations,
                         role=enums['buildingRole'][buildings['role'][i]]))
    index = STRtree([row['polygon'] for row in rows])
    pairs = []
    for i, a in enumerate(rows):
        shape = a['polygon']
        for j in sorted(index.query(shape, predicate='intersects')):
            if j <= i:
                continue
            b = rows[j]
            other = b['polygon']
            shared = shape.boundary.intersection(other.boundary)
            if shared.length < 1:
                continue
            area = shape.intersection(other).area
            if area < 1:
                continue
            relation = relation_by_id.get(a['id'])
            if relation is not relation_by_id.get(b['id']):
                relation = None
            low, high = zip(a['relativeY'], b['relativeY'])
            pairs.append(dict(ids=[a['id'], b['id']], sharedM=round(shared.length, 3),
                intersectionM2=round(area, 3), smallerCoverage=round(area / min(shape.area, other.area), 5),
                researchCandidate=min(high) - max(low) >= 1, worldY=[a['worldY'], b['worldY']],
                relation=relation['id'] if relation else None,
                status=classify(a, b, shared, ordinary_ids, relation)))
    return invalid, pairs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=ROOT / 'js/sz-city.json.gz')
    parser.add_argument('--ordinary-ids', type=Path, help='JSON array of ordinary building collider source IDs from the formal baseline')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    blob = args.package.read_bytes()
    raw = json.loads(gzip.decompress(blob))
    ids = set(json.loads(args.ordinary_ids.read_text())) if args.ordinary_ids else None
    invalid, pairs = scan(raw, load_relations(), ids)
    prior = [pair for pair in pairs if pair['researchCandidate']]
    summary = dict(packageSha256=sha256(blob).hexdigest(), buildings=len(raw['buildings']['id']),
                   ordinarySourceIds=len(ids) if ids is not None else None, invalid=len(invalid),
                   researchPairs=len(prior), researchStatus=dict(sorted(Counter(p['status'] for p in prior).items())),
                   allPairs=len(pairs), allStatus=dict(sorted(Counter(p['status'] for p in pairs).items())))
    args.output.write_text(json.dumps(dict(summary=summary, invalid=invalid, pairs=pairs), ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
