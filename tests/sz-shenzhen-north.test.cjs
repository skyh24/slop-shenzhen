const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');

const payload = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const rail = payload.shenzhenNorthRail;
const { createNorthRailLayout, northRailHeight, sampleRail } = require('../js/sz-rail/geometry.js');
const { createRailDispatch, TRAIN } = require('../js/sz-rail/dispatch.js');
const { decodeCityPayload, validateCityPayload } = require('../js/sz-data-format.js');
const { loadModule } = require('./helpers/module.cjs');
const layoutFile = join(__dirname, '../js/sz-landmarks/layout.js');
const layoutSource = readFileSync(layoutFile, 'utf8');
const imports = Object.fromEntries([...layoutSource.matchAll(/import .* from '(\.\/[^']+)'/g)]
  .map(([, path]) => [path, { sourceIds: [], build: () => [] }]));
imports['./sports-venues.js'] = { sportsLandmarks: [] };
imports['./shenzhen-north.js'] = require('../js/sz-landmarks/shenzhen-north.js');
imports['../building-collision.js'] = require('../js/building-collision.js');
const { planSzLandmarks } = loadModule(layoutSource, { imports });
const { polygonContains } = require('../js/building-collision.js');

test('North Station renders the reviewed components and leaves station neighbours alone', () => {
  const { buildings, geo } = decodeCityPayload(payload);
  const options = { northRail: rail, heightAt: () => 8, groundHeight: () => 8 };
  const model = planSzLandmarks(buildings, geo.terrain, geo.sites, options);
  const north = model.plans.find(p => p.id === 'shenzhen-north');
  const ids = new Set(north.parts.map(p => p.sourceId));
  assert.deepEqual([...ids].sort(), ['way/222088288', 'way/262922059', 'way/262922064']);
  for (const id of ids) assert.ok(model.skipIds.has(id));
  for (const id of ['way/370233869', 'way/414560161', 'way/535354526', 'way/535354515', 'way/556678394']) {
    assert.ok(!model.skipIds.has(id), id);
  }
  const incomplete = planSzLandmarks(buildings.filter(b => b.id !== 'way/262922059'), geo.terrain, geo.sites, options);
  assert.ok(!incomplete.plans.some(p => p.id === 'shenzhen-north'));
  assert.ok(!incomplete.skipIds.has('way/222088288'));
});

test('North Station paths follow source edges, run in both directions and fit under station structures', () => {
  const { buildings, geo } = decodeCityPayload(payload);
  const { routes, platforms, along } = createNorthRailLayout(rail);
  const { plans } = planSzLandmarks(buildings, geo.terrain, geo.sites, { northRail: rail });
  const { parts } = plans.find(p => p.id === 'shenzhen-north');
  assert.equal(routes.length, 20);
  assert.equal(platforms.length, 11);
  assert.equal(routes.filter(r => r.direction === 1).length, 10);
  assert.ok(platforms.every(p => p.stations.every(({ left, right }) => right - left > 5)));
  for (const route of routes) {
    assert.ok(route.switches.length > 2);
    assert.ok(route.length > 3100);
    assert.ok(route.points.every((p, i) => i === 0 || p.s > route.points[i - 1].s));
    assert.ok(route.points.every((p, i) => i === 0 || route.direction * (along(p) - along(route.points[i - 1])) > 0));
    assert.ok(Math.abs(along(sampleRail(route.points, route.stop - TRAIN.length / 2))) < 3);
    for (const p of route.points.filter(p => Math.abs(along(p)) < 227)) {
      assert.ok(Math.abs(p.y - northRailHeight(0)) < 1e-6);
      assert.ok(!parts.some(part => part.minY < p.y + 4.15 && part.maxY > p.y
        && polygonContains(part.polygon, p.x, p.z)), `Station blocks ${route.id}`);
    }
  }
  const broken = structuredClone(rail);
  broken.routes[0].edges[1] = -broken.routes[0].edges[1];
  assert.throws(() => validateCityPayload({ ...payload, shenzhenNorthRail: broken }), /disconnected rail route/);
});

test('five second schedule tracks conflicts and completes full cycles without overlapping occupied blocks', () => {
  const { routes } = createNorthRailLayout(rail);
  const dispatch = createRailDispatch(routes);
  let mostTrains = 0;
  const positions = new Map();
  for (let i = 0; i < 240 * 30; i++) {
    if (i === 2600) {
      const paused = dispatch.snapshot();
      for (let j = 0; j < 90; j++) dispatch.update(0);
      assert.deepEqual(dispatch.snapshot(), paused);
    }
    dispatch.update(1 / 30);
    const active = dispatch.trains.filter(t => t.route);
    mostTrains = Math.max(active.length, mostTrains);
    const occupied = new Set();
    for (const train of active) {
      const previous = positions.get(train.id) ?? 0;
      assert.ok(train.s >= previous && train.s - previous <= 1.48);
      positions.set(train.id, train.s);
      const blocks = new Set(train.route.blocks.filter(b => train.s > b.begin && train.s - TRAIN.length < b.end)
        .flatMap(b => b.ids));
      for (const id of blocks) {
        assert.ok(!occupied.has(id), `Overlapping trains at ${id}`);
        occupied.add(id);
      }
    }
  }
  const { triggered, started, queued, cleared, log } = dispatch.snapshot();
  const schedule = log.filter(e => e.state === 'scheduled');
  assert.equal(schedule.length, 48);
  assert.ok(schedule.every((e, i) => e.time === (i + 1) * 5 && e.kind === (i % 2 ? 'departure' : 'arrival')));
  for (const kind of ['arrival', 'departure']) assert.equal(triggered[kind], started[kind] + queued[kind]);
  assert.ok(mostTrains >= 4 && cleared >= 1);
  assert.ok(log.some(e => e.state === 'waiting' && e.reason.startsWith('switch:')));
  const first = log.find(e => e.state === 'cleared');
  const lifecycle = log.filter(e => e.train === first.train && e.state !== 'started');
  assert.deepEqual(lifecycle.map(e => e.state), ['approach', 'brake', 'dwell', 'ready', 'accelerate', 'leave', 'cleared']);
  assert.ok(lifecycle.every(e => e.route === first.route && e.berth === first.berth));
});
