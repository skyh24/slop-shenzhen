const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');

const file = name => join(__dirname, '../js', name);
const point = { x: 5, z: 5 };
const far = { x: 4000, z: 4000 };
const fingerprint = 'a'.repeat(64);
const nearRow = { id: 'metro-0', kind: 'metro', bounds: [4, 4, 6, 6], safety: [4, 4, 6, 6], safetyY: [0, 3], bytes: 30, count: 1 };
const remoteRow = { ...nearRow, id: 'metro-1', bounds: [3999, 3999, 4001, 4001], safety: [3999, 3999, 4001, 4001] };
const manifest = { version: 1, fingerprint, cells: [nearRow, remoteRow], drone: { stations: [], routes: [] } };

async function setup({ plan = manifest, mismatch = false } = {}) {
  const { createRegionalStream } = await import('../js/sz-regional-stream.js');
  const frames = [], requests = [], warnings = [];
  let live = 0;
  const stream = createRegionalStream(plan, {
    nextFrame: fn => frames.push(fn),
    now: () => 0,
    warn: message => warnings.push(message),
    request: async (url, { signal }) => {
      const id = url.pathname.split('/').at(-1).replace('.json', '');
      requests.push({ id, signal });
      return { ok: true, text: async () => JSON.stringify({ id, version: 1,
        fingerprint: mismatch ? 'b'.repeat(64) : fingerprint, data: [1] }) };
    },
    decode: row => ({ colliders: [{ type: 'metro', minX: row.safety[0], minZ: row.safety[1],
      maxX: row.safety[2], maxZ: row.safety[3], minY: 0, maxY: 3 }] }),
    mount: row => {
      assert.equal(stream.colliders(row.bounds[0], row.bounds[1], 0)[0].type, 'metro');
      live++;
      return { dispose() { live--; } };
    }
  });
  async function drain() {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
      for (const fn of frames.splice(0)) fn();
    }
  }
  return { stream, drain, requests, warnings, live: () => live };
}

test('regional safety is registered before visuals and load, exit and return balance resources', async () => {
  const { stream, drain, requests, live } = await setup();
  assert.equal(stream.colliders(point.x, point.z, 0)[0].type, 'regional-pending');
  const startup = stream.prepare(point);
  await drain();
  await startup;
  assert.equal(live(), 0);
  assert.equal(stream.colliders(point.x, point.z, 0)[0].type, 'metro');
  stream.start();
  stream.update(point);
  await drain();
  assert.equal(live(), 1);
  assert.deepEqual(stream.statistics.startup, { bytes: { metro: 30 }, objects: {}, safetyObjects: { metro: 1 } });

  stream.update(far);
  await drain();
  assert.equal(live(), 1);
  assert.equal(stream.colliders(point.x, point.z, 0)[0].type, 'regional-pending');
  assert.equal(requests[0].signal.aborted, true);
  stream.update(point);
  await drain();
  assert.equal(live(), 1);
  assert.deepEqual(requests.map(row => row.id), ['metro-0', 'metro-1', 'metro-0']);
  stream.dispose();
  assert.equal(live(), 0);
  assert.equal(stream.statistics.releases, 3);
});

test('obsolete fetches and mismatched packets never mount geometry', async () => {
  const { stream, drain, requests, live } = await setup();
  stream.start();
  stream.update(point);
  stream.update(far);
  await drain();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(live(), 1);
  assert.equal(stream.statistics.cancelled, 1);
  stream.dispose();

  const stale = await setup({ mismatch: true });
  stale.stream.start();
  stale.stream.update(point);
  await stale.drain();
  assert.equal(stale.live(), 0);
  assert.match(stale.warnings[0], /fingerprint mismatch/);
  assert.deepEqual(stale.stream.colliders(point.x, point.z, 0), []);
  const incompatible = await setup({ plan: { ...manifest, version: 0 } });
  assert.match(incompatible.warnings[0], /Missing or incompatible plan/);
  assert.equal(incompatible.stream.prepare(point), null);
});

test('regional data matches the city fingerprint and includes flyable offline motion', () => {
  const city = JSON.parse(gunzipSync(readFileSync(file('sz-city.json.gz'))));
  const { regionalScene: plan } = city;
  const counts = new Map();
  for (const row of plan.cells) {
    const bytes = readFileSync(file(`sz-regional/${plan.fingerprint.slice(0, 20)}/${row.id}.json`));
    const data = JSON.parse(bytes);
    assert.equal(bytes.length, row.bytes);
    assert.equal(data.fingerprint, plan.fingerprint);
    assert.equal(data.version, plan.version);
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + row.count);
    if (row.kind === 'flight') {
      assert.ok(data.data.legs.every(leg => leg.duration > 0 && leg.segment.length === leg.cumulative.length));
      assert.ok(data.data.cruiseY > 100);
    }
  }
  assert.ok(counts.get('metro') > 500);
  assert.ok(counts.get('shore') > 1000);
  assert.equal(counts.get('flight'), 10);
});
