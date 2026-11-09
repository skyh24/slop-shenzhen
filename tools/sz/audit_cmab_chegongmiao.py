"""复核车公庙 CMAB v7 候选屋顶，输出独立于城市构建的审计。"""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import itertools
import json
import math
from pathlib import Path
import re
from statistics import median
import struct
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
from zipfile import ZipFile

import osmium
from shapely.geometry import LinearRing, MultiPolygon, Polygon

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project, project_coords
from osm import KEEP_TAGS

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_SOURCES = ('cmab-v7-guangdong-prd1-range', 'cmab-v7-guangdong-zip-tail')
MEMBER = '广东省/processed_zhusanjiaoyi20220302_all'
SUFFIXES = ('.cpg', '.prj', '.shx', '.shp', '.dbf')
SITE_IDS = (1163682854, 545225957, 545225959)
SITE_FRACTION = 0.5
HIGH_IOU = 0.55
MERCATOR_RADIUS = 6378137.0
DOWNLOAD_BLOCK = 8 * 1024 * 1024


def byte_range(record):
    match = re.fullmatch(r'bytes=(\d+)-(\d+)', record['range'])
    if not match:
        raise ValueError(f'Invalid locked byte range: {record["id"]}')
    start, last = map(int, match.groups())
    if start + record['bytes'] != last + 1:
        raise ValueError(f'Locked byte count disagrees with the range: {record["id"]}')
    return start, last + 1


def verify_source(path, record):
    if path.stat().st_size != record['bytes']:
        raise ValueError(f'Locked source has a different size: {record["id"]}')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != record['sha256']:
        raise ValueError(f'Locked source has a different SHA-256: {record["id"]}')


def download_range(record, archive_size):
    start, stop = byte_range(record)
    target = ROOT / record['file']
    target.parent.mkdir(parents=True, exist_ok=True)
    blocks = [(offset, min(offset + DOWNLOAD_BLOCK, stop)) for offset in range(start, stop, DOWNLOAD_BLOCK)]

    def fetch(block):
        first, end = block
        last = end - 1
        url = f'{record["url"]}?cmab_slice={first}-{last}'
        request = Request(url, headers={'Range': f'bytes={first}-{last}', 'Accept-Encoding': 'identity',
                                        'User-Agent': 'Slop Shenzhen CMAB audit'})
        with urlopen(request, timeout=45) as response:
            if response.status != 206 or response.headers.get('Content-Range') != f'bytes {first}-{last}/{archive_size}':
                raise ValueError(f'Expected the locked HTTP byte range {first}-{last}')
            payload = response.read(end - first + 1)
        if len(payload) != end - first:
            raise ValueError(f'Incomplete HTTP byte range {first}-{last}')
        return payload

    with TemporaryDirectory(dir=target.parent) as stage:
        path = Path(stage) / target.name
        with path.open('wb') as output, ThreadPoolExecutor(max_workers=4) as pool:
            # 分组读取限制并行缓冲量，只写通过范围核对的块。
            for offset in range(0, len(blocks), 4):
                for payload in pool.map(fetch, blocks[offset:offset + 4]):
                    output.write(payload)
        verify_source(path, record)
        path.replace(target)


class ArchiveWindow:
    """只开放已下载的连续末段，供 ZIP 读取目录和锁定成员。"""

    def __init__(self, body, start, tail):
        self.body = body
        self.start = start
        self.tail = tail
        self.tail_start = start + body.seek(0, io.SEEK_END)
        self.size = self.tail_start + len(tail)
        self.offset = 0

    def seek(self, offset, whence=io.SEEK_SET):
        origin = {io.SEEK_SET: 0, io.SEEK_CUR: self.offset, io.SEEK_END: self.size}[whence]
        self.offset = origin + offset
        return self.offset

    def tell(self):
        return self.offset

    def seekable(self):
        return True

    def read(self, size=-1):
        offset = self.offset
        if offset >= self.size:
            return b''
        if offset < self.start:
            raise ValueError('ZIP requested bytes outside the locked download window')
        end = self.size if size < 0 else min(offset + size, self.size)
        body = b''
        if offset < self.tail_start:
            self.body.seek(offset - self.start)
            body = self.body.read(min(end, self.tail_start) - offset)
        if end > self.tail_start:
            body += self.tail[max(offset - self.tail_start, 0):end - self.tail_start]
        self.offset += len(body)
        return body


def site_footprints(pbf):
    sites = {}
    reader = osmium.FileProcessor(str(pbf)).with_locations().with_filter(osmium.filter.IdFilter(SITE_IDS))
    for obj in reader:
        if obj.type_str() == 'w' and obj.id in SITE_IDS:
            polygon = Polygon(project_coords((node.lon, node.lat) for node in obj.nodes))
            if not polygon.is_valid or polygon.area <= 0:
                raise ValueError(f'Invalid OSM pilot footprint: way/{obj.id}')
            sites[obj.id] = polygon
    if sites.keys() != set(SITE_IDS):
        raise ValueError('Missing OSM pilot footprint')
    return {identity: sites[identity] for identity in SITE_IDS}


def decode_ring(sequence):
    xs = itertools.accumulate(sequence[::2])
    zs = itertools.accumulate(sequence[1::2])
    return [(x / 10, z / 10) for x, z in zip(xs, zs, strict=True)]


def intersects_bounds(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def city_sites(city, sites):
    if city['version'] != 2 or city['origin'] != [ORIGIN_LON, ORIGIN_LAT]:
        raise ValueError('Unsupported city package coordinate encoding')
    pack, enums = city['buildings'], city['enums']
    bounds = {key: polygon.bounds for key, polygon in sites.items()}
    by_site = {key: [] for key in sites}
    for i, rings in enumerate(pack['rings']):
        outer = decode_ring(rings[0])
        xs, zs = zip(*outer)
        footprint_bounds = min(xs), min(zs), max(xs), max(zs)
        possible = [key for key in sites if intersects_bounds(footprint_bounds, bounds[key])]
        if not possible:
            continue
        polygon = Polygon(outer, [decode_ring(hole) for hole in rings[1:]])
        if not polygon.is_valid or polygon.area <= 0:
            continue
        for key in possible:
            fraction = polygon.intersection(sites[key]).area / polygon.area
            if fraction >= SITE_FRACTION:
                by_site[key].append({'id': pack['id'][i], 'fraction': round(fraction, 4), 'area': round(polygon.area, 1),
                                     'height': pack['h'][i], 'minHeight': pack['minH'][i],
                                     'category': enums['category'][pack['cat'][i]],
                                     'heightSource': enums['heightSource'][pack['src'][i]], 'polygon': polygon})
    return by_site


def osm_building_tags(pbf, by_site):
    ids = {row['id'] for rows in by_site.values() for row in rows if row['id'].startswith(('way/', 'relation/'))}
    numbers = [int(identity.split('/')[1]) for identity in ids]
    types = {'w': 'way', 'r': 'relation'}
    tags = {}
    for obj in osmium.FileProcessor(str(pbf)).with_filter(osmium.filter.IdFilter(numbers)):
        identity = f'{types.get(obj.type_str())}/{obj.id}'
        if identity in ids:
            tags[identity] = {key: obj.tags[key] for key in KEEP_TAGS if key in obj.tags}
    return tags


def web_mercator(x, z):
    lon = math.radians(ORIGIN_LON + x / KX)
    lat = math.radians(ORIGIN_LAT - z / KY)
    return lon * MERCATOR_RADIUS, math.asinh(math.tan(lat)) * MERCATOR_RADIUS


def local_point(x, y):
    return project(math.degrees(x / MERCATOR_RADIUS), math.degrees(math.atan(math.sinh(y / MERCATOR_RADIUS))))


def read_exact(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise ValueError('Truncated Shapefile member')
    return data


def shape_header(stream, member):
    header = read_exact(stream, 100)
    code, = struct.unpack_from('>I', header)
    words, = struct.unpack_from('>I', header, 24)
    version, shape_type = struct.unpack_from('<II', header, 28)
    if code != 9994 or words * 2 != member.file_size or version != 1000 or shape_type != 5:
        raise ValueError(f'Unsupported polygon Shapefile header: {member.filename}')


def polygon_record(body):
    ring_count, point_count = struct.unpack_from('<II', body, 36)
    first = 44 + ring_count * 4
    points = [local_point(x, y) for x, y in struct.iter_unpack('<2d', body[first:first + point_count * 16])]
    if ring_count == 1:
        return Polygon(points)
    indices = struct.unpack_from(f'<{ring_count}I', body, 44)
    rings = [LinearRing(points[a:b]) for a, b in zip(indices, (*indices[1:], point_count), strict=True)]
    # 投影到 x/z 会翻转方向，外环变为逆时针。
    shells = [Polygon(ring) for ring in rings if ring.is_ccw]
    holes = [ring for ring in rings if not ring.is_ccw]
    return MultiPolygon([Polygon(shell.exterior, [hole for hole in holes if shell.covers(hole)]) for shell in shells])


def selected_roofs(archive, sites):
    site_bounds = {}
    for key, polygon in sites.items():
        west, north, east, south = polygon.bounds
        site_bounds[key] = (*web_mercator(west, south), *web_mercator(east, north))
    candidates, intersects = [], Counter()
    scanned = bbox_hits = invalid = 0
    member = archive.getinfo(MEMBER + '.shp')
    with archive.open(member) as geometry:
        shape_header(geometry, member)
        while header := geometry.read(8):
            fid, words = struct.unpack('>II', header)
            scanned += 1
            if fid != scanned:
                raise ValueError('Non-sequential Shapefile record numbers')
            body = read_exact(geometry, words * 2)
            kind, = struct.unpack_from('<I', body)
            if kind == 0:
                continue
            if kind != 5:
                raise ValueError(f'Unexpected Shapefile record type: {kind}')
            bbox = struct.unpack_from('<4d', body, 4)
            possible = [key for key in sites if intersects_bounds(bbox, site_bounds[key])]
            if not possible:
                continue
            bbox_hits += 1
            polygon = polygon_record(body)
            if not polygon.is_valid or polygon.area <= 0:
                invalid += 1
                continue
            for key in possible:
                if not sites[key].intersects(polygon):
                    continue
                intersects[key] += 1
                fraction = sites[key].intersection(polygon).area / polygon.area
                if fraction >= SITE_FRACTION:
                    candidates.append((fid, key, polygon, fraction))
    return candidates, {'scanned': scanned, 'bboxHits': bbox_hits, 'invalidNearSites': invalid,
                        'intersectingBySite': {key: intersects[key] for key in sites}}


def drain(stream):
    while stream.read(1024 * 1024):
        pass


def index_count(archive):
    member = archive.getinfo(MEMBER + '.shx')
    with archive.open(member) as index:
        shape_header(index, member)
        drain(index)
    count, extra = divmod(member.file_size - 100, 8)
    if extra:
        raise ValueError('Invalid Shapefile index length')
    return count


def read_attributes(archive, fids):
    rows, fields = {}, []
    with archive.open(MEMBER + '.dbf') as attributes:
        header = read_exact(attributes, 32)
        count, header_size, record_size = struct.unpack_from('<IHH', header, 4)
        descriptors = read_exact(attributes, header_size - 32)
        if not descriptors.endswith(b'\r'):
            raise ValueError('Invalid DBF field descriptors')
        offset = 1
        slices = []
        for descriptor, in struct.iter_unpack('32s', descriptors[:-1]):
            name = descriptor[:11].split(b'\x00', 1)[0].decode('ascii')
            length = descriptor[16]
            fields.append({'name': name, 'type': chr(descriptor[11]), 'length': length, 'decimals': descriptor[17]})
            slices.append((name, offset, offset + length))
            offset += length
        if record_size != offset or not {'merged_id', 'Function', 'Height', 'Age'}.issubset(f['name'] for f in fields):
            raise ValueError('Invalid CMAB DBF record schema')
        for fid in sorted(set(fids)):
            attributes.seek(header_size + (fid - 1) * record_size)
            record = read_exact(attributes, record_size)
            if record[:1] != b' ':
                raise ValueError(f'Invalid or deleted CMAB DBF record: {fid}')
            rows[fid] = {name: record[start:end].decode('utf-8').strip() for name, start, end in slices}
        drain(attributes)
    return count, fields, rows


def compare_roofs(candidates, attributes, by_site, tags):
    rows = []
    for fid, key, roof, fraction in candidates:
        scores = []
        for building in by_site[key]:
            footprint = building['polygon']
            shared = roof.intersection(footprint).area
            if shared > 0:
                iou = shared / (roof.area + footprint.area - shared)
                scores.append((iou, shared / roof.area, shared / footprint.area, building))
        scores.sort(key=lambda row: -row[0])
        overlaps = [{'id': b['id'], 'iou': round(iou, 3), 'roofOverlap': round(roof_overlap, 3),
                     'footprintOverlap': round(footprint_overlap, 3), 'category': b['category'], 'height': b['height'],
                     'heightSource': b['heightSource'], 'tags': tags.get(b['id'], {})}
                    for iou, roof_overlap, footprint_overlap, b in scores]
        center = roof.centroid
        rows.append({'fid': fid, 'site': key, 'area': round(roof.area, 2), 'fraction': round(fraction, 3),
                     'centerXZ': [round(center.x, 2), round(center.y, 2)], 'attributes': attributes[fid],
                     'overlaps': overlaps, 'highOverlap': bool(scores and scores[0][0] >= HIGH_IOU)})
    return rows


def audit(city_package, refresh):
    sources = {row['id']: row for row in json.loads((ROOT / 'data/source/sources.json').read_text())['sources']}
    records = [sources[key] for key in ARCHIVE_SOURCES]
    body_start, body_end = byte_range(records[0])
    tail_start, archive_size = byte_range(records[1])
    if body_end != tail_start or len({row['url'] for row in records}) != 1 or any(row['version'] != 7 for row in records):
        raise ValueError('CMAB v7 source windows must be adjacent in the same archive')
    for record in records:
        if refresh:
            download_range(record, archive_size)
        verify_source(ROOT / record['file'], record)
    pbf_record = sources['osm-guangdong']
    pbf = ROOT / pbf_record['file']
    verify_source(pbf, pbf_record)
    package = city_package.read_bytes()
    city = json.loads(gzip.decompress(package))
    sites = site_footprints(pbf)
    by_site = city_sites(city, sites)
    tags = osm_building_tags(pbf, by_site)

    with (ROOT / records[0]['file']).open('rb') as body:
        window = ArchiveWindow(body, body_start, (ROOT / records[1]['file']).read_bytes())
        with ZipFile(window) as archive:
            encoding = archive.read(MEMBER + '.cpg').decode('ascii')
            projection = archive.read(MEMBER + '.prj').decode('ascii')
            if encoding != 'UTF-8' or not projection.startswith('PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere"'):
                raise ValueError('Unexpected CMAB encoding or projection')
            indexed = index_count(archive)
            candidates, scan = selected_roofs(archive, sites)
            count, fields, attributes = read_attributes(archive, (row[0] for row in candidates))
            if count != indexed or count != scan['scanned']:
                raise ValueError('CMAB SHP, SHX and DBF record counts disagree')
            # 五个成员都已读至末尾，ZipFile 已验证各成员 CRC。
            members = [{'file': m.filename, 'crc32': f'{m.CRC:08x}', 'bytes': m.file_size,
                        'compressedBytes': m.compress_size, 'crcVerified': True}
                       for m in (archive.getinfo(MEMBER + suffix) for suffix in SUFFIXES)]

    rows = compare_roofs(candidates, attributes, by_site, tags)
    best = [row['overlaps'][0]['iou'] if row['overlaps'] else 0 for row in rows]
    summary = []
    for key, buildings in by_site.items():
        selected = [row for row in rows if row['site'] == key]
        summary.append({'site': key, 'osmId': f'way/{key}', 'runtimeCount': len(buildings),
                        'runtimeCategoryCounts': Counter(b['category'] for b in buildings),
                        'cmabCount': len(selected), 'highOverlapCount': sum(row['highOverlap'] for row in selected),
                        'cmabFunctionCounts': Counter(row['attributes']['Function'] for row in selected),
                        'runtimeObjects': [{**{k: v for k, v in b.items() if k != 'polygon'}, 'tags': tags.get(b['id'], {})}
                                           for b in buildings]})
    return {'pilot': 'chegongmiao-donghai', 'usage': 'offline-candidate-audit', 'citySha256': hashlib.sha256(package).hexdigest(),
            'osmSource': pbf_record['id'], 'osmSha256': pbf_record['sha256'], 'cmabSources': records,
            'archiveMembers': members, 'encoding': encoding, 'projection': projection, 'crs': 'EPSG:3857',
            'fields': fields, 'scan': scan, 'minimumSiteFraction': SITE_FRACTION, 'highOverlapThreshold': HIGH_IOU,
            'medianBestIoU': median(best) if best else None, 'sites': summary, 'matches': rows}


def main():
    parser = argparse.ArgumentParser(description='Audit the locked CMAB v7 building sample and emit JSON')
    parser.add_argument('--city-package', type=Path, default=ROOT / 'js/sz-city.json.gz',
                        help='city package to compare with the local source data')
    parser.add_argument('--refresh', action='store_true', help='download the two locked v7 byte ranges (344 MiB)')
    args = parser.parse_args()
    print(json.dumps(audit(args.city_package, args.refresh), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
