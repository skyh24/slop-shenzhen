const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { registerHooks } = require('node:module');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const { createFrameClock, SIMULATION_MAX_DELTA, SIMULATION_MIN_DELTA } = loadModule(read('sz-frame-clock.js'));

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('a normal frame feeds the same wall interval to simulation and playback', () => {
  const clock = createFrameClock(1000);
  const frame = clock.advance(1016.7);
  close(frame.raw, 0.0167);
  close(frame.simulation, 0.0167);
  close(frame.playback, 0.0167);
  close(frame.elapsed, 0.0167);
  close(clock.elapsed, 0.0167);
});

test('a long frame caps the simulation step while playback keeps the real interval', () => {
  const clock = createFrameClock(0);
  const frame = clock.advance(2000);
  assert.equal(frame.raw, 2);
  assert.equal(frame.simulation, SIMULATION_MAX_DELTA, 'the simulated world does not teleport');
  assert.equal(frame.playback, 2, 'playback content still follows real elapsed time');
  assert.equal(frame.elapsed, SIMULATION_MAX_DELTA);
});

test('a stalled, reversed or missing timestamp never moves time backwards', () => {
  const clock = createFrameClock(1000);
  const same = clock.advance(1000);
  assert.deepEqual([same.raw, same.simulation, same.playback], [0, SIMULATION_MIN_DELTA, 0]);
  const backwards = clock.advance(900);
  assert.deepEqual([backwards.raw, backwards.simulation, backwards.playback], [0, SIMULATION_MIN_DELTA, 0]);
  const missing = clock.advance(Number.NaN);
  assert.deepEqual([missing.raw, missing.simulation, missing.playback], [0, SIMULATION_MIN_DELTA, 0]);
  close(clock.elapsed, 3 * SIMULATION_MIN_DELTA);
});

test('hidden frames keep the simulation running but never advance playback', () => {
  const clock = createFrameClock(0, { hidden: true });
  const hidden = clock.advance(16.7);
  assert.equal(hidden.playback, 0);
  close(hidden.simulation, 0.0167);
  clock.setHidden(true);
  assert.equal(clock.advance(33.4).playback, 0);
  assert.equal(clock.hidden, true);
});

test('the first frame after the page becomes visible drops the hidden interval', () => {
  const clock = createFrameClock(0);
  clock.advance(16.7);
  const before = clock.elapsed;
  clock.setHidden(true);
  clock.setHidden(false);
  const resume = clock.advance(5016.7);
  assert.equal(resume.playback, 0, 'the hidden gap does not reach playback consumers');
  assert.equal(resume.simulation, SIMULATION_MAX_DELTA, 'the simulation catches up one capped step only');
  assert.equal(clock.elapsed, before + SIMULATION_MAX_DELTA);
  close(clock.advance(5033.4).playback, 0.0167);
  // 已可见时再次通知可见不是新的恢复事件，后续帧照常推进播放。
  clock.setHidden(false);
  close(clock.advance(5050.1).playback, 0.0167);
});

test('reset re-aligns the loop start without rewinding accumulated simulation time', () => {
  const clock = createFrameClock(0);
  clock.advance(2000);
  const before = clock.elapsed;
  clock.reset(9000);
  const frame = clock.advance(9000);
  assert.deepEqual([frame.raw, frame.simulation, frame.playback], [0, SIMULATION_MIN_DELTA, 0]);
  assert.equal(clock.elapsed, before + SIMULATION_MIN_DELTA);
});

test('a day phase change does not reset or advance the simulation clock', () => {
  const { createDayPhase } = loadModule(read('sz-day-phase.js'));
  const clock = createFrameClock(0);
  let now = 0;
  for (let i = 0; i < 60; i++) clock.advance(now += 16.7);
  const before = clock.elapsed;
  const phase = createDayPhase();
  phase.wire({ phases: ['golden', 'midnight'], applyLighting: () => {}, applyLook: () => {} });
  assert.equal(phase.apply('midnight'), true);
  assert.equal(clock.elapsed, before, 'time-of-day lighting owns no simulation clock');
  const frame = clock.advance(now += 16.7);
  assert.equal(clock.elapsed, before + frame.simulation);
});

const threeRoot = process.env.SZ_THREE_PACKAGE_DIR ?? resolve(__dirname, '../.agents/three-0.187.0');
const threeBuild = { 'three/webgpu': 'three.webgpu.js', 'three/tsl': 'three.tsl.js' };
registerHooks({ resolve(specifier, context, next) {
  return threeBuild[specifier]
    ? { url: pathToFileURL(resolve(threeRoot, 'build', threeBuild[specifier])).href, shortCircuit: true }
    : next(specifier, context);
} });

const canvasContext = new Proxy({}, {
  get: (target, key) => target[key] ?? (key === 'createLinearGradient' ? () => ({ addColorStop: () => {} }) : () => {})
});

test('the summit program takes pause, speed and background resume from the frame clock', async () => {
  global.document = { hidden: false, createElement: () => ({ getContext: () => canvasContext }) };
  const { createCbdProgram } = await import('../js/sz-cbd-program.js');
  const { uniform } = await import('three/tsl');
  const clock = createFrameClock(0);
  const program = createCbdProgram({ x: 0, y: 113, z: -1030 }, uniform(0.86));
  program.start();
  let now = 0;
  const frames = (count, ms) => {
    for (let i = 0; i < count; i++) program.update(clock.advance(now += ms).playback);
  };
  frames(60, 1000 / 60);
  close(program.time, 1, 0.02);
  program.togglePause();
  const paused = program.time;
  frames(60, 1000 / 60);
  assert.equal(program.time, paused, 'a paused program ignores frame time');
  program.togglePause();
  frames(60, 1000 / 60);
  close(program.time, paused + 1, 0.02);
  program.toggleSpeed();
  const fast = program.time;
  frames(60, 1000 / 60);
  close(program.time, fast + 2, 0.04, 'double speed takes double playback time');
  clock.setHidden(true);
  clock.setHidden(false);
  const shown = program.time;
  program.update(clock.advance(now += 5000).playback);
  assert.equal(program.time, shown, 'no playback jump after five hidden seconds');
  frames(60, 1000 / 60);
  close(program.time, shown + 2, 0.06);
  program.stop();
});
