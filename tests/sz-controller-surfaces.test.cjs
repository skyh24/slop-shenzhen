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

test('flat contact triangles return the exact top of the rendered solid', async () => {
  const { triangleHeight } = await modulePromise;
  const top = Math.fround(11.6592);
  const platform = [{ x: 0, y: top, z: 0 }, { x: 5, y: top, z: 0 }, { x: 0, y: top, z: 7 }];
  for (const x of [0.13, 0.97, 2.1, 3.23]) {
    for (const z of [0.12, 0.87, 1.36]) assert.equal(triangleHeight(platform, x, z), top);
  }
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

test('descending terrain hands off to the first rendered platform crossed from above', async () => {
  const { createSurfaceResolver } = await modulePromise;
  const lower = triangle.map(point => ({ ...point, y: 11.3 }));
  const upper = triangle.map(point => ({ ...point, y: 11.66 }));
  const resolver = createSurfaceResolver({ groundHeight: () => 11.2, surfaces: [
    { id: 'lower', heightSource: 'fixture-measured', triangles: [lower] },
    { id: 'upper', heightSource: 'fixture-measured', triangles: [upper] }
  ] });
  assert.equal(resolver.resolve(5, 2, { previousY: 11.8, previousSurfaceId: 'terrain' }).surfaceId, 'upper');
  assert.equal(resolver.resolve(5, 2, { previousY: 11.21, previousSurfaceId: 'terrain' }).surfaceId, 'terrain');
  assert.equal(resolver.resolve(5, 2, { previousY: 11.33, previousSurfaceId: 'lower' }).surfaceId, 'lower');
  assert.equal(resolver.resolve(5, 2, { previousY: 11.66, previousSurfaceId: 'upper' }).surfaceId, 'upper');
});

test('unknown ground and unresolved structural heights are never replaced with zero', async () => {
  const { createSurfaceResolver } = await modulePromise;
  assert.equal(createSurfaceResolver({ groundHeight: () => null }).resolve(0, 0), null);
  assert.throws(() => createSurfaceResolver({ groundHeight: () => 0,
    surfaces: [{ id: 'bridge', heightSource: 'unresolved', triangles: [triangle] }] }), /resolved height provenance/);
});
