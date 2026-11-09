const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const source = read('sz-vehicles.js');
const imports = {
  'three/webgpu': { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } } },
  'three/addons/geometries/LoftGeometry.js': {},
  'three/addons/utils/BufferGeometryUtils.js': {},
  './sz-strings.js': {},
  './vehicles.js': {}
};
const { VEHICLE_SPECS, wheelArchTop, rotorSweep } = loadModule(
  source + '\nexport { wheelArchTop, rotorSweep };', { imports }
);

test('wheel cutouts follow the same axle centers and radius as the visible tires', () => {
  for (const spec of Object.values(VEHICLE_SPECS)) {
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
  const models = loadModule(source, { imports: {
    ...imports,
    'three/webgpu': THREE,
    'three/addons/geometries/LoftGeometry.js': loft,
    'three/addons/utils/BufferGeometryUtils.js': buffers,
    './sz-strings.js': { STR: {} },
    './vehicles.js': vehicles
  } });

  for (const type of ['taxi', 'sedan', 'suv', 'bus']) {
    const model = type === 'bus' ? models.createShenzhenBusMesh() : models.createShenzhenCarMesh({ type });
    assert.equal(model.wheels.length, 4);
    assert.ok(Math.abs(model.bounds.min.y) < 1e-6);
    const [frontLeft, frontRight, rearLeft] = model.wheels;
    assert.equal(frontLeft.steerPivot.position.z - rearLeft.steerPivot.position.z, model.spec.wheelbase);
    assert.equal(frontLeft.tire.children[0].geometry, frontRight.tire.children[0].geometry);
    if (model.chassis) {
      model.group.updateMatrixWorld(true);
      for (const { steerPivot } of model.wheels) {
        const side = Math.sign(steerPivot.position.x);
        const ray = new THREE.Raycaster(new THREE.Vector3(side * 2, model.spec.radius * 1.95, steerPivot.position.z),
          new THREE.Vector3(-side, 0, 0));
        const hits = ray.intersectObject(model.chassis, true);
        assert.ok(hits.length > 0, 'the inner wheel well remains closed');
        assert.ok(hits[0].point.x * side < model.spec.track / 2 - model.spec.tireWidth / 2,
          'the body does not occupy the tire slot');
      }
    }
    model.dispose();

    const fleet = models.createTrafficVehicleGeometry({ type });
    fleet.computeBoundingBox();
    assert.ok(Math.abs(fleet.boundingBox.min.y) < 1e-6);
    assert.equal(fleet.attributes.color.count, fleet.attributes.position.count);
    assert.ok(fleet.index.count / 3 < 3500);
    fleet.dispose();
  }

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
});
