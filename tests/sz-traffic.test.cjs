const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');
const polygonModule = require('./helpers/polygon.cjs');

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
const roads = load('sz-roads.js', { 'three/webgpu': three, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) } });
const signalModule = load('sz-intersection-control.js');
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
const sections = load('sz-road-section.js');
const { createTrafficGraph, createSzTraffic, laneRoute, poseOnRoute, routeSegments, trafficModelBounds, writeTrafficCollider } = load('sz-traffic.js', {
  'three/webgpu': three,
  './sz-intersection-control.js': signalModule,
  './sz-roads.js': roads,
  './sz-road-section.js': sections,
  './sz-vehicles.js': trafficVehicles,
  './building-collision.js': load('building-collision.js', { './sz-polygon.js': polygonModule }),
  ...driving
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
  const { createMarkingLayout } = load('sz-road-markings.js', { './sz-roads.js': roads, './sz-road-section.js': sections });
  const graph = {
    nodes: [0, 0, 80, 0], names: ['North Ring'], links: [[0, 1, 0, 17, 4, 1, []]],
    metadata: [{ ...groundRoad(1), widthSource: 'reviewed-cross-section', crossSection: {
      laneCountSource: 'municipal-design-and-relative-imagery', laneWidthM: 3.5, points: [0, 0, 8, 80, 0, 8]
    } }]
  };
  const [edge] = createTrafficGraph(graph).edges;
  assert.equal(edge.section, sections.getRoadSection(graph, 0));
  assert.equal(edge.section.sourceId, 'way/1');
  assert.equal(edge.section.widthSource, 'reviewed-cross-section');
  assert.equal(edge.section.laneSource, 'municipal-design-and-relative-imagery');
  assert.equal(edge.section.pavementWidthM, 17);
  assert.equal(edge.segments[0].z, -1);
  assert.equal(edge.section.travelWidthM, 14);
  assert.deepEqual(Array.from(edge.section.routeOffsetsM), [-5.25, -1.75, 1.75, 5.25]);
  const { strips } = createMarkingLayout(graph);
  const dividersZ = Array.from(strips.filter(strip => strip.kind === 'lane' && strip.ax === 0), strip => strip.az);
  const trafficZ = edge.section.routeOffsetsM.map(offset => edge.segments[0].z + offset);
  assert.deepEqual(dividersZ, [-4.5, -1, 2.5]);
  assert.deepEqual(dividersZ, Array.from(trafficZ.slice(1), (center, i) => (center + trafficZ[i]) / 2));
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

test('traffic writes each car wheel style to both front and rear slots', () => {
  const graph = { nodes: [0, 0, 900, 0], names: ['Road'], links: [[0, 1, 0, 8, 2, 1, []]], metadata: [groundRoad(1)] };
  const traffic = createSzTraffic(new Group(), graph, { roadHeight: () => 6 });
  for (let frame = 0; frame < 5; frame++) traffic.update(0.05, { x: 250, z: 0 });
  const wheels = traffic.group.children.filter(child => child.name?.startsWith('traffic:wheels-'));
  assert.equal(wheels.length, 2);
  const styles = wheels.map(mesh => mesh.geometry.attributes.wheelStyle.array);
  const active = traffic.vehicles.filter(vehicle => vehicle.route && vehicle.type !== 'bus');
  assert.ok(active.length > 1);
  active.forEach((actor, slot) => {
    for (const array of styles) {
      assert.equal(array[slot * 2], actor.style, `${actor.type} front wheel keeps its car style`);
      assert.equal(array[slot * 2 + 1], actor.style, `${actor.type} rear wheel keeps its car style`);
    }
  });
  assert.ok(styles[0].every((style, index) => style === styles[1][index]), 'left and right wheels share one style buffer');
  assert.ok(new Set(active.map(actor => actor.style)).size > 1, 'the fleet is painted with more than one style');
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

// 高架车流夹具：字段与 planElevatedRoads 的链路记录同构，直接喂给 createTrafficGraph。
// index 必须唯一且不与手工地面链路的 sourceIndex 冲突，否则同源边会被“不串联”过滤掉。
function elevatedEdgeRecord({ osmId, index, surfaceId, startNode, endNode, points, direction = 1,
  sharedStart = false, sharedEnd = false, startDeckY = 20, endDeckY = 20 }) {
  return {
    index, osmId, surfaceId, name: 'Elevated', width: 8, lanes: 2, direction,
    startNode, endNode, sharedStart, sharedEnd, startDeckY, endDeckY, lengthM: 100,
    points: points.map(([x, z]) => ({ x, z }))
  };
}

test('traffic graph adds signed elevated edges on the record centerline', () => {
  const graph = { nodes: [0, 0, 100, 0], names: ['Elevated'], links: [], metadata: [] };
  const records = [
    elevatedEdgeRecord({ osmId: 'way/d0', index: 200, surfaceId: 'sz-elevated-road:200',
      startNode: 0, endNode: 1, points: [[0, 0], [100, 0]], direction: 0, startDeckY: 12, endDeckY: 13 }),
    elevatedEdgeRecord({ osmId: 'way/d1', index: 201, surfaceId: 'sz-elevated-road:201',
      startNode: 0, endNode: 1, points: [[0, 10], [100, 10]], direction: 1, startDeckY: 14, endDeckY: 15 }),
    elevatedEdgeRecord({ osmId: 'way/dm1', index: 202, surfaceId: 'sz-elevated-road:202',
      startNode: 0, endNode: 1, points: [[0, 20], [100, 20]], direction: -1, sharedEnd: true,
      startDeckY: 20, endDeckY: 18 })
  ];
  const { edges } = createTrafficGraph(graph, { elevated: { links: records } });
  const byOsmId = id => edges.filter(edge => edge.osmId === id);
  const [forward, backward] = byOsmId('way/d0').sort((a, b) => b.sign - a.sign);
  assert.deepEqual([forward.from, forward.to, forward.sign], [0, 1, 1]);
  assert.deepEqual([backward.from, backward.to, backward.sign], [1, 0, -1]);
  assert.deepEqual([forward.segments[0].x, forward.segments[0].z, forward.segments[0].dx], [0, 0, 1]);
  assert.deepEqual([backward.segments[0].x, backward.segments[0].z, backward.segments[0].dx], [100, 0, -1]);
  for (const edge of byOsmId('way/d0')) {
    assert.equal(edge.elevated, true);
    assert.equal(edge.surfaceId, 'sz-elevated-road:200');
    assert.equal(edge.section, sections.getDeckSection(graph, records[0]));
  }
  const [oneWay] = byOsmId('way/d1');
  assert.deepEqual([oneWay.from, oneWay.to, oneWay.sign], [0, 1, 1]);
  assert.deepEqual([oneWay.segments[0].x, oneWay.segments[0].z], [0, 10]);
  assert.equal(oneWay.surfaceId, 'sz-elevated-road:201');
  const [reverse] = byOsmId('way/dm1');
  assert.deepEqual([reverse.from, reverse.to, reverse.sign], [1, 0, -1]);
  assert.deepEqual([reverse.segments[0].x, reverse.segments[0].dx, reverse.segments[0].dz], [100, -1, 0]);
  assert.deepEqual([reverse.startDeckY, reverse.endDeckY], [18, 20]);
  assert.deepEqual([reverse.sharedStart, reverse.sharedEnd], [true, false]);
  assert.equal(reverse.surfaceId, 'sz-elevated-road:202');
});

test('traffic graph connects layers only through shared ground ends and matching deck heights', () => {
  const graph = {
    nodes: [0, 0, 100, 0, 200, 0, 300, 0, 400, 0, 500, 0, 600, 0, 700, 0, 800, 0, 900, 0, 1000, 0],
    names: ['Ground'],
    links: [[0, 1, 0, 9, 2, 1, []], [2, 3, 0, 9, 2, 1, []], [4, 5, 0, 9, 2, 1, []], [8, 9, 0, 9, 2, 1, []]],
    metadata: [{ ...groundRoad(1), osmId: 'way/g1' }, { ...groundRoad(2), osmId: 'way/g2' },
      { ...groundRoad(3), osmId: 'way/g3' }, { ...groundRoad(4), osmId: 'way/g5' }]
  };
  const records = [
    elevatedEdgeRecord({ osmId: 'way/e1', index: 101, surfaceId: 'sz-elevated-road:101',
      startNode: 1, endNode: 2, points: [[100, 0], [200, 0]], sharedStart: true, startDeckY: 10, endDeckY: 14 }),
    elevatedEdgeRecord({ osmId: 'way/e2', index: 102, surfaceId: 'sz-elevated-road:102',
      startNode: 2, endNode: 4, points: [[200, 0], [400, 0]], startDeckY: 14, endDeckY: 15 }),
    elevatedEdgeRecord({ osmId: 'way/e3', index: 103, surfaceId: 'sz-elevated-road:103',
      startNode: 4, endNode: 6, points: [[400, 0], [600, 0]], startDeckY: 15.2, endDeckY: 16 }),
    elevatedEdgeRecord({ osmId: 'way/e4', index: 104, surfaceId: 'sz-elevated-road:104',
      startNode: 4, endNode: 7, points: [[400, 0], [700, 0]], startDeckY: 16, endDeckY: 17 }),
    elevatedEdgeRecord({ osmId: 'way/e5', index: 105, surfaceId: 'sz-elevated-road:105',
      startNode: 5, endNode: 8, points: [[500, 0], [800, 0]], sharedStart: true, sharedEnd: true,
      startDeckY: 18, endDeckY: 10 }),
    elevatedEdgeRecord({ osmId: 'way/e6', index: 106, surfaceId: 'sz-elevated-road:106',
      startNode: 5, endNode: 10, points: [[500, 0], [1000, 0]], startDeckY: 19, endDeckY: 19 })
  ];
  const network = createTrafficGraph(graph, { elevated: { links: records } });
  const edgeOf = osmId => network.edges.find(edge => edge.osmId === osmId);
  const nextIds = edge => Array.from(edge.next, next => next.osmId).sort();
  // 地面→高架：只在链路落地端（sharedStart）连接。
  assert.deepEqual(nextIds(edgeOf('way/g1')), ['way/e1']);
  // 高架→高架：共享节点处估计桥面高差 ≤ 0.35 m 才连接，地面边不在这里接。
  assert.deepEqual(nextIds(edgeOf('way/e1')), ['way/e2']);
  assert.deepEqual(nextIds(edgeOf('way/e2')), ['way/e3']);
  // 地面→高架：悬空起点即使节点编号与地面边相同也不连接。
  assert.deepEqual(nextIds(edgeOf('way/g3')), ['way/e5']);
  // 高架→地面：只在链路落地端（sharedEnd）连接。
  assert.deepEqual(nextIds(edgeOf('way/e5')), ['way/g5']);
  assert.equal(edgeOf('way/e1').elevated, true);
  assert.equal(edgeOf('way/e1').segments[0].x, 100);
  assert.ok(!edgeOf('way/g1').elevated);
});

test('poseOnRoute follows the deck for elevated edges and keeps ground height underneath', () => {
  const box = { min: { x: -0.95, y: 0, z: -2.4 }, max: { x: 0.95, y: 1.8, z: 2.4 } };
  const model = trafficModelBounds(box, vehicleSpecs.taxi);
  const deckEdge = { osmId: 'way/e1', elevated: true, surfaceId: 'sz-elevated-road:300' };
  const groundEdge = { osmId: 'way/g1', elevated: false };
  // 高度函数按边的表面身份取高度：高架边只能拿到桥面，地面边只能拿到地面。
  const height = (x, z, edge) => edge?.surfaceId ? 12.5 : 6;
  const line = edge => Array.from({ length: 101 }, (_, i) => ({ x: i * 2, z: 0, dx: 1, dz: 0, s: i * 2, edge }));
  const pose = {};
  assert.equal(poseOnRoute(line(deckEdge), 100, model, height, pose), true);
  assert.equal(pose.edge, deckEdge);
  assert.ok(Math.abs(pose.y - 12.5) < 1e-9, `elevated pose y ${pose.y}`);
  assert.equal(poseOnRoute(line(groundEdge), 100, model, height, pose), true);
  assert.equal(pose.edge, groundEdge);
  assert.ok(Math.abs(pose.y - 6) < 1e-9, `ground pose keeps its own height ${pose.y}`);
  assert.equal(poseOnRoute(line(deckEdge), 100, model, () => null, pose), false);
});

test('traffic road height uses the deck for elevated edges and ground height for ground edges', () => {
  const deckSurfaceId = 'sz-elevated-road:300';
  const deckHeight = (x, z, surfaceId) => surfaceId === deckSurfaceId
    && x >= 200 && x <= 300 && Math.abs(z) <= 4 ? 12.5 : null;
  const groundHeight = (x, z) => x >= 0 && x <= 400 && Math.abs(z) <= 5 ? 6 : null;
  const graph = {
    nodes: [0, 0, 200, 0, 300, 0, 400, 0], names: ['Ground'],
    links: [[0, 1, 0, 9, 2, 1, []], [1, 3, 0, 9, 2, 1, []]],
    metadata: [groundRoad(1), groundRoad(2)]
  };
  const records = [elevatedEdgeRecord({ osmId: 'way/e1', index: 300, surfaceId: deckSurfaceId,
    startNode: 1, endNode: 2, points: [[200, 0], [300, 0]], startDeckY: 12.5, endDeckY: 12.5,
    sharedStart: true, sharedEnd: false })];
  const traffic = createSzTraffic(new Group(), graph, {
    roadHeight: groundHeight, elevated: { links: records, heightAt: deckHeight }
  });
  const elevatedEdge = traffic.network.edges.find(edge => edge.elevated);
  const groundEdge = traffic.network.edges.find(edge => edge.osmId === 'way/2');
  assert.equal(elevatedEdge.surfaceId, deckSurfaceId);
  assert.equal(traffic.roadHeight(250, 0, elevatedEdge), 12.5);
  assert.equal(traffic.roadHeight(250, 0, groundEdge), 6);
  assert.equal(traffic.roadHeight(250, 4.5, elevatedEdge), null);
  assert.equal(traffic.roadHeight(250, 4.5, groundEdge), 6);
  const withoutDeckSampler = createSzTraffic(new Group(), graph, {
    roadHeight: groundHeight, elevated: { links: records }
  });
  assert.equal(withoutDeckSampler.roadHeight(250, 0, elevatedEdge), null);
  assert.equal(traffic.network.edges.filter(edge => edge.elevated).length, 1);
  assert.equal(traffic.statistics.directedEdges, traffic.network.edges.length);
  assert.equal(traffic.statistics.directedEdges, 3);
});

test('traffic refuses ambient routes that would end on an elevated deck', () => {
  const deckSurfaceId = 'sz-elevated-road:300';
  const graph = {
    nodes: [0, 0, 200, 0, 300, 0], names: ['Ground'],
    links: [[0, 1, 0, 9, 2, 1, []]], metadata: [groundRoad(1)]
  };
  const records = [elevatedEdgeRecord({ osmId: 'way/e1', index: 300, surfaceId: deckSurfaceId,
    startNode: 1, endNode: 2, points: [[200, 0], [300, 0]], startDeckY: 12.5, endDeckY: 12.5,
    sharedStart: true })];
  const traffic = createSzTraffic(new Group(), graph, {
    roadHeight: () => 6, elevated: { links: records, heightAt: (x, z, surfaceId) => surfaceId === deckSurfaceId ? 12.5 : null }
  });
  for (let frame = 0; frame < 30; frame++) traffic.update(0.05, { x: 100, z: 0 });
  assert.equal(traffic.statistics.active, 0);
  assert.ok(traffic.statistics.mainlineEndRejects > 0, 'routes ending on a deck are rejected');
});

test('traffic brakes for a stopped lead vehicle before overlap and follows it away smoothly', () => {
  const graph = { nodes: [0, 0, 900, 0], names: ['Road'],
    links: [[0, 1, 0, 6.5, 1, 1, []]], metadata: [groundRoad(1)] };
  const traffic = createSzTraffic(new Group(), graph, { roadHeight: () => 6 });
  const focus = { x: 250, z: 0 };
  traffic.update(0, focus);
  const actor = traffic.vehicles.find(vehicle => vehicle.route);
  const lead = { type: 'car', heading: Math.PI / 2, speed: 0,
    collisionBounds: { min: { x: -1, y: 0, z: -2.3 }, max: { x: 1, y: 1.8, z: 2.3 } },
    position: { x: actor.pose.x + 25, y: 6, z: 0 } };
  const gap = () => lead.position.x - 2.3 - actor.collider.maxX;
  let brakedAt = 0;
  let previous = actor.speed;
  for (let i = 0; i < 220; i++) {
    traffic.update(0.05, focus, [lead]);
    if (actor.speed < previous - 0.01 && !brakedAt) brakedAt = gap();
    assert.ok(gap() > 1.9);
    previous = actor.speed;
  }
  assert.ok(brakedAt > 8);
  assert.ok(gap() > 1.9 && gap() < 2.4);
  assert.equal(actor.speed, 0);
  lead.speed = 5;
  for (let i = 0; i < 120; i++) {
    lead.position.x += lead.speed * 0.05;
    traffic.update(0.05, focus, [lead]);
    assert.ok(actor.speed - previous <= 2.2 * 0.05 + 1e-7);
    previous = actor.speed;
  }
  assert.ok(actor.speed > 3.5);
  lead.speed = 0;
  for (let i = 0; i < 180; i++) {
    traffic.update(0.05, focus, [lead]);
    assert.ok(gap() > 1.9);
  }
  assert.equal(actor.speed, 0);
});

test('a crossing pedestrian and a cutting-in car constrain the route before overlap while an upper deck does not', () => {
  const { routeLeader, writeEntityCollider, writePedestrianCollider, contactTime } = driving['./sz-driving-motion.js'];
  const ego = writeEntityCollider({}, { type: 'car', position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 12 });
  const samples = [{ x: 0, z: 0, s: 0 }, { x: 0, z: 60, s: 60 }];
  const lead = (...bodies) => routeLeader({ samples, index: 0, s: 0, reach: 45, ego, bodies, roadHeight: () => 0 });
  const pedestrian = writePedestrianCollider({}, -2.8, 0, 18, Math.PI / 2, 1.35);
  const upper = writePedestrianCollider({}, -2.8, 5, 18, Math.PI / 2, 1.35);
  const cutIn = writeEntityCollider({}, { type: 'car', position: { x: 5, y: 0, z: 17 }, heading: -Math.PI / 4, speed: 6 });
  cutIn.id = 'traffic:cut-in';
  const nearbyLane = { ...cutIn, sin: 0, cos: 1, vx: 0, vz: 6 };
  assert.ok(lead(pedestrian).limit < ego.vz);
  assert.ok(lead(cutIn).limit < ego.vz);
  assert.equal(lead(nearbyLane).limit, Infinity);
  assert.equal(lead(upper).limit, Infinity);
  const sweep = contactTime(ego, { ...pedestrian, x: -8, z: 5 }, 1, -20, 12);
  assert.ok(sweep > 0 && sweep < 1);
});

test('Chegongmiao route clears both junction guardrails and keeps its deck contacts', () => {
  const { gunzipSync } = require('node:zlib');
  const { decodeCityPayload } = load('sz-data-format.js');
  const { geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
  const graph = geo.roadGraph;
  const surfaces = load('sz-controller-surfaces.js');
  const { planElevatedRoads } = load('sz-elevated-roads.js', {
    'three/webgpu': three,
    'three/tsl': {},
    './sz-roads.js': roads,
    './sz-ground-surface.js': load('sz-ground-surface.js'),
    './sz-controller-surfaces.js': surfaces, './sz-polygon.js': load('sz-polygon.js')
  });
  const plan = planElevatedRoads(graph, geo.terrainSurface);
  const { createDrivePlanner, createTurnFilter } = load('sz-drive-route.js', {
    './sz-intersection-control.js': signalModule,
    './sz-traffic.js': { laneRoute, poseOnRoute }, './sz-road-section.js': sections
  });
  const areaLinks = graph.links.flatMap((link, index) =>
    roads.roadLinkPoints(graph, link).some(({ x, z }) => x > -3500 && x < -3000 && z > 500 && z < 1200) ? [index] : []);
  const localGraph = { ...graph, links: areaLinks.map(i => graph.links[i]), metadata: areaLinks.map(i => graph.metadata[i]) };
  const layout = roads.createRoadSurfaceLayout(localGraph, geo.terrainSurface);
  const groundHeight = roads.createRoadHeightSampler(layout.chunks, geo.terrainSurface.grid);
  const deckHeight = surfaces.createSurfaceHeightAt(plan.surfaces);
  const { network, roadHeight } = createSzTraffic(new Group(), graph, {
    roadHeight: groundHeight, elevated: { links: plan.driveLinks, heightAt: deckHeight },
    canTurn: createTurnFilter(graph)
  });
  const model = trafficModelBounds(geometryFixture(0.96, 2.4).boundingBox, vehicleSpecs.taxi);
  const planner = createDrivePlanner(network, graph, { model, roadHeight, isClear: () => true });
  const route = planner.route(planner.snap(-3311.9624, 730.481), planner.snap(-3179.0028, 975.6674));
  assert.ok(route, 'the source-directed route can be planned');
  assert.deepEqual(Array.from(route.edges, edge => edge.osmId),
    ['way/1077629921', 'way/40955020', 'way/854919717', 'way/1524817657', 'way/1163682877']);
  const { polygonBoxOverlaps } = load('building-collision.js', { './sz-polygon.js': polygonModule });
  const pose = {};
  const at = surfaces.createSurfaceResolver({ groundHeight, surfaces: plan.surfaces });
  let support = { height: 8, surfaceId: 'terrain' };
  const visited = new Set([support.surfaceId]);
  const guardrails = plan.colliders.filter(c => c.type === 'elevated-barrier'
    && ['way/40955020', 'way/961590249', 'way/854919717', 'way/854919713', 'way/1524817657'].includes(c.sourceId));
  for (const way of ['way/961590249', 'way/854919713']) {
    assert.ok(guardrails.some(c => c.sourceId === way), `${way} retains its exterior guardrail`);
  }
  for (let s = 0; s < route.length; s += 0.25) {
    assert.ok(poseOnRoute(route.samples, s, model, roadHeight, pose));
    support = at.resolve(pose.x, pose.z, { previousY: support.height, previousSurfaceId: support.surfaceId });
    assert.ok(support && Math.abs(support.height - pose.y) <= 0.26,
      `surface contact at ${s} m: ${support?.surfaceId} at ${support?.height}, expected wheel pose ${pose.y}`);
    if (support.surfaceId !== 'terrain') {
      assert.ok(Math.abs(support.height - deckHeight(pose.x, pose.z, support.surfaceId)) < 1e-6);
    }
    visited.add(support.surfaceId);
    const barrier = guardrails.find(c => c.maxY > support.height && c.minY < support.height + 1.8
      && polygonBoxOverlaps(c.polygon, pose.x, pose.z, model.hx, model.hz, pose.cos, pose.sin));
    assert.equal(barrier, undefined, `guardrail conflict at ${s} m: ${barrier?.name}`);
  }
  assert.deepEqual([...visited], ['terrain', ...route.surfaces]);
  assert.equal(support.surfaceId, 'terrain');
  const [underX, underZ] = [-3212.4811, 810.5833];
  assert.equal(at.resolve(underX, underZ, { previousY: 8, previousSurfaceId: 'terrain' }).surfaceId, 'terrain');
  const bridge = route.edges[2];
  const deckY = deckHeight(underX, underZ, bridge.surfaceId);
  const groundY = groundHeight(underX, underZ);
  assert.ok(deckY > groundY + 4);
  const { createAutoDrive } = load('sz-auto-drive.js', {
    './sz-intersection-control.js': signalModule,
    ...driving
  });
  const auto = createAutoDrive({ model, roadHeight });
  const { dx, dz } = bridge.segments.at(-1);
  const departure = { from: { x: underX, z: underZ, dx, dz, edge: bridge } };
  const atLevel = (y, surfaceId) => ({
    speed: 0, heading: Math.atan2(dx, dz), position: { x: underX, y, z: underZ },
    _support: { height: y, surfaceId }
  });
  assert.ok(auto.canStart(departure, atLevel(deckY, bridge.surfaceId), 'car'));
  assert.equal(auto.canStart(departure, atLevel(groundY, 'terrain'), 'car'), false);
});

test('a source-connected tunnel route stays on its own floor across every seam and reaches ground', async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const { gunzipSync } = require('node:zlib');
  const { geo } = load('sz-data-format.js').decodeCityPayload(JSON.parse(gunzipSync(
    readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
  const surface = load('sz-controller-surfaces.js');
  const ground = load('sz-ground-surface.js').createGroundSurfaceSampler(geo.terrainSurface);
  const { buildSzRoadStructures, graphWithRoadStructures } = load('sz-road-structures.js', {
    'three/webgpu': THREE, './sz-roads.js': roads, './sz-controller-surfaces.js': surface
  });
  const graph = graphWithRoadStructures(geo.roadGraph, geo.roadStructures);
  const scene = new THREE.Group();
  const built = buildSzRoadStructures(scene, graph, geo.roadStructures, { groundHeight: () => 8 });
  const network = createTrafficGraph(graph, { elevated: built });
  const parts = geo.roadStructures.records.filter(row => row.route === 'binhai-superhq-east');
  assert.equal(parts.length, 3);
  const chain = parts.map(part => network.edges.find(edge => edge.sourceIndex === part.index));
  assert.ok(chain[0].next.includes(chain[1]) && chain[1].next.includes(chain[2]));
  const approach = network.edges.find(edge => !edge.elevated && edge.next.includes(chain[0]));
  const exit = chain[2].next.find(edge => !edge.elevated);
  assert.ok(approach && exit);
  const resolver = surface.createSurfaceResolver({ groundHeight: ground, surfaces: built.surfaces });
  let support = { height: 8, surfaceId: 'terrain' };
  const traversed = new Set();
  for (const part of parts) {
    const road = built.links.find(row => row.index === part.index);
    for (const frame of road.frames) {
      support = resolver.resolve(frame.x, frame.z, { previousY: support.height, previousSurfaceId: support.surfaceId, mode: 'car' });
      assert.ok(support && Math.abs(support.height - frame.y) < 1e-5);
      traversed.add(support.surfaceId);
    }
  }
  assert.ok(chain.every(edge => traversed.has(edge.surfaceId)));
  const exitPoint = exit.segments[0];
  const end = resolver.resolve(exitPoint.x + exitPoint.dx * 5, exitPoint.z + exitPoint.dz * 5,
    { previousY: support.height, previousSurfaceId: support.surfaceId, mode: 'car' });
  assert.equal(end.surfaceId, 'terrain');
  const bore = built.links.find(row => row.index === parts[1].index);
  const middle = bore.frames[Math.floor(bore.frames.length / 2)];
  assert.equal(resolver.resolve(middle.x, middle.z, { previousY: 8, previousSurfaceId: 'terrain', mode: 'person' }).height, 8);
  const trench = built.links.find(row => row.index === parts[0].index).frames.find(frame => frame.d > 90);
  assert.equal(ground(trench.x, trench.z), null);
  assert.ok(built.colliders.some(c => c.type === 'tunnel-roof' && c.roofPanel));
  assert.ok(built.colliders.some(c => c.type === 'tunnel-light' && c.roofPanel));
  const model = trafficModelBounds(geometryFixture(0.96, 2.4).boundingBox, vehicleSpecs.taxi);
  const segments = routeSegments({ edge: approach, segment: approach.segments.length - 1, distance: 24 },
    model, () => 0, new Set(), 0.5);
  assert.ok(chain.every(edge => segments.some(segment => segment.edge === edge)));
  assert.equal(segments.at(-1).edge.elevated, undefined);
  const { createDrivePlanner } = load('sz-drive-route.js', {
    './sz-intersection-control.js': signalModule, './sz-traffic.js': { laneRoute, poseOnRoute }, './sz-road-section.js': sections
  });
  const planner = createDrivePlanner(network, graph, {
    model, roadHeight: (x, z, edge) => edge?.surfaceId ? built.heightAt(x, z, edge.surfaceId) : ground(x, z),
    isClear: () => true
  });
  const drive = planner.route(planner.snap(-9600, 2622.37), planner.snap(-7940, 2605));
  assert.ok(drive && chain.every(edge => drive.edges.includes(edge)));
  for (const id of ['nanping-xili-east', 'nanping-xili-west', 'nanguang-south', 'nanguang-north',
    'huanggang-binhe-north', 'huanggang-binhe-south', 'beihuan-shahe-east', 'beihuan-shahe-west',
    'nanping-branch-north', 'nanping-branch-south', 'guimiao-east', 'guimiao-west']) {
    const records = geo.roadStructures.records.filter(row => row.route === id);
    assert.ok(records.length >= 3, id);
    const routeEdges = records.map(record => network.edges.find(edge => edge.sourceIndex === record.index));
    assert.ok(routeEdges.every((edge, i) => edge && (!i || routeEdges[i - 1].next.includes(edge))), id);
    const parts = records.map(record => built.links.find(link => link.index === record.index));
    for (const [i, part] of parts.entries()) {
      if (i) {
        assert.deepEqual(part.frames[0].left, parts[i - 1].frames.at(-1).left, id);
        assert.deepEqual(part.frames[0].right, parts[i - 1].frames.at(-1).right, id);
      }
      for (const frame of part.frames) {
        const height = built.heightAt(frame.x, frame.z, part.surfaceId);
        assert.ok(height !== null && Math.abs(height - frame.y) < 1e-5, `${part.osmId} @ ${frame.d}: ${height} vs ${frame.y}`);
      }
    }
    if (id.startsWith('nanping-xili')) {
      assert.ok(records.some(record => record.way === (id.endsWith('east') ? 'way/683489207' : 'way/221894936')));
      const bridges = records.filter(record => record.kind === 'bridge');
      assert.ok(bridges.length > 0 && bridges.every(record =>
        resolver.isFlightRoadDeck(`sz-road-structure:${record.index}`)), id);
      const first = routeEdges[0].segments[0];
      const last = routeEdges.at(-1).segments.at(-1);
      const from = planner.snap(first.x + first.dx * 14, first.z + first.dz * 14);
      const to = planner.snap(last.x + last.dx * (last.length - 14), last.z + last.dz * (last.length - 14));
      const full = from && to && planner.route(from, to);
      assert.ok(full && routeEdges.every(edge => full.edges.includes(edge)), id);
    }
    if (id.startsWith('guimiao')) {
      const bore = records.find(record => geo.roadGraph.metadata[record.index].tunnel);
      assert.equal(bore.lanes, 3, id);
      assert.ok(bore.coverM[1] > 1600, id);
      assert.ok(built.colliders.some(c => c.name === `sz-road-structure:${bore.index}` && c.type === 'tunnel-roof'), id);
      // 两向均接滨海大道东侧；西端相邻跨线桥另有独立高程待核。
      if (id.endsWith('west')) {
        assert.ok(network.edges.some(edge => !edge.elevated && edge.next.includes(routeEdges[0])), id);
      } else {
        assert.ok(routeEdges.at(-1).next.some(edge => !edge.elevated), id);
      }
      let contact = { height: 8, surfaceId: 'terrain' };
      for (const part of parts) for (const frame of part.frames) {
        contact = resolver.resolve(frame.x, frame.z, {
          mode: 'car', previousY: contact.height, previousSurfaceId: contact.surfaceId
        });
        assert.ok(contact && Math.abs(contact.height - frame.y) < 0.025, `${id} ${part.osmId} @ ${frame.d}`);
      }
    }
  }
  const movements = [
    [[1471.03, 1638.98], [1462.70, 1585.62], [17634, 214, 899, 213, 20449]],
    [[1363.03, 1587.73], [1371.42, 1640.25], [20449, 39, 900, 212, 17634]],
    [[-16184.84, -56.31], [-15726.49, -386.61], [18636, 18637, 15658, 7813]],
    [[1348.42, 1640.55], [1487.03, 1638.77], [17634]]
  ];
  for (const [from, to, indices] of movements) {
    const route = planner.route(planner.snap(...from), planner.snap(...to));
    assert.ok(route);
    assert.deepEqual(Array.from(route.edges, edge => edge.sourceIndex), indices);
    for (const [i, sample] of route.samples.entries()) {
      if (sample.edge.rampSpeed) assert.ok(route.limits[i] <= 6.5);
    }
  }
  for (const { ramp, incoming, outgoing } of geo.roadStructures.connections) {
    const rows = [ramp, incoming, outgoing].map(index => built.links.find(link => link.index === index));
    assert.ok(rows[0].openings.size > 0);
    assert.ok(rows[1].openings.size + rows[2].openings.size > 0);
    assert.equal(rows[0].structureNeighbors.includes('terrain'), rows[0].sharedStart || rows[0].sharedEnd);
  }
  built.dispose();
});
