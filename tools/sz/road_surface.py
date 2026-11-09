"""按 FABDEM 基线派生道路工程面高程，只改内存地形网格，原始 DSM 文件不动。

派生规则公开可复现，且只降不升（去污染方向）：
- 沿道路中心线每 10 m 取 FABDEM V1-2（已去建筑、去树冠的模型 DTM）站点高程，
  先中值滤波压尖峰，再与该处原 DSM 运行时高程取小值作逐站参考；
- 参考序列再中值滤波一次，共享路网节点取各入射已解析路段端点参考的中位高程；
- 按道路等级限制纵坡（高速/快速 6%、主干 7%、次干 8%、其余 10%），前后两遍压坡；
- 横断面保持水平（同一站点横向同高，不做超高和横坡）；
- 路面平台半径 = 最近站点半宽 + 1.5 倍地形网格间距，平台外自适应 smoothstep
  过渡回原 DSM 高程，范围外完全不改；
- 派生顶点最终不允许高于原 DSM + 0.5 m；陡坡山地和锁定地形排除区保留原样；
- 量化到地形 heightScale 后才替换网格整数值，只替换变化的格点。

派生面只在构建报告里标 heightSource='derived-road'，不冒充实测高程；原始 GeoTIFF
和 DSM 网格都不写回文件。桥、隧道和 layer 路段单独处理，不参与平滑。
"""

import json
import math
import time
from collections import Counter
from pathlib import Path

import numpy as np
from shapely import STRtree, contains_xy, points, prepare, union_all

from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON
from roads import CLASS_OF

ROOT = Path(__file__).resolve().parents[2]
CANDIDATES_PATH = ROOT / 'data/source/terrain-candidates.json'
BASELINE_SOURCE_ID = 'fabdem-bristol-v1.2'

TERRAIN_KEYS = ('x0', 'z0', 'step', 'nx', 'nz', 'heightScale', 'heights')
GRAPH_KEYS = ('nodes', 'links', 'metadata', 'names')

STATION_SPACING_M = 10.0
TRANSITION_M = 15.0
MAX_TRANSITION_M = 45.0
MAX_TRANSITION_SLOPE = 0.20
STEEP_DSM_STEP_LIMIT_M = 3.0
PLATEAU_BUFFER_STEPS = 1.5
MIN_LINK_WIDTH_M = 3.0
MIN_LINK_LENGTH_M = 5.0
GRADE_CLAMP_PASSES = 3
NODE_RELAXATION_ITERATIONS = 10
MEDIAN_FILTER_WINDOW = 7
SPIKE_REPORT_LIMIT_M = 3.0
RAISE_CAP_M = 0.5
RELAXATION_ITERATIONS = 10
RELAXATION_ALPHA = 0.5
ADJACENT_DELTA_LIMIT_M = 0.5
INSIDE_STEP_LIMIT_M = 1.7
INSIDE_STEP_ITERATIONS = 60
RIM_FADE_LAYERS = 3
LARGE_DELTA_M = 5.0
MAX_LARGE_DELTA_ENTRIES = 200
MAX_UNRESOLVED_ENTRIES = 50

CLASS_ORDER = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'local', 'service', 'pedestrian')
MAX_GRADE_PERCENT_BY_CLASS = {
    'motorway': 6.0,
    'trunk': 6.0,
    'primary': 7.0,
    'secondary': 8.0,
    'tertiary': 10.0,
    'local': 10.0,
    'service': 10.0,
    'pedestrian': 10.0,
}

METHOD_TEXT = (
    'FABDEM station baseline median-filtered to reject residual building/canopy spikes, then reduced to '
    'min(filtered FABDEM, original DSM runtime height) per station with nodata fallbacks; the reference '
    'series is median-filtered again; shared nodes pinned to the median incident reference endpoint and '
    'relaxed within the class grade allowance; class grade clamp with forward/backward passes; flat '
    'cross-section; plateau radius = nearest station half width + 1.5 terrain steps; adaptive smoothstep '
    'transition (15 m minimum, widened where the profile differs from the DSM); bounded Laplacian '
    'relaxation and an inside-corridor single-cell step limit; derived vertices never exceed '
    'the original DSM by more than the raise cap; quantized to terrain heightScale'
)

LIMITATIONS = [
    'FABDEM is a modelled DTM (source GLO-30 mainly 2011-2015) and still contains residual building and '
    'canopy height in dense areas; the derived surface is an explicitly estimated engineering surface, '
    'not measured elevation',
    'The derived surface is a de-contamination (lowering) pass only: it never exceeds the original DSM by '
    'more than the raise cap, so the DSM absolute level and building bases stay consistent',
    'Where the original DSM is contaminated upward over a whole link, min(FABDEM, DSM) cannot remove all of '
    'it; the residual is capped by the raise cap and reported as capped vertices',
    'Bridge, tunnel and layer links keep the original terrain and are not smoothed',
    'Links without a complete FABDEM station profile keep the original terrain; the list is capped',
    'Links with any station inside a locked terrain exclusion polygon keep the original terrain',
    'The flat cross-section ignores real superelevation, cross fall, kerb and sidewalk level changes',
    'A link whose two node elevations exceed the class grade allowance keeps both nodes (network continuity '
    'wins) and is reported as grade-infeasible',
    'The transition band is widened on purpose where the derived surface differs a lot from the DSM, so '
    'the modified footprint can exceed half width + 1.5 steps + 15 m in contaminated areas',
]

REQUIRED_GRAPH_METADATA = ('heightSource',)

def _round(value, digits=3):
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)

def _exclusion_union(excluded_polygons):
    """把锁定地形排除区（面或带 poly/polygon 的字典）合并成 prepared 几何。"""
    if not excluded_polygons:
        return None
    if isinstance(excluded_polygons, (str, bytes)):
        raise ValueError('excluded_polygons must be a list of polygons or records')
    try:
        items = list(excluded_polygons)
    except TypeError as error:
        raise ValueError('excluded_polygons must be a list of polygons or records') from error
    geometries = []
    for item in items:
        if isinstance(item, dict):
            geometry = item.get('poly', item.get('polygon'))
        else:
            geometry = item
        if geometry is None or geometry.is_empty:
            continue
        if geometry.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError('excluded_polygons entries must be Polygon or MultiPolygon')
        geometries.append(geometry)
    if not geometries:
        return None
    union = union_all(geometries)
    prepare(union)
    return union

def _validate_terrain(terrain):
    """校验地形字典并返回整数量化高程数组。"""
    if not isinstance(terrain, dict):
        raise ValueError('terrain must be a dict')
    missing = [key for key in TERRAIN_KEYS if key not in terrain]
    if missing:
        raise ValueError(f'terrain is missing keys: {missing}')
    for key in ('x0', 'z0', 'step', 'heightScale'):
        value = terrain[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise ValueError(f'terrain {key} must be a number')
        if not math.isfinite(float(value)):
            raise ValueError(f'terrain {key} must be finite')
        if key in ('step', 'heightScale') and float(value) <= 0:
            raise ValueError(f'terrain {key} must be positive')
    for key in ('nx', 'nz'):
        value = terrain[key]
        if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or int(value) < 2:
            raise ValueError(f'terrain {key} must be an integer of at least 2')
    heights = np.asarray(terrain['heights'])
    if heights.ndim != 1 or heights.size != int(terrain['nx']) * int(terrain['nz']):
        raise ValueError(f'terrain heights count {heights.size} does not match nx * nz')
    if not np.issubdtype(heights.dtype, np.integer):
        if not np.equal(np.rint(heights), heights).all():
            raise ValueError('terrain heights must be integers at heightScale')
        heights = heights.astype(np.int64)
    if not np.isfinite(heights).all():
        raise ValueError('terrain heights must be finite')
    return heights.astype(np.int64)

def _validate_graph(road_graph):
    """校验路网字典并返回 (节点数, Nx2 节点坐标数组)。"""
    if not isinstance(road_graph, dict):
        raise ValueError('road_graph must be a dict')
    missing = [key for key in GRAPH_KEYS if key not in road_graph]
    if missing:
        raise ValueError(f'road_graph is missing keys: {missing}')
    try:
        nodes = np.asarray(road_graph['nodes'], dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError('road_graph nodes must be numbers') from error
    if nodes.ndim != 1 or nodes.size % 2 != 0 or nodes.size == 0 or not np.isfinite(nodes).all():
        raise ValueError('road_graph nodes must be a finite flat even-length array')
    node_count = nodes.size // 2
    links, metadata, names = road_graph['links'], road_graph['metadata'], road_graph['names']
    if not isinstance(links, list) or not isinstance(metadata, list) or not isinstance(names, list):
        raise ValueError('road_graph links, metadata and names must be lists')
    if len(metadata) != len(links):
        raise ValueError('road_graph links and metadata must have the same length')
    for index, link in enumerate(links):
        if not isinstance(link, (list, tuple)) or len(link) < 7:
            raise ValueError(f'road_graph link {index} is malformed')
        for node_index in (link[0], link[1]):
            if (isinstance(node_index, bool) or not isinstance(node_index, (int, np.integer))
                    or not 0 <= int(node_index) < node_count):
                raise ValueError(f'road_graph link {index} node indices must be integers in range')
        width = link[3]
        if (isinstance(width, bool) or not isinstance(width, (int, float, np.integer, np.floating))
                or not math.isfinite(float(width)) or float(width) <= 0):
            raise ValueError(f'road_graph link {index} width must be finite and positive')
        try:
            inner_array = np.asarray(link[6], dtype=float)
        except (TypeError, ValueError) as error:
            raise ValueError(f'road_graph link {index} centerline points must be numbers') from error
        if link[6] is None or inner_array.ndim != 1 or inner_array.size % 2 != 0:
            raise ValueError(f'road_graph link {index} centerline points must be flat x/z pairs')
        if not isinstance(metadata[index], dict) or 'heightSource' not in metadata[index]:
            raise ValueError(f'road_graph metadata {index} is missing heightSource')
    return nodes.reshape(-1, 2), node_count

def _class_of(metadata):
    """返回道路等级；未收录的 highway 值不计入派生并单独计数。"""
    return CLASS_OF.get(metadata.get('highway'))

def _select_links(links, metadata):
    """筛出可派生路段，按第一个不满足的条件记录排除原因。"""
    excluded = Counter()
    selected = []
    for index, meta in enumerate(metadata):
        reason = ('bridge' if meta.get('bridge') else 'tunnel' if meta.get('tunnel')
                  else 'layer' if meta.get('layer') else
                  'notTerrainHeightSource' if meta.get('heightSource') != 'terrain' else
                  'unknownRoadClass' if _class_of(meta) is None else
                  'narrowWidth' if float(links[index][3]) < MIN_LINK_WIDTH_M else None)
        selected.append(index) if reason is None else excluded.update([reason])
    return selected, excluded

def _link_path(nodes, link):
    inner = np.asarray(link[6], dtype=float).reshape(-1, 2)
    return np.vstack((nodes[int(link[0])], inner, nodes[int(link[1])]))

def _station_geometry(path):
    """按 10 m 站距重采样，返回里程、站点坐标和路段几何；总长不足 5 m 时返回 None。"""
    segments = np.linalg.norm(np.diff(path, axis=0), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(segments)))
    length = float(cumulative[-1])
    if length < MIN_LINK_LENGTH_M:
        return None
    stations = np.append(np.arange(0.0, length, STATION_SPACING_M), length)
    x = np.interp(stations, cumulative, path[:, 0])
    z = np.interp(stations, cumulative, path[:, 1])
    return {'stations': stations, 'x': x, 'z': z, 'length': length,
            'path': path, 'cumulative': cumulative, 'segments': segments}

def _lonlat(x, z):
    return ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY

def _baseline_manifest(sampler):
    """读取候选高程清单；外部注入 sampler 时允许清单缺失。"""
    try:
        record = json.loads(CANDIDATES_PATH.read_text())
    except (OSError, ValueError) as error:
        if sampler is not None:
            return {'checkedAt': None}, {'id': BASELINE_SOURCE_ID}
        raise ValueError('Road surface baseline manifest is unavailable; pass sampler=...') from error
    source = next((item for item in record.get('sources', []) if item.get('id') == BASELINE_SOURCE_ID), None)
    if source is None:
        if sampler is not None:
            return record, {'id': BASELINE_SOURCE_ID}
        raise ValueError(f'Road surface baseline source is missing: {BASELINE_SOURCE_ID}')
    return record, source

def _load_baseline_raster(source):
    """用审计脚本的读取器载入 FABDEM，校验字节数和 sha256。"""
    from audit_terrain_candidates import read_candidate

    try:
        return read_candidate(source)
    except (OSError, ValueError, KeyError) as error:
        raise ValueError(
            'FABDEM baseline raw files are unavailable or failed hash verification; '
            'pass sampler=... to use an injected baseline'
        ) from error

def _sample_raster(raster, lon, lat):
    """按 Raster 的双线性规则批量采样；范围外或 nodata 返回 NaN。"""
    data = raster.data
    fx = (lon - raster.x) / raster.dx
    fy = (lat - raster.y) / raster.dy
    valid = np.isfinite(fx) & np.isfinite(fy)
    i = np.floor(np.where(valid, fx, 0.0)).astype(np.int64)
    j = np.floor(np.where(valid, fy, 0.0)).astype(np.int64)
    valid &= (i >= 0) & (j >= 0) & (i + 1 < data.shape[1]) & (j + 1 < data.shape[0])
    values = np.full(lon.shape, np.nan, dtype=float)
    if not valid.any():
        return values
    ii, jj = i[valid], j[valid]
    tx, ty = fx[valid] - ii, fy[valid] - jj
    v00, v01 = data[jj, ii].astype(float), data[jj, ii + 1].astype(float)
    v10, v11 = data[jj + 1, ii].astype(float), data[jj + 1, ii + 1].astype(float)
    ok = np.isfinite(v00) & np.isfinite(v01) & np.isfinite(v10) & np.isfinite(v11)
    if raster.nodata is not None:
        ok &= (v00 != raster.nodata) & (v01 != raster.nodata) & (v10 != raster.nodata) & (v11 != raster.nodata)
    height = (v00 * (1 - tx) * (1 - ty) + v01 * tx * (1 - ty)
              + v10 * (1 - tx) * ty + v11 * tx * ty) * raster.scale
    flat = np.flatnonzero(valid)
    values[flat[ok]] = height[ok]
    return values

def _sample_stations(sampler, raster, lon, lat):
    """采样测站基线高程；注入 sampler 时逐个调用并接受 None / NaN 为缺测。"""
    if sampler is None:
        return _sample_raster(raster, lon, lat)
    values = np.full(lon.shape, np.nan, dtype=float)
    for index, (station_lon, station_lat) in enumerate(zip(lon, lat)):
        value = sampler(float(station_lon), float(station_lat))
        if value is not None:
            values[index] = float(value)
    values[~np.isfinite(values)] = np.nan
    return values

def _median_by_group(groups, values, size):
    """按组取中位值；没有样本的组保持 NaN。"""
    result = np.full(size, np.nan, dtype=float)
    if groups.size == 0:
        return result
    order = np.argsort(groups, kind='stable')
    sorted_groups, sorted_values = groups[order], values[order]
    unique, starts = np.unique(sorted_groups, return_index=True)
    ends = np.append(starts[1:], sorted_groups.size)
    for group, start, end in zip(unique, starts, ends):
        result[int(group)] = float(np.median(sorted_values[start:end]))
    return result

def _local_step_grid(values):
    """原地形网格 4 邻接最大高差，用于识别陡坡山地并避免在陡坡上造出台阶。"""
    padded = np.pad(values, 1, mode='edge')
    centre = padded[1:-1, 1:-1]
    return np.maximum.reduce([np.abs(padded[1:-1, :-2] - centre),
                              np.abs(padded[1:-1, 2:] - centre),
                              np.abs(padded[:-2, 1:-1] - centre),
                              np.abs(padded[2:, 1:-1] - centre)])

def _relax_node_levels(start_nodes, end_nodes, lengths, grades, initial, iterations):
    """在网络范围内松弛共享节点高程，使每条路段的端点高差落在等级坡度允许范围内。

    逐点中位得到的节点高程在山区或受污染 DSM 下会互相矛盾（短路段被拉成陡坡），
    这里用固定次数的对称松弛把矛盾摊到整个连通路网上，保持确定性。
    """
    levels = initial.astype(float).copy()
    allowed = lengths * grades / 100.0 * 0.98
    start_nodes = np.asarray(start_nodes, dtype=np.int64)
    end_nodes = np.asarray(end_nodes, dtype=np.int64)
    for _ in range(iterations):
        difference = levels[end_nodes] - levels[start_nodes]
        excess = difference - np.clip(difference, -allowed, allowed)
        adjustment = excess * 0.5
        np.add.at(levels, start_nodes, adjustment)
        np.add.at(levels, end_nodes, -adjustment)
    return levels

def _forward_pass(profile, limit):
    out = profile.astype(float).copy()
    for index in range(1, out.size):
        step = limit[index - 1]
        previous = out[index - 1]
        out[index] = min(max(out[index], previous - step), previous + step)
    return out

def _backward_pass(profile, limit):
    out = profile.astype(float).copy()
    for index in range(out.size - 2, -1, -1):
        step = limit[index]
        following = out[index + 1]
        out[index] = min(max(out[index], following - step), following + step)
    return out

def _limit_profile(raw, distances, grade_percent, start, end):
    """端点钉死后按坡度限制压坡；端点高差超出可达范围时保留端点并返回不可行。"""
    limit = np.diff(distances) * grade_percent / 100.0
    reach = np.concatenate(([0.0], np.cumsum(limit)))
    total = reach[-1]
    feasible = abs(end - start) <= total + 1e-9
    ratio = distances / distances[-1]
    profile = raw + (start - raw[0]) * (1 - ratio) + (end - raw[-1]) * ratio
    if not feasible:
        # 路网连通优先：两端节点高程都保留，坡度只作为尽力约束并在报告里标不可行。
        profile[0], profile[-1] = start, end
        return profile, False
    lower = np.maximum(start - reach, end - (total - reach))
    upper = np.minimum(start + reach, end + (total - reach))
    for _ in range(GRADE_CLAMP_PASSES):
        profile = _forward_pass(profile, limit)
        profile = _backward_pass(profile, limit)
        profile = np.clip(profile, lower, upper)
    profile[0], profile[-1] = start, end
    return profile, True

def _station_base(profile):
    """横向平台取值：最近测站与同一路段前后测站按 (1,2,1) 加权，避免站点台阶。"""
    count = profile.size
    index = np.arange(count)
    previous = profile[np.maximum(index - 1, 0)]
    following = profile[np.minimum(index + 1, count - 1)]
    return (2.0 * profile + previous + following) * 0.25

def _median_filter(values, window):
    """奇数窗口中值滤波；短路段自动缩小窗口，返回 (滤波值, 最大绝对剔除尖峰)。"""
    count = values.size
    if count < 3:
        return values.astype(float).copy(), 0.0
    width = min(window, count if count % 2 == 1 else count - 1)
    if width < 3:
        return values.astype(float).copy(), 0.0
    half = width // 2
    padded = np.pad(values, half, mode='edge')
    windows = np.lib.stride_tricks.sliding_window_view(padded, width)
    filtered = np.median(windows, axis=-1)
    return filtered, float(np.max(np.abs(values - filtered)))

def _sample_original_terrain(terrain, heights, terrain_sampler, xs, zs):
    """沿中心线测站采样原地形 DSM；注入 terrain_sampler 时逐点调用，缺测返回 NaN。"""
    if terrain_sampler is None:
        return _terrain_surface_values(terrain, heights, xs, zs)
    values = np.full(xs.shape, np.nan, dtype=float)
    for index, (x_value, z_value) in enumerate(zip(xs, zs)):
        value = terrain_sampler(float(x_value), float(z_value))
        if value is not None:
            values[index] = float(value)
    values[~np.isfinite(values)] = np.nan
    return values

def _rim_fade_weights(cut_mask, layers, shape):
    """计算人工切口（陡坡、锁定排除区）附近派生面向原地形淡出的权重。

    派生面被陡坡或锁定排除区切断时，边界处直接给平台高程会形成新的陡坎；按层淡出
    到原地形高程可以把切口摊到几格之内，而且不会抬高（原地形是上限之一）。
    """
    weights = np.zeros(shape, dtype=float)
    front = cut_mask
    for layer in range(1, layers + 1):
        padded = np.pad(front, 1, mode='edge')
        grown = (padded[1:-1, :-2] | padded[1:-1, 2:]
                 | padded[:-2, 1:-1] | padded[2:, 1:-1])
        newly = grown & ~cut_mask & (weights == 0.0)
        weights[newly] = (layers + 1 - layer) / (layers + 1)
        front = grown
    return weights

def _relax_derived(field, mask, iterations, alpha):
    """派生顶点上的加权拉普拉斯松弛；原地形顶点是固定边界，线性坡面保持不变。"""
    for _ in range(iterations):
        padded = np.pad(field, 1, mode='edge')
        average = (padded[1:-1, :-2] + padded[1:-1, 2:]
                   + padded[:-2, 1:-1] + padded[2:, 1:-1]) * 0.25
        field = np.where(mask, field + alpha * (average - field), field)
    return field

def _nearest_station(tree, coordinates):
    """STRtree 批量最近邻；返回 (最近测站下标, 距离)。"""
    pair, distances = tree.query_nearest(points(coordinates), return_distance=True, all_matches=False)
    nearest = np.full(coordinates.shape[0], -1, dtype=np.int64)
    nearest_distances = np.full(coordinates.shape[0], np.inf, dtype=float)
    if pair.size:
        input_index = np.asarray(pair[0], dtype=np.int64)
        nearest[input_index] = np.asarray(pair[1], dtype=np.int64)
        nearest_distances[input_index] = np.asarray(distances, dtype=float)
    if (nearest < 0).any():
        raise RuntimeError('STRtree nearest query did not resolve every terrain vertex')
    return nearest, nearest_distances

def _profile_at_vertices(coordinates, link_of_vertex, resolved, mask):
    """把顶点投影到最近测站所属路段，取纵断面在该处里程的内插值。

    最近测站决定使用哪条路段的走廊；纵断面在路段内线性插值，消除按最近站点
    直接取值时在站界出现的台阶。
    """
    heights = np.full(coordinates.shape[0], np.nan, dtype=float)
    selected = np.flatnonzero(mask)
    if not selected.size:
        return heights
    groups = link_of_vertex[selected]
    order = np.argsort(groups, kind='stable')
    selected = selected[order]
    groups = groups[order]
    unique, starts = np.unique(groups, return_index=True)
    ends = np.append(starts[1:], groups.size)
    for link_index, start, end in zip(unique, starts, ends):
        info = resolved[int(link_index)]
        path = info['path']
        if path.shape[0] < 2:
            heights[selected[start:end]] = info['base'][0]
            continue
        points_here = coordinates[selected[start:end]]
        direction = path[1:] - path[:-1]
        squared = np.where(np.einsum('ij,ij->i', direction, direction) > 0.0,
                           np.einsum('ij,ij->i', direction, direction), 1.0)
        relative = points_here[:, None, :] - path[None, :-1, :]
        t = np.clip(np.einsum('mij,ij->mi', relative, direction) / squared[None, :], 0.0, 1.0)
        offset = relative - t[:, :, None] * direction[None, :, :]
        segment = np.argmin(np.einsum('mij,mij->mi', offset, offset), axis=1)
        chainage = info['cumulative'][segment] + t[np.arange(t.shape[0]), segment] * info['segments'][segment]
        heights[selected[start:end]] = np.interp(chainage, info['distances'], info['base'])
    return heights

def _terrain_surface_values(terrain, heights, xs, zs):
    """按地形网格的 ne-sw 对角线双线性采样原 DSM 高程，用于前后高差对比。"""
    x0, z0 = float(terrain['x0']), float(terrain['z0'])
    step = float(terrain['step'])
    nx, nz = int(terrain['nx']), int(terrain['nz'])
    scale = float(terrain['heightScale'])
    scaled = heights.astype(float) * scale
    fx = (xs - x0) / step
    fz = (zs - z0) / step
    valid = np.isfinite(fx) & np.isfinite(fz)
    i = np.floor(np.where(valid, fx, 0.0)).astype(np.int64)
    j = np.floor(np.where(valid, fz, 0.0)).astype(np.int64)
    valid &= (i >= 0) & (j >= 0) & (i < nx - 1) & (j < nz - 1)
    values = np.full(xs.shape, np.nan, dtype=float)
    if not valid.any():
        return values
    ii, jj = i[valid], j[valid]
    u, v = fx[valid] - ii, fz[valid] - jj
    base = jj * nx + ii
    a, b, c, d = scaled[base], scaled[base + 1], scaled[base + nx], scaled[base + nx + 1]
    values[valid] = np.where(u + v <= 1,
                             a + (b - a) * u + (c - a) * v,
                             d + (c - d) * (1 - u) + (b - d) * (1 - v))
    return values

def _limit_inside_steps(field, derived, iterations, caps):
    """把走廊内相邻派生顶点的单格高差压到限值内，同时始终不高于原地形抬高上限。

    只调整派生顶点，原地形不动；对称摊分，迭代次数固定，结果确定。
    """
    for _ in range(iterations):
        for axis in (0, 1):
            first = [slice(None), slice(None)]
            second = [slice(None), slice(None)]
            first[axis], second[axis] = slice(None, -1), slice(1, None)
            first, second = tuple(first), tuple(second)
            difference = field[first] - field[second]
            both = derived[first] & derived[second]
            excess = difference - np.clip(difference, -INSIDE_STEP_LIMIT_M, INSIDE_STEP_LIMIT_M)
            adjustment = np.where(both, excess * 0.5, 0.0)
            field[first] -= adjustment
            field[second] += adjustment
        np.minimum(field, caps, out=field)
    return field

def _adjacent_stats(values, original, derived, plateau):
    """统计 4 邻接格点高差：走廊内、平台内、平台边沿和新增边沿台阶。"""

    def collect(axis):
        first, second = [slice(None)] * 2, [slice(None)] * 2
        first[axis], second[axis] = slice(None, -1), slice(1, None)
        first, second = tuple(first), tuple(second)
        return (np.abs(values[first] - values[second]), np.abs(original[first] - original[second]),
                derived[first] & derived[second], plateau[first] & plateau[second],
                derived[first] ^ derived[second])

    deltas = [collect(0), collect(1)]

    def maximum(mask_index):
        return max((float(delta[mask].max()) if mask.any() else 0.0
                    for delta, _, *masks in deltas for mask in [masks[mask_index]]), default=0.0)

    inside_max = maximum(0)
    plateau_max = maximum(1)
    rim_max = maximum(2)
    rim_new = max((float(np.max(delta[rim] - base_delta[rim])) if rim.any() else 0.0
                   for delta, base_delta, _, _, rim in deltas), default=0.0)
    inside_new = max((float(np.max(delta[inside] - base_delta[inside])) if inside.any() else 0.0
                      for delta, base_delta, inside, _, _ in deltas), default=0.0)
    over_two = sum(int((delta[inside] > 2.0).sum()) for delta, _, inside, _, _ in deltas)
    over_five = sum(int((delta[inside] > 5.0).sum()) for delta, _, inside, _, _ in deltas)
    plateau_over_two = sum(int((delta[plateau_mask] > 2.0).sum())
                           for delta, _, _, plateau_mask, _ in deltas)
    return {'inside': inside_max, 'plateau': plateau_max, 'rim': rim_max,
            'rimNew': max(rim_new, 0.0), 'insideNew': max(inside_new, 0.0),
            'over2M': over_two, 'over5M': over_five, 'plateauOver2M': plateau_over_two}

def _baseline_report(record, source, injected):
    files = [{key: item.get(key) for key in ('path', 'sha256', 'bytes')} for item in source.get('files', [])]
    return {
        'heightSource': 'derived-road',
        'sourceId': source.get('id'),
        'productType': source.get('productType'),
        'verticalDatum': source.get('verticalDatum'),
        'acquisition': source.get('acquisition'),
        'license': source.get('license'),
        'licenseReference': source.get('licenseReference'),
        'reference': source.get('reference'),
        'checkedAt': record.get('checkedAt'),
        'files': files,
        'sampler': 'injected' if injected else 'manifest-geotiff',
        'attribution': ('FABDEM V1-2 (University of Bristol) contains modified Copernicus GLO-30 '
                        'elevation data; CC BY-NC-SA 4.0 plus Copernicus attribution terms.'),
    }

def _rule_report(step, height_scale):
    return {
        'stationSpacingM': STATION_SPACING_M, 'gradeClampPasses': GRADE_CLAMP_PASSES,
        'maxGradePercentByClass': dict(sorted(MAX_GRADE_PERCENT_BY_CLASS.items())),
        'stationMedianFilterWindow': MEDIAN_FILTER_WINDOW,
        'referenceRule': f'reference = median_filter(min(median_filter(FABDEM), original DSM runtime height), '
                         f'{MEDIAN_FILTER_WINDOW}) with nodata fallbacks; lowering only',
        'raiseCapM': RAISE_CAP_M, 'plateauBufferSteps': PLATEAU_BUFFER_STEPS,
        'plateauBufferRule': 'nearest station half width + 1.5 * terrain step',
        'transitionM': TRANSITION_M, 'maxTransitionSlope': MAX_TRANSITION_SLOPE,
        'maxTransitionM': MAX_TRANSITION_M,
        'transitionRule': 'width = clip(|profile - original DSM| / maxTransitionSlope, minTransitionM, maxTransitionM)',
        'plateauRelaxation': {'iterations': RELAXATION_ITERATIONS, 'alpha': RELAXATION_ALPHA,
                              'scope': 'derived vertices only; original terrain is a fixed boundary'},
        'insideStepLimit': {'limitM': INSIDE_STEP_LIMIT_M, 'iterations': INSIDE_STEP_ITERATIONS,
                            'scope': 'adjacent derived vertices inside one corridor, with the raise cap applied'},
        'rimFadeLayers': RIM_FADE_LAYERS,
        'steepTerrainExclusion': {'maxLocalDsmStepM': STEEP_DSM_STEP_LIMIT_M,
                                  'rule': 'terrain cells steeper than this keep the original DSM'},
        'nodeLevelRelaxation': {'iterations': NODE_RELAXATION_ITERATIONS,
                                'rule': 'shared node levels relaxed so endpoints fit the class grade allowance'},
        'junctionContinuity': 'shared nodes use the median of incident resolved link reference endpoints',
        'quantizationM': height_scale, 'terrainStepM': step, 'method': METHOD_TEXT,
    }

def _with_derived_marker(terrain, heights, **details):
    """复制地形字典并记录 derived-road 标记；不修改输入。"""
    result = {**terrain, 'heights': heights.tolist()}
    if isinstance(terrain.get('processing'), dict):
        result['processing'] = {**terrain['processing'],
                                'roadSurface': {'heightSource': 'derived-road', **details}}
    return result

def _empty_result(terrain, heights, status, excluded, baseline, rule, started, reason):
    report = {
        'status': status, 'reason': reason, 'heightSource': 'derived-road',
        'baseline': baseline, 'rule': rule,
        'links': {'total': None, 'eligible': 0, 'resolved': 0, 'unresolved': 0, 'gradeInfeasible': 0,
                  'excluded': dict(sorted(excluded.items())), 'excludedTerrain': 0,
                  'reference': {'rule': 'min(median filtered FABDEM, original DSM)'}},
        'stations': {'count': 0, 'spacingM': STATION_SPACING_M, 'medianFilterWindow': MEDIAN_FILTER_WINDOW,
                     'spikeLimitM': SPIKE_REPORT_LIMIT_M, 'filteredLinks': 0,
                     'spikeSamplesOverLimit': 0, 'maxRejectedSpikeM': None},
        'vertices': {'total': int(heights.size), 'derived': 0, 'plateau': 0, 'transition': 0,
                     'changed': 0, 'changedFraction': 0.0, 'maxAbsDeltaM': None, 'p95AbsDeltaM': None,
                     'maxAdjacentDeltaM': None, 'plateauAdjacentDeltaM': None, 'rimAdjacentDeltaM': None,
                     'rimNewStepM': None, 'insideNewStepM': None,
                     'adjacentStepsOver2M': 0, 'adjacentStepsOver5M': 0, 'plateauStepsOver2M': 0,
                     'raisedCapped': 0, 'maxRaiseM': None, 'excluded': 0,
                     'limitM': ADJACENT_DELTA_LIMIT_M},
        'classes': {},
        'largeDeltas': [],
        'unresolvedLinks': [],
        'timing': {'totalSeconds': _round(time.perf_counter() - started)},
        'limitations': LIMITATIONS,
    }
    return _with_derived_marker(terrain, heights, changedVertices=0), report

def build_road_surface(terrain, road_graph, report, *, sampler=None, terrain_sampler=None,
                       excluded_polygons=()):
    """派生平滑路面高程，返回新的地形字典；不修改输入，且只降低、不抬高。

    terrain: 地形网格字典，字段 x0/z0/step/nx/nz/heightScale/heights，heights 为 heightScale 整数。
    road_graph: 路网字典，字段 nodes/links/metadata/names，与 js/sz-roads.js 的 isGroundRoad 口径一致。
    report: 构建报告字典，函数写入 report['roadSurface']。
    sampler: 可选 (lon, lat) -> float | None，注入 FABDEM 基线采样；默认按
             data/source/terrain-candidates.json 用审计读取器载入本地 GeoTIFF。
    terrain_sampler: 可选 (x, z) -> float | None，采样原地形高程用于前后高差；默认用输入网格双线性。
    excluded_polygons: 锁定地形排除区（shapely 面或带 poly/polygon 的字典），区内顶点和站点不参与派生。
    """
    started = time.perf_counter()
    if not isinstance(report, dict):
        raise ValueError('report must be a dict')
    if sampler is not None and not callable(sampler):
        raise ValueError('sampler must be callable or None')
    excluded_union = _exclusion_union(excluded_polygons)
    heights = _validate_terrain(terrain)
    nodes, node_count = _validate_graph(road_graph)
    if terrain_sampler is not None and not callable(terrain_sampler):
        raise ValueError('terrain_sampler must be callable or None')

    x0, z0 = float(terrain['x0']), float(terrain['z0'])
    step, height_scale = float(terrain['step']), float(terrain['heightScale'])
    nx, nz = int(terrain['nx']), int(terrain['nz'])

    record, source = _baseline_manifest(sampler)
    injected = sampler is not None
    baseline = _baseline_report(record, source, injected)
    rule = _rule_report(step, height_scale)

    links, metadata, names = road_graph['links'], road_graph['metadata'], road_graph['names']
    candidate_indices, excluded = _select_links(links, metadata)
    if not candidate_indices:
        result_terrain, surface_report = _empty_result(terrain, heights, 'skipped', excluded, baseline, rule,
                                                       started, 'noEligibleGroundLinks')
        report['roadSurface'] = surface_report
        return result_terrain

    baseline_started = time.perf_counter()
    raster = None if injected else _load_baseline_raster(source)
    baseline_seconds = time.perf_counter() - baseline_started if raster is not None else 0.0

    # 建立测站几何，长度不足的段在这里剔除。
    link_info = []
    station_started = time.perf_counter()
    for index in candidate_indices:
        meta = metadata[index]
        link = links[index]
        path = _link_path(nodes, link)
        geometry = _station_geometry(path)
        if geometry is None:
            excluded['shortLength'] += 1
            continue
        station_lon, station_lat = _lonlat(geometry['x'], geometry['z'])
        class_name = _class_of(meta)
        info = {'index': index, 'osmId': meta.get('osmId'), 'name': names[link[2]] if link[2] < len(names) else '',
                'class': class_name, 'grade': MAX_GRADE_PERCENT_BY_CLASS[class_name],
                'width': float(link[3]), 'halfWidth': float(link[3]) / 2.0,
                'distances': geometry['stations'], 'length': geometry['length'],
                'path': geometry['path'], 'cumulative': geometry['cumulative'],
                'segments': geometry['segments'],
                'x': geometry['x'], 'z': geometry['z'],
                'lon': station_lon, 'lat': station_lat, 'startNode': int(link[0]), 'endNode': int(link[1])}
        link_info.append(info)
    if not link_info:
        result_terrain, surface_report = _empty_result(terrain, heights, 'skipped', excluded, baseline, rule,
                                                       started, 'noStationGeometry')
        report['roadSurface'] = surface_report
        return result_terrain

    station_lon = np.concatenate([info['lon'] for info in link_info])
    station_lat = np.concatenate([info['lat'] for info in link_info])
    station_flat_x = np.concatenate([info['x'] for info in link_info])
    station_flat_z = np.concatenate([info['z'] for info in link_info])
    raw_flat = _sample_stations(sampler, raster, station_lon, station_lat)
    before_flat = _sample_original_terrain(terrain, heights, terrain_sampler, station_flat_x, station_flat_z)
    offset = 0
    for info in link_info:
        count = info['distances'].size
        info['raw'] = raw_flat[offset:offset + count]
        info['dsm'] = before_flat[offset:offset + count]
        offset += count
    station_seconds = time.perf_counter() - station_started

    # 缺测段整段保留原地形；任意站点落在锁定排除区的路段也整段保留。
    if excluded_union is not None:
        station_excluded_flat = contains_xy(excluded_union, station_flat_x, station_flat_z)
    else:
        station_excluded_flat = np.zeros(station_flat_x.shape, dtype=bool)
    def unresolved_entry(info, reason, **extra):
        return {'osmId': info['osmId'], 'name': info['name'], 'class': info['class'],
                'lengthM': _round(info['length']), 'reason': reason, **extra}

    resolved, unresolved = [], []
    exclusion_position = 0
    for info in link_info:
        count = info['distances'].size
        info['excludedStations'] = station_excluded_flat[exclusion_position:exclusion_position + count]
        exclusion_position += count
        if info['excludedStations'].any():
            unresolved.append(unresolved_entry(info, 'terrainExclusion',
                                               excludedStations=int(info['excludedStations'].sum())))
        elif np.isnan(info['raw']).any():
            unresolved.append(unresolved_entry(info, 'fabdemSampleMissing'))
        elif not np.isfinite(info['dsm']).any():
            unresolved.append(unresolved_entry(info, 'terrainBaselineMissing'))
        else:
            resolved.append(info)
    if not resolved:
        result_terrain, surface_report = _empty_result(terrain, heights, 'unresolved', excluded, baseline, rule,
                                                       started, 'fabdemSampleMissing')
        surface_report['links']['total'] = len(links)
        surface_report['links']['eligible'] = len(link_info)
        surface_report['links']['unresolved'] = len(unresolved)
        surface_report['links']['excludedTerrain'] = sum(
            1 for info in unresolved if info.get('reason') == 'terrainExclusion')
        surface_report['unresolvedLinks'] = unresolved[:MAX_UNRESOLVED_ENTRIES]
        surface_report['timing'] = {'baselineSeconds': _round(baseline_seconds),
                                    'stationSeconds': _round(station_seconds),
                                    'totalSeconds': _round(time.perf_counter() - started)}
        report['roadSurface'] = surface_report
        return result_terrain

    # 只降不升的稳健参考：先压 FABDEM 尖峰，再与该站原 DSM 取小值，最后再中值滤波一次。
    profile_started = time.perf_counter()
    filtered_links = 0
    spike_samples = 0
    spike_max = 0.0
    for info in resolved:
        filtered, spike = _median_filter(info['raw'], MEDIAN_FILTER_WINDOW)
        info['filtered'] = filtered
        info['spikeM'] = spike
        if info['raw'].size >= 3:
            filtered_links += 1
        spike_max = max(spike_max, spike)
        spike_samples += int((np.abs(info['raw'] - filtered) > SPIKE_REPORT_LIMIT_M).sum())
        dsm = info['dsm']
        finite = np.isfinite(dsm)
        lowered = filtered.copy()
        lowered[finite] = np.minimum(filtered[finite], dsm[finite])
        reference, reference_spike = _median_filter(lowered, MEDIAN_FILTER_WINDOW)
        info['reference'] = reference
        info['referenceSpikeM'] = reference_spike
        info['referenceMedianM'] = float(np.median(reference))
        info['dsmMedianM'] = float(np.median(dsm[finite])) if finite.any() else float('nan')
        info['biasM'] = info['referenceMedianM'] - info['dsmMedianM']

    # 共享节点高程 = 各入射已解析路段端点参考值的中位值。
    group_parts, endpoint_parts = [], []
    for info in resolved:
        group_parts.extend((info['startNode'], info['endNode']))
        endpoint_parts.extend((info['reference'][0], info['reference'][-1]))
    node_elevations = _median_by_group(np.asarray(group_parts, dtype=np.int64),
                                       np.asarray(endpoint_parts, dtype=float), node_count)
    relaxed = _relax_node_levels([info['startNode'] for info in resolved],
                                 [info['endNode'] for info in resolved],
                                 np.asarray([info['length'] for info in resolved], dtype=float),
                                 np.asarray([info['grade'] for info in resolved], dtype=float),
                                 node_elevations, NODE_RELAXATION_ITERATIONS)
    finite_nodes = np.isfinite(node_elevations)
    node_elevations[finite_nodes] = relaxed[finite_nodes]
    grade_infeasible = 0
    for info in resolved:
        start = node_elevations[info['startNode']]
        end = node_elevations[info['endNode']]
        if not math.isfinite(start):
            start = float(info['reference'][0])
        if not math.isfinite(end):
            end = float(info['reference'][-1])
        info['profile'], feasible = _limit_profile(info['reference'], info['distances'], info['grade'], start, end)
        info['base'] = _station_base(info['profile'])
        info['gradeFeasible'] = feasible
        if not feasible:
            grade_infeasible += 1
    profile_seconds = time.perf_counter() - profile_started

    # 拼接全部测站，供 STRtree 最近邻查询。
    station_xy_parts, half_width_parts, link_parts = [], [], []
    for info_index, info in enumerate(resolved):
        station_xy_parts.append(np.column_stack((info['x'], info['z'])))
        half_width_parts.append(np.full(info['base'].size, info['halfWidth']))
        link_parts.append(np.full(info['base'].size, info_index, dtype=np.int64))
    station_xy = np.concatenate(station_xy_parts)
    station_half_width = np.concatenate(half_width_parts)
    station_link = np.concatenate(link_parts)
    station_count = station_xy.shape[0]

    vertex_started = time.perf_counter()
    grid_x = x0 + np.arange(nx) * step
    grid_z = z0 + np.arange(nz) * step
    mesh_x, mesh_z = np.meshgrid(grid_x, grid_z)
    query = np.column_stack((mesh_x.ravel(), mesh_z.ravel()))
    tree = STRtree(points(station_xy))
    nearest, distance = _nearest_station(tree, query)

    plateau_radius = station_half_width[nearest] + PLATEAU_BUFFER_STEPS * step
    plateau = distance <= plateau_radius
    original_metres = heights.astype(float) * height_scale
    vertex_link = station_link[nearest]
    # 过渡带按平台与原地形高差放大，避免 25 m 网格上出现单格陡坎。
    candidate = distance <= plateau_radius + MAX_TRANSITION_M
    base = _profile_at_vertices(query, vertex_link, resolved, candidate)
    transition_width = np.clip(np.abs(base - original_metres) / MAX_TRANSITION_SLOPE,
                               TRANSITION_M, MAX_TRANSITION_M)
    band = (~plateau) & (distance <= plateau_radius + transition_width)
    # 陡坡山地保留原始 DSM：在近乎垂直的山坡或紧邻高差突变处铺平路面会产生人为陡坎。
    steep = _local_step_grid(original_metres.reshape(nz, nx)).ravel() > STEEP_DSM_STEP_LIMIT_M
    if excluded_union is not None:
        vertex_excluded = contains_xy(excluded_union, query[:, 0], query[:, 1])
    else:
        vertex_excluded = np.zeros(query.shape[0], dtype=bool)
    plateau = plateau & ~steep & ~vertex_excluded
    band = band & ~steep & ~vertex_excluded
    derived = plateau | band
    # 只降不升：派生顶点不允许高于原 DSM + 抬高上限。
    raise_cap = original_metres + RAISE_CAP_M
    raw_target = original_metres.copy()
    raw_target[plateau] = base[plateau]
    if band.any():
        ratio = np.clip((distance[band] - plateau_radius[band]) / transition_width[band], 0.0, 1.0)
        weight = ratio * ratio * (3.0 - 2.0 * ratio)
        raw_target[band] = base[band] * (1.0 - weight) + original_metres[band] * weight
    raised_mask = derived & (raw_target > raise_cap + 1e-9)
    target = np.minimum(raw_target, raise_cap)
    caps = raise_cap.reshape(nz, nx)
    field = target.reshape(nz, nx)
    artificial_cut = (steep | vertex_excluded) & ~derived
    fade = _rim_fade_weights(artificial_cut.reshape(nz, nx), RIM_FADE_LAYERS, (nz, nx))
    if (fade > 0).any():
        field = field * (1.0 - fade) + original_metres.reshape(nz, nx) * fade
    field = np.minimum(field, caps)
    field = _relax_derived(field, derived.reshape(nz, nx), RELAXATION_ITERATIONS, RELAXATION_ALPHA)
    raised_mask |= derived & (field.ravel() > raise_cap + 1e-9)
    field = _limit_inside_steps(field, derived.reshape(nz, nx), INSIDE_STEP_ITERATIONS, caps)
    field = np.minimum(field, caps).ravel()
    raised_capped = int(raised_mask.sum())
    quantized = np.rint(field / height_scale).astype(np.int64)
    new_heights = heights.copy()
    new_heights[derived] = quantized[derived]
    changed = new_heights != heights
    raise_metres = (new_heights.astype(float) - heights.astype(float)) * height_scale
    max_raise = float(raise_metres[derived].max()) if derived.any() else 0.0
    vertex_seconds = time.perf_counter() - vertex_started

    # 每条路段派生前后高差（测站点位，派生值取平台取值）。
    link_deltas, link_deltas_by_class = [], {name: [] for name in CLASS_ORDER}
    large_candidates = []
    for info in resolved:
        before_slice = info['dsm']
        after_slice = info['base']
        valid = np.isfinite(before_slice)
        max_delta = float(np.max(np.abs(after_slice[valid] - before_slice[valid]))) if valid.any() else float('nan')
        info['delta'] = max_delta
        if math.isfinite(max_delta):
            link_deltas.append(max_delta)
            link_deltas_by_class[info['class']].append(max_delta)
            if max_delta > LARGE_DELTA_M:
                large_candidates.append({'osmId': info['osmId'], 'name': info['name'], 'class': info['class'],
                                         'lengthM': _round(info['length']), 'maxAbsDeltaM': _round(max_delta),
                                         'maxFabdemSpikeM': _round(info['spikeM'])})

    link_deltas_array = np.asarray(link_deltas, dtype=float)
    if link_deltas_array.size:
        links_max_delta, links_p95_delta = float(link_deltas_array.max()), float(np.percentile(link_deltas_array, 95))
        links_median_delta = float(np.median(link_deltas_array))
        links_over_five = int((link_deltas_array > LARGE_DELTA_M).sum())
    else:
        links_max_delta = links_p95_delta = links_median_delta = None
        links_over_five = 0
    large_candidates.sort(key=lambda item: (-item['maxAbsDeltaM'], str(item['osmId'])))
    large_deltas = large_candidates[:MAX_LARGE_DELTA_ENTRIES]

    # 派生格点统计。
    changed_metres = np.abs(new_heights[changed] - heights[changed]) * height_scale
    delta_metres = np.abs(new_heights.astype(float) - heights.astype(float)) * height_scale
    vertex_links = station_link[nearest]
    vertex_classes = np.asarray([CLASS_ORDER.index(info['class']) for info in resolved], dtype=np.int64)[vertex_links]
    classes_report = {}
    derived_changed = changed & derived
    for class_name in CLASS_ORDER:
        class_code = CLASS_ORDER.index(class_name)
        class_links = link_deltas_by_class[class_name]
        vertex_mask = derived_changed & (vertex_classes == class_code)
        classes_report[class_name] = {
            'links': int(sum(1 for info in resolved if info['class'] == class_name)),
            'changedVertices': int(vertex_mask.sum()),
            'maxAbsDeltaM': _round(max(class_links)) if class_links else None,
            'p95AbsDeltaM': _round(float(np.percentile(class_links, 95))) if class_links else None,
        }
    values_grid = (new_heights.astype(float) * height_scale).reshape(nz, nx)
    original_grid = original_metres.reshape(nz, nx)
    adjacent = _adjacent_stats(values_grid, original_grid, derived.reshape(nz, nx), plateau.reshape(nz, nx))

    biases = np.asarray([info['biasM'] for info in resolved], dtype=float)
    reference_report = {
        'rule': 'reference = min(median-filtered FABDEM, original DSM runtime height), then median-filtered',
        'medianBiasM': _round(float(np.median(biases))),
        'p10BiasM': _round(float(np.percentile(biases, 10))),
        'p90BiasM': _round(float(np.percentile(biases, 90))),
        'maxRaiseBiasM': _round(float(biases.max())),
        'definition': 'biasM = median reference - median original DSM along the centreline; positive means '
                      'the reference still sits above the DSM',
    }
    exclusion_links = sum(1 for info in unresolved if info.get('reason') == 'terrainExclusion')

    changed_vertices = int(changed.sum())
    status = 'applied' if changed_vertices else 'unchanged'
    surface_report = {
        'status': status,
        'heightSource': 'derived-road',
        'baseline': baseline,
        'rule': rule,
        'links': {'total': len(links), 'eligible': len(link_info), 'resolved': len(resolved),
                  'unresolved': len(unresolved), 'gradeInfeasible': grade_infeasible,
                  'excluded': dict(sorted(excluded.items())), 'excludedTerrain': exclusion_links,
                  'maxAbsDeltaM': _round(links_max_delta), 'p95AbsDeltaM': _round(links_p95_delta),
                  'medianAbsDeltaM': _round(links_median_delta), 'overFiveMetres': links_over_five,
                  'reference': reference_report},
        'stations': {'count': int(station_count), 'spacingM': STATION_SPACING_M,
                     'medianFilterWindow': MEDIAN_FILTER_WINDOW, 'spikeLimitM': SPIKE_REPORT_LIMIT_M,
                     'filteredLinks': filtered_links, 'spikeSamplesOverLimit': spike_samples,
                     'maxRejectedSpikeM': _round(spike_max)},
        'vertices': {'total': int(heights.size), 'derived': int(derived.sum()), 'plateau': int(plateau.sum()),
                     'transition': int(band.sum()), 'changed': changed_vertices,
                     'changedFraction': _round(changed_vertices / max(heights.size, 1), 5),
                     'maxAbsDeltaM': _round(float(changed_metres.max())) if changed_metres.size else None,
                     'p95AbsDeltaM': _round(float(np.percentile(changed_metres, 95))) if changed_metres.size else None,
                     'maxAdjacentDeltaM': _round(adjacent['inside']),
                     'plateauAdjacentDeltaM': _round(adjacent['plateau']),
                     'rimAdjacentDeltaM': _round(adjacent['rim']), 'rimNewStepM': _round(adjacent['rimNew']),
                     'insideNewStepM': _round(adjacent['insideNew']),
                     'adjacentStepsOver2M': adjacent['over2M'], 'adjacentStepsOver5M': adjacent['over5M'],
                     'plateauStepsOver2M': adjacent['plateauOver2M'], 'raisedCapped': raised_capped,
                     'maxRaiseM': _round(max_raise), 'excluded': int(vertex_excluded.sum()),
                     'limitM': ADJACENT_DELTA_LIMIT_M},
        'classes': classes_report,
        'largeDeltas': large_deltas,
        'unresolvedLinks': unresolved[:MAX_UNRESOLVED_ENTRIES],
        'timing': {'baselineSeconds': _round(baseline_seconds), 'stationSeconds': _round(station_seconds),
                   'profileSeconds': _round(profile_seconds), 'vertexSeconds': _round(vertex_seconds),
                   'totalSeconds': _round(time.perf_counter() - started)},
        'limitations': LIMITATIONS,
    }
    report['roadSurface'] = surface_report
    result_terrain = _with_derived_marker(
        terrain, new_heights, sourceId=baseline['sourceId'], changedVertices=changed_vertices,
        maxAbsDeltaM=_round(float(delta_metres.max())) if delta_metres.size else None,
        raisedCapped=raised_capped, raiseCapM=RAISE_CAP_M,
        excludedVertices=int(vertex_excluded.sum()))
    print(f'roadSurface: {len(resolved)}/{len(link_info)} links resolved, {changed_vertices}/'
          f'{heights.size} vertices changed in {surface_report["timing"]["totalSeconds"]:.1f}s', flush=True)
    return result_terrain
