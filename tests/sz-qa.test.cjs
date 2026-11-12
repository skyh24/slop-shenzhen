const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '..', file), 'utf8');
const main = read('js/main.js');
const qa = loadModule(read('js/sz-qa.js'), { imports: {
  'three/webgpu': { Group: class Group {}, TimestampQuery: { RENDER: 'render' } },
  './sz-geodata.js': { GEO: { roadGraph: { nodes: [] } } }
}, globals: { URLSearchParams } });
const sessionFor = (search, hostname = '127.0.0.1') =>
  qa.createQaSession({ search, hostname, defaultChunkSize: 1000 });

test('the entry stays a single wiring file under the package size limit', () => {
  assert.ok(main.split('\n').length <= 1000, `js/main.js has ${main.split('\n').length} lines`);
});

test('the plain entry exposes no QA globals; only the qa session installs them', () => {
  assert.ok(!/window\.__sz/.test(main), 'js/main.js no longer assigns window.__sz* itself');
  assert.match(main, /if \(qa\.enabled\) \{[\s\S]*?qa\.install\(/, 'the installer runs only for an enabled QA session');
  const installs = main.match(/qa\.install\(/g) ?? [];
  assert.equal(installs.length, 1, 'the installer is called once');
});

test('the QA session installs only on loopback hosts with ?qa=1', () => {
  assert.equal(sessionFor('?qa=1', 'example.test').enabled, false);
  assert.equal(sessionFor('', '127.0.0.1').enabled, false);
  assert.equal(sessionFor('?qa=1', 'localhost').enabled, true);
  assert.equal(sessionFor('?qa=1', '127.0.0.1').enabled, true);
});

test('the QA camera and chunk options keep their documented parsing', () => {
  const session = sessionFor('?qa=1&cam=1,2,3,4,5,6&chunks=500');
  assert.equal(session.camera.join(','), '1,2,3,4,5,6');
  assert.equal(session.chunkSize, 500);
  assert.equal(sessionFor('?qa=1').chunkSize, 1000);
  assert.throws(() => sessionFor('?qa=1&cam=1,2,3'), /Invalid QA camera/);
  assert.throws(() => sessionFor('?qa=1&cam=1,2,3,4,5,x'), /Invalid QA camera/);
});

test('public URLs and non-QA loopback URLs ignore debug query options', () => {
  for (const session of [
    sessionFor('?qa=1&cam=invalid&chunks=500&skip=trees', 'example.test'),
    sessionFor('?cam=invalid&chunks=500&skip=trees')
  ]) {
    assert.equal(session.camera, null);
    assert.equal(session.chunkSize, 1000);
    assert.equal(session.stage('trees', () => 'built'), 'built');
  }
});

test('skip stages only apply inside QA and return the documented stubs', () => {
  const build = () => ({ built: true });
  assert.equal(sessionFor('?qa=1&skip=landmarks,trees').stage('landmarks', build).colliders.length, 0);
  assert.equal(sessionFor('?qa=1&skip=landmarks,trees').stage('trees', build).built, undefined);
  assert.equal(sessionFor('?qa=1&skip=landmarks').stage('drones', build).built, true,
    'stages that are not listed still build');
  assert.equal(sessionFor('', 'example.test').stage('landmarks', build).built, true,
    'skip has no effect outside QA');
  assert.doesNotThrow(() => sessionFor('?qa=1&skip=lightshow').stage('lightshow', build).update());
  assert.equal(sessionFor('?qa=1&skip=stations').stage('stations', build), null,
    'the station stage stub is the existing optional null');
  assert.throws(() => sessionFor('?qa=1&skip=unknown-stage').stage('unknown-stage', build),
    /Unknown skip stage/);
});

test('startup timings and the fixed camera are recorded only for a QA session', () => {
  const plain = sessionFor('', 'example.test');
  plain.markStartup('renderer', 12);
  assert.equal(Object.keys(plain.startup).length, 0);
  const session = sessionFor('?qa=1&cam=10,20,30,40,50,60');
  session.markStartup('renderer', 12);
  assert.equal(session.startup.renderer, 12);
  const camera = {
    position: { set: (...values) => { camera.set = values; } },
    lookAt: (...values) => { camera.target = values; },
    updateMatrixWorld: () => { camera.updated = true; }
  };
  session.applyCamera(camera);
  assert.deepEqual(camera.set, [10, 20, 30]);
  assert.deepEqual(camera.target, [40, 50, 60]);
  assert.equal(camera.updated, true);
  const plainCamera = { position: { set: () => assert.fail('plain sessions must not move the camera') } };
  plain.applyCamera(plainCamera);
});

test('the [init] stage log and its data labels stay in the entry', () => {
  assert.match(main, /console\.log\(`\[init\] \$\{initTimings\.join\(', '\)\}`\)/);
  for (const label of ['data.download', 'data.decompress', 'data.parse', 'data.validate', 'data.decode']) {
    assert.ok(main.includes(`'${label}'`), `${label} stays a [init] stage label`);
  }
  assert.match(main, /const DATA_STAGE_LABELS = \{[\s\S]*?decodeMs: 'data\.decode'/);
});

test('the landmark site takeover now lives next to the landmark plans', () => {
  assert.ok(!main.includes('polygonContains'), 'the entry no longer imports the polygon test');
  assert.match(main, /skipIds: landmarks\.skipIds/);
  assert.match(read('js/sz-landmarks/layout.js'), /export function siteTakeoverIds/);
});
