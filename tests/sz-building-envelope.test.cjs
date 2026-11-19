const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const polygon = require('./helpers/polygon.cjs');
const roads = require('./helpers/roads.cjs');
const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const realThree = { skip: !process.env.SZ_THREE_PACKAGE_DIR };
const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 1, heights: [0, 0, 0, 0] };
const volume = (id, minX, minZ, maxX, maxZ, height, minHeight = 0, holes = []) => ({
  id, minX, minZ, maxX, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
  height, minHeight, heightSource: 'osm-height', facade: 'office',
  polygons: [{ outer: ring(minX, minZ, maxX, maxZ), holes }]
});

async function harness() {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': loadModule(read('sz-terrain.js')) } });
  const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygon } });
  const envelope = loadModule(read('sz-building-envelope.js'), { imports: {
    './sz-geometry.js': geometry, './sz-polygon.js': polygon,
    './sz-building-envelope-relations.js': loadModule(read('sz-building-envelope-relations.js'))
  } });
  const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
    'three/webgpu': THREE, './sz-geodata.js': {}, './sz-geometry.js': geometry,
    './sz-building-layout.js': layout, './sz-building-envelope.js': envelope,
    './sz-building-plan.js': loadModule(read('sz-building-plan.js')),
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
    './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
    './sz-polygon.js': polygon, './sz-roads.js': roads, './building-collision.js': collision, './sz-retail-frontage.js': {}
  } });
  const build = (buildings, options = {}) => {
    const blocks = buildCityBlocks(new THREE.Scene(), { buildings, terrain: grid, roadGraph: null, entrances: [], ...options });
    blocks.group.updateMatrixWorld(true);
    return blocks;
  };
  const ray = (blocks, origin, direction, far) => new THREE.Raycaster(new THREE.Vector3(...origin),
    new THREE.Vector3(...direction), 0, far).intersectObjects(blocks.group.children);
  const roof = blocks => loadModule(read('sz-controller-surfaces.js')).createSurfaceResolver({ groundHeight: () => 0, surfaces: blocks.surfaces });
  return { build, ray, roof, layout, collision };
}

test('automatic envelopes retain partial wings, courtyards, source solids and raised passages across chunks', realThree, async () => {
  const { build, ray, roof, collision } = await harness();
  const main = volume('a-main', -10, -10, 10, 10, 30, 0, [ring(-8, 1, -4, 7)]);
  const part = volume('b-part', 0, -10, 18, 2, 12);
  const raised = volume('c-raised', 0, -10, 6, 0, 50, 40);
  const blocks = build([raised, part, main], { renderChunkSize: 4 });
  const front = (x, y) => ray(blocks, [x, y, -14], [0, 0, 1], 4.001);
  for (const [x, y] of [[3.17, 6.13], [3.17, 20.13], [15.13, 6.13], [3.17, 45.13]]) {
    assert.equal(front(x, y).length, 1, `exposed wall at ${x},${y}`);
  }
  assert.equal(front(3, 35).length, 0);
  assert.equal(roof(blocks).below(3, -4, 39).height, 30);
  assert.equal(roof(blocks).below(15, -4, 20).height, 12);
  assert.equal(roof(blocks).below(-6, 4, 100).height, 0);
  assert.equal(ray(blocks, [3, 35, -4], [0, 1, 0], 10)[0].point.y, 40);
  assert.equal(collision.polygonContains(blocks.colliders.find(c => c.sourceId === main.id).polygon, -6, 4), false);
  assert.equal(blocks.allBlocks.length, 3);
  assert.deepEqual(Array.from(blocks.colliders.filter(c => c.type === 'building'), c => [c.sourceId, c.minY, c.maxY]),
    [['c-raised', 40, 50], ['b-part', 0, 12], ['a-main', 0, 30]]);
  blocks.dispose();
});

test('unregistered equal volumes have deterministic walls, roofs and coping without deleting either source', realThree, async () => {
  const { build, ray } = await harness();
  const a = volume('a-owner', -10, -10, 10, 10, 30), b = volume('z-alias', -10, -10, 10, 10, 30);
  a.polygons[0].outer.reverse();
  const seeds = [];
  for (const sources of [[a, b], [b, a]]) {
    const blocks = build(sources);
    for (const y of [15, 30.4]) {
      const hits = ray(blocks, [2, y, -14], [0, 0, 1], 4.001);
      assert.equal(hits.length, 1, `wall or coping at ${y}`);
      seeds.push(hits[0].object.geometry.attributes.bmeta.getY(hits[0].face.a));
    }
    assert.equal(ray(blocks, [2, 35, 3], [0, -1, 0], 5.001).length, 1);
    assert.equal(blocks.allBlocks.length, 2);
    assert.equal(blocks.colliders.filter(c => c.type === 'building').length, 2);
    assert.equal(blocks.duplicateIds.size, 0);
    assert.equal(blocks.colliders.filter(c => c.type === 'roof-parapet' && c.minZ === -10 && c.maxZ === -10
      && c.minX < 2 && c.maxX > 2).length, 1);
    blocks.dispose();
  }
  assert.equal(new Set(seeds).size, 1);
});

test('touching footprints omit internal walls while a real narrow gap keeps both walls', realThree, async () => {
  const { build, ray } = await harness();
  for (const gap of [0, 0.02]) {
    const blocks = build([volume('a-west', -10, -10, 10, 10, 30), volume('b-east', 10 + gap, -10, 30, 10, 30)]);
    for (const y of [15, 30.4]) {
      const hits = ray(blocks, [11, y, 3], [-1, 0, 0], 1.01);
      assert.equal(hits.length, gap ? y > 30 ? 2 : 1 : 0, `shared wall or narrow gap at ${y}`);
    }
    blocks.dispose();
  }
});

test('scene takeovers and rejected road footprints cannot cut holes in a retained neighbour', realThree, async () => {
  const { build, ray } = await harness();
  const main = volume('way/retained', -10, -10, 10, 10, 30);
  const omitted = volume('overture/omitted', 0, -10, 18, 2, 40);
  for (const options of [{ skipIds: new Set([omitted.id]) }, { roadClearance: () => 'ground:road' }]) {
    const blocks = build([main, omitted], options);
    assert.equal(ray(blocks, [3, 6, -14], [0, 0, 1], 4.001).length, 1);
    assert.equal(ray(blocks, [3, 35, -4], [0, -1, 0], 5.001).length, 1);
    assert.equal(blocks.allBlocks.length, 1);
    assert.equal(blocks.envelopePlans.size, 0);
    assert.ok(blocks.detailPlan.skipIds.has(omitted.id));
    blocks.dispose();
  }
});

test('Cangsong, Haisong and Vanke source overlaps render one wall at every sampled height automatically', realThree, async () => {
  const { build, ray, layout } = await harness();
  const { decodeCityPayload } = await import('../js/sz-data-format.js');
  const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
  const samples = [
    ['way/1305286519', 'way/1305286520', [-3383.9, 1262.6], [-3339.1, 1254.3]],
    ['way/341698304', 'way/1431632124', [-3729.6, 1360.9], [-3722.7, 1398.5]],
    ['way/341698304', 'way/1431632125', [-3591.4, 1448], [-3598.3, 1410.4]],
    ['way/779229114', 'way/1305286514', [-3493.4, 1513.1], [-3440.4, 1512.5]]
  ];
  const ids = new Set(samples.flatMap(row => row.slice(0, 2)));
  const sources = buildings.filter(b => ids.has(b.id));
  assert.equal(sources.length, 7);
  const blocks = build(sources, { terrain: geo.terrain });
  for (const [aId, bId, a, b] of samples) {
    const [p, q] = [aId, bId].map(id => layout.buildingPlacement(sources.find(b => b.id === id), geo.terrain));
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz), nx = dz / length, nz = -dx / length;
    for (const t of [0.25, 0.5, 0.75]) {
      const y = Math.max(p.minY, q.minY) + t * (Math.min(p.maxY, q.maxY) - Math.max(p.minY, q.minY));
      const x = a[0] + dx * 0.43, z = a[1] + dz * 0.43;
      const count = Math.max(...[1, -1].map(sign => ray(blocks, [x + nx * sign, y, z + nz * sign],
        [-nx * sign, 0, -nz * sign], 1.001).filter(hit => Math.abs(hit.distance - 1) < 0.001).length));
      assert.equal(count, 1, `${aId}/${bId} at ${y}`);
    }
  }
  assert.equal(blocks.allBlocks.length, sources.length);
  assert.equal(JSON.stringify(blocks.colliders.filter(c => c.type === 'building')),
    JSON.stringify(sources.flatMap(b => layout.buildingPlacement(b, geo.terrain).colliders)));
  blocks.dispose();
});
