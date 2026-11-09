const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(path.join(__dirname, '..', file), 'utf8');

test('unverified published endpoints cannot create operational flight routes', () => {
  const routes = JSON.parse(read('data/source/air-routes.json'));
  const evidence = JSON.parse(read('data/source/air-evidence.json'));
  assert.equal(routes.status, 'no-operational-track-verified');
  assert.deepEqual(routes.droneRoutes, []);
  assert.deepEqual(routes.droneStations, []);
  assert.equal(routes.droneCruiseAltitude, null);
  assert.equal(routes.evtolLoop, null);
  for (const item of [...evidence.routes, ...evidence.stations, ...evidence.shows]) {
    assert.match(item.source, /^https:\/\//);
    assert.match(item.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(evidence.routes.every(route => route.track === null));
});

test('legacy preview remains inert even with an old cached invented flight payload', () => {
  class Group {
    constructor() { this.children = []; this.visible = true; }
    add(child) { this.children.push(child); }
  }
  const { createAir } = loadModule(read('js/sz-mvp/air.js'), {
    imports: { 'three/webgpu': { Group } }
  });
  const air = createAir({ air: { droneRoutes: [['fake-a', 'fake-b']] } });
  assert.equal(air.droneCount, 0);
  assert.equal(air.evtol, null);
  assert.equal(air.routeLines.visible, false);
  assert.doesNotThrow(() => air.update(1));
});
