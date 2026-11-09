"""城市树木：OSM 实测树点加带标注的程序化行道树/公园树，输出共享实例数组。

三个来源严格分开记录：
- osm-node / osm-row：PBF 里 natural=tree 节点、natural=tree_row 线，位置有来源；
- simulated-street / simulated-park：按道路等级与绿地面积用固定种子布置，是外观估计（simulated）。
树高、冠幅、树种分别带来源；没有 OSM 标签的树只写成树种范围估计，不冒充单株实测。
"""

import math
from collections import Counter

import numpy as np
import osmium
from shapely import STRtree, points as shapely_points
from shapely.geometry import LineString, Point

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, project
from roads import CLASS_OF, _num, road_dimensions

# 总量上限：行道树和公园树共享，超出部分等距抽样并计入 dropped['total-cap']。
CAP = 60000
STREET_QUOTA = 36000
STREET_CLASSES = ('trunk', 'primary', 'secondary', 'tertiary')
STREET_SPACING_M = {'trunk': 22.0, 'primary': 20.0, 'secondary': 18.0, 'tertiary': 24.0}
STREET_OFFSET_M = 2.5
STREET_MIN_LENGTH_M = 20.0
JUNCTION_CLEAR_M = 18.0
STREET_DENSITY_RANGE = (0.55, 0.70)
PARK_MIN_AREA_M2 = 1500.0
PARK_DENSITY_RANGE = (0.55, 0.75)
PARK_EDGE_M = 2.0
PARK_DUPLICATE_M = 5.0
PATH_CLEAR_M = 1.5
BUILDING_CLEAR_M = 2.0
SOURCES = ['osm-node', 'osm-row', 'simulated-street', 'simulated-park']
APPEARANCE_SOURCES = ['osm-tags', 'species-estimate']
OSM_SNAPSHOT = 'osm-guangdong'
OSM_PBF_RELATIVE = 'data/raw/guangdong-latest.osm.pbf'

# 树种表：取值范围是外观估计，不是实测；runtime 只按 id 取形态参数。
SPECIES = [
    {'id': 'ficus', 'name': '榕树', 'nameEn': 'Banyan', 'heightM': (9.0, 16.0), 'crownM': (8.0, 14.0),
     'trunkRatio': 0.34, 'weight': 30},
    {'id': 'camphor', 'name': '香樟', 'nameEn': 'Camphor', 'heightM': (8.0, 13.0), 'crownM': (6.0, 11.0),
     'trunkRatio': 0.44, 'weight': 22},
    {'id': 'phoenix', 'name': '凤凰木', 'nameEn': 'Flame tree', 'heightM': (8.0, 14.0), 'crownM': (7.0, 13.0),
     'trunkRatio': 0.40, 'weight': 16},
    {'id': 'bauhinia', 'name': '宫粉紫荆', 'nameEn': 'Orchid tree', 'heightM': (5.0, 9.0), 'crownM': (4.0, 8.0),
     'trunkRatio': 0.36, 'weight': 12},
    {'id': 'royal-palm', 'name': '大王椰', 'nameEn': 'Royal palm', 'heightM': (10.0, 17.0), 'crownM': (3.0, 4.5),
     'trunkRatio': 0.76, 'weight': 12},
    {'id': 'kapok', 'name': '木棉', 'nameEn': 'Kapok', 'heightM': (10.0, 16.0), 'crownM': (6.0, 10.0),
     'trunkRatio': 0.52, 'weight': 8},
]
SPECIES_BY_ID = {item['id']: item for item in SPECIES}
SPECIES_INDEX = {item['id']: index for index, item in enumerate(SPECIES)}

# OSM 树种/属名到本地树种 id 的映射；值都转小写，按包含匹配。
OSM_SPECIES_ALIASES = {
    'ficus microcarpa': 'ficus', 'ficus rubiginosa': 'ficus', 'ficus': 'ficus', 'banyan': 'ficus',
    'cinnamomum camphora': 'camphor', 'cinnamomum': 'camphor', 'camphor': 'camphor',
    'delonix regia': 'phoenix', 'delonix': 'phoenix', 'flame tree': 'phoenix',
    'bauhinia': 'bauhinia', 'orchid tree': 'bauhinia',
    'roystonea': 'royal-palm', 'royal palm': 'royal-palm', 'wodyetia': 'royal-palm', 'palm': 'royal-palm',
    'bombax ceiba': 'kapok', 'bombax': 'kapok', 'kapok': 'kapok',
}

LIMITATIONS = [
    'simulated-street / simulated-park 是按道路等级、绿地面积和固定种子布置的外观估计，不是单株实测，'
    '不能当作市政种植清单或实时植被数据。',
    '只有 PBF 里 natural=tree / natural=tree_row 的点位有来源；没有 height / diameter_crown 标签的树，'
    '树高和冠幅按树种范围估计（appearance=species-estimate）。',
    '树龄没有数据来源，未建模。',
    '避让只按本地几何判定建筑退让 2 m、水体、湿地、车行道、pedestrian 广场走廊和已知步道；'
    '树池、地下管线、架空线、入口净空未核实。',
    'OSM 的 highway 面（area=yes 广场）不在现有 osm.py 产出里，plaza 只覆盖 pedestrian 线状走廊。',
    '绿地图层包含山体林地（面积远大于城市公园），受 60000 株总量上限约束，'
    '非地标绿地按面积配额等距抽样，密度低于满铺。',
    '树种从固定权重表里按种子抽取，不对应深圳市政实际种植清单。',
]


def _seed(text):
    """与 js/sz-building-layout.js 的 buildingSeed 同构的 FNV-1a，保证前后端同一标识得到同一随机数。"""
    value = 2166136261
    for byte in text.encode('utf-8'):
        value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
    return value / 4294967296


def _span(key, limits, margin=0.12):
    """在给定范围里按种子取一个值，margin 保证不贴表两端。"""
    low, high = limits
    return low + (high - low) * (margin + (1 - 2 * margin) * _seed(key))


def _species_for_seed(key):
    total = sum(item['weight'] for item in SPECIES)
    pick = _seed(key + ':species') * total
    for item in SPECIES:
        pick -= item['weight']
        if pick <= 0:
            return item['id']
    return SPECIES[-1]['id']


def _species_from_tags(tags, key):
    for field in ('species', 'genus'):
        value = tags.get(field)
        if not value:
            continue
        text = str(value).strip().lower()
        for alias, species_id in OSM_SPECIES_ALIASES.items():
            if alias in text:
                return species_id
    return _species_for_seed(key)


def _estimate_size(species_id, key):
    species = SPECIES_BY_ID[species_id]
    return _span(key + ':height', species['heightM']), _span(key + ':crown', species['crownM'])


def _tree_tags(tags):
    keep = ('natural', 'species', 'genus', 'height', 'diameter_crown', 'leaf_type', 'leaf_cycle',
            'denotation', 'name')
    return {key: tags[key] for key in keep if key in tags}


def read_osm_trees(pbf, clip):
    """从锁定 PBF 里读 natural=tree 节点和 natural=tree_row 线上的树位。

    返回的记录已经投影到本地坐标并按 clip 过滤；tree_row 每节点一条，来源 id 保持 way/<id>，
    因为这些位置是由有来源的树列线派生出来的，不是逐株实测点。
    """
    bounds = clip.bounds
    west = ORIGIN_LON + bounds[0] / KX
    east = ORIGIN_LON + bounds[2] / KX
    north = ORIGIN_LAT - bounds[1] / KY
    south = ORIGIN_LAT - bounds[3] / KY

    def inside(lon, lat):
        return west - 1e-6 <= lon <= east + 1e-6 and south - 1e-6 <= lat <= north + 1e-6

    out = []
    reader = (osmium.FileProcessor(str(pbf))
              .with_locations()
              .with_filter(osmium.filter.KeyFilter('natural')))
    for obj in reader:
        natural = obj.tags.get('natural')
        if obj.is_node() and natural == 'tree':
            if not inside(obj.lon, obj.lat):
                continue
            x, z = project(obj.lon, obj.lat)
            if not clip.covers(Point(x, z)):
                continue
            out.append({'osmId': f'node/{obj.id}', 'x': x, 'z': z, 'source': 'osm-node',
                        'tags': _tree_tags(obj.tags)})
        elif obj.is_way() and natural == 'tree_row':
            tags = _tree_tags(obj.tags)
            try:
                nodes = [(node.ref, node.lon, node.lat) for node in obj.nodes]
            except osmium.InvalidLocationError:
                continue
            seen = set()
            for ref, lon, lat in nodes:
                if ref in seen or not inside(lon, lat):
                    continue
                seen.add(ref)
                x, z = project(lon, lat)
                if not clip.covers(Point(x, z)):
                    continue
                out.append({'osmId': f'way/{obj.id}', 'x': x, 'z': z, 'source': 'osm-row', 'tags': tags})
    return out


class _SpatialMask:
    """批量点命中测试：每类避让几何只建一次 STRtree，避免对几十万候选点逐点 Python 循环。"""

    __slots__ = ('tree',)

    def __init__(self, geoms):
        geoms = [geom for geom in geoms if geom is not None and not geom.is_empty]
        self.tree = STRtree(geoms) if geoms else None

    def hits(self, xs, zs):
        count = len(xs)
        out = np.zeros(count, dtype=bool)
        if self.tree is None or count == 0:
            return out
        hits = self.tree.query(shapely_points(xs, zs), predicate='intersects')
        out[hits[0]] = True
        return out


def _poly_of(item):
    if hasattr(item, 'geom_type'):
        return item
    return item.get('poly') or item.get('polygon') or item.get('geom')


def _clip_parts(geom, clip):
    clipped = geom.intersection(clip)
    return [part for part in getattr(clipped, 'geoms', [clipped])
            if part.geom_type == 'LineString' and not part.is_empty and part.length > 0.01]


def _road_graph_links(road_graph):
    """把路网 links 还原成折线；只保留地面、非桥非隧非分层链路。"""
    nodes, links, metadata = road_graph['nodes'], road_graph['links'], road_graph['metadata']
    out = []
    for index, (link, meta) in enumerate(zip(links, metadata, strict=True)):
        inner = link[6]
        coords = [(nodes[link[0] * 2], nodes[link[0] * 2 + 1])]
        coords += [(inner[i], inner[i + 1]) for i in range(0, len(inner), 2)]
        coords.append((nodes[link[1] * 2], nodes[link[1] * 2 + 1]))
        out.append({'id': f"{meta.get('osmId', 'way/0')}#{index}", 'osmId': meta.get('osmId'),
                    'cls': CLASS_OF.get(meta.get('highway')), 'width': float(link[3]),
                    'line': LineString(coords), 'heightSource': meta.get('heightSource'),
                    'bridge': bool(meta.get('bridge')), 'tunnel': bool(meta.get('tunnel')),
                    'layer': meta.get('layer') or 0})
    return out


def _osm_links(osm, clip):
    """没有路网时的退路：直接从 OSM highway 折线还原链路，供测试和小范围数据使用。"""
    out = []
    for road in osm.get('roads', []):
        tags = road['tags']
        cls = CLASS_OF.get(tags.get('highway'))
        if cls is None:
            continue
        line = LineString([project(*point) for point in road['geom'].coords])
        width, _lanes, width_source = road_dimensions(tags)
        out.append({'id': f"{road['id']}#0", 'osmId': road['id'], 'cls': cls, 'width': width,
                    'line': line,
                    'heightSource': 'unresolved' if tags.get('bridge', 'no') not in ('no', 'false', '0')
                    or tags.get('tunnel', 'no') not in ('no', 'false', '0')
                    or _num(tags.get('layer')) not in (None, 0.0) else 'terrain',
                    'bridge': tags.get('bridge', 'no') not in ('no', 'false', '0'),
                    'tunnel': tags.get('tunnel', 'no') not in ('no', 'false', '0'),
                    'layer': _num(tags.get('layer')) or 0, 'widthSource': width_source})
    return out


def _junction_points(links):
    """统计地面链路端点度数，返回至少有 3 条链路相交的路口点；高层道路按同一平面近似。"""
    degree = Counter()
    node_positions = {}
    for link in links:
        coords = list(link['line'].coords)
        for point in (coords[0], coords[-1]):
            key = (round(point[0], 2), round(point[1], 2))
            degree[key] += 1
            node_positions[key] = point
    return [Point(node_positions[key]) for key, count in degree.items() if count >= 3]


def _walk_extra_lines(osm):
    """路网之外仍要避让的慢行/服务道路：pedestrian、footway、cycleway、service。"""
    lines = []
    for road in osm.get('roads', []):
        tags = road['tags']
        if CLASS_OF.get(tags.get('highway')) not in ('pedestrian', 'service'):
            continue
        width, _lanes, _source = road_dimensions(tags)
        coords = [project(*point) for point in road['geom'].coords]
        if len(coords) < 2:
            continue
        lines.append({'line': LineString(coords), 'width': max(2.0, width)})
    return lines


def _plaza_lines(osm):
    """pedestrian 线状广场/步行街走廊；OSM 的 area=yes 广场面当前管线不产出。"""
    lines = []
    for road in osm.get('roads', []):
        tags = road['tags']
        if tags.get('highway') != 'pedestrian':
            continue
        width, _lanes, _source = road_dimensions(tags)
        coords = [project(*point) for point in road['geom'].coords]
        if len(coords) < 2:
            continue
        lines.append(LineString(coords).buffer(max(1.5, width / 2 + 0.5), quad_segs=3))
    return lines


def _streetscape_paths(streetscape):
    lines = []
    if not streetscape:
        return lines
    for path in streetscape.get('paths', []):
        for segment in path.get('segments', []):
            points = segment.get('points') or []
            if len(points) < 2:
                continue
            lines.append(LineString(points).buffer(PATH_CLEAR_M, quad_segs=3))
    return lines


def _park_spacing(area_m2):
    if area_m2 < 5000:
        return 18.0
    if area_m2 < 20000:
        return 20.0
    if area_m2 < 100000:
        return 22.0
    if area_m2 < 500000:
        return 24.0
    return 26.0


def _even_subset(items, keep):
    """按固定间隔抽取 keep 条，保持空间分布均匀且与输入顺序一致。"""
    total = len(items)
    if keep >= total:
        return list(items)
    if keep <= 0:
        return []
    return [items[(index * total) // keep] for index in range(keep)]


def _tree_record(x, z, height, crown, species_id, source, appearance, osm_id=None):
    return {'x': round(x, 3), 'z': round(z, 3), 'height': round(height, 3), 'crown': round(crown, 3),
            'species': species_id, 'source': source, 'appearance': appearance, 'osmId': osm_id}


def _prepare_masks(osm, water, wetland, streetscape, buildings, links, walk_lines):
    building_geoms = [_poly_of(item).buffer(BUILDING_CLEAR_M, quad_segs=2) for item in buildings]
    water_geoms = [_poly_of(item) for item in water]
    wetland_geoms = [_poly_of(item) for item in wetland]
    ground = [link for link in links
              if not link['bridge'] and not link['tunnel'] and not link['layer']]
    ground_corridors = [link['line'].buffer(max(0.5, link['width'] / 2 + 0.5), quad_segs=3) for link in ground]
    all_corridors = [link['line'].buffer(max(0.5, link['width'] / 2 + 0.5), quad_segs=3) for link in links]
    walk = [item['line'].buffer(item['width'] / 2 + 0.5, quad_segs=3) for item in walk_lines]
    paths = _streetscape_paths(streetscape)
    plaza = _plaza_lines(osm)
    return {
        'building': _SpatialMask(building_geoms),
        'water': _SpatialMask(water_geoms),
        'wetland': _SpatialMask(wetland_geoms),
        'road': _SpatialMask(ground_corridors),
        'walk': _SpatialMask(all_corridors + walk),
        'path': _SpatialMask(paths),
        'plaza': _SpatialMask(plaza),
    }


def build_trees(osm, clip_local, land, water, wetland, green, parks, streetscape, buildings, report,
                *, pbf=None, osm_trees=None, road_graph=None):
    """装配树木共享数组；没有 OSM 树来源时返回 None 并写 status。"""
    if pbf is None and osm_trees is None:
        report['trees'] = {'status': 'skipped-no-osm-tree-source'}
        return None

    dropped = Counter()
    requested = 0

    # ---- 1. OSM 实测/派生树点 ----
    osm_records = list(osm_trees) if osm_trees is not None else read_osm_trees(pbf, clip_local)
    osm_nodes = sum(1 for item in osm_records if item['source'] == 'osm-node')
    osm_rows = sum(1 for item in osm_records if item['source'] == 'osm-row')
    osm_row_ways = len({item['osmId'] for item in osm_records if item['source'] == 'osm-row'})

    # ---- 2. 地面道路链路 ----
    links = _road_graph_links(road_graph) if road_graph else _osm_links(osm, clip_local)
    walk_lines = _walk_extra_lines(osm)
    masks = _prepare_masks(osm, water, wetland, streetscape, buildings, links, walk_lines)

    osm_kept = []
    appearance_tags = 0
    road_hit = building_hit = np.zeros(0, dtype=bool)
    if osm_records:
        xs = np.array([item['x'] for item in osm_records], dtype=np.float64)
        zs = np.array([item['z'] for item in osm_records], dtype=np.float64)
        water_hit = masks['water'].hits(xs, zs)
        wetland_hit = masks['wetland'].hits(xs, zs)
        road_hit = masks['road'].hits(xs, zs)
        building_hit = masks['building'].hits(xs, zs)
        for index, item in enumerate(osm_records):
            requested += 1
            if water_hit[index]:
                dropped['osm-water'] += 1
                continue
            if wetland_hit[index]:
                dropped['osm-wetland'] += 1
                continue
            if not clip_local.covers(Point(item['x'], item['z'])):
                dropped['osm-outside-clip'] += 1
                continue
            tags = item.get('tags') or {}
            key = item['osmId'] + ':' + item['source']
            species_id = _species_from_tags(tags, key)
            tag_height = _num(tags.get('height'))
            tag_crown = _num(tags.get('diameter_crown'))
            height, crown = _estimate_size(species_id, key)
            used_tag = False
            if tag_height and 2.0 <= tag_height <= 60.0:
                height, used_tag = tag_height, True
            if tag_crown and 1.0 <= tag_crown <= 40.0:
                crown, used_tag = tag_crown, True
            appearance = 'osm-tags' if used_tag else 'species-estimate'
            if used_tag:
                appearance_tags += 1
            osm_kept.append(_tree_record(item['x'], item['z'], height, crown, species_id,
                                         item['source'], appearance, item['osmId']))
    osm_conflicts = {'road': int(road_hit.sum()) if osm_records else 0,
                     'building': int(building_hit.sum()) if osm_records else 0}
    # osm_conflicts 只做审计：位置来自源数据，运行时按实际铺装和建筑接触再决定是否显示。

    # ---- 3. 行道树：地面主/次干路两侧各一行 ----
    street_links = [link for link in links
                    if link['cls'] in STREET_CLASSES and link['heightSource'] == 'terrain'
                    and not link['bridge'] and not link['tunnel'] and not link['layer']]
    street_links.sort(key=lambda link: link['id'])
    junction_points = _junction_points([link for link in links if not link['bridge'] and not link['tunnel']])
    junction_mask = _SpatialMask([point.buffer(JUNCTION_CLEAR_M, quad_segs=4) for point in junction_points])
    slots = []
    street_length = 0.0
    skipped_links = Counter()
    for link in street_links:
        spacing = STREET_SPACING_M[link['cls']]
        offset = link['width'] / 2 + STREET_OFFSET_M
        for part_index, part in enumerate(_clip_parts(link['line'], clip_local)):
            length = part.length
            if length < STREET_MIN_LENGTH_M:
                skipped_links['short'] += 1
                continue
            street_length += length
            count = int(math.floor((length - spacing * 0.5) / spacing)) + 1
            count = max(count, 0)
            density = STREET_DENSITY_RANGE[0] + (STREET_DENSITY_RANGE[1] - STREET_DENSITY_RANGE[0]) * _seed(
                f"street:{link['id']}:{part_index}")
            for side in (1, -1):
                for slot in range(count):
                    distance = spacing * (slot + 0.5)
                    point = part.interpolate(distance)
                    ahead = part.interpolate(min(length, distance + 1.0))
                    if ahead.equals(point):
                        ahead = part.interpolate(max(0.0, distance - 1.0))
                    dx, dz = ahead.x - point.x, ahead.y - point.y
                    norm = math.hypot(dx, dz) or 1.0
                    x = point.x - side * dz / norm * offset
                    z = point.y + side * dx / norm * offset
                    slots.append({'x': x, 'z': z, 'key': f"street:{link['id']}:{part_index}:{side}:{slot}",
                                  'density': density})
    if slots:
        requested += len(slots)
        xs = np.array([slot['x'] for slot in slots], dtype=np.float64)
        zs = np.array([slot['z'] for slot in slots], dtype=np.float64)
        hits = {name: masks[name].hits(xs, zs) for name in ('building', 'water', 'wetland', 'plaza', 'road')}
        on_junction = junction_mask.hits(xs, zs)
        street_kept = []
        for index, slot in enumerate(slots):
            if on_junction[index]:
                dropped['street-junction'] += 1
            elif hits['building'][index]:
                dropped['street-building'] += 1
            elif hits['water'][index]:
                dropped['street-water'] += 1
            elif hits['wetland'][index]:
                dropped['street-wetland'] += 1
            elif hits['plaza'][index]:
                dropped['street-plaza'] += 1
            elif hits['road'][index]:
                dropped['street-road-corridor'] += 1
            elif not clip_local.covers(Point(slot['x'], slot['z'])):
                dropped['street-outside-clip'] += 1
            elif _seed(slot['key'] + ':keep') >= slot['density']:
                dropped['street-density'] += 1
            else:
                species_id = _species_for_seed(slot['key'])
                height, crown = _estimate_size(species_id, slot['key'])
                street_kept.append(_tree_record(slot['x'], slot['z'], height, crown, species_id,
                                                'simulated-street', 'species-estimate'))
    else:
        street_kept = []

    # ---- 4. 公园/城市绿地：按面积定间距的分层抽样 ----
    park_area_ids = set()
    park_areas = []
    for park in parks or []:
        for area in park.get('areas', []):
            polygon = _poly_of(area)
            if polygon is None or polygon.is_empty or polygon.area < PARK_MIN_AREA_M2:
                continue
            identity = area.get('osmId') or park.get('osmId') or park.get('id')
            park_area_ids.add(identity)
            park_areas.append((f'park:{identity}', polygon, 'park'))
    park_areas.sort(key=lambda item: item[0])
    green_areas = []
    seen_green = set()
    for item in green or []:
        identity = item.get('id') or f"green:{len(seen_green)}"
        polygon = _poly_of(item)
        if polygon is None or polygon.is_empty or polygon.area < PARK_MIN_AREA_M2:
            continue
        if identity in park_area_ids or identity in seen_green:
            continue
        seen_green.add(identity)
        green_areas.append((f'green:{identity}', polygon, 'green'))
    green_areas.sort(key=lambda item: item[0])
    park_area_m2 = 0.0
    park_candidates = []
    skipped_areas = Counter()
    for area_id, polygon, origin in park_areas + green_areas:
        interior = polygon.buffer(-PARK_EDGE_M, quad_segs=2)
        if interior.is_empty or interior.area < 100.0:
            skipped_areas['park-area-too-thin'] += 1
            continue
        park_area_m2 += interior.area
        spacing = _park_spacing(polygon.area)
        density = PARK_DENSITY_RANGE[0] + (PARK_DENSITY_RANGE[1] - PARK_DENSITY_RANGE[0]) * _seed(
            f'park-rate:{area_id}')
        minx, minz, maxx, maxz = interior.bounds
        steps_x = int(math.floor((maxx - minx) / spacing))
        steps_z = int(math.floor((maxz - minz) / spacing))
        for ix in range(steps_x + 1):
            for iz in range(steps_z + 1):
                key = f'{area_id}:{ix}:{iz}'
                x = minx + (ix + 0.5) * spacing + (_seed(key + ':x') - 0.5) * spacing * 0.5
                z = minz + (iz + 0.5) * spacing + (_seed(key + ':z') - 0.5) * spacing * 0.5
                if not interior.covers(Point(x, z)):
                    continue
                requested += 1
                if _seed(key + ':keep') >= density:
                    dropped['park-density'] += 1
                    continue
                park_candidates.append({'x': x, 'z': z, 'key': key, 'origin': origin})
    park_kept, green_kept = [], []
    if park_candidates:
        xs = np.array([item['x'] for item in park_candidates], dtype=np.float64)
        zs = np.array([item['z'] for item in park_candidates], dtype=np.float64)
        building_hit = masks['building'].hits(xs, zs)
        water_hit = masks['water'].hits(xs, zs)
        wetland_hit = masks['wetland'].hits(xs, zs)
        road_hit = masks['walk'].hits(xs, zs)
        path_hit = masks['path'].hits(xs, zs)
        occupied = {}
        for index, item in enumerate(park_candidates):
            if building_hit[index]:
                dropped['park-building'] += 1
            elif water_hit[index]:
                dropped['park-water'] += 1
            elif wetland_hit[index]:
                dropped['park-wetland'] += 1
            elif road_hit[index]:
                dropped['park-road'] += 1
            elif path_hit[index]:
                dropped['park-path'] += 1
            else:
                cell = (int(math.floor(item['x'] / 4.0)), int(math.floor(item['z'] / 4.0)))
                duplicate = False
                for offset_x in (-1, 0, 1):
                    for offset_z in (-1, 0, 1):
                        for other_x, other_z in occupied.get((cell[0] + offset_x, cell[1] + offset_z), ()):
                            if (other_x - item['x']) ** 2 + (other_z - item['z']) ** 2 < PARK_DUPLICATE_M ** 2:
                                duplicate = True
                                break
                        if duplicate:
                            break
                    if duplicate:
                        break
                if duplicate:
                    dropped['park-duplicate'] += 1
                    continue
                occupied.setdefault(cell, []).append((item['x'], item['z']))
                species_id = _species_for_seed(item['key'])
                height, crown = _estimate_size(species_id, item['key'])
                record = _tree_record(item['x'], item['z'], height, crown, species_id,
                                      'simulated-park', 'species-estimate')
                (park_kept if item['origin'] == 'park' else green_kept).append(record)

    # ---- 5. 上限：OSM 优先，行道树配额次之，地标公园次之，其余绿地填满余额 ----
    trees = list(osm_kept)
    if osm_kept:
        dropped['total-cap'] += max(0, len(osm_kept) - CAP)
        trees = osm_kept[:CAP]
    street_quota = max(0, min(STREET_QUOTA, CAP - len(trees)))
    if len(street_kept) > street_quota:
        dropped['total-cap'] += len(street_kept) - street_quota
        street_kept = _even_subset(street_kept, street_quota)
    trees.extend(street_kept)
    park_budget = max(0, CAP - len(trees))
    if len(park_kept) > park_budget:
        dropped['total-cap'] += len(park_kept) - park_budget
        park_kept = _even_subset(park_kept, park_budget)
    trees.extend(park_kept)
    green_budget = max(0, CAP - len(trees))
    if len(green_kept) > green_budget:
        dropped['total-cap'] += len(green_kept) - green_budget
        green_kept = _even_subset(green_kept, green_budget)
    trees.extend(green_kept)

    # ---- 6. 共享数组 ----
    count = len(trees)
    payload = {
        'version': 1,
        'count': count,
        'x': [round(tree['x'] * 10) for tree in trees],
        'z': [round(tree['z'] * 10) for tree in trees],
        'height': [max(10, round(tree['height'] * 10)) for tree in trees],
        'crown': [max(10, round(tree['crown'] * 10)) for tree in trees],
        'species': [SPECIES_INDEX[tree['species']] for tree in trees],
        'source': [SOURCES.index(tree['source']) for tree in trees],
        'appearance': [APPEARANCE_SOURCES.index(tree['appearance']) for tree in trees],
        'speciesNames': [item['id'] for item in SPECIES],
        'sources': list(SOURCES),
        'appearanceSources': list(APPEARANCE_SOURCES),
        'osm': [[index, tree['osmId']] for index, tree in enumerate(trees) if tree['osmId']],
        'stats': {},
        'limitations': list(LIMITATIONS),
    }
    counts_by_source = Counter(tree['source'] for tree in trees)
    species_counts = Counter(tree['species'] for tree in trees)
    stats = {
        'requested': requested,
        'kept': count,
        'cap': CAP,
        'countsBySource': {source: counts_by_source[source] for source in SOURCES},
        'speciesCounts': {item['id']: species_counts[item['id']] for item in SPECIES},
        'streetLengthM': round(street_length, 1),
        'parkAreaM2': round(park_area_m2, 1),
        'dropped': dict(sorted(dropped.items())),
    }
    payload['stats'] = stats

    rules = {
        'streetClasses': list(STREET_CLASSES),
        'streetSpacingM': dict(STREET_SPACING_M),
        'streetOffsetM': f'width/2 + {STREET_OFFSET_M}',
        'streetMinLinkLengthM': STREET_MIN_LENGTH_M,
        'junctionClearM': JUNCTION_CLEAR_M,
        'streetDensityRange': list(STREET_DENSITY_RANGE),
        'parkMinAreaM2': PARK_MIN_AREA_M2,
        'parkDensityRange': list(PARK_DENSITY_RANGE),
        'parkEdgeM': PARK_EDGE_M,
        'buildingClearM': BUILDING_CLEAR_M,
        'pathClearM': PATH_CLEAR_M,
        'cap': CAP,
        'streetQuota': STREET_QUOTA,
    }
    report['trees'] = {
        'status': 'generated',
        'requested': requested,
        'kept': count,
        'cap': CAP,
        'countsBySource': stats['countsBySource'],
        'speciesCounts': stats['speciesCounts'],
        'appearanceSources': {'osm-tags': appearance_tags,
                              'species-estimate': count - appearance_tags},
        'streetLengthM': stats['streetLengthM'],
        'parkAreaM2': stats['parkAreaM2'],
        'dropped': stats['dropped'],
        'skippedLinks': dict(skipped_links),
        'skippedAreas': dict(skipped_areas),
        'parkKept': {'destination': len(park_kept), 'otherGreen': len(green_kept)},
        'rules': rules,
        'species': [{key: item[key] for key in ('id', 'name', 'nameEn', 'heightM', 'crownM', 'trunkRatio', 'weight')}
                    for item in SPECIES],
        'osmSource': {'snapshot': OSM_SNAPSHOT, 'file': OSM_PBF_RELATIVE,
                      'treeNodes': osm_nodes, 'treeRowWays': osm_row_ways, 'treeRowPositions': osm_rows,
                      'kept': len(osm_kept), 'conflicts': osm_conflicts},
        'limitations': list(LIMITATIONS),
    }
    return payload
