const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

function load(name, imports, globals) {
  return loadModule(readFileSync(require.resolve(`../js/${name}.js`), 'utf8'), { imports, globals });
}

class Path2D { moveTo() {} lineTo() {} closePath() {} }
const GEO = { mapRegions: { coverage: { retail: 1, office: 1, park: 1 } } };
const strings = load('sz-strings');
const polygon = load('sz-polygon');
const dataFormat = load('sz-data-format');
const spatial = load('sz-spatial', { './sz-polygon.js': polygon, './sz-ground-surface.js': {} });
const layers = load('sz-map-layers', { './sz-strings.js': strings, './sz-geodata.js': { GEO }, './sz-city-config.js': { ROADS: [] } });
const regions = load('sz-map-regions', { './sz-map-layers.js': layers, './sz-spatial.js': spatial,
  './sz-data-format.js': dataFormat, './sz-strings.js': strings, './sz-polygon.js': polygon }, { Path2D });
const encode = (...points) => points.flatMap(([x, z], i) =>
  [10 * (x - (points[i - 1]?.[0] ?? 0)), 10 * (z - (points[i - 1]?.[1] ?? 0))]);
const rectangle = (l, t, r, b) => encode([l, t], [r, t], [r, b], [l, b]);
const flags = { retail: true, regions: true, landmarks: true };
const records = [
  { id: 'a', type: 'park', name: null, level: 'place', areaM2: 10000,
    rings: [[encode([0, 0], [200, 0], [200, 70], [65, 70], [65, 160], [0, 160]), rectangle(10, 10, 25, 25)]],
    anchors: [[33, 120, 30]] },
  { id: 'b', type: 'office', name: 'Office', level: 'building', areaM2: 1600,
    rings: [[rectangle(85, 10, 125, 50)]], anchors: [[105, 30, 20]] },
  { id: 'c', type: 'retail', name: 'Retail', level: 'place', areaM2: 11000,
    rings: [[rectangle(210, 0, 320, 100)], [rectangle(330, 0, 430, 100)]], anchors: [[265, 50, 50]] }
];

test('region hits respect concavity, holes, street gaps, zoom and layer switches', () => {
  const map = regions.createMapRegions(records);
  const hit = (x, z, zoom = 1.5, layers = flags) => map.hit(x, z, zoom, layers)?.id ?? null;
  assert.equal(hit(15, 15), null);
  assert.equal(hit(150, 140), null);
  assert.equal(hit(100, 30, 0.5), 'a');
  assert.equal(hit(100, 30), 'b');
  assert.equal(hit(100, 30, 1.5, { retail: true }), null);
  assert.equal(hit(35, 120, 0.04), null);
  assert.equal(hit(265, 50), 'c');
  assert.equal(hit(325, 50), null);
  assert.equal(hit(365, 50), 'c');
  assert.equal(regions.regionName(map.hit(35, 120, 1, flags)), '未命名公园');
});

test('shared-edge hysteresis does not extend a hit into an unassigned street', () => {
  const right = { id: 'right', type: 'public', name: 'Facility', level: 'place', areaM2: 12000,
    rings: [[rectangle(200, 0, 260, 200)]], anchors: [[230, 70, 25]] };
  const map = regions.createMapRegions([records[0], right]);
  const previous = map.hit(199, 50, 1, flags);
  assert.equal(map.hit(200.5, 50, 1, flags, previous)?.id, 'a');
  assert.equal(map.hit(205, 50, 1, flags, previous)?.id, 'right');
  assert.equal(map.hit(197, 80, 1, flags, previous), null);
});

test('labels need an interior fit and yield to an existing marker', () => {
  const map = regions.createMapRegions([records[0]]);
  const drawn = [];
  const ctx = { strokeText() {}, fillText: (...args) => drawn.push(args) };
  const view = zoom => new layers.MapView(100, 100, zoom, 400, 300);
  map.drawLabels(ctx, view(0.3), flags, [], 'sans-serif', () => 45);
  assert.equal(drawn.length, 0);
  const placed = [];
  map.drawLabels(ctx, view(1), flags, placed, 'sans-serif', () => 45);
  assert.equal(drawn[0][0], '未命名公园');
  assert.equal(placed.length, 1);
  map.drawLabels(ctx, view(1), flags, placed, 'sans-serif', () => 45);
  assert.equal(drawn.length, 1);
});

test('touch selects without travel, hover leaves selection intact, and drag and drive suppress inspection', () => {
  class Element {
    constructor() { this.events = {}; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} }; }
    addEventListener(name, fn) { this.events[name] = fn; }
    fire(name, x, z, type = 'mouse') { this.events[name]({ preventDefault() {}, clientX: x, clientY: z,
      timeStamp: 100, pointerId: 1, pointerType: type, button: 0 }); }
    setAttribute() {}
    append() {}
    appendChild() {}
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  }
  const els = new Map();
  const canvas = new Element();
  const layer = regions.createMapRegions(records);
  const arrive = [];
  const drive = [];
  let pending = null;
  const map = { fullCanvas: canvas, viewZoom: 1.5, viewCenterX: 0, viewCenterZ: 0, mapLayersVisible: flags,
    isFullMapOpen: true, fullSize: () => ({ w: 400, h: 300 }), screenToWorld: (x, z) => ({ x, z }),
    renderPointerHint: text => { map.hint = text; }, renderFullMap() {}, regionLayer: () => layer,
    onTeleport: (...args) => arrive.push(args), pickDrivePoint: (...args) => drive.push(args), drive: { active: false } };
  const inspection = load('sz-map-inspection', { './sz-geodata.js': { GEO }, './sz-city-config.js': { NYC_LANDMARKS: [] },
    './sz-map-regions.js': regions, './sz-strings.js': strings }, {
    document: { getElementById(id) { if (!els.has(id)) els.set(id, new Element()); return els.get(id); },
      querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {} },
    window: { addEventListener() {} }, clearTimeout() {}, requestAnimationFrame: fn => (pending = fn, 1)
  }).wireMapInspection(map);
  const flush = () => { const fn = pending; pending = null; fn?.(); };
  canvas.fire('pointerdown', 100, 25, 'touch');
  canvas.fire('pointerup', 100, 25, 'touch');
  flush();
  assert.equal(inspection.highlight.id, 'b');
  assert.equal(arrive.length, 0);
  assert.match(els.get('map-selection-text').textContent, /Office/);

  canvas.fire('pointermove', 40, 130);
  flush();
  assert.equal(inspection.highlight.id, 'a');
  assert.equal(inspection.selection.x, 100);
  canvas.fire('pointerdown', 40, 130);
  canvas.fire('pointermove', 59, 110);
  flush();
  assert.equal(inspection.highlight, null);
  canvas.fire('pointerup', 59, 110);
  flush();
  assert.equal(inspection.selection.x, 100);
  for (let i = 0; i < 2; i++) {
    canvas.fire('pointerdown', 100, 25, 'touch');
    canvas.fire('pointerup', 100, 25, 'touch');
  }
  assert.equal(arrive.length, 1);
  assert.equal(arrive[0][0], 100);
  assert.equal(inspection.selection, null);

  map.isPlanningDrive = true;
  canvas.fire('pointerdown', 100, 25);
  canvas.fire('pointerup', 100, 25);
  flush();
  assert.equal(inspection.highlight, null);
  assert.deepEqual(drive, [[100, 25]]);
  assert.equal(arrive.length, 1);
});
