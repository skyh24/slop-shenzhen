"""从广东 PBF 里读出一期范围内的道路、建筑、水体、绿地和海岸线（经纬度几何）。"""

import pickle
from pathlib import Path

import osmium
from shapely import wkb
from shapely.geometry import LineString, box
from shapely.ops import unary_union

from geo import BAY_CONTEXT_BBOX

ROOT = Path(__file__).resolve().parents[2]
PBF = ROOT / 'data/raw/guangdong-latest.osm.pbf'
CACHE = ROOT / 'data/raw/cache/osm-phase1.pkl'
CACHE_VERSION = 5

GREEN_LANDUSE = {'grass', 'forest', 'recreation_ground', 'village_green', 'meadow', 'park'}
GREEN_LEISURE = {'park', 'garden', 'nature_reserve', 'golf_course', 'pitch'}
GREEN_NATURAL = {'wood', 'scrub', 'grassland', 'heath'}
WATER_LANDUSE = {'reservoir', 'basin'}

KEEP_TAGS = (
    'name', 'name:en', 'height', 'building:levels', 'building', 'building:part', 'min_height',
    'building:levels:underground', 'building:use', 'location',
    'highway', 'lanes', 'width', 'oneway', 'bridge', 'tunnel', 'layer', 'leisure', 'landuse',
    'natural', 'water', 'wetland', 'amenity', 'man_made',
    'junction', 'access', 'vehicle', 'motor_vehicle', 'motorcar',
)


def _tags(obj):
    return {k: obj.tags[k] for k in KEEP_TAGS if k in obj.tags}


def _classify_area(t):
    if 'building' in t or 'building:part' in t:
        return 'building'
    if t.get('natural') == 'water' or t.get('landuse') in WATER_LANDUSE or t.get('waterway') == 'riverbank':
        return 'water'
    if t.get('natural') == 'wetland':
        return 'wetland'
    if t.get('leisure') in GREEN_LEISURE or t.get('landuse') in GREEN_LANDUSE or t.get('natural') in GREEN_NATURAL:
        return 'green'
    return None


def read_osm(bbox, use_cache=True):
    if use_cache and CACHE.exists():
        with CACHE.open('rb') as f:
            cached = pickle.load(f)
        if (cached.get('bbox') == bbox and cached.get('bayContextBbox') == BAY_CONTEXT_BBOX
                and cached.get('cacheVersion') == CACHE_VERSION):
            return cached

    w, s, e, n = bbox
    clip = box(w, s, e, n)
    bay_context = box(*BAY_CONTEXT_BBOX)
    coastal_coverage = unary_union([clip, bay_context])
    wkbf = osmium.geom.WKBFactory()
    out = {'cacheVersion': CACHE_VERSION, 'bbox': bbox, 'bayContextBbox': BAY_CONTEXT_BBOX,
           'roads': [], 'coastline': [], 'bayCoastline': [], 'shoreWetlands': [],
           'buildings': [], 'water': [], 'wetland': [], 'green': []}

    keys = ('building', 'building:part', 'highway', 'natural', 'water', 'leisure', 'landuse', 'waterway')
    fp = (osmium.FileProcessor(str(PBF))
          .with_locations()
          .with_areas()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY | osmium.osm.AREA | osmium.osm.RELATION))
          .with_filter(osmium.filter.KeyFilter(*keys)))

    def inside(lon, lat):
        return w - 0.01 <= lon <= e + 0.01 and s - 0.01 <= lat <= n + 0.01

    for obj in fp:
        if obj.is_area():
            t = _tags(obj)
            if 'waterway' in obj.tags:
                t['waterway'] = obj.tags['waterway']
            kind = _classify_area(t)
            shore_wetland = t.get('natural') in ('wetland', 'mud')
            if kind is None and not shore_wetland:
                continue
            try:
                geom = wkb.loads(wkbf.create_multipolygon(obj), hex=True)
            except Exception:
                continue
            osm_id = f"{'way' if obj.from_way() else 'relation'}/{obj.orig_id()}"
            entry = {'id': osm_id, 'tags': t, 'geom': geom}
            if shore_wetland and geom.intersects(coastal_coverage):
                out['shoreWetlands'].append(entry)
            if kind is not None and geom.intersects(clip):
                out[kind + 's' if kind == 'building' else kind].append(entry)
        elif isinstance(obj, osmium.osm.Way):
            hw = obj.tags.get('highway')
            coast = obj.tags.get('natural') == 'coastline'
            if not hw and not coast:
                continue
            try:
                coords = [(nd.lon, nd.lat) for nd in obj.nodes]
            except osmium.InvalidLocationError:
                continue
            if len(coords) < 2:
                continue
            near_phase = any(inside(*c) for c in coords)
            if coast:
                line = LineString(coords)
                entry = {'id': f'way/{obj.id}', 'geom': line}
                if near_phase:
                    out['coastline'].append(entry)
                if line.intersects(bay_context):
                    out['bayCoastline'].append(entry)
            elif near_phase:
                out['roads'].append({'id': f'way/{obj.id}', 'tags': _tags(obj), 'geom': LineString(coords),
                                     'nodeRefs': [nd.ref for nd in obj.nodes]})

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open('wb') as f:
        pickle.dump(out, f)
    return out


if __name__ == '__main__':
    from geo import PHASE1_BBOX
    data = read_osm(PHASE1_BBOX, use_cache=False)
    for k, v in data.items():
        if isinstance(v, list):
            print(k, len(v))
