const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const main = read('main.js');
const sceneSite = read('sz-scene-site.js');

// 这两处试点把六条入口收成一份场所声明；测试锁住入口不再各自按场所名重写并列链。
test('the scene entry registers the pilot places once with their own facets', () => {
  assert.match(sceneSite, /id: 'public-walk',\s*\n\s*ground: \{ heightSource: 'rendered-terrain', sample: publicWalk\.heightAt \},\s*\n\s*walkReserve: publicWalk\.reserves,\s*\n\s*walkerExclusion: publicWalk\.reserves/);
  assert.match(sceneSite, /id: 'north-station',\s*\n\s*ground: \{ heightSource: 'rendered-terrain', sample: northStation\.heightAt \},\s*\n\s*standable: northStation\.surfaces/);
  assert.match(sceneSite, /access: \{ restricted: northStation\.inRestricted \}/);
  assert.match(sceneSite, /publicRoutes: \(\{ colliders, carriageway \}\) => northStation\.publicRoutes\(colliders, carriageway\)/);
  assert.match(sceneSite, /places\.applyGrounds\(surfaceAtlas\)/);
  assert.match(sceneSite, /places\.groundLayer\('public-walk'\)/);
  assert.match(sceneSite, /places\.reservesWalk\(x, z, r\)/);
  assert.match(sceneSite, /places\.reservesLampSites\(x, z, r\)/);
});

test('main consumes the place ledger instead of station-specific branches', () => {
  assert.match(main, /\.\.\.places\.standable/);
  assert.match(main, /places\.allowsGroundMode\(mode, x, z, surface\)/);
  assert.match(main, /places\.excludesWalker\(x, z, 2\)/);
  assert.match(main, /places\.publicRoutes\(\{ colliders, carriageway: carriagewayOccupied \}\)/);
  assert.match(main, /excludeGround: places\.restricted/);
  assert.doesNotMatch(main, /northStation\?\.inRestricted/);
  assert.doesNotMatch(main, /northStation\?\.publicRoutes/);
  assert.doesNotMatch(main, /publicWalk\.reserves\(x, z, 2\)/);
});
