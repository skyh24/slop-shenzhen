const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const { runInNewContext } = require('node:vm');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const load = (file, imports = {}) => loadModule(read(file), { imports });
const signalApi = load('sz-intersection-control.js');
const surface = load('sz-controller-surfaces.js');
const roads = load('sz-roads.js', { 'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) } });
const collision = load('building-collision.js', { './sz-polygon.js': polygonModule });
const physics = load('vehicle-physics.js');
const traffic = load('sz-traffic.js', { 'three/webgpu': {}, './sz-intersection-control.js': signalApi,
  './sz-roads.js': roads,
  // 路线规划只用到 sz-traffic 的纯函数；车队涂装用到的 carStyleCode 给一个等价替身。
  './sz-vehicles.js': { carStyleCode: ({ livery = 0, metallic = 0, trim = 0, wheel = 0 }) =>
    (livery & 7) + ((metallic & 1) << 3) + ((trim & 3) << 4) + ((wheel & 3) << 6) },
  './building-collision.js': collision, './vehicle-physics.js': physics });
const { createAutoDrive, hasRoadFootprint } = load('sz-auto-drive.js', {
  './sz-intersection-control.js': signalApi, './sz-traffic.js': traffic, './vehicle-physics.js': physics
});
const { createDrivePlanner, createTurnFilter } = load('sz-drive-route.js', {
  './sz-intersection-control.js': signalApi, './sz-traffic.js': traffic
});
const bounds = { min: { x: -1.1, y: 0, z: -2.4 }, max: { x: 1.1, y: 1.81, z: 2.4 } };
const model = traffic.trafficModelBounds(bounds, { wheelbase: 2.8, track: 1.54 });

const groundRoad = id => ({ osmId: `way/${id}`, heightSource: 'terrain', layer: 0, bridge: false, tunnel: false });
const rule = (restriction, from, to, via, viaWays = []) => ({ osmId: 'relation/1', restriction,
  fromWayId: `way/${from}`, toWayIds: [`way/${to}`], viaNodeId: `node/${via}`, viaWayIds: viaWays });

test('brake and boost inputs cancel automatic driving through the frame wiring', () => {
  const main = read('main.js');
  const start = main.indexOf('    const { forward, backward, left, right');
  const end = main.indexOf('    controllerManager.update(', start);
  assert.ok(start >= 0 && end > start);
  const wiring = main.slice(start, end);
  const route = { from: { x: 0, z: 0, dx: 1, dz: 0 }, length: 50, stops: [], limits: [9],
    samples: [{ x: 0, z: 0, s: 0 }, { x: 50, z: 0, s: 50 }] };
  for (const action of ['brake', 'boost']) {
    const car = { position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, speed: 0 };
    const autoDrive = createAutoDrive({ model, roadHeight: () => 0, nearTraffic: () => [] });
    assert.equal(autoDrive.start(route, car, 'car'), true);
    const controllerManager = { activeMode: 'car', keys: { [action]: true } };
    const context = { controllerManager, autoDrive, driveCar: car, dt: 1 / 60, elapsed: 0,
      mapSystem: { isFullMapOpen: false } };
    assert.equal(runInNewContext(`${wiring}\ndriveInput;`, context), null);
    assert.equal(autoDrive.status, 'manual');
    controllerManager.keys[action] = false;
    assert.equal(runInNewContext(`${wiring}\ndriveInput;`, { ...context }), null);
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
  trafficBodies.push({ x: -2, z: 1.9, sin: 1, cos: 0, halfW: 1.2, halfL: 2.4, minY: 2, maxY: 4 });
  assert.equal(green.permitMove(-2, 0, car.heading), false, 'candidate contact is checked before reserving the intersection');
  assert.equal(auto.statistics.signalEntries, 0);
  trafficBodies.length = 0;
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

test('the player car uses existing physics on the sourced eastbound Shennan signal approach', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const { geo } = decodeCityPayload(raw);
  const control = signalApi.createIntersectionControl(geo.roadFrontage, geo.roadGraph);
  assert.equal(geo.roadGraph.turnRestrictions.source, 'osm-guangdong');
  const { chunks } = roads.createRoadSurfaceLayout(geo.roadGraph, geo.terrainSurface);
  const roadHeight = roads.createRoadHeightSampler(chunks, geo.terrainSurface.grid);
  const groundHeight = load('sz-ground-surface.js').createGroundSurfaceSampler(geo.terrainSurface);
  const { ThirdPersonControllerManager } = load('controllers.js', { 'three/webgpu': {}, './sz-city-config.js': {
    ISLAND_BOUNDS: { minX: geo.bounds[0], minZ: geo.bounds[1], maxX: geo.bounds[2], maxZ: geo.bounds[3] }
  }, './sz-controller-surfaces.js': surface, './sz-park-arrivals.js': {}, './sz-strings.js': {}, './city-lighting-materials.js': {},
  './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8, radius: 0.335 } } }, './pedestrians.js': {},
  './vehicle-lights.js': {}, './building-collision.js': collision });
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
    heading: Math.atan2(route.from.dx, route.from.dz), speed: 0 };
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
