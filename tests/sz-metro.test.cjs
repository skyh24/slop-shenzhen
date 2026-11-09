const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('metro import requires network evidence and preserves transfer identities and clipped source geometry', () => {
  execFileSync(join(root, '.venv/bin/python'), ['-m', 'unittest', 'discover', '-s', 'tools/sz/tests', '-p', 'test_metro.py'], { cwd: root, stdio: 'pipe' });
});
