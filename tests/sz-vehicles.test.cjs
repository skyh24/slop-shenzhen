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

  // 深圳出租采用高顶两厢轮廓，车轮和车身仍用同一剖面。
  const taxiSpec = models.VEHICLE_SPECS.taxi;
  const taxiBody = cars.BODY_SPECS.taxi;
  const taxiLayout = cars.carLayout(taxiBody);
  const angleFromVertical = (rise, run) => Math.atan2(Math.abs(run), rise) * 180 / Math.PI;
  assert.ok(taxiSpec.length > 4.85 && taxiSpec.length < 4.95, `taxi length ${taxiSpec.length}`);
  assert.ok(taxiSpec.width > 1.9 && taxiSpec.width < 1.95, `taxi width ${taxiSpec.width}`);
  assert.ok(taxiSpec.height > 1.68 && taxiSpec.height < 1.77, `taxi height ${taxiSpec.height}`);
  assert.ok(taxiSpec.wheelbase > 2.88 && taxiSpec.wheelbase < 2.92, `taxi wheelbase ${taxiSpec.wheelbase}`);
  assert.ok(taxiSpec.radius > 0.355 && taxiSpec.radius < 0.37, `taxi wheel radius ${taxiSpec.radius}`);
  assert.ok(taxiBody.cabin.roofRear < -1.9 && taxiBody.cabin.rail[1] > 0.66, 'roof stays high and wide over the hatch');
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
  assert.ok(taxiLayout.body(-2.35).W - taxiLayout.body(-2.35).xE < 0.09,
    'the hatch shoulder follows the glass without a wide ledge');
  // 低矮圆润前脸：长收圆 + 大 rake，机舱盖低、风挡大倾角
  const noseFront = cars.carTipZ(taxiBody, 0.95, true);
  const noseBumper = cars.carTipZ(taxiBody, 0.6, true);
  assert.ok(noseBumper - noseFront > 0.12, `raked nose: bumper ${noseBumper.toFixed(2)} vs hood line ${noseFront.toFixed(2)}`);
  assert.ok(taxiLayout.body(2.1).yE < 0.95, `low bonnet line ${taxiLayout.body(2.1).yE.toFixed(2)}`);
  assert.ok(taxiLayout.body(1.8).yE >= 0.93, 'the nose meets the higher hood');
  const sideWindowBase = Array.from({ length: 17 }, (_, i) => taxiLayout.cabin(1.06 - i * 0.20).beltY);
  assert.ok(Math.max(...sideWindowBase) - Math.min(...sideWindowBase) < 0.012,
    'the window belt is level from the front door to the rear quarter');
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
  for (const detail of [1, 0]) {
    const shell = cars.buildBodyLoft(taxiBody, detail);
    const { position, partId } = shell.attributes;
    const neighbors = Array.from({ length: position.count }, () => []);
    for (let i = 0; i < shell.index.count; i += 3) {
      const [a, b, c] = shell.index.array.slice(i, i + 3);
      if ([a, b, c].some(v => partId.getX(v) !== 0)) continue;
      neighbors[a].push(b, c);
      neighbors[b].push(a, c);
      neighbors[c].push(a, b);
    }
    const isRear = i => position.getZ(i) < -1.5 && Math.abs(position.getX(i)) > 0.56;
    const roof = neighbors.findIndex((links, i) => links.length && isRear(i) && position.getY(i) > 1.55);
    assert.ok(roof >= 0, 'the high rear roof is part of the exterior');
    const seen = new Set([roof]);
    const pending = [roof];
    for (const point of pending) {
      for (const next of neighbors[point]) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    assert.ok([...seen].some(i => isRear(i) && position.getY(i) < 0.95),
      'the rear roof and tail shoulder share connected exterior faces');
    shell.dispose();
  }
  const midSection = taxiLayout.body(0);
  assert.ok(midSection.W - midSection.xE > 0.08, 'side glass sits in from the widest point (convex shoulder, no vertical slab)');
  assert.ok(midSection.W - midSection.xE <= 0.13, 'tumblehome stays small so the cabin is wide too (upper and lower body widened together)');
  // 大曲面玻璃房 + 细 A/B/C 柱
  assert.ok(taxiBody.cabin.bulge >= 0.015, 'side glass is curved outward');
  assert.ok(taxiBody.cabin.pillars.length >= 2 && taxiBody.pillarWidth <= 0.03, 'slim B/C pillars');
  const glassHeight = taxiLayout.cabin(0).railY - taxiLayout.belt.cowl.y;
  assert.ok(glassHeight > 0.32, `large side glass, ${glassHeight.toFixed(2)} m tall`);
  // 后窗下缘要贴着尾门，不能留下三厢尾箱或悬空的玻璃。
  assert.equal(taxiBody.cabin.deck, taxiBody.zRear, 'the hatch profile closes at the same station as the tail face');
  const backlightRise = taxiLayout.cabin(taxiBody.cabin.roofRear).railY - taxiLayout.cabin(taxiBody.cabin.deck).beltY;
  const backlightRun = Math.abs(taxiBody.cabin.deck - taxiBody.cabin.roofRear);
  const backlightAngle = angleFromVertical(backlightRise, backlightRun);
  assert.ok(backlightAngle > 18 && backlightAngle < 36, `hatchback rear window angle ${backlightAngle.toFixed(1)}°`);
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

  // 玩家出租车保留完整车身和纽约原版深色车窗材质。
  const playerTaxi = models.createShenzhenCarMesh({ type: 'taxi' });
  const seat = playerTaxi.seat;
  assert.ok(seat && seat.pelvis && seat.feet.length === 2 && seat.hands.length === 2, 'player taxi exposes a driver seat');
  assert.ok(seat.pelvis.y > 0.5 && seat.pelvis.y < 0.8, `pelvis sits on the cushion (${seat.pelvis.y})`);
  for (const foot of seat.feet) assert.ok(foot.z > seat.pelvis.z + 0.3 && foot.y < seat.pelvis.y, 'feet reach into the footwell');
  for (const hand of seat.hands) assert.ok(hand.z > seat.pelvis.z + 0.25 && hand.y > seat.pelvis.y, 'hands reach the wheel');
  const cockpit = playerTaxi.chassis.getObjectByName('player-taxi-cockpit');
  assert.ok(cockpit, 'player taxi has a visible driver cockpit');
  assert.ok(playerTaxi.chassis.getObjectByName('player-taxi-cockpit'), 'driver cockpit is present');
  const bodyMesh = playerTaxi.chassis.getObjectByName('taxi-lofted-body');
  const closedBody = cars.buildCarGeometry(cars.BODY_SPECS.taxi, false);
  assert.ok(closedBody.attributes.partId.array.every(id => id !== 1), 'glazing is painted on the same exterior');
  assert.deepEqual(bodyMesh.geometry.index.array, closedBody.index.array, 'player taxi keeps the complete lofted body and roof');
  assert.equal(bodyMesh.material.transparent, false, 'the exterior uses opaque dark glazing');
  assert.equal(bodyMesh.material, cars.createLoftedCarMaterial(cars.BODY_SPECS.taxi, models.PALETTE.taxiBlue));
  assert.equal(models.createTrafficCarBody('taxi').material.transparent, false, 'ambient taxi glass stays opaque');
  closedBody.dispose();
  playerTaxi.dispose();

  // 四旋翼：座位锚点 + 内置飞行员可整组隐藏（玩家登机后换成同一角色）。
  const occupied = models.createEvtolMesh();
  assert.ok(occupied.seat && occupied.seat.pelvis, 'eVTOL exposes a pilot seat');
  const pilotGroup = occupied.group.getObjectByName('pilot');
  assert.ok(pilotGroup && pilotGroup.visible, 'empty eVTOL shows its built-in pilot');
  occupied.setOccupantVisible(false);
  assert.equal(pilotGroup.visible, false, 'boarding hides the built-in pilot');
  occupied.setOccupantVisible(true);
  assert.equal(pilotGroup.visible, true);
  occupied.dispose();
  const emptyCargo = models.createCargoDroneMesh();
  assert.equal(emptyCargo.seat, null, 'cargo drone has no passenger seat');
  emptyCargo.dispose();
});
