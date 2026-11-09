const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('Copernicus sampling respects point registration, tile seams and source failures', () => {
  execFileSync(join(root, '.venv/bin/python'), ['-m', 'unittest', 'discover', '-s', 'tools/sz/tests', '-p', 'test_copernicus.py'], { cwd: root, stdio: 'pipe' });
});
