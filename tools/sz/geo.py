"""深圳局部坐标：WGS84 在原点处做切平面，1 单位 = 1 米，x 向东，z 向南。"""

import math

from shapely.geometry import box
from shapely.ops import unary_union

ORIGIN_LON = 114.0545
ORIGIN_LAT = 22.5463

_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
_PHI0 = math.radians(ORIGIN_LAT)
_N = _A / math.sqrt(1 - _E2 * math.sin(_PHI0) ** 2)
_M = _A * (1 - _E2) / (1 - _E2 * math.sin(_PHI0) ** 2) ** 1.5
KX = math.pi / 180 * _N * math.cos(_PHI0)
KY = math.pi / 180 * _M

# 一期范围：主框加留仙洞北向延伸（经纬度）
PHASE1_BOXES = [
    (113.925, 22.495, 114.085, 22.565),
    (113.920, 22.565, 113.960, 22.588),
]
PHASE1_BBOX = (113.920, 22.495, 114.085, 22.588)

# 只用于深圳湾远景的岸线裁切，南界取锁定数据清单的南界。
BAY_CONTEXT_BBOX = (113.915, 22.455, 114.061, 22.526)


def project(lon, lat):
    return ((lon - ORIGIN_LON) * KX, -(lat - ORIGIN_LAT) * KY)


def project_coords(coords):
    return [project(lon, lat) for lon, lat in coords]


def phase1_clip_lonlat():
    return unary_union([box(*b) for b in PHASE1_BOXES])


def phase1_clip_local():
    parts = []
    for w, s, e, n in PHASE1_BOXES:
        x0, z0 = project(w, n)
        x1, z1 = project(e, s)
        parts.append(box(x0, z0, x1, z1))
    return unary_union(parts)
