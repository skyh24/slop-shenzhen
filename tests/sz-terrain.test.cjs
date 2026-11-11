const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const modulePromise = import(`data:text/javascript;base64,${readFileSync(join(root, 'js/sz-terrain.js')).toString('base64')}`);

test('terrain contact matches both rendered triangle planes and boundary vertices', async () => {
  const { terrainHeight, terrainCellTriangles } = await modulePromise;
  const grid = { x0: -25, z0: 50, step: 25, nx: 2, nz: 2, heightScale: 0.1, heights: [0, 100, 200, 500] };
  const triangles = terrainCellTriangles(grid, 0, 0);
  for (const triangle of triangles) {
    for (const weights of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.3, 0.5]]) {
      const p = [0, 1, 2].map(axis => triangle.reduce((sum, v, k) => sum + v[axis] * weights[k], 0));
      assert.ok(Math.abs(terrainHeight(grid, p[0], p[2]) - p[1]) < 1e-9);
    }
  }
  assert.equal(terrainHeight(grid, -12.5, 62.5), 15, 'diagonal is planar rather than bilinear');
  assert.equal(terrainHeight(grid, -26, 50), null);
  assert.equal(terrainHeight(null, 0, 0), null);
});
