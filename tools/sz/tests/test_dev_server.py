"""通过真实 HTTP 响应检查开发服务器，避免把源码写法当成行为。"""

from functools import partial
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import DevHandler, LocalCityServer


class DevServerTest(unittest.TestCase):
    def test_changed_modules_and_errors_are_not_cached(self):
        class QuietHandler(DevHandler):
            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            module = Path(directory) / 'module.js'
            with LocalCityServer(('127.0.0.1', 0), partial(QuietHandler, directory=directory)) as server:
                thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
                thread.start()
                url = f'http://127.0.0.1:{server.server_port}'
                try:
                    for content in ('export const value = 1;', 'export const value = 2;'):
                        module.write_text(content)
                        with urlopen(url + '/module.js', timeout=2) as response:
                            self.assertEqual(response.read().decode(), content)
                            self.assertIn('no-store', response.headers['Cache-Control'])
                            self.assertEqual(response.headers['Pragma'], 'no-cache')
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(url + '/missing.js', timeout=2)
                    self.assertEqual(caught.exception.code, 404)
                    self.assertIn('no-store', caught.exception.headers['Cache-Control'])
                    caught.exception.close()
                finally:
                    server.shutdown()
                    thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
