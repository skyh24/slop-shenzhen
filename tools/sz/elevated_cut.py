"""把高架桥面高于原地形的路段按"截断山体"裁开，桥面标高保持 layer×4.8 m。

口径取 js/sz-elevated-roads.js planLink 的非核实纵断面（round 55）：
    lift      = LAYER_HEIGHT_M * max(0, layer)
    base(d)   = (startGround + lift) + ((endGround + lift) - (startGround + lift)) * d / L
    weight(d) = min(共享起点 ? clamp01(d / rampLen) : 1,
                    共享终点 ? clamp01((L - d) / rampLen) : 1)
    deckY(d)  = base(d) - (1 - weight) * lift      # 落地端 12% 引道内贴地
桥面不再逐帧跟随地形，地形高于桥面时由本模块在山体上开出走廊，显示地形与桥面因此不会互相穿插。

只处理桥面比地形低 CUT_MIN_M 以上、且长度超过一个站距的连续段：这是"山体穿过桥面"的位置，
交错桥、审核立交与贴地匝道都不会命中。走廊宽 = max(源宽, 6.5 m) + 0.6 m 余量，与运行时
桥面最小铺装同口径；裁切复用 commercial_paving.cut_ground_openings，与隧道洞口同一套网格数据。
切口按"竖直截断"处理：裁掉的走廊四周补一圈竖直岩壁（顶部取原地形、底部落在桥面下 0.3 m），
不加边坡也不抬桥面，桥面因此像穿过路堑一样笔直（round 57 用户口径）。
"""

import math

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from commercial_paving import cut_ground_openings
from tunnel_portals import (_SurfaceSampler, _ground_nodes, _link_width, _polyline_length,
                            _resample, _source_points)

LAYER_HEIGHT_M = 4.8
ELEVATED_DRIVE_MAX_GRADE = 0.12
MIN_DECK_WIDTH_M = 6.5
CORRIDOR_MARGIN_M = 0.6
CUT_WALL_DROP_M = 0.3
CUT_MIN_M = 2.0
STATION_M = 4.0


def _deck_height(length, shared_start, shared_end, lift, start_ground, end_ground):
    """按运行时非核实纵断面返回 deckY(distance) 闭包。"""
    ramp_len = lift / ELEVATED_DRIVE_MAX_GRADE if lift > 0 else 0.0

    def clamp01(value):
        return 0.0 if value <= 0 else 1.0 if value >= 1 else value

    def height(distance):
        base = (start_ground + lift) + ((end_ground + lift) - (start_ground + lift)) \
            * min(1.0, distance / length)
        if ramp_len <= 0:
            return base
        weight = min(clamp01(distance / ramp_len) if shared_start else 1.0,
                     clamp01((length - distance) / ramp_len) if shared_end else 1.0)
        return base - (1 - weight) * lift

    return height


def _runs(values):
    """把 (distance, x, z, needs_cut) 序列切成连续需要裁切的段。"""
    runs, current = [], []
    for entry in values:
        if entry[3]:
            current.append(entry)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def plan_elevated_cut_mask(graph, terrain_surface):
    """求全城高架桥面截断山体的走廊并集，返回 (mask, 统计, 桥面采样)。

    桥面采样是落在切段内的 (x, z, 桥面标高)，供切口岩壁把底部贴在桥面下方。
    """
    sampler = _SurfaceSampler(terrain_surface)
    ground = _ground_nodes(graph)
    corridors = []
    deck_samples = []
    cut_links = 0
    cut_spans = 0
    for link, metadata in zip(graph['links'], graph['metadata']):
        if metadata.get('tunnel'):
            continue
        layer = metadata.get('layer') or 0
        if not metadata.get('bridge') and abs(layer) <= 0:
            continue
        lift = LAYER_HEIGHT_M * max(0, layer)
        points = _source_points(graph, link)
        length = _polyline_length(points)
        if length <= STATION_M or len(points) < 2:
            continue
        stations = _resample(points, length)
        if len(stations) < 2:
            continue
        start_ground = sampler(points[0][0], points[0][1])
        end_ground = sampler(points[-1][0], points[-1][1])
        if start_ground is None or end_ground is None:
            continue
        height = _deck_height(length, link[0] in ground, link[1] in ground, lift,
                              start_ground, end_ground)
        rows = []
        for distance, x, z in stations:
            sample = sampler(x, z)
            if sample is None:
                rows.append((distance, x, z, False))
                continue
            needs_cut = sample - height(distance) > CUT_MIN_M
            if needs_cut:
                deck_samples.append((x, z, height(distance)))
            rows.append((distance, x, z, needs_cut))
        runs = _runs(rows)
        half_width = (max(_link_width(link), MIN_DECK_WIDTH_M) + CORRIDOR_MARGIN_M) / 2
        polygons = []
        for run in runs:
            if len(run) < 2:
                continue
            line = LineString([(x, z) for _, x, z, _ in run])
            polygon = line.buffer(half_width, cap_style='flat', quad_segs=4)
            if not polygon.is_empty and polygon.area > 0:
                polygons.append(polygon)
        if not polygons:
            continue
        corridors.extend(polygons)
        cut_links += 1
        cut_spans += len(polygons)
    mask = unary_union(corridors) if corridors else Polygon()
    return mask, {'links': cut_links, 'spans': cut_spans, 'cutM2': round(mask.area, 3),
                  'removedM2': 0.0}, deck_samples


def build_cut_walls(mask, deck_samples, sampler):
    """沿截断走廊边界造一圈竖直岩壁：顶部取原地形，底部落在桥面下 CUT_WALL_DROP_M。"""
    if mask.is_empty or not deck_samples:
        return {'positions': [], 'triangles': 0, 'minY': 0.0, 'maxY': 0.0}
    from shapely.geometry import Point
    from shapely.strtree import STRtree
    stations = [Point(x, z) for x, z, _ in deck_samples]
    tree = STRtree(stations)
    heights = [height for _, _, height in deck_samples]
    positions, triangles = [], 0
    min_y, max_y = float('inf'), float('-inf')
    polygons = [mask] if mask.geom_type == 'Polygon' else list(mask.geoms)
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            points = list(ring.coords)[:-1]
            if len(points) < 3:
                continue
            tops, bottoms = [], []
            for x, z in points:
                top = sampler(x, z)
                if top is None:
                    tops.append(None)
                    continue
                nearest = int(tree.nearest(Point(x, z)))
                bottom = heights[nearest] - CUT_WALL_DROP_M
                tops.append(max(top, bottom))
                bottoms.append(bottom)
            for index in range(len(points)):
                following = (index + 1) % len(points)
                near, far = tops[index], tops[following]
                if near is None or far is None:
                    continue
                start, end = bottoms[index], bottoms[following]
                if near - start <= 1e-3 and far - end <= 1e-3:
                    continue
                a, b = points[index], points[following]
                positions.extend([a[0], start, a[1], a[0], near, a[1], b[0], far, b[1]])
                positions.extend([a[0], start, a[1], b[0], far, b[1], b[0], end, b[1]])
                triangles += 2
                min_y = min(min_y, start, end)
                max_y = max(max_y, near, far)
    if not positions:
        return {'positions': [], 'triangles': 0, 'minY': 0.0, 'maxY': 0.0}
    return {'positions': [round(value, 3) for value in positions], 'triangles': triangles,
            'minY': round(min_y, 3), 'maxY': round(max_y, 3)}


def apply_elevated_cut(surface, graph, report=None):
    """在山体上裁出高架桥面走廊并补竖直岩壁，返回新的 terrainSurface；空 mask 时原样返回。"""
    mask, stats, deck_samples = plan_elevated_cut_mask(graph, surface)
    if mask.is_empty:
        # 第二次调用（重建链路）落在已经裁过的地形上，保留首次统计。
        if report is not None and 'elevatedCut' not in report:
            report['elevatedCut'] = stats
        return surface
    from tunnel_portals import _SurfaceSampler
    walls = build_cut_walls(mask, deck_samples, _SurfaceSampler(surface))
    cut, removed_area = cut_ground_openings(surface, mask)
    if report is not None:
        stats['removedM2'] = round(removed_area, 3)
        stats['wallTriangles'] = walls['triangles']
        report['elevatedCut'] = stats
    return {**cut, 'cutWalls': walls}
