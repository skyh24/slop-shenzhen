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

# 主城区和深圳北站走廊的包络。实际覆盖还需扣除锁定 OSM 快照里的香港行政范围。
PHASE1_BOXES = [
    (113.868, 22.467, 114.142, 22.574),
    (113.920, 22.574, 114.090, 22.623),
]
# 旧版 GloBFP 的局部序号以这个范围筛选后编号，保留已有建筑的身份。
LEGACY_PHASE1_BOXES = [(113.925, 22.495, 114.085, 22.565), (113.920, 22.565, 113.960, 22.588)]
PHASE1_BBOX = (113.868, 22.467, 114.142, 22.623)
HONG_KONG_BOUNDARY_ID = 20044132
YANJIANG_ROUTE_ID = 6371344

# 海面岸线补到西部沿江高架和深圳湾大桥视域。
BAY_CONTEXT_BBOX = (113.840, 22.455, 114.061, 22.574)
YANJIANG_SCENIC_BBOX = (113.842, 22.505, 113.901, 22.575)


def project(lon, lat):
    return ((lon - ORIGIN_LON) * KX, -(lat - ORIGIN_LAT) * KY)


def project_coords(coords):
    return [project(lon, lat) for lon, lat in coords]


def phase1_clip_lonlat():
    return unary_union([box(*b) for b in PHASE1_BOXES])


def phase1_clip_local(boxes=PHASE1_BOXES):
    parts = []
    for w, s, e, n in boxes:
        x0, z0 = project(w, n)
        x1, z1 = project(e, s)
        parts.append(box(x0, z0, x1, z1))
    return unary_union(parts)
