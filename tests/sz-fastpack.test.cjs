const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');

const root = join(__dirname, '..');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(root, 'js/sz-data-format.js')).toString('base64')}`);
const surfacePromise = import(`data:text/javascript;base64,${readFileSync(join(root, 'js/sz-ground-surface.js')).toString('base64')}`);
const json = readFileSync(join(root, 'js/sz-city.json.gz'));
const packed = readFileSync(join(root, 'js/sz-city.szc.gz'));

test('SZC1 preserves every city value and supports server-inflated responses', async () => {
  const { readCityPayload, decodeCityPayload } = await modulePromise;
  const expected = JSON.parse(gunzipSync(json));
  for (const bytes of [packed, gunzipSync(packed)]) {
    const actual = await readCityPayload('fixture', async () => new Response(bytes));
    const normalized = JSON.parse(JSON.stringify(actual, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value));
    assert.deepEqual(normalized, expected);
    assert.ok(actual.terrainSurface.chunks.some(chunk => ArrayBuffer.isView(chunk.positions)));
    assert.equal(decodeCityPayload(actual).buildings.length, expected.buildings.id.length);
  }
});

test('SZC1 rejects corruption, truncation, unknown versions and conflicting section lengths', async () => {
  const { decodeFastCity } = await modulePromise;
  const bytes = gunzipSync(packed);
  for (const edit of [
    b => b.subarray(0, b.length - 1),
    b => { b[4] = 9; return b; },
    b => { b[12] ^= 1; return b; },
    b => { b[b.length - 1] ^= 1; return b; }
  ]) {
    await assert.rejects(() => decodeFastCity(edit(Buffer.from(bytes))), /SZC1/);
  }
});

function fixture(metadata, body = Buffer.alloc(8)) {
  const text = Buffer.from(JSON.stringify(metadata));
  const padded = Buffer.alloc(Math.ceil(text.length / 8) * 8);
  text.copy(padded);
  const header = Buffer.alloc(16);
  header.write('SZC1');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(text.length, 8);
  header.writeUInt32LE(body.length, 12);
  const hash = createHash('sha256').update(header).update(padded).update(body).digest();
  return Buffer.concat([header, hash, padded, body]);
}

test('SZC1 rejects malformed numeric references even with a matching checksum', async () => {
  const { decodeFastCity } = await modulePromise;
  const column = { path: ['x'], type: 'f64', count: 1, offset: 0, bytes: 8 };
  for (const change of [
    { path: ['__proto__'] }, { path: ['missing'] }, { type: 'prototype' },
    { count: 2 }, { offset: 1 }, { count: -1 }
  ]) {
    await assert.rejects(() => decodeFastCity(fixture({ payload: { x: null }, columns: [{ ...column, ...change }] })), /SZC1/);
  }
  await assert.rejects(() => decodeFastCity(fixture({ payload: { x: null }, columns: [column, column] })), /SZC1/);
  const nan = Buffer.alloc(8);
  nan.writeDoubleLE(NaN);
  await assert.rejects(() => decodeFastCity(fixture({ payload: { x: null }, columns: [column] }, nan)), /finite/);
});

test('SZC1 handles unaligned byte views without changing values', async () => {
  const { decodeFastCity } = await modulePromise;
  const bytes = fixture({ payload: { x: null }, columns: [{ path: ['x'], type: 'f64', count: 1, offset: 0, bytes: 8 }] });
  const offset = new Uint8Array(bytes.length + 1);
  offset.set(bytes, 1);
  assert.deepEqual(await decodeFastCity(offset.subarray(1)), { x: [0] });
  assert.deepEqual(await decodeFastCity(Buffer.from(offset.buffer).subarray(1)), { x: [0] });
});

test('SZC1 preserves rendered terrain, triangle topology and contact heights across chunks', async () => {
  const { readCityPayload } = await modulePromise;
  const { unpackSurface, createGroundSurfaceSampler } = await surfacePromise;
  const expected = JSON.parse(gunzipSync(json));
  const actual = await readCityPayload('fixture', async () => new Response(packed));
  const before = unpackSurface(expected.terrainSurface);
  const after = unpackSurface(actual.terrainSurface);
  for (const [id, chunk] of before) {
    for (const key of ['positions', 'indices', 'cellRanges']) assert.deepEqual(after.get(id)[key], chunk[key]);
  }
  const sampleA = createGroundSurfaceSampler(expected.terrainSurface);
  const sampleB = createGroundSurfaceSampler(actual.terrainSurface);
  const [minX, minZ, maxX, maxZ] = actual.bounds;
  for (let x = minX; x <= maxX; x += 137) {
    for (let z = minZ; z <= maxZ; z += 131) assert.equal(sampleB(x, z), sampleA(x, z));
  }
});
