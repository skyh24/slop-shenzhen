const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

// S4（docs/22 A5）：日夜系数只写一处，模块直接读 uniform，入口不再转抄、不再逐个传夜间参数。
// 这里守住模块接线契约；数值行为由各模块自己的运行期用例覆盖。

const root = join(__dirname, '..');
const read = (file) => readFileSync(join(root, 'js', file), 'utf8');

const lightingSource = read('lighting.js');
const mainSource = read('main.js');
const nightReaders = ['sz-street-lamps.js', 'sz-apec.js', 'sz-apec-city.js', 'sz-light-show.js'];

test('lighting.js shares the single sceneUniforms.night uniform and writes it once', () => {
  assert.match(lightingSource, /import\s*\{\s*sceneUniforms\s*\}\s*from\s*'\.\/sz-materials\.js';/,
    'lighting.js imports the shared scene uniform');
  assert.match(lightingSource, /this\.uNightFactor\s*=\s*sceneUniforms\.night;/,
    'the engine night factor is an alias of the city uniform, not a second uniform');
  assert.doesNotMatch(lightingSource, /this\.uNightFactor\s*=\s*uniform\(/,
    'lighting.js must not create a second night uniform');
  const writes = [...lightingSource.matchAll(/uNightFactor\.value\s*=/g)];
  assert.equal(writes.length, 1, 'the night factor is written in exactly one place (applyPreset)');
  assert.ok(lightingSource.indexOf('uNightFactor.value = p.nightFactor') > lightingSource.indexOf('applyPreset(presetId'),
    'the single write lives in applyPreset');
});

test('main.js no longer transcribes the night factor or passes it module by module', () => {
  assert.doesNotMatch(mainSource, /sceneUniforms\.night\.value\s*=/, 'the entry does not copy uNightFactor into sceneUniforms.night');
  assert.doesNotMatch(mainSource, /lightingSystem\.uNightFactor/, 'the entry does not hand the night factor to modules');
  assert.doesNotMatch(mainSource, /nightFactor/, 'no per-module night factor parameter remains in the entry');
  assert.match(mainSource, /streetLamps\.update\(cameraSystem\.camera\.position\);/, 'street lamps update reads the uniform itself');
  assert.match(mainSource, /apecTheme\.update\(dt\);/, 'APEC theme update reads the uniform itself');
  assert.match(mainSource, /apecCity\.update\(dt\);/, 'APEC city update reads the uniform itself');
  assert.match(mainSource, /lightShow\.update\(\);/, 'light show visibility is owned by the module');
  assert.doesNotMatch(mainSource, /lightShow\.group\.visible\s*=/, 'the entry no longer toggles the light show group');
});

test('night-reading modules import sceneUniforms and take no night factor argument', () => {
  for (const file of nightReaders) {
    const source = read(file);
    assert.match(source, /import\s*\{[^}]*\bsceneUniforms\b[^}]*\}\s*from\s*'\.\/sz-materials\.js';/,
      `${file} imports the shared scene uniform`);
    assert.match(source, /sceneUniforms\.night\.value/, `${file} reads sceneUniforms.night.value directly`);
    assert.doesNotMatch(source, /nightFactor/, `${file} takes no nightFactor parameter`);
  }
  // 灯光秀的显隐在模块内部按 uniform 阈值判断。
  assert.match(read('sz-light-show.js'), /group\.visible\s*=\s*sceneUniforms\.night\.value > 0\.25/,
    'the light show sets its own visibility from the uniform');
});
