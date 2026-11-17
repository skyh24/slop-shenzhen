const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (name) => readFileSync(join(__dirname, '../js', name), 'utf8');
const {
  FACADE_NOISE, PANE_SOFT_FLOOR, SHOP_NIGHT_RAMP, paneMask, cellNoise, shopNightGlow
} = loadModule(read('sz-facade-look.js'));

const close = (actual, expected, epsilon = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('pane mask is one at the cell centre and half covered on its edge', () => {
  close(paneMask(0.5, 0.4, 0.05), 1);
  // |fract(0.1)-0.5| 正好等于 edge，遮罩退到 0.5。
  close(paneMask(0.1, 0.4, 0.05), 0.5);
  // |fract(0.0)-0.5| 已越过 edge+soft，整格是墙。
  assert.equal(paneMask(0, 0.4, 0.05), 0);
  // 整格坐标的小数部分相同，遮罩也必须相同。
  close(paneMask(10.1, 0.4, 0.05), paneMask(0.1, 0.4, 0.05));
});

test('a wider soft band spreads the pane edge but keeps its centre', () => {
  const narrow = paneMask(0.06, 0.4, 0.02);
  const wide = paneMask(0.06, 0.4, 0.1);
  assert.equal(narrow, 0, 'a narrow band already turned the pixel into wall');
  assert.ok(wide > narrow, 'wider anti-aliasing lifts the edge coverage');
  close(paneMask(0.5, 0.4, 0.2), 1);
});

test('cell noise is fixed per cell and stays inside the unit range', () => {
  close(cellNoise(0, 0), 0);
  close(cellNoise(1, 0), 0.9216903898159217);
  close(cellNoise(3, 7), 0.5414905330253532);
  close(cellNoise(-2, 4), 0.2900872986501781);
  for (const [x, y] of [[0, 1], [12, -9], [7.9, 3.2]]) {
    const value = cellNoise(x, y);
    assert.ok(value >= 0 && value < 1, `${x},${y} -> ${value}`);
  }
});

test('the noise salt and pane constants are the shared values', () => {
  assert.deepEqual({ ...FACADE_NOISE }, { x: 12.9898, y: 78.233, scale: 43758.5453 });
  assert.equal(PANE_SOFT_FLOOR, 0.004);
  assert.deepEqual({ ...SHOP_NIGHT_RAMP }, { from: 0.56, to: 1.45 });
  assert.equal(Object.isFrozen(FACADE_NOISE), true);
});

test('shop fronts stay dark in daylight and reach full glow at midnight', () => {
  assert.equal(shopNightGlow(0.24), 0);
  assert.equal(shopNightGlow(0.48), 0);
  assert.equal(shopNightGlow(0.56), 0);
  close(shopNightGlow(0.7), 0.06644831191158752);
  close(shopNightGlow(1), 0.4915733883333877);
  close(shopNightGlow(1.2), 0.8076156540216661);
  close(shopNightGlow(1.45), 1);
  assert.equal(shopNightGlow(9), 1);
});
