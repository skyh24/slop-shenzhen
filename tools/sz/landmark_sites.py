"""按地标清单里的 OSM 对象 ID 提取场地、湖泊、车站等院落轮廓。

只读出 landmarks.json 已人工核对的 `osm` 字段引用的对象，不按名称模糊匹配；
输出局部米制坐标的分米差分环，供运行期地标模型对位使用。
"""

import json
from pathlib import Path

import osmium
from shapely.geometry import Polygon

from geo import project
from land import _to_local
from osm import PBF

ROOT = Path(__file__).resolve().parents[2]
LANDMARKS = ROOT / 'data/source/landmarks.json'
SNAPSHOT = 'osm-guangdong'
WAY_OR_RELATION = ('way', 'relation')


def collect_requests(landmarks):
    """返回 {(kind, osm_id): [(landmark_id, role), ...]}，跳过节点和非法 ID。"""
    requests = {}
    for landmark in landmarks:
        for role, value in (landmark.get('osm') or {}).items():
            values = value if isinstance(value, list) else [value]
            for source_id in values:
                if not isinstance(source_id, str) or '/' not in source_id:
                    continue
                kind, number = source_id.split('/', 1)
                if kind not in WAY_OR_RELATION or not number.isdigit():
                    continue
                requests.setdefault((kind, int(number)), []).append((landmark['id'], role))
    return requests


def _encode_ring(coords, strip_closure=True):
    points = list(coords)
    if strip_closure and len(points) > 1 and points[0] == points[-1]:
        points = points[:-1]
    flat, px, pz = [], 0, 0
    for x, z in points:
        ix, iz = round(x * 10), round(z * 10)
        flat += [ix - px, iz - pz]
        px, pz = ix, iz
    return flat


def _encode_geometry(geom):
    """面几何编码成多边形列表；每个多边形第一环是外环，其余是内环。"""
    if geom.geom_type == 'Polygon':
        polygons = [geom]
    else:
        polygons = [part for part in getattr(geom, 'geoms', []) if part.geom_type == 'Polygon']
    encoded = []
    for polygon in polygons:
        if polygon.is_empty or polygon.area <= 1e-6:
            continue
        rings = [_encode_ring(polygon.exterior.coords)]
        rings += [_encode_ring(interior.coords) for interior in polygon.interiors if len(interior.coords) >= 4]
        encoded.append(rings)
    return encoded


def read_site_areas(requests, pbf=PBF):
    """单次扫描 PBF，返回 {(kind, osm_id): {'osmId', 'polygons'}}。

    按 ID 过滤时 pyosmium 不组装 Area 对象，闭合 way 在这里直接按节点坐标编码；
    relation 的 multipolygon 组装与本次场地用途无关，遇到关系对象跳过并记入缺失。
    """
    wanted = {number for (_kind, number) in requests}
    if not wanted:
        return {}
    found = {}
    reader = (osmium.FileProcessor(str(pbf)).with_locations()
              .with_filter(osmium.filter.IdFilter(wanted))
              .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)))
    for obj in reader:
        if not obj.is_closed() or len(obj.nodes) < 4:
            continue
        try:
            coords = [project(node.lon, node.lat) for node in obj.nodes]
        except osmium.InvalidLocationError:
            continue
        polygon = Polygon(coords)
        encoded = _encode_geometry(polygon)
        if not encoded:
            continue
        found[('way', obj.id)] = {'osmId': f'way/{obj.id}', 'polygons': encoded}
    return found


def compile_sites(landmarks, areas, requests):
    sites = {}
    missing = []
    for (kind, osm_id), usages in sorted(requests.items()):
        key = (kind, osm_id)
        if key not in areas:
            missing.append({'osmId': f'{kind}/{osm_id}', 'roles': [f'{lm}:{role}' for lm, role in usages]})
            continue
        for landmark_id, role in usages:
            sites.setdefault(landmark_id, {})[role] = dict(areas[key])
    return sites, missing


def build_landmark_sites(manifest, report, pbf=PBF, *, area_entries=()):
    requests = collect_requests(manifest)
    areas = read_site_areas(requests, pbf=pbf)
    # 已经由 PBF 装配器解析的关系面可直接复用，避免重复扫描或用名称猜测。
    for entry in area_entries:
        kind, number = entry['id'].split('/')
        key = (kind, int(number))
        if key in requests and key not in areas:
            polygons = _encode_geometry(_to_local(entry['geom']))
            if polygons:
                areas[key] = {'osmId': entry['id'], 'polygons': polygons}
    sites, missing = compile_sites(manifest, areas, requests)
    report['landmarkSites'] = {
        'source': SNAPSHOT,
        'requestedObjects': len(requests),
        'resolvedObjects': len(areas),
        'landmarks': sum(1 for lm in manifest if lm['id'] in sites),
        'roles': sum(len(roles) for roles in sites.values()),
        'missing': missing[:50],
        'missingCount': len(missing),
    }
    return {'version': 1, 'source': SNAPSHOT, 'sites': sites}


if __name__ == '__main__':
    manifest = json.loads(LANDMARKS.read_text())['landmarks']
    report = {}
    payload = build_landmark_sites(manifest, report)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print({key: sorted(roles) for key, roles in payload['sites'].items()})
