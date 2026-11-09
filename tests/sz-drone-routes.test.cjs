const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const load = (name, imports = {}) => loadModule(read(name), { imports });
const terrain = load('sz-terrain.js');
const droneRoutes = load('sz-drone-routes.js', { 'three/webgpu': {}, './sz-terrain.js': terrain });

const air = {
  version: 3,
  verifiedAt: '2026-11-09',
  status: 'source-endpoints-schematic-tracks',
  droneStations: [
    { id: 'a', name: 'A 站', operator: '美团无人机', kind: 'takeoff', x: 0, z: 0,
      coordinateSource: 'test', sourceUrls: ['https://example.com/a'], verifiedAt: '2026-11-09' },
    { id: 'b', name: 'B 站', operator: '美团无人机', kind: 'landing', x: 300, z: 400,
      coordinateSource: 'test', sourceUrls: ['https://example.com/b'], verifiedAt: '2026-11-09' }
  ],
  droneRoutes: [
    { id: 'route-1', name: 'A ⇄ B', operator: '美团无人机', fromStationId: 'a', toStationId: 'b',
      lengthM: 500, trackStatus: 'schematic', altitudeM: 100, altitudeSource: 'estimate',
      sourceUrls: ['https://example.com/a'], sourcePublisher: 'test', sourcePublishedAt: '2023-09-04',
      verifiedAt: '2026-11-09' }
  ],
  apecSuspension: {
    windows: [{ from: '2026-11-07', to: '2026-11-21', areas: 'test', sourceUrl: 'https://example.com/notice' }],
    operatorNotice: { text: '停运', sourceUrl: 'https://example.com/notice' }
  }
};

test('drone plan keeps sourced endpoints and marks schematic tracks', () => {
  const plan = droneRoutes.planDroneFlights(air, { now: new Date('2026-11-01T00:00:00+08:00') });
  assert.equal(plan.routes.length, 1);
  assert.equal(plan.suspended, false);
  const [route] = plan.routes;
  assert.equal(route.from.id, 'a');
  assert.equal(route.to.id, 'b');
  assert.equal(route.lengthM, 500);
  assert.equal(route.altitudeM, 100);
  assert.equal(route.altitudeSource, 'estimate');
  assert.equal(route.flights.length, 2);
  assert.ok(route.flights.every(flight => flight.speedMps > 0 && flight.phase >= 0 && flight.phase < 1));
  assert.ok(droneRoutes.isApecAirSuspended(air, new Date('2026-11-08T12:00:00+08:00')));
  assert.ok(droneRoutes.isApecAirSuspended(air, new Date('2026-11-21T23:00:00+08:00')));
  assert.equal(droneRoutes.isApecAirSuspended(air, new Date('2026-11-22T00:00:00+08:00')), false);
  assert.equal(droneRoutes.isApecAirSuspended(air, new Date('2026-11-06T23:59:00+08:00')), false);
});

test('drone plan drops routes whose station is missing instead of inventing one', () => {
  const broken = { ...air, droneRoutes: [{ ...air.droneRoutes[0], toStationId: 'missing' }] };
  const plan = droneRoutes.planDroneFlights(broken, { now: new Date('2026-11-01T00:00:00+08:00') });
  assert.equal(plan.routes.length, 0);
});

test('real drone module builds, flies when open and parks during APEC control', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const realModule = loadModule(read('sz-drone-routes.js'), { imports: { 'three/webgpu': THREE, './sz-terrain.js': terrain } });
  const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 0.1, heights: [100, 100, 100, 100] };
  const scene = new THREE.Scene();
  const openAir = realModule.buildSzDroneRoutes(scene, { air, terrain: grid, now: new Date('2026-11-01T00:00:00+08:00') });
  assert.equal(openAir.statistics.routes, 1);
  assert.equal(openAir.statistics.flights, 2);
  assert.equal(openAir.statistics.suspended, false);
  openAir.update(0.016);
  const flying = openAir.group.children.filter(child => child.type === 'Group' && child.children.length > 5);
  assert.ok(flying.length >= 2, 'two drone models exist');
  const firstY = flying[0].position.y;
  assert.ok(firstY > 100, 'drone cruises above terrain');
  const suspendedAir = realModule.buildSzDroneRoutes(scene, { air, terrain: grid, now: new Date('2026-11-12T00:00:00+08:00') });
  assert.equal(suspendedAir.statistics.suspended, true);
  suspendedAir.update(0.016);
  const parked = suspendedAir.group.children.filter(child => child.type === 'Group' && child.children.length > 5);
  assert.ok(parked.length >= 2);
  assert.ok(parked.every(group => Math.abs(group.position.z - air.droneStations[0].z) < 1e-6
    && group.position.x === air.droneStations[0].x), 'suspended drones wait at the takeoff station');
  openAir.dispose();
  suspendedAir.dispose();
  assert.equal(openAir.group.parent, null);
});
