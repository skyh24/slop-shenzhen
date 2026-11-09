const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const load = (file, imports = {}) => loadModule(read(file), { imports });
const signalApi = load('sz-intersection-control.js');
const { createAutoDrive, hasRoadFootprint } = load('sz-auto-drive.js', { './sz-intersection-control.js': signalApi });
const model = { hx: 1.1, hz: 2.4, x: 0, z: 0, halfWheelbase: 1.4, halfTrack: 0.77,
  corners: [[-1.1, -2.4], [-1.1, 2.4], [1.1, -2.4], [1.1, 2.4]] };
const surface = load('sz-controller-surfaces.js');
const roads = load('sz-roads.js', { 'three/webgpu': {} });
const collision = load('building-collision.js');
const traffic = load('sz-traffic.js', { 'three/webgpu': {}, './sz-intersection-control.js': signalApi,
  './sz-roads.js': roads, './sz-vehicles.js': {}, './building-collision.js': collision, './vehicle-physics.js': {} });
const { createDrivePlanner, createTurnFilter } = load('sz-drive-route.js', {
  './sz-intersection-control.js': signalApi, './sz-traffic.js': traffic
});

const groundRoad = id => ({ osmId: `way/${id}`, heightSource: 'terrain', layer: 0, bridge: false, tunnel: false });
const rule = (restriction, from, to, via, viaWays = []) => ({ osmId: 'relation/1', restriction,
  fromWayId: `way/${from}`, toWayIds: [`way/${to}`], viaNodeId: `node/${via}`, viaWayIds: viaWays });

test('route planning respects directed links, actual pavement, and source turn restrictions', () => {
  const graph = { nodes: [0, 0, 75, 0, 150, 0, 225, 0, 75, 55], nodeIds: ['node/1', 'node/2', 'node/3', 'node/4', 'node/5'],
    names: ['Road'], links: [[0, 1, 0, 10, 2, 1, []], [1, 2, 0, 10, 2, 1, []], [2, 3, 0, 10, 2, 1, []], [1, 4, 0, 10, 2, 1, []]],
    metadata: [groundRoad(1), groundRoad(2), { ...groundRoad(3), bridge: true, heightSource: 'unresolved' }, groundRoad(4)],
    turnRestrictions: { rules: [rule('only_straight_on', 1, 2, 2)] } };
  const ground = (x, z) => (x >= 0 && x <= 150 && Math.abs(z) <= 5) || (Math.abs(x - 75) <= 5 && z <= 55 && z >= 0) ? 3 : null;
  const network = traffic.createTrafficGraph(graph);
  const routeWith = roadHeight => createDrivePlanner(network, graph, { model, roadHeight, isClear: () => true });
  const planner = routeWith(ground);
  const start = planner.snap(10, 0), end = planner.snap(142, 0);
  const route = planner.route(start, end);
  assert.ok(Math.abs(route.length - 132) < 1e-5);
  assert.deepEqual(Array.from(route.edges, edge => edge.osmId), ['way/1', 'way/2']);
  assert.equal(planner.route(end, start), null);
  assert.equal(planner.route(start, planner.snap(75, 48)), null);
  assert.equal(planner.snap(208, 0), null);
  const gap = routeWith((x, z) => x > 62 && x < 66 ? null : ground(x, z));
  assert.equal(gap.route(gap.snap(10, 0), gap.snap(142, 0)), null);
  assert.equal(createTurnFilter({ ...graph, turnRestrictions: { rules: [rule('no_left_turn', 1, 4, 2, ['way/2'])] } })(
    network.edges[0], network.edges[1]), false);
});

test('starting is explicit and signal occupancy survives manual takeover inside the intersection', () => {
  const graph = { nodes: [-30, 0, 12, 0, 65, 0], nodeIds: ['node/1', 'node/2', 'node/3'], names: ['Road'],
    links: [[0, 1, 0, 10, 2, 1, []], [1, 2, 0, 10, 2, 1, []]], metadata: [groundRoad(1), groundRoad(2)] };
  const control = signalApi.createIntersectionControl({ intersections: [{ id: 'test', bounds: [-3, -5, 22, 5], approaches: [
    { osmNodeId: 50, osmWayId: 'way/1', fromNodeId: 'node/1', toNodeId: 'node/2', group: 0, stopX: 0, stopZ: 0, dx: 1, dz: 0, widthM: 10 }
  ] }] }, graph);
  const roadHeight = (x, z) => x >= -30 && x <= 65 && Math.abs(z) <= 5 ? 2 : null;
  const planner = createDrivePlanner(traffic.createTrafficGraph(graph), graph, { model, control, roadHeight, isClear: () => true });
  const route = planner.route(planner.snap(-22, 0), planner.snap(54, 0));
  assert.equal(route.stops.length, 1);
  assert.ok(route.stops[0].clearS > route.stops[0].s);
  const narrowGap = createDrivePlanner(traffic.createTrafficGraph(graph), graph, { model, control, roadHeight,
    isClear: pose => pose.x <= 4.3 || pose.x >= 4.52 });
  assert.equal(narrowGap.route(narrowGap.snap(-22, 0), narrowGap.snap(54, 0)), null);
  assert.equal(planner.snap(10, 0), null, 'this approach has no nearby validated arrival outside the conflict rectangle');
  const trafficBodies = [];
  const auto = createAutoDrive({ model, control, roadHeight, nearTraffic: () => trafficBodies });
  const car = { position: { x: -25, z: 0, y: 2 }, heading: Math.PI / 2, speed: 0 };
  assert.equal(auto.start(route, car, 'car'), false);
  assert.equal(car.position.x, -25);
  car.position.x = route.from.x;
  assert.equal(auto.start(route, car, 'person'), false);
  assert.equal(auto.start(route, car, 'car'), true);
  const approach = route.stops[0].approach;
  assert.equal(control.enter(approach, 0, 'traffic-ahead'), true);
  const tick = (elapsed, manual = false) => auto.update(car, { dt: 1 / 60, elapsed, mode: 'car', manual });
  for (const x of [-17, -10, -4]) {
    car.position.x = x;
    assert.ok(tick(4));
  }
  const red = tick(4);
  assert.equal(red.permitMove(-2, 0, car.heading), false);
  assert.equal(auto.status, 'signal');
  const occupied = tick(8);
  assert.equal(occupied.permitMove(-2, 0, car.heading), false);
  assert.equal(auto.status, 'intersection');
  control.release(approach, 'traffic-ahead');
  trafficBodies.push({ x: 22, z: 0, sin: 1, cos: 0, halfW: 1.2, halfL: 3.1, minY: 2, maxY: 4 });
  assert.equal(tick(8).permitMove(-2, 0, car.heading), false, 'a stopped vehicle blocks an otherwise open green exit');
  trafficBodies.length = 0;
  const green = tick(8);
  assert.equal(green.permitMove(-2, 0, car.heading), true);
  car.position.x = 6;
  assert.equal(tick(8.5, true), null);
  assert.equal(auto.status, 'manual');
  const opposing = { ...route.stops[0].approach, group: 1 };
  tick(12);
  assert.equal(control.canEnter(opposing, 12, 'opposing'), false);
  car.position.x = 30;
  tick(12.5);
  assert.equal(control.canEnter(opposing, 12.5, 'opposing'), true);
  assert.equal(auto.statistics.signalEntries, 1);
  assert.equal(auto.statistics.intersectionWaits, 1);
});

test('the player car uses existing physics on the sourced eastbound Shennan signal approach', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const control = signalApi.createIntersectionControl(geo.roadFrontage, geo.roadGraph);
  assert.equal(geo.roadGraph.turnRestrictions.source, 'osm-guangdong');
  const { chunks } = roads.createRoadSurfaceLayout(geo.roadGraph, geo.terrainSurface);
  const roadHeight = roads.createRoadHeightSampler(chunks, geo.terrainSurface.grid);
  const groundHeight = load('sz-ground.js', { 'three/webgpu': {}, 'three/tsl': {} }).createGroundSurfaceSampler(geo.terrainSurface);
  const { ThirdPersonControllerManager } = load('controllers.js', { 'three/webgpu': {}, './sz-city-config.js': {
    ISLAND_BOUNDS: { minX: geo.bounds[0], minZ: geo.bounds[1], maxX: geo.bounds[2], maxZ: geo.bounds[3] }
  }, './sz-controller-surfaces.js': surface, './sz-park-arrivals.js': {}, './sz-strings.js': {}, './city-lighting-materials.js': {},
  './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } }, './pedestrians.js': {},
  './vehicle-lights.js': {}, './building-collision.js': collision });
  const bounds = { min: { x: -model.hx, y: 0, z: -model.hz }, max: { x: model.hx, y: 1.81, z: model.hz } };
  const car = { type: 'car', collisionBounds: bounds, chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: [],
    position: {}, speed: 0, vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0, steerAngle: 0, wheelSpin: 0 };
  const controller = Object.assign(Object.create(ThirdPersonControllerManager.prototype), { entities: { car }, activeMode: 'car', keys: {},
    groundHeight, surfaceResolver: surface.createSurfaceResolver({ groundHeight }), colliders: [] });
  const planner = createDrivePlanner(traffic.createTrafficGraph(geo.roadGraph), geo.roadGraph, { model, roadHeight, control,
    detailedRoadIds: geo.roadFrontage.corridors.flatMap(corridor => corridor.roadIds), isClear: p => controller.isClearCarPose(p) });
  const route = planner.route(planner.snap(-5423, 1183), planner.snap(-5150, 1132));
  assert.deepEqual(Array.from(route.stops, stop => stop.approach.osmNodeId), [8894987731]);
  const { x, z, dx, dz } = route.from;
  const y = groundHeight(x, z);
  Object.assign(car, { position: { x, y, z }, heading: Math.atan2(dx, dz), _safePosition: { x, y, z }, _support: { height: y, surfaceId: 'terrain' } });
  const auto = createAutoDrive({ model, roadHeight, control });
  assert.equal(auto.start(route, car, 'car'), true);
  for (let frame = 0; frame < 3000 && auto.active; frame++) {
    const input = auto.update(car, { dt: 1 / 60, elapsed: 2.8 + frame / 60, mode: 'car', manual: false });
    if (input) controller.updateCar(1 / 60, input);
    assert.ok(hasRoadFootprint(roadHeight, model, car.position.x, car.position.z, car.heading));
  }
  assert.equal(auto.status, 'arrived');
  assert.ok(Math.hypot(car.position.x - route.to.x, car.position.z - route.to.z) < 0.7);
  assert.equal(auto.statistics.signalEntries, 1);
  assert.ok(auto.statistics.signalWaits > 0);
  assert.ok(car.speed < 0.15);
});
