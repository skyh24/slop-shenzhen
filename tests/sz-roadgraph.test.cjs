const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('Shenzhen road graph preserves OSM topology, direction, clipping and provenance', () => {
  execFileSync(join(root, '.venv/bin/python'), ['-m', 'unittest', 'discover', '-s', 'tools/sz/tests', '-p', 'test_roadgraph.py'], { cwd: root, stdio: 'pipe' });
});
