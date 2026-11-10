const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => readFileSync(path.join(__dirname, '..', file), 'utf8');

test('unverified published endpoints cannot create operational flight routes', () => {
  const routes = JSON.parse(read('data/source/air-routes.json'));
  const evidence = JSON.parse(read('data/source/air-evidence.json'));
  // 端点有公开来源后，routes 允许带来源的站点和“示意航迹”；但任何真实航迹仍不允许出现。
  assert.equal(routes.status, 'source-endpoints-schematic-tracks');
  assert.ok(routes.droneStations.length > 0 && routes.droneRoutes.length > 0);
  assert.ok(routes.droneStations.every(station => station.sourceUrls.length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(station.verifiedAt)));
  assert.ok(routes.droneRoutes.every(route => route.trackStatus === 'schematic'
    && route.altitudeSource === 'estimate' && !('track' in route) && !('path' in route)));
  assert.equal(routes.droneCruiseAltitude.source, 'estimate');
  assert.equal(routes.evtolLoop, null);
  for (const item of [...evidence.routes, ...evidence.stations, ...evidence.shows]) {
    assert.match(item.source, /^https:\/\//);
    assert.match(item.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(evidence.routes.every(route => route.track === null));
});
