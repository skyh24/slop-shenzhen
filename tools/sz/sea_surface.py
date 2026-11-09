"""按 OSM 岸线方向识别海侧，独立于地形和控制器生成海面。"""

from collections import defaultdict
from itertools import pairwise
from math import hypot

from shapely import STRtree
from shapely.geometry import Point, box
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

from geo import BAY_CONTEXT_BBOX
from land import _polys, _to_local

HANDBOOK = ('https://dataspace.copernicus.eu/sites/default/files/media/files/2024-06/'
            'geo1988-copernicusdem-spe-002_producthandbook_i5.0.pdf')


def _directed_sea_faces(coastline, coverage):
    edges = [(identity, line.intersection(coverage)) for identity, line in coastline if line.intersects(coverage)]
    faces = [face for face in polygonize(unary_union([coverage.boundary, *(edge for _, edge in edges)]))
             if coverage.covers(face.representative_point())]
    tree = STRtree(faces)
    seaward, landward, incomplete = defaultdict(set), set(), set()
    for identity, edge in edges:
        for line in getattr(edge, 'geoms', [edge]):
            if line.geom_type != 'LineString' or line.is_empty:
                continue
            for (ax, az), (bx, bz) in pairwise(line.coords):
                length = hypot(bx - ax, bz - az)
                if length < 0.02:
                    continue
                x, z = (ax + bx) / 2, (az + bz) / 2
                offset = min(0.25, length / 5) / length
                # OSM 海在 way 右边，x 东 z 南坐标下右法向为 (-dz, dx)。
                dx, dz = (az - bz) * offset, (bx - ax) * offset
                sea = tree.query(Point(x + dx, z + dz), predicate='within')
                land = tree.query(Point(x - dx, z - dz), predicate='within')
                if len(sea) != 1 or len(land) != 1:
                    continue
                if sea[0] == land[0]:
                    incomplete.add(sea[0])
                else:
                    seaward[sea[0]].add(identity)
                    landward.add(land[0])
    return [(face, seaward[i]) for i, face in enumerate(faces)
            if seaward[i] and i not in landward and i not in incomplete]


def build_sea_surface(osm, clip, land, terrain, report):
    if (terrain['processing']['heightSource'] != 'copernicus-glo30-dsm' or not terrain['sources']
            or any(source.get('verticalDatum') != 'EGM2008' for source in terrain['sources'])):
        report['seaSurface'] = {'status': 'ocean-editing-datum-unavailable'}
        return None

    phase_coast = {item['id']: _to_local(item['geom']) for item in osm['coastline']}
    phase_faces = _directed_sea_faces(phase_coast.items(), clip)
    if not phase_faces:
        report['seaSurface'] = {'status': 'seaward-face-unresolved'}
        return None
    phase_sea = unary_union([face for face, _ in phase_faces])
    coast_ids = set().union(*(ids for _, ids in phase_faces))

    context = clip.union(_to_local(box(*BAY_CONTEXT_BBOX)))
    bay_coast = {item['id']: _to_local(item['geom']) for item in osm.get('bayCoastline', [])}
    context_faces = _directed_sea_faces({**phase_coast, **bay_coast}.items(), context)
    extension = []
    for face, ids in context_faces:
        if face.intersection(phase_sea).area > 1:
            extra = face.difference(clip)
            if extra.area > 1:
                extension.append(extra)
                coast_ids.update(ids)
    sea = unary_union([phase_sea, *extension]).difference(unary_union(land))
    wetlands = [(item['id'], make_valid(_to_local(item['geom']))) for item in osm.get('shoreWetlands', [])]
    wetland_exclusions = [(identity, geom) for identity, geom in wetlands if sea.intersection(geom).area > 0]
    sea = sea.difference(unary_union([geom for _, geom in wetland_exclusions]))
    polygons = [poly for poly in _polys(sea) if poly.area >= 0.1]
    if not polygons:
        report['seaSurface'] = {'status': 'seaward-face-unresolved'}
        return None

    # 0 米是 GLO-30 海洋像元的编辑约定。沿岸潮位、河湖水位和地形样本各有独立来源。
    source = {'osmSnapshotId': 'osm-guangdong', 'coastlineIds': sorted(coast_ids),
              'excludedWetlandIds': sorted({identity for identity, _ in wetland_exclusions}),
              'geometry': 'osm-coastline-directed-water-side', 'verticalDatum': 'EGM2008',
              'heightMethod': 'copernicus-glo30-ocean-editing', 'handbook': HANDBOOK,
              'contextBoundsLonLat': list(BAY_CONTEXT_BBOX)}
    report['seaSurface'] = {'status': 'generated', 'nominalHeightM': 0, 'source': source,
                            'phase1AreaKm2': round(sea.intersection(clip).area / 1e6, 6),
                            'contextAreaKm2': round(sea.difference(clip).area / 1e6, 6),
                            'polygons': len(polygons), 'holes': sum(len(poly.interiors) for poly in polygons)}
    return {'version': 1, 'heightM': 0, 'source': source, 'polygons': polygons}
