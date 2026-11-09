const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(roads = []) {
  class Path2D { moveTo() {} lineTo() {} closePath() {} addPath() {} }
  const GEO = {
    coverage: [{ outer: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }] }],
    land: [],
    metro: {
      lines: [{ ref: '1', colour: '#00AB39' }, { ref: '4', colour: '#DC241F' }],
      segments: [{ lineRefs: ['1'], points: [1, 1, 50, 50] }, { lineRefs: ['4'], points: [30, 10, 70, 30] }],
      stations: [{ name: 'Station', x: 20, z: 30, lineRefs: ['1'] }]
    },
    air: {
      version: 3, verifiedAt: '2026-11-09', status: 'source-endpoints-schematic-tracks',
      droneStations: [
        { id: 'a', name: 'A 站', x: 10, z: 20, verifiedAt: '2026-11-09', operator: '美团无人机' },
        { id: 'b', name: 'B 站', x: 80, z: 60, verifiedAt: '2026-11-09', operator: '美团无人机' }
      ],
      droneRoutes: [{ id: 'r', name: 'A ⇄ B', fromStationId: 'a', toStationId: 'b', lengthM: 500,
        trackStatus: 'schematic', altitudeM: 100, altitudeSource: 'estimate', verifiedAt: '2026-11-09' }],
      apecSuspension: { windows: [{ from: '2026-11-07', to: '2026-11-21', sourceUrl: 'https://example.com' }] }
    },
    sites: {
      'futian-station': { station: { polygons: [{ outer: [{ x: 10, z: 10 }, { x: 40, z: 10 }, { x: 40, z: 40 }, { x: 10, z: 40 }], holes: [] }] } },
      'xili-station': { site: { polygons: [{ outer: [{ x: 55, z: 55 }, { x: 90, z: 55 }, { x: 90, z: 90 }, { x: 55, z: 90 }], holes: [] }] } }
    }
  };
  const context = vm.createContext({ Path2D, GEO, REAL_BUILDINGS: [], ROADS: roads, console, performance: { now: () => 0 },
    NYC_LANDMARKS: [{ name:'Landmark',short:'Landmark',x:10,z:15 }], ISLAND_BOUNDS: {minX:0,minZ:0,maxX:100,maxZ:100},
    getLocationLabel: () => 'location', isTypingInField: () => false,
    STR: { map: { counts:()=>'', searchPlaceholder:'',teleportHint:x=>x,playerLocation:x=>x,
      clickHint: 'Click to teleport', touchHint: 'Tap to teleport', roadInitials: { 深南大道: 'sndd' }, landmarkInitials: {} },
      drive: { mapHint: 'Click to pick route endpoints', touchHint: 'Tap to pick route endpoints' } },
    document: { getElementById:()=>null,addEventListener(){} }, window:{ addEventListener(){} } });
  for (const name of ['sz-map-layers.js','sz-map.js']) {
    const code = fs.readFileSync(require.resolve(`../js/${name}`),'utf8').replace(/^import .*;\n/gm,'').replace(/^export \{.*\};/gm,'');
    vm.runInContext(code, context);
  }
  return { context, map: vm.runInContext('new NYCMapSystem({ controllerManager:{ getActiveEntity:()=>({position:{x:1,y:2,z:3},heading:0}) }, cameraSystem:{} })', context) };
}

test('map search and viewport retain source coordinates', () => {
  const { map } = fixture();
  assert.equal(map.metroLines.size, 0);
  assert.equal(map.waypoint,null);
  map.search('Station');
  assert.equal(map.viewCenterX,20);
  assert.equal(map.viewCenterZ,30);
  assert.equal(map.viewZoom,0.9);
  const point=map.screenToWorld(600,400,1200,800);
  assert.equal(point.x,20); assert.equal(point.z,30);
  map.search('Landmark'); assert.equal(map.viewCenterX,10);
});

test('a documented pinyin alias highlights source road geometry', () => {
  const { map } = fixture([{ name: '深南大道', pts: [{ x: 0, z: 30 }, { x: 100, z: 30 }], w: 26 }]);
  map.search('sndd');
  assert.ok(map.searchPath);
  assert.equal(map.viewCenterX, 50);
  assert.equal(map.viewCenterZ, 30);
});

test('metro selection redraws both maps using only selected source colors', () => {
  const { context, map } = fixture();
  const colours = [];
  const ctx = new Proxy({}, {
    get: () => () => {},
    set: (_, key, value) => {
      if (key === 'strokeStyle') colours.push(value);
      return true;
    }
  });
  const view = vm.runInContext('new MapView(50,50,1,100,100)', context);
  map.drawWorld(ctx, view, false);
  assert.deepEqual(colours, []);
  map.miniCache = {};
  map.fullStaticKey = 'old';
  map.setMetroLines(['4']);
  assert.equal(map.miniCache, null);
  assert.equal(map.fullStaticKey, '');
  map.drawWorld(ctx, view, false);
  assert.deepEqual(colours, ['#DC241F']);
});

test('world drawing clips source geometry without synthetic routes', () => {
  const { context,map } = fixture();
  const calls=[];
  const ctx=new Proxy({}, {get:(_,key)=> (...args)=>calls.push([key,...args]),set:()=>true});
  const view=vm.runInContext('new MapView(50,50,1,100,100)',context);
  map.drawWorld(ctx,view,false);
  assert.ok(calls.some(c=>c[0]==='clip'));
  assert.ok(calls.some(c=>c[0]==='restore'));
  const code=fs.readFileSync(require.resolve('../js/sz-map.js'),'utf8');
  assert.equal(code.includes('drawRoute('),false);
});

test('map pointer guidance switches from teleport to route selection on mouse and touch', () => {
  const { map } = fixture();
  map.elHoverInfo = {};
  map.renderPointerHint();
  assert.equal(map.elHoverInfo.textContent, 'Click to teleport');
  map.isPlanningDrive = true;
  map.renderPointerHint();
  assert.equal(map.elHoverInfo.textContent, 'Click to pick route endpoints');
  map.touchHints = true;
  map.renderPointerHint();
  assert.equal(map.elHoverInfo.textContent, 'Tap to pick route endpoints');
});

test('HSR layer draws only verified station footprints and stays off by default', () => {
  const { context, map } = fixture();
  const strokes = [];
  const dashes = [];
  const ctx = new Proxy({}, {
    get: (_, key) => (key === 'fillText' || key === 'strokeText') ? () => {} : () => {},
    set: (_, key, value) => {
      if (key === 'strokeStyle') strokes.push(value);
      if (key === 'lineDash') dashes.push(value);
      return true;
    }
  });
  const view = vm.runInContext('new MapView(50,50,1,100,100)', context);
  map.drawWorld(ctx, view, false);
  assert.deepEqual(strokes, []);
  map.hsrVisible = true;
  map.drawWorld(ctx, view, false);
  assert.ok(strokes.includes('#6f93c9'), 'rail station outlines use the rail colour');
  const layers = vm.runInContext('mapLayers()', context);
  assert.equal(layers.hsr.length, 2);
  assert.equal(layers.hsr.find(station => station.id === 'xili-station').underConstruction, true);
  assert.equal(layers.hsr.find(station => station.id === 'futian-station').underConstruction, false);
});

test('drone layer draws sourced route lines and stations only when enabled', () => {
  const { context, map } = fixture();
  const strokes = [];
  const fills = [];
  const ctx = new Proxy({}, {
    get: (_, key) => (key === 'fillText' || key === 'strokeText') ? () => {} : () => {},
    set: (_, key, value) => {
      if (key === 'strokeStyle') strokes.push(value);
      if (key === 'fillStyle') fills.push(value);
      return true;
    }
  });
  const view = vm.runInContext('new MapView(50,50,1,100,100)', context);
  map.drawWorld(ctx, view, false);
  assert.ok(!strokes.includes('#7fd0ff'));
  map.dronesVisible = true;
  map.drawWorld(ctx, view, false);
  assert.ok(strokes.includes('#7fd0ff'), 'schematic drone route uses the drone colour');
  assert.ok(fills.includes('#ffcf6b'), 'sourced stations get a marker');
});
