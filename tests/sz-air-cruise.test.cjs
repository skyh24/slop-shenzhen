const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');

const root = join(__dirname, '..');
const read = name => readFileSync(join(root, 'js', name), 'utf8');
const polygon = loadModule(read('sz-polygon.js'));
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygon } });
const { createAirCruise, planAirCruise } = loadModule(read('sz-air-cruise.js'), {
  imports: { ...driving, './building-collision.js': collision, './sz-terrain.js': loadModule(read('sz-terrain.js')) }
});
const city = JSON.parse(gunzipSync(readFileSync(join(root, 'js/sz-city.json.gz'))));
const { flight, routes } = city.airCruises;

function line() {
  return { id: 'fixture', points: Array.from({ length: 241 }, (_, i) => [i * 5, 0]) };
}

const geometry = {
  groundHeight: () => 8, roadHeight: () => null, nearColliders: () => [], bodyRadius: 5, maxAltitude: 400
};

test('published cruise routes retain connected directed main road links and explicit access segments', () => {
  const graph = city.roadGraph;
  const byEndpoints = new Map();
  graph.links.forEach(([a, b, name, , , direction], i) => {
    const metadata = graph.metadata[i];
    const from = graph.nodeIds[a], to = graph.nodeIds[b];
    for (const sign of direction ? [direction] : [1, -1]) {
      const key = sign === 1 ? [from, to] : [to, from];
      byEndpoints.set([...key, metadata.osmId].join('|'), { name: graph.names[name], sign, ...metadata });
    }
  });
  assert.deepEqual(routes.map(route => [route.id, route.start.landmarkId, route.end.mainWayId]), [
    ['beihuan', undefined, 'way/1055004298'], ['shennan', 'tencent-towers', 'way/996762416'],
    ['binhai', 'tencent-binhai', 'way/1051282775']
  ]);
  for (const route of routes) {
    const segments = route.segments.filter(segment => segment.kind === 'main');
    assert.ok(segments.length > 20);
    assert.equal(route.segments[0].kind, 'entry');
    assert.deepEqual([...new Set(segments.map(segment => segment.road))], route.roads.map(road => road.name));
    for (const [i, segment] of segments.entries()) {
      const source = byEndpoints.get([segment.fromNode, segment.toNode, segment.osmId].join('|'));
      assert.ok(source);
      assert.equal(source.name, segment.road);
      assert.equal(source.sign, segment.direction);
      assert.equal(source.highway, route.roads.find(road => road.name === segment.road).highway);
      assert.ok(segment.sourceToM > segment.sourceFromM);
      if (i) assert.equal(segment.fromNode, segments[i - 1].toNode);
    }
  }
  assert.equal(routes[2].segments.at(-1).kind, 'departure');
  assert.ok(routes[2].segments.some(segment => segment.tunnel));
});

test('ground-relative profiles ignore lower decks and raise locally for a swept obstruction', () => {
  const build = (top, z = 0) => planAirCruise(line(), flight, {
    ...geometry, nearColliders: () => [{ minX: 599.8, maxX: 600.2, minZ: z - 1, maxZ: z + 1, maxY: top, sourceId: 'fixture-roof' }]
  });
  const bridge = build(32);
  assert.ok(Math.abs(bridge.poseAt(600).y - 88) < 1e-9);
  const roof = build(102);
  assert.ok(roof.poseAt(600).y >= 116);
  assert.ok(Math.abs(roof.poseAt(0).y - 88) < 1e-9);
  assert.ok(roof.audit.maxGrade <= 0.1000001);
  assert.ok(roof.audit.minimumClearance >= 14 - 1e-8);
  assert.deepEqual([...roof.audit.obstacles[0].sources], ['fixture-roof']);
  assert.equal(build(230, 12).audit.obstacles.length, 0);
  assert.throws(() => build(200), /clearance envelope/);
});

test('the full-speed profile reaches 600 km/h on a long straight without changing the route', () => {
  const path = { ...line(), points: Array.from({ length: 2401 }, (_, i) => [i * 5, 0]) };
  const scenic = planAirCruise(path, flight, geometry);
  const full = scenic.atSpeed(600 / 3.6);
  const pose = {};
  full.flightAt(1, pose);
  assert.ok(Math.abs(pose.speed * 3.6 - 200) < 1e-7);
  full.flightAt(full.duration * 0.5, pose);
  assert.ok(Math.abs(pose.speed * 3.6 - 600) < 1e-7);
  assert.ok(full.duration < scenic.duration);
  assert.equal(full.points, scenic.points);
  const custom = scenic.atSpeed(310 / 3.6);
  custom.flightAt(custom.duration * 0.5, pose);
  assert.ok(Math.abs(pose.speed * 3.6 - 310) < 1e-7);
  full.flightAt(full.duration, pose);
  assert.equal(pose.distance, full.distance);
  assert.equal(pose.speed, 0);
});

test('cruise waits for resources, pauses, reaches a full stop and can restart without touching a player entity', () => {
  const vector = { set(x, y, z) { Object.assign(this, { x, y, z }); }, copy(v) { this.set(v.x, v.y, v.z); } };
  const aircraft = {
    position: Object.create(vector),
    mesh: { visible: false, position: Object.create(vector), rotation: {}, updateMatrixWorld() {} },
    updateRotors() {}
  };
  const cruise = createAirCruise({ routes: [line()], flight }, geometry, aircraft);
  const [route] = cruise.routes;
  assert.equal(cruise.start(route), true);
  assert.equal(aircraft.speed, 0);
  const initialHeading = aircraft.heading;
  cruise.update(0.5, true);
  assert.equal(cruise.status, 'aligning');
  assert.equal(cruise.distance, 0);
  assert.ok(Math.abs(initialHeading - aircraft.heading - Math.PI / 8) < 1e-8);
  cruise.update(0.5, false);
  assert.equal(cruise.status, 'waiting');
  assert.ok(Math.abs(initialHeading - aircraft.heading - Math.PI / 4) < 1e-8);
  assert.equal(cruise.distance, 0);
  for (let i = 0; i < 200; i++) cruise.update(0.05, true);
  assert.ok(cruise.distance > 0 && cruise.distance < route.distance);
  assert.ok(cruise.prefetch().x > aircraft.position.x);
  const before = cruise.distance;
  cruise.togglePause();
  cruise.update(1, true);
  assert.equal(cruise.distance, before);
  assert.equal(aircraft.speed, 0);
  cruise.togglePause();
  while (cruise.status !== 'complete') cruise.update(0.05, true);
  assert.ok(Math.abs(cruise.distance - route.distance) < 1e-7);
  assert.ok(aircraft.speed < 1e-7);
  assert.equal(aircraft.mesh.visible, true);
  assert.equal(cruise.restart(), true);
  assert.equal(cruise.distance, 0);
  cruise.stop();
  assert.equal(aircraft.mesh.visible, false);
  assert.equal(cruise.entity, null);
});
