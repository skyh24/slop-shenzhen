const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const look = loadModule(read('sz-facade-look.js'));

// 一个只求数值的 TSL 替身：节点是 `p => number` 的函数，p 为待求坐标（x, y）。
const value = (input, p) => (typeof input === 'function' ? input(p) : input);
const wrap = fn => Object.assign(fn, {
  mul: other => wrap(node(p => value(fn, p) * value(other, p))),
  sub: other => wrap(node(p => value(fn, p) - value(other, p))),
  add: other => wrap(node(p => value(fn, p) + value(other, p))),
  oneMinus: () => wrap(node(p => 1 - value(fn, p)))
});
const node = fn => wrap(fn);
const constant = v => node(() => v);
const tsl = {
  Fn: fn => (...args) => fn(args),
  float: constant,
  vec2: (x, y) => node(p => ({ x: value(x, p), y: value(y, p) })),
  dot: (a, b) => node(p => {
    const av = value(a, p); const bv = value(b, p);
    return av.x * bv.x + av.y * bv.y;
  }),
  sin: v => node(p => Math.sin(value(v, p))),
  floor: v => node(p => Math.floor(value(v, p))),
  fract: v => node(p => {
    const n = value(v, p);
    return n - Math.floor(n);
  }),
  abs: v => node(p => Math.abs(value(v, p))),
  max: (a, b) => node(p => Math.max(value(a, p), value(b, p))),
  fwidth: () => constant(0),
  smoothstep: (from, to, v) => node(p => {
    const lo = value(from, p); const hi = value(to, p);
    const t = Math.min(1, Math.max(0, (value(v, p) - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  })
};
const nodes = loadModule(read('sz-facade-nodes.js'), {
  imports: { 'three/tsl': tsl, './sz-facade-look.js': look }
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('the node pane mask matches the CPU mask at the same cell and edge', () => {
  for (const [cell, edge, soft] of [[0.5, 0.4, 0.05], [0.1, 0.4, 0.05], [0.06, 0.4, 0.02], [0.5, 0.47, 0.01]]) {
    const got = nodes.paneMaskNode(constant(cell), edge, soft)({});
    close(got, look.paneMask(cell, edge, soft));
  }
});

test('the automatic mask falls back to the soft floor when pixels are large', () => {
  const got = nodes.paneMaskAutoNode(constant(0.1), 0.4)({});
  close(got, look.paneMask(0.1, 0.4, 0.004));
});

test('the cell noise node reproduces the CPU hash after flooring', () => {
  close(nodes.cellNoiseNode(constant(1), constant(0))({}), look.cellNoise(1, 0));
  close(nodes.cellNoiseNode(constant(3), constant(7))({}), look.cellNoise(3, 7));
  close(nodes.cellNoiseNode(constant(3.9), constant(7.2))({}), look.cellNoise(3, 7));
});

test('the shop night node is the shared ramp', () => {
  for (const glow of [0.56, 0.7, 1, 1.2, 1.45]) {
    close(nodes.shopNightNode(constant(glow))({}), look.shopNightGlow(glow));
  }
});

test('the module exposes one node per shared facade curve', () => {
  assert.deepEqual(Object.keys(nodes).sort(),
    ['cellNoiseNode', 'hash21Node', 'paneMaskAutoNode', 'paneMaskNode', 'paneSoftNode', 'shopNightNode']);
});