"""保持桥面纵断面，按竖直路堑裁掉侵入桥面的地形。

口径取 js/sz-elevated-roads.js planLink 的非核实纵断面（round 55）：
    lift      = 普通高架 4.8 m，南坪和南光高架主线 10.3 m
    base(d)   = (startGround + lift) + ((endGround + lift) - (startGround + lift)) * d / L
    weight(d) = min(共享起点 ? clamp01(d / rampLen) : 1,
                    共享终点 ? clamp01((L - d) / rampLen) : 1)
    deckY(d)  = base(d) - (1 - weight) * lift      # 落地端 12% 引道内贴地
桥面不再逐帧跟随地形，地形高于桥面时由本模块在山体上开出走廊，显示地形与桥面因此不会互相穿插。

普通桥沿中线识别地形高出路面的连续段；京港澳已标注的高架检测完整桥宽，按运行时车道断面裁切，
并保留桥头标高锚点。走廊加 0.6 m 余量，复用 commercial_paving.cut_ground_openings。
切口按"竖直截断"处理：裁掉的走廊四周补一圈竖直岩壁（顶部取原地形、底部落在桥面下 0.3 m），
不加边坡也不抬桥面，桥面因此像穿过路堑一样笔直（round 57 用户口径）。
"""

import math

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from commercial_paving import cut_ground_openings
from tunnel_portals import (_SurfaceSampler, _ground_nodes, _link_width, _polyline_length,
                            _high_deck_portals, _high_deck_road, _resample, _source_points)

DECK_RISE_M = 4.8
HIGH_DECK_RISE_M = 10.3
ELEVATED_DRIVE_MAX_GRADE = 0.12
MIN_DECK_WIDTH_M = 6.5
CORRIDOR_MARGIN_M = 0.6
CUT_WALL_DROP_M = 0.3
CUT_MIN_M = 2.0
STATION_M = 4.0
CUT_VERSION = 3


def _deck_height(length, shared_start, shared_end, lift, start_ground, end_ground, *, g4=False):
    """按运行时非核实纵断面返回 deckY(distance) 闭包。"""
    grade = ELEVATED_DRIVE_MAX_GRADE
    base_grade = abs(end_ground - start_ground) / length
    if g4 and base_grade < grade:
        grade -= base_grade
    ramp_len = lift / grade if lift > 0 else 0.0

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


def deck_width(link):
    # 与 sz-road-section.js 的 deckLaneProfile 同口径，包括路肩与护栏。
    source_width, lanes, direction = link[3:6]
    directions = 2 if direction == 0 else 1
    per_direction = math.floor(lanes / directions + 0.5) if lanes > 0 else math.floor(
        (source_width + 0.25) / 3.25 / directions)
    return max(source_width, min(4, max(1, per_direction)) * directions * 3.25 + 1.7)


def plan_elevated_cut_mask(graph, terrain_surface):
    """求全城高架桥面截断山体的走廊并集，返回 (mask, 统计, 桥面采样)。

    桥面采样是落在切段内的 (x, z, 桥面标高)，供切口岩壁把底部贴在桥面下方。
    """
    sampler = _SurfaceSampler(terrain_surface)
    ground = _ground_nodes(graph)
    deck_portals = _high_deck_portals(graph)
    g4_profiles = terrain_surface.get('g4Profiles', {})
    urban_areas = [spec['groundArea'] for spec in terrain_surface.get('interchangeLevels', [])]
    corridors = []
    deck_samples = []
    cut_links = 0
    cut_spans = 0
    for index, (link, metadata) in enumerate(zip(graph['links'], graph['metadata'], strict=True)):
        if metadata.get('tunnel') or str(index) in g4_profiles:
            continue
        layer = metadata.get('layer') or 0
        if not metadata.get('bridge') and abs(layer) <= 0:
            continue
        name = graph['names'][link[2]]
        # 南坪快速由整线水平断面单独裁山体，保留原隧道的覆土。
        if name == '南坪快速' and metadata.get('highway') == 'trunk':
            continue
        high = _high_deck_road(metadata, name)
        g4 = (metadata.get('bridge') and layer > 0 and metadata.get('highway') == 'motorway'
              and name == '京港澳高速')
        full_width = high or g4 or layer > 1
        lift = HIGH_DECK_RISE_M if high else DECK_RISE_M if layer > 0 else 0
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
        shared = [node in ground or (high and node in deck_portals) for node in link[:2]]
        height = _deck_height(length, *shared, lift, start_ground, end_ground, g4=g4 or high)
        width = deck_width(link) if full_width else max(_link_width(link), MIN_DECK_WIDTH_M)
        rows = []
        for i, (distance, x, z) in enumerate(stations):
            deck_y = height(distance)
            if full_width and 0 < i < len(stations) - 1:
                # 两侧山坡也可能先侵入桥面，沿完整断面探测，桥端保留与地面或下一跨的接点。
                _, ax, az = stations[i - 1]
                _, bx, bz = stations[i + 1]
                dx, dz = bx - ax, bz - az
                run = math.hypot(dx, dz) or 1
                samples = (sampler(x + offset * dz / run, z - offset * dx / run)
                           for offset in (-width / 2, -width / 4, 0, width / 4, width / 2))
                needs_cut = any(sample is not None and sample - deck_y > 0.05 for sample in samples)
            else:
                sample = sampler(x, z)
                needs_cut = not full_width and sample is not None and sample - deck_y > CUT_MIN_M
                if needs_cut:
                    deck_samples.append((x, z, deck_y))
            protected = any(area['minX'] <= x <= area['maxX'] and area['minZ'] <= z <= area['maxZ']
                            for area in urban_areas)
            rows.append((distance, x, z, needs_cut and not protected))
        if full_width:
            # 单站也可能是真实凸起，裁到相邻站，保留两端的高程锚点。
            rows = [(d, x, z, 0 < i < len(rows) - 1 and any(row[3] for row in rows[i - 1:i + 2]))
                    for i, (d, x, z, _) in enumerate(rows)]
        runs = _runs(rows)
        half_width = (width + CORRIDOR_MARGIN_M) / 2
        polygons = []
        for run in runs:
            if len(run) < 2:
                continue
            coords = [(x, z) for _, x, z, _ in run]
            if full_width:
                # 平端裁口延伸到相邻站间，避免曲线横断面斜交缓冲区端边而漏掉桥角。
                _, ax, az, _ = rows[rows.index(run[0]) - 1]
                _, bx, bz, _ = rows[rows.index(run[-1]) + 1]
                coords.insert(0, ((ax + coords[0][0]) / 2, (az + coords[0][1]) / 2))
                coords.append(((bx + coords[-1][0]) / 2, (bz + coords[-1][1]) / 2))
            line = LineString(coords)
            polygon = line.buffer(half_width, cap_style='flat', quad_segs=4)
            if not polygon.is_empty and polygon.area > 0:
                polygons.append(polygon)
                if full_width:
                    deck_samples.extend((x, z, height(d)) for d, x, z, _ in run)
        if not polygons:
            continue
        corridors.extend(polygons)
        cut_links += 1
        cut_spans += len(polygons)
    mask = unary_union(corridors) if corridors else Polygon()
    return mask, {'links': cut_links, 'spans': cut_spans, 'cutM2': round(mask.area, 3),
                  'removedM2': 0.0}, deck_samples


def build_cut_walls(mask, deck_samples, sampler, *, opening_floor=None):
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
            # 裁口直边可能只有两个端点，沿边补采样才能贴到中段隆起的山体断面。
            points = list(ring.segmentize(STATION_M).coords)[:-1]
            if len(points) < 3:
                continue
            tops, bottoms = [], []
            for x, z in points:
                top = sampler(x, z)
                if top is None:
                    tops.append(None)
                    bottoms.append(None)
                    continue
                nearest = int(tree.nearest(Point(x, z)))
                bottom = heights[nearest] - CUT_WALL_DROP_M
                if opening_floor is not None:
                    bottom = max(bottom, opening_floor(x, z))
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


def merge_cut_walls(previous, added, mask):
    """保留裁口外的原岩壁，新裁口内部的旧墙移除。"""
    from shapely.prepared import prep
    inside = prep(mask)
    old = (previous or {}).get('positions', [])
    retained = []
    for start in range(0, len(old), 9):
        triangle = old[start:start + 9]
        points = list(dict.fromkeys(zip(triangle[::3], triangle[2::3])))
        edge = LineString(points) if len(points) > 1 else Point(points[0])
        if not inside.contains(edge):
            retained.extend(triangle)
    positions = retained + added['positions']
    return {'positions': positions, 'triangles': len(positions) // 9,
            'minY': min(positions[1::3], default=0), 'maxY': max(positions[1::3], default=0)}


def apply_elevated_cut(surface, graph, report=None):
    """在山体上裁出高架桥面走廊并补竖直岩壁，返回新的 terrainSurface；空 mask 时原样返回。"""
    previous_walls = surface.get('cutWalls')
    previous = (report or {}).get('elevatedCut', {})
    if previous_walls is not None and previous.get('version') == CUT_VERSION:
        return surface
    # 增量构建按新层高探测新增侵入处，保留旧裁口边界的岩壁。
    mask, stats, deck_samples = plan_elevated_cut_mask(graph, surface)
    if mask.is_empty:
        if report is not None:
            report['elevatedCut'] = {**(previous or stats), 'version': CUT_VERSION}
        return surface
    walls = build_cut_walls(mask, deck_samples, _SurfaceSampler(surface))
    cut, removed_area = cut_ground_openings(surface, mask)
    walls = merge_cut_walls(previous_walls, walls, mask)
    if report is not None:
        stats['removedM2'] = round(removed_area, 3)
        if previous_walls is not None:
            for key in ('links', 'spans', 'cutM2', 'removedM2'):
                stats[key] = round(stats[key] + previous.get(key, 0), 3)
        stats['wallTriangles'] = walls['triangles']
        report['elevatedCut'] = {'version': CUT_VERSION, **stats}
    return {**cut, 'cutWalls': walls}
