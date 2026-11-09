const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const root = join(__dirname, '..');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(root, 'js/sz-data-format.js')).toString('base64')}`);
const bytes = readFileSync(join(root, 'js/sz-city.json.gz'));
const raw = JSON.parse(gunzipSync(bytes));

test('shared city loader accepts gzip and server-inflated data and rejects HTTP failures', async () => {
  const { readCityPayload } = await modulePromise;
  for (const body of [bytes, gunzipSync(bytes)]) {
    const result = await readCityPayload('fixture', async () => new Response(body));
    assert.equal(result.buildings.id.length, raw.buildings.h.length);
    assert.equal(result.origin[0], 114.0545);
  }
  await assert.rejects(() => readCityPayload('fixture', async () => new Response('', { status: 404 })), /404/);
  await assert.rejects(() => readCityPayload('fixture', async () => new Response(bytes.subarray(0, 80))));
});

test('runtime adapter preserves every building source, footprint, hole and vertical part', async () => {
  const { decodeCityPayload, decodePoly } = await modulePromise;
  const { buildings, geo } = decodeCityPayload(raw);
  assert.equal(buildings.length, raw.buildings.h.length);
  // 误识别过滤（docs/15-IMPROVEMENT-PLAN.md 3.2）会移除少数落在广场/绿地/车行道内的小轮廓，
  // 因此总数从约 39.9k 降到约 38.1k；这里只保留数量级保护，不锁定具体数量。
  assert.ok(buildings.length > 37500);
  let holes = 0, raisedParts = 0;
  buildings.forEach((building, i) => {
    assert.equal(building.id, raw.buildings.id[i]);
    assert.equal(building.heightSource, raw.enums.heightSource[raw.buildings.src[i]]);
    assert.equal(building.height, raw.buildings.h[i]);
    assert.equal(building.minHeight, raw.buildings.minH[i]);
    const rings = decodePoly(raw.buildings.rings[i]);
    const decoded = [building.polygons[0].outer, ...building.polygons[0].holes];
    assert.equal(decoded.length, rings.length);
    decoded.forEach((ring, j) => assert.deepEqual(ring.flatMap(p => [p.x, p.z]), Array.from(rings[j])));
    holes += building.polygons[0].holes.length;
    raisedParts += building.minHeight > 0;
  });
  assert.ok(holes > 0, 'courtyards remain open');
  assert.ok(raisedParts > 0, 'elevated parts retain their lower height');
  assert.equal(geo.roadGraph, raw.roadGraph);
  assert.equal(geo.terrain, raw.terrain);
  assert.equal(geo.frame.bearingDeg, 0);
});

test('city data rejects source loss, invalid topology and incompatible terrain before scene creation', async () => {
  const { validateCityPayload } = await modulePromise;
  const badOrigin = { ...raw, origin: [0, 0] };
  assert.throws(() => validateCityPayload(badOrigin), /origin/);
  assert.throws(() => validateCityPayload({ ...raw, buildings: { ...raw.buildings, id: [] } }), /buildings.id/);
  const badGraph = { ...raw.roadGraph, links: [[-1, 0, 0, 7, 1, 0, []]], metadata: [{}] };
  assert.throws(() => validateCityPayload({ ...raw, roadGraph: badGraph }), /graph link/);
  assert.throws(() => validateCityPayload({ ...raw, terrain: { ...raw.terrain, diagonal: 'nw-se' } }), /terrain grid/);
});

test('coordinate decoder rejects truncated or fractional delta streams', async () => {
  const { decodeRing } = await modulePromise;
  assert.throws(() => decodeRing([1, 2, 3]), /coordinate sequence/);
  assert.throws(() => decodeRing([0, 0, 0.5, 3]), /coordinate delta/);
});
