import gzip
from http.client import HTTPConnection
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release import (CACHE, ReleaseHandler, activate_version, export_static, module_path,
                     store_version, verify_version)
from serve import LocalCityServer


class LocalReleaseTests(unittest.TestCase):
    def test_static_export_keeps_version_pairs_and_does_not_http_encode_gzip_files(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            store, output = root / 'store', root / 'public'
            city = gzip.compress(b'{"city":1}', mtime=0)
            files = {'index.html': b'<html></html>', 'js/sz-city.json.gz': city}
            a = store_version(store, files)
            export_static(store, a, output)
            b = store_version(store, {**files, 'index.html': b'<html>updated</html>'})
            export_static(store, b, output)
            for version in (a, b):
                self.assertEqual((output / 'v' / version / 'js/sz-city.json.gz').read_bytes(), city)
            self.assertEqual((output / '_redirects').read_text(), f'/ /v/{b}/ 302\n')
            self.assertIn(CACHE, (output / '_headers').read_text())
            self.assertNotIn('Content-Encoding', (output / '_headers').read_text())
            self.assertFalse((output / 'v' / a / '.gzip').exists())
            self.assertEqual(module_path('js/sz-vegetation-layout.js', '../data/source/vegetation-pilots.json'),
                             'data/source/vegetation-pilots.json')
            with self.assertRaises(ValueError):
                module_path('js/main.js', '../data/raw/private.json')

    def test_complete_versions_are_immutable_and_rollback_keeps_each_code_data_pair(self):
        with TemporaryDirectory() as tmp:
            store = Path(tmp)
            data_a, data_b = (gzip.compress(body, mtime=0) for body in (b'{"v":"a"}', b'{"v":"b"}'))
            common = {'index.html': b'<script src="js/main.js"></script>'}
            a = store_version(store, {**common, 'js/main.js': b'/* a */' * 200, 'js/sz-city.json.gz': data_a})
            b = store_version(store, {**common, 'js/main.js': b'/* b */' * 200, 'js/sz-city.json.gz': data_b})
            activate_version(store, a)
            with LocalCityServer(('127.0.0.1', 0), ReleaseHandler) as server:
                server.release_store = store
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()

                def get(path, accept='gzip'):
                    conn = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                    try:
                        conn.request('GET', path, headers={'Accept-Encoding': accept})
                        resp = conn.getresponse()
                        return resp.status, dict(resp.getheaders()), resp.read()
                    finally:
                        conn.close()

                try:
                    status, header, _ = get('/?qa=1')
                    self.assertEqual((status, header['Location'], header['Cache-Control']),
                                     (307, f'/v/{a}/?qa=1', 'no-store'))
                    status, header, body = get(f'/v/{a}/js/main.js')
                    self.assertEqual((status, header['Vary'], header['Cache-Control']),
                                     (200, 'Accept-Encoding', CACHE))
                    self.assertEqual(header['Content-Encoding'], 'gzip')
                    self.assertEqual(gzip.decompress(body), b'/* a */' * 200)
                    _, identity, body = get(f'/v/{a}/js/main.js', '*;q=1, gzip;q=0')
                    self.assertNotIn('Content-Encoding', identity)
                    self.assertEqual(body, b'/* a */' * 200)
                    self.assertEqual(get(f'/v/{a}/js/sz-city.szc.gz')[0], 404)
                    self.assertEqual(get(f'/v/{a}/data/raw/secret')[0], 404)

                    asset_b = store / 'versions' / b / 'js/sz-city.json.gz'
                    asset_b.unlink()
                    with self.assertRaises(FileNotFoundError):
                        activate_version(store, b)
                    self.assertEqual(json.loads(get('/version.json')[2])['version'], a)
                    self.assertEqual(get(f'/v/{b}/js/sz-city.json.gz')[0], 404)
                    asset_b.write_bytes(b'corrupt')
                    with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                        verify_version(store, b)
                    status, header, _ = get(f'/v/{b}/js/sz-city.json.gz')
                    self.assertEqual((status, header['Cache-Control']), (503, 'no-store'))

                    self.assertEqual(store_version(store, {**common, 'js/main.js': b'/* b */' * 200,
                                                          'js/sz-city.json.gz': data_b}), b)
                    activate_version(store, b)
                    self.assertEqual(get('/')[1]['Location'], f'/v/{b}/')
                    for version, data in ((a, data_a), (b, data_b)):
                        status, header, body = get(f'/v/{version}/js/sz-city.json.gz')
                        self.assertEqual(status, 200)
                        self.assertNotIn('Content-Encoding', header)
                        self.assertEqual(body, data)
                    activate_version(store, a)
                    self.assertEqual(get('/')[1]['Location'], f'/v/{a}/')
                finally:
                    server.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
