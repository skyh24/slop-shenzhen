
import gzip, json, sys, time
sys.path.insert(0, 'tools/sz')
from elevated_cut import plan_elevated_cut_mask
t0 = time.time()
payload = json.loads(gzip.decompress(open('js/sz-city.json.gz','rb').read()))
graph = payload['roadGraph']
surface = payload['terrainSurface']
mask, stats = plan_elevated_cut_mask(graph, surface)
print('seconds', round(time.time()-t0,1))
print(json.dumps(stats, ensure_ascii=False))
import shapely
geoms = getattr(mask, 'geoms', [mask])
print('polygons', len(geoms))
for g in sorted(geoms, key=lambda g: -g.area)[:12]:
    b = g.bounds
    print(round(g.area,1), [round(v,1) for v in b])
