const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/sz-drone-routes.js'), 'utf8');
const air = {
  droneStations: [
    { id: 'a', name: 'A', x: 0, z: 0, coordinatePrecisionM: 20 },
    { id: 'b', name: 'B', x: 300, z: 0, coordinatePrecisionM: 20 }
  ],
  droneRoutes: [{ id: 'route-1', fromStationId: 'a', toStationId: 'b',
    trackStatus: 'schematic', altitudeM: 100, altitudeSource: 'estimate' }],
  apecSuspension: { windows: [{ from: '2026-11-07', to: '2026-11-21' }] }
};
const site = {
  obstacles: [], isWater: () => false, roadHeight: () => null,
  heightAt: () => 8, flightHeightAt: () => 8
};
const terrain = loadModule(readFileSync(join(__dirname, '../js/sz-terrain.js'), 'utf8'));
const load = (THREE = {}, createCargoDroneMesh) => loadModule(source, {
  imports: { 'three/webgpu': THREE, './sz-vehicles.js': { createCargoDroneMesh }, './sz-strings.js': { STR: {} }, './sz-terrain.js': terrain }
});
const pkg = process.env.SZ_THREE_PACKAGE_DIR;
const realThree = () => import(pathToFileURL(join(pkg, 'build/three.webgpu.js')));

test('APEC date boundaries follow Shenzhen midnight throughout an existing browser session', () => {
  const { isApecAirSuspended } = load();
  assert.equal(isApecAirSuspended(air, '2026-11-06T15:59:59Z'), false);
  assert.equal(isApecAirSuspended(air, '2026-11-06T16:00:00Z'), true);
  assert.equal(isApecAirSuspended(air, '2026-11-21T15:59:59Z'), true);
  assert.equal(isApecAirSuspended(air, '2026-11-21T16:00:00Z'), false);
});

test('station placement preserves provenance and rejects water, roads and canopy', { skip: !pkg }, async () => {
  const { planDroneFlights } = load(await realThree());
  const canopy = { minX: -5, maxX: 5, minZ: -5, maxZ: 5, minY: 12, maxY: 30 };
  const { stations, routes } = planDroneFlights(air, {
    ...site, obstacles: [canopy], isWater: (x, z) => x < -2,
    roadHeight: (x, z) => z < -2 ? 8 : null
  });
  const [a] = stations;
  assert.equal(a.available, true);
  assert.equal(a.sourceX, 0);
  assert.equal(a.sourceZ, 0);
  assert.equal(a.positionSource, 'scene-estimate');
  assert.ok(a.offsetM > 5 && a.offsetM <= 20);
  assert.ok(a.x >= -2 && a.z >= -2 && a.y > 8);
  assert.equal(routes[0].trackStatus, 'schematic');
  const closed = planDroneFlights(air, { ...site, isWater: x => x < 100 });
  assert.equal(closed.routes[0].path.reason, 'no-safe-station');
  assert.equal(closed.stations[0].available, false);
  const missing = planDroneFlights({ ...air, droneStations: [air.droneStations[0]] }, site);
  assert.equal(missing.routes[0].path.reason, 'no-safe-station');
});

test('route clearance covers narrow building obstacles and enforces the ceiling', { skip: !pkg }, async () => {
  const { planDroneFlights } = load(await realThree());
  const tower = { minX: 150.55, maxX: 150.8, minZ: -0.5, maxZ: 0.5, minY: 8, maxY: 160 };
  const [route] = planDroneFlights(air, { ...site, obstacles: [tower],
    flightHeightAt: x => x > 100 && x < 120 ? 150 : 8 }).routes;
  assert.equal(route.path.cruiseY, 176);
  const [closed] = planDroneFlights(air, { ...site, obstacles: [{ ...tower, maxY: 245 }] }).routes;
  assert.equal(closed.path.reason, 'cruise-ceiling');
  const [unknown] = planDroneFlights(air, { ...site, flightHeightAt: () => null }).routes;
  assert.equal(unknown.path.reason, 'unknown-terrain');
});

test('each end can dispatch a continuous round trip on the displayed polyline', { skip: !pkg }, async () => {
  const THREE = await realThree();
  const { dronePoseAt, planDroneFlights } = load(THREE);
  const [route] = planDroneFlights(air, site).routes;
  const { path } = route;
  assert.equal(path.points[0].y, route.from.y);
  assert.equal(path.points.at(-1).y, route.to.y);
  for (const fromEnd of [false, true]) {
    const origin = fromEnd ? path.points.at(-1) : path.points[0];
    const destination = fromEnd ? path.points[0] : path.points.at(-1);
    const deliveries = new Set();
    const phases = new Set();
    const sample = { position: new THREE.Vector3() };
    const prev = origin.clone();
    const edge = new THREE.Line3();
    const closest = new THREE.Vector3();
    for (let t = 0; t < 2 * path.seconds + 16; t += 0.1) {
      const pose = dronePoseAt(path, fromEnd, t, sample);
      phases.add(pose.phase);
      assert.ok(prev.distanceTo(pose.position) <= 2.001);
      assert.ok(path.points.slice(1).some((point, i) => edge.set(path.points[i], point)
        .closestPointToPoint(pose.position, true, closest).distanceToSquared(pose.position) < 1e-12));
      if (pose.phase === 'delivery') {
        assert.ok(destination.equals(pose.position));
        deliveries.add(pose.delivered);
      }
      if (pose.returning) assert.equal(pose.cargo, false);
      prev.copy(pose.position);
    }
    assert.deepEqual([...phases], ['loading', 'takeoff', 'cruise', 'descent', 'delivery', 'complete']);
    assert.deepEqual([...deliveries], [false, true]);
    assert.ok(origin.equals(prev));
  }
});

test('suspended operations, manual simulation, following visibility and disposal stay independent', { skip: !pkg }, async () => {
  const THREE = await realThree();
  let releases = 0;
  const module = load(THREE, () => {
    const group = new THREE.Group();
    const cargoBox = new THREE.Group();
    group.add(cargoBox);
    return { group, cargoBox, statusLight: new THREE.Group(), bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)),
      update() {}, dispose() { releases++; } };
  });
  const scene = new THREE.Scene();
  let now = '2026-11-06T15:59:00Z';
  const system = module.buildSzDroneRoutes(scene, { air, site, clock: () => new Date(now) });
  const [a, b] = system.stations;
  const line = system.group.children.find(child => child.isLine);
  const aircraft = system.group.getObjectByName('route-1:drone');
  assert.equal(line.visible, false);
  assert.equal(aircraft.visible, false);
  system.preview(a.id);
  assert.equal(line.visible, true);
  assert.equal(line.geometry.attributes.position.count, system.routes[0].path.points.length);
  assert.equal(system.start(a.id, false, b), null);
  const normal = system.start(b.id, false, a, { remote: true });
  assert.equal(normal.stationId, b.id);
  assert.ok(normal.pose.position.equals(new THREE.Vector3(b.x, b.y, b.z)));
  now = '2026-11-06T16:00:00Z';
  system.update(0.05);
  assert.equal(system.isActive(normal), false);
  assert.equal(aircraft.visible, false);
  assert.equal(system.start(a.id, false, a), null);
  assert.equal(system.start(a.id, false, b, { remote: true }), null);
  const demo = system.start(a.id, true, b, { remote: true });
  assert.equal(system.status(b.id, b).mission, demo);
  assert.equal(system.start(b.id, true, b), demo);
  assert.equal(demo.stationId, a.id);
  const far = new THREE.Vector3(8000, 8000, 8000);
  system.update(0.05, far);
  assert.equal(aircraft.visible, true);
  system.preview(null);
  assert.equal(line.visible, true);
  system.stopFollowing();
  system.update(0.05, far);
  assert.equal(aircraft.visible, false);
  assert.equal(line.visible, false);
  assert.equal(system.start(a.id, true, a), demo);
  let geometryReleases = 0;
  const geometries = new Set();
  system.group.traverse(({ geometry }) => { if (geometry) geometries.add(geometry); });
  for (const geometry of geometries) geometry.addEventListener('dispose', () => geometryReleases++);
  system.dispose();
  system.dispose();
  assert.equal(geometryReleases, geometries.size);
  assert.equal(system.isActive(demo), false);
  assert.equal(system.start(a.id, true, a), null);
  assert.equal(releases, 1);
  assert.equal(system.group.parent, null);
  assert.equal(system.group.children.length, 0);
});

test('camera ray shortens against thin obstacles and uphill terrain', { skip: !pkg }, async () => {
  const THREE = await realThree();
  const { cameraClearFraction } = load(THREE);
  const a = new THREE.Vector3(0, 1, 0), b = new THREE.Vector3(8, 2, 0);
  assert.equal(cameraClearFraction(a, b, [], () => 0), 1);
  const wall = { minX: 4, maxX: 4.1, minZ: -1, maxZ: 1, minY: 0, maxY: 3 };
  assert.ok(cameraClearFraction(a, b, [wall], () => 0) < 0.5);
  assert.ok(cameraClearFraction(a, b, [], x => x < 2 ? 0 : 3) < 0.3);
});

test('watching restores the same player after Escape and uses a safe fallback after loss', () => {
  const source = readFileSync(join(__dirname, '../js/sz-drone-watch.js'), 'utf8');
  const strings = loadModule(readFileSync(join(__dirname, '../js/sz-strings.js'), 'utf8'));
  const sessions = loadModule(readFileSync(join(__dirname, '../js/sz-observation-session.js'), 'utf8'));
  const nodes = new Map();
  const document = { body: { dataset: {} }, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, addEventListener(type, listener) { this[type] = listener; }, focus() {} });
    return nodes.get(id);
  } };
  const window = { addEventListener(type, listener) { this[type] = listener; } };
  const { wireDroneWatch } = loadModule(source, { imports: { './sz-strings.js': strings, './sz-observation-session.js': sessions },
    globals: { document, window, setTimeout: () => 1, clearTimeout() {} } });
  const person = { position: { x: 8, y: 4, z: 6 }, heading: 2, speed: 0 };
  const original = structuredClone(person);
  const station = { id: 'a', approach: { x: 11, y: 4, z: 6, heading: 1 } };
  const mission = { pose: { phase: 'cruise' }, demo: true };
  let safety = true, active = true, fallback;
  const camera = { startDroneFollow(pose) { this.target = pose; }, stopDroneFollow() { this.target = null; },
    updateDroneFollow: () => true, getActivePreset: () => ({ name: 'Prior camera' }), resetForTeleport() {} };
  const touch = { setEnabled(enabled) { this.enabled = enabled; } };
  const labels = [];
  const watch = wireDroneWatch({
    drones: { stations: [station], routes: [], start: () => mission, isActive: () => active, stopFollowing() {} },
    controllerManager: { activeMode: 'person', getActiveEntity: () => person, occupant: { timer: 0 },
      resetInput() {}, findModePosition: () => safety,
      teleportActiveTo(x, z) { fallback = { x, z }; return fallback; } },
    cameraSystem: camera, touchControls: touch, gamepadControls: { reset() {} },
    laneAssist: { cancel() {} }, autoDrive: { active: false }, observationSessions: sessions.createObservationSessions(),
    closePopovers() {}, mapOpen: () => false, teleport() {}, onCameraLabel: label => labels.push(label)
  });
  assert.equal(watch.map.follow(station, true), true);
  assert.equal(watch.update(0.05), true);
  assert.equal(camera.target, mission.pose);
  assert.equal(touch.enabled, false);
  window.keydown({ code: 'Escape' });
  assert.deepEqual(person, original);
  assert.equal(watch.active, false);
  assert.equal(touch.enabled, true);
  assert.equal(camera.target, null);
  assert.equal(labels.at(-1), 'Prior camera');
  assert.equal(watch.map.follow(station, true), true);
  active = safety = false;
  assert.equal(watch.update(0.05), false);
  assert.deepEqual(fallback, { x: 11, z: 6 });
  assert.equal(watch.active, false);
  assert.equal(nodes.get('drone-follow-exit').hidden, true);
  assert.equal(nodes.get('drone-follow-status').textContent, strings.STR.drones.failed);
});
