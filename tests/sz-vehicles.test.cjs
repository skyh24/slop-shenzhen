const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const source = read('sz-vehicles.js');

// 纯函数单测用最小 BODY_SPECS 夹具，只验证由 loft 剖面推导整车尺寸的规则。
const bodyFixture = {
  halfWidth: [[0, 0.9]], archFlare: 0.02, sill: [[0, 0.25]], zFront: 2.2, zRear: -2.3,
  wheelZ: 1.4, wheelX: 0.8, wheelRadius: 0.35, headlight: [0.6, 0.7], cabin: { roofFront: -0.02, roofRear: -1.12 }
};
const fixtureBody = name => ({ ...bodyFixture, name });
const imports = {
  'three/webgpu': { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
  'three/addons/geometries/LoftGeometry.js': {},
  'three/addons/utils/BufferGeometryUtils.js': {},
  './sz-strings.js': { STR: {} },
  './vehicles.js': {},
  './cars.js': {
    BODY_SPECS: {
      taxi: fixtureBody('taxi'), sedan: fixtureBody('sedan'), suv: fixtureBody('suv'),
      minivan: fixtureBody('minivan'), van: fixtureBody('van')
    },
    buildCarGeometry: () => ({}),
    buildCarSidePatch: () => ({}),
    buildSteerableWheelGeo: () => ({}),
    carLayout: () => ({ cabin: () => ({}), cabinTop: () => 1.44 }),
    carStyleCode: () => 0,
    carTipZ: () => 0,
    createCarWheelMaterial: () => ({}),
    createLoftedCarMaterial: () => ({ userData: {} }),
    setCarLocale: () => 'shenzhen',
    taxiSignPlacement: () => ({ z: -0.5, y: 1.4 })
  }
};
const { VEHICLE_SPECS, wheelArchTop, rotorSweep } = loadModule(source, { imports });

test('car dimensions are derived from the lofted body profile, so collision matches the visible geometry', () => {
  for (const type of ['taxi', 'sedan', 'suv', 'minivan', 'van']) {
    const body = imports['./cars.js'].BODY_SPECS[type];
    const spec = VEHICLE_SPECS[type];
    assert.equal(spec.length, body.zFront - body.zRear);
    assert.equal(spec.wheelbase, body.wheelZ * 2);
    assert.equal(spec.track, body.wheelX * 2);
    assert.equal(spec.radius, body.wheelRadius);
    assert.equal(spec.tireWidth, body.wheelRadius * 0.68);
    assert.equal(spec.sill, Math.min(...body.sill.map((point) => point[1])));
    assert.equal(spec.width, 2 * (Math.max(...body.halfWidth.map((point) => point[1])) + body.archFlare));
    assert.equal(spec.headlight[0], body.headlight[0]);
    assert.equal(spec.headlight[1], body.headlight[1]);
  }
});

test('wheel cutouts follow the same axle centers and radius as the visible tires', () => {
  const spec = VEHICLE_SPECS.bus;
  const arch = spec.radius + 0.058;
  assert.equal(wheelArchTop(spec, 0, arch), spec.sill);
  for (const direction of [-1, 1]) {
    const center = direction * spec.wheelbase / 2;
    assert.ok(wheelArchTop(spec, center, arch) > spec.radius * 2);
    for (const offset of [-0.29, -0.15, 0, 0.15, 0.29]) {
      const tireTop = spec.radius + Math.sqrt(spec.radius ** 2 - offset ** 2);
      assert.ok(wheelArchTop(spec, center + offset, arch) > tireTop);
    }
  }
});

test('rotor bounds use vertex radius and thickness for a full rotation', () => {
  const vertices = [[0.6, 0.03, 0.8], [-0.7, -0.04, 0], [0, 0.04, 0]];
  const part = {
    position: { x: 2, y: 1.5, z: -3 },
    children: [{ geometry: { attributes: { position: {
      count: vertices.length, getX: i => vertices[i][0], getY: i => vertices[i][1], getZ: i => vertices[i][2]
    } } } }]
  };
  const points = [];
  const bounds = { expandByPoint: p => points.push([p.x, p.y, p.z]) };
  assert.equal(rotorSweep(part, bounds), 1);
  assert.deepEqual(points, [[1, 1.46, -4], [3, 1.54, -2]]);
});

// 真实 Three 0.187.0：车身、车轮、贴花和飞行器几何。
const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;
test('real three geometry has grounded wheels, clear fenders and bounded rotors', { skip: !threePackageDir }, async () => {
  const packageUrl = pathToFileURL(join(threePackageDir, '/'));
  const [THREE, buffers, loft] = await Promise.all([
    import(new URL('build/three.webgpu.js', packageUrl)),
    import(new URL('examples/jsm/utils/BufferGeometryUtils.js', packageUrl)),
    import(new URL('examples/jsm/geometries/LoftGeometry.js', packageUrl))
  ]);
  assert.equal(THREE.REVISION, '187');
  const vehicles = loadModule(read('vehicles.js'), { imports: {
    'three/webgpu': THREE, 'three/addons/utils/BufferGeometryUtils.js': buffers
  } });

  // cars.js 的材质要建 TSL 节点图；几何测试只需要可调用的空节点，避免整套数值求值器。
  const emptyNode = () => {
    const proxy = new Proxy(function () {}, {
      get: (target, key) => (key === Symbol.toPrimitive ? () => 0 : proxy),
      apply: () => proxy
    });
    return proxy;
  };
  const tslNames = ['Fn', 'If', 'float', 'vec2', 'vec3', 'vec4', 'color', 'attribute', 'varying', 'vertexStage',
    'sin', 'cos', 'atan', 'pow', 'dot', 'abs', 'fract', 'floor', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
    'length', 'fwidth'];
  const tsl = Object.fromEntries(tslNames.map((name) => [name, (...args) => (name === 'Fn' ? () => emptyNode() : emptyNode())]));
  tsl.varying = (value) => value;
  tsl.vertexStage = (value) => value;
  // uniform 节点同时暴露 .value（玩家灯光的写入点）和可链式的 x/y/z/w 分量。
  tsl.uniform = (value) => {
    const node = emptyNode();
    return { value, x: node, y: node, z: node, w: node };
  };
  tsl.normalView = emptyNode();
  tsl.positionViewDirection = emptyNode();
  tsl.time = emptyNode();
  tsl.instanceIndex = emptyNode();
  const context2d = () => new Proxy({}, {
    get: (target, key) => (key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {})
  });
  const canvas = () => ({ width: 0, height: 0, getContext: context2d });
  const cars = loadModule(read('cars.js'), {
    imports: {
      'three/webgpu': THREE,
      'three/tsl': tsl,
      'three/addons/utils/BufferGeometryUtils.js': buffers,
      'three/addons/geometries/LoftGeometry.js': loft,
      './city-lighting-materials.js': { cityUniforms: { uInteriorGlow: { value: 0.48 } } },
      './vehicles.js': vehicles
    },
    globals: { document: { createElement: canvas } }
  });
  const models = loadModule(source, {
    imports: {
      ...imports,
      'three/webgpu': THREE,
      'three/addons/geometries/LoftGeometry.js': loft,
      'three/addons/utils/BufferGeometryUtils.js': buffers,
      './sz-strings.js': { STR: { vehicleLabels: { taxi: '深圳出租', available: '空车' } } },
      './vehicles.js': vehicles,
      './cars.js': cars
    },
    globals: { document: { createElement: canvas } }
  });

  // 深圳出租是独立 e6 类 MPV 体型：高顶两厢、流线前脸、微斜圆角尾门，不是轿车的斜背尾箱也不是方盒子。
  const taxiSpec = models.VEHICLE_SPECS.taxi;
  const taxiBody = cars.BODY_SPECS.taxi;
  assert.ok(Math.abs(taxiSpec.length - 4.7) < 0.01, `taxi length ${taxiSpec.length}`);
  assert.ok(taxiSpec.width > 1.8 && taxiSpec.width < 1.83, `taxi width ${taxiSpec.width}`);
  assert.ok(taxiSpec.height > 1.66 && taxiSpec.height < 1.71, `taxi height ${taxiSpec.height}`);
  assert.equal(taxiSpec.wheelbase, 2.8);
  assert.ok(taxiBody.zRear < -2.35, 'rear overhang stays short');
  const taxiLayout = cars.carLayout(taxiBody);
  const angleFromVertical = (rise, run) => Math.atan2(Math.abs(run), rise) * 180 / Math.PI;
  // 前脸：机舱盖低、鼻锥上沿明显后掠（滑流线），不是直立的方正车头
  const noseFront = cars.carTipZ(taxiBody, 0.95, true);
  const noseBumper = cars.carTipZ(taxiBody, 0.56, true);
  const hoodHeight = taxiLayout.body(2.1).yE;
  assert.ok(noseBumper - noseFront > 0.12, `raked nose: bumper ${noseBumper.toFixed(2)} vs hood line ${noseFront.toFixed(2)}`);
  assert.ok(hoodHeight < 0.95, `low bonnet line ${hoodHeight.toFixed(2)}`);
  assert.ok(angleFromVertical(1, (taxiBody.cabin.cowl - taxiBody.cabin.roofFront) / (taxiLayout.rail.front.y - taxiLayout.belt.cowl.y)) > 40,
    'windscreen is more raked than 40° from vertical');
  // 尾部：tailRake + 较大平面收圆，尾门微斜圆角而不是垂直平板；后窗仍接近直立
  assert.ok(taxiBody.tailRake && taxiBody.tailRake.length >= 0.35, 'tail has a rake, so the tailgate is not a vertical slab');
  assert.ok(taxiBody.tail.halfWidth[0] >= 0.2, 'tail plan corners are rounded, not a flat plank');
  const tailTop = cars.carTipZ(taxiBody, 1.0, false);
  const tailBumper = cars.carTipZ(taxiBody, 0.7, false);
  const tailRake = angleFromVertical(1.0 - 0.7, tailTop - tailBumper);
  assert.ok(tailRake > 5 && tailRake < 30, `tail rakes forward gently, got ${tailRake.toFixed(1)}°`);
  const backlightRise = taxiLayout.cabin(taxiBody.cabin.roofRear).railY - taxiLayout.cabin(taxiBody.cabin.deck).beltY;
  const backlightRun = Math.abs(taxiBody.cabin.deck - taxiBody.cabin.roofRear);
  const backlightAngle = angleFromVertical(backlightRise, backlightRun);
  assert.ok(backlightAngle > 10 && backlightAngle < 32, `backlight leans slightly, got ${backlightAngle.toFixed(1)}°`);
  const tailSection = taxiLayout.body(taxiBody.zRear);
  assert.ok(tailSection.yT - tailSection.yB > 0.6, 'tailgate is a tall face');
  // 尾灯在尾门两侧靠上，位于车牌上方并落在尾门面高度范围内
  assert.ok(taxiBody.taillight[1] > taxiBody.plates[1]);
  assert.ok(taxiBody.taillight[1] + taxiBody.taillight[3] <= tailSection.yE + 0.01);

  for (const type of ['taxi', 'sedan', 'suv', 'minivan', 'van']) {
    const model = models.createShenzhenCarMesh({ type });
    const spec = models.VEHICLE_SPECS[type];
    assert.equal(model.wheels.length, 4);
    assert.ok(Math.abs(model.bounds.min.y) < 1e-6, `${type} rests on the ground`);
    assert.ok(model.bounds.max.y > 1.2 && model.bounds.max.y < 2.8, `${type} has a realistic height`);
    const [frontLeft, frontRight, rearLeft, rearRight] = model.wheels;
    assert.equal(frontLeft.isFront, true);
    assert.equal(frontRight.isFront, true);
    assert.equal(rearLeft.isFront, false);
    assert.equal(rearRight.isFront, false);
    assert.equal(frontLeft.steerPivot.position.z - rearLeft.steerPivot.position.z, spec.wheelbase);
    assert.equal(frontRight.steerPivot.position.z - rearRight.steerPivot.position.z, spec.wheelbase);
    assert.equal(frontLeft.steerPivot.position.x, -spec.track / 2);
    assert.equal(frontLeft.tire.geometry, rearLeft.tire.geometry, 'left pair shares one wheel buffer');
    assert.equal(frontRight.tire.geometry, rearRight.tire.geometry, 'right pair shares one wheel buffer');
    assert.notEqual(frontLeft.tire.geometry, frontRight.tire.geometry, 'outboard wheel faces stay mirrored');
    assert.equal(typeof model.setLights, 'function');
    model.setLights(true, true);

    model.group.updateMatrixWorld(true);
    for (const { steerPivot } of model.wheels) {
      const side = Math.sign(steerPivot.position.x);
      const ray = new THREE.Raycaster(new THREE.Vector3(side * 2, spec.radius * 1.95, steerPivot.position.z),
        new THREE.Vector3(-side, 0, 0));
      const hits = ray.intersectObject(model.chassis, true);
      assert.ok(hits.length > 0, 'the inner wheel well remains closed');
      assert.ok(hits[0].point.x * side < spec.track / 2 - spec.tireWidth / 2 + 0.02,
        'the body does not occupy the tire slot');
    }

    // 出租车有曲面车门字、粤B 绿牌和「空车 TAXI」顶灯贴花。
    const decals = [];
    model.chassis.traverse(({ name }) => { if (name) decals.push(name); });
    if (type === 'taxi') {
      assert.equal(decals.filter(name => name === 'taxi-door-lettering').length, 2);
      assert.ok(decals.includes('front-plate') && decals.includes('rear-plate'));
      assert.equal(decals.filter(name => name === 'roof-sign-lettering').length, 2);
    } else {
      assert.ok(!decals.includes('front-plate'), `${type} has no taxi plate decal`);
    }
    model.dispose();

    const body = models.createTrafficCarBody(type);
    body.geometry.computeBoundingBox();
    assert.ok(body.geometry.index.count / 3 > 1500, `${type} ambient body is the detailed loft, not a proxy`);
    assert.ok(body.geometry.attributes.partId, 'ambient body keeps part ids for the TSL material');
    assert.ok(!body.geometry.attributes.paintColor, 'traffic adds per-instance paint when it builds its mesh');

    const wheels = models.createTrafficWheels();
    assert.ok(wheels.left.index.count / 3 > 100 && wheels.right.index.count / 3 > 100);
    assert.equal(wheels.baseRadius, cars.BODY_SPECS.sedan.wheelRadius);
    assert.notEqual(wheels.left, wheels.right);
    wheels.left.dispose();
    wheels.right.dispose();
  }

  // 30 辆环境车只有 5 套 loft 材质（每种车身一套，按 spec+locale 缓存），不能一辆一份 shader。
  const carMaterials = ['taxi', 'sedan', 'suv', 'minivan', 'van'].map(type => models.createTrafficCarBody(type).material);
  assert.equal(new Set(carMaterials).size, 5);
  assert.equal(models.createTrafficCarBody('sedan').material, carMaterials[1], 'material cache reuses per body spec');
  const sharedWheels = models.createTrafficWheels();
  assert.equal(models.createTrafficWheels().material, sharedWheels.material, 'all ambient wheels share one material');
  sharedWheels.left.dispose();
  sharedWheels.right.dispose();

  const bus = models.createShenzhenBusMesh();
  assert.equal(bus.wheels.length, 4);
  assert.ok(Math.abs(bus.bounds.min.y) < 1e-6);
  assert.equal(bus.wheels[0].tire.children[0].geometry, bus.wheels[1].tire.children[0].geometry);
  bus.dispose();

  for (const color of ['yellow', 'blue']) {
    const model = models.createSharedCycleMesh({ color });
    assert.ok(Math.abs(model.bounds.min.y) < 1e-6);
    assert.equal(model.pedals.length, 2);
    assert.equal(model.crankPivot.position.y, model.bikeFrame.bracket.y);
    assert.equal(model.frontWheel.children[0].geometry, model.rearWheel.children[0].geometry);
    model.dispose();
  }

  for (const [factory, blades] of [[models.createEvtolMesh, 2], [models.createCargoDroneMesh, 3]]) {
    const aircraft = factory();
    assert.equal(aircraft.rotors.length, 4);
    assert.ok(Math.abs(aircraft.bounds.min.y) < 1e-6);
    const bounds = aircraft.bounds.clone().expandByScalar(1e-7);
    const current = new THREE.Box3();
    for (const rotor of aircraft.rotors) {
      assert.equal(rotor.userData.parts.filter(part => part === 'tapered-rotor-blade').length, blades);
      assert.equal(rotor.children[0].geometry, aircraft.rotors[0].children[0].geometry);
    }
    for (let i = 0; i < 72; i++) {
      aircraft.update(1 / 60, 0.73);
      assert.ok(bounds.containsBox(current.setFromObject(aircraft.group, true)));
    }
    assert.equal(aircraft.rotors[0].rotation.y, -aircraft.rotors[1].rotation.y);
    aircraft.dispose();
  }

  // 载人飞行器座舱里有一名坐姿飞行员；货机没有乘员。
  const pilot = models.createEvtolMesh();
  const pilotParts = pilot.group.userData.parts;
  for (const name of ['pilot-head', 'pilot-torso', 'pilot-upper-arm', 'pilot-forearm', 'pilot-thigh', 'pilot-shin', 'pilot-foot']) {
    assert.ok(pilotParts.includes(name), `eVTOL cockpit has ${name}`);
  }
  // 舱盖要足够透，第三人称机位能看清里面坐着人
  const canopyMesh = pilot.group.children.find(child => child.name === 'canopy');
  assert.ok(canopyMesh, 'eVTOL has a canopy mesh');
  assert.ok(canopyMesh.material.transparent && canopyMesh.material.opacity <= 0.5,
    `canopy opacity ${canopyMesh.material.opacity} keeps the pilot visible`);
  pilot.dispose();
  const cargo = models.createCargoDroneMesh();
  assert.ok(!cargo.group.userData.parts.some(name => name.startsWith('pilot-')), 'cargo drone has no occupant');
  cargo.dispose();
});
