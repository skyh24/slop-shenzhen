const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(__dirname, '../js/sz-controller-surfaces.js')).toString('base64')}`);
const triangle = [{ x: 0, y: 10, z: 0 }, { x: 10, y: 12, z: 0 }, { x: 0, y: 10, z: 10 }];

test('contact height follows the supplied ramp triangle exactly', async () => {
  const { triangleHeight } = await modulePromise;
  assert.equal(triangleHeight(triangle, 0, 0), 10);
  assert.equal(triangleHeight(triangle, 5, 2), 11);
  assert.equal(triangleHeight(triangle, 8, 8), null);
});

test('underpass and elevated contacts retain their current level without snapping', async () => {
  const { createSurfaceResolver } = await modulePromise;
  const resolver = createSurfaceResolver({ groundHeight: () => 0,
    surfaces: [{ id: 'bridge', heightSource: 'fixture-measured', triangles: [triangle] }] });
  assert.equal(resolver.resolve(5, 2).surfaceId, 'terrain');
  assert.equal(resolver.resolve(5, 2, { previousY: 0, previousSurfaceId: 'terrain' }).height, 0);
  assert.equal(resolver.resolve(5, 2, { previousY: 10.8, previousSurfaceId: 'bridge' }).height, 11);
  assert.equal(resolver.resolve(8, 8, { previousY: 11, previousSurfaceId: 'bridge' }), null);
  assert.equal(resolver.below(5, 2, 10).height, 0);
  assert.equal(resolver.below(5, 2, 12).height, 11);
});

test('unknown ground and unresolved structural heights are never replaced with zero', async () => {
  const { createSurfaceResolver } = await modulePromise;
  assert.equal(createSurfaceResolver({ groundHeight: () => null }).resolve(0, 0), null);
  assert.throws(() => createSurfaceResolver({ groundHeight: () => 0,
    surfaces: [{ id: 'bridge', heightSource: 'unresolved', triangles: [triangle] }] }), /resolved height provenance/);
});
