const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

// 服务器本身在 tools/sz/serve.py：这里只锁住会重演的缓存事故的行为约定。
const serve = readFileSync(join(__dirname, '../tools/sz/serve.py'), 'utf8');

test('dev server serves the module graph without browser caching', () => {
  assert.match(serve, /self\.send_header\('Cache-Control',\s*'no-store[^']*'\)/,
    'serve.py sends Cache-Control: no-store so a reload never mixes old and new modules');
  assert.match(serve, /self\.send_header\('Pragma',\s*'no-cache'\)/,
    'serve.py sends the HTTP/1.0 Pragma fallback with it');
});

test('dev server still serves the repository root over HTTP/1.0', () => {
  assert.match(serve, /class LocalCityServer\(ThreadingHTTPServer\)/,
    'the low-latency threaded server is kept');
  assert.match(serve, /directory=Path\(__file__\)\.resolve\(\)\.parents\[2\]/,
    'the document root stays derived from the script location');
});
