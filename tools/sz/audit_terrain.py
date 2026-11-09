"""对比两份高程产品，记录疑点，不自动改写任一源的高程。"""

import json
from pathlib import Path

import numpy as np
from shapely.geometry import Point

from copernicus import CopernicusSampler
from geo import KX, KY, ORIGIN_LAT, ORIGIN_LON, phase1_clip_local
from terrain import HgtSampler

ROOT = Path(__file__).resolve().parents[2]


def main():
    sources = json.loads((ROOT / 'data/source/sources.json').read_text())['sources']
    hashes = lambda prefix: {s['id'].removeprefix(prefix): s['sha256'] for s in sources if s['id'].startswith(prefix)}
    old = HgtSampler(ROOT / 'data/raw/terrain', hashes('terrain-'))
    new = CopernicusSampler(ROOT / 'data/raw/terrain/copernicus', hashes('copernicus-dem-'))
    points = [{'id': 'origin', 'name': '市民中心原点', 'lon': ORIGIN_LON, 'lat': ORIGIN_LAT},
              {'id': 'hgt-minimum', 'name': '旧 HGT 最低点', 'lon': 113.94926188498734, 'lat': 22.528013547562107}]
    selected = {'lianhuashan', 'talent-park', 'dji-sky-city', 'ping-an', 'tencent-binhai'}
    for lm in json.loads((ROOT / 'data/source/landmarks.json').read_text())['landmarks']:
        if lm['id'] in selected:
            points.append({'id': lm['id'], 'name': lm['name'], 'lat': lm['center'][0], 'lon': lm['center'][1]})
    for point in points:
        point['hgtM'] = round(old.sample(point['lon'], point['lat']), 2)
        point['copernicusM'] = round(new.sample(point['lon'], point['lat']), 2)
        point['deltaM'] = round(point['copernicusM'] - point['hgtM'], 2)
    clip = phase1_clip_local()
    x0, z0, x1, z1 = clip.bounds
    samples = []
    for z in np.arange(z0, z1, 100):
        for x in np.arange(x0, x1, 100):
            if not clip.covers(Point(x, z)):
                continue
            lon, lat = ORIGIN_LON + x / KX, ORIGIN_LAT - z / KY
            samples.append([old.sample(lon, lat), new.sample(lon, lat)])
    a = np.asarray(samples)
    result = {'date': '2026-11-09', 'points': points, 'gridStepM': 100, 'samples': len(samples),
              'sources': list(old.sources.values()) + list(new.sources.values()),
              'summary': {'hgtMinM': round(float(a[:, 0].min()), 2), 'copernicusMinM': round(float(a[:, 1].min()), 2),
                          'hgtBelowMinus10M': int((a[:, 0] < -10).sum()),
                          'copernicusBelowMinus10M': int((a[:, 1] < -10).sum()),
                          'medianAbsoluteDifferenceM': round(float(np.median(abs(a[:, 1] - a[:, 0]))), 2)},
              'limitations': ['Includes water and buildings; these are not surveyed ground control points',
                              'Sources differ in acquisition dates, vertical reference and surface treatment; Copernicus may include older DEM infill',
                              'A smaller negative tail does not prove ground accuracy',
                              'Landmark centers are not mountain peaks or roof height measurements'],
              'references': ['https://registry.opendata.aws/copernicus-dem/',
                             'https://copernicus-dem-30m.s3.amazonaws.com/readme.html']}
    out = ROOT / 'data/source/terrain-audit.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'points': points, 'samples': len(samples), 'summary': result['summary']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
