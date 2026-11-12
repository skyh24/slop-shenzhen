import * as THREE from 'three/webgpu';
import { ISLAND_BOUNDS, isTypingInField, SPAWN_POINT, terrainHeight, findGroundArrival, isWater } from './sz-city-config.js';
import { createSurfaceResolver } from './sz-controller-surfaces.js';
import { findParkArrival } from './sz-park-arrivals.js';
import { STR } from './sz-strings.js';
import { cityUniforms, createContactShadowMaterial } from './city-lighting-materials.js';
import { VEHICLE_SPECS, createShenzhenCarMesh, createSharedCycleMesh, createEvtolMesh } from './sz-vehicles.js';
import { PersonCrowd, PersonRig, PERSON_BONES } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { loftContactPolygon, polygonContact, roofPanelContactPolygon, spanContactPolygon } from './building-collision.js';

// Player models, animation and movement for walking, driving, cycling and flying.

// 出生候选来自真实源道路；构造时还要用显示地面和碰撞体复核。
const groundCollider = { type: 'ground' };

const CAR_DRIVE = {
  speed: 80 / 3.6, boostSpeed: 120 / 3.6, reverseSpeed: 10.5, acceleration: 4.5,
  forwardAcceleration: 80 / 3.6 / 4, boostAcceleration: 120 / 3.6 / 4,
  // 松开 Shift 后主动回落到常规上限，避免长时间停在 120 km/h。
  boostDeceleration: 4,
  powerSpeed: 14.5, // Above 52 km/h, engine power limits acceleration.
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9,
  wheelbase: VEHICLE_SPECS.taxi.wheelbase, grip: 9.5, cornering: 10.5
};
const CAR_BOOST_DRIVE = { ...CAR_DRIVE, speed: CAR_DRIVE.boostSpeed, forwardAcceleration: CAR_DRIVE.boostAcceleration };
const BICYCLE_DRIVE = {
  speed: 60 / 3.6, reverseSpeed: 4.5, acceleration: 6.5, forwardAcceleration: 60 / 3.6 / 4,
  powerSpeed: 10.5, // Above 38 km/h, rider power limits acceleration.
  rolling: 0.1, drag: 0.004, coast: 0.45, brake: 10.5
};
const CAR_AUTO_DRIVE = { ...CAR_DRIVE, speed: 36, forwardAcceleration: null };
// 2026-11-11 用户指定升降上限 20 m/s、2 秒加速到位，因此垂直加速度取 10 m/s²。
const EVTOL_DRIVE = {
  speed: 500 / 3.6, acceleration: 500 / 3.6 / 4, reverseSpeed: 21.6,
  verticalSpeed: 20, verticalAcceleration: 10, altitude: 400
};
const PERSON_STEP_UP = 0.38;
const CONTACT_EPSILON = 1e-5;

// 同一角色只有一套上下车状态：步行 → 上车过渡 → 乘坐 → 下车过渡 → 步行。
const OCCUPANT_STATES = Object.freeze({ WALKING: 'walking', BOARDING: 'boarding', SEATED: 'seated', ALIGHTING: 'alighting' });
const BOARDING_SECONDS = 0.35;
const ALIGHTING_SECONDS = 0.3;
const FLIGHT_START_ALTITUDE = 200;
const FLIGHT_START_CLEARANCE = 12;
// 坐姿手臂 IK 的下段长度沿用 pedestrians.js ride() 的 FOREARM + 0.07，
// 让手能落到方向盘/操纵台抓握点，不另造一套骨架常量。
const SEAT_ARM_LOWER = 0.325;
// 坐姿解算的临时向量/四元数按需创建：控制器模块在没有 THREE 的单元测试里也能加载。
let _seatScratch = null;
function seatScratch() {
  if (!_seatScratch) {
    _seatScratch = {
      matrix: new THREE.Matrix4(), rootQuat: new THREE.Quaternion(), pelvisQuat: new THREE.Quaternion(),
      chestQuat: new THREE.Quaternion(), footQuat: new THREE.Quaternion(), tilt: new THREE.Quaternion(),
      axisX: new THREE.Vector3(1, 0, 0), world: new THREE.Vector3(), pelvis: new THREE.Vector3(),
      chest: new THREE.Vector3(), head: new THREE.Vector3(), hip: new THREE.Vector3(), ankle: new THREE.Vector3(),
      shoulder: new THREE.Vector3(), target: new THREE.Vector3(), pole: new THREE.Vector3(), front: new THREE.Vector3()
    };
  }
  return _seatScratch;
}
function seatTilt(scratch, angle, out) {
  return out.setFromAxisAngle(scratch.axisX, angle);
}

function driveSpeed(speed, throttle, dt, drive, serviceBrake = 0) {
  // Turning can project tiny sideways motion back into speed after braking to zero.
  // Treat a crawl as stopped when changing direction, so this cannot hold the brakes forever.
  if (speed * throttle < 0 && Math.abs(speed) < 0.05) speed = 0;
  const braking = speed * throttle < 0;
  const brakeStrength = serviceBrake || (braking ? Math.abs(throttle) : 0);
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (brakeStrength ? brakeStrength * drive.brake : !throttle ? drive.coast : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || brakeStrength) return Math.sign(speed) * coasting;

  // 玩家正向全油门按净加速度在4秒达速；松键、制动和倒车仍使用原阻力。
  if (throttle > 0 && drive.forwardAcceleration) {
    return Math.min(Math.max(drive.speed, coasting), magnitude + throttle * drive.forwardAcceleration * dt);
  }
  const limit = throttle < 0 ? drive.reverseSpeed : drive.speed;
  let acceleration = drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  // Collision momentum above the powered limit decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
// 脚部越过数据边缘时沿用最近接触面，仅供姿态求解；移动仍拒绝未知地面。
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person')
  ?? controllers.entities.person._support.height;

function collisionBody(mode, radius, heading, margin = 0, bounds = null) {
  // 建筑的快速接触检测沿用同一套定向矩形，尺寸取自模型及旋翼扫掠。
  const car = Boolean(bounds) || mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = (bounds ? Math.max(-bounds.min.x, bounds.max.x) : 0.86) + margin;
  const hz = (bounds ? Math.max(-bounds.min.z, bounds.max.z) : 2.18) + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: bounds?.min.y ?? (mode === 'helicopter' ? -0.25 : 0),
    top: bounds?.max.y ?? (mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9)
  };
}

// 运动和传送共用脚印碰撞。人物使用圆，车辆和飞行器使用从模型提取的定向矩形。
function buildingContact(c, x, y, z, body, contact) {
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  if (c.polygon) {
    const bottom = y + body.bottom;
    const top = y + body.top;
    let polygon = c.polygon;
    if (c.loft) polygon = loftContactPolygon(c.loft, bottom, top);
    else if (c.roofPanel) polygon = roofPanelContactPolygon(c.roofPanel, bottom, top);
    else if (c.verticalSpan) polygon = spanContactPolygon(polygon, c.verticalSpan, bottom, top);
    return polygon !== null && polygonContact(polygon, x, z, body, contact);
  }
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = [], options = {}) {
    this.groundHeight = options.groundHeight ?? terrainHeight;
    this.surfaceResolver = createSurfaceResolver({ groundHeight: this.groundHeight, surfaces: options.surfaces ?? [] });
    this.nearTraffic = options.nearTraffic;
    this.spawnPoint = options.spawnPoint ?? SPAWN_POINT;
    if (!this.spawnPoint) throw new Error('No sourced ground spawn is available');
    this.maxFlightAltitude = options.maxFlightAltitude ?? EVTOL_DRIVE.altitude;
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.activeMode = 'person'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false,
      brake: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };
    // 乘员状态：activeMode 是当前被控制的对象，occupant 记录同一玩家角色坐在哪辆载具里。
    this.occupant = { state: OCCUPANT_STATES.WALKING, mode: null, timer: 0 };

    this.initializeArrivals();

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicMaterial &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC'],
      boost: ['ShiftLeft', 'ShiftRight'],
      brake: ['Space']
    };
    // Space 同时承担跳跃/上升和汽车刹车，一个键可以对应多个动作。
    const actionsByCode = new Map();
    for (const [action, codes] of Object.entries(bindings)) {
      for (const code of codes) {
        const list = actionsByCode.get(code);
        if (list) list.push(action);
        else actionsByCode.set(code, [action]);
      }
    }
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const actions = actionsByCode.get(e.code);
      if (!actions || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      for (const action of actions) {
        this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
        this._blendInput(action);
      }
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  isOccupantBound() {
    return Boolean(this.occupant?.mode)
      && (this.occupant.state === OCCUPANT_STATES.BOARDING || this.occupant.state === OCCUPANT_STATES.SEATED);
  }

  // 模式切换复用当前位置；只有地图传送和存档恢复会传入已核验的目的地。
  setMode(mode, destination = null) {
    if (!Object.hasOwn(this.entities, mode)) return false;
    const previous = this.activeMode;
    if (mode === previous && !destination) {
      this._applyModeVisibility();
      return true;
    }
    const point = destination ?? this.findModePosition(mode);
    if (!point) return false;

    this.activeMode = mode;
    this.occupant = mode === 'person'
      ? { state: destination ? OCCUPANT_STATES.WALKING : OCCUPANT_STATES.ALIGHTING,
        mode: null, timer: destination ? 0 : ALIGHTING_SECONDS }
      : { state: destination ? OCCUPANT_STATES.SEATED : OCCUPANT_STATES.BOARDING,
        mode, timer: destination ? 0 : BOARDING_SECONDS };
    this._applyModeVisibility();
    this._placeActiveAt(point, point.heading);
    return true;
  }

  findModePosition(mode, active = this.getActiveEntity()) {
    const { x, y, z } = active.position;
    const { heading } = active;
    const flying = mode === 'helicopter';
    const body = collisionBody(mode, flying ? 4.5 : mode === 'cyclist' ? 1 : 0.48,
      heading, 0.05, this.entities[mode].collisionBounds);
    const takeoff = active.takeoff;
    const sameTakeoffPoint = takeoff && Math.hypot(x - takeoff.x, z - takeoff.z) < 0.001;
    const previous = (sameTakeoffPoint ? takeoff.support : active._support)
      ?? this.surfaceResolver.below(x, z, y + (active.type === 'helicopter' ? active.collisionBounds?.min.y ?? 0 : 0) + 0.05);
    let height;
    let surfaceId;
    if (flying) {
      const altitude = active.type === 'helicopter' ? y : FLIGHT_START_ALTITUDE;
      const floor = previous?.height;
      height = Math.min(this.maxFlightAltitude, Number.isFinite(floor) ? Math.max(altitude, floor + FLIGHT_START_CLEARANCE) : altitude);
      if (height + body.bottom <= (floor ?? -Infinity)) return null;
    } else {
      if (!previous || (previous.surfaceId === 'terrain' && isWater(x, z) !== false)) return null;
      const support = this.supportedFootprint(x, z, body, { _support: previous });
      if (!support || Math.abs(support.height - previous.height) > CONTACT_EPSILON) return null;
      height = support.height;
      surfaceId = support.surfaceId;
    }
    const reach = Math.max(body.extX, body.extZ);
    if (this.nearColliders(x, z, reach).some(c => buildingContact(c, x, height, z, body))) return null;
    return { x, y: height, z, heading, surfaceId,
      takeoff: flying && active.type !== 'helicopter' && previous ? { x, z, support: previous } : null };
  }

  _applyModeVisibility() {
    for (const [mode, entity] of Object.entries(this.entities)) {
      if (entity.mesh) entity.mesh.visible = mode === this.activeMode;
      if (entity.helmet) entity.helmet.visible = false;
    }
    if (this.activeMode !== 'car') this.entities.car?.setLights?.(false, false);
    this.entities.helicopter?.setOccupantVisible?.(false);
  }

  _occupantRoot(vehicle) {
    if (vehicle.type === 'car') return vehicle.chassisPivot ?? vehicle.mesh;
    if (vehicle.type === 'cyclist') return vehicle.leanPivot ?? vehicle.mesh;
    return vehicle.tiltPivot ?? vehicle.mesh;
  }

  _syncOccupant() {
    const person = this.entities.person;
    if (!person) return;
    if (!this.isOccupantBound()) return;
    const vehicle = this.entities[this.occupant.mode];
    if (!vehicle) return;
    const root = this._occupantRoot(vehicle);
    if (!root) return;
    const rig = person.rig;
    if (typeof root.updateWorldMatrix === 'function') root.updateWorldMatrix(true, false);
    if (person.shadow) person.shadow.visible = false;
    person.speed = 0;
    person.verticalVel = 0;
    if (this.occupant.mode === 'cyclist' && vehicle.bikeFrame && typeof rig?.ride === 'function') {
      // 自行车复用 PersonRig.ride：同一个玩家角色坐到座垫、双手扶把、双脚随脚踏。
      rig.ride(root, vehicle.pedalPhase ?? 0, vehicle.bikeFrame);
      if (vehicle.helmet) {
        vehicle.helmet.visible = true;
        vehicle.helmet.quaternion.copy(rig.headQuaternion);
        vehicle.helmet.position.set(0, 0.175, -0.012).applyQuaternion(rig.headQuaternion).add(rig.headPosition);
      }
      person.position.copy(vehicle.position);
      person.heading = vehicle.heading;
    } else if (vehicle.seat && typeof rig?.writeBone === 'function' && rig.bind) {
      const scratch = seatScratch();
      scratch.matrix.copy(root.matrixWorld);
      this._poseSeated(rig, scratch.matrix, vehicle.seat, vehicle.heading);
      scratch.world.copy(vehicle.seat.pelvis).applyMatrix4(scratch.matrix);
      person.position.copy(scratch.world);
      person.heading = vehicle.heading;
    } else {
      person.position.copy(vehicle.position);
      person.heading = vehicle.heading;
    }
    if (!rig) return;
    rig.placed = true;
    rig.x = person.position.x;
    rig.z = person.position.z;
    rig.yaw = person.heading;
    rig.speed = 0;
    rig.gait = 0;
    person._safePosition = { x: person.position.x, y: person.position.y, z: person.position.z };
    person.crowd.begin();
    person.crowd.add(rig, 0);
    person.crowd.end();
  }

  // 坐姿：骨盆落在座垫上，胸、头、腿、手都按载具世界矩阵解算，因此随车身/座舱俯仰和转向一起动。
  _poseSeated(rig, matrix, seat, heading) {
    const s = rig.s ?? 1;
    const bones = PERSON_BONES;
    const c = seatScratch();
    seatTilt(c, -(seat.recline ?? 0.1), c.pelvisQuat);
    c.rootQuat.setFromRotationMatrix(matrix);
    c.pelvisQuat.premultiply(c.rootQuat);
    c.world.copy(seat.pelvis).applyMatrix4(matrix);
    c.pelvis.copy(c.world);
    rig.writeBone(bones.PELVIS, c.pelvisQuat, c.pelvis);
    seatTilt(c, 0.08, c.chestQuat);
    c.chestQuat.premultiply(c.pelvisQuat);
    rig.jointFrom(bones.PELVIS, bones.CHEST, c.pelvisQuat, c.pelvis, c.chest);
    rig.writeBone(bones.CHEST, c.chestQuat, c.chest);
    seatTilt(c, -0.02, c.tilt);
    c.tilt.premultiply(c.rootQuat);
    rig.jointFrom(bones.CHEST, bones.HEAD, c.chestQuat, c.chest, c.head);
    rig.writeBone(bones.HEAD, c.tilt, c.head);
    // 腿：脚踝落到脚部空间，膝盖自然向前上方折起。
    seatTilt(c, 0.12, c.footQuat);
    c.footQuat.premultiply(c.rootQuat);
    for (let i = 0; i < 2; i++) {
      rig.jointFrom(bones.PELVIS, i === 0 ? bones.THIGH_L : bones.THIGH_R, c.pelvisQuat, c.pelvis, c.hip);
      c.ankle.copy(seat.feet[i]).applyMatrix4(matrix);
      const ankle = rig.solveLeg(i, c.hip, c.ankle, heading);
      rig.writeFoot(i, ankle, c.footQuat, 0);
    }
    // 手：两段 IK 落到方向盘/操纵台抓握点。上臂长度从 bind 骨架量出，下段见 SEAT_ARM_LOWER。
    const upper = Math.hypot(
      rig.bind[bones.FOREARM_L].x - rig.bind[bones.UPPER_ARM_L].x,
      rig.bind[bones.FOREARM_L].y - rig.bind[bones.UPPER_ARM_L].y,
      rig.bind[bones.FOREARM_L].z - rig.bind[bones.UPPER_ARM_L].z) * s;
    const armBind = Math.atan2(Math.abs(rig.bind[bones.FOREARM_L].x - rig.bind[bones.UPPER_ARM_L].x),
      -(rig.bind[bones.FOREARM_L].y - rig.bind[bones.UPPER_ARM_L].y));
    c.front.set(0, 0, 1).applyQuaternion(c.rootQuat);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const upperArm = i === 0 ? bones.UPPER_ARM_L : bones.UPPER_ARM_R;
      const forearm = i === 0 ? bones.FOREARM_L : bones.FOREARM_R;
      rig.jointFrom(bones.CHEST, upperArm, c.chestQuat, c.chest, c.shoulder);
      c.target.copy(seat.hands[i]).applyMatrix4(matrix);
      c.pole.set(side * 0.7, -1, -0.25).applyQuaternion(c.rootQuat).normalize();
      rig.limb(upperArm, forearm, c.shoulder, c.target, upper, SEAT_ARM_LOWER * s, c.pole, c.front, side * armBind);
    }
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null, { requireArrival = false, park = null, exact = false } = {}) {
    const ent = this.getActiveEntity();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(this.maxFlightAltitude, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude, requireArrival || exact, park, { exact });
    if ((requireArrival || exact) && !destination) return null;
    this.resetInput();
    // 传送与正常上下车保持同一乘员状态：传送到人物时就是步行，传送到载具时人仍在座位上。
    if (this.activeMode === 'person') {
      this.occupant = { state: OCCUPANT_STATES.WALKING, mode: null, timer: 0 };
      if (ent.shadow) ent.shadow.visible = true;
    } else if (this.occupant?.mode !== this.activeMode) {
      this.occupant = { state: OCCUPANT_STATES.SEATED, mode: this.activeMode, timer: 0 };
    }
    if (destination) this._placeActiveAt(destination,
      (requireArrival || exact) && Number.isFinite(destination.heading) ? destination.heading : heading);
    else this._placeActiveAt(ent.position, ent.heading, ent._support);
    const point = { x: ent.position.x, z: ent.position.z };
    if (destination?.parkAreaId) point.parkAreaId = destination.parkAreaId;
    return point;
  }

  _placeActiveAt(point, heading, support = null) {
    const ent = this.getActiveEntity();
    const heli = this.activeMode === 'helicopter';
    ent.position.x = point.x;
    ent.position.y = point.y;
    ent.position.z = point.z;
    ent.heading = heading;
    ent._support = heli ? null : support ?? { height: point.y, surfaceId: point.surfaceId ?? 'terrain' };
    ent._safePosition = { x: point.x, y: point.y, z: point.z };
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.jumping = false;
      ent.jumpPrep = 0;
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      if (ent.shadow) {
        ent.shadow.position.y = 0.02;
        ent.shadow.scale.set(1, 1, 1);
      }
      if (ent.mesh) ent.mesh.visible = true;
      if (typeof ent.rig?.reset === 'function') {
        ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
        ent.crowd.begin();
        ent.crowd.add(ent.rig, 0);
        ent.crowd.end();
      }
    } else if (this.activeMode === 'car') {
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      ent.setLights?.(false, false);
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
      ent._brakeHold = 0;
    } else if (heli) {
      ent.takeoff = point.takeoff ?? null;
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    if (this.isOccupantBound()) {
      if (typeof ent.mesh.updateMatrixWorld === 'function') ent.mesh.updateMatrixWorld(true);
      this._syncOccupant();
    }
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude, requireArrival = false, park = null, { exact = false, mode = this.activeMode } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = mode === 'helicopter';
    const radius = heli ? 4.5 : mode === 'person' ? 0.48 : 0.65;
    const margin = heli && !requireArrival ? 6000 : 0;
    const entity = this.entities[mode];
    const requestedShape = collisionBody(mode, radius, heading, 0.1, entity.collisionBounds);
    const clampPoint = (px, pz) => ({
      x: Math.max(ISLAND_BOUNDS.minX - margin, Math.min(ISLAND_BOUNDS.maxX + margin, px)),
      z: Math.max(ISLAND_BOUNDS.minZ - margin, Math.min(ISLAND_BOUNDS.maxZ + margin, pz))
    });
    const clear = (p) => {
      if (!p) return false;
      const shape = requireArrival && !heli && Number.isFinite(p.heading)
        ? collisionBody(mode, radius, p.heading, 0.1, entity.collisionBounds)
        : requestedShape;
      const reach = Math.max(shape.extX, shape.extZ);
      const support = heli ? null : this.supportedFootprint(p.x, p.z, shape, null);
      let baseY = heli ? altitude : support?.height;
      if (requireArrival && heli) {
        const hx = shape.car ? shape.hx : shape.radius;
        const hz = shape.car ? shape.hz : shape.radius;
        for (const dx of [-hx, 0, hx]) {
          for (const dz of [-hz, 0, hz]) {
            const y = this.groundHeight(p.x + dx * shape.cos + dz * shape.sin, p.z - dx * shape.sin + dz * shape.cos);
            if (Number.isFinite(y)) baseY = Math.max(baseY, y - shape.bottom + 1);
          }
        }
        if (baseY > this.maxFlightAltitude) return false;
      }
      if (!Number.isFinite(baseY)) return false;
      p.y = baseY;
      if (support) p.surfaceId = support.surfaceId;
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    if (exact) {
      const point = { x, z, heading };
      const clamped = clampPoint(x, z);
      return x === clamped.x && z === clamped.z && clear(point) ? point : null;
    }
    if (park) {
      return mode === 'person' ? findParkArrival({ x, z }, park, requestedShape.radius, clear) : null;
    }
    if (!heli) {
      const arrival = findGroundArrival({ x, z }, mode, { isClear: clear });
      if (!arrival) return null;
      const result = { ...arrival };
      return clear(result) ? result : null;
    }
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(ISLAND_BOUNDS.minX, Math.min(ISLAND_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(ISLAND_BOUNDS.minZ + 30, Math.min(ISLAND_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED NYC PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: STR.modeNames.person,
      mesh: root,
      shadow: pedShadow,
      crowd,
      rig,
      position: new THREE.Vector3(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z),
      prevX: this.spawnPoint.x,
      prevZ: this.spawnPoint.z,
      heading: 0,
      speed: 0,
      verticalVel: 0,
      jumping: false,
      jumpPrep: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  createCarEntity() {
    const model = createShenzhenCarMesh();
    const { group: root, chassis: chassisPivot, spec } = model;
    root.name = 'PlayerTaxiCar';

    const shadowGeometry = new THREE.PlaneGeometry(spec.width + 0.44, spec.length + 0.4);
    shadowGeometry.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(shadowGeometry, createContactShadowMaterial());
    carShadow.position.y = 0.02;
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [-1, 1].map(side => {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, { headlight: spec.headlight, zFront: spec.length / 2 }, side);
      chassisPivot.add(spot, spot.target);
      return spot;
    });
    this.scene.add(root);

    return {
      type: 'car',
      label: STR.modeNames.car,
      mesh: root,
      collisionBounds: model.bounds,
      chassisPivot,
      setLights: model.setLights,
      headLights,
      wheels: model.wheels,
      seat: model.seat,
      position: new THREE.Vector3(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z),
      prevX: this.spawnPoint.x,
      prevZ: this.spawnPoint.z,
      heading: 0,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';
    const model = createSharedCycleMesh({ color: 'yellow' });
    const { group: leanPivot, frontWheel, rearWheel, crankPivot, pedals, bikeFrame } = model;
    root.add(leanPivot);

    const riderRig = new PersonRig({ seed: 12.8, scale: 1, girth: 0.97, hair: 0.1 });
    const helmetMaterial = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb, emissive: 0x181c22, roughness: 0.22, metalness: 0.25
    });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMaterial);
    helmet.scale.set(0.95, 0.68, 1.28);
    riderRig.ride(leanPivot, 0, bikeFrame);
    const helmetCenter = new THREE.Vector3(0, 0.175, -0.012).applyQuaternion(riderRig.headQuaternion).add(riderRig.headPosition);
    const collisionBounds = model.bounds.clone();
    const helmetRadius = helmet.geometry.parameters.radius * Math.max(...helmet.scale.toArray());
    collisionBounds.max.y = Math.max(collisionBounds.max.y, helmetCenter.y + helmetRadius);
    this.scene.add(helmet);

    const shadowGeometry = new THREE.PlaneGeometry(0.85, 2.25);
    shadowGeometry.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(shadowGeometry, createContactShadowMaterial());
    bikeShadow.position.y = 0.02;
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 0.819, 0.724);
    headLight.target.position.set(0, 0, 7.6);
    leanPivot.add(headLight, headLight.target);
    this.scene.add(root);

    return {
      type: 'cyclist',
      label: STR.modeNames.cyclist,
      mesh: root,
      collisionBounds,
      leanPivot,
      frontWheel,
      rearWheel,
      wheelRadius: model.radius,
      crankPivot,
      pedals,
      bikeFrame,
      helmet,
      headLight,
      position: new THREE.Vector3(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z),
      heading: 0,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerEvtol';
    const model = createEvtolMesh();
    root.add(model.group);
    this.scene.add(root);

    return {
      type: 'helicopter',
      label: STR.modeNames.helicopter,
      mesh: root,
      collisionBounds: model.bounds,
      tiltPivot: model.group,
      updateRotors: model.update,
      seat: model.seat,
      setOccupantVisible: model.setOccupantVisible,
      position: new THREE.Vector3(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z),
      heading: 0.62,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.26, 0),
      chaseDistance: 8.9,
      chaseHeight: 2.85
    };
  }

  initializeArrivals() {
    const arrival = this.findTeleportPosition(this.spawnPoint.x, this.spawnPoint.z, this.spawnPoint.heading ?? 0, 0, true);
    if (!arrival) throw new Error('No clear sourced arrival for the player');
    this._applyModeVisibility();
    this._placeActiveAt(arrival, arrival.heading);
  }

  isPointOnSidewalk() { return false; }

  getGroundHeight(x, z, mode = 'person') {
    const entity = this.entities?.[mode];
    const support = entity?._support;
    return this.surfaceResolver.resolve(x, z, {
      previousY: support?.height ?? null, previousSurfaceId: support?.surfaceId ?? null
    })?.height ?? null;
  }

  supportedFootprint(x, z, body, entity) {
    const previous = entity?._support;
    const options = { previousY: previous?.height ?? null, previousSurfaceId: previous?.surfaceId ?? null };
    const center = this.surfaceResolver.resolve(x, z, options);
    if (!center) return null;
    const halfX = body.car ? body.hx : body.extX, halfZ = body.car ? body.hz : body.extZ;
    const sin = body.car ? body.sin : 0, cos = body.car ? body.cos : 1;
    for (const dx of [-halfX, 0, halfX]) {
      for (const dz of [-halfZ, 0, halfZ]) {
        if (dx === 0 && dz === 0) continue;
        // 圆形脚印的对角采样沿圆周，矩形车身仍检查四角。
        const scale = !body.car && dx !== 0 && dz !== 0 ? Math.SQRT1_2 : 1;
        const offsetX = dx * scale, offsetZ = dz * scale;
        const support = this.surfaceResolver.resolve(x + offsetX * cos + offsetZ * sin, z - offsetX * sin + offsetZ * cos, options);
        if (!support || Math.abs(support.height - center.height) > 1.5) return null;
      }
    }
    return center;
  }

  // Static colliders within `r` of (x, z), kept in their original order and indexed once into 48 m cells.
  nearColliders(x, z, r, includeTraffic = true) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    if (includeTraffic && this.nearTraffic) out.push(...this.nearTraffic(x, z, r));
    return out;
  }

  isClearCarPose({ x, y, z, heading }) {
    const body = collisionBody('car', 1.35, heading, 0.05, this.entities.car.collisionBounds);
    const support = this.supportedFootprint(x, z, body, null);
    return Boolean(support && Math.abs(support.height - y) <= 0.26
      && !this.nearColliders(x, z, Math.max(body.extX, body.extZ), false)
        .some(c => buildingContact(c, x, support.height, z, body)));
  }

  personStep(pos, body, entity, near) {
    const previous = entity?._safePosition;
    const floor = entity?._support;
    if (!previous || !floor || entity.jumping || entity.jumpPrep > 0 || Math.abs(pos.y - floor.height) > 0.3) return null;
    const travel = Math.hypot(pos.x - previous.x, pos.z - previous.z);
    if (travel > 0.5 || (travel < 1e-7 && floor.surfaceId === 'terrain')) return null;
    const step = this.surfaceResolver.footing?.(pos.x, pos.z, body.radius,
      floor.height, Math.min(pos.y, floor.height) + PERSON_STEP_UP);
    if (!step) return null;
    const y = step.height + CONTACT_EPSILON;
    // 先在抬脚前后的位置用完整人物体核对净空和侧墙，再落脚到实际三角面。
    if (near.some(c => buildingContact(c, pos.x, y, pos.z, body)
      || buildingContact(c, previous.x, y, previous.z, body))) return null;
    return step;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    const mode = entity?.type || this.activeMode;
    const heli = mode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(ISLAND_BOUNDS.minX - m, Math.min(ISLAND_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(ISLAND_BOUNDS.minZ - m, Math.min(ISLAND_BOUNDS.maxZ + m, pos.z));
    const modelEntity = entity ?? this.entities?.[mode];
    const body = collisionBody(mode, radius, modelEntity?.heading ?? 0, 0, modelEntity?.collisionBounds);
    const restore = () => {
      const previous = entity?._safePosition;
      if (previous) { pos.x = previous.x; pos.z = previous.z; }
      if (entity) entity.speed = 0;
    };
    if (!heli) {
      const previous = entity?._safePosition ?? { x: entity?.prevX ?? pos.x, z: entity?.prevZ ?? pos.z };
      const steps = Math.ceil(Math.hypot(pos.x - previous.x, pos.z - previous.z) / 0.5);
      if (steps > 256) { restore(); return; }
      for (let step = 0; step <= steps; step++) {
        const t = steps ? step / steps : 1;
        if (!this.supportedFootprint(previous.x + (pos.x - previous.x) * t,
          previous.z + (pos.z - previous.z) * t, body, entity)) { restore(); return; }
      }
    }
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    if (mode === 'person') {
      const step = this.personStep(pos, body, entity, near);
      if (step) {
        pos.y = step.height;
        entity._support = step;
        entity._safePosition = { x: pos.x, y: pos.y, z: pos.z };
        return;
      }
    }
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = body.car ? Math.abs(nx * body.cos - nz * body.sin) * body.hx + Math.abs(nx * body.sin + nz * body.cos) * body.hz : radius;
          this.reportCollision(entity, c, c.type === 'vehicle' ? 'vehicle' : 'building',
            pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: pos.y + 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
    if (!heli) {
      const support = this.supportedFootprint(pos.x, pos.z, body, entity);
      if (!support) { restore(); return; }
      if (entity) entity._support = support;
    }
    if (entity) entity._safePosition = { x: pos.x, y: pos.y, z: pos.z };
  }

  poseCharacters(dt) {
    if (this.isOccupantBound()) return;
    const p = this.entities.person;
    if (!p) return;
    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
    if (!Number.isFinite(groundY)) return;
    const air = p.position.y - groundY;
    const jumpAir = p.jumping ? Math.max(0.006, air) : p.jumpPrep > 0 ? -(1 - p.jumpPrep / 0.085) : air > 0.3 ? air : 0;
    if (p.shadow) {
      p.shadow.position.y = groundY - p.position.y + 0.02;
      const scale = Math.max(0.45, 1 - Math.max(0, jumpAir) * 0.35);
      p.shadow.scale.set(scale, scale, 1);
    }
    p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, jumpAir);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();
  }

  update(dt, elapsed, driveInput = null) {
    if (this.activeMode === 'person') {
      if (this.occupant.state === OCCUPANT_STATES.ALIGHTING) {
        // 下车过渡：人物已经站到安全落点，短暂停住再交回步行输入。
        this.occupant.timer = Math.max(0, this.occupant.timer - dt);
        this.entities.person.speed = 0;
        if (this.occupant.timer === 0) this.occupant.state = OCCUPANT_STATES.WALKING;
      } else {
        this.updatePerson(dt, elapsed);
      }
    } else if (this.occupant.state === OCCUPANT_STATES.BOARDING) {
      // 上车过渡：载具保持静止、不接受驾驶输入；乘员已经绑定在座位上。
      this.occupant.timer = Math.max(0, this.occupant.timer - dt);
      if (this.occupant.timer === 0) this.occupant.state = OCCUPANT_STATES.SEATED;
    } else if (this.activeMode === 'car') {
      this.updateCar(dt, driveInput);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt);
    }
    const active = this.getActiveEntity();
    if (active.type === 'helicopter') {
      const climb = Math.max(0, active.verticalSpeed) / EVTOL_DRIVE.verticalSpeed;
      const cruise = Math.abs(active.speed) / EVTOL_DRIVE.speed;
      active.updateRotors(dt, 0.57 + 0.32 * climb + 0.11 * cruise);
    }
    active.mesh.position.copy(active.position);
    active.mesh.rotation.y = active.heading;
    // 载具世界矩阵更新后再把同一角色写到座位上，坐姿因此跟着车身/座舱一起平移、转向和俯仰。
    this._syncOccupant();

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car?.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = this.activeMode === 'car' ? HEADLIGHTS.intensity * beamScale : 0;
      }
    }
    const bike = this.entities.cyclist;
    if (bike?.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    if (dt <= 0) return;
    const p = this.entities.person;
    const maxSpeed = 8.2;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxSpeed * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxSpeed * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    const accelerating = Math.abs(targetSpeed) > Math.abs(p.speed) && p.speed * targetSpeed >= 0;
    const acceleration = accelerating ? 5.5 * Math.abs(targetSpeed) / maxSpeed : 12;
    p.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, targetSpeed - p.speed));

    const prevX = p.position.x;
    const prevZ = p.position.z;
    p.prevX = prevX;
    p.prevZ = prevZ;
    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);
    const nextX = prevX + sinH * p.speed * dt;
    const nextZ = prevZ + cosH * p.speed * dt;
    p.position.x = nextX;
    p.position.z = nextZ;
    this.resolveHorizontalCollision(p.position, 0.48, null, p);

    // Prevent phantom speed buildup when blocked head-on by a building or shoreline boundary
    if (Math.abs(p.position.x - nextX) > 1e-6 || Math.abs(p.position.z - nextZ) > 1e-6) {
      const actualFwd = ((p.position.x - prevX) * sinH + (p.position.z - prevZ) * cosH) / dt;
      if (p.speed > 0 && actualFwd < p.speed) p.speed = Math.max(0, actualFwd);
      else if (p.speed < 0 && actualFwd > p.speed) p.speed = Math.min(0, actualFwd);
    }

    const groundY = p._support?.height ?? this.getGroundHeight(p.position.x, p.position.z, 'person');
    if (!Number.isFinite(groundY)) return;
    const JumpLeadTime = 0.085;
    if (this.keys.up && p.position.y <= groundY + 0.02 && !p.jumping && !(p.jumpPrep > 0)) {
      p.jumpPrep = JumpLeadTime;
    }
    if (p.jumpPrep > 0) {
      p.jumpPrep = Math.max(0, p.jumpPrep - dt);
      p.position.y += (groundY - p.position.y) * (1 - Math.exp(-dt * 18));
      if (Math.abs(groundY - p.position.y) < 1e-3) p.position.y = groundY;
      if (p.jumpPrep === 0) {
        p.verticalVel = 5.2;
        p.jumping = true;
      }
    }
    if (p.jumping || p.position.y > groundY + 0.3) {
      if (p.position.y > groundY + 0.3) {
        p.jumping = true;
        p.jumpPrep = 0;
      }
      p.verticalVel -= 14.5 * dt;
      const nextY = p.position.y + p.verticalVel * dt;
      const landing = p.verticalVel < 0
        ? this.surfaceResolver.footing?.(p.position.x, p.position.z, 0.48, nextY, p.position.y) : null;
      p.position.y = nextY;
      if (landing && landing.height >= groundY) {
        p._support = landing;
        p.position.y = landing.height;
        p.verticalVel = 0;
        p.jumping = false;
      } else if (p.position.y <= groundY) {
        p.position.y = groundY;
        p.verticalVel = 0;
        p.jumping = false;
      }
    } else if (!(p.jumpPrep > 0)) {
      // Stepping up or down ordinary 0.22 m curbs stays grounded so the IK footsteps carry the body smoothly
      p.position.y += (groundY - p.position.y) * (1 - Math.exp(-dt * 18));
      if (Math.abs(groundY - p.position.y) < 1e-3) p.position.y = groundY;
      p.verticalVel = 0;
      p.jumping = false;
    }
  }

  updateCar(dt, driveInput = null) {
    if (dt <= 0) return;
    const c = this.entities.car;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    if (driveInput) throttle = driveInput.throttle;
    const boost = Boolean(this.keys.boost);
    const serviceBrake = Math.max(driveInput?.brake ?? 0, this.keys.brake ? 1 : 0);
    const braking = serviceBrake > 0 || c.speed * throttle < 0;
    // 手动驾驶按住 Shift 时可到 120 km/h；自动驾驶仍用自身限速。
    const drive = driveInput ? CAR_AUTO_DRIVE : boost ? CAR_BOOST_DRIVE : CAR_DRIVE;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.prevX = prevX;
    c.prevZ = prevZ;
    // Short steps keep grip, impacts and suspension consistent at different display rates.
    const steps = Math.ceil(dt * 120);
    const step = dt / steps;
    const steerResponse = 1 - Math.exp(-10 * step);
    const yawResponse = 1 - Math.exp(-5 * step);
    const tireResponse = 1 - Math.exp(-4 * step);
    for (let i = 0; i < steps; i++) {
      const previousHeading = c.heading;
      const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
      const vx = sin * c.speed + c.vx, vz = cos * c.speed + c.vz;
      const forward = vx * sin + vz * cos;
      const sideways = vx * cos - vz * sin;
      let speed = driveSpeed(forward, throttle, step, drive, serviceBrake);
      // 松开 Shift 后从加力区回落到常规上限，制动和碰撞仍按原有方式处理。
      if (!driveInput && !boost && !braking && speed > CAR_DRIVE.speed) {
        speed = Math.max(CAR_DRIVE.speed, speed - CAR_DRIVE.boostDeceleration * step);
      }
      const acceleration = (speed - forward) / step;
      // Braking and cornering share tire grip; air resistance does not use it.
      const tireAcceleration = acceleration + CAR_DRIVE.drag * forward * Math.abs(forward);
      const grip = Math.sqrt(Math.max(0, CAR_DRIVE.grip ** 2 - tireAcceleration ** 2));
      // A handbrake slide preserves steering while reducing lateral grip; fade it out at low speed.
      const handbrake = forward * throttle < 0 ? Math.abs(throttle) * Math.min(1, Math.abs(forward) / 5) : 0;
      const lateralGrip = grip * (1 - 0.7 * handbrake);
      const steeringGrip = grip + (CAR_DRIVE.grip - grip) * handbrake;

      // Full lock at parking speeds, progressively less steering at road speeds.
      const turn = CAR_DRIVE.wheelbase * CAR_DRIVE.cornering;
      const maxSteer = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.60)));
      const steering = driveInput ? Math.max(-maxSteer, Math.min(maxSteer, driveInput.steerAngle)) : steerInput * maxSteer;
      c.steerAngle += (steering - c.steerAngle) * steerResponse;
      const yawLimit = steeringGrip / Math.max(2, Math.abs(speed));
      const targetYaw = Math.max(-yawLimit, Math.min(yawLimit, speed * Math.tan(c.steerAngle) / CAR_DRIVE.wheelbase));
      // Collision spin remains part of the yaw velocity; the tires gradually regain control.
      const yawStep = steeringGrip * 0.65 * step;
      c.angularVel += Math.max(-yawStep, Math.min(yawStep, (targetYaw - c.angularVel) * yawResponse));
      c.heading += c.angularVel * step;

      // Turning the chassis must not instantly rotate its momentum. Tires remove sideways slip
      // with a bounded force; longitudinal momentum, including impacts, stays in speed.
      const nextSin = Math.sin(c.heading), nextCos = Math.cos(c.heading);
      const worldX = sin * speed + cos * sideways;
      const worldZ = cos * speed - sin * sideways;
      c.speed = worldX * nextSin + worldZ * nextCos;
      const slip = worldX * nextCos - worldZ * nextSin;
      const correction = Math.max(-lateralGrip * step, Math.min(lateralGrip * step, -slip * tireResponse));
      c.vx = nextCos * (slip + correction);
      c.vz = -nextSin * (slip + correction);
      const beforeX = c.position.x, beforeZ = c.position.z;
      const nextX = beforeX + (nextSin * c.speed + c.vx) * step;
      const nextZ = beforeZ + (nextCos * c.speed + c.vz) * step;
      if (driveInput && !driveInput.permitMove(nextX, nextZ, c.heading)) {
        c.heading = previousHeading;
        c.speed = c.vx = c.vz = c.angularVel = 0;
        break;
      }
      const previousSafe = c._safePosition;
      const previousSupport = c._support;
      c.position.x = nextX;
      c.position.z = nextZ;
      this.resolveHorizontalCollision(c.position, 1.35, c);
      if (driveInput && (c.position.x !== nextX || c.position.z !== nextZ)
        && !driveInput.permitMove(c.position.x, c.position.z, c.heading)) {
        c.position.x = beforeX;
        c.position.z = beforeZ;
        c._safePosition = previousSafe;
        c._support = previousSupport;
        c.heading = previousHeading;
        c.speed = c.vx = c.vz = c.angularVel = 0;
        break;
      }

      const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026;
      const targetRoll = Math.max(-0.09, Math.min(0.09, correction / step * 0.012));
      c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
      c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
      c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * step));
      c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * step));
      c.heaveVel += (-c.heaveY * 85 - c.heaveVel * 12) * step;
      c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * step));
    }
    const nextGroundY = this.getGroundHeight(c.position.x, c.position.z, 'car');
    if (Number.isFinite(nextGroundY)) c.position.y = nextGroundY;
    c.chassisPivot.position.y = c.heaveY;

    c.setLights?.(braking, c.speed < -0.2);

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / VEHICLE_SPECS.taxi.radius;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt) {
    if (dt <= 0) return;
    const b = this.entities.cyclist;

    const handbrake = b.speed > 0 ? +this.keys.up : 0;
    let throttle = 0;
    if (handbrake) throttle = -handbrake;
    else if (this.keys.forward) throttle = +this.keys.forward;
    else if (this.keys.backward) throttle = b.speed > 0 ? -this.keys.backward : -0.6 * this.keys.backward;

    // Pause briefly at zero after braking from forward travel so holding S stops cleanly before backing up
    if (b.speed > 0 && throttle < 0) {
      b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);
      if (b.speed < 0.05) {
        b.speed = 0;
        if (!handbrake) b._brakeHold = 0.25;
      }
    } else if (!handbrake && b._brakeHold > 0 && throttle < 0) {
      b._brakeHold = Math.max(0, b._brakeHold - dt);
      b.speed = 0;
    } else {
      b._brakeHold = 0;
      b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);
    }

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    const prevX = b.position.x;
    const prevZ = b.position.z;
    const sinH = Math.sin(b.heading);
    const cosH = Math.cos(b.heading);
    const nextX = prevX + sinH * b.speed * dt;
    const nextZ = prevZ + cosH * b.speed * dt;
    b.position.x = nextX;
    b.position.z = nextZ;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);

    // Prevent phantom speed buildup when blocked head-on by a building or shoreline boundary
    if (Math.abs(b.position.x - nextX) > 1e-6 || Math.abs(b.position.z - nextZ) > 1e-6) {
      const actualFwd = ((b.position.x - prevX) * sinH + (b.position.z - prevZ) * cosH) / dt;
      if (b.speed > 0 && actualFwd < b.speed) b.speed = Math.max(0, actualFwd);
      else if (b.speed < 0 && actualFwd > b.speed) b.speed = Math.min(0, actualFwd);
    }
    const nextGroundY = this.getGroundHeight(b.position.x, b.position.z, 'cyclist');
    if (Number.isFinite(nextGroundY)) b.position.y = nextGroundY;

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / (b.wheelRadius ?? 0.335)) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  getFlightSupport(entity, previousSkidY) {
    const { x, z } = entity.position;
    const terrain = this.groundHeight(x, z);
    const support = this.surfaceResolver.below(x, z, previousSkidY + 0.025);
    if (!support || support.surfaceId === 'terrain') return terrain;
    // 从上方接触屋面，且旋翼包络四角都有同一平面支撑，避免机身停在屋沿外。
    const shape = collisionBody(entity.type, 4.5, entity.heading, 0, entity.collisionBounds);
    const halfX = shape.car ? shape.hx : shape.extX, halfZ = shape.car ? shape.hz : shape.extZ;
    for (const dx of [-halfX, halfX]) for (const dz of [-halfZ, halfZ]) {
      const corner = this.surfaceResolver.below(x + dx * shape.cos + dz * shape.sin,
        z - dx * shape.sin + dz * shape.cos, support.height + 0.025);
      if (corner?.surfaceId !== support.surfaceId) return terrain;
    }
    return support.height;
  }

  updateHelicopter(dt) {
    if (dt <= 0) return;
    const h = this.entities.helicopter;
    const { speed: maxHorizSpeed, verticalSpeed: maxVertSpeed } = EVTOL_DRIVE;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * (fwdInput > 0 && h.speed >= 0 ? EVTOL_DRIVE.acceleration : 24.0) * dt;
      h.speed = Math.max(-EVTOL_DRIVE.reverseSpeed, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * EVTOL_DRIVE.verticalAcceleration * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    const skidBase = h.collisionBounds?.min.y ?? -0.25;
    const previousSkidY = h.position.y + skidBase;
    const previousX = h.position.x, previousZ = h.position.z;
    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    let landing = this.getFlightSupport(h, previousSkidY);
    let floor = Number.isFinite(landing) ? landing - skidBase : null;
    // 地面高于飞行上限时阻止水平进入，不把贴地后的飞机重新压进山体。
    if (floor !== null && floor > this.maxFlightAltitude) {
      h.position.x = previousX;
      h.position.z = previousZ;
      h.speed = 0;
      landing = this.getFlightSupport(h, previousSkidY);
      floor = Number.isFinite(landing) ? landing - skidBase : null;
    }
    if (floor !== null && h.position.y < floor) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, landing, h.position.z, 0, 1, 0, -h.verticalSpeed);
      h.position.y = floor;
      h.verticalSpeed = Math.max(0, h.verticalSpeed);
    }
    if (floor === null && h.position.y < (h._safePosition?.y ?? h.position.y)) {
      h.position.y = h._safePosition.y;
      h.verticalSpeed = 0;
    }
    // 已存位置若就在超限地面上，接触安全优先；不改源地形或允许继续爬升。
    const ceiling = Math.max(this.maxFlightAltitude, floor ?? this.maxFlightAltitude);
    if (h.position.y >= ceiling) {
      h.position.y = ceiling;
      h.verticalSpeed = Math.min(0, h.verticalSpeed);
    }
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.21;
    const targetRoll = -yawInput * 0.24;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 7);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 7);

    // 落地时滑橇放平，去掉悬停摆动造成的穿地或离地。
    const airborne = floor === null ? 1 : Math.max(0, Math.min(1, (h.position.y - floor) / 2.2));
    h.tiltPivot.rotation.x = h.pitchAngle * airborne;
    h.tiltPivot.rotation.z = h.rollAngle * airborne;
  }
}

export { ThirdPersonControllerManager, OCCUPANT_STATES, BOARDING_SECONDS, ALIGHTING_SECONDS, FLIGHT_START_ALTITUDE };
