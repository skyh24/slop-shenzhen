const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '..', 'js', name), 'utf8');
const sessionModule = loadModule(read('sz-observation-session.js'));
const { createObservationSessions } = sessionModule;
const strings = loadModule(read('sz-strings.js'));

function dom() {
  const nodes = new Map();
  function element() {
    return {
      hidden: true, dataset: {}, textContent: '',
      classList: { toggle() {} },
      append(...children) { this.children = children; },
      addEventListener(type, handler) { this[type] = handler; },
      setAttribute() {},
      closest() { return null; },
      focus() { this.focused = true; }
    };
  }
  return { nodes, document: {
    hidden: false, body: { dataset: {} }, createElement: element,
    querySelectorAll: () => [],
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    }
  } };
}

test('failed program changes keep the active orbit or prior show and restore the first camera and time on exit', () => {
  const { document } = dom();
  const observationSessions = createObservationSessions();
  const { wireShowPrograms } = loadModule(read('sz-ui.js'), {
    imports: { './sz-strings.js': strings, './sz-city-config.js': {}, './sz-observation-session.js': sessionModule },
    globals: { document }
  });
  const { wireLandmarkOrbit } = loadModule(read('sz-landmark-views.js'), {
    imports: { './sz-strings.js': strings, './sz-observation-session.js': sessionModule },
    globals: { document }
  });
  const position = { x: 201, y: 8, z: 0 };
  let surfaceId = 'plaza';
  const controllerManager = {
    keys: {}, activeMode: 'person', getActiveEntity: () => ({ position }),
    findModePosition: () => ({ ...position, surfaceId }), nearColliders: () => []
  };
  const lightingSystem = { activePresetId: 'day' };
  const cameraSystem = {
    camera: { position }, activePresetId: 'action', orbitYawOffset: 0.7, orbitPitchOffset: 0.1, zoomMultiplier: 1.2,
    startLandmarkOrbit() { this.landmarkOrbit = {}; this.activePresetId = 'landmarkOrbit'; },
    resetForTeleport() { this.landmarkOrbit = null; }
  };
  const selectCamera = id => { cameraSystem.activePresetId = id; cameraSystem.landmarkOrbit = null; };
  const show = (id, arrivalSurface) => {
    const calls = [];
    const program = {
      cue: 0, start() { calls.push('start'); return this.canStart !== false; }, stop: () => calls.push('stop'),
      update: dt => calls.push(dt)
    };
    return { calls, entryIds: [id], labels: { cues: ['cue'], noArrival: 'No landing' }, program,
      arrival: { ...position, surfaceId: arrivalSurface } };
  };
  const summit = show('summit', 'plaza');
  const park = show('park', 'park');
  let canMove = true;
  const programs = wireShowPrograms({
    shows: [summit, park], controllerManager, cameraSystem, lightingSystem, observationSessions,
    selectMode: () => canMove, selectCamera, selectTime: id => { lightingSystem.activePresetId = id; },
    closePopovers() {}, resetInput() {}
  });
  const orbitButton = document.getElementById('orbit');
  const orbit = wireLandmarkOrbit({
    button: orbitButton, views: new Map([['landmark', { x: 0, z: 0, base: 8, roof: 60 }]]),
    controllerManager, cameraSystem, heightAt: () => 8, mapOpen: () => false, onStart() {},
    exit: () => selectCamera('chase'), observationSessions
  });
  const click = id => document.getElementById(id).click();
  click('orbit');
  assert.equal(cameraSystem.activePresetId, 'landmarkOrbit');
  click('park');
  assert.equal(cameraSystem.activePresetId, 'landmarkOrbit');
  assert.equal(programs.active, false);
  click('summit');
  assert.equal(programs.active, true);
  assert.equal(cameraSystem.activePresetId, 'pov');
  assert.equal(cameraSystem.landmarkOrbit, null);
  assert.equal(lightingSystem.activePresetId, 'midnight');
  orbit.update();
  assert.equal(orbitButton.hidden, true);
  surfaceId = 'park';
  canMove = false;
  click('park');
  programs.update(0.1);
  assert.deepEqual(summit.calls, ['start', 0.1]);
  assert.deepEqual(park.calls, ['start', 'stop']);
  canMove = true;
  park.program.canStart = false;
  click('park');
  assert.deepEqual(summit.calls, ['start', 0.1]);
  park.program.canStart = true;
  click('park');
  assert.deepEqual(summit.calls, ['start', 0.1, 'stop']);
  assert.deepEqual(park.calls, ['start', 'stop', 'start', 'start']);
  assert.equal(programs.previousTime, 'day');
  click('program-exit');
  programs.end();
  assert.deepEqual(park.calls, ['start', 'stop', 'start', 'start', 'stop']);
  assert.equal(lightingSystem.activePresetId, 'day');
  assert.equal(cameraSystem.activePresetId, 'chase');
  assert.equal(cameraSystem.orbitYawOffset, 0.7);
  assert.equal(document.getElementById('btn-program').focused, true);
});

test('air cruise updates camera and input only after route entry and restores them on exit', () => {
  const { document } = dom();
  const { wireAirCruise } = loadModule(read('sz-air-cruise-ui.js'), {
    imports: { './sz-strings.js': strings, './sz-observation-session.js': sessionModule }, globals: { document }
  });
  const route = { id: 'beihuan', start: { name: 'West' }, end: { name: 'East' }, distance: 1000, length3d: 1000,
    estimateSeconds: 100 };
  let accepted = false, activeRoute = null, touchEnabled = true;
  const cruise = {
    routes: [route], scenicSpeed: 15, fullSpeed: 30,
    get active() { return activeRoute !== null; },
    get route() { return activeRoute; },
    status: 'aligning', distance: 0, altitude: 200, targetHeight: 200,
    start(next) { if (accepted) activeRoute = next; return accepted; },
    stop() { activeRoute = null; }
  };
  const cameraSystem = {
    activePresetId: 'action', orbitYawOffset: 0.7, orbitPitchOffset: 0.1, zoomMultiplier: 1.2, userOrbitTimer: 2,
    resetForTeleport() { this.orbitYawOffset = this.orbitPitchOffset = this.userOrbitTimer = 0; this.zoomMultiplier = 1; }
  };
  const modeLabel = { textContent: 'Walking' }, cameraLabel = { textContent: 'Action' };
  const ui = wireAirCruise({
    cruise, cameraSystem, controllerManager: { resetInput() {}, getActiveEntity: () => ({ label: 'Walking' }) },
    mapSystem: { isFullMapOpen: false }, touchControls: { setEnabled: enabled => { touchEnabled = enabled; } },
    gamepadControls: { reset() {} }, laneAssist: { cancel() {} }, observationSessions: createObservationSessions(),
    selectCamera: id => { cameraSystem.activePresetId = id; }, closePopovers() {}, modeLabel, cameraLabel,
    buildingDetails: {}
  });
  const start = document.getElementById('air-cruise-routes').children[0].children.at(-1).children[0];
  start.click();
  assert.equal(cruise.active, false);
  assert.equal(touchEnabled, true);
  assert.equal(cameraSystem.activePresetId, 'action');
  assert.equal(document.getElementById('air-cruise-feedback').hidden, false);
  accepted = true;
  start.click();
  assert.equal(cruise.active, true);
  assert.equal(touchEnabled, false);
  assert.equal(cameraSystem.activePresetId, 'chase');
  cameraSystem.orbitYawOffset = 1.4;
  accepted = false;
  start.click();
  assert.equal(cruise.active, true);
  assert.equal(cameraSystem.orbitYawOffset, 1.4);
  ui.close();
  ui.close();
  assert.equal(cruise.active, false);
  assert.equal(touchEnabled, true);
  assert.equal(cameraSystem.activePresetId, 'action');
  assert.equal(cameraSystem.orbitYawOffset, 0.7);
  assert.equal(cameraSystem.orbitPitchOffset, 0.1);
  assert.equal(cameraSystem.zoomMultiplier, 1.2);
  assert.equal(cameraSystem.userOrbitTimer, 2);
});
