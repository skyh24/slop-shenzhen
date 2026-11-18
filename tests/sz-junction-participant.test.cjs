const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const signal = loadModule(read('sz-intersection-control.js'));
const { createJunctionParticipant, createCrossingParticipant } = loadModule(read('sz-junction-participant.js'));

function fixture() {
  const graph = { links: [[0, 1, 0, 10, 3, 1, []], [2, 3, 1, 8, 2, -1, []]],
    nodeIds: ['node/1', 'node/2', 'node/3', 'node/4'],
    metadata: [{ osmId: 'way/1', heightSource: 'terrain' }, { osmId: 'way/2', heightSource: 'terrain' }] };
  const control = signal.createIntersectionControl({ intersections: [{ id: 'fixture', bounds: [-8, -9, 10, 8],
    approaches: [
      { osmNodeId: 50, osmWayId: 'way/1', fromNodeId: 'node/1', toNodeId: 'node/2', group: 0,
        stopX: -7, stopZ: 0, widthM: 10, dx: 1, dz: 0 },
      { osmNodeId: 51, osmWayId: 'way/2', fromNodeId: 'node/4', toNodeId: 'node/3', group: 1,
        stopX: 0, stopZ: -8, widthM: 8, dx: 0, dz: 1 }
    ] }] }, graph);
  return { control, east: control.approachFor(0, 1), north: control.approachFor(1, 2) };
}

test('a queued participant asks only inside the stop window and can withdraw the request', () => {
  const { control, east } = fixture();
  const car = createJunctionParticipant(control, 'car-a');
  assert.equal(car.wait(east, 0, { distance: 8 }).held, false);
  assert.equal(control.snapshot(0)[0].requests.length, 0);
  const queued = car.wait(east, 0.1, { distance: 3 });
  assert.equal(queued.held, false);
  assert.equal(queued.phase, 'green');
  assert.equal(car.requesting, true);
  const [queuedRequest] = control.snapshot(0.1)[0].requests;
  assert.deepEqual([String(queuedRequest.actorId), queuedRequest.ready], ['car-a', true]);
  // 每帧刷新后跨过 0.5 秒请求超时仍然保留；撤销后不留残余请求。
  car.wait(east, 0.4, { distance: 2.5 });
  car.wait(east, 0.8, { distance: 2 });
  assert.equal(control.snapshot(0.8)[0].requests.length, 1);
  car.suspend();
  assert.equal(car.requesting, false);
  assert.equal(control.snapshot(0.8)[0].requests.length, 0);
});

test('an occupied exit keeps the request not ready and blocks entry until it clears', () => {
  const { control, east } = fixture();
  const car = createJunctionParticipant(control, 'car-a');
  const waiting = car.wait(east, 0, { distance: 1, exitBlocked: true });
  assert.equal(waiting.held, true);
  assert.equal(control.snapshot(0)[0].requests[0].ready, false);
  const blocked = car.enter(0, true);
  assert.deepEqual([blocked.ok, blocked.entered], [false, false]);
  assert.equal(control.snapshot(0)[0].owner, null);
  const entered = car.enter(0.1);
  assert.deepEqual([entered.ok, entered.entered], [true, true]);
  assert.equal(car.reservation, east);
  assert.equal(control.snapshot(0.1)[0].owner, 'car-a');
  assert.equal(control.snapshot(0.1)[0].requests.length, 0);
});

test('ownership survives suspension and clears only when the rear has left', () => {
  const { control, east } = fixture();
  const car = createJunctionParticipant(control, 'car-a');
  car.wait(east, 0, { distance: 1 });
  assert.equal(car.enter(0).entered, true);
  car.suspend();
  assert.equal(control.snapshot(0)[0].owner, 'car-a');
  assert.equal(car.release(false), false);
  assert.equal(control.snapshot(0)[0].owner, 'car-a');
  assert.equal(car.release(true), true);
  assert.equal(control.snapshot(0)[0].owner, null);
  assert.equal(car.release(true), true);
  assert.equal(car.reservation, null);
});

test('another actor cannot enter early while the participant still occupies the junction', () => {
  const { control, east, north } = fixture();
  const owner = createJunctionParticipant(control, 'car-a');
  const other = createJunctionParticipant(control, 'car-b');
  owner.wait(east, 0.2, { distance: 1 });
  assert.equal(owner.enter(0.2).entered, true);
  assert.equal(other.wait(north, 0.2, { distance: 1 }).held, true);
  assert.equal(other.enter(0.2).ok, false);
  // 对向绿灯后，已占用者仍未驶离，另一个方向不得获准。
  const green = other.wait(north, 4.1, { distance: 1 });
  assert.equal(green.phase, 'green');
  assert.equal(green.held, true);
  assert.equal(other.enter(4.1).ok, false);
  owner.release(true);
  assert.equal(other.wait(north, 4.2, { distance: 1 }).held, false);
  assert.equal(other.enter(4.2).entered, true);
});

test('abandon and repeated cleanup leave no ownership or request behind', () => {
  const { control, east } = fixture();
  const car = createJunctionParticipant(control, 'car-a');
  car.wait(east, 0, { distance: 1 });
  assert.equal(car.enter(0).entered, true);
  car.abandon();
  const [junction] = control.snapshot(0);
  assert.deepEqual([junction.owner, junction.requests.length], [null, 0]);
  assert.equal(car.reservation, null);
  car.abandon();
  car.suspend();
  assert.deepEqual([junction.owner, junction.requests.length], [null, 0]);
});

test('a pedestrian crossing keeps vehicles waiting even on green', () => {
  const { control, east } = fixture();
  const crossing = { id: 'fixture', group: 0 };
  assert.equal(control.enterCrossing(crossing, 0.5, 'walker'), true);
  const car = createJunctionParticipant(control, 'car-a');
  const waiting = car.wait(east, 0.6, { distance: 1 });
  assert.equal(waiting.held, true);
  assert.equal(waiting.phase, 'red');
  assert.equal(car.enter(0.6).ok, false);
  control.leaveCrossing(crossing, 'walker', 0.7);
  assert.equal(control.enterCrossing(crossing, 0.9, 'walker-2'), false, '已排队车辆先获得至多一轮灯相');
  assert.equal(car.wait(east, 0.8, { distance: 1 }).held, false);
  assert.equal(car.enter(0.8).entered, true);
  assert.equal(control.enterCrossing(crossing, 0.9, 'walker-2'), false, '车辆占用时行人不得进入');
});

function crossingControlStub() {
  const calls = [];
  const owners = new Map();
  let green = true;
  return {
    calls,
    get owner() { return owners.values().next().value ?? null; },
    setGreen(value) { green = value; },
    enterCrossing(crossing, elapsedSeconds, actorId) {
      calls.push(['enter', crossing.id, elapsedSeconds, actorId]);
      if (!green || owners.has(crossing.id)) return false;
      owners.set(crossing.id, actorId);
      return true;
    },
    leaveCrossing(crossing, actorId, elapsedSeconds) {
      calls.push(['leave', crossing.id, elapsedSeconds, actorId]);
      if (owners.get(crossing.id) === actorId) owners.delete(crossing.id);
    }
  };
}

test('a crossing grant spans same-signal legs and is released once at the far sidewalk', () => {
  const control = crossingControlStub();
  const walker = createCrossingParticipant(control, 'ped-1');
  assert.equal(walker.switchTo({ id: 'alfa', group: 0 }, 0.5), true);
  assert.equal(control.owner, 'ped-1');
  assert.equal(walker.signal.id, 'alfa');
  // 同一信号下的下一段（安全岛另一侧）不重新看灯色，也不重复申请。
  control.setGreen(false);
  assert.equal(walker.switchTo({ id: 'alfa', group: 1 }, 4.2), true);
  assert.deepEqual(control.calls, [['enter', 'alfa', 0.5, 'ped-1']]);
  assert.equal(control.owner, 'ped-1');
  assert.equal(walker.switchTo(null, 6), true);
  assert.deepEqual(control.calls, [['enter', 'alfa', 0.5, 'ped-1'], ['leave', 'alfa', 6, 'ped-1']]);
  assert.equal(control.owner, null);
  assert.equal(walker.signal, null);
  walker.switchTo(null, 6.5);
  assert.equal(control.calls.length, 2);
});

test('a denied next signal keeps the current crossing grant and reports the block', () => {
  const control = crossingControlStub();
  const walker = createCrossingParticipant(control, 'ped-1');
  walker.switchTo({ id: 'alfa', group: 0 }, 0.5);
  control.setGreen(false);
  assert.equal(walker.switchTo({ id: 'beta', group: 1 }, 3.5), false);
  assert.equal(control.owner, 'ped-1');
  assert.equal(walker.signal.id, 'alfa');
  assert.deepEqual(control.calls.at(-1), ['enter', 'beta', 3.5, 'ped-1']);
  // 新许可先取得，旧段随后释放，换段过程不会短暂交出占用。
  control.setGreen(true);
  assert.equal(walker.switchTo({ id: 'beta', group: 1 }, 8.2), true);
  assert.deepEqual(control.calls.slice(-2), [
    ['enter', 'beta', 8.2, 'ped-1'], ['leave', 'alfa', 8.2, 'ped-1']
  ]);
  assert.equal(walker.signal.id, 'beta');
  assert.equal(control.owner, 'ped-1');
});

test('abandon clears a crossing grant once and repeated cleanup is silent', () => {
  const control = crossingControlStub();
  const walker = createCrossingParticipant(control, 'ped-1');
  walker.switchTo({ id: 'alfa', group: 0 }, 1);
  walker.abandon(2);
  assert.equal(control.owner, null);
  assert.equal(walker.signal, null);
  const calls = control.calls.length;
  walker.abandon(3);
  walker.abandon(4);
  assert.equal(control.calls.length, calls);
  // 释放后可以重新进入同一信号。
  assert.equal(walker.switchTo({ id: 'alfa', group: 0 }, 8.1), true);
  assert.equal(control.owner, 'ped-1');
});

test('an uncontrolled crossing or a missing actor id never touches intersection control', () => {
  const control = crossingControlStub();
  const uncontrolled = createCrossingParticipant(null, 'ped-2');
  assert.equal(uncontrolled.switchTo({ id: 'alfa', group: 0 }, 0), true);
  uncontrolled.abandon(1);
  const anonymous = createCrossingParticipant(control, undefined);
  assert.equal(anonymous.switchTo({ id: 'alfa', group: 0 }, 0), true);
  anonymous.abandon(1);
  assert.deepEqual(control.calls, []);
});
