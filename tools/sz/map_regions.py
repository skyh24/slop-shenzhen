"""从锁定 OSM 面和生产车行边界生成二维地图区域。"""

from collections import Counter
import json
from pathlib import Path
import subprocess

import osmium
from shapely import STRtree, make_valid, normalize, set_precision, union_all, wkb
from shapely.algorithms.polylabel import polylabel
from shapely.geometry import Point, Polygon, box

from audit_shopping_park import boundary_lines, cut_block, packaged_polygon, wgs84_box
from commercial_paving import FOOTPRINT_HELPER
from geo import PHASE1_BBOX, project
from land import _to_local

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = {'school', 'college', 'university', 'hospital', 'library', 'townhall',
          'community_centre', 'arts_centre', 'theatre', 'fire_station', 'police'}
KINDS = ('retail', 'public', 'park', 'residential', 'office', 'village', 'unknown')


def region_type(tags):
    building = tags.get('building')
    landuse, leisure = tags.get('landuse'), tags.get('leisure')
    if tags.get('location') in ('underground', 'roof', 'rooftop') or tags.get('building:part'):
        return None
    if not building and (landuse == 'retail' or tags.get('shop') == 'mall'):
        return 'retail', 'place'
    if tags.get('amenity') in PUBLIC or tags.get('tourism') == 'museum' or leisure in ('sports_centre', 'stadium'):
        # 建筑本身仍是具体对象，不把它扩成设施园区。
        return 'public', 'building' if building else 'place'
    if not building and (leisure in ('park', 'nature_reserve') or landuse == 'park'):
        return 'park', 'place'
    if not building and tags.get('residential') in ('urban_village', 'village_in_city'):
        return 'village', 'place'
    if not building and landuse == 'residential':
        return 'residential', 'place'
    if building and (building == 'office' or tags.get('office') not in (None, 'no')):
        return 'office', 'building'
    if not building and (landuse == 'office' or tags.get('office') == 'park'):
        return 'office', 'place'
    return None


def parts(shape):
    if shape.geom_type == 'Polygon':
        if not shape.is_empty:
            yield shape
    else:
        for child in getattr(shape, 'geoms', []):
            yield from parts(child)


def valid_area(shape):
    return shape if shape.is_valid else union_all(list(parts(make_valid(shape))))


def read_areas(pbf, bounds, reviewed):
    frame = box(*bounds)
    factory = osmium.geom.WKBFactory()
    source = (osmium.FileProcessor(str(pbf)).with_locations().with_areas()
              .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA))
              .with_filter(osmium.filter.KeyFilter('landuse', 'leisure', 'residential',
                                                   'amenity', 'tourism', 'office', 'building', 'shop')))
    records = {}
    for area in source:
        identity = f"{'way' if area.from_way() else 'relation'}/{area.orig_id()}"
        tags = dict(area.tags)
        kind = reviewed.get(identity) or region_type(tags)
        if not kind or tags.get('area') == 'no':
            continue
        # 先用已装配外环判包络，避免为整省候选创建 WKB。
        near = False
        for ring in area.outer_rings():
            xs, ys = zip(*[(node.lon, node.lat) for node in ring])
            if min(xs) <= bounds[2] and max(xs) >= bounds[0] and min(ys) <= bounds[3] and max(ys) >= bounds[1]:
                near = True
                break
        if not near:
            continue
        try:
            shape = wkb.loads(factory.create_multipolygon(area), hex=True)
        except (ValueError, RuntimeError):
            continue
        shape = valid_area(shape)
        if not shape.intersects(frame):
            continue
        name = tags.get('name:zh') or tags.get('name')
        records[identity] = (kind, name.strip() if name and name.strip() else None, _to_local(shape))
    return records


class Masks:
    def __init__(self, polygons):
        self.polygons = polygons
        self.tree = STRtree(polygons)

    def overlapping(self, shape):
        return (self.polygons[i] for i in self.tree.query(shape, predicate='intersects'))

    def cut(self, shape, pad=0):
        if shape.is_empty:
            return shape
        query = shape.buffer(pad) if pad else shape
        mask = union_all(list(self.overlapping(query)))
        if not mask.is_empty:
            shape = shape.difference(mask.buffer(pad) if pad else mask)
        return shape


def road_footprints(graph, bounds):
    result = subprocess.run(['node', str(FOOTPRINT_HELPER), json.dumps(bounds)],
                            input=json.dumps(graph, separators=(',', ':')), capture_output=True, text=True, check=True)
    return [valid_area(Polygon(row['ring'])) for row in json.loads(result.stdout)]


def map_shape(shape, land, water, roads):
    # 量化到分米前给排除面留余量；高架和隧道未进入地面车行掩模。
    dry = water.cut(shape.intersection(land), 0.12)
    return set_precision(roads.cut(dry, 0.12), 0.1)


def label_anchors(polygons):
    candidates = []
    for polygon in polygons[:6]:
        # 用最大内切圆近似视觉中心。对狭长区域保留面内位置，显示时仍检查整行字能否放下。
        point = polylabel(polygon, tolerance=1)
        x, z = round(point.x, 2), round(point.y, 2)
        clearance = polygon.boundary.distance(Point(x, z))
        if clearance > 0.25 and polygon.contains(Point(x, z)):
            candidates.append([x, z, round(clearance - 0.01, 2)])
    return sorted(candidates, key=lambda row: -row[2])


def build_map_regions(payload, source, encode_polygon):
    audit = json.loads((ROOT / 'data/source/shopping-park-audit.json').read_text())
    # 审计里的道路及场所关系只有在同一快照上才能复用。
    if audit['snapshot']['sha256'] != source['sha256']:
        raise ValueError('Map region pilot must be reviewed for the current OSM snapshot')
    datum = json.loads((ROOT / 'data/source/urban-datum.json').read_text())
    plaza = {row['osmId']: row['name'] for row in datum['commercial']
             if row['tag'].get('landuse') == 'retail'}
    reviewed = {identity: ('retail', 'place') for identity in plaza}
    records = read_areas(ROOT / source['file'], PHASE1_BBOX, reviewed)
    if not reviewed.keys() <= records.keys():
        raise ValueError(f'Missing reviewed retail source: {reviewed.keys() - records.keys()}')

    places = {place['id']: {'id': place['id'], 'name': place['name'], 'osmIds': place['osmIds'],
                            'evidenceRefs': place['evidenceRefs']} for place in audit['places']}
    blocks = {row['id']: row for row in audit['blocks']}
    parcel_places = {row['sourceAreaOsmId']: sorted(place['id'] for place in audit['places']
                     if block_id in place['blockIds']) for block_id, row in blocks.items()}

    land = union_all([valid_area(packaged_polygon(poly)) for poly in payload['land']])
    water = Masks([valid_area(packaged_polygon(poly)) for poly in payload['water']]
                  + [valid_area(packaged_polygon(pond['rings']))
                     for pond in (payload.get('golfCourse') or {}).get('ponds', [])])
    graph = payload['roadGraph']
    roads = Masks(road_footprints(graph, payload['bounds']))
    table = payload['buildings']
    footprints = [valid_area(packaged_polygon(rings)) for rings in table['rings']]
    building_index = Masks(footprints)
    first_index = {}
    for i, identity in enumerate(table['id']):
        first_index.setdefault(identity, i)
    area_shapes = []
    rows = []

    def add(identity, kind, level, name, shape, evidence, place_ids=()):
        polygons = sorted((normalize(p) for p in parts(shape) if p.area >= 10),
                          key=lambda p: (-p.area, p.bounds, p.wkb))
        if not polygons:
            return
        anchors = label_anchors(polygons)
        if not anchors:
            return
        display = union_all(polygons)
        # 仅记录平面归属候选，按足迹多数面积归入；不推断产权、开放权限或楼体使用。
        indices = building_index.tree.query(display, predicate='intersects')
        building_refs = {first_index[table['id'][i]] for i in indices if footprints[i].area > 0
                         and display.intersection(footprints[i]).area >= footprints[i].area * 0.5}
        rows.append({'id': identity, 'type': kind, 'level': level, 'name': name,
                     'areaM2': round(display.area, 1), 'rings': [encode_polygon(p) for p in polygons],
                     'anchors': anchors, 'source': evidence, 'placeIds': list(place_ids),
                     'buildingRefs': sorted(building_refs)})
        area_shapes.append(display)

    for identity, ((kind, level), name, shape) in sorted(records.items()):
        if shape.area < (25 if level == 'building' else 100):
            continue
        evidence = {'kind': 'osm-area', 'osmId': identity}
        if identity in plaza:
            evidence['review'] = 'urban-datum:commercial'
        add(f'osm:{identity}', kind, level, plaza.get(identity, name), map_shape(shape, land, water, roads),
            evidence, parcel_places.get(identity, []))

    sample = wgs84_box(audit['boundsWgs84'])
    local_asphalt = union_all(list(roads.overlapping(sample)))
    source_areas = Masks(area_shapes.copy())
    for identity, block in blocks.items():
        lines, _ = boundary_lines(graph, block['boundaryWayIds'], sample)
        seed = Point(project(*block['seedWgs84']))
        _, shape, _ = cut_block(lines, local_asphalt, seed)
        # 街块只补未分类部分；整个街块的名称不能由相邻商场或 POI 推导。
        remainder = source_areas.cut(map_shape(shape, land, water, roads), 0.12)
        remainder = set_precision(remainder, 0.1)
        remainder = union_all([part for part in parts(remainder) if part.area >= 1000])
        add(f'block:{identity}', 'unknown', 'block', None, remainder,
            {'kind': 'derived-block', 'roadOsmIds': block['boundaryWayIds'], 'auditId': audit['id']})

    pilot = next(row for row in datum['structuralBaselinePilots'] if row['id'] == audit['structuralPilotId'])
    pilot_bounds = [min(pilot['boundsWgs84'][i], audit['boundsWgs84'][i]) if i < 2
                    else max(pilot['boundsWgs84'][i], audit['boundsWgs84'][i]) for i in range(4)]
    counts = Counter(row['type'] for row in rows)
    return {'version': 1, 'source': {key: source[key] for key in ('id', 'snapshotAt', 'sha256', 'url')},
            'pilot': {'id': pilot['id'], 'name': pilot['name'], 'boundsWgs84': pilot_bounds},
            'coverage': {kind: counts[kind] for kind in KINDS}, 'places': list(places.values()), 'regions': rows}
