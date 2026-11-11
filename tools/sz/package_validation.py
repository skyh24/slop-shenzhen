"""格式校验与真实性风险分开报告；过时来源不能因成功打包变成已核实数据。"""

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parents[2]
CORE_SOURCES = ('osm-guangdong', 'overture-buildings', 'globfp-2265', 'globfp-2269')


def sha256(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def verify_sources(root=ROOT, source_ids=CORE_SOURCES):
    records = json.loads((root / 'data/source/sources.json').read_text())['sources']
    indexed = {entry['id']: entry for entry in records}
    verified = []
    for identity in source_ids:
        entry = indexed[identity]
        path = root / entry['file']
        actual = sha256(path)
        if actual != entry['sha256'] or path.stat().st_size != entry['bytes']:
            raise ValueError(f'Source checksum or size mismatch: {identity}')
        verified.append({'id': identity, 'sha256': actual, 'bytes': path.stat().st_size,
                         'release': entry.get('release', entry.get('lastModified')),
                         'referenceYear': 2020 if identity.startswith('globfp-') else None,
                         'observedAt': entry.get('acquiredAt')})
    return verified


def ring_points(flat):
    x, z, points = 0, 0, []
    for dx, dz in zip(flat[::2], flat[1::2]):
        x, z = x + dx, z + dz
        points.append((x / 10, z / 10))
    return points


def audit_payload(payload, raw_bytes, sources):
    subprocess.run(['node', str(ROOT / 'tools/sz/validate-city.mjs')], input=raw_bytes, check=True)
    buildings = payload['buildings']
    # 一个源多面对象可被裁成多个楼体，源 ID 重复不等于重复建筑。
    identities = Counter(buildings['id'])
    records = [(identity, json.dumps(buildings['rings'][i]), buildings['minH'][i], buildings['h'][i])
               for i, identity in enumerate(buildings['id'])]
    if len(set(records)) != len(records):
        raise ValueError('Duplicate building geometry records')
    # 下游索引与显示必须保留同一批三角形；损坏索引是编码阻断项。
    chunks = payload.get('terrainSurface', {}).get('chunks', [])
    for chunk in chunks:
        positions, indices = chunk['positions'], chunk['indices']
        if len(positions) % 3 or len(indices) % 3 or any(
                type(i) is not int or i < 0 or i >= len(positions) // 3 for i in indices):
            raise ValueError(f'Invalid terrain triangle indices: {chunk["id"]}')
    invalid, slender = [], []
    for i, identity in enumerate(buildings['id']):
        rings = [ring_points(ring) for ring in buildings['rings'][i]]
        polygon = Polygon(rings[0], rings[1:])
        if not polygon.is_valid or polygon.area <= 0:
            invalid.append(identity)
        # 仅列待复核项，不能把细长的真实楼直接删除。
        if polygon.area > 0:
            rect = list(polygon.minimum_rotated_rectangle.exterior.coords)
            width = min(((a[0] - b[0])**2 + (a[1] - b[1])**2)**0.5 for a, b in zip(rect, rect[1:]))
            if width > 0 and buildings['h'][i] / width > 12:
                slender.append(identity)
    height_sources = Counter(payload['enums']['heightSource'][index] for index in buildings['src'])
    return {
        'version': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'encodingValidation': 'passed', 'realityValidation': 'incomplete',
        'recentObservationWindow': [2025, 2026],
        'payloadSha256': hashlib.sha256(raw_bytes).hexdigest(),
        'sourceIntegrity': sources,
        'counts': {'buildings': len(buildings['id']), 'terrainChunks': len(chunks)},
        'multipartSourceIds': {key: count for key, count in identities.items() if count > 1},
        'heightSources': dict(height_sources),
        'reviewRequired': {'invalidQuantizedFootprints': invalid, 'heightWidthRatioAbove12': slender},
        'limitations': [
            'Source checksum and schema validation do not prove present-day building existence.',
            'OSM snapshot and Overture release dates are not per-feature observation dates.',
            'GloBFP has a 2020 reference year, outside the requested 2025-2026 window.',
            'Dated imagery checks cover samples only, not all building footprints or heights.',
            'Road conflicts and landmark-site residual footprints still require evidence review.',
            'SZC1 changes storage only; unresolved source geometry is not silently repaired.',
        ],
    }
