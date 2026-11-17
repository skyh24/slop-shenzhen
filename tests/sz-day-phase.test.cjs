const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const {
  DAY_PHASE_CHANNELS, HEADLIGHTS_FULL, dayChannels, createDayPhase, dayPhase
} = loadModule(read('sz-day-phase.js'));

const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('daylight presets keep every lamp channel off', () => {
  for (const glow of [0.48, 0.24]) {
    const channels = dayChannels(0, glow);
    for (const name of DAY_PHASE_CHANNELS) assert.equal(channels[name], 0, name);
  }
});

test('twilight lights the street but not the skyline show', () => {
  const channels = dayChannels(0.28, 1.25);
  close(channels.night, 0.28);
  close(channels.lamps, 0.6796817558299039, 1e-12);
  assert.equal(channels.show, 0, 'the light show fade is still zero at twilight');
  close(channels.headlights, 0.9425 / HEADLIGHTS_FULL, 1e-12);
  assert.equal(channels.deepNight, 0);
});

test('midnight saturates every channel except the raw night factor', () => {
  const channels = dayChannels(0.86, 1.55);
  close(channels.night, 0.86, 1e-12);
  for (const name of ['lamps', 'show', 'headlights', 'deepNight']) close(channels[name], 1, 1e-12, name);
});

test('channel inputs clamp to the day and night ends', () => {
  assert.deepEqual(dayChannels(-3, -1), dayChannels(0, 0.6));
  assert.equal(dayChannels(Number.NaN, Number.NaN).night, 0);
  assert.equal(dayChannels(9, 9).lamps, 1);
});

test('an unknown channel name is rejected', () => {
  assert.throws(() => dayPhase.channel('sunset'), /Unknown day phase channel: sunset/);
});

test('wire rejects an empty, duplicated or non-string phase list', () => {
  assert.throws(() => createDayPhase().wire({ phases: [] }), /at least one id/);
  assert.throws(() => createDayPhase().wire({ phases: ['a', 'a'] }), /Duplicate day phase id/);
  assert.throws(() => createDayPhase().wire({ phases: [''] }), /non-empty string/);
  assert.throws(() => createDayPhase().wire({ applyLighting: 'x' }), /applyLighting must be a function/);
  assert.throws(() => createDayPhase().wire({ applyLook: 1 }), /applyLook must be a function/);
  assert.throws(() => createDayPhase().wire({ night: 0 }), /night must be a function/);
  assert.throws(() => createDayPhase().wire({ glow: null }), /glow must be a function/);
});

test('apply writes lighting before the look and refuses unknown ids', () => {
  const order = [];
  const phase = createDayPhase().wire({
    phases: ['golden', 'midnight'],
    applyLighting: id => order.push(`lighting:${id}`),
    applyLook: id => order.push(`look:${id}`),
    night: () => 0.86,
    glow: () => 1.55
  });
  assert.equal(phase.apply('midnight'), true);
  assert.deepEqual(order, ['lighting:midnight', 'look:midnight']);
  assert.equal(phase.id, 'midnight');
  assert.equal(phase.apply('sunset'), false);
  assert.equal(phase.apply(''), false);
  assert.equal(phase.apply(null), false);
  assert.deepEqual(order, ['lighting:midnight', 'look:midnight'], 'a refused id changes nothing');
});

test('channels follow the wired accessors and deep night is a boolean', () => {
  let night = 0.28;
  let glow = 1.25;
  const phase = createDayPhase().wire({ night: () => night, glow: () => glow });
  close(phase.channel('lamps'), 0.6796817558299039, 1e-12);
  assert.equal(phase.isDeepNight, false);
  night = 0.86;
  glow = 1.55;
  assert.equal(phase.channel('show'), 1);
  assert.equal(phase.isDeepNight, true);
});

test('the shared instance is a day phase wired by nobody yet at import time', () => {
  assert.equal(typeof dayPhase.apply, 'function');
  assert.ok(DAY_PHASE_CHANNELS.includes('headlights'));
});
