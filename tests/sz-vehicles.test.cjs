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

  // 深圳出租是参考图那台长、低、圆润的流线型纯电出租车：低车顶 + 大倾角风挡 + 溜背圆尾，
  // 不是高顶方盒 MPV，也不是轿车尾箱。
  const taxiSpec = models.VEHICLE_SPECS.taxi;
  const taxiBody = cars.BODY_SPECS.taxi;
  const taxiLayout = cars.carLayout(taxiBody);
  const angleFromVertical = (rise, run) => Math.atan2(Math.abs(run), rise) * 180 / Math.PI;
  // 长 / 低 / 宽比例
  assert.ok(taxiSpec.length > 4.85 && taxiSpec.length < 4.95, `taxi length ${taxiSpec.length}`);
  assert.ok(taxiSpec.width > 1.9 && taxiSpec.width < 1.95, `taxi width ${taxiSpec.width}`);
  assert.ok(taxiSpec.height > 1.5 && taxiSpec.height < 1.57, `taxi height ${taxiSpec.height}`);
  assert.ok(taxiSpec.wheelbase > 2.88 && taxiSpec.wheelbase < 2.92, `taxi wheelbase ${taxiSpec.wheelbase}`);
  assert.ok(taxiSpec.radius > 0.355 && taxiSpec.radius < 0.37, `taxi wheel radius ${taxiSpec.radius}`);
  assert.ok(taxiSpec.height / taxiSpec.length < 0.33, 'low and long: height/length below 0.33');
  assert.ok(taxiSpec.width / taxiSpec.height > 1.2, 'wide stance relative to the low roof');
  // 车身加宽后轮子应完全收进轮拱：轮胎外沿要比轴位车身半宽内收 ≥10 mm
  const halfWidthPeak = Math.max(...taxiBody.halfWidth.map((point) => point[1]));
  assert.ok(halfWidthPeak > 0.94 && halfWidthPeak < 0.96, `wide lower body half width ${halfWidthPeak}`);
  assert.ok(taxiSpec.track > 1.63 && taxiSpec.track < 1.69, `track tucked in to ${taxiSpec.track}`);
  const axleHalfWidth = taxiLayout.body(taxiSpec.wheelbase / 2).W;
  const tireOuter = taxiSpec.track / 2 + taxiSpec.tireWidth / 2;
  assert.ok(axleHalfWidth - tireOuter >= 0.01,
    `tire outer face ${tireOuter.toFixed(3)} is recessed ${((axleHalfWidth - tireOuter) * 1000).toFixed(0)} mm inside the body ${axleHalfWidth.toFixed(3)}`);
  // 转向间隙：轮胎在平面里扫过的外接圆要留在轮拱切口内，前轮打满不穿轮眉
  const steeringSweep = Math.hypot(taxiSpec.radius, taxiSpec.tireWidth / 2);
  assert.ok(steeringSweep < taxiSpec.radius + taxiBody.archGap,
    `steered tire sweep ${steeringSweep.toFixed(3)} stays inside the arch ${(taxiSpec.radius + taxiBody.archGap).toFixed(3)}`);
  // 上下同步加宽：tumblehome 收小，车顶/玻璃房一起变宽
  for (const point of taxiBody.tumble) assert.ok(point[1] <= 0.125 && point[1] >= 0.09, `tumblehome ${point[1]}`);
  // 低矮圆润前脸：长收圆 + 大 rake，机舱盖低、风挡大倾角
  const noseFront = cars.carTipZ(taxiBody, 0.95, true);
  const noseBumper = cars.carTipZ(taxiBody, 0.6, true);
  assert.ok(noseBumper - noseFront > 0.12, `raked nose: bumper ${noseBumper.toFixed(2)} vs hood line ${noseFront.toFixed(2)}`);
  assert.ok(taxiLayout.body(2.1).yE < 0.95, `low bonnet line ${taxiLayout.body(2.1).yE.toFixed(2)}`);
  assert.ok(angleFromVertical(1, (taxiBody.cabin.cowl - taxiBody.cabin.roofFront) / (taxiLayout.rail.front.y - taxiLayout.belt.cowl.y)) > 50,
    'strongly raked windscreen (more than 50° from vertical)');
  // 长弧形车顶：顶线连续、无折点
  const roofSamples = [];
  for (let z = taxiBody.cabin.roofFront; z >= taxiBody.cabin.roofRear; z -= 0.05) roofSamples.push(taxiLayout.cabin(z).railY);
  for (let i = 2; i < roofSamples.length; i++) {
    const curvature = roofSamples[i] - 2 * roofSamples[i - 1] + roofSamples[i - 2];
    assert.ok(Math.abs(curvature) < 0.004, `roof crown stays smoothly curved (second difference ${curvature.toFixed(4)})`);
  }
  assert.ok(roofSamples[0] <= roofSamples[Math.floor(roofSamples.length / 2)] - 0.03, 'roof rises from the windscreen top to a crowned centre');
  assert.ok(roofSamples.at(-1) < roofSamples[Math.floor(roofSamples.length / 2)] - 0.02, 'roof falls into the rear glass');
  // 侧面是凸曲面：低超椭圆指数 + 明显 tumblehome，没有竖直方盒侧板
  assert.ok(taxiBody.lowerRound >= 2 && taxiBody.lowerRound <= 2.4, `lowerRound ${taxiBody.lowerRound}`);
  assert.ok(taxiBody.upperRound >= 2 && taxiBody.upperRound <= 2.4, `upperRound ${taxiBody.upperRound}`);
  const midSection = taxiLayout.body(0);
  assert.ok(midSection.W - midSection.xE > 0.08, 'side glass sits in from the widest point (convex shoulder, no vertical slab)');
  assert.ok(midSection.W - midSection.xE <= 0.13, 'tumblehome stays small so the cabin is wide too (upper and lower body widened together)');
  // 大曲面玻璃房 + 细 A/B/C 柱
  assert.ok(taxiBody.cabin.bulge >= 0.015, 'side glass is curved outward');
  assert.ok(taxiBody.cabin.pillars.length >= 2 && taxiBody.pillarWidth <= 0.03, 'slim B/C pillars');
  const glassHeight = taxiLayout.cabin(0).railY - taxiLayout.belt.cowl.y;
  assert.ok(glassHeight > 0.32, `large side glass, ${glassHeight.toFixed(2)} m tall`);
  // 溜背圆尾：整圈同一条收圆弧 + 随高度单调前倾的 tailRake，后窗大倾角
  assert.ok(taxiBody.tailRake && taxiBody.tailRake.length >= 0.35, 'tail has a rake, so the rear is rounded, not a vertical hatch');
  const tailRounding = ['halfWidth', 'edge', 'crown', 'sill', 'shoulder'].map(key => taxiBody.tail[key]);
  for (const parameter of tailRounding) {
    assert.ok(parameter[0] >= 0.5, `tail rounding ${parameter[0]} blends the rear face into the sides`);
    assert.ok(parameter[2] <= 2.2, `tail superellipse exponent ${parameter[2]} keeps the corner round`);
  }
  assert.ok(new Set(tailRounding.map(parameter => parameter[0])).size === 1,
    'every rear parameter uses the same rounding length, so the whole corner is one continuous surface');
  const rearHeights = [0.27, 0.4, 0.55, 0.7, 0.82, 0.9];
  const rearTips = rearHeights.map(y => cars.carTipZ(taxiBody, y, false));
  for (let i = 1; i < rearTips.length; i++) {
    assert.ok(rearTips[i] >= rearTips[i - 1] - 1e-6,
      `tail profile moves forward monotonically (${rearHeights[i - 1]}→${rearHeights[i]}: ${rearTips[i - 1].toFixed(3)}→${rearTips[i].toFixed(3)})`);
  }
  const tailRake = angleFromVertical(rearHeights.at(-1) - rearHeights[0], rearTips.at(-1) - rearTips[0]);
  assert.ok(tailRake > 12, `fastback tail leans forward strongly, got ${tailRake.toFixed(1)}°`);
  // 最后 1.2 m 的侧面断面单调连续（后轮拱影响的 yS 只在拱后取样）
  const rearSection = [];
  for (let z = taxiBody.zRear; z <= taxiBody.zRear + 1.2 + 1e-9; z += 0.02) rearSection.push({ z, ...taxiLayout.body(z) });
  for (const key of ['W', 'yE', 'yT', 'xB', 'xE']) {
    for (let i = 1; i < rearSection.length; i++) {
      assert.ok(rearSection[i][key] >= rearSection[i - 1][key] - 0.002,
        `rear ${key} has no reverse kink at z ${rearSection[i].z.toFixed(2)}`);
    }
  }
  const behindArch = rearSection.filter(section => section.z < -1.9);
  for (let i = 1; i < behindArch.length; i++) {
    assert.ok(behindArch[i].yS >= behindArch[i - 1].yS - 0.002, 'shoulder line is continuous behind the rear arch');
  }
  assert.ok(rearSection[0].W < rearSection.at(-1).W - 0.08, 'rear plan corner tapers in smoothly');
  // 后窗下沿接在被尾部斜面推到前的车身上沿，不在车尾外悬空；后窗大倾角（溜背）
  const capTopZ = cars.carTipZ(taxiBody, taxiLayout.body(taxiBody.zRear).yT - 0.02, false);
  assert.ok(taxiBody.cabin.deck > capTopZ, `backlight base ${taxiBody.cabin.deck} sits ahead of the raked tail top ${capTopZ.toFixed(2)}`);
  assert.ok(taxiBody.cabin.deck - capTopZ < 0.4, 'short fastback deck between backlight base and tail top');
  const backlightRise = taxiLayout.cabin(taxiBody.cabin.roofRear).railY - taxiLayout.cabin(taxiBody.cabin.deck).beltY;
  const backlightRun = Math.abs(taxiBody.cabin.deck - taxiBody.cabin.roofRear);
  const backlightAngle = angleFromVertical(backlightRise, backlightRun);
  assert.ok(backlightAngle > 35 && backlightAngle < 70, `fastback backlight is strongly raked, got ${backlightAngle.toFixed(1)}°`);
  const tailSection = taxiLayout.body(taxiBody.zRear);
  assert.ok(tailSection.yT - tailSection.yB > 0.45, 'rear face is big enough for lamps and the plate');
  // 尾灯在尾部两侧靠上，位于车牌上方并落在后脸高度范围内
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
