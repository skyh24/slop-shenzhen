const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
// 仓库不提交本机绝对路径：three 包位置只能从环境变量取，未设置时整组跳过。
const skip = !process.env.SZ_THREE_PACKAGE_DIR;
const threeReady = skip ? null : import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));

// 坐姿解算读取骨架绑定；用同名占位骨骼，不依赖真实蒙皮资源。
const PERSON_BONES = {
  PELVIS: 'PELVIS', CHEST: 'CHEST', HEAD: 'HEAD', THIGH_L: 'THIGH_L', THIGH_R: 'THIGH_R',
  UPPER_ARM_L: 'UPPER_ARM_L', FOREARM_L: 'FOREARM_L', UPPER_ARM_R: 'UPPER_ARM_R', FOREARM_R: 'FOREARM_R'
};

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    }
  };
}

// 用真实 three 实体和桩场景配置加载真实 controllers.js；构造器被跳过，乘员初值按契约手动置入。
function loadControllers(THREE, world) {
  return loadModule(source, {
    globals: { window: eventTarget(), document: { ...eventTarget(), hidden: false } },
    imports: {
      ...driving,
      'three/webgpu': THREE,
      './sz-city-config.js': {
        ISLAND_BOUNDS: { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000, sidewalkHeight: 0 },
        SPAWN_POINT: { x: 0, y: 0, z: 0, heading: 0 },
        terrainHeight: () => 0,
        findGroundArrival: (target, _mode, { radius, isClear }) => world.roads
          .map(point => ({ ...point, distance: Math.hypot(point.x - target.x, point.z - target.z) }))
          .filter(point => point.distance <= radius)
          .sort((a, b) => a.distance - b.distance)
          .find(isClear) ?? null,
        isTypingInField: () => false,
        isWater: (x, z) => world.water(x, z)
      },
      './sz-controller-surfaces.js': {},
      './sz-park-arrivals.js': {},
      './sz-strings.js': { STR: { modeNames: { person: 'person', car: 'car', cyclist: 'cyclist', helicopter: 'helicopter' } } },
      './city-lighting-materials.js': { cityUniforms: { uInteriorGlow: { value: 0 } }, createContactShadowMaterial: () => ({}) },
      './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } },
      './pedestrians.js': { PersonCrowd: class {}, PersonRig: class {}, PERSON_BONES },
      './vehicle-lights.js': { HEADLIGHTS: { intensity: 1 }, createVehicleHeadlight: () => ({}), placeVehicleHeadlight() {} },
      './building-collision.js': {}
    },
    filename: 'js/controllers.js'
  });
}

function mockCrowd() {
  return {
    updates: 0, adds: [],
    begin() {}, end() {},
    add(rig, index) { this.adds.push([rig, index]); this.updates++; }
  };
}

// 只记录调用的骨架桩：ride 是契约里明确要求的骑姿入口，其余方法供真实坐姿解算调用。
function mockRig(THREE, rideCalls) {
  const bind = {
    PELVIS: new THREE.Vector3(0, 0.92, 0), CHEST: new THREE.Vector3(0, 1.3, 0),
    HEAD: new THREE.Vector3(0, 1.58, 0), UPPER_ARM_L: new THREE.Vector3(0.2, 1.36, 0),
    FOREARM_L: new THREE.Vector3(0.22, 1.08, 0), UPPER_ARM_R: new THREE.Vector3(-0.2, 1.36, 0),
    FOREARM_R: new THREE.Vector3(-0.22, 1.08, 0)
  };
  return {
    s: 1, bind, placed: false,
    headPosition: new THREE.Vector3(0, 1.6, 0), headQuaternion: new THREE.Quaternion(),
    writeBone() {}, writeFoot() {}, limb() {},
    jointFrom(_fromBone, _toBone, _quat, from, out) { return out.copy(from); },
    solveLeg(_index, _hip, ankle) { return new THREE.Vector3(ankle.x, ankle.y, ankle.z); },
    update() {}, reset() {},
    ride(root, crank, frame) { rideCalls.push([root, crank, frame]); }
  };
}

function createHarness(THREE, overrides = {}) {
  const state = { water: () => false, traffic: () => [], colliders: [], ground: () => 0, roads: [], ...overrides };
  const loaded = loadControllers(THREE, state);
  // 未导出时退回契约字面量，让缺特性版本继续跑到真正的行为断言，而不是在装配期抛 TypeError。
  const OCCUPANT_STATES = loaded.OCCUPANT_STATES ??
    { WALKING: 'walking', BOARDING: 'boarding', SEATED: 'seated', ALIGHTING: 'alighting' };
  const controller = Object.create(loaded.ThirdPersonControllerManager.prototype);
  const rideCalls = [];
  const pilotCalls = [];
  const rig = mockRig(THREE, rideCalls);

  const person = {
    type: 'person', position: new THREE.Vector3(0, 0, 0), heading: 0, speed: 0,
    prevX: 0, prevZ: 0, verticalVel: 0, jumping: false, jumpPrep: 0,
    mesh: new THREE.Group(), rig, crowd: mockCrowd(),
    shadow: { visible: true, position: new THREE.Vector3(0, 0.02, 0), scale: new THREE.Vector3(1, 1, 1) },
    _support: { height: 0, surfaceId: 'terrain' }, _safePosition: { x: 0, y: 0, z: 0 },
    cameraTargetOffset: new THREE.Vector3(0, 1.55, 0), chaseDistance: 4.3, chaseHeight: 1.95
  };
  const car = {
    type: 'car', position: new THREE.Vector3(2, 0, 0), heading: 0, speed: 0,
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0,
    wheelSpin: 0, lastCollisionSpark: null, wheels: [], lights: [false, false],
    mesh: new THREE.Group(), chassisPivot: new THREE.Group(),
    collisionBounds: { min: { x: -1.1, y: 0, z: -2.3 }, max: { x: 1.1, y: 1.8, z: 2.3 } },
    seat: {
      pelvis: new THREE.Vector3(0, 0.64, 0), recline: 0.12,
      feet: [new THREE.Vector3(0.19, 0.24, 0.72), new THREE.Vector3(-0.19, 0.24, 0.72)],
      hands: [new THREE.Vector3(0.165, 0.9, 0.47), new THREE.Vector3(-0.165, 0.9, 0.47)]
    },
    setLights(braking, reversing) { this.lights = [braking, reversing]; },
    _support: { height: 0, surfaceId: 'terrain' }, _safePosition: { x: 2, y: 0, z: 0 }, prevX: 2, prevZ: 0,
    cameraTargetOffset: new THREE.Vector3(0, 0.96, 0), chaseDistance: 6.9, chaseHeight: 2.12
  };
  car.mesh.add(car.chassisPivot);
  car.mesh.position.copy(car.position);

  const cyclist = {
    type: 'cyclist', position: new THREE.Vector3(4, 0, 0), heading: 0, speed: 0,
    leanAngle: 0, pedalPhase: 0, mesh: new THREE.Group(), leanPivot: new THREE.Group(),
    helmet: new THREE.Group(),
    bikeFrame: {
      seat: new THREE.Vector3(0, 0.93, -0.235), bars: new THREE.Vector3(0, 1.05, 0.42),
      bracket: new THREE.Vector3(0, 0.28, -0.1), gripHalf: 0.22, crankLength: 0.17 },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } }, pedals: [], wheelRadius: 0.335,
    collisionBounds: { min: { x: -0.4, y: 0, z: -0.9 }, max: { x: 0.4, y: 1.4, z: 0.9 } },
    _brakeHold: 0,
    _support: { height: 0, surfaceId: 'terrain' }, _safePosition: { x: 4, y: 0, z: 0 }, prevX: 4, prevZ: 0,
    cameraTargetOffset: new THREE.Vector3(0, 1.35, 0), chaseDistance: 4.8, chaseHeight: 2.05
  };
  cyclist.mesh.add(cyclist.leanPivot);
  cyclist.mesh.position.copy(cyclist.position);
  cyclist.helmet.visible = true;

  const helicopter = {
    type: 'helicopter', position: new THREE.Vector3(-4, 0, 0), heading: 0, speed: 0,
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    mesh: new THREE.Group(), tiltPivot: new THREE.Group(),
    updateRotors() {},
    collisionBounds: { min: { x: -3, y: -0.25, z: -2.8 }, max: { x: 3, y: 2.2, z: 2.8 } },
    seat: {
      pelvis: new THREE.Vector3(0, 0.95, 0.2), recline: 0.1,
      feet: [new THREE.Vector3(0.3, 0.35, 0.85), new THREE.Vector3(-0.3, 0.35, 0.85)],
      hands: [new THREE.Vector3(0.3, 1.05, 0.6), new THREE.Vector3(-0.3, 1.05, 0.6)]
    },
    setOccupantVisible(visible) { pilotCalls.push(visible); this.occupantVisible = visible; },
    _support: { height: 0, surfaceId: 'terrain' }, _safePosition: { x: -4, y: 0, z: 0 }, prevX: -4, prevZ: 0,
    cameraTargetOffset: new THREE.Vector3(0, 1.26, 0), chaseDistance: 8.9, chaseHeight: 2.85
  };
  helicopter.mesh.add(helicopter.tiltPivot);
  helicopter.mesh.position.copy(helicopter.position);

  controller.scene = new THREE.Scene();
  controller.colliders = state.colliders;
  controller.nearTraffic = (x, z, r) => state.traffic(x, z, r);
  controller.roadHeight = state.roadHeight ?? (() => null);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost', 'brake'].map((key) => [key, false]));
  controller.activeMode = 'person';
  controller.occupant = { state: OCCUPANT_STATES.WALKING, mode: null, timer: 0 };
  controller.maxFlightAltitude = 900;
  controller.spawnPoint = { x: 0, y: 0, z: 0 };
  controller.groundHeight = (x, z) => {
    const y = state.ground(x, z);
    return Number.isFinite(y) ? y : null;
  };
  controller.getGroundHeight = (x, z) => controller.groundHeight(x, z);
  controller.getFlightSupport = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.surfaceResolver = {
    resolve(x, z) {
      const y = state.ground(x, z);
      return Number.isFinite(y) ? { height: y, surfaceId: 'terrain' } : null;
    },
    below(x, z, y) {
      const point = this.resolve(x, z);
      return point && point.height <= y ? point : null;
    },
    footing(x, z) { return this.resolve(x, z); }
  };
  controller.entities = { person, car, cyclist, helicopter };

  let elapsed = 0;
  return {
    THREE, controller, OCCUPANT_STATES, exportedStates: loaded.OCCUPANT_STATES,
    state, person, car, cyclist, helicopter, rig, rideCalls, pilotCalls,
    advance(seconds, step = 1 / 60) {
      const ticks = Math.ceil(seconds / step - 1e-9);
      for (let i = 0; i < ticks; i++) controller.update(step, (elapsed += step));
      return ticks;
    }
  };
}

function seatWorld(vehicle) {
  const pivot = vehicle.type === 'car' ? vehicle.chassisPivot : vehicle.tiltPivot;
  return pivot.localToWorld(vehicle.seat.pelvis.clone());
}

function boardAndSit(h, mode) {
  assert.equal(h.controller.setMode(mode), true, mode + ' must accept boarding');
  h.advance(0.4);
  assert.equal(h.controller.occupant.state, 'seated', mode + ' boarding must finish within 0.4 s');
}

test('boarding walks into the car seat and never keeps the old idle walk', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  assert.ok(h.exportedStates, 'controllers.js must export OCCUPANT_STATES');
  assert.deepEqual(Object.values(h.OCCUPANT_STATES).sort(), ['alighting', 'boarding', 'seated', 'walking']);
  assert.equal(h.controller.occupant.state, 'walking');
  assert.equal(h.controller.occupant.mode, null);
  assert.equal(h.controller.setMode('car'), true);
  assert.equal(h.controller.activeMode, 'car');
  assert.equal(h.controller.occupant.state, 'boarding');
  assert.equal(h.controller.occupant.mode, 'car');

  h.controller.keys.forward = true;
  let sawBoarding = false, sawSeated = false, maxDrift = 0;
  for (let i = 0; i < 60; i++) {
    h.controller.update(1 / 60, i / 60);
    if (h.controller.occupant.state === 'boarding') sawBoarding = true;
    if (h.controller.occupant.state === 'seated') sawSeated = true;
    maxDrift = Math.max(maxDrift, h.person.position.distanceTo(seatWorld(h.car)));
  }
  assert.equal(sawBoarding, true, 'boarding is a visible transition state');
  assert.equal(sawSeated, true, 'boating completes within one second');
  assert.ok(maxDrift < 1e-6, 'seated person stays in the seat instead of walking away: ' + maxDrift);
});

test('seated person follows a moving and rotating car seat', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  boardAndSit(h, 'car');
  for (const [x, z, heading] of [[3.5, -2, 0.7], [-8, 6, 2.1], [1, 4, -1.3]]) {
    h.car.position.x = x;
    h.car.position.z = z;
    h.car.heading = heading;
    h.controller.update(1 / 60, 1);
    assert.equal(h.controller.occupant.state, 'seated');
    assert.ok(h.person.position.distanceTo(seatWorld(h.car)) < 1e-6,
      'person.position must equal the seat world point after translate/rotate');
  }
});

test('car driving input is ignored while boarding and accepted once seated', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  assert.equal(h.controller.setMode('car'), true);
  h.controller.keys.forward = true;
  const start = h.car.position.clone();
  for (let i = 0; i < 6; i++) h.controller.update(1 / 60, i / 60);
  assert.equal(h.controller.occupant.state, 'boarding');
  assert.equal(h.car.speed, 0, 'the car must not drive during the boarding transition');
  assert.ok(h.car.position.distanceTo(start) < 1e-9);
  h.advance(0.3);
  assert.equal(h.controller.occupant.state, 'seated');
  const speedBefore = h.car.speed;
  h.advance(0.5);
  assert.ok(h.car.speed > speedBefore + 1, 'seated driver input accelerates the car');
  assert.ok(h.car.position.distanceTo(start) > 0.1, 'the accepted input moves the car forward');
});

test('mode changes share one position and render one player model', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  h.person.position.set(8, 0, -6);
  h.person.heading = 0.43;
  for (const mode of ['car', 'cyclist', 'helicopter', 'person']) {
    assert.equal(h.controller.setMode(mode), true);
    const active = h.controller.getActiveEntity();
    assert.equal(active.position.x, 8);
    assert.equal(active.position.z, -6);
    assert.equal(active.heading, 0.43);
    assert.equal(active.position.y, mode === 'helicopter' ? 200 : 0);
    assert.deepEqual(Object.entries(h.controller.entities).filter(([, e]) => e.mesh.visible).map(([key]) => key), [mode]);
    assert.equal(h.cyclist.helmet.visible, mode === 'cyclist');
  }
  assert.ok(h.rideCalls.length > 0, 'cycling reuses the player rig');
  assert.equal(h.person.rig, h.rig);
});

test('returning from flight at the same spot preserves the departure surface', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  const ground = h.person._support;
  h.controller.surfaceResolver.below = (_x, _z, y) => y >= 5 ? { height: 5, surfaceId: 'bridge' } : ground;
  assert.equal(h.controller.setMode('helicopter'), true);
  assert.equal(h.helicopter.position.y, 200);
  assert.equal(h.controller.setMode('person'), true);
  assert.equal(h.person._support.surfaceId, 'terrain');
  assert.equal(h.person.position.y, 0);
});

test('a blocked destination keeps the active mode and position', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  boardAndSit(h, 'helicopter');
  h.helicopter.position.set(4, 20, -3);
  const check = () => {
    assert.equal(h.controller.setMode('person'), false);
    assert.equal(h.controller.activeMode, 'helicopter');
    assert.deepEqual(h.helicopter.position.toArray(), [4, 20, -3]);
  };
  h.state.water = () => true;
  check();
  h.state.water = () => false;
  h.state.traffic = () => [{ minX: 3, maxX: 5, minY: 0, maxY: 2, minZ: -4, maxZ: -2 }];
  check();
  h.state.traffic = () => [];
  assert.equal(h.controller.setMode('person'), true);
  assert.deepEqual(h.person.position.toArray(), [4, 0, -3]);
});

test('blocked flight switches to the nearest flat road with clearance for the requested mode', { skip }, async () => {
  const THREE = await threeReady;
  const heading = Math.PI / 2;
  const ground = x => {
    if (x < 1) return null;
    if (Math.abs(x - 10) < 3) return 8 + (x - 10) * 0.18;
    return 8;
  };
  for (const mode of ['person', 'car', 'cyclist']) {
    const h = createHarness(THREE, {
      water: x => x < 0,
      roads: [50, 40, 30, 20, 10].map(x => ({ x, y: 2, z: 0, heading })),
      traffic: () => [{ minX: 17, maxX: 23, minY: 8, maxY: 10, minZ: -1, maxZ: 1 }],
      ground: (x, z) => x === 0 && z === 0 ? 0 : ground(x),
      roadHeight: (x, z) => Math.abs(x - 30) < 3 && Math.hypot(x - 30, z) > 0.3 ? null : ground(x)
    });
    boardAndSit(h, 'helicopter');
    h.helicopter.position.set(-1, 200, 0);
    h.helicopter.speed = 40;
    assert.equal(h.controller.setMode(mode), true, mode);
    const active = h.controller.getActiveEntity();
    assert.deepEqual(active.position.toArray(), [40, 8, 0]);
    assert.equal(active.heading, heading);
    assert.equal(active.speed, 0);
    assert.equal(active._support.surfaceId, 'terrain');
    assert.equal(h.helicopter.mesh.visible, false);
  }
});

test('airborne boarding hides the pilot and the seat follows tiltPivot', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  assert.equal(h.controller.setMode('helicopter'), true);
  assert.deepEqual(h.pilotCalls, [false], 'the built-in pilot is hidden through setOccupantVisible(false)');
  h.advance(1);
  assert.equal(h.controller.occupant.state, 'seated');
  assert.ok(h.person.position.distanceTo(seatWorld(h.helicopter)) < 1e-6);
  // 离地后俯仰/横滚只体现在 tiltPivot 上，坐姿必须跟着倾斜后的座舱走。
  h.helicopter.position.y = 40;
  h.helicopter.pitchAngle = 0.25;
  h.helicopter.rollAngle = -0.18;
  h.helicopter.verticalSpeed = 0;
  h.helicopter.speed = 0;
  h.controller.update(1 / 60, 2);
  assert.ok(Math.abs(h.helicopter.tiltPivot.rotation.x) > 0.05, 'airborne pitch tilts the cockpit pivot');
  assert.ok(h.person.position.distanceTo(seatWorld(h.helicopter)) < 1e-6,
    'the seated pose follows the tilted cockpit transform');
  assert.ok(h.person.position.y > h.helicopter.position.y + 0.3, 'the seat is not the plain vehicle position');
});

test('entering the manual aircraft turns for one second before accepting forward thrust', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  assert.equal(h.controller.setMode('helicopter'), true);
  const aircraft = h.helicopter;
  const heading = aircraft.heading;
  const at = aircraft.position.clone();
  assert.ok(Math.abs(aircraft.mesh.rotation.y - heading - Math.PI / 4) < 1e-8);
  h.controller.keys.forward = true;
  h.advance(0.5);
  assert.ok(Math.abs(aircraft.mesh.rotation.y - heading - Math.PI / 8) < 1e-8);
  assert.ok(aircraft.position.distanceTo(at) < 1e-8);
  h.advance(0.5);
  assert.ok(Math.abs(aircraft.mesh.rotation.y - heading) < 1e-8);
  assert.ok(Math.abs(aircraft.speed) < 1e-8);
  h.advance(1);
  assert.ok(Math.abs(aircraft.speed * 3.6 - 200) < 0.01);
});

test('repeated mode switching keeps one pedestrian rig and never walks while seated', { skip }, async () => {
  const THREE = await threeReady;
  const h = createHarness(THREE);
  boardAndSit(h, 'car');
  assert.ok(h.person.position.distanceTo(seatWorld(h.car)) < 1e-6);
  h.car.speed = 0;
  assert.equal(h.controller.setMode('person'), true);
  h.advance(0.4);
  assert.equal(h.controller.occupant.state, 'walking');
  assert.equal(h.person.rig, h.rig);
  assert.equal(h.controller.setMode('cyclist'), true);
  h.advance(0.4);
  assert.equal(h.controller.occupant.state, 'seated');
  assert.equal(h.person.rig, h.rig, 'the same single person rig is reused');
  h.cyclist.speed = 0;
  assert.equal(h.controller.setMode('person'), true);
  h.advance(0.4);
  assert.equal(h.controller.occupant.state, 'walking');
  h.controller.keys.forward = true;
  const from = h.person.position.clone();
  h.advance(0.5);
  assert.ok(h.person.position.distanceTo(from) > 0.5, 'walking resumes without a second drifting clone');
  assert.equal(h.person.rig, h.rig);
  assert.equal(h.controller.entities.person.rig, h.rig);
  assert.ok(h.person.crowd.adds.every(([added]) => added === h.rig), 'only the single person rig is rendered');
  assert.equal(h.person.mesh.visible, true);
});
