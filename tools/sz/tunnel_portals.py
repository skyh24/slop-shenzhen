"""按路网图与运行时洞底纵断面推导通用隧道洞口，并裁开显示地形面。

口径取 js/sz-tunnels.js planTunnel 的洞底（:302-309）：
    startSink = 共享起点 ? clamp01(d / 12) : 1
    endSink   = 共享终点 ? clamp01((L - d) / 12) : 1
    floorY    = terrain(x, z) - 6 * |layer| * min(startSink, endSink)
所以覆土 cover = terrain - floorY = 6 * |layer| * min(startSink, endSink)，与地形无关。按 4 m 站距，
cover 落在 (0.05, 5.6) m 的连续站点就是洞口开敞段；共享端向内约 12 m 内线性起坡，更深处留给洞身。
常量 PORTAL_TRANSITION_M = 12、TUNNEL_LAYER_DEPTH_M = 6、TUNNEL_BORE_HEIGHT_M = 5 与 js 同源，改动需两边同步。

注意：全城路径 planCityTunnel（js/sz-tunnels.js:646，洞底在 :710）目前仍用两端地形高程的线性连线，
与上面的 sink 口径不同；在它迁移到 sink 之前，本模块按 sink 裁出的洞口会与运行时洞身有偏差。

只处理 metadata.tunnel 为真且 |layer| >= 1 的边（layer 为 0 时运行时不建洞身）；共享端指该端节点
同时被地面道路使用（heightSource 为 terrain、非 bridge/tunnel、layer 为 0），与运行时
js/sz-roads.js 的 isGroundRoad 同口径。没有共享端的边不裁，地形采样缺站时跳过该边，不报错。
因为 cover 与地形无关，平地城市隧道只要 |layer| >= 1 且有共享端也会在洞口 12 m 内裁开——这是
纵断面决定的洞身位置，不再用「地形是否高于路面」筛选。

走廊宽度 = max(源宽, 9 m) + 1.5 m 施工余量，沿开敞段生成面并 unary_union，再交给
commercial_paving.cut_ground_openings 裁 terrainSurface。地形采样复用 terrainSurface 的三角面
（与运行时 createGroundSurfaceSampler 同一套数据），不混用工程网格。
"""

import math

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from commercial_paving import cut_ground_openings

STATION_M = 4.0
COVER_MIN_M = 0.05
COVER_MAX_M = 5.6
PORTAL_TRANSITION_M = 12.0
# 与 sz-interchange-levels.js 的高层主线、互通接续段和长洞口引道一致。
HIGH_DECK_TUNNEL_APPROACH_M = 84.0
HIGH_DECK_ROADS = {'南坪快速': 'trunk', '南光高速': 'motorway'}
NANGUANG_THROUGH_WAY = 'way/1081087778'
NANGUANG_BORES = {'way/25516495', 'way/183920372'}
TUNNEL_LAYER_DEPTH_M = 6.0
MIN_TUNNEL_WIDTH_M = 9.0
CORRIDOR_MARGIN_M = 1.5
EPSILON = 1e-9

# 与 js/sz-roads.js isGroundRoad 一致：地形高程落地、非桥非隧、layer 为 0。
GROUND_HEIGHT_SOURCE = 'terrain'


def _clamp01(value):
    return 0.0 if value <= 0 else 1.0 if value >= 1 else value


def _source_points(graph, link):
    """复刻 road_structures.source_points，避免为一行代码引入循环导入。"""
    a, b, inner = link[0], link[1], link[6]
    nodes = graph['nodes']
    return [(nodes[2 * a], nodes[2 * a + 1]), *zip(inner[::2], inner[1::2]),
            (nodes[2 * b], nodes[2 * b + 1])]


def _is_ground_road(metadata):
    return (metadata.get('heightSource') == GROUND_HEIGHT_SOURCE and not metadata.get('bridge')
            and not metadata.get('tunnel') and not metadata.get('layer'))


def _ground_nodes(graph):
    """地面道路用到的节点；隧道端点与它们重合时，运行时视为洞口。"""
    nodes = set()
    for link, metadata in zip(graph['links'], graph['metadata']):
        if not _is_ground_road(metadata):
            continue
        nodes.add(link[0])
        nodes.add(link[1])
    return nodes


def _high_deck_road(metadata, name):
    return (not metadata.get('tunnel') and (metadata.get('layer') or 0) > 0
            and (metadata.get('osmId') == NANGUANG_THROUGH_WAY
                 or (name in HIGH_DECK_ROADS and HIGH_DECK_ROADS[name] == metadata.get('highway'))))


def _high_deck_portals(graph):
    decks = set()
    for link, meta in zip(graph['links'], graph['metadata'], strict=True):
        if _high_deck_road(meta, graph['names'][link[2]]):
            decks.update((node, link[2]) for node in link[:2])
    return {node for link, meta in zip(graph['links'], graph['metadata'], strict=True)
            if meta.get('tunnel') and meta.get('osmId') in NANGUANG_BORES
            for node in link[:2] if (node, link[2]) in decks}


def _polyline_length(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def _resample(points, length):
    """按运行时 resample 切站：每段按 ceil(段长 / 4 m) 等分，两端点必在站上。"""
    stations = [(0.0, points[0][0], points[0][1])]
    distance = 0.0
    for a, b in zip(points, points[1:]):
        segment = math.hypot(b[0] - a[0], b[1] - a[1])
        if segment < EPSILON:
            continue
        steps = max(1, math.ceil(segment / STATION_M))
        for step in range(1, steps + 1):
            t = step / steps
            stations.append((distance + segment * t, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        distance += segment
    return stations if distance > EPSILON else []


class _SurfaceSampler:
    """按 terrainSurface 三角面取高程，复刻 js/sz-ground-surface.js 的 createGroundSurfaceSampler。"""

    def __init__(self, surface):
        grid = surface['grid']
        self.grid = grid
        self.step = grid['step']
        self.columns = grid['nx'] - 1
        self.chunk_size = surface['chunkSize']
        self.chunks = {chunk['id']: chunk for chunk in surface['chunks']}
        self.cells = {}
        for chunk in surface['chunks']:
            ranges = chunk['cellRanges']
            for index in range(0, len(ranges), 3):
                self.cells[ranges[index]] = (chunk, ranges[index + 1], ranges[index + 2])

    def _chunk_id(self, world_x, world_z):
        return '%d,%d' % (math.floor(world_x / self.chunk_size), math.floor(world_z / self.chunk_size))

    def _height_in_cell(self, entry, x, z):
        chunk, start, count = entry
        positions, indices = chunk['positions'], chunk['indices']
        origin_x, origin_z = chunk['origin']
        local_x, local_z = x - origin_x, z - origin_z
        for cursor in range(start, start + count, 3):
            ia, ib, ic = indices[cursor], indices[cursor + 1], indices[cursor + 2]
            ax, ay, az = positions[3 * ia:3 * ia + 3]
            bx, by, bz = positions[3 * ib:3 * ib + 3]
            cx, cy, cz = positions[3 * ic:3 * ic + 3]
            denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            if abs(denominator) < 1e-12:
                continue
            u = ((bz - cz) * (local_x - cx) + (cx - bx) * (local_z - cz)) / denominator
            v = ((cz - az) * (local_x - cx) + (ax - cx) * (local_z - cz)) / denominator
            w = 1 - u - v
            if u < -1e-7 or v < -1e-7 or w < -1e-7:
                continue
            return u * ay + v * by + w * cy
        return None

    def __call__(self, x, z):
        grid = self.grid
        fx = (x - grid['x0']) / self.step
        fz = (z - grid['z0']) / self.step
        if fx < 0 or fz < 0 or fx > grid['nx'] - 1 or fz > grid['nz'] - 1:
            return None
        i = min(math.floor(fx), grid['nx'] - 2)
        j = min(math.floor(fz), grid['nz'] - 2)
        # 刚好落在格线上的点同时查邻接单元，覆盖海岸或分块边缘。
        columns = (i, i - 1) if float(fx).is_integer() and i > 0 else (i,)
        rows = (j, j - 1) if float(fz).is_integer() and j > 0 else (j,)
        for row in rows:
            for col in columns:
                world_x = grid['x0'] + (col + 0.5) * self.step
                world_z = grid['z0'] + (row + 0.5) * self.step
                if self._chunk_id(world_x, world_z) not in self.chunks:
                    continue
                entry = self.cells.get(row * self.columns + col)
                if entry is None:
                    continue
                height = self._height_in_cell(entry, x, z)
                if height is not None:
                    return height
        return None


def _link_width(link):
    """源宽非法时按洞身最小宽度处理；与运行时 max(源宽, 9 m) 同口径。"""
    try:
        width = float(link[3])
    except (IndexError, TypeError, ValueError):
        width = 0.0
    return width if math.isfinite(width) and width > 0 else MIN_TUNNEL_WIDTH_M


def _open_spans(length, depth, shared_start, shared_end, transition_m=PORTAL_TRANSITION_M):
    """求 cover = depth * min(startSink, endSink) 落在 (0.05, 5.6) 的连续地段。

    cover 在 [0, L] 上是分段线性（拐点在两端各 12 m），先按 0.25 m 粗筛出与两个阈值的交点，
    再二分细化，最后按交点分段判定内外。这样走廊覆盖整条 12 m 过渡带，不会只剩 4 m 站上的点。
    """
    def cover(distance):
        start_sink = _clamp01(distance / transition_m) if shared_start else 1.0
        end_sink = _clamp01((length - distance) / transition_m) if shared_end else 1.0
        return depth * min(start_sink, end_sink)

    size = 0.25
    boundaries = [0.0, length]
    previous = cover(0.0)
    distance = size
    while distance <= length:
        value = cover(distance)
        for threshold in (COVER_MIN_M, COVER_MAX_M):
            if (previous <= threshold) != (value <= threshold):
                low, high = distance - size, distance
                for _ in range(48):
                    middle = (low + high) / 2
                    if (cover(low) <= threshold) != (cover(middle) <= threshold):
                        high = middle
                    else:
                        low = middle
                boundaries.append((low + high) / 2)
        previous = value
        distance += size
    boundaries = sorted(boundaries)
    spans = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end - start <= 1e-6:
            continue
        middle = (start + end) / 2
        if COVER_MIN_M < cover(middle) < COVER_MAX_M:
            if spans and abs(spans[-1][1] - start) <= 1e-6:
                spans[-1] = (spans[-1][0], end)
            else:
                spans.append((start, end))
    return [(start, end) for start, end in spans if end - start > 0.05]


def _span_polygon(line, start, end, half_width):
    """沿一段开敞地段按 4 m 站距取点并缓冲成走廊面，两端点必在面内。"""
    distances = [start]
    distance = start + STATION_M
    while distance < end:
        distances.append(distance)
        distance += STATION_M
    distances.append(end)
    points = [(line.interpolate(value).x, line.interpolate(value).y) for value in distances]
    polygon = LineString(points).buffer(half_width, cap_style='flat', quad_segs=4)
    return polygon if not polygon.is_empty and polygon.area > 0 else None


def plan_tunnel_portal_mask(graph, terrain_surface, report=None, *, high_deck_only=False):
    """求全城隧道洞口走廊的并集；没有命中任何开敞段时返回空面。

    report['tunnelPortals'] 记 {'links': 参与裁切的隧道边数, 'portalSpans': 洞口开敞段数,
    'cutM2': 规划走廊总面积, 'genericCutM2': 实际裁掉的网格投影面积（由裁切步骤回填）}。
    审核 route 的 portalCutM2 由 road_structures 单独统计，两者不合并。
    """
    sampler = _SurfaceSampler(terrain_surface)
    ground = _ground_nodes(graph)
    deck_portals = _high_deck_portals(graph)
    corridors = []
    cut_links = 0
    portal_spans = 0
    for link, metadata in zip(graph['links'], graph['metadata']):
        if not metadata.get('tunnel'):
            continue
        if graph['names'][link[2]] == '南坪快速' and metadata.get('highway') == 'trunk':
            continue
        layer = metadata.get('layer') or 0
        depth = TUNNEL_LAYER_DEPTH_M * abs(layer)
        # layer 为 0 没有上下关系，运行时不建洞身，这里也不裁。
        if depth <= 0:
            continue
        joins_high_deck = metadata.get('osmId') in NANGUANG_BORES and any(node in deck_portals for node in link[:2])
        if high_deck_only and not joins_high_deck:
            continue
        shared_start = link[0] in ground or (joins_high_deck and link[0] in deck_portals)
        shared_end = link[1] in ground or (joins_high_deck and link[1] in deck_portals)
        if not shared_start and not shared_end:
            continue
        points = _source_points(graph, link)
        line = LineString([(x, z) for x, z in points]) if len(points) > 1 else None
        length = _polyline_length(points)
        if line is None or length <= 0:
            continue
        stations = _resample(points, length)
        if len(stations) < 2:
            continue
        # 运行时要求整条隧道每一站都能取到地形；缺站就不建洞身，这里跳过该边。
        if not joins_high_deck and any(sampler(x, z) is None for _, x, z in stations):
            continue
        transition_m = HIGH_DECK_TUNNEL_APPROACH_M if joins_high_deck else PORTAL_TRANSITION_M
        spans = _open_spans(length, depth, shared_start, shared_end, transition_m)
        if not spans:
            continue
        half_width = (max(_link_width(link), MIN_TUNNEL_WIDTH_M) + CORRIDOR_MARGIN_M) / 2
        polygons = [polygon for polygon in (_span_polygon(line, start, end, half_width) for start, end in spans)
                    if polygon is not None]
        if not polygons:
            continue
        corridors.extend(polygons)
        cut_links += 1
        portal_spans += len(polygons)
    mask = unary_union(corridors) if corridors else Polygon()
    if report is not None:
        report['tunnelPortals'] = {'links': cut_links, 'portalSpans': portal_spans,
                                   'cutM2': round(mask.area, 3), 'genericCutM2': 0.0}
    return mask


def apply_tunnel_portal_cut(payload, graph, report=None, terrain_surface=None):
    """在 terrainSurface 上裁出通用洞口走廊，返回新的表面字典；空 mask 时原样返回。"""
    surface = payload if terrain_surface is None else terrain_surface
    mask = plan_tunnel_portal_mask(graph, surface, report)
    if mask.is_empty:
        return payload
    cut, removed_area = cut_ground_openings(payload, mask)
    if report is not None:
        report['tunnelPortals']['genericCutM2'] = round(removed_area, 3)
    return cut