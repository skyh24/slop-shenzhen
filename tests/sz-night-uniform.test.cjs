const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

// S4（docs/22 A5）与候选三：昼夜系数只写一处，日落之后各类灯的强度只由 js/sz-day-phase.js 的通道给出。
// 这里守住接线契约；曲线数值由 tests/sz-day-phase.test.cjs 覆盖。

const root = join(__dirname, '..');
const read = (file) => readFileSync(join(root, 'js', file), 'utf8');

const lightingSource = read('lighting.js');
const mainSource = read('main.js');

// 文件 → 该文件应当读取的通道。
const channelReaders = {
  'sz-site-fixtures.js': 'lamps',
  'sz-waterfront.js': 'lamps',
  'sz-bay-waterfront.js': 'lamps',
  'sz-theme-parks/index.js': 'lamps',
  'sz-light-show.js': 'show',
  'sz-cbd-program.js': 'deepNight',
  'sz-apec.js': 'night',
  'sz-apec-city.js': 'night',
  'sz-street-lamps.js': 'night',
  'controllers.js': 'headlights'
};

test('lighting.js still owns the single night uniform and exports the phase list', () => {
  assert.match(lightingSource, /import\s*\{\s*sceneUniforms\s*\}\s*from\s*'\.\/sz-materials\.js';/,
    'lighting.js imports the shared scene uniform');
  assert.match(lightingSource, /this\.uNightFactor\s*=\s*sceneUniforms\.night;/,
    'the engine night factor is an alias of the city uniform, not a second uniform');
  const writes = [...lightingSource.matchAll(/uNightFactor\.value\s*=/g)];
  assert.equal(writes.length, 1, 'the night factor is written in exactly one place (applyPreset)');
  assert.match(lightingSource, /export const TIME_PRESET_IDS = Object\.freeze\(Object\.keys\(TIME_PRESETS\)\);/,
    'the preset ids are exported for the day phase wiring');
});

test('main.js switches time through the day phase instead of two parallel calls', () => {
  assert.match(mainSource, /import\s*\{\s*dayPhase\s*\}\s*from\s*'\.\/sz-day-phase\.js';/,
    'the entry imports the shared day phase');
  assert.match(mainSource, /dayPhase\.wire\(\{[\s\S]*?phases:\s*TIME_PRESET_IDS/,
    'the channel is wired with the lighting preset ids');
  assert.match(mainSource, /applyLighting:\s*\(id\)\s*=>\s*lightingSystem\.applyPreset\(id\)/,
    'lighting is applied by the channel');
  assert.match(mainSource, /applyLook:\s*\(id\)\s*=>\s*colorGrade\.applyPreset\(id\)/,
    'the color grade is applied by the channel');
  assert.match(mainSource, /function selectTime\(timeId\) \{\s*if \(!dayPhase\.apply\(timeId\)\) return;/,
    'selectTime refuses an unknown phase instead of half-applying it');
  assert.equal([...mainSource.matchAll(/lightingSystem\.applyPreset\(/g)].length, 1,
    'the entry never calls applyPreset outside the channel wiring');
  assert.doesNotMatch(mainSource, /colorGrade\.applyPreset\(lightingSystem\.activePresetId\)/,
    'the color grade no longer follows the lighting system around');
});

test('every consumer imports the day phase and reads a named channel', () => {
  for (const [file, channel] of Object.entries(channelReaders)) {
    const source = read(file);
    assert.match(source, /import\s*\{[^}]*\bdayPhase\b[^}]*\}\s*from\s*'\.\.?\/sz-day-phase\.js';/,
      `${file} imports the shared day phase`);
    assert.ok(source.includes(`dayPhase.channel('${channel}')`),
      `${file} reads the ${channel} channel`);
    assert.doesNotMatch(source, /sceneUniforms\.night\.value\s*[><]=?/,
      `${file} no longer invents its own night threshold`);
  }
  // 街区灯的开关与原始强度是两条通道。
  const kit = read('sz-districts/kit.js');
  assert.match(kit, /const night = dayPhase\.channel\('night'\);/);
  assert.match(kit, /const lit = dayPhase\.channel\('lamps'\) > 0;/);
  // 车灯强度是满档乘通道。
  assert.match(read('controllers.js'), /const beamScale = HEADLIGHTS_FULL \* dayPhase\.channel\('headlights'\);/);
});

test('deep night is taken from the channel, not re-derived in the entry', () => {
  assert.doesNotMatch(mainSource, /sceneUniforms\.night\.value\s*>=\s*0\.5/, 'no midnight threshold in the entry');
  assert.match(mainSource, /themeParks\.update\(now \* 0\.001, dayPhase\.isDeepNight, cameraSystem\.camera\.position\);/);
  assert.match(mainSource, /audioSystem\.update\(dt, elapsed, cameraSystem\.camera, dayPhase\.isDeepNight\);/);
  assert.doesNotMatch(mainSource, /activePresetId === 'midnight'/, 'the entry does not compare phase ids by hand');
});

test('the light show keeps its shader fade on the shared uniform', () => {
  const show = read('sz-light-show.js');
  assert.match(show, /group\.visible = dayPhase\.channel\('show'\) > 0 && !isProgramActive\(\);/);
  assert.match(show, /smoothstep\(0\.32, 0\.68, sceneUniforms\.night\)/,
    'the per-fragment fade still reads the uniform node');
});
