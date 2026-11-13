"""本机发布验证：构造完整版本、原子切入口、保留版本回退。"""

import argparse
import gzip
from hashlib import sha256
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import posixpath
import re
from tempfile import NamedTemporaryFile, TemporaryDirectory
from urllib.parse import urlsplit

from serve import LocalCityServer

ROOT = Path(__file__).resolve().parents[2]
THREE = '0.187.0'
CDN = f'https://cdn.jsdelivr.net/npm/three@{THREE}/'
IMPORT_MAP = {
    'three': 'build/three.webgpu.js',
    'three/webgpu': 'build/three.webgpu.js',
    'three/tsl': 'build/three.tsl.js',
    'three/addons/': 'examples/jsm/',
}
IMPORTS = re.compile(r'^[ \t]*(?:(?:import|export)\s+[^\'";]*?\bfrom\s*|import\s*)([\'"])([^\'"\n]+)\1', re.M)
MAP_TAG = re.compile(r'(<script type="importmap">)(.*?)(</script>)', re.S)
TOKEN = r'[A-Za-z0-9_.-]+'
SAFE_FILE = re.compile(rf'{TOKEN}(?:/{TOKEN})*')
VERSION = re.compile(r'[0-9a-f]{64}')
MIME = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.gz': 'application/gzip',
        '.json': 'application/json', '.md': 'text/plain', '': 'text/plain'}
CACHE = 'public, max-age=31536000, immutable'


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def digest(data):
    return sha256(data).hexdigest()


def checked_path(root, name):
    if not SAFE_FILE.fullmatch(name) or any(part in ('.', '..') for part in name.split('/')):
        raise ValueError(f'Invalid release resource: {name}')
    path = root / name
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Resource escapes its source: {name}')
    return path


class Entry(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.modules = set()
        self.preloads = set()
        self.styles = set()
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == 'script' and attr.get('type') == 'module':
            self.modules.add(attr['src'].removeprefix('./'))
        if tag == 'link' and attr.get('rel') == 'modulepreload':
            self.preloads.add(attr['href'].removeprefix('./'))
        if tag == 'link' and attr.get('rel') == 'stylesheet' and attr.get('href', '').startswith('./'):
            self.styles.add(urlsplit(attr['href']).path.removeprefix('./'))


def module_path(name, spec):
    if spec.startswith(('./', '../')):
        child = posixpath.normpath(posixpath.join(posixpath.dirname(name), spec))
        # 应用模块不能跨到其它目录，Three 的相对导入也必须在引擎目录内。
        if (name, child) == ('js/sz-lianhuashan.js', 'data/source/lianhuashan-summit.json'):
            return child
        if child.split('/')[0] != name.split('/')[0]:
            raise ValueError(f'Module escapes its runtime directory: {name}: {spec}')
        return child
    if spec in IMPORT_MAP and not spec.endswith('/'):
        return 'engine/' + IMPORT_MAP[spec]
    if spec.startswith('three/addons/'):
        return 'engine/examples/jsm/' + spec.removeprefix('three/addons/')
    raise ValueError(f'Unknown module specifier: {name}: {spec}')


def release_files(source, engine):
    if json.loads((engine / 'package.json').read_text())['version'] != THREE:
        raise ValueError(f'Release requires Three.js {THREE}')
    html = (source / 'index.html').read_text()
    match = MAP_TAG.search(html)
    if not match or json.loads(match[2]) != {'imports': {key: CDN + value for key, value in IMPORT_MAP.items()}}:
        raise ValueError('Entry import map differs from the pinned release engine')
    entry = Entry(html)
    if entry.modules != {'js/main.js'} or not entry.styles:
        raise ValueError('Unexpected release entry')
    mapping = {'imports': {key: './engine/' + path for key, path in IMPORT_MAP.items()}}
    html = (html[:match.start(2)] + '\n    ' + json_bytes(mapping).decode() + '  ' + html[match.end(2):])
    html = html.replace('<html ', '<html data-sz-release ', 1)
    html = html.replace('  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />\n', '')
    html = html.replace('<!-- three.js r187 release (npm package, served by jsDelivr) -->',
                        '<!-- three.js r187：随当前版本提供。 -->')

    files = {'index.html': html.encode(), 'engine/LICENSE': checked_path(engine, 'LICENSE').read_bytes()}
    for name in sorted(entry.styles | {'js/sz-city.json.gz', 'LICENSE', 'data/source/ATTRIBUTION.md'}):
        if name in entry.styles and not re.fullmatch(r'css/[\w.-]+\.css', name):
            raise ValueError(f'Unexpected stylesheet: {name}')
        files[name] = checked_path(source, name).read_bytes()
    city = files['js/sz-city.json.gz']
    report = json.loads(checked_path(source, 'data/source/build-report.json').read_text())
    if (not city.startswith(b'\x1f\x8b') or len(city) != report['outputBytes']
            or digest(city) != report['outputSha256']):
        raise ValueError('City package does not match the verified build report')

    regional = report.get('regionalScene', {})
    for name, expected in regional.get('rules', {}).items():
        if digest(checked_path(source, name).read_bytes()) != expected:
            raise ValueError(f'Regional scene rules changed; rebuild the regional scene: {name}')
    for name, expected in regional.get('files', {}).items():
        if not re.fullmatch(r'js/sz-regional/[a-f0-9]{20}/[a-z-]+-[0-9]+\.json', name):
            raise ValueError(f'Unexpected regional resource: {name}')
        data = checked_path(source, name).read_bytes()
        if digest(data) != expected:
            raise ValueError(f'Regional resource does not match the verified build report: {name}')
        files[name] = data

    stack = list(entry.modules | {'engine/' + path for key, path in IMPORT_MAP.items() if not key.endswith('/')})
    while stack:
        name = stack.pop()
        if name in files:
            continue
        if name == 'data/source/lianhuashan-summit.json':
            files[name] = checked_path(source, name).read_bytes()
            continue
        if not name.endswith('.js'):
            raise ValueError(f'Unexpected module: {name}')
        root, relative = (engine, name.removeprefix('engine/')) if name.startswith('engine/') else (source, name)
        data = checked_path(root, relative).read_bytes()
        files[name] = data
        stack.extend(module_path(name, spec) for _, spec in IMPORTS.findall(data.decode()))
    if entry.preloads - files.keys():
        raise ValueError(f'Preloads outside the runtime graph: {sorted(entry.preloads - files.keys())}')
    return files


def variant(data):
    return {'bytes': len(data), 'sha256': digest(data)}


def store_version(store, files):
    versions = store / 'versions'
    versions.mkdir(parents=True, exist_ok=True)
    rows = {}
    with TemporaryDirectory(dir=versions, prefix='.staging-') as temp:
        stage = Path(temp) / 'version'
        for name, data in sorted(files.items()):
            path = checked_path(stage, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            row = {'identity': variant(data)}
            # 城市包本身是 gzip 文件：应用解压，HTTP 不再加 Content-Encoding。
            if path.suffix in ('.html', '.css', '.js', '.json', '.md', ''):
                compressed = gzip.compress(data, compresslevel=9, mtime=0)
                if len(compressed) < len(data):
                    encoded = stage / '.gzip' / name
                    encoded.parent.mkdir(parents=True, exist_ok=True)
                    encoded.write_bytes(compressed)
                    row['gzip'] = variant(compressed)
            rows[name] = row
        manifest = json_bytes({'schema': 1, 'three': THREE, 'entry': 'index.html', 'resources': rows})
        version = digest(manifest)
        (stage / 'manifest.json').write_bytes(manifest)
        destination = versions / version
        if not destination.exists():
            stage.rename(destination)
        else:
            try:
                verify_version(store, version)
            except (OSError, ValueError):
                # 只修复此哈希原本应有的字节。每个文件原子替换，清单最后恢复。
                paths = sorted(path for path in stage.rglob('*') if path.is_file())
                paths.remove(stage / 'manifest.json')
                for original in [*paths, stage / 'manifest.json']:
                    target = checked_path(destination, original.relative_to(stage).as_posix())
                    if not target.is_file() or target.read_bytes() != original.read_bytes():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        original.replace(target)
    verify_version(store, version)
    return version


def version_manifest(store, version):
    if not VERSION.fullmatch(version):
        raise ValueError('Invalid version ID')
    directory = store / 'versions' / version
    data = checked_path(directory, 'manifest.json').read_bytes()
    if digest(data) != version:
        raise ValueError('Version manifest checksum mismatch')
    return directory, data, json.loads(data)['resources']


def read_variant(directory, name, encoding, expected):
    relative = f'.gzip/{name}' if encoding == 'gzip' else name
    data = checked_path(directory, relative).read_bytes()
    if variant(data) != expected:
        raise ValueError(f'Resource checksum mismatch: {name}')
    return data


def verify_version(store, version):
    directory, _, rows = version_manifest(store, version)
    for name, row in rows.items():
        raw = read_variant(directory, name, 'identity', row['identity'])
        if 'gzip' in row and gzip.decompress(read_variant(directory, name, 'gzip', row['gzip'])) != raw:
            raise ValueError(f'Gzip variant differs from the identity resource: {name}')


def activate_version(store, version):
    verify_version(store, version)
    with NamedTemporaryFile(dir=store, prefix='.active-', delete=False) as temp:
        path = Path(temp.name)
        temp.write(json_bytes({'version': version, 'entry': f'/v/{version}/'}))
    try:
        path.replace(store / 'active.json')
    finally:
        path.unlink(missing_ok=True)


def accepts_gzip(header):
    choices = {}
    for item in header.lower().split(','):
        name, _, options = item.strip().partition(';')
        weight = re.search(r'\bq\s*=\s*([0-9.]+)', options)
        try:
            choices[name.strip()] = float(weight[1]) if weight else 1
        except ValueError:
            choices[name.strip()] = 0
    return choices.get('gzip', choices.get('*', 0)) > 0


class ReleaseHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def send_bytes(self, status, body=b'', *, mime='text/plain', cache='no-store', headers=None):
        self.send_response(status)
        self.send_header('Cache-Control', cache)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD' and body:
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        store = self.server.release_store
        uri = urlsplit(self.path)
        if uri.path in ('/', '/version.json'):
            try:
                active = (store / 'active.json').read_bytes()
                version = json.loads(active)['version']
                if not VERSION.fullmatch(version):
                    raise ValueError('Invalid active version')
            except (OSError, ValueError, KeyError):
                return self.send_bytes(503, b'No active release')
            if uri.path == '/version.json':
                return self.send_bytes(200, active, mime='application/json')
            location = f'/v/{version}/' + ('?' + uri.query if uri.query else '')
            return self.send_bytes(307, headers={'Location': location})

        match = re.fullmatch(r'/v/([0-9a-f]{64})/(.*)', uri.path)
        if not match:
            return self.send_bytes(404)
        version, name = match.groups()
        try:
            directory, manifest, rows = version_manifest(store, version)
            if name == 'manifest.json':
                return self.send_bytes(200, manifest, mime='application/json', cache=CACHE)
            name = name or 'index.html'
            if name not in rows:
                return self.send_bytes(404)
            row = rows[name]
            enc = 'gzip' if 'gzip' in row and accepts_gzip(self.headers.get('Accept-Encoding', '')) else 'identity'
            body = read_variant(directory, name, enc, row[enc])
        except FileNotFoundError:
            return self.send_bytes(404)
        except (OSError, ValueError, KeyError):
            return self.send_bytes(503, b'Release resource failed verification')
        headers = {'Vary': 'Accept-Encoding'} if 'gzip' in row else {}
        if enc == 'gzip':
            headers['Content-Encoding'] = enc
        return self.send_bytes(200, body, mime=MIME[Path(name).suffix], cache=CACHE, headers=headers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', type=Path, default=ROOT / 'docs/qa/site-cost/releases')
    commands = parser.add_subparsers(dest='command', required=True)
    stage = commands.add_parser('stage')
    stage.add_argument('--source', type=Path, default=ROOT)
    stage.add_argument('--three', type=Path, default=ROOT / f'.agents/three-{THREE}')
    commands.add_parser('activate').add_argument('version')
    commands.add_parser('verify').add_argument('version')
    commands.add_parser('serve').add_argument('--port', type=int, default=8180)
    args = parser.parse_args()
    if args.command == 'stage':
        print(store_version(args.store, release_files(args.source, args.three)))
    elif args.command == 'activate':
        activate_version(args.store, args.version)
    elif args.command == 'verify':
        verify_version(args.store, args.version)
    else:
        with LocalCityServer(('127.0.0.1', args.port), ReleaseHandler) as server:
            server.release_store = args.store
            print(f'Serving local releases at http://127.0.0.1:{server.server_port}/', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
