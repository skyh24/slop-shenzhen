const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
const { vehicleContact, resolveVehicleContact, sweptVehicleContact } = physics;

function body(options = {}) {
  const result = { x: 0, z: 0, sin: 0, cos: 1, halfW: 0.86, halfL: 2.18,
    mass: 1600, vx: 0, vz: 0, angularVel: 0, ...options };
  result.prevX ??= result.x;
  result.prevZ ??= result.z;
  return result;
}

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
}

function inertia(b) {
  return b.mass * (b.halfW ** 2 + b.halfL ** 2) / 3;
}

function energy(b) {
  return (b.mass * (b.vx ** 2 + b.vz ** 2) + inertia(b) * b.angularVel ** 2) / 2;
}

function momentum(a, b) {
  return [a.mass * a.vx + b.mass * b.vx, a.mass * a.vz + b.mass * b.vz,
    a.mass * (a.z * a.vx - a.x * a.vz) + b.mass * (b.z * b.vx - b.x * b.vz)
    + inertia(a) * a.angularVel + inertia(b) * b.angularVel];
}

function collide(a, b) {
  const hit = {};
  assert.ok(vehicleContact(a, b, hit));
  resolveVehicleContact(a, b, hit);
  return hit;
}

test('centered rear-end impacts exchange momentum without artificial spin', () => {
  const a = body({ vz: 10 }), b = body({ z: 4.2 });
  const hit = collide(a, b);
  close(hit.x, 0);
  close(hit.nz, -1);
  close(a.vz, 4.6);
  close(b.vz, 5.4);
  close(a.angularVel, 0);
  close(b.angularVel, 0);
  close(a.mass * a.vz + b.mass * b.vz, 16000);
});

test('offset bumper contacts lie in the overlapping faces and spin both cars', () => {
  const a = body({ x: 0.6, vz: 12 }), b = body({ z: 4.2 });
  const before = momentum(a, b), initialEnergy = energy(a) + energy(b);
  const hit = collide(a, b);
  close(hit.x, 0.3);
  assert.ok(Math.abs(a.angularVel) > 0.1);
  assert.ok(Math.abs(b.angularVel) > 0.1);
  momentum(a, b).forEach((value, i) => close(value, before[i]));
  assert.ok(energy(a) + energy(b) < initialEnergy);
});

test('bus contacts conserve momentum and move the heavy vehicle much less', () => {
  const car = body({ vz: 15 }), bus = body({ z: 7.8, mass: 12000, halfW: 1.3, halfL: 5.72 });
  const before = momentum(car, bus);
  collide(car, bus);
  assert.ok(bus.vz > 0 && bus.vz < 2);
  assert.ok(car.vz > 0 && car.vz < 2);
  momentum(car, bus).forEach((value, i) => close(value, before[i]));
});

test('separating or resting overlaps produce no impulse or spin', () => {
  for (const velocity of [0, -10]) {
    const a = body({ vz: velocity }), b = body({ z: 4.2 });
    const hit = collide(a, b);
    close(hit.impulse, 0);
    close(a.vz, velocity);
    close(b.vz, 0);
    close(a.angularVel, 0);
  }
});

test('angled and spinning impacts conserve momentum without gaining energy', () => {
  for (let i = 0; i < 80; i++) {
    const heading = i * 0.079;
    const a = body({ x: 0.3, z: -1, vx: 8 * Math.sin(i), vz: 9,
      sin: Math.sin(heading), cos: Math.cos(heading), angularVel: Math.cos(i) });
    const b = body({ z: 1, vx: -5 * Math.cos(i), vz: -3, mass: 2100, angularVel: Math.sin(i) });
    const hit = {};
    if (!vehicleContact(a, b, hit)) continue;
    const before = momentum(a, b), initialEnergy = energy(a) + energy(b);
    resolveVehicleContact(a, b, hit);
    momentum(a, b).forEach((value, j) => close(value, before[j], 1e-7));
    assert.ok(energy(a) + energy(b) <= initialEnergy + 1e-7);
    assert.ok(Number.isFinite(hit.x) && Number.isFinite(hit.z));
  }
});

test('sideswipes retain forward motion instead of imposing a fixed speed penalty', () => {
  const a = body({ x: 1.7, vx: -0.5, vz: 12 }), b = body({ vz: 12 });
  collide(a, b);
  close(a.vz, 12);
  close(b.vz, 12);
});

test('all four SAT axes reject a diagonal near miss', () => {
  const angle = Math.PI / 4;
  const a = body({ x: 2.4, z: -2.4, sin: Math.sin(angle), cos: Math.cos(angle) });
  const b = body();
  assert.equal(vehicleContact(a, b, {}), false);
});

test('swept contacts catch a complete side crossing and rewind to first contact', () => {
  const a = body({ x: 4, prevX: -4, vx: 40 }), b = body();
  const hit = {};
  assert.equal(vehicleContact(a, b, hit), false);
  assert.ok(sweptVehicleContact(a, b, hit));
  assert.ok(a.x < -1.7 && a.x > -1.73);
  close(hit.nx, -1);
  resolveVehicleContact(a, b, hit);
  assert.ok(a.vx < 20 && b.vx > 20);
});

test('sweeps handle relative movement and reject departing overlaps and near misses', () => {
  const a = body({ x: 4, prevX: -3, vx: 35 });
  const b = body({ x: -3, prevX: 3, vx: -30 });
  assert.ok(sweptVehicleContact(a, b, {}));
  assert.ok(a.x < b.x);
  assert.equal(sweptVehicleContact(body({ x: 4, prevX: 0 }), body(), {}), false);
  assert.equal(sweptVehicleContact(body({ x: 4, prevX: -4, z: 5 }), body(), {}), false);
});

test('first contact wins when a fast side impact crosses the center but still overlaps', () => {
  const a = body({ x: 0.1, prevX: -1.8, vx: 40 }), b = body();
  const hit = {};
  assert.ok(vehicleContact(a, b, hit));
  close(hit.nx, 1, 1e-8);
  assert.ok(sweptVehicleContact(a, b, hit));
  close(hit.nx, -1, 1e-8);
  assert.ok(resolveVehicleContact(a, b, hit) > 39);
  assert.ok(b.vx > 20);
});

test('swept side scrapes preserve each vehicle’s tangential travel', () => {
  for (const distance of [0.2, 0.3]) {
    const a = body({ x: -1.71, prevX: -1.72, z: distance, prevZ: 0, vx: 0.6, vz: distance * 60 });
    const b = body({ z: 0.2, prevZ: 0, vz: 12 });
    const hit = {};
    assert.ok(sweptVehicleContact(a, b, hit));
    close(hit.az, distance);
    close(hit.bz, 0.2);
    resolveVehicleContact(a, b, hit);
    assert.ok(a.vz > 11.9 && b.vz > 11.9);
  }
});

test('swept touching bumpers preserve mass-weighted common forward travel', () => {
  const a = body({ z: 0.21, prevZ: 0, vz: 12.6, mass: 1700 });
  const b = body({ z: 4.56, prevZ: 4.36, vz: 12, mass: 1600 });
  const hit = {};
  assert.ok(sweptVehicleContact(a, b, hit));
  assert.ok(hit.az > 0.2 && hit.bz > 4.56);
  close(1700 * hit.az + 1600 * hit.bz, 1700 * 0.21 + 1600 * 4.56);
  close(hit.bz - hit.az + hit.depth, 4.36);
  resolveVehicleContact(a, b, hit);
  assert.ok(a.vz >= 12 && b.vz >= 12);
});

test('touching vehicles at equal velocity are never rewound', () => {
  const a = body({ z: 0.2, prevZ: 0, vz: 12 });
  const b = body({ z: 4.56, prevZ: 4.36, vz: 12 });
  assert.equal(sweptVehicleContact(a, b, {}), false);
  close(a.z, 0.2);
  close(b.z, 4.56);
});

