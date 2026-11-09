const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

class Group {
  constructor() { this.children = []; }
  add(object) { this.children.push(object); }
}

class InstancedMesh {
  constructor() {
    this.instanceMatrix = { setUsage() {} };
    this.transforms = [];
  }
  setMatrixAt(index, matrix) { this.transforms[index] = [...matrix]; }
}

class Object3D {
  position = { set: (...point) => { this.point = point; } };
  rotation = { set: (...angles) => { this.angles = angles; } };
  updateMatrix() { this.matrix = [...this.point, ...this.angles]; }
}

const three = { Group, InstancedMesh, Object3D, MeshStandardNodeMaterial: class {} };
const load = (name, imports) => loadModule(readFileSync(join(__dirname, '../js', name), 'utf8'), { imports });
const roads = load('sz-roads.js', { 'three/webgpu': three });
const vehiclePhysics = load('vehicle-physics.js');
const vehicleSpecs = {
  taxi: { track: 1.54, wheelbase: 2.8 }, sedan: { track: 1.62, wheelbase: 2.92 },
  suv: { track: 1.63, wheelbase: 2.77 }, bus: { track: 2.05, wheelbase: 5.9 }
};
const { createTrafficGraph, createSzTraffic, trafficModelBounds, writeTrafficCollider } = load('sz-traffic.js', {
  'three/webgpu': three,
  './sz-roads.js': roads,
  './sz-vehicles.js': {
    VEHICLE_SPECS: vehicleSpecs,
    createTrafficVehicleGeometry({ type }) {
      const halfWidth = type === 'bus' ? 1.275 : 1.02;
      const halfLength = type === 'bus' ? 6.1 : 2.4;
      return { computeBoundingBox() {}, boundingBox: {
        min: { x: -halfWidth, y: 0, z: -halfLength }, max: { x: halfWidth, y: 1.8, z: halfLength }
      } };
    }
  },
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
  assert.ok(traffic.group.children[0].transforms.some(values => position.every((value, index) => value === values[index])));
  assert.ok(traffic.nearColliders(actor.pose.x, actor.pose.z, 0).includes(actor.collider));
});
