
import gzip, json
payload = json.loads(gzip.decompress(open('js/sz-city.json.gz','rb').read()))
ts = payload['terrainSurface']
ch = ts['chunks'][0]
print(list(ch.keys()))
for k,v in ch.items():
    print(k, type(v).__name__, len(v) if hasattr(v,'__len__') else v, str(v)[:120])
print('version', ts['version'], 'heightSource', ts['heightSource'], 'diagonal', ts['diagonal'], 'waterSurface', ts['waterSurface'])
print('exclusions sample', json.dumps(ts['exclusions'])[:200])
