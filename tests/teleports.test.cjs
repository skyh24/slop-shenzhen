const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let GEO, CITY_PAYLOAD, TELEPORT_LOCATIONS, LANDMARK_SITES, getScenicCamera, createGroundSurfaceSampler, findParkArrival, parkAt, decodeCityPayload;
test.before(async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(await readFile(url));
  try {
    ({ GEO, CITY_PAYLOAD } = await import('../js/sz-geodata.js'));
    ({ TELEPORT_LOCATIONS, LANDMARK_SITES } = await import('../js/sz-city-config.js'));
    ({ getScenicCamera } = await import('../js/sz-camera-presets.js'));
    ({ findParkArrival, parkAt } = await import('../js/sz-park-arrivals.js'));
    ({ decodeCityPayload } = await import('../js/sz-data-format.js'));
    const { loadModule } = require('./helpers/module.cjs');
    ({ createGroundSurfaceSampler } = loadModule(read('js/sz-ground-surface.js')));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('teleport destinations bind the retained buttons to Shenzhen roads on the rendered terrain', () => {
  const groundHeight = createGroundSurfaceSampler(GEO.terrainSurface);
  const oldButtonIds = ['tp-empire', 'tp-timessq', 'tp-chrysler', 'tp-grandcentral',
    'tp-bryant', 'tp-flatiron', 'tp-centralpark', 'tp-owtc'];
  const buttons = [...read('index.html').matchAll(/id="(tp-[^"]+)"[^>]+data-teleport="([^"]+)"/g)];
  assert.deepEqual(buttons.map(match => match[1]), oldButtonIds);
  assert.equal(new Set(buttons.map(match => match[2])).size, oldButtonIds.length);
  for (const [, , key] of buttons) assert.ok(TELEPORT_LOCATIONS[key], key);
  const roadIds = new Set(GEO.roadGraph.metadata
    .filter(road => road.heightSource === 'terrain' && !road.bridge && !road.tunnel && !road.layer)
    .map(road => road.osmId));
  for (const [key, point] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(LANDMARK_SITES[key], key);
    assert.ok(Number.isFinite(point.heading), key);
    assert.ok(Number.isFinite(groundHeight(point.x, point.z)), key);
    assert.ok(roadIds.has(point.sourceRoadId), key);
  }
});

test('every scenic camera exposed by the entry resolves against the Shenzhen snapshot', () => {
  const cameras = [...read('index.html').matchAll(/data-camera="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(cameras.slice(0, 3), ['chase', 'action', 'pov']);
  assert.equal(cameras.length, 19);
  assert.deepEqual(cameras.slice(-8), ['djiSkyCity', 'pingAnTower', 'chunsunTower', 'civicRoof', 'chunjianShell', 'cultureSquare', 'conventionCenter', 'bayBridge']);
  for (const id of cameras.slice(3)) {
    for (const elapsed of [0, 40, 120]) {
      const { position, target } = getScenicCamera(id, elapsed);
      assert.ok([...position, ...target].every(Number.isFinite), id);
      assert.ok(Math.hypot(...position.map((coordinate, i) => coordinate - target[i])) > 1, id);
    }
  }
});

test('park arrivals retain a verified site member and require rendered ground support', () => {
  const groundHeight = createGroundSurfaceSampler(GEO.terrainSurface);
  const park = GEO.parks.find(item => item.id === 'shenzhen-bay-park');
  assert.equal(park.osmId, 'relation/8133384');
  assert.equal(park.areas.length, 12);
  const anchor = LANDMARK_SITES[park.id];
  const supported = ({ x, z }) => Number.isFinite(groundHeight(x, z));
  const point = findParkArrival(anchor, park, 0.58, supported);
  assert.ok(point);
  const area = park.areas.find(item => item.osmId === point.parkAreaId);
  assert.equal(area.name, '日出剧场');
  const clicked = parkAt(GEO.parks, point.x, point.z);
  assert.equal(clicked.id, park.id);
  assert.ok(clicked.areas.length < park.areas.length);
  assert.ok(clicked.areas.some(item => item.osmId === area.osmId));
  assert.equal(findParkArrival(anchor, park, 0.58, () => false), null);
  assert.throws(() => decodeCityPayload({ ...CITY_PAYLOAD, parks: [{ ...CITY_PAYLOAD.parks[0], source: '' }] }), /park source/);
});

test('preset and map teleports share arrival resets and mark only a resolved landing point', () => {
  const main = read('js/main.js');
  const start = main.indexOf('  function teleportTo(');
  const end = main.indexOf('  const openMapBtn', start);
  const handlers = new Map();
  const calls = [];
  const landed = { x: -305.7, z: 521 };
  let arrival = landed;
  let map;
  const feedback = {};
  const environment = {
    TELEPORT_LOCATIONS,
    bayPark: null,
    controllerManager: {
      teleportActiveTo: (x, z, heading, altitude, options) => {
        calls.push(['teleport', x, z, heading, altitude, options.requireArrival]);
        return arrival;
      }
    },
    touchControls: { reset: () => calls.push(['touch']) },
    gamepadControls: { reset: () => calls.push(['gamepad']) },
    cameraSystem: { resetForTeleport: () => calls.push(['camera']) },
    selectCamera: (...args) => calls.push(['selectCamera', ...args]),
    autoDrive: { stop: () => {} },
    getLocationLabel: (x, z) => `${x}, ${z}`,
    inBounds: x => x < 9000,
    SZMapSystem: class {
      constructor(options) { this.onTeleport = options.onTeleport; map = this; }
    },
    wireMetroMenu: () => {},
    GEO,
    STR: { map: { noArrival: 'No arrival' } },
    document: { getElementById: id => id === 'teleport-feedback' ? feedback : null },
    teleportButtons: Object.keys(TELEPORT_LOCATIONS).map((key) => ({
      dataset: { teleport: key },
      addEventListener: (_event, handler) => handlers.set(key, handler)
    })),
    closePopovers: () => {}
  };
  vm.runInNewContext(main.slice(start, end), environment);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    calls.length = 0;
    handlers.get(name)();
    assert.deepEqual(calls, [
      ['teleport', point.x, point.z, point.heading, null, true],
      ['touch'], ['gamepad'], ['camera'], ['selectCamera', 'chase', true]
    ]);
    assert.equal(map.waypoint.x, landed.x);
    assert.equal(map.waypoint.z, landed.z);
  }
  map.waypoint = { x: 100, z: 200, name: 'inside a building' };
  map.onTeleport(100, 200);
  assert.equal(map.waypoint.x, landed.x);
  assert.equal(map.waypoint.name, `${landed.x}, ${landed.z}`);
  arrival = null;
  calls.length = 0;
  handlers.get('ping-an')();
  assert.equal(calls.length, 1);
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.textContent, 'No arrival');
  assert.equal(map.onTeleport(10000, 10000), null);
  assert.equal(map.waypoint.x, landed.x);
});
