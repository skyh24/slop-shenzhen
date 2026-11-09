const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { signalPhase, createIntersectionControl, routeSignalStops } = loadModule(
  readFileSync(join(__dirname, '../js/sz-intersection-control.js'), 'utf8'));

test('signal groups alternate three seconds green, one yellow and four red', () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, t) => [signalPhase(0, t), signalPhase(1, t)]), [
    ['green', 'red'], ['green', 'red'], ['green', 'red'], ['yellow', 'red'],
    ['red', 'green'], ['red', 'green'], ['red', 'green'], ['red', 'yellow'], ['green', 'red']
  ]);
  assert.equal(signalPhase(0, 2.999), 'green');
  assert.equal(signalPhase(1, 7.999), 'yellow');
  assert.throws(() => signalPhase(2, 0), /Invalid signal phase/);
});

test('the directional stop plane and rear clearance share one conflict reservation', () => {
  const graph = { links: [[0, 1, 0, 10, 3, 1, []], [2, 3, 1, 8, 2, -1, []]],
    nodeIds: ['node/1', 'node/2', 'node/3', 'node/4'],
    metadata: [{ osmId: 'way/1', heightSource: 'terrain' }, { osmId: 'way/2', heightSource: 'terrain' }] };
  const rows = [{ osmNodeId: 50, osmWayId: 'way/1', fromNodeId: 'node/1', toNodeId: 'node/2', group: 0,
    stopX: -7, stopZ: 0, widthM: 10, dx: 1, dz: 0 },
  { osmNodeId: 51, osmWayId: 'way/2', fromNodeId: 'node/4', toNodeId: 'node/3', group: 1,
    stopX: 0, stopZ: -8, widthM: 8, dx: 0, dz: 1 }];
  const control = createIntersectionControl({ intersections: [{ id: 'fixture', approaches: rows, bounds: [-8, -9, 10, 8] }] }, graph);
  const edge = { sourceIndex: 0, to: 1 };
  assert.equal(control.approachFor(0, 0), null);
  assert.equal(control.approachState(1, 2, 4).phase, 'green');
  const samples = [-20, -8, -4, 11, 16].map(x => ({ x, z: 2, s: x + 20, edge }));
  const [stop] = routeSignalStops(samples, control, 4);
  assert.deepEqual([stop.s, stop.clearS], [13, 36]);
  assert.equal(control.enter(stop.approach, 3.2, 'car-a'), false);
  assert.equal(control.enter(stop.approach, 2.99, 'car-a'), true);
  assert.equal(control.canEnter(control.approachFor(1, 2), 4.01, 'car-b'), false);
  control.release(stop.approach, 'car-a');
  assert.equal(control.canEnter(control.approachFor(1, 2), 4.01, 'car-b'), true);

  const cross = control.approachFor(1, 2);
  control.request(stop.approach, 'car-a', 5.8);
  control.request(cross, 'car-b', 5.9);
  assert.equal(control.canEnter(cross, 5.95, 'car-b'), false);
  for (const t of [6.1, 6.4, 6.7, 7.0, 7.3, 7.6, 7.9]) {
    control.request(stop.approach, 'car-a', t);
    control.request(cross, 'car-b', t);
  }
  assert.equal(control.canEnter(stop.approach, 8.01, 'car-a'), true);
  control.request(stop.approach, 'car-a', 8.1, false);
  assert.equal(control.snapshot(8.11)[0].requests[0].ready, false);
  control.cancelRequest(stop.approach, 'car-a');
  assert.equal(control.snapshot(8.41)[0].requests.length, 0);
});
