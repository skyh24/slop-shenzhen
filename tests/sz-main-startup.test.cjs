const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const main = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
const DATA_LABELS = ['data.download', 'data.decompress', 'data.parse', 'data.validate', 'data.decode'];
const indexOf = (needle) => {
  const at = main.indexOf(needle);
  assert.ok(at >= 0, `${needle} is present in js/main.js`);
  return at;
};

test('main imports the staged city data timings from the geodata loader', () => {
  assert.match(main, /import\s*\{[^}]*\bDATA_TIMINGS\b[^}]*\}\s*from\s*'\.\/sz-geodata\.js';/,
    'DATA_TIMINGS is imported from ./sz-geodata.js with the other city data exports');
});

test('initApp pre-fills the five data.* timings from DATA_TIMINGS', () => {
  const presetStart = indexOf('let initTimings = [];');
  const rendererInit = indexOf('await renderer.init();');
  assert.ok(presetStart < rendererInit, 'the timings are preset before the renderer starts');
  const preset = main.slice(presetStart, rendererInit);
  assert.match(preset, /DATA_TIMINGS/, 'DATA_TIMINGS pre-fills the [init] timings');
  assert.match(preset, /initTimings\.push\(/);
  assert.match(preset, /qa\.markStartup\(/, 'QA snapshots receive the same staged timings');
  assert.match(preset, /\$\{label\} \$\{ms\}ms/, 'timings keep the "[init]" label format');
  let previous = -1;
  for (const label of DATA_LABELS) {
    const at = main.indexOf(`'${label}'`);
    assert.ok(at >= 0, `the ${label} label is defined`);
    assert.ok(at > previous, `the ${label} label keeps the documented order`);
    previous = at;
  }
  // 五个标签都在 initTimings 预置代码附近，而不是散落在别处或只在注释里。
  const windowStart = Math.max(0, presetStart - 1600);
  const window = main.slice(windowStart, rendererInit);
  for (const label of DATA_LABELS) {
    assert.ok(window.includes(`'${label}'`), `${label} is defined next to the initTimings preset`);
  }
});

test('init failure reaches the boot fallback and keeps the plain console fallback', () => {
  const start = main.lastIndexOf('initApp().catch(');
  assert.ok(start >= 0, 'js/main.js ends with initApp().catch(...)');
  const tail = main.slice(start);
  assert.match(tail, /console\.error\('\[init\]', error\)/);
  assert.match(tail, /__szBoot/, 'the catch hands startup failures to window.__szBoot');
  assert.match(tail, /\.fail\(\s*navigator\.gpu\s*\?\s*'init'\s*:\s*'webgpu'\s*,\s*error\s*\)/,
    'missing WebGPU maps to the webgpu message, other init failures to init');
  assert.match(tail, /return;/, 'the fallback path returns before the legacy label fallback');
  assert.match(tail, /loading-status/, 'without __szBoot the #loading-status fallback remains');
  assert.match(tail, /STR\.loadingFailed/);
  assert.match(tail, /STR\.webgpuMissing/);
});

test('the renderer and animation loop are created once, and ready is announced after the loop starts', () => {
  assert.equal([...main.matchAll(/new THREE\.WebGPURenderer\(/g)].length, 1,
    'a retry must not build a second WebGPU renderer');
  assert.equal([...main.matchAll(/setAnimationLoop\(/g)].length, 1,
    'a retry must not register a second animation loop');
  const loop = indexOf('await renderer.setAnimationLoop(renderFrame);');
  const ready = main.indexOf('globalThis.__szBoot?.ready?.()');
  assert.ok(ready > loop, '__szBoot.ready() runs only after the animation loop is registered');
  const between = main.slice(loop, ready);
  assert.ok(!/new THREE\.WebGPURenderer\(/.test(between));
});

test('first-frame failures inside the loop also reach the boot fallback', () => {
  const at = indexOf('[first-frame]');
  const tail = main.slice(Math.max(0, at - 120), at + 520);
  assert.match(tail, /console\.error\('\[first-frame\]', error\)/);
  assert.match(tail, /__szBoot[^;]*\bfail\b[^;]*'init'\s*,\s*error/,
    'first-frame errors report through __szBoot.fail("init", error)');
});
