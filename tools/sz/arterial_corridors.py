"""复用源路网整理三条干道的重复连接和中央分隔带。"""

from collections import Counter
import json
import math
from pathlib import Path

from shapely import make_valid
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from commercial_paving import ground_carriageway_mask
from package_validation import ring_points
from road_frontage import _encode_surface, _ground, _way_line
from roadgraph import graph_components

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/arterial-corridors.json'


def omit_reviewed_duplicates(graph, report, manifest):
    """只删除节点、方向、断面和中心线一致的指定重复边，返回索引映射。"""
    reviewed = {row[key] for row in manifest['duplicates'] for key in ('omit', 'keep')}
    indices = {}
    for i, meta in enumerate(graph['metadata']):
        way = meta['osmId']
        if way in reviewed:
            if way in indices:
                raise ValueError(f'Reviewed duplicate was split: {way}')
            indices[way] = i
    omitted = set()
    for row in manifest['duplicates']:
        keep = indices[row['keep']]
        omit = indices.get(row['omit'])
        if omit is None:
            continue
        a, b = graph['links'][omit], graph['links'][keep]
        ma, mb = graph['metadata'][omit], graph['metadata'][keep]
        if (a[:4] != b[:4] or a[5:] != b[5:] or a[4] != 0 or b[4] < 2 or a[5] != 1
                or not _ground(ma) or not _ground(mb) or ma['highway'] != mb['highway']
                or ma.get('drive') or mb.get('drive', {}).get('closed')
                or [graph['nodeIds'][i] for i in b[:2]] != row['nodes']):
            raise ValueError(f"Reviewed duplicate no longer matches: {row['omit']}")
        if any(row['omit'] in (rule['fromWayId'], *rule['toWayIds'], *rule['viaWayIds'])
               for rule in graph.get('turnRestrictions', {}).get('rules', [])):
            raise ValueError(f"Reviewed duplicate now has a turn restriction: {row['omit']}")
        omitted.add(omit)
    remap = {}
    if omitted:
        kept = []
        for i, pair in enumerate(zip(graph['links'], graph['metadata'], strict=True)):
            if i not in omitted:
                remap[i] = len(kept)
                kept.append(pair)
        graph['links'], graph['metadata'] = map(list, zip(*kept, strict=True))
        report['roadGraph'].update(links=len(kept),
                                   lengthKm=round(sum(row['lengthM'] for row in graph['metadata']) / 1000, 2),
                                   widthSources=dict(Counter(row['widthSource'] for row in graph['metadata'])),
                                   connectivity=graph_components(len(graph['nodeIds']), graph['links']))
    report['arterialDuplicateReview'] = manifest['duplicates']
    return remap


def remap_structure_indices(payload, report, remap):
    # 两段仅在地面重复。桥隧与滨水仍引用原有源边，只调整数组索引。
    if not remap:
        return
    plan = payload['roadStructures']
    audit = report['roadStructures']
    for row in [*plan['records'], *audit['segments']]:
        row['index'] = remap[row['index']]
    for row in [*plan.get('connections', []), *audit.get('connections', [])]:
        for key in ('ramp', 'incoming', 'outgoing'):
            row[key] = remap[row[key]]
    for bridges in (payload['waterfront']['roadBridges'], report['waterfrontSamples']['roadBridges']):
        for bridge in bridges:
            bridge['edges'] = [remap[i] for i in bridge['edges']]
            for portal in bridge['portals']:
                portal['edge'] = remap[portal['edge']]


def _segments(graph, name, excluded):
    for i, (link, meta) in enumerate(zip(graph['links'], graph['metadata'], strict=True)):
        a, b, road_name, width, _, direction, inner = link
        if (graph['names'][road_name] != name or i in excluded or not _ground(meta)
                or direction != 1 or meta['highway'].endswith('_link')):
            continue
        points = [graph['nodes'][a * 2:a * 2 + 2], *zip(inner[::2], inner[1::2]), graph['nodes'][b * 2:b * 2 + 2]]
        for p, q in zip(points, points[1:]):
            length = math.dist(p, q)
            if length >= 0.5:
                yield (LineString([p, q]), width, meta['osmId'])


def _paired_strip(first, second, max_gap):
    line, width, _ = first
    other, other_width, _ = second
    a, b = line.coords
    c, d = other.coords
    length, other_length = line.length, other.length
    dx, dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    u = (c[0] - a[0]) * dx + (c[1] - a[1]) * dz
    v = (d[0] - a[0]) * dx + (d[1] - a[1]) * dz
    if u - v < 0.90 * other_length:
        return None
    start, end = max(0, v), min(length, u)
    if end - start < 0.05:
        return None

    def project_at(s):
        t = (s - u) / (v - u)
        return c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t

    p, q = project_at(start), project_at(end)
    offsets = [(x - a[0]) * dz - (z - a[1]) * dx for x, z in (p, q)]
    if offsets[0] * offsets[1] <= 0 or max(map(abs, offsets)) > (width + other_width) / 2 + max_gap:
        return None
    return Polygon([(a[0] + s * dx, a[1] + s * dz) for s in (start, end)] + [q, p])


def compile_arterial_medians(payload, osm, manifest, report):
    graph = payload['roadGraph']
    frontage = payload['roadFrontage']
    suffix = '-arterial-median'
    frontage['features'] = [f for f in frontage['features'] if not f['id'].endswith(suffix)]
    # 仅同层双幅主线围合。排除高架及隧道进出段，保留已核实的上盖和场地。
    excluded = {row['index'] for row in payload['roadStructures']['records']}
    masks = [Polygon(list(zip(ring[::2], ring[1::2])))
             for row in frontage['features'] if row['kind'] in ('median', 'sidewalk', 'paving')
             for ring in row['outlines']]
    walk_lines = [_way_line(way) for way in osm['roads']
                  if way['tags'].get('highway') in ('footway', 'cycleway', 'pedestrian', 'path', 'steps')
                  and not any(way['tags'].get(key, 'no') not in ('no', '0') for key in ('bridge', 'tunnel', 'layer'))]
    walk_index = STRtree(walk_lines)
    building_shapes = [Polygon(rings[0], rings[1:]) for rings in
                       (list(map(ring_points, rings)) for rings, h in
                        zip(payload['buildings']['rings'], payload['buildings']['minH'], strict=True) if h < 0.3)]
    building_index = STRtree(building_shapes)
    structure_masks = []
    for row in payload['roadStructures']['records']:
        if row['kind'] == 'bridge':
            continue
        stations = row['stations']
        left = list(zip(stations[4::8], stations[5::8]))
        right = list(zip(stations[6::8], stations[7::8]))
        structure_masks.append(make_valid(Polygon(left + right[::-1])).buffer(0.36))
    rows = []
    for name, style in manifest['style'].items():
        segments = list(_segments(graph, name, excluded))
        lines = [part[0] for part in segments]
        index = STRtree(lines)
        strips, ids = [], set()
        for i, first in enumerate(segments):
            for j in sorted(index.query(lines[i], predicate='dwithin', distance=85)):
                if j <= i:
                    continue
                strip = _paired_strip(first, segments[j], 6 if style == 'separator' else 40)
                if strip is not None:
                    strips.append(strip)
                    ids.update((first[2], segments[j][2]))
        if not strips:
            continue
        area = make_valid(unary_union(strips))
        mask, _ = ground_carriageway_mask(area, graph)
        passages = [walk_lines[i].buffer(1.8) for i in walk_index.query(area, predicate='intersects')]
        buildings = [make_valid(building_shapes[i]) for i in building_index.query(area)]
        island = area.difference(unary_union([mask.buffer(0.36), *masks, *passages, *buildings, *structure_masks]))
        # 去掉交角残片，保留连续窄带。平贴地面，不改变路口通行高度。
        island = island.buffer(-0.23).buffer(0.23)
        feature = _encode_surface('median', ids, island)
        if feature['trianglesXZ']:
            frontage['features'].append({**feature, 'id': name + suffix, 'arterialStyle': style})
            rows.append({'road': name, 'style': style, 'areaM2': round(island.area, 2), 'sourceWayIds': sorted(ids)})
    report['arterialMedianDesign'] = {'placementSource': 'estimated-between-existing-osm-carriageways',
                                     'evidence': manifest['evidence'], 'roads': rows}
    report['roadFrontage'].update(features=len(frontage['features']),
                                 planarTriangles=sum(len(f['trianglesXZ']) // 6 for f in frontage['features']))
