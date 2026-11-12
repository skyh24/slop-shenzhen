"""海岸线闭合成陆地，整理水体、湿地（红树林）和绿地。"""

from shapely import STRtree
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import linemerge, polygonize, transform, unary_union

from geo import project


def _to_local(geom):
    return transform(lambda x, y, z=None: project(x, y), geom)


def _polys(geom):
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, 'geoms', []) if isinstance(g, Polygon)]


def build_land(osm, clip_local, buildings, report, *, paving=None):
    """陆地 = 海岸线切开范围框后，含有建筑的那些面。"""
    lines = [_to_local(c['geom']) for c in osm['coastline']]
    merged = linemerge(unary_union(lines)) if lines else None
    pieces = list(polygonize(unary_union([clip_local.boundary] + ([merged] if merged else []))))
    pieces = [p.intersection(clip_local) for p in pieces]
    pieces = [p for p in pieces if not p.is_empty and p.area > 1]

    tree = STRtree([b['poly'].representative_point() for b in buildings])
    land = []
    for p in pieces:
        n = len(tree.query(p, predicate='contains'))
        density = n / max(p.area / 1e6, 1e-3)
        if n >= 3 and density > 5:
            land.append(p)
    land_geom = unary_union(land) if land else clip_local
    report['landPieces'] = len(land)
    report['landAreaKm2'] = round(land_geom.area / 1e6, 2)
    report['seaAreaKm2'] = round((clip_local.area - land_geom.area) / 1e6, 2)

    def layer(items, min_area):
        out = []
        for it in items:
            g = _to_local(it['geom']).intersection(clip_local)
            for p in _polys(g):
                if p.area >= min_area:
                    out.append({'id': it['id'], 'poly': p.simplify(0.8, preserve_topology=True), 'name': it['tags'].get('name')})
        return out

    water = layer(osm['water'], 200)
    wetland = layer(osm['wetland'], 200)
    green = layer(osm['green'], 150)
    if paving is not None:
        green = [{**item, 'poly': part} for item in green
                 for part in _polys(item['poly'].difference(paving)) if not part.is_empty]
    report['water'] = len(water)
    report['wetland'] = len(wetland)
    report['green'] = len(green)
    return _polys(land_geom.simplify(1.0, preserve_topology=True)), water, wetland, green
