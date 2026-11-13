const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');
const { runInNewContext } = require('node:vm');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const load = (file, imports = {}) => loadModule(read(file), { imports });
const signalApi = load('sz-intersection-control.js');
const sections = load('sz-road-section.js');
const surface = load('sz-controller-surfaces.js');
const roads = load('sz-roads.js', { 'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) } });
const collision = load('building-collision.js', { './sz-polygon.js': polygonModule });
const traffic = load('sz-traffic.js', { 'three/webgpu': {}, './sz-intersection-control.js': signalApi,
  './sz-roads.js': roads, './sz-road-section.js': sections,
  // 路线规划只用到 sz-traffic 的纯函数；车队涂装用到的 carStyleCode 给一个等价替身。
  './sz-vehicles.js': { carStyleCode: ({ livery = 0, metallic = 0, trim = 0, wheel = 0 }) =>
    (livery & 7) + ((metallic & 1) << 3) + ((trim & 3) << 4) + ((wheel & 3) << 6) },
  './building-collision.js': collision, ...driving });
const { createAutoDrive, hasRoadFootprint } = load('sz-auto-drive.js', {
  './sz-intersection-control.js': signalApi, './sz-traffic.js': traffic, ...driving
});
const { createDrivePlanner, createTurnFilter } = load('sz-drive-route.js', {
  './sz-intersection-control.js': signalApi, './sz-traffic.js': traffic, './sz-road-section.js': sections
});
const bounds = { min: { x: -1.1, y: 0, z: -2.4 }, max: { x: 1.1, y: 1.81, z: 2.4 } };
const model = traffic.trafficModelBounds(bounds, { wheelbase: 2.8, track: 1.54 });

const groundRoad = id => ({ osmId: `way/${id}`, heightSource: 'terrain', layer: 0, bridge: false, tunnel: false });
const rule = (restriction, from, to, via, viaWays = []) => ({ osmId: 'relation/1', restriction,
  fromWayId: `way/${from}`, toWayIds: [`way/${to}`], viaNodeId: `node/${via}`, viaWayIds: viaWays });

test('brake and boost inputs cancel automatic driving through the frame wiring', () => {
  const main = read('main.js');
  const start = main.indexOf('    const { forward, backward, left, right', main.indexOf('  function renderFrame'));
  const end = main.indexOf('    const prefetch =', start);
  assert.ok(start >= 0 && end > start);
  const wiring = main.slice(start, end);
  const route = { from: { x: 0, z: 0, dx: 1, dz: 0 }, length: 50, stops: [], limits: [9],
    samples: [{ x: 0, z: 0, s: 0 }, { x: 50, z: 0, s: 50 }] };
  for (const action of ['brake', 'boost']) {
    const car = { position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, speed: 0 };
    const autoDrive = createAutoDrive({ model, roadHeight: () => 0, nearTraffic: () => [] });
    assert.equal(autoDrive.start(route, car, 'car'), true);
    let appliedInput;
    const controllerManager = { activeMode: 'car', keys: { [action]: true },
      update: (_dt, _elapsed, input) => { appliedInput = input; } };
    const context = { controllerManager, autoDrive, laneAssist: { update: () => null }, driveCar: car, dt: 1 / 60, elapsed: 0,
      mapSystem: { isFullMapOpen: false }, cruise: { active: false }, droneWatch: { active: false } };
    runInNewContext(wiring, context);
    assert.equal(appliedInput, null);
    assert.equal(autoDrive.status, 'manual');
    controllerManager.keys[action] = false;
    runInNewContext(wiring, { ...context });
    assert.equal(appliedInput, null);
    assert.equal(autoDrive.status, 'manual', 'releasing the key does not resume the route');
  }
});

const DECK_SURFACE = 'sz-elevated-road:7';
const DECK_SURFACE_B = 'sz-elevated-road:8';
// 架空链路按正式 createTrafficGraph 的 elevated 分支接入，覆盖 surfaceId/共享端/桥面高的字段契约。
const deckLink = (overrides = {}) => ({ index: 1, osmId: 'way/900', surfaceId: DECK_SURFACE, name: 'Elevated',
  points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], startNode: 0, endNode: 1,
  width: 7, lanes: 2, direction: 1, startDeckY: 20, endDeckY: 20, sharedStart: false, sharedEnd: false, ...overrides });
const emptyGraph = () => ({ nodes: [], nodeIds: ['node/1', 'node/2'], names: [], links: [], metadata: [],
  turnRestrictions: { rules: [] } });

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
  const shifted = planner.snap(10, 0);
  assert.ok(shifted && !control.contains(shifted.x, shifted.z, Math.hypot(model.hx, model.hz) + 0.35));
  assert.ok(Math.abs(shifted.x - 10) > 12, 'the parking target is outside the signal conflict area');
  const trafficBodies = [];
  const auto = createAutoDrive({ model, control, roadHeight, nearTraffic: () => trafficBodies });
  const car = { position: { x: -25, z: route.from.z, y: 2 }, heading: Math.PI / 2, speed: 0 };
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
  assert.equal(red.permitMove(-2, route.from.z, car.heading), false);
  assert.equal(auto.status, 'signal');
  const occupied = tick(8);
  assert.equal(occupied.permitMove(-2, route.from.z, car.heading), false);
  assert.equal(auto.status, 'intersection');
  control.release(approach, 'traffic-ahead');
  trafficBodies.push({ x: 22, z: route.from.z, sin: 1, cos: 0, halfW: 1.2, halfL: 3.1, minY: 2, maxY: 4 });
  assert.equal(tick(8).permitMove(-2, route.from.z, car.heading), false, 'a stopped vehicle blocks an otherwise open green exit');
  trafficBodies.length = 0;
  const green = tick(8);
  trafficBodies.push({ x: -2, z: route.from.z + 1.9, sin: 1, cos: 0, halfW: 1.2, halfL: 2.4, minY: 2, maxY: 4 });
  assert.equal(green.permitMove(-2, route.from.z, car.heading), false, 'candidate contact is checked before reserving the intersection');
  assert.equal(auto.statistics.signalEntries, 0);
  trafficBodies.length = 0;
  assert.equal(green.permitMove(-2, route.from.z, car.heading), true);
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

test('a North Ring vehicle contact outside route lookahead waits and clears without aborting', () => {
  // 碰撞候选与环境车包络取自北环新洲段堵车实录。
  const { x, y, z, heading } = { x: -1943.91213244, y: 24.70868285, z: -1832.06503373, heading: -1.3909399904 };
  const recordedModel = traffic.trafficModelBounds({
    min: { x: -1.11500001, y: 0, z: -2.36949992 }, max: { x: 1.11500001, y: 1.80900002, z: 2.37986207 }
  }, { wheelbase: 2.8, track: 1.54 });
  const obstacle = { x: -1946.70521145, z: -1830.47853599, sin: -0.7223695469, cos: 0.6915072217,
    halfW: 0.9965146844, halfL: 2.4836900634, minY: 24.00839280, maxY: 26.59889426 };
  const dx = Math.sin(heading), dz = Math.cos(heading);
  // 将试路中心移到侧面，令沿线预判无阻挡，单独覆盖碰撞推出后的候选检查。
  const from = { x: x - 3 * dz, z: z + 3 * dx, dx, dz };
  const route = { from, length: 50, stops: [], limits: [9], samples: [
    { x: from.x, z: from.z, s: 0 }, { x: from.x + 50 * dx, z: from.z + 50 * dz, s: 50 }
  ] };
  const car = { position: { x: from.x, y, z: from.z }, heading, speed: 0 };
  const nearby = [obstacle];
  const auto = createAutoDrive({ model: recordedModel, roadHeight: () => y, nearTraffic: () => nearby });
  assert.equal(auto.start(route, car, 'car'), true);
  const tick = elapsed => auto.update(car, { dt: 1 / 60, elapsed, mode: 'car', manual: false });
  for (let frame = 0; frame < 8 * 60; frame++) {
    const input = tick(frame / 60);
    assert.equal(auto.status, 'driving');
    assert.equal(input.permitMove(x, z, heading), false);
    assert.equal(auto.status, 'traffic');
  }
  nearby[0] = { ...obstacle, minY: obstacle.minY + 5, maxY: obstacle.maxY + 5 };
  assert.equal(tick(8).permitMove(x, z, heading), true, 'an overhead vehicle can share the same horizontal position');
  assert.equal(auto.status, 'driving');
  assert.equal(auto.active, true);
});

function playerCarFixture(groundHeight, { surfaces = [], colliders = [], carBounds = bounds } = {}) {
  const { ThirdPersonControllerManager } = load('controllers.js', { 'three/webgpu': {}, './sz-city-config.js': {
    ISLAND_BOUNDS: { minX: -16000, minZ: -16000, maxX: 16000, maxZ: 16000 }
  }, './sz-controller-surfaces.js': surface, './sz-park-arrivals.js': {}, './sz-strings.js': {}, './city-lighting-materials.js': {},
  './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } }, './pedestrians.js': {},
  './vehicle-lights.js': {}, './building-collision.js': collision, ...driving });
  const car = { type: 'car', collisionBounds: carBounds, chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: [],
    position: {}, speed: 0, vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0, steerAngle: 0, wheelSpin: 0 };
  const controller = Object.assign(Object.create(ThirdPersonControllerManager.prototype), { entities: { car }, activeMode: 'car', keys: {},
    groundHeight, surfaceResolver: surface.createSurfaceResolver({ groundHeight, surfaces }), colliders });
  return { controller, car };
}

function placeAtStart(car, route, roadHeight) {
  const { x, z, dx, dz, edge } = route.from;
  const y = roadHeight(x, z, edge);
  Object.assign(car, { position: { x, y, z }, heading: Math.atan2(dx, dz), _safePosition: { x, y, z },
    _support: { height: y, surfaceId: edge?.surfaceId ?? 'terrain' } });
}

test('the player car uses existing physics on the sourced eastbound Shennan signal approach', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const control = signalApi.createIntersectionControl(geo.roadFrontage, geo.roadGraph);
  assert.equal(geo.roadGraph.turnRestrictions.source, 'osm-guangdong');
  const { chunks } = roads.createRoadSurfaceLayout(geo.roadGraph, geo.terrainSurface);
  const roadHeight = roads.createRoadHeightSampler(chunks, geo.terrainSurface.grid);
  const groundHeight = load('sz-ground-surface.js').createGroundSurfaceSampler(geo.terrainSurface);
  const { controller, car } = playerCarFixture(groundHeight);
  const planner = createDrivePlanner(traffic.createTrafficGraph(geo.roadGraph), geo.roadGraph, { model, roadHeight, control,
    detailedRoadIds: geo.roadFrontage.corridors.flatMap(corridor => corridor.roadIds), isClear: p => controller.isClearCarPose(p) });
  const route = planner.route(planner.snap(-5423, 1183), planner.snap(-5150, 1132));
  assert.deepEqual(Array.from(route.stops, stop => stop.approach.osmNodeId), [8894987731]);
  placeAtStart(car, route, roadHeight);
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

test('an elevated deck route is planned and driven with its surface identity', () => {
  const graph = emptyGraph();
  graph.nodeIds = ['node/1', 'node/2', 'node/3'];
  const first = deckLink({ points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] });
  const second = deckLink({ index: 2, osmId: 'way/901', surfaceId: DECK_SURFACE_B,
    points: [{ x: 50, z: 0 }, { x: 100, z: 0 }], startNode: 1, endNode: 2 });
  const network = traffic.createTrafficGraph(graph, { elevated: { links: [first, second] } });
  assert.equal(network.edges.length, 2);
  assert.ok(network.edges[0].next.includes(network.edges[1]), '共享节点两端桥面高差在容差内，链路连通');
  const queries = [];
  // 两条桥面各有不同高程；某次接触检查若漏传边，查询返回 null，footprint 就会失败。
  const deckHeight = edge => edge?.surfaceId === DECK_SURFACE ? 10 : edge?.surfaceId === DECK_SURFACE_B ? 20 : null;
  const roadHeight = (x, z, edge) => {
    queries.push(edge);
    return deckHeight(edge);
  };
  const planner = createDrivePlanner(network, graph, { model, roadHeight, isClear: () => true });
  const start = planner.snap(10, 0), end = planner.snap(90, 0);
  assert.ok(start && end);
  const route = planner.route(start, end);
  assert.ok(route);
  assert.ok(Math.abs(route.length - 80) < 1e-5);
  assert.deepEqual(Array.from(route.surfaces), [DECK_SURFACE, DECK_SURFACE_B]);
  assert.equal(route.from.edge, network.edges[0]);
  const auto = createAutoDrive({ model, roadHeight, nearTraffic: () => [] });
  const car = { position: { x: route.from.x, y: 10, z: route.from.z },
    heading: Math.atan2(route.from.dx, route.from.dz), speed: 0, _support: { surfaceId: DECK_SURFACE, height: 10 } };
  queries.length = 0;
  assert.equal(auto.start(route, car, 'car'), true);
  assert.equal(queries.length, 5);
  assert.ok(queries.every(edge => edge === network.edges[0]), '启动检查查询起点桥面身份');
  let input = null;
  for (const s of [14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58]) {
    car.position.x = route.from.x + s;
    input = auto.update(car, { dt: 1 / 60, elapsed: s / 10, mode: 'car', manual: false });
    assert.ok(input);
  }
  queries.length = 0;
  assert.equal(input.permitMove(car.position.x + 0.5, car.position.z, car.heading), true);
  const contactEdges = new Set([network.edges[0], network.edges[1]]);
  assert.ok(queries.length >= 5);
  assert.ok(queries.every(edge => contactEdges.has(edge)), '移动许可只查询路线附近段的桥面身份');
  assert.ok(queries.includes(network.edges[1]), '当前段桥面身份参与接触查询');
  assert.ok(queries.some(edge => edge.surfaceId === DECK_SURFACE_B), '当前进度段桥面身份参与接触查询');
  assert.equal(auto.status, 'driving');
});

test('automatic driving rejects an overlapping route on a different level', () => {
  const roadHeight = (x, z, edge) => edge?.surfaceId ? 20 : 8;
  const auto = createAutoDrive({ model, roadHeight });
  const deckRoute = { from: { x: 0, z: 0, dx: 1, dz: 0, edge: { surfaceId: DECK_SURFACE } }, length: 50 };
  const groundRoute = { ...deckRoute, from: { ...deckRoute.from, edge: {} } };
  const car = { position: { x: 0, y: 8, z: 0 }, heading: Math.PI / 2, speed: 0,
    _support: { surfaceId: 'terrain', height: 8 } };

  assert.equal(auto.canStart(deckRoute, car, 'car'), false, 'the car below the bridge cannot start the bridge route');
  assert.equal(auto.start(deckRoute, car, 'car'), false);
  assert.equal(auto.status, 'idle');
  car.position.y = 20;
  car._support = { surfaceId: DECK_SURFACE, height: 20 };
  assert.equal(auto.canStart(groundRoute, car, 'car'), false, 'the car on the bridge cannot start the road below');
  assert.equal(auto.canStart(deckRoute, car, 'car'), true);

  car._support = { surfaceId: DECK_SURFACE_B, height: 20 };
  assert.equal(auto.canStart(deckRoute, car, 'car'), false, 'equal height does not connect independent decks');
  car._support = null;
  assert.equal(auto.canStart(deckRoute, car, 'car'), false, 'an unknown support cannot start a bridge route');
  car._support = { surfaceId: DECK_SURFACE, height: 20 };
  car.position.y = 19;
  assert.equal(auto.canStart(deckRoute, car, 'car'), false, 'a stale support cannot override the car height');
  car._support.height = 19;
  assert.equal(auto.canStart(deckRoute, car, 'car'), false, 'support and car height must still agree with the actual deck');
});

test('automatic driving checks the center height at the actual car position on a ramp', () => {
  const edge = { surfaceId: DECK_SURFACE, sharedStart: true };
  const ramp = (x, z, candidate) => candidate === edge && x >= 0 && Math.abs(z) < 3 ? 8 + x * 0.12 : null;
  const auto = createAutoDrive({ model, roadHeight: ramp });
  const route = { from: { x: 3, z: 0, dx: 1, dz: 0, edge }, length: 50 };
  const car = { position: { x: 4, y: 8.48, z: 0 }, heading: Math.PI / 2, speed: 0,
    _support: { surfaceId: DECK_SURFACE, height: 8.48 } };
  assert.ok(Math.abs(ramp(4 + model.hz, 0, edge) - car.position.y) > 0.26, 'the ramp can have sloped corner contact');
  assert.equal(auto.start(route, car, 'car'), true);
});

test('a ground edge under an elevated deck keeps the ground surface', () => {
  const graph = { nodes: [0, 6, 100, 6], nodeIds: ['node/1', 'node/2'], names: ['Ground Road'],
    links: [[0, 1, 0, 10, 2, 0, []]], metadata: [groundRoad(5)], turnRestrictions: { rules: [] } };
  // 桥面正压在桥下地面路之上：平面位置重叠，只有表面身份不同。
  const network = traffic.createTrafficGraph(graph, { elevated: { links: [deckLink({ points: [{ x: 0, z: 6 }, { x: 100, z: 6 }] })] } });
  assert.equal(network.edges.filter(edge => edge.surfaceId).length, 1, '同一张图里既有桥面也有桥下地面');
  const queries = [];
  const roadHeight = (x, z, edge) => {
    const height = edge?.surfaceId === DECK_SURFACE ? 20 : 0;
    queries.push({ edge, height });
    return height;
  };
  const planner = createDrivePlanner(network, graph, { model, roadHeight, isClear: () => true });
  const start = planner.snap(50, 8.3);
  assert.ok(start);
  assert.equal(start.candidates[0].edge.surfaceId, undefined, '地面车道候选先于桥面候选');
  const route = planner.route(start, planner.snap(90, 8.3));
  assert.ok(route);
  assert.ok(Math.abs(route.length - 40) < 1e-5);
  assert.deepEqual(Array.from(route.surfaces), []);
  assert.ok(route.edges.every(edge => edge.surfaceId === undefined), '规划路线只走地面边');
  assert.ok(route.samples.every(sample => sample.edge.surfaceId === undefined));
  const auto = createAutoDrive({ model, roadHeight, nearTraffic: () => [] });
  const car = { position: { x: route.from.x, y: 0, z: route.from.z },
    heading: Math.atan2(route.from.dx, route.from.dz), speed: 0 };
  queries.length = 0;
  assert.equal(auto.start(route, car, 'car'), true);
  assert.equal(queries.length, 5);
  assert.ok(queries.every(({ edge }) => edge === route.from.edge), '桥下地面车只查询地面边');
  assert.ok(queries.every(({ height }) => height === 0), '桥下地面车按地面高程接触');
  const input = auto.update(car, { dt: 1 / 60, elapsed: 0, mode: 'car', manual: false });
  assert.ok(input);
  queries.length = 0;
  assert.equal(input.permitMove(car.position.x + 0.5, car.position.z, car.heading), true);
  assert.ok(queries.length >= 5);
  assert.ok(queries.every(({ edge }) => !edge?.surfaceId), '桥下地面车只查询路线附近的地面边');
  assert.ok(queries.every(({ height }) => height === 0));
  assert.ok(queries.some(({ edge }) => edge === route.from.edge));
});

test('hasRoadFootprint forwards the edge identity to every height query', () => {
  const deck = { surfaceId: DECK_SURFACE };
  const calls = [];
  assert.equal(hasRoadFootprint((x, z, edge) => { calls.push(edge); return 5; }, model, 0, 0, 0, deck), true);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(edge => edge === deck));
  assert.equal(hasRoadFootprint((x, z, edge) => edge === null ? 3 : null, model, 0, 0, 0), true, '省略边时按 null 查询地面');
  assert.equal(hasRoadFootprint((x, z, edge) => edge?.surfaceId ? 20 : null, model, 0, 0, 0), false);
  assert.equal(hasRoadFootprint((x, z, edge) => edge?.surfaceId ? 20 : null, model, 0, 0, 0, deck), true);
});


test('directed same-edge routes, source access and posted speeds preserve legal lane stations', () => {
  const graph = { nodes: [0, 0, 640, 0, 0, 100, 640, 100, 0, 210, 640, 210],
    nodeIds: [], names: ['Road'], links: [[0, 1, 0, 10, 2, 1, []], [2, 3, 0, 10, 2, 0, []], [4, 5, 0, 10, 2, 1, []]],
    metadata: [{ ...groundRoad(1), highway: 'trunk', drive: { maxKph: { forward: 30 } } },
      { ...groundRoad(2), drive: { closed: ['backward'] } }, { ...groundRoad(3), drive: { maxheight: 1.7 } }] };
  const roadHeight = (x, z) => x >= 0 && x <= 640 && [0, 100, 210].some(c => Math.abs(z - c) <= 5) ? 8 : null;
  const planner = createDrivePlanner(traffic.createTrafficGraph(graph), graph, { model, roadHeight, isClear: () => true });
  const from = planner.snap(20, 1), to = planner.snap(510, 1);
  const route = planner.route(from, to);
  assert.ok(route);
  assert.equal(route.length, 490);
  assert.equal(route.from.x, 20);
  assert.equal(route.to.x, 510);
  assert.ok(Math.max(...route.limits) <= 30 / 3.6);
  assert.ok(route.seconds >= route.length / (30 / 3.6));
  assert.equal(planner.route(to, from), null);
  assert.equal(planner.route(planner.snap(500, 100), planner.snap(20, 100)), null);
  assert.equal(planner.snap(20, 210), null);
  assert.equal(planner.snap(20, 380), null);
  assert.equal(planner.route(from, planner.snap(500, 100)), null);
});

test('automatic driving cruises at 80 km/h at 30, 60 and 120 Hz, and parks at the same lane station', t => {
  const graph = { nodes: [0, 0, 900, 0], nodeIds: [], names: ['Trunk'], links: [[0, 1, 0, 10, 2, 1, []]],
    metadata: [{ ...groundRoad(1), highway: 'trunk' }] };
  const groundHeight = () => 8;
  const roadHeight = (x, z) => x >= 0 && x <= 900 && Math.abs(z) <= 5 ? 8 : null;
  const planner = createDrivePlanner(traffic.createTrafficGraph(graph), graph, { model, roadHeight, isClear: () => true });
  const route = planner.route(planner.snap(20, 0), planner.snap(820, 0));
  const durations = [];
  for (const hz of [30, 60, 120]) {
    const { controller, car } = playerCarFixture(groundHeight);
    placeAtStart(car, route, roadHeight);
    const auto = createAutoDrive({ model, roadHeight });
    assert.equal(auto.start(route, car, 'car'), true);
    let elapsed = 0, first, last;
    const dt = 1 / hz;
    for (; elapsed < 65 && auto.active; elapsed += dt) {
      const input = auto.update(car, { dt, elapsed, mode: 'car', manual: false });
      if (input) controller.updateCar(dt, input);
      if (!first && car.position.x >= 200) first = { x: car.position.x, elapsed };
      if (!last && car.position.x >= 600) last = { x: car.position.x, elapsed };
    }
    assert.equal(auto.status, 'arrived');
    const speedKph = (last.x - first.x) / (last.elapsed - first.elapsed) * 3.6;
    assert.ok(Math.abs(speedKph - 80) < 0.15);
    assert.ok(Math.abs(car.position.x - route.to.x) < 0.7 && Math.abs(car.speed) < 0.05);
    durations.push(elapsed);
    t.diagnostic(`${hz} Hz: ${(last.x - first.x).toFixed(2)} m / ${(last.elapsed - first.elapsed).toFixed(3)} s = ${speedKph.toFixed(3)} km/h; parked after ${elapsed.toFixed(3)} s`);
  }
  assert.ok(Math.max(...durations) - Math.min(...durations) < 0.1);
});

test('an occupied departure queues once, pauses to a stop, and resumes without resetting position', () => {
  const graph = { nodes: [0, 0, 450, 0], nodeIds: [], names: ['Trunk'], links: [[0, 1, 0, 10, 2, 1, []]],
    metadata: [{ ...groundRoad(1), highway: 'trunk' }] };
  const groundHeight = () => 8;
  const planner = createDrivePlanner(traffic.createTrafficGraph(graph), graph, { model, roadHeight: groundHeight, isClear: () => true });
  const route = planner.route(planner.snap(20, 0), planner.snap(410, 0));
  const { controller, car } = playerCarFixture(groundHeight);
  const auto = createAutoDrive({ model, roadHeight: groundHeight });
  let attempts = 0, elapsed = 0;
  const prepare = () => {
    if (++attempts === 1) return 'occupied';
    placeAtStart(car, route, groundHeight);
    return 'car';
  };
  assert.equal(auto.queue(route, prepare), true);
  assert.equal(auto.queue(route, prepare), false);
  const tick = (mode = 'car') => {
    const dt = 1 / 60;
    const input = auto.update(car, { dt, elapsed: elapsed += dt, mode, manual: false });
    if (input) controller.updateCar(dt, input);
  };
  tick('person');
  assert.equal(auto.status, 'occupied');
  for (let i = 0; i < 120; i++) tick();
  assert.equal(attempts, 2);
  assert.equal(auto.status, 'driving');
  auto.pause();
  for (let i = 0; i < 420; i++) tick();
  assert.equal(auto.status, 'paused');
  assert.equal(car.speed, 0);
  const stopped = car.position.x;
  for (let i = 0; i < 30; i++) tick();
  assert.equal(car.position.x, stopped);
  auto.resume();
  for (let i = 0; i < 60; i++) tick();
  assert.ok(car.position.x > stopped);
  const { x } = car.position;
  auto.stop('cancelled');
  assert.equal(auto.status, 'cancelled');
  assert.equal(car.position.x, x);
});

test('the player controller drives from ground through the sourced Chegongmiao deck and returns to ground', t => {
  const { geo } = load('sz-data-format.js').decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
  const graph = geo.roadGraph;
  const groundSurface = load('sz-ground-surface.js');
  const plan = load('sz-elevated-roads.js', { 'three/webgpu': {}, 'three/tsl': {}, './sz-roads.js': roads,
    './sz-ground-surface.js': groundSurface, './sz-controller-surfaces.js': surface }).planElevatedRoads(graph, geo.terrainSurface);
  const area = graph.links.flatMap((link, i) => roads.roadLinkPoints(graph, link)
    .some(p => p.x > -3500 && p.x < -3000 && p.z > 500 && p.z < 1200) ? [i] : []);
  const layout = roads.createRoadSurfaceLayout({ ...graph, links: area.map(i => graph.links[i]), metadata: area.map(i => graph.metadata[i]) },
    geo.terrainSurface);
  const pavement = roads.createRoadHeightSampler(layout.chunks, geo.terrainSurface.grid);
  const groundHeight = groundSurface.createGroundSurfaceSampler(geo.terrainSurface);
  const deckHeight = surface.createSurfaceHeightAt(plan.surfaces);
  const roadHeight = (x, z, edge) => edge?.surfaceId ? deckHeight(x, z, edge.surfaceId) : pavement(x, z);
  const carBounds = { min: { x: -1.11500001, y: 0, z: -2.36949992 }, max: { x: 1.11500001, y: 1.80900002, z: 2.37986207 } };
  const bridgeModel = traffic.trafficModelBounds(carBounds, { wheelbase: 2.8, track: 1.54 });
  const { controller, car } = playerCarFixture(groundHeight, { surfaces: plan.surfaces, colliders: plan.colliders, carBounds });
  const control = signalApi.createIntersectionControl(geo.roadFrontage, graph);
  const network = traffic.createTrafficGraph(graph, { elevated: { links: plan.driveLinks } });
  const planner = createDrivePlanner(network, graph, { model: bridgeModel, roadHeight, control, isClear: pose => controller.isClearCarPose(pose) });
  const start = planner.snap(-3311.9624, 730.481), end = planner.snap(-3179.0028, 975.6674);
  const route = planner.route(start.levels.find(l => l.level === 'ground'), end.levels.find(l => l.level === 'ground'));
  assert.ok(route?.surfaces.length, 'route traverses the existing elevated surfaces');
  placeAtStart(car, route, roadHeight);
  const auto = createAutoDrive({ model: bridgeModel, roadHeight, control });
  assert.equal(auto.start(route, car, 'car'), true);
  const visited = new Set([car._support.surfaceId]);
  let elapsed = 0;
  for (; elapsed < 120 && auto.active; elapsed += 1 / 60) {
    const input = auto.update(car, { dt: 1 / 60, elapsed, mode: 'car', manual: false });
    if (input) controller.updateCar(1 / 60, input);
    visited.add(car._support.surfaceId);
    assert.ok(hasRoadFootprint(roadHeight, bridgeModel, car.position.x, car.position.z, car.heading,
      route.edges, car.position.y), `unsupported car at ${car.position.x},${car.position.z}`);
    if (car._support.surfaceId !== 'terrain') assert.ok(Math.abs(deckHeight(car.position.x, car.position.z, car._support.surfaceId) - car.position.y) < 0.02);
  }
  assert.equal(auto.status, 'arrived', JSON.stringify({ elapsed, progress: auto.progress, position: car.position, surfaces: [...visited] }));
  assert.deepEqual([...visited], ['terrain', ...route.surfaces]);
  assert.equal(car._support.surfaceId, 'terrain');
  assert.ok(Math.hypot(car.position.x - route.to.x, car.position.z - route.to.z) < 0.7);
  t.diagnostic(`${route.length.toFixed(2)} m / ${elapsed.toFixed(2)} s, terrain → ${route.surfaces.join(' → ')} → terrain`);
});
