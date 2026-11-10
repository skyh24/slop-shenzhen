const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

class Group {
  constructor() { this.children = []; }
  add(...objects) { this.children.push(...objects); }
}

class InstancedMesh {
  constructor(geometry, material, capacity) {
    this.geometry = geometry;
    this.material = material;
    this.capacity = capacity;
    this.instanceMatrix = { setUsage() {}, needsUpdate: false };
    this.transforms = [];
    this.count = 0;
  }
  setMatrixAt(index, matrix) { this.transforms[index] = [...matrix]; }
  dispose() {}
}

class InstancedBufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.needsUpdate = false;
  }
}

class Object3D {
  position = { set: (...point) => { this.point = point; } };
  rotation = { set: (...angles) => { this.angles = angles; } };
  scale = { set: (...values) => { this.scaleValues = values; } };
  updateMatrix() { this.matrix = [...this.point, ...this.angles]; }
}

class Color {
  constructor(hex) {
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
  }
}

const three = {
  Group, InstancedMesh, InstancedBufferAttribute, Object3D, Color,
  MeshStandardNodeMaterial: class {}, DynamicDrawUsage: 35048
};
const load = (name, imports) => loadModule(readFileSync(join(__dirname, '../js', name), 'utf8'), { imports });
const roads = load('sz-roads.js', { 'three/webgpu': three });
const signalModule = load('sz-intersection-control.js');
const vehiclePhysics = load('vehicle-physics.js');
const vehicleSpecs = {
  taxi: { track: 1.6, wheelbase: 2.8, radius: 0.35 }, sedan: { track: 1.6, wheelbase: 2.8, radius: 0.35 },
  suv: { track: 1.69, wheelbase: 2.9, radius: 0.38 }, minivan: { track: 1.69, wheelbase: 3.03, radius: 0.37 },
  van: { track: 1.72, wheelbase: 3.6, radius: 0.38 }, bus: { track: 2.05, wheelbase: 5.9, radius: 0.49 }
};
// 车体几何的测试替身：记录 computeBoundingBox / 实例属性，不建真实缓冲。
function geometryFixture(halfWidth, halfLength, height = 1.8, minY = 0) {
  return {
    boundingBox: { min: { x: -halfWidth, y: minY, z: -halfLength }, max: { x: halfWidth, y: height, z: halfLength } },
    attributes: {},
    computeBoundingBox() {},
    setAttribute(name, attribute) { this.attributes[name] = attribute; return this; },
    dispose() {}
  };
}
const trafficVehicles = {
  VEHICLE_SPECS: vehicleSpecs,
  carStyleCode: ({ livery = 0, metallic = 0, trim = 0, wheel = 0 }) =>
    (livery & 7) + ((metallic & 1) << 3) + ((trim & 3) << 4) + ((wheel & 3) << 6),
  createTrafficVehicleGeometry({ type }) {
    return geometryFixture(type === 'bus' ? 1.275 : 0.95, type === 'bus' ? 6.1 : 2.4);
  },
  createTrafficCarBody(type) {
    return { geometry: geometryFixture(0.95, type === 'van' ? 2.9 : 2.4, 1.8, 0.25), material: {} };
  },
  createTrafficWheels() {
    return {
      left: geometryFixture(0.05, 0.35), right: geometryFixture(0.05, 0.35), material: {},
      baseRadius: 0.35, groundOffset: 0.345
    };
  }
};
const { createTrafficGraph, createSzTraffic, laneOffsets, laneRoute, routeSegments, trafficModelBounds, writeTrafficCollider } = load('sz-traffic.js', {
  'three/webgpu': three,
  './sz-intersection-control.js': signalModule,
  './sz-roads.js': roads,
  './sz-vehicles.js': trafficVehicles,
  './building-collision.js': load('building-collision.js'),
  './vehicle-physics.js': vehiclePhysics
});

const groundRoad = id => ({ osmId: `way/${id}`, heightSource: 'terrain', layer: 0, bridge: false, tunnel: false });

test('traffic follows the OSM source directions and never connects geometric crossings or unresolved bridges', () => {
  const graph = {
    nodes: [0, 0, 30, 0, 70, 0, 30, 0, 30, 20, 110, 0],
    names: ['Road'],
    links: [[0, 1, 0, 9, 2, 1, []], [2, 1, 0, 9, 2, -1, []], [3, 4, 0, 9, 2, 0, []], [2, 5, 0, 9, 2, 1, []]],
    metadata: [groundRoad(1), groundRoad(2), groundRoad(3), { ...groundRoad(4), heightSource: 'unresolved', bridge: true }]
  };
  const { edges } = createTrafficGraph(graph);
  assert.equal(edges.length, 4);
  assert.deepEqual([edges[1].from, edges[1].to, edges[1].sign], [1, 2, -1]);
  assert.deepEqual(Array.from(edges[0].next, edge => edge.osmId), ['way/2']);
  assert.equal(edges[1].next.length, 0);
});

test('traffic follows reviewed travel lanes and leaves the outer shoulder unoccupied', () => {
  const graph = {
    nodes: [0, 0, 80, 0], names: ['North Ring'], links: [[0, 1, 0, 17, 4, 1, []]],
    metadata: [{ ...groundRoad(1), crossSection: { laneWidthM: 3.5, points: [0, 0, 8, 80, 0, 8] } }]
  };
  const [edge] = createTrafficGraph(graph).edges;
  assert.equal(edge.segments[0].z, -1);
  assert.equal(edge.travelWidth, 14);
  assert.deepEqual(Array.from(laneOffsets(edge)), [-5.25, -1.75, 1.75, 5.25]);
});

test('traffic connects a reviewed expressway ramp to the outside lane without crossing through lanes', () => {
  const profile = (id, from, to) => ({ ...groundRoad(id), crossSection: { laneWidthM: 3.5, points: [from, 0, 8, to, 0, 8] } });
  const ramp = id => ({ ...groundRoad(id), highway: 'trunk_link' });
  const graph = {
    nodes: [0, 0, 200, 0, 500, 0, 450, 30, -160, 18], names: ['North Ring', 'Ramp'],
    links: [[0, 1, 0, 17, 4, 1, []], [1, 3, 1, 6.5, 0, 1, []], [1, 2, 0, 17, 4, 1, []], [4, 0, 1, 6.5, 0, 1, []]],
    metadata: [profile(1, 0, 200), ramp(2), profile(3, 200, 500), ramp(4)]
  };
  const [main, exit, straight, entry] = createTrafficGraph(graph).edges;
  const path = (edge, choice) => routeSegments({ edge, segment: 0, distance: 20 }, { hx: 1 }, () => 0, new Set(), choice);
  assert.ok(path(main, 0.1).some(segment => segment.edge === straight));
  assert.ok(path(main, 0.1).every(segment => segment.edge !== exit));
  const outbound = laneRoute(path(main, 0.9));
  assert.ok(outbound.some(point => point.edge === exit));
  assert.ok(outbound.filter(point => Math.abs(point.x - 200) < 6)
    .every(point => Math.abs(point.z - 4.25) < 0.7 && point.dx > 0.98));
  const inbound = laneRoute(path(entry, 0.1));
  assert.ok(inbound.some(point => point.edge === main));
  assert.ok(inbound.filter(point => Math.abs(point.x) < 6)
    .every(point => Math.abs(point.z - 4.25) < 0.7 && point.dx > 0.98));
});

test('traffic collision bounds are the same local model box with the rendered yaw', () => {
  const model = trafficModelBounds({ min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 2, z: 3 } }, vehicleSpecs.taxi);
  const body = writeTrafficCollider({}, model, { x: 8, y: 6, z: 11, sin: 1, cos: 0, pitch: 0, roll: 0 });
  assert.equal(body.obb.cx, 8.5);
  assert.equal(body.obb.cz, 11);
  assert.deepEqual([body.minX, body.maxX, body.minZ, body.maxZ, body.minY, body.maxY], [6, 11, 10, 12, 6, 8]);
});

test('traffic stops before a player and uses its drawn position for collision queries', () => {
  const graph = {
    nodes: [0, 0, 900, 0], names: ['Road'], links: [[0, 1, 0, 8, 2, 1, []]], metadata: [groundRoad(1)]
  };
  const scene = new Group();
  const roadHeight = (x, z) => x >= 0 && x <= 900 && Math.abs(z) <= 4 ? 6 : null;
  const traffic = createSzTraffic(scene, graph, { roadHeight });
  const focus = { x: 250, z: 0 };
  traffic.update(0, focus);
  const actor = traffic.vehicles.find(vehicle => vehicle.route);
  assert.ok(actor);
  const start = actor.pose.x;
  const player = { type: 'person', position: { x: start + 10, y: 6, z: 0 }, heading: 0 };
  for (let frame = 0; frame < 100; frame++) traffic.update(0.05, focus, [player]);
  assert.ok(actor.pose.x > start);
  assert.ok(actor.pose.x < player.position.x - actor.model.hz);
  assert.equal(actor.speed, 0);
  const position = [actor.pose.x, actor.pose.y, actor.pose.z];
  const bodyMesh = traffic.group.children.find(child => child.name === `traffic:${actor.type}`);
  assert.ok(bodyMesh.transforms.some(values => position.every((value, index) => value === values[index])));
  const wheelMeshes = traffic.group.children.filter(child => child.name?.startsWith('traffic:wheels-'));
  const activeCars = traffic.vehicles.filter(vehicle => vehicle.route && vehicle.type !== 'bus').length;
  assert.equal(wheelMeshes.length, 2);
  assert.equal(wheelMeshes[0].material, wheelMeshes[1].material, 'left and right wheels share one material');
  for (const wheels of wheelMeshes) {
    assert.equal(wheels.count, activeCars * 2, 'two wheel instances per active car');
    assert.ok(wheels.capacity >= activeCars * 2);
  }
  // 平坦路面上车轮实例落地：中心高度 = 路面高度 + 18 段 lathe 的贴地偏移 × 轮胎缩放。
  const activeCarsList = traffic.vehicles.filter(vehicle => vehicle.route && vehicle.type !== 'bus');
  const carIndex = activeCarsList.indexOf(actor.type === 'bus' ? activeCarsList[0] : actor);
  const car = activeCarsList[carIndex < 0 ? 0 : carIndex];
  const spec = vehicleSpecs[car.type];
  const scale = spec.radius / 0.35;
  const front = wheelMeshes[0].transforms[(carIndex < 0 ? 0 : carIndex) * 2];
  const rear = wheelMeshes[0].transforms[(carIndex < 0 ? 0 : carIndex) * 2 + 1];
  assert.ok(Math.abs(front[1] - (car.pose.y + 0.345 * scale)) < 1e-9, 'wheels sit on the road surface');
  assert.ok(Math.abs(Math.abs(front[0] - rear[0]) - spec.wheelbase) < 1e-9, 'front and rear axles are one wheelbase apart');
  assert.ok(traffic.nearColliders(actor.pose.x, actor.pose.z, 0).includes(actor.collider));
});

test('traffic refuses finite routes that would park vehicles close to the focus', () => {
  const graph = {
    nodes: [0, 0, 200, 0], names: ['Road'], links: [[0, 1, 0, 8, 2, 1, []]], metadata: [groundRoad(1)]
  };
  const traffic = createSzTraffic(new Group(), graph, { roadHeight: () => 6 });
  for (let frame = 0; frame < 30; frame++) traffic.update(0.05, { x: 100, z: 0 });
  assert.equal(traffic.statistics.active, 0);
  assert.ok(traffic.statistics.nearEndRejects > 0);
});

test('traffic does not plan a stationary queue at a reviewed mainline endpoint', () => {
  const graph = {
    nodes: [0, 0, 900, 0], names: ['North Ring'], links: [[0, 1, 0, 17, 4, 1, []]],
    metadata: [{ ...groundRoad(1), crossSection: { laneWidthM: 3.5, points: [0, 0, 8, 900, 0, 8] } }]
  };
  const traffic = createSzTraffic(new Group(), graph, { roadHeight: () => 6 });
  for (let frame = 0; frame < 30; frame++) traffic.update(0.05, { x: 100, z: 0 });
  assert.equal(traffic.statistics.active, 0);
  assert.ok(traffic.statistics.mainlineEndRejects > 0);
});

test('traffic keeps a visible terminal vehicle and its collider until the camera looks away', () => {
  const graph = {
    nodes: [0, 0, 900, 0], names: ['Road'], links: [[0, 1, 0, 8, 2, 1, []]], metadata: [groundRoad(1)]
  };
  const traffic = createSzTraffic(new Group(), graph, { roadHeight: () => 6 });
  const focus = { x: 250, z: 0 };
  traffic.update(0, focus);
  const actor = traffic.vehicles.find(vehicle => vehicle.route);
  const original = actor.route;
  for (let frame = 0; frame < 1600 && actor.s < actor.end; frame++) {
    traffic.update(0.05, focus, [], null, () => true);
  }
  assert.equal(actor.s, actor.end);
  for (let frame = 0; frame < 120; frame++) traffic.update(0.05, focus, [], null, () => true);
  assert.equal(actor.route, original);
  assert.ok(traffic.nearColliders(actor.pose.x, actor.pose.z, 0).includes(actor.collider));
  assert.equal(traffic.statistics.offscreenRecycled, 0);
  traffic.update(0.05, focus, [], null, body => body !== actor.collider);
  assert.notEqual(actor.route, original);
  assert.equal(traffic.statistics.offscreenRecycled, 1);
});

function signalRoad() {
  const graph = { nodes: [0, 0, 900, 0], nodeIds: ['node/1', 'node/2'], names: ['Road'],
    links: [[0, 1, 0, 10, 3, 1, []]], metadata: [groundRoad(1)] };
  const source = { intersections: [{ id: 'fixture', bounds: [244, -7, 270, 7], approaches: [{
    osmNodeId: 3, osmWayId: 'way/1', fromNodeId: 'node/1', toNodeId: 'node/2', group: 0,
    stopX: 250, stopZ: 0, dx: 1, dz: 0, widthM: 10
  }] }] };
  const control = signalModule.createIntersectionControl(source, graph);
  return { graph, control };
}

test('traffic stops for a held approach and clears the conflict area after green ends', () => {
  const { graph, control } = signalRoad();
  const traffic = createSzTraffic(new Group(), graph, { signals: control,
    roadHeight: (x, z) => x >= 0 && x <= 900 && Math.abs(z) <= 5 ? 2 : null });
  const focus = { x: 196, z: 0 };
  for (let i = 0; i < 550; i++) traffic.update(0.05, focus, [], 5);
  const waiter = traffic.vehicles.find(actor => actor.waitingForSignal);
  assert.ok(waiter && waiter.collider.maxX < 250);
  assert.equal(traffic.statistics.signalEntries, 0);
  for (let i = 0; i < 45 && !waiter.reservation; i++) traffic.update(0.05, focus, [], 0.4);
  assert.ok(waiter.reservation);
  const afterGreen = waiter.pose.x;
  for (let i = 0; i < 160; i++) traffic.update(0.05, focus, [], 5);
  assert.ok(waiter.pose.x > afterGreen + 24);
  assert.equal(waiter.reservation, null);
  assert.equal(traffic.statistics.signalEntries, 1);
});

test('traffic refuses to reserve an intersection over a narrow unsupported gap in the exit', () => {
  const { graph, control } = signalRoad();
  const traffic = createSzTraffic(new Group(), graph, { signals: control,
    roadHeight: (x, z) => x >= 0 && x <= 900 && Math.abs(z) <= 5 && (x <= 265.17 || x >= 265.51) ? 2 : null });
  for (let i = 0; i < 380; i++) traffic.update(0.05, { x: 196, z: 0 }, [], 0.7);
  assert.ok(traffic.statistics.signalExitRejects > 0);
  assert.equal(traffic.statistics.signalEntries, 0);
  assert.equal(control.snapshot(0.7)[0].owner, null);
});

test('traffic holds at a green stop line while a physical vehicle occupies the exit', () => {
  const { graph, control } = signalRoad();
  const traffic = createSzTraffic(new Group(), graph, { signals: control,
    roadHeight: (x, z) => x >= 0 && x <= 900 && Math.abs(z) <= 5 ? 2 : null });
  const focus = { x: 196, z: 0 };
  const parked = { type: 'car', position: { x: 278, y: 2, z: 0 }, heading: Math.PI / 2,
    collisionBounds: { min: { x: -1.1, y: 0, z: -2.5 }, max: { x: 1.1, y: 1.8, z: 2.5 } } };
  for (let i = 0; i < 550; i++) traffic.update(0.05, focus, [parked], 0.7);
  assert.equal(traffic.statistics.signalEntries, 0);
  assert.ok(traffic.vehicles.some(actor => actor.waitingForSignal && actor.blocker?.atExit));
  for (let i = 0; i < 80; i++) traffic.update(0.05, focus, [], 0.7);
  assert.ok(traffic.statistics.signalEntries > 0);
});
