const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'),
  { imports: { './sz-polygon.js': polygonModule } });
const { createSurfaceResolver } = loadModule(readFileSync(join(__dirname, '../js/sz-controller-surfaces.js'), 'utf8'));

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(nyc = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    findGroundArrival: (target, mode, options) => {
      if (options.isClear({ ...target })) return { ...target };
      for (let distance = 4; distance <= 256; distance += 4) {
        for (let i = 0; i < 32; i++) {
          const candidate = { x: target.x + Math.cos(i * Math.PI / 16) * distance,
            z: target.z + Math.sin(i * Math.PI / 16) * distance };
          if (options.isClear(candidate)) return candidate;
        }
      }
      return null;
    },
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    isWater: () => false,
    nearestRoads: () => [],
    ...nyc
  };
  const { ThirdPersonControllerManager, PLAYER_SPEED_LIMITS, FLIGHT_MAX_ALTITUDE } = loadModule(source, {
    globals: { window, document },
    imports: {
      ...driving,
      'three/webgpu': {},
      './sz-city-config.js': config,
      './sz-controller-surfaces.js': {},
      './sz-park-arrivals.js': {},
      './sz-strings.js': { STR: {} },
      './city-lighting-materials.js': {},
      './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } },
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './building-collision.js': polygonCollision
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost', 'brake'].map((action) => [action, false]));
  controller.getGroundHeight = (x, z) => nyc.blockAt?.(x, z) ? 0.22 : 0;
  controller.groundHeight = (x, z) => controller.getGroundHeight(x, z, controller.activeMode);
  controller.maxFlightAltitude = FLIGHT_MAX_ALTITUDE;
  controller.surfaceResolver = {
    resolve(x, z) {
      const y = controller.getGroundHeight(x, z, controller.activeMode);
      return Number.isFinite(y) ? { height: y, surfaceId: 'terrain' } : null;
    },
    below(x, z, y) { const p = this.resolve(x, z); return p && p.height <= y ? p : null; }
  };
  controller.bindKeyboard();
  return {
    controller,
    PLAYER_SPEED_LIMITS,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either jump binding stays active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'Space');
  key('keydown', 'KeyE');
  key('keyup', 'Space');
  assert.equal(controller.keys.up, true);
  key('keyup', 'KeyE');
  assert.equal(controller.keys.up, false);
});

test('Space also brakes the car and Shift boosts it', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'Space');
  assert.equal(controller.keys.up, true);
  assert.equal(controller.keys.brake, true);
  key('keyup', 'Space');
  assert.equal(controller.keys.up, false);
  assert.equal(controller.keys.brake, false);

  for (const code of ['ShiftLeft', 'ShiftRight']) {
    key('keydown', code);
    assert.equal(controller.keys.boost, true);
    key('keyup', code);
    assert.equal(controller.keys.boost, false);
  }
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('up', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'KeyE');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist') Object.assign(entity, {
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Helicopter') Object.assign(entity, {
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  });
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Helicopter') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Helicopter']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      if (mode === 'Car') {
        assert.equal(Math.sign(partial.speed), Math.sign(full.speed));
        assert.ok(Math.abs(partial.speed) > 0 && Math.abs(partial.speed) < Math.abs(full.speed), 'partial throttle moves more slowly');
        assert.equal(Math.sign(partial.steerAngle), Math.sign(full.steerAngle));
        assert.ok(Math.abs(partial.steerAngle) > 0 && Math.abs(partial.steerAngle) < Math.abs(full.steerAngle), 'partial steering turns less');
        continue;
      }
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      assert.ok(Math.abs(partial.heading - full.heading * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Helicopter') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

function carDynamicsHarness(motion = {}) {
  const { controller } = keyboardHarness();
  const car = {
    type: 'car', position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0,
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: [],
    lights: [false, false],
    setLights(braking, reversing) { this.lights = [braking, reversing]; },
    ...motion
  };
  controller.entities = { car };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  return {
    controller, car,
    advance(seconds, hz = 60) {
      for (let i = 0; i < Math.round(seconds * hz); i++) controller.updateCar(1 / hz);
    }
  };
}

function carVelocity(car) {
  return [Math.sin(car.heading) * car.speed + car.vx, Math.cos(car.heading) * car.speed + car.vz];
}

test('car accelerates gradually to full speed and preserves coasting and braking', () => {
  const acceleration = carDynamicsHarness();
  acceleration.controller.keys.forward = true;
  acceleration.advance(1);
  assert.ok(Math.abs(acceleration.car.speed * 3.6 - 40) < 0.01);
  acceleration.advance(1);
  assert.ok(Math.abs(acceleration.car.speed * 3.6 - 80) < 0.01);
  acceleration.advance(1);
  assert.ok(Math.abs(acceleration.car.speed * 3.6 - 120) < 0.01);
  acceleration.advance(3);
  assert.equal(acceleration.car.speed, 120 / 3.6);

  const boosted = carDynamicsHarness();
  boosted.controller.keys.forward = boosted.controller.keys.boost = true;
  boosted.advance(1);
  assert.ok(Math.abs(boosted.car.speed * 3.6 - 60) < 0.01);
  boosted.advance(1);
  assert.ok(Math.abs(boosted.car.speed * 3.6 - 120) < 0.01);

  const coasting = carDynamicsHarness({ speed: 50 / 3.6 });
  coasting.advance(5);
  assert.ok(Math.abs(coasting.car.speed * 3.6 - 33.07) < 0.2, 'keep the existing accelerator-release resistance');

  const braking = carDynamicsHarness({ speed: 50 / 3.6 });
  braking.controller.keys.backward = true;
  braking.advance(1.5);
  assert.ok(braking.car.speed >= 0 && braking.car.speed < 0.2, 'braking reaches a stop without reversing early');
  assert.ok(braking.car.position.z > 9.8 && braking.car.position.z < 10.6, 'preserve the roughly ten-metre stopping distance');
});

test('Space brakes the car without requiring reverse throttle', () => {
  const braking = carDynamicsHarness({ speed: 120 / 3.6 });
  braking.controller.keys.brake = true;
  braking.advance(1);
  assert.ok(braking.car.speed >= 0 && braking.car.speed * 3.6 < 100, 'Space sheds speed');
  braking.advance(3);
  assert.equal(braking.car.speed, 0, 'Space brings the car to rest');
  assert.equal(braking.car.lights[0], true, 'Space lights the brake lamps');
});

test('releasing boost does not add extra deceleration while braking', () => {
  for (const action of ['brake', 'backward']) {
    const boosted = carDynamicsHarness({ speed: 120 / 3.6 });
    const released = carDynamicsHarness({ speed: 120 / 3.6 });
    boosted.controller.keys.boost = true;
    boosted.controller.keys[action] = released.controller.keys[action] = true;
    boosted.advance(0.5);
    released.advance(0.5);
    assert.equal(released.car.speed, boosted.car.speed, 'the same brake input has the same strength');
  }
});

test('car steering follows speed and reverses direction when backing up', () => {
  const slow = carDynamicsHarness({ speed: 5 });
  const fast = carDynamicsHarness({ speed: 25 });
  const reverse = carDynamicsHarness({ speed: -5 });
  const stopped = carDynamicsHarness();
  for (const sim of [slow, fast, reverse, stopped]) {
    sim.controller.keys.left = true;
    sim.advance(1);
  }
  assert.ok(slow.car.heading > fast.car.heading && fast.car.heading > 0, 'fast steering follows a wider arc');
  assert.ok(fast.car.steerAngle < slow.car.steerAngle / 3, 'reduce steering lock at speed');
  assert.ok(Math.abs(fast.car.angularVel * fast.car.speed) < 9.5, 'high-speed turning stays within road-tire grip');
  assert.ok(reverse.car.heading < 0, 'the same steering input turns the opposite way in reverse');
  assert.ok(Math.abs(reverse.car.heading + slow.car.heading) < 0.05, 'forward and reverse steering remain symmetric');
  assert.equal(stopped.car.heading, 0, 'steering alone cannot rotate a stationary car');
  assert.equal(stopped.car.speed, 0);
});

test('car changes direction after braking with residual turning and sideways motion', () => {
  for (const direction of [-1, 1]) {
    for (const hz of [30, 60, 120]) {
      const sim = carDynamicsHarness({ speed: -direction * 10, angularVel: direction });
      sim.controller.keys[direction > 0 ? 'forward' : 'backward'] = true;
      sim.controller.keys.left = true;
      sim.advance(3, hz);
      assert.ok(sim.car.speed * direction > 5, 'holding the new direction must release the brakes and drive away');
    }
  }
});

test('player brake and reverse lamps follow braking and backward travel', () => {
  for (const [speed, input, brake, reverse] of [
    [0, null, 0, 0], [5, null, 0, 0], [5, 'forward', 0, 0], [5, 'backward', 1, 0],
    [-5, null, 0, 1], [-5, 'backward', 0, 1], [-5, 'forward', 1, 1]
  ]) {
    const sim = carDynamicsHarness({ speed });
    if (input) sim.controller.keys[input] = true;
    sim.advance(1 / 60);
    assert.equal(sim.car.lights[0], Boolean(brake), `brake at speed ${speed}, input ${input}`);
    assert.equal(sim.car.lights[1], Boolean(reverse), `reverse at speed ${speed}, input ${input}`);
    const onFoot = teleportHarness('person').ent;
    sim.controller.entities.person = onFoot;
    sim.controller.setMode('person', { x: 0, y: 0, z: 0, heading: 0 });
    assert.deepEqual(sim.car.lights, [false, false], 'leaving the car resets both lamps');
  }
});

test('releasing car steering settles smoothly and suspension leans outward', () => {
  const sim = carDynamicsHarness({ speed: 15 });
  sim.controller.keys.left = true;
  sim.advance(2);
  const turning = sim.car.angularVel;
  assert.ok(sim.car.chassisPivot.rotation.z > 0, 'the body rolls away from the turn');
  sim.controller.keys.left = false;
  sim.advance(1 / 60);
  assert.ok(sim.car.angularVel > 0, 'steering release does not snap away the existing yaw');
  sim.advance(1.5);
  assert.ok(Math.abs(sim.car.angularVel) < Math.abs(turning) * 0.1, 'yaw settles after the wheel recenters');
  assert.ok(Math.abs(sim.car.steerAngle) < 0.001);
});

test('S and Space have the same grip and steering through service braking', () => {
  for (const speed of [15, 25]) {
    const backward = carDynamicsHarness({ speed });
    const space = carDynamicsHarness({ speed });
    backward.controller.keys.backward = true;
    space.controller.keys.brake = true;
    for (const sim of [backward, space]) {
      sim.controller.keys.left = true;
      sim.advance(0.75);
    }
    assert.deepEqual(carVelocity(backward.car), carVelocity(space.car));
    assert.equal(backward.car.heading, space.car.heading);
    assert.ok(backward.car.heading > 0.03, 'steering stays available under braking');
    assert.ok(Math.hypot(...carVelocity(backward.car)) < speed);
  }
});

test('sustained car turns produce bounded slip that recovers with countersteering', () => {
  for (const speed of [5, 15, 25]) {
    const sim = carDynamicsHarness({ speed });
    sim.controller.keys.forward = true;
    sim.controller.keys.left = true;
    let peakSlip = 0;
    for (let i = 0; i < 900; i++) {
      sim.controller.updateCar(1 / 60);
      const slip = Math.atan2(Math.hypot(sim.car.vx, sim.car.vz), Math.abs(sim.car.speed));
      peakSlip = Math.max(peakSlip, slip);
      assert.ok(sim.car.speed > 4, 'holding a turn does not spin the car to a stop');
    }
    assert.ok(peakSlip > 0 && peakSlip < 0.27, `hard turns allow a modest slide without a growing spin: ${peakSlip}`);

    sim.controller.keys.left = false;
    sim.controller.keys.right = true;
    sim.advance(0.5);
    assert.ok(sim.car.angularVel < 0, 'countersteering brings yaw back under control');
    sim.controller.keys.right = false;
    sim.controller.keys.forward = false;
    sim.advance(2);
    assert.ok(Math.hypot(sim.car.vx, sim.car.vz) < 0.05, 'the slide settles after steering is released');
  }
});

test('car collision momentum is retained and sideways motion settles through grip', () => {
  const forward = carDynamicsHarness({ vz: 8 });
  forward.advance(0.1);
  assert.ok(carVelocity(forward.car)[1] > 7.7, 'a forward impact becomes rolling motion instead of disappearing');
  assert.ok(forward.car.speed > 7.7, 'longitudinal momentum reaches the signed speed used by other systems');

  const sideways = carDynamicsHarness({ vx: 8 });
  sideways.advance(0.1);
  assert.ok(carVelocity(sideways.car)[0] > 6.9, 'tire grip cannot remove a sideways impact instantly');
  sideways.advance(2);
  assert.ok(Math.abs(carVelocity(sideways.car)[0]) < 0.1, 'sideways velocity eventually settles');
});

test('unpowered car steering and collision recovery never add translational energy', () => {
  const sim = carDynamicsHarness({ speed: 20, vx: 3, angularVel: 1 });
  sim.controller.keys.left = true;
  let speed = Math.hypot(...carVelocity(sim.car));
  for (let i = 0; i < 240; i++) {
    sim.controller.updateCar(1 / 60);
    const next = Math.hypot(...carVelocity(sim.car));
    assert.ok(Number.isFinite(next) && next <= speed + 1e-9, 'steering and grip may redirect or dissipate momentum, but cannot create it');
    speed = next;
  }
});

test('car turning, handbraking and impact recovery agree across display rates', () => {
  const results = [30, 60, 120, 144].map((hz) => {
    const sim = carDynamicsHarness({ speed: 15, vx: 2, angularVel: 0.5 });
    sim.controller.keys.left = 0.6;
    sim.controller.keys.forward = 0.5;
    sim.advance(2, hz);
    sim.controller.keys.forward = false;
    sim.controller.keys.backward = 0.8;
    sim.advance(0.5, hz);
    sim.controller.keys.backward = false;
    sim.controller.keys.left = false;
    sim.advance(1, hz);
    return sim.car;
  });
  for (const car of results.slice(0, -1)) {
    const reference = results.at(-1);
    assert.ok(Math.hypot(car.position.x - reference.position.x, car.position.z - reference.position.z) < 0.1, 'path differs by less than ten centimetres');
    assert.ok(Math.abs(car.heading - reference.heading) < 0.01);
    assert.ok(Math.abs(car.speed - reference.speed) < 0.05);
    assert.ok(Math.abs(car.chassisPivot.rotation.z - reference.chassisPivot.rotation.z) < 0.01);
  }
});

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], helicopter: [11.4, 3.3] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'helicopter' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, lights: [true, true], wheelSpin: 1,
    setLights(braking, reversing) { this.lights = [braking, reversing]; },
    wheels: [{ isFront: true, restY: 0.36, steerPivot: { position: position(0.82, 0.36, 1.45), rotation: { y: 0.4 } },
      tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7,
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } }, pedals: [],
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(),
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
      assert.deepEqual(ent.lights, [false, false]);
    } else if (mode === 'cyclist') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 120, 'keep the helicopter altitude when already above the minimum');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'helicopter' ? 120 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('explicit drive start placement requires the exact open point and never chooses another road', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 20 }]);
  assert.equal(controller.teleportActiveTo(5, 5, 0, null, { exact: true }), null);
  assert.deepEqual([ent.position.x, ent.position.z, ent.speed], [400, 400, 20]);
  assert.equal(controller.teleportActiveTo(510, 5, 0, null, { exact: true }), null);
  assert.deepEqual({ ...controller.teleportActiveTo(25, 8, 0.8, null, { exact: true }) }, { x: 25, z: 8 });
  assert.equal(ent.heading, 0.8);
  assert.equal(ent.speed, 0);
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('movement and teleports preserve polygon courtyards and avoid their actual walls', () => {
  const points = (values) => values.map(([x, z]) => ({ x, z }));
  const collider = { minX: 0, maxX: 30, minZ: 0, maxZ: 30, maxY: 200, polygon: {
    outer: points([[0, 0], [30, 0], [30, 30], [0, 30]]),
    holes: [points([[5, 5], [25, 5], [25, 25], [5, 25]])]
  } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...collider }]);
    assert.deepEqual({ ...controller.teleportActiveTo(15, 15, 0) }, { x: 15, z: 15 });
    const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [15, 15]);
    ent.position.x = 5.1;
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    const resolved = [ent.position.x, ent.position.z];
    assert.ok(ent.position.x > 5.1, 'wall contact moves back into the courtyard');
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], resolved, 'one resolution clears the wall');
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = mode === 'helicopter' ? 0.25 : 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('movement contacts the visible altitude slice of a rotated narrowing tower', () => {
  const ring = half => [{ x: 0, z: -half }, { x: half, z: 0 }, { x: 0, z: half }, { x: -half, z: 0 }];
  const lower = ring(10), upper = ring(2);
  const minY = 10, maxY = 30;
  const collider = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, minY, maxY,
    polygon: { outer: lower, holes: [] }, loft: { lower, upper, minY, maxY } };
  const { controller, ent } = teleportHarness('person', [collider]);
  for (const y of [4, 25, 30]) {
    Object.assign(ent.position, { x: 5, y, z: 0 });
    controller.resolveHorizontalCollision(ent.position, 0.48);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 0]);
  }
  Object.assign(ent.position, { x: 5, y: 15, z: 0 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 0]);
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['helicopter', 3.2]]) {
    const y = mode === 'helicopter' ? 0.25 : 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = mode === 'helicopter' ? 10.35 : 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('helicopter skids cannot pass through a roof below the body origin', () => {
  const { controller, ent } = teleportHarness('helicopter', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 10.2, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 4.5);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 10.2) }, { x: 5, z: 5 });
});

test('unknown ground rejects arrivals while helicopters may remain above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  controller.getGroundHeight = (x, z) => Math.abs(x) > 500 || Math.abs(z) > 500 ? null : 0;
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 400, z: 400 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const heli = teleportHarness('helicopter', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 50 }]);
  heli.ent.position.y = 10;
  assert.deepEqual({ ...heli.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(heli.ent.position.y, 92);
});

test('interactive flight arrivals clear the highest sampled terrain across the model footprint', () => {
  const { controller, ent } = teleportHarness('helicopter');
  controller.maxFlightAltitude = 400;
  ent.collisionBounds = { min: { x: -3, y: -0.25, z: -3 }, max: { x: 3, y: 2, z: 3 } };
  controller.groundHeight = x => x > 5 ? 220 : 140;
  const arrival = controller.teleportActiveTo(5, 5, 0, 100, { requireArrival: true });
  assert.deepEqual({ ...arrival }, { x: 5, z: 5 });
  assert.equal(ent.position.y, 221.25);
  controller.groundHeight = () => 450;
  assert.equal(controller.teleportActiveTo(50, 50, 0, 100, { requireArrival: true }), null);
  assert.deepEqual([ent.position.x, ent.position.y, ent.position.z], [5, 221.25, 5]);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('inactive player vehicles do not block explicit teleports', () => {
  const { controller } = teleportHarness('person');
  for (const mode of ['car', 'cyclist', 'helicopter']) {
    const inactive = teleportHarness(mode).ent;
    inactive.position.x = inactive.position.z = 0;
    inactive.position.y = 0.22;
    controller.entities[mode] = inactive;
  }
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, 0, null, { exact: true }) }, { x: 0, z: 0 });
});

test('walk mode keeps curb step-offs grounded while real jumps arc and pin the contact shadow to the pavement', () => {
  const { controller } = keyboardHarness({
    ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
    blockAt: (_x, z) => (z < 0 ? {} : null)
  });
  let maxRigAir = 0;
  const shadow = {
    position: { y: 0.02 },
    scale: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  };
  const person = {
    type: 'person',
    position: { x: 0, y: 0.22, z: -0.4 },
    prevX: 0,
    prevZ: -0.4,
    heading: 0,
    speed: 2.0,
    verticalVel: 0,
    jumping: false,
    shadow,
    mesh: { visible: true },
    rig: { placed: true, update(_dt, _x, _z, _h, _g, _o, air) { maxRigAir = Math.max(maxRigAir, air); } },
    crowd: { updates: 0, begin() {}, add() {}, end() {} }
  };
  controller.activeMode = 'person';
  controller.colliders = [];
  controller.entities = { person };
  controller.keys.forward = true;

  // Walk across the 0.22 m curb at z = 0: must stay grounded without triggering jump state
  for (let i = 0; i < 30; i++) {
    controller.updatePerson(1 / 60);
    controller.poseCharacters(1 / 60, person.position);
    assert.equal(person.jumping, false, 'stepping off a 0.22 m curb must not trigger jumping');
  }
  assert.equal(person.position.y, 0);
  assert.equal(maxRigAir, 0, 'curb step-off passes air=0 so PersonRig steps down smoothly');

  // Press jump: brief countermovement prep passes negative air to PersonRig, then person launches into the air and contact shadow stays at y = 0.02 in world space
  let minRigAir = 0;
  person.rig.update = (_dt, _x, _z, _h, _g, _o, air) => {
    minRigAir = Math.min(minRigAir, air);
    maxRigAir = Math.max(maxRigAir, air);
  };
  controller.keys.up = true;
  controller.updatePerson(1 / 60);
  controller.poseCharacters(1 / 60, person.position);
  controller.keys.up = false;
  assert.ok(person.jumpPrep > 0 && minRigAir < 0, 'jump initiates a brief countermovement wind-up before liftoff');
  for (let i = 0; i < 20; i++) {
    controller.updatePerson(1 / 60);
    controller.poseCharacters(1 / 60, person.position);
  }
  assert.equal(person.jumping, true);
  assert.ok(person.position.y > 0.5 && maxRigAir > 0.5, 'real jump lifts person and informs PersonRig');
  assert.ok(Math.abs((person.position.y + shadow.position.y) - 0.02) < 1e-6, 'contact shadow stays on the ground beneath the jump');
  assert.ok(shadow.scale.x < 0.85, 'contact shadow shrinks with jump height');
});

test('walk mode clamps phantom speed when blocked head-on by a building wall', () => {
  const { controller } = keyboardHarness({
    ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
    blockAt: () => null
  });
  const person = {
    type: 'person',
    position: { x: 0, y: 0, z: -0.5 },
    prevX: 0,
    prevZ: -0.5,
    heading: 0,
    speed: 0,
    verticalVel: 0,
    jumping: false
  };
  controller.activeMode = 'person';
  controller.colliders = [{ minX: -10, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }];
  controller.entities = { person };
  controller.keys.forward = true;

  for (let i = 0; i < 120; i++) controller.updatePerson(1 / 60);
  assert.ok(person.speed < 0.05, `wall-blocked pedestrian does not accumulate phantom sprint speed (got ${person.speed})`);

  // Reversing away from the wall responds immediately on the next frame
  controller.keys.forward = false;
  controller.keys.backward = true;
  controller.updatePerson(1 / 60);
  assert.ok(person.speed < 0 && person.position.z < -0.48, 'pedestrian backs away from wall without waiting to bleed phantom speed');
});

test('cyclist braking stops briskly, pauses at zero before reversing, and supports Space handbrake', () => {
  function bikeHarness(speed = 0, colliders = []) {
    const { controller } = keyboardHarness({
      ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
      CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
      blockAt: () => null
    });
    const cyclist = {
      type: 'cyclist',
      position: { x: 0, y: 0, z: 0 },
      heading: 0,
      speed,
      leanAngle: 0,
      pedalPhase: 0,
      leanPivot: { rotation: { z: 0 } },
      frontWheel: { rotation: { x: 0 } },
      rearWheel: { rotation: { x: 0 } },
      crankPivot: { rotation: { x: 0 } },
      pedals: []
    };
    controller.activeMode = 'cyclist';
    controller.colliders = colliders;
    controller.entities = { cyclist };
    controller.getGroundHeight = () => 0;
    return { controller, cyclist };
  }

  // Holding S from cruising speed (12 m/s) stops in ~6.5 m and pauses cleanly at 0 before backing up
  const sBrake = bikeHarness(12);
  sBrake.controller.keys.backward = true;
  for (let i = 0; i < 72; i++) sBrake.controller.updateCyclist(1 / 60); // 1.2 s
  assert.equal(sBrake.cyclist.speed, 0, 'S brake brings the bicycle to a clean stop without immediately reversing');
  assert.ok(sBrake.cyclist.position.z > 5.5 && sBrake.cyclist.position.z < 7.5,
    `bicycle stops within ~6.5 m from 12 m/s (got ${sBrake.cyclist.position.z.toFixed(2)} m)`);

  // Continuing to hold S past the brief stop hold engages gentle reverse
  for (let i = 0; i < 30; i++) sBrake.controller.updateCyclist(1 / 60);
  assert.ok(sBrake.cyclist.speed < -0.5, 'continuing to hold S after stopping backs the bike up');

  // Holding Space (keys.up) brakes to a complete stop and never reverses
  const handbrake = bikeHarness(15);
  handbrake.controller.keys.up = true;
  for (let i = 0; i < 150; i++) handbrake.controller.updateCyclist(1 / 60);
  assert.equal(handbrake.cyclist.speed, 0, 'Space handbrake stops at zero and never reverses');
  assert.ok(handbrake.cyclist.position.z < 11.5, 'Space handbrake stops crisply from high speed');

  // Wall-blocked cyclist clamps phantom speed so braking/reversing away works immediately
  const blocked = bikeHarness(0, [{ minX: -10, maxX: 10, minZ: 0.5, maxZ: 10, maxY: 30 }]);
  blocked.controller.keys.forward = true;
  for (let i = 0; i < 120; i++) blocked.controller.updateCyclist(1 / 60);
  assert.ok(blocked.cyclist.speed < 0.05, `wall-blocked cyclist clamps phantom speed (got ${blocked.cyclist.speed})`);
});

test('unknown terrain movement restores the last supported position without assigning zero', () => {
  const { controller, ent } = teleportHarness('car');
  ent._safePosition = { x: 400, y: 18, z: 400 };
  ent._support = { height: 18, surfaceId: 'terrain' };
  ent.position.x = 410;
  ent.position.y = 18;
  controller.getGroundHeight = x => x > 405 ? null : 18;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.y, ent.position.z], [400, 18, 400]);
  assert.equal(ent.speed, 0);
});

test('movement cannot skip a narrow unknown strip between two supported endpoints', () => {
  const { controller, ent } = teleportHarness('person');
  ent._safePosition = { x: 0, y: 12, z: 0 };
  ent.position.x = 10; ent.position.z = 0; ent.position.y = 12;
  controller.getGroundHeight = x => x > 4 && x < 6 ? null : 12;
  controller.resolveHorizontalCollision(ent.position, 0.48, null, ent);
  assert.deepEqual([ent.position.x, ent.position.y, ent.position.z], [0, 12, 0]);
});

test('controller surface queries retain resolved elevated support and unknown remains null', () => {
  const { controller } = keyboardHarness();
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: x => x < 10 ? 7 : null });
  delete controller.getGroundHeight;
  controller.entities = { person: { _support: { height: 7, surfaceId: 'terrain' } } };
  assert.equal(controller.getGroundHeight(0, 0), 7);
  assert.equal(controller.getGroundHeight(20, 0), null);
});

test('a car spanning connected slab sections keeps contact and clears their shared seam', () => {
  const { controller } = teleportHarness('car');
  function slab(id, from, to, successor) {
    const points = [[-3, from], [3, from], [3, to], [-3, to]].map(([x, z]) => ({ x, z, y: 4 + z * 0.045 }));
    return { id, heightSource: 'estimate', structured: true, modes: ['car'], driveSuccessors: [successor, 'terrain'],
      triangles: [[points[0], points[1], points[2]], [points[0], points[2], points[3]]] };
  }
  const first = slab('first', -12, 0, 'second'), second = slab('second', 0, 12, 'first');
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: () => 3.2, surfaces: [first, second] });
  controller.colliders = [{ type: 'bridge-slab', name: 'second', minX: -3, maxX: 3, minZ: 0, maxZ: 12,
    minY: 3.8, maxY: 4.54 }];
  assert.equal(controller.isClearCarPose({ x: 0, y: 3.955, z: -1, heading: 0, surfaceId: 'first' }), true);
  assert.equal(controller.isClearCarPose({ x: 0, y: 3.2, z: 5, heading: 0, surfaceId: 'terrain' }), false);
});

test('a car on a flush elevated slab seam takes no phantom side push', () => {
  const makeCollider = () => {
    const outer = [[-6, -20], [6, -20], [6, 20], [-6, 20]].map(([x, z]) => ({ x, z }));
    return { type: 'elevated-slab', name: 'deck', minX: -6, maxX: 6, minZ: -20, maxZ: 20,
      minY: 7.35, maxY: 8, verticalSpan: [7.35, 7.35, 8, 8], polygon: { outer, holes: [] } };
  };
  const run = groundHeight => {
    const { controller, ent } = teleportHarness('car', [makeCollider()]);
    controller.surfaceResolver = createSurfaceResolver({ groundHeight: () => groundHeight });
    delete controller.getGroundHeight;
    Object.assign(ent, { heading: Math.PI / 2, speed: 8, vx: 0, vz: 0, angularVel: 0 });
    Object.assign(ent.position, { x: 0, y: groundHeight, z: 0 });
    ent._safePosition = { x: 0, y: groundHeight, z: 0 };
    ent._support = { height: groundHeight, surfaceId: 'terrain' };
    controller.resolveHorizontalCollision(ent.position, 1.35, ent);
    return { x: ent.position.x, z: ent.position.z };
  };
  for (const groundHeight of [7.999999999999999, 8 - 1e-6, 8]) {
    assert.deepEqual(run(groundHeight), { x: 0, z: 0 }, `flush seam at ${groundHeight}`);
  }
  const stepped = run(7.99);
  assert.ok(Math.hypot(stepped.x, stepped.z) > 0.5, 'a 1 cm step below the deck top is still a side wall');
});

test('a flush deck supplies support where the ground is denied at a wetland portal', () => {
  const { controller, ent } = teleportHarness('cyclist');
  const height = 8;
  const corners = [[-6, -6], [6, -6], [6, 6], [-6, 6]].map(([x, z]) => ({ x, y: height, z }));
  const deck = { id: 'deck', heightSource: 'estimate', solidDeck: true, climbableFromGround: true,
    modes: ['cyclist'], triangles: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]] };
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: () => height, surfaces: [deck] });
  delete controller.getGroundHeight;
  controller.groundAccess = (mode, x, z, surface) => surface.surfaceId !== 'terrain';
  Object.assign(ent.position, { x: 0, y: height, z: 0 });
  ent._support = { height, surfaceId: 'terrain' };
  const body = { car: false, radius: 0.65, extX: 0.65, extZ: 0.65, mode: 'cyclist',
    bottom: 0, top: 1.9, sin: 0, cos: 1 };
  const support = controller.supportedFootprint(0, 0, body, ent);
  assert.equal(support.surfaceId, 'deck');
  assert.ok(body.supportedSlabs?.has('deck'), 'the accepted deck is registered as support');
});

test('the scene bicycle entry crosses dry ground labels and still stops at solid walls and missing ground', () => {
  const main = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
  const start = main.indexOf('    groundAccess: ');
  const end = main.indexOf('\n  });', start);
  assert.ok(start >= 0 && end > start);
  const expression = main.slice(start, end).trim().replace(/^groundAccess: /, '');
  const { permits } = loadModule(`export const permits = ${expression};`, {
    globals: { parkGroundAccess: () => false }
  });
  assert.equal(permits('car', 0, 0, { surfaceId: 'terrain' }), false);
  for (const wall of [false, true]) {
    const { controller, ent } = teleportHarness('cyclist', wall ? [{
      minX: -4, maxX: 4, minY: 0, maxY: 3, minZ: 4, maxZ: 4.3
    }] : []);
    controller.surfaceResolver = createSurfaceResolver({ groundHeight: (x, z) => z < 6 ? 0 : null });
    delete controller.getGroundHeight;
    controller.groundAccess = permits;
    Object.assign(ent.position, { x: 0, y: 0, z: 0 });
    ent._support = { height: 0, surfaceId: 'terrain' };
    ent._safePosition = { x: 0, y: 0, z: 0 };
    ent.heading = 0;
    ent.speed = 4;
    controller.keys.forward = true;
    for (let i = 0; i < 10; i++) controller.updateCyclist(0.05);
    assert.ok(ent.position.z > 2, 'the scene entry accepts supported dry ground even when the park policy denies it');
    for (let i = 0; i < 40; i++) controller.updateCyclist(0.05);
    assert.ok(ent.position.z > 3);
    assert.ok(ent.position.z < (wall ? 3.36 : 5.36));
    assert.ok(ent.speed < 0.05);
  }
});

test('stationary player tires follow the four active contacts on a sloped deck and the road beneath', () => {
  const { controller } = keyboardHarness();
  const ground = (x, z) => 0.06 * x + 0.03 * z;
  const corners = [[-5, -5], [5, -5], [5, 5], [-5, 5]].map(([x, z]) => ({ x, z, y: ground(x, z) + 6 }));
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: ground, surfaces: [{
    id: 'deck', heightSource: 'estimate', triangles: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]]
  }] });
  const car = { heading: Math.PI / 2, position: { x: 0, y: 6, z: 0 },
    _support: { height: 6, surfaceId: 'deck' }, wheels: [-1, 1].flatMap(side => [-1.45, 1.45].map(z => ({
      restY: 0.36, steerPivot: { position: { x: 0.82 * side, y: 0.36, z } }
    }))) };
  for (const [height, surfaceId] of [[6, 'deck'], [0, 'terrain']]) {
    car.position.y = height;
    car._support = { height, surfaceId };
    controller.updateCarWheelContact(car);
    for (const { restY, steerPivot: { position: tire } } of car.wheels) {
      assert.ok(Math.abs(height + tire.y - restY - (height + ground(tire.z, -tire.x))) < 1e-9);
    }
  }
});

function walkingPlatform(name, top, bottom = 0) {
  const minX = 1, maxX = 4, minZ = -2, maxZ = 2;
  const corners = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]].map(([x, z]) => ({ x, y: top, z }));
  return {
    collider: { name, minX, maxX, minZ, maxZ, minY: bottom, maxY: top, polygon: { outer: corners, holes: [] } },
    surface: { id: name, heightSource: 'fixture-measured',
      triangles: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]] }
  };
}

function walkingHarness(platform, extraColliders = [], { x = 0, y = 0, z = 0, jumping = false } = {}) {
  const { controller, ent } = teleportHarness('person', [platform.collider, ...extraColliders]);
  delete controller.getGroundHeight;
  controller.groundHeight = () => 0;
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: controller.groundHeight, surfaces: [platform.surface] });
  Object.assign(ent.position, { x, y, z });
  Object.assign(ent, { heading: Math.PI / 2, speed: 0, jumping, jumpPrep: 0, verticalVel: jumping ? -3 : 0,
    _safePosition: { x, y, z }, _support: { height: 0, surfaceId: 'terrain' } });
  return { controller, ent, walk(frames, forward = 0.2) {
    controller.keys.forward = forward;
    for (let i = 0; i < frames; i++) controller.updatePerson(1 / 60);
  } };
}

test('walking steps onto a low rendered platform and keeps its footing after stopping and switching modes', () => {
  const { controller, ent, walk } = walkingHarness(walkingPlatform('low', 0.24));
  walk(128);
  assert.ok(ent.position.x > 2 && ent.position.x < 4);
  assert.equal(ent.position.y, 0.24);
  assert.equal(ent._support.surfaceId, 'low');
  walk(30, 0);
  assert.equal(ent.position.y, 0.24);

  const car = teleportHarness('car').ent;
  Object.assign(car.position, { x: 0.4, y: 0, z: 0 });
  car.heading = 0;
  car._safePosition = { x: 0, y: 0, z: 0 };
  car._support = { height: 0, surfaceId: 'terrain' };
  controller.entities.car = car;
  const resolver = controller.surfaceResolver;
  controller.surfaceResolver = { ...resolver, footing() { throw new Error('The vehicle must not use pedestrian footing'); } };
  assert.equal(controller.setMode('car'), true);
  assert.equal(car.position.x, ent.position.x);
  assert.equal(car.position.y, 0.24);
  assert.equal(car._support.surfaceId, 'low');
  controller.setMode('car', { x: 0.4, y: 0, z: 0, heading: 0 });
  controller.resolveHorizontalCollision(car.position, 1.35, car);
  assert.ok(car.position.x <= 0.15);
  assert.equal(car.position.y, 0);
  assert.equal(car._support.surfaceId, 'terrain');
  controller.surfaceResolver = resolver;
  // 同一个角色已经坐进车里：不再留在平台上自行行走，也不再跑步行解算。
  const seated = { x: ent.position.x, z: ent.position.z };
  for (let i = 0; i < 30; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 0 });
  assert.deepEqual({ x: ent.position.x, z: ent.position.z }, seated, 'the driver stays in the seat instead of walking off');
});

test('walking cannot climb a high platform or cross a side wall while stepping onto a low one', () => {
  const side = { minX: 1, maxX: 1.16, minZ: -2, maxZ: 2, minY: 0, maxY: 1.2 };
  for (const [platform, walls] of [[walkingPlatform('high', 0.72), []], [walkingPlatform('low', 0.24), [side]]]) {
    const { ent, walk } = walkingHarness(platform, walls);
    walk(180);
    assert.ok(ent.position.x <= 0.521);
    assert.equal(ent.position.y, 0);
    assert.equal(ent._support.surfaceId, 'terrain');
  }
});

test('bridge levels keep walking and jumping on their own supported surfaces', () => {
  const bridge = walkingPlatform('bridge', 4, 3.68);
  const below = walkingHarness(bridge);
  below.walk(220);
  assert.ok(below.ent.position.x > 4);
  assert.equal(below.ent.position.y, 0);
  assert.equal(below.ent._support.surfaceId, 'terrain');
  const above = walkingHarness(bridge, [], { x: 2, y: 5.1, jumping: true });
  above.walk(100, 0);
  assert.equal(above.ent.position.y, 4);
  assert.equal(above.ent._support.surfaceId, 'bridge');
  assert.equal(above.ent.jumping, false);

  above.walk(180, 1);
  const edge = bridge.collider.maxX - 0.48;
  assert.ok(above.ent.position.x > edge - 0.1 && above.ent.position.x <= edge + 1e-6);
  assert.equal(above.ent.position.y, 4);
  above.controller.keys.up = true;
  above.walk(7, 1);
  above.controller.keys.up = false;
  above.walk(14, 1);
  assert.equal(above.ent.jumping, true);
  assert.ok(above.ent.position.y > 4.5);
  assert.ok(above.ent.position.x <= edge + 1e-6);
  above.walk(60, 1);
  assert.equal(above.ent.position.y, 4);
  assert.equal(above.ent.jumping, false);
  assert.ok(above.ent.position.x <= edge + 1e-6);
  assert.equal(above.ent._support.surfaceId, 'bridge');
});

test('vehicle collision uses the outside edge of its rendered geometry envelope', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 1, maxX: 4, minZ: -10, maxZ: 10, maxY: 2 }]);
  ent.heading = 0;
  Object.assign(ent.position, { x: 0, y: 0, z: 0 });
  ent.collisionBounds = { min: { x: -1.115, y: 0, z: -2.369 }, max: { x: 1.115, y: 1.81, z: 2.38 } };
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.115) < 1e-9);
});

test('passenger aircraft caps speed and altitude and brings level skids onto terrain', () => {
  const { controller, ent } = teleportHarness('helicopter');
  ent.collisionBounds = { min: { x: -3, y: 0, z: -2.8 }, max: { x: 3, y: 2.2, z: 2.8 } };
  Object.assign(ent.position, { x: 0, y: 10, z: 0 });
  ent.speed = ent.verticalSpeed = 0;
  controller.maxFlightAltitude = 400;
  controller.keys.forward = controller.keys.up = true;
  for (let i = 0; i < 120; i++) controller.updateHelicopter(1 / 60);
  assert.ok(Math.abs(ent.speed * 3.6 - 400) < 0.01);
  assert.ok(Math.abs(ent.verticalSpeed - 20) < 1e-8);

  ent.position.y = 399.97;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y, 400);
  assert.equal(ent.verticalSpeed, 0);

  ent.position.y = 0.06;
  ent.verticalSpeed = -5;
  controller.keys.up = false;
  controller.keys.down = true;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y + ent.collisionBounds.min.y, 0);
  assert.equal(ent.verticalSpeed, 0);
  assert.ok(ent.tiltPivot.rotation.x === 0 && ent.tiltPivot.rotation.z === 0);
});

test('a passenger aircraft descends onto the roof only from above and with its envelope supported', () => {
  const { controller, ent } = teleportHarness('helicopter');
  const { createSurfaceResolver } = loadModule(readFileSync(join(__dirname, '../js/sz-controller-surfaces.js'), 'utf8'));
  const a = { x: -10, y: 10, z: -10 }, b = { x: 10, y: 10, z: -10 };
  const c = { x: 10, y: 10, z: 10 }, d = { x: -10, y: 10, z: 10 };
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: () => 0, surfaces: [
    { id: 'sourced-roof', heightSource: 'landmark', triangles: [[a, b, c], [a, c, d]] }
  ] });
  controller.groundHeight = () => 0;
  ent.collisionBounds = { min: { x: -3, y: 0, z: -2.8 }, max: { x: 3, y: 2.2, z: 2.8 } };
  ent.heading = ent.speed = 0;
  Object.assign(ent.position, { x: 0, y: 10.04, z: 0 });
  assert.equal(controller.getFlightSupport(ent, 9), 0);
  ent.position.x = 8;
  assert.equal(controller.getFlightSupport(ent, 11), 0);

  ent.position.x = 0;
  ent.verticalSpeed = -5;
  controller.keys.down = true;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y, 10);
  assert.equal(ent.verticalSpeed, 0);
});

test('aircraft stops before terrain above its ceiling without compressing skids into terrain', () => {
  const { controller, ent } = teleportHarness('helicopter');
  controller.maxFlightAltitude = 400;
  controller.groundHeight = (x, z) => z > 0.1 ? 429 : 390;
  ent.collisionBounds = { min: { x: -3, y: -0.25, z: -3 }, max: { x: 3, y: 2, z: 3 } };
  Object.assign(ent.position, { x: 0, y: 400, z: 0 });
  ent.heading = 0;
  ent.speed = 36;
  ent.verticalSpeed = 0;
  controller.keys.forward = true;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.z, 0);
  assert.equal(ent.position.y, 400);
  assert.equal(ent.speed, 0);

  controller.groundHeight = () => 429;
  controller.keys.forward = false;
  controller.keys.down = true;
  for (let i = 0; i < 120; i++) controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y + ent.collisionBounds.min.y, 429);
  assert.equal(ent.verticalSpeed, 0);
});


test('player vehicles reach their configured speed limits across frame rates', () => {
  for (const hz of [30, 60, 120, null]) {
    for (const [mode, target, seconds] of [['car', 120, 3], ['cyclist', 60, 4], ['helicopter', 600, 3], ['helicopter', -400, 4]]) {
      const sim = mode === 'car' ? carDynamicsHarness() : teleportHarness(mode);
      const { controller } = sim;
      const entity = sim.car || sim.ent;
      Object.assign(entity.position, { x: 0, y: mode === 'helicopter' ? 100 : 0, z: 0 });
      Object.assign(entity, { speed: 0, heading: 0, verticalSpeed: 0 });
      controller.getGroundHeight = () => 0;
      controller.resolveHorizontalCollision = () => {};
      const input = target < 0 ? 'backward' : 'forward';
      controller.keys[input] = true;
      const update = mode === 'car' ? 'updateCar' : mode === 'cyclist' ? 'updateCyclist' : 'updateHelicopter';
      let elapsed = 0, frame = 0;
      for (const milestone of [1, 2, 3, 4, 6]) {
        while (elapsed < milestone - 1e-10) {
          const dt = Math.min(hz ? 1 / hz : [1 / 30, 1 / 144, 1 / 60][frame++ % 3], milestone - elapsed);
          controller[update](dt);
          elapsed += dt;
        }
        assert.ok(Math.abs(entity.speed * 3.6 - target * Math.min(1, milestone / seconds)) < 0.01,
          `${mode} reaches the expected speed at ${milestone}s with ${hz || 'variable'} FPS`);
      }
      assert.equal(Math.sign(entity.position.z), Math.sign(target), 'the vehicle moves in the requested direction');
      controller.keys[input] = false;
      controller[update](0.1);
      assert.equal(Math.sign(entity.speed), Math.sign(target));
      assert.ok(Math.abs(entity.speed * 3.6) < Math.abs(target), 'release slows the vehicle');
    }
  }
});

test('aircraft at top speed cannot skip a narrow obstacle during a slow frame', () => {
  for (const [speed, obstacleZ] of [[600, 4], [-400, -2.8]]) {
    const { controller, ent } = teleportHarness('helicopter', [
      { minX: -20, maxX: 20, minY: 99, maxY: 110, minZ: obstacleZ - 0.1, maxZ: obstacleZ + 0.1 }
    ]);
    Object.assign(ent.position, { x: 0, y: 100, z: 0 });
    ent.collisionBounds = { min: { x: -3, y: 0, z: -2 }, max: { x: 3, y: 2.2, z: 2 } };
    Object.assign(ent, { heading: 0, speed: speed / 3.6, verticalSpeed: 0 });
    controller.keys[speed > 0 ? 'forward' : 'backward'] = true;
    controller.updateHelicopter(0.05);
    assert.ok(Math.abs(ent.position.z) <= Math.abs(obstacleZ) - 2.1 + 1e-6);
    assert.ok(Math.abs(ent.speed * 3.6) < 1);
  }
});

test('speed telemetry uses the physical maximum for each mode and reports speed magnitude', () => {
  const { PLAYER_SPEED_LIMITS } = keyboardHarness();
  const ui = readFileSync(join(__dirname, '../js/sz-ui.js'), 'utf8');
  const { createHudTelemetry } = loadModule(ui, {
    imports: { './sz-strings.js': {}, './sz-city-config.js': {}, './sz-observation-session.js': {} }
  });
  const entity = { speed: 0, position: { x: 0, y: 200, z: 0 } };
  const controllerManager = { getActiveEntity: () => entity };
  const els = { speed: {}, speedMeter: { style: {} } };
  const cameraSystem = { getActivePreset: () => ({ category: 'follow' }) };
  let location;
  const hud = createHudTelemetry({
    els, controllerManager, topSpeed: PLAYER_SPEED_LIMITS, cameraSystem,
    renderLocation: (x, z) => { location = [x, z]; }
  });
  for (const [mode, speedKmh, expectedFill] of [
    ['person', 0, 0], ['person', 8.2 * 3.6 / 2, 0.5], ['person', 8.2 * 3.6, 1],
    ['car', 80, 2 / 3], ['car', 120, 1], ['car', 130, 1],
    ['cyclist', 30, 0.5], ['cyclist', 60, 1],
    ['helicopter', 300, 0.5], ['helicopter', 600, 1], ['helicopter', -400, 2 / 3]
  ]) {
    controllerManager.activeMode = mode;
    entity.speed = speedKmh / 3.6;
    hud.update(0.25);
    assert.equal(els.speed.textContent, String(Math.round(Math.abs(speedKmh))), mode);
    const fill = Number(els.speedMeter.style.transform.match(/^scaleX\((.+)\)$/)?.[1]);
    assert.ok(Math.abs(fill - expectedFill) < 1e-9, mode + ' at ' + speedKmh + ' km/h');
  }
  cameraSystem.droneFollow = { pose: { position: { x: 50, z: 80 } } };
  hud.update(0.25);
  assert.deepEqual(location, [50, 80]);
  cameraSystem.droneFollow = null;
  hud.update(0.25);
  assert.deepEqual(location, [0, 0]);
});

function contactCar({ speed = 0, heading = 0, colliders = [], y = 0 } = {}) {
  const { controller, ent: car } = teleportHarness('car', colliders);
  const origin = { x: 0, y, z: 0 };
  Object.assign(car, { heading, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0,
    heaveVel: 0, heaveY: 0, _safePosition: { ...origin }, _support: { height: y, surfaceId: 'terrain' } });
  Object.assign(car.position, origin);
  car.collisionBounds = { min: { x: -1.1, y: 0, z: -2.37 }, max: { x: 1.1, y: 1.8, z: 2.38 } };
  return { controller, car };
}

test('a thin wall stops the 80 and 120 km/h car and sustained throttle cannot bounce it', () => {
  for (const speed of [80 / 3.6, 120 / 3.6, -9]) {
    const sign = Math.sign(speed);
    const wall = { minX: -20, maxX: 20, minY: 0, maxY: 3,
      minZ: sign > 0 ? 4 : -4.12, maxZ: sign > 0 ? 4.12 : -4 };
    const { controller, car } = contactCar({ speed, colliders: [wall] });
    let impacts = 0;
    controller.setCollisionListener(() => impacts++);
    controller.keys[sign > 0 ? 'forward' : 'backward'] = true;
    controller.keys.boost = speed > 30;
    for (let i = 0; i < 80; i++) {
      controller.updateCar(0.05);
      assert.ok(sign * carVelocity(car)[1] >= -1e-8, 'contact cannot reverse world velocity');
      assert.ok(sign * car.position.z <= 1.64, 'the bumper remains on the entry side of the wall');
    }
    assert.ok(Math.abs(car.position.z) > 1.5);
    assert.ok(Math.hypot(...carVelocity(car)) < 1e-7);
    assert.equal(impacts, 1, 'holding against the wall emits a single impact');
  }
});

test('an oblique wall strike sheds the inward velocity and preserves bounded tangential travel', () => {
  const { controller, car } = contactCar({ speed: 120 / 3.6, heading: 0.72,
    colliders: [{ minX: -20, maxX: 100, minZ: 4, maxZ: 4.12, minY: 0, maxY: 3 }] });
  for (let i = 0; i < 8; i++) controller.updateCar(0.05);
  const [vx, vz] = carVelocity(car);
  assert.ok(car.position.x > 3 && vx > 0);
  assert.ok(Math.abs(vz) < 0.2);
  assert.ok(car.position.z < 1.5);
  assert.ok(Math.hypot(vx, vz) < 120 / 3.6);
});

test('manual car stops for same-level pedestrians and ignores another deck', () => {
  const { writePedestrianCollider } = driving['./sz-driving-motion.js'];
  for (const height of [0, 5]) {
    const { controller, car } = contactCar({ speed: 120 / 3.6 });
    const person = writePedestrianCollider({}, 0, height, 6, Math.PI / 2, 0);
    controller.nearPedestrians = () => [person];
    controller.keys.forward = controller.keys.boost = true;
    for (let i = 0; i < 20; i++) controller.updateCar(0.05);
    if (height === 0) {
      assert.ok(car.position.z > 3.1 && car.position.z < 3.31);
      assert.ok(Math.abs(car.speed) < 1e-7);
    } else assert.ok(car.position.z > 30);
  }
});

test('a rear-end contact matches the lead normal velocity while an approaching car cannot launch the player backwards', () => {
  const { writeEntityCollider } = driving['./sz-driving-motion.js'];
  for (const leadSpeed of [0, 6, -6]) {
    const { controller, car } = contactCar({ speed: 18 });
    const lead = writeEntityCollider({}, { type: 'car', position: { x: 0, y: 0, z: 5.1 }, heading: 0, speed: leadSpeed });
    controller.nearTraffic = () => [lead];
    // 直接进入接触阶段，以免前置紧急制动掩盖碰撞后的速度约束。
    controller.applyCarContact(car, lead, 'vehicle', 0, -1, 0, 2.5);
    assert.ok(Math.abs(car.speed - Math.max(leadSpeed, 0)) < 0.1);
  }
});

test('manual emergency brake intervenes before contact without a player setting', () => {
  const { writeEntityCollider } = driving['./sz-driving-motion.js'];
  const leader = writeEntityCollider({}, { type: 'car', position: { x: 0, y: 0, z: 20 }, heading: 0, speed: 0 });
  const { controller, car } = contactCar({ speed: 22 });
  controller.nearTraffic = () => [leader];
  controller.keys.forward = true;
  controller.updateCar(0.05);
  assert.ok(car.position.z < 1.2 && car.speed < 22);
});

test('flight cruise holds horizontal speed through manual turning and climbing until reverse input', () => {
  const { controller, ent } = teleportHarness('helicopter');
  controller.occupant = { state: 'seated' };
  ent.speed = 45;
  ent.position.y = 300;
  assert.equal(controller.canSetCruise(), true);
  controller.cruiseSpeed = ent.speed;
  controller.keys.left = controller.keys.up = true;
  for (let i = 0; i < 120; i++) controller.updateHelicopter(1 / 60);
  assert.equal(ent.speed, 45);
  assert.ok(ent.heading > 1 && ent.position.y > 300);
  controller.keys.backward = true;
  controller.updateHelicopter(1 / 60);
  assert.equal(controller.cruiseSpeed, null);
  assert.ok(ent.speed < 45);
});

test('lane shortcuts request one direction and leave typing, modifiers and repeated keydown alone', () => {
  const window = eventTarget();
  const { wireShortcuts } = loadModule(readFileSync(join(__dirname, '../js/sz-ui.js'), 'utf8'), {
    imports: { './sz-strings.js': {}, './sz-city-config.js': { isTypingInField: e => e.target?.tagName === 'INPUT' },
      './sz-observation-session.js': {} },
    globals: { window }
  });
  const calls = [];
  wireShortcuts({ onLane: direction => calls.push(direction), onLaneCancel: () => calls.push('cancel'),
    onToggleLane: () => calls.push('lane toggle'), onSpeedCruise: () => calls.push('speed cruise') });
  for (const event of [{ code: 'KeyJ' }, { code: 'KeyL' }, { code: 'KeyJ', repeat: true },
    { code: 'KeyL', ctrlKey: true }, { code: 'KeyJ', target: { tagName: 'INPUT' } }, { code: 'Escape' },
    { code: 'KeyK' }, { code: 'KeyU' }, { code: 'KeyE' }, { code: 'KeyF' }, { code: 'KeyF', repeat: true },
    { code: 'KeyF', target: { tagName: 'INPUT' } }, { code: 'KeyF', metaKey: true }, { code: 'KeyK', repeat: true }]) {
    window.dispatch('keydown', event);
  }
  assert.deepEqual(calls, [1, -1, 'cancel', 'lane toggle', 'speed cruise']);
});


test('default flight ceiling clears a 600 metre tower and still clamps ascent', () => {
  const { controller, ent } = teleportHarness('helicopter');
  assert.equal(controller.maxFlightAltitude, 1200);
  ent.heading = ent.speed = 0;
  ent.verticalSpeed = 20;
  Object.assign(ent.position, { x: 0, y: 599, z: 0 });
  controller.keys.up = true;
  for (let i = 0; i < 120; i++) controller.updateHelicopter(1 / 60);
  assert.ok(ent.position.y > 630);
  ent.position.y = 1199.9;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y, 1200);
  assert.equal(ent.verticalSpeed, 0);
});

test('landing on a roof preserves the floor through walking cycling and driving', () => {
  const { controller, ent } = teleportHarness('helicopter');
  delete controller.getGroundHeight;
  controller.groundHeight = () => 8;
  const corners = [[-30, -30], [30, -30], [30, 30], [-30, 30]].map(([x, z]) => ({ x, y: 608, z }));
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: controller.groundHeight, surfaces: [
    { id: 'tower-roof', heightSource: 'fixture-measured', triangles: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]] }
  ] });
  controller.colliders = [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, minY: 8, maxY: 608 }];
  ent.collisionBounds = { min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 2.2, z: 3 } };
  Object.assign(ent.position, { x: 0, y: 608.04, z: 0 });
  ent.heading = ent.speed = 0;
  ent.verticalSpeed = -5;
  controller.keys.down = true;
  controller.updateHelicopter(1 / 60);
  assert.equal(ent.position.y, 608);
  for (const mode of ['person', 'cyclist', 'car']) controller.entities[mode] = teleportHarness(mode).ent;
  assert.equal(controller.setMode('person'), true);
  controller.keys.forward = true;
  for (let i = 0; i < 60; i++) controller.updatePerson(1 / 60);
  assert.ok(controller.entities.person.position.z > 1);
  for (const mode of ['cyclist', 'car', 'person']) {
    assert.equal(controller.setMode(mode), true);
    assert.equal(controller.getActiveEntity().position.y, 608);
    assert.equal(controller.getActiveEntity()._support.surfaceId, 'tower-roof');
  }
  controller.setMode('person', { x: 50, y: 8, z: 0, heading: 0, surfaceId: 'terrain' });
  for (const mode of ['cyclist', 'car']) {
    assert.equal(controller.setMode(mode), true, 'open flat ground does not require a road');
    assert.equal(controller.getActiveEntity().position.y, 8);
  }
});

test('landing across a graded bridge seam permits walking and driving on the same deck', () => {
  const { controller, ent } = teleportHarness('helicopter');
  delete controller.getGroundHeight;
  controller.groundHeight = () => 8;
  const surfaces = [[-20, 0], [0, 30]].map(([start, end], i) => {
    const corners = [[-6, start], [6, start], [6, end], [-6, end]].map(([x, z]) => ({ x, y: 18 + z * 0.04, z }));
    return { id: `deck-${i}`, heightSource: 'fixture-design', structured: true, flightRoadDeck: true,
      modes: ['person', 'car', 'helicopter'], driveSuccessors: [`deck-${1 - i}`],
      triangles: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]] };
  });
  controller.surfaceResolver = createSurfaceResolver({ groundHeight: controller.groundHeight, surfaces });
  controller.colliders = surfaces.flatMap(({ id, triangles }) => triangles.map(outer => {
    const top = outer.map(p => p.y);
    const bottom = top.map(y => y - 0.65);
    return { name: id, type: 'bridge-slab', minX: -6, maxX: 6,
      minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
      minY: Math.min(...bottom), maxY: Math.max(...top),
      polygon: { outer, holes: [] }, roofPanel: { outer, top, bottom } };
  }));
  ent.collisionBounds = { min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 2.2, z: 3 } };
  Object.assign(ent.position, { x: 4, y: 19, z: -0.2 });
  ent.heading = ent.speed = 0;
  assert.equal(controller.getFlightSupport(ent, ent.position.y), 8);
  ent.position.x = 0;
  for (const mode of ['person', 'car']) controller.entities[mode] = teleportHarness(mode).ent;
  assert.equal(controller.findModePosition('person'), null);
  ent.verticalSpeed = -5;
  controller.keys.down = true;
  for (let i = 0; i < 18; i++) controller.updateHelicopter(1 / 60);
  assert.ok(Math.abs(ent.position.y - 18.112) < 1e-6);
  assert.deepEqual([...ent.landedRoadDecks], ['deck-0', 'deck-1']);
  assert.equal(controller.setMode('person'), true);
  controller.keys.forward = true;
  for (let i = 0; i < 120; i++) controller.updatePerson(1 / 60);
  assert.ok(controller.entities.person.position.z > 1);
  assert.equal(controller.entities.person._support.surfaceId, 'deck-1');
  assert.equal(controller.setMode('car'), true);
  assert.equal(controller.entities.car._support.surfaceId, 'deck-1');
  assert.equal(controller.surfaceResolver.resolve(0, 2, {
    mode: 'person', previousY: 8, previousSurfaceId: 'terrain'
  }).surfaceId, 'terrain');
});
