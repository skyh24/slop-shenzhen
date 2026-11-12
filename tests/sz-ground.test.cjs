const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const root = join(__dirname, '..');
const source = readFileSync(join(root, 'js/sz-ground-surface.js'), 'utf8').replace("import * as THREE from 'three/webgpu';", 'const THREE = {};');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('rendered Shenzhen Bay water keeps the Hong Kong pylon island and the park dry', { skip: !threeDir }, async () => {
  const read = name => readFileSync(join(root, 'js', name), 'utf8');
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const { buildSzSea } = loadModule(read('sz-sea.js'), { imports: {
    ...imports, './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports }),
    './sz-water-material.js': { createSzWaterMaterial: () => new THREE.MeshStandardNodeMaterial({ roughness: 0.12 }) }
  } });
  const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
  const raw = JSON.parse(gunzipSync(readFileSync(join(root, 'js/sz-city.json.gz'))));
  const { geo } = decodeCityPayload(raw);
  const scene = new THREE.Scene();
  const sea = buildSzSea(scene, geo.seaSurface);
  scene.updateMatrixWorld(true);
  const level = (x, z) => new THREE.Raycaster(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0))
    .intersectObject(sea.mesh)[0]?.point.y ?? null;
  const [north, south] = geo.bridges.find(bridge => bridge.id === 'shenzhen-bay-bridge').spans.map(span => span.tower);
  assert.equal(level(north.x, north.z), 0);
  assert.equal(level(south.x, south.z), null);
  assert.equal(level(-9000, 9000), 0);
  assert.equal(level(-10804.1, 4963.3), null);
  assert.equal(level(-9000, 11000), null);
  assert.equal(sea.mesh.userData.source.verticalDatum, 'EGM2008');
  sea.dispose();
  assert.equal(scene.children.length, 0);
});

test('contact query reads rendered Float32 triangle positions and excludes missing surfaces', async () => {
  const { createGroundSurfaceSampler } = await modulePromise;
  const surface = { version: 1, chunkSize: 25, diagonal: 'ne-sw',
    grid: { x0: 0, z0: 0, step: 25, nx: 3, nz: 2 }, chunks: [
      { id: '0,0', origin: [0, 0], positions: [0, 0, 0, 0, 20.123456, 25, 25, 10, 0],
        indices: [0, 1, 2], kinds: [0, 0, 0], cellRanges: [0, 0, 3] },
      { id: '1,0', origin: [25, 0], positions: [0, 10, 0, 0, 40, 25, 25, 30, 0],
        indices: [0, 1, 2], kinds: [3, 3, 3], cellRanges: [1, 0, 3] }
    ] };
  const height = createGroundSurfaceSampler(surface);
  const expected = new Float32Array([20.123456])[0] * 0.4 + 10 * 0.2;
  assert.equal(height(5, 10), expected);
  assert.equal(height(20, 20), null, 'unrendered half cell remains empty');
  assert.equal(height(25, 0), 10, 'shared chunk border remains continuous');
  assert.equal(height(-1, 0), null);
  assert.equal(height(NaN, 0), null);
  surface.chunks[1].kinds[0] = 4;
  assert.throws(() => createGroundSurfaceSampler(surface), /Invalid terrain surface chunk/);
});

test('generated clipped ground is queryable without filling a subcell lake or coastline gap', async () => {
  const { createGroundSurfaceSampler } = await modulePromise;
  const code = `import sys,json
sys.path.insert(0,'tools/sz')
from shapely.geometry import box
from terrain_surface import build_terrain_surface
g={'x0':0,'z0':0,'step':25,'nx':3,'nz':3,'heightScale':0.1,'diagonal':'ne-sw','heights':[0,100,300,200,500,400,600,200,100],'processing':{'heightSource':'fixture'}}
s=build_terrain_surface(g,box(0,0,50,50),[box(0,0,47,50)],[{'poly':box(11,0,13,50)}],{},chunk_size=25)
print(json.dumps(s))`;
  const surface = JSON.parse(execFileSync(join(root, '.venv/bin/python'), ['-c', code], { cwd: root }));
  const height = createGroundSurfaceSampler(surface);
  assert.equal(height(12, 20), null, 'narrow water cut is retained inside a DEM cell');
  assert.equal(height(49, 20), null, 'coastline is not rounded up to the raster edge');
  assert.ok(Math.abs(height(10, 10) - 12) < 1e-5);
  assert.equal(height(25, 25), 50);
  for (const chunk of surface.chunks) {
    for (let p = 0; p < chunk.indices.length; p += 3) {
      const points = chunk.indices.slice(p, p + 3).map(index => chunk.positions.slice(index * 3, index * 3 + 3));
      const x = points.reduce((sum, v) => sum + Math.fround(v[0]), 0) / 3 + chunk.origin[0];
      const z = points.reduce((sum, v) => sum + Math.fround(v[2]), 0) / 3 + chunk.origin[1];
      const y = points.reduce((sum, v) => sum + Math.fround(v[1]), 0) / 3;
      assert.ok(Math.abs(height(x, z) - y) < 1e-5);
    }
  }
});

test('expanded city ground keeps the coastal districts, Nanshan relief and the Hong Kong exclusion', async () => {
  const { createGroundSurfaceSampler } = await modulePromise;
  const raw = JSON.parse(gunzipSync(readFileSync(join(root, 'js/sz-city.json.gz'))));
  const height = createGroundSurfaceSampler(raw.terrainSurface);
  const places = new Map(raw.landmarks.map(place => [place.id, place]));
  for (const id of ['huangbeiling', 'shenzhen-north', 'oh-bay', 'taizi-bay']) {
    const { x, z } = places.get(id);
    assert.equal(height(x, z), 8, id);
  }
  assert.ok(height(-15964.2, 5647.6) > 180, 'Nanshan mountain relief');
  for (const [x, z] of [[1491.5, 3798.3], [-1285.8, 6234.5], [7457.5, 2690.9]]) {
    assert.equal(height(x, z), null);
    const { x0, z0, step, nx, heights } = raw.terrain;
    const index = Math.round((z - z0) / step) * nx + Math.round((x - x0) / step);
    assert.equal(heights[index], 0, 'masked samples carry no DSM elevation');
  }
});
