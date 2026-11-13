"""用源街道、地块与步道补齐局部地面；显示和通行仍使用同一批地形三角面。"""

import json
from collections import defaultdict
from pathlib import Path

from shapely import STRtree, prepare, union_all
from shapely.geometry import LineString, box

from audit_shopping_park import packaged_polygon
from commercial_paving import ground_carriageway_mask
from land import _to_local
from map_regions import parts, valid_area
from road_frontage import _way_line
from roads import _num
from shenzhen_bay import PAVING, PUBLIC, _lines, _snapshots, _surface_sampler, bay_paving
from urban_paving import LAWN, STONE, _at_grade, _frontage_reservations, _partition, _source_masks

SOURCE = Path(__file__).resolve().parents[2] / 'data/source/ground-walk.json'
GRAVEL = 12


def _polygons(payload, keys, extent):
    return union_all([valid_area(p) for key in keys for rings in payload[key]
                      if extent.intersects(p := packaged_polygon(rings))])


def _candidate(identity, surface, kind, base):
    return {'id': identity, 'kind': 'stone', 'surfaceKind': kind, 'baseKinds': base}, surface


def _cover_candidates(roadside, asphalt, buildings, parcels, protected):
    # 先在源地块内补面向道路的建筑前场，再给剩余近路空间铺草。
    free = roadside.difference(protected.union(buildings).union(asphalt))
    fronts = union_all([parcel for parcel, _ in parcels.values()])
    near_front = buildings.buffer(8).intersection(asphalt.buffer(24))
    stone = free.intersection(fronts).intersection(near_front)
    lawn = free.intersection(asphalt.buffer(9)).difference(near_front.union(fronts))

    def usable(shape, area, radius):
        return union_all([p for p in parts(shape) if p.area >= area and not p.buffer(-radius).is_empty])
    return usable(stone, 10, 0.7), usable(lawn, 12, 0.65)


def _park_candidates(park, osm, pbf, forbidden):
    clear = park.difference(forbidden)
    narrow = clear.buffer(-0.78)
    wide_by_width = {}
    ways = [(row, _way_line(row)) for row in osm['roads']
            if row['tags'].get('highway') in ('footway', 'path', 'pedestrian')]
    ways = [(row, line) for row, line in ways if line.intersects(park)]
    tags = _snapshots(pbf, {row['id'] for row, _ in ways},
                      extra_tags=('footway', 'indoor', 'location', 'smoothness', 'trail_visibility'))
    for row, line in ways:
        t = tags[row['id']]['tags']
        if (not _at_grade(t) or t.get('access') not in PUBLIC or t.get('foot') not in PUBLIC
                or any(key.endswith(':conditional') for key in t) or t.get('opening_hours')
                or t.get('footway') == 'crossing' or t.get('trail_visibility') in ('bad', 'horrible', 'no')):
            continue
        surface = t.get('surface')
        if surface in ('wood', 'metal', 'grass', 'stepping_stones', 'sand', 'mud'):
            continue
        loose = surface in ('fine_gravel', 'gravel', 'compacted', 'ground', 'dirt', 'earth') or (
            surface is None and t.get('highway') == 'path')
        material = GRAVEL if loose else 5 if surface == 'asphalt' else 4
        width = max(1.4, min(5, _num(t.get('width')) or (1.8 if loose else 2.8)))
        # 逐段裁去禁入区；小路随可用宽度收窄，保留连续可走中心。
        if width not in wide_by_width:
            wide = clear.buffer(-width / 2)
            wide_by_width[width] = ((wide, width), (narrow.difference(wide), 1.55))
        for safe, actual in wide_by_width[width]:
            for part in _lines(line.intersection(safe)):
                if part.length < 2:
                    continue
                yield row['id'], part, actual, material, part.buffer(actual / 2, quad_segs=6).intersection(clear)


def compile_ground_walk(payload, osm, source, report):
    plan = json.loads(SOURCE.read_text())
    if source['sha256'] != plan['osmSnapshotSha256'] or osm['sourceSha256'] != source['sha256']:
        raise ValueError('Ground walk requires the reviewed OSM snapshot')
    root = SOURCE.parents[2]
    pbf = root / source['file']
    ways = {row['id']: row for row in osm['roads']}
    streets = union_all([_way_line(ways[id]).buffer(26) for id in plan['roadOsmIds']])
    park_ids = set(plan['parkOsmIds'])
    parks = [(row['id'], valid_area(_to_local(row['geom']))) for row in osm['green'] if row['id'] in park_ids]
    if {identity for identity, _ in parks} != park_ids:
        raise ValueError('Missing reviewed park boundary')
    extent = union_all([streets, *(park.buffer(4) for _, park in parks)])
    dry = _polygons(payload, ('land',), extent)
    wet = _polygons(payload, ('water', 'wetland'), extent)
    green = _polygons(payload, ('green',), extent)
    floors = payload['buildings']
    buildings = union_all([valid_area(p) for rings, h in zip(floors['rings'], floors['minH'], strict=True)
                           if h < 2.4 and extent.intersects(p := packaged_polygon(rings))])
    excluded = []
    parcels, known, lines = _source_masks(pbf, extent, set(),
                                          frontage_uses=('retail', 'commercial', 'office'),
                                          walk_exclusions=excluded)
    reserved = _frontage_reservations(payload, extent)
    road, _ = ground_carriageway_mask(extent, payload['roadGraph'])
    ground = payload['terrainSurface']
    candidates, routes, park_lengths = [], [], defaultdict(float)
    for park_id, park in parks:
        # 已有滨水、公园和街道面另有所有者；这里只补源线缺失的部分。
        barrier = union_all([wet, buildings, road, union_all(excluded)]).buffer(0.20)
        for osm_id, path, width, material, mask in _park_candidates(park.intersection(dry), osm, pbf, barrier):
            identity = f'{park_id}:{osm_id}:{len(routes)}'
            routes.append((identity, path, width))
            candidates.append(_candidate(identity, mask.difference(reserved), material, (0, 1, None)))
            park_lengths[park_id] += path.length

    stone, lawn = _cover_candidates(streets.intersection(dry), road, buildings, parcels,
                                    union_all([wet, green, known, lines, reserved]))
    candidates += [_candidate('street-stone', stone, STONE, (0,)), _candidate('street-lawn', lawn, LAWN, (0,))]

    # 旧包迁移只重标滨水生成器覆盖的三角面；新包已保留中湾材质。
    bay, _, _ = bay_paving(payload['shenzhenBay']['paths'], payload['roadGraph'])
    bay_candidates = [f'bay-{name}' for name, kind in PAVING.items() if kind != 8]
    for name, kind in PAVING.items():
        if kind != 8:
            candidates.append(_candidate(f'bay-{name}', bay[kind], kind, (8, 9)))
    # 沿既有环线换面，保持桥面、道路、树灯位置和岸线高程。
    for route in payload['waterfront']['routes']:
        if route['id'].startswith('lychee-'):
            mask = union_all([LineString(p['points']).buffer(p['widthM'] / 2, quad_segs=6)
                              for p in route['paths'] if not p['bridge']])
            candidates.append(_candidate(route['id'], mask, 4, (8,)))

    candidates = [(spec, mask) for spec, mask in candidates if not mask.is_empty]
    masks = [mask for _, mask in candidates]
    index = STRtree(masks)
    for mask in masks:
        prepare(mask)
    covered = {spec['id']: [] for spec, _ in candidates}
    chunks, changed = [], []
    size = ground['chunkSize']
    for chunk in ground['chunks']:
        x, z = chunk['origin']
        local = [candidates[i] for i in sorted(index.query(box(x, z, x + size, z + size), predicate='intersects'))]
        result = _partition(chunk, local, covered) if local else chunk
        chunks.append(result)
        if result is not chunk:
            changed.append(chunk['id'])
    payload['terrainSurface'] = {**ground, 'chunks': chunks}
    walks = payload['urbanPaving']['publicRoutes']
    walks[:] = [row for row in walks if not row['id'].startswith('park-ground:')]
    sample = _surface_sampler(payload['terrainSurface'], extent)
    for identity, line, width in routes:
        # 物理步道可接既有铺装；只有具备沿线支撑的路线才注册人群通行。
        points = [[round(x, 3), round(z, 3)] for x, z in line.coords]
        if any(sample(*line.interpolate(i / 10, normalized=True).coords[0]) is None for i in range(11)):
            continue
        walks.append({'id': f'park-ground:{identity}', 'evidence': SOURCE.name, 'pointsXZ': points,
                      'widthM': width, 'lateralM': 0.10 if width >= 1.9 else 0})
    report['groundWalk'] = {'source': SOURCE.name, 'osmSnapshotSha256': source['sha256'], 'changedChunks': changed,
                           'parkCenterlineM': {k: round(v, 2) for k, v in park_lengths.items()},
                           'parkWalkRoutes': sum(row['id'].startswith('park-ground:') for row in walks),
                           'pavedM2': {k: round(sum(p.area for p in covered.get(k, ())), 2)
                                       for k in ('street-stone', 'street-lawn', *bay_candidates)}}
    report['terrainSurface'].update(vertices=sum(len(c['kinds']) for c in chunks),
                                    triangles=sum(len(c['indices']) // 3 for c in chunks))
