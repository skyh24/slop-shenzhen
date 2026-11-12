const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const THREE_STUB = {};
// 解码/LOD 纯函数测试用不到树冠库；真实 Three 用例里再加载 sz-tree-crown.js。
const crownStub = {
  CROWN_SPECIES: { ficus: {}, camphor: {}, phoenix: {}, bauhinia: {}, 'royal-palm': {}, kapok: {} },
  createCrownLibrary: () => { throw new Error('crown library not used here'); }
};
const trees = loadModule(read('sz-trees.js'), {
  imports: { 'three/webgpu': THREE_STUB, './sz-polygon.js': polygonModule, './sz-tree-crown.js': crownStub }
});

const SPECIES = ['ficus', 'camphor', 'phoenix', 'bauhinia', 'royal-palm', 'kapok'];
const SOURCES = ['osm-node', 'osm-row', 'simulated-street', 'simulated-park'];
const APPEARANCE = ['osm-tags', 'species-estimate'];

// 分米整数输入，和共享包里的 trees 段一致。
function makePayload(records) {
  return {
    version: 1,
    count: records.length,
    x: records.map(record => record.x),
    z: records.map(record => record.z),
    height: records.map(record => record.height ?? 110),
    crown: records.map(record => record.crown ?? 90),
    species: records.map(record => SPECIES.indexOf(record.species ?? 'ficus')),
    source: records.map(record => SOURCES.indexOf(record.source ?? 'simulated-street')),
    appearance: records.map(record => APPEARANCE.indexOf(record.appearance ?? 'species-estimate')),
    speciesNames: SPECIES,
    sources: SOURCES,
    appearanceSources: APPEARANCE,
    osm: records.flatMap((record, index) => (record.osm ? [[index, record.osm]] : [])),
    stats: { requested: records.length, kept: records.length, countsBySource: {} },
    limitations: []
  };
}

test('tree payload decodes decimetres to metres and keeps provenance', () => {
  const payload = makePayload([
    { x: -123, z: 456, height: 110, crown: 90, species: 'camphor', source: 'osm-node',
      appearance: 'osm-tags', osm: 'node/123' },
    { x: 12, z: -34, height: 55, crown: 40, species: 'bauhinia', source: 'simulated-park' }
  ]);
  const decoded = trees.decodeTreePayload(payload);
  assert.equal(decoded.count, 2);
  assert.equal(decoded.x[0], -12.3);
  assert.equal(decoded.z[0], 45.6);
  assert.equal(decoded.height[0], 11);
  assert.equal(decoded.crown[0], 9);
  assert.deepEqual([...decoded.speciesNames], [...SPECIES]);
  assert.deepEqual([...decoded.sources], [...SOURCES]);
  assert.equal(decoded.osm.get(0), 'node/123');
  assert.equal(decoded.osm.has(1), false);
  assert.equal(trees.decodeTreePayload(undefined), null);
  assert.equal(trees.decodeTreePayload(null), null);
  const empty = trees.decodeTreePayload(makePayload([]));
  assert.equal(empty.count, 0);
});

test('tree payload validation rejects malformed arrays, lengths and enums', () => {
  const good = makePayload([{ x: 0, z: 0, osm: 'node/1', source: 'osm-node' }]);
  const cases = [
    [() => ({ ...good, version: 2 }), /version/],
    [() => ({ ...good, count: 60001 }), /count/],
    [() => ({ ...good, x: [0, 1] }), /length/],
    [() => ({ ...good, x: [1.5] }), /x values/],
    [() => ({ ...good, height: [0] }), /height range/],
    [() => ({ ...good, crown: [-1] }), /crown range/],
    [() => ({ ...good, species: [99] }), /species index/],
    [() => ({ ...good, source: [99] }), /source index/],
    [() => ({ ...good, appearance: [9] }), /appearance index/],
    [() => ({ ...good, appearanceSources: ['osm-tags'] }), /appearanceSources/],
    [() => ({ ...good, osm: [[0, 'relation/1']] }), /osm id/],
    [() => ({ ...good, osm: [[3, 'node/1']] }), /osm index/],
    [() => ({ ...good, osm: [[0, 'node/1'], [0, 'node/2']] }), /osm duplicate/],
    [() => ({ ...good, osm: [[0, 'node/1']], source: [2] }), /osm source/]
  ];
  for (const [build, pattern] of cases) {
    assert.throws(() => trees.decodeTreePayload(build()), pattern);
  }
});

test('tree chunks are deterministic and keyed by 1000 m cells', () => {
  const payload = makePayload([
    { x: 40, z: -40 },
    { x: 12000, z: 500 },
    { x: -15000, z: -25000 }
  ]);
  const decoded = trees.decodeTreePayload(payload);
  const chunks = trees.planTreeChunks(decoded);
  assert.deepEqual([...chunks.keys()], ['-2,-3', '0,-1', '1,0']);
  assert.equal(chunks.get('0,-1')[0].index, 0);
  assert.equal(chunks.get('0,-1')[0].x, 4);
  assert.equal(chunks.get('0,-1')[0].height, 11);
  const again = trees.planTreeChunks(decoded);
  assert.equal(JSON.stringify([...again.entries()]), JSON.stringify([...chunks.entries()]));
  const smaller = trees.planTreeChunks(decoded, 500);
  assert.deepEqual([...smaller.keys()], ['-3,-5', '0,-1', '2,0']);
  assert.equal(trees.planTreeChunks(null).size, 0);
  assert.throws(() => trees.planTreeChunks(decoded, 0), /chunk size/);
});

test('tree LOD keeps near crowns under 180 m and hides beyond 900 m', () => {
  assert.equal(trees.treeLod(0), 'near');
  assert.equal(trees.treeLod(179.999), 'near');
  assert.equal(trees.treeLod(180), 'far');
  assert.equal(trees.treeLod(500), 'far');
  assert.equal(trees.treeLod(900), 'far');
  assert.equal(trees.treeLod(900.001), 'hidden');
  assert.equal(trees.treeLod(Infinity), 'hidden');
  assert.equal(trees.treeLod(150, 200, 400), 'near');
  assert.equal(trees.treeLod(300, 200, 400), 'far');
  assert.equal(trees.treeLod(450, 200, 400), 'hidden');
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;

test('instanced tree chunks place trunks on the lowest probe height and switch LOD by camera', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  const model = loadModule(read('sz-trees.js'), {
    imports: { 'three/webgpu': THREE, './sz-polygon.js': polygonModule,
      './sz-tree-crown.js': { CROWN_SPECIES: crown.CROWN_SPECIES, createCrownLibrary: crown.createCrownLibrary } }
  });
  const payload = makePayload([
    { x: 0, z: 0, height: 120, crown: 100, osm: 'node/1', source: 'osm-node', appearance: 'osm-tags' },
    { x: 15000, z: 0, height: 120, crown: 100, source: 'simulated-park' },
    { x: 5000, z: 5000, height: 120, crown: 100 }, // 车行道上的候选：运行时跳过
    { x: -5000, z: -5000, height: 120, crown: 100 }, // 地形高程未知
    { x: 11000, z: 0, height: 120, crown: 100 }, // 步道冲突
    { x: 21000, z: 0, height: 120, crown: 100 } // 建筑冲突
  ]);
  const groundHeight = (x, z) => (Math.abs(x + 500) < 1.5 && Math.abs(z + 500) < 1.5 ? null : 5);
  const roadHeight = (x, z) => (x > 495 && x < 505 && z > 495 && z < 505 ? 4 : null);
  const pathAt = (x, z) => (x > 1095 && x < 1105 ? ['footway'] : []);
  const building = {
    minY: 0, maxY: 30, minX: 2050, maxX: 2150, minZ: -50, maxZ: 50,
    polygon: { outer: [{ x: 2050, z: -50 }, { x: 2150, z: -50 }, { x: 2150, z: 50 }, { x: 2050, z: 50 }], holes: [] }
  };
  const scene = new THREE.Scene();
  const built = model.buildSzTrees(scene, payload, { groundHeight, roadHeight, pathAt, colliders: [building] });
  scene.updateMatrixWorld(true);
  assert.equal(built.statistics.placed, 2);
  assert.equal(JSON.stringify(built.statistics.skipped), JSON.stringify({
    unsupportedGround: 1, roadConflict: 1, pathConflict: 1, buildingConflict: 1,
    openMedian: 0, roadside: 0, frontageTrunkConflict: 0, frontageCrownConflict: 0
  }));
  assert.equal(built.statistics.payloadCount, 6);
  assert.equal(built.statistics.chunks, 2);
  assert.equal(built.group.children.length, 6);
  assert.equal(built.colliders.length, 2);
  assert.equal(built.colliders[0].type, 'tree');
  assert.equal(built.colliders[0].sourceId, 'node/1');
  assert.equal(built.colliders[0].minY, 5);
  assert.ok(built.colliders[0].maxY > 5);

  const trunkMesh = built.group.getObjectByName('tree-trunks-far:0,0/0,0');
  const matrix = new THREE.Matrix4();
  trunkMesh.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[13], 5);

  // 近/远/隐藏三档切换：初始相机在原点时 0,0 块用近冠。
  const nearMesh = built.group.getObjectByName('tree-crowns-near:0,0/0,0:ficus');
  const farMesh = built.group.getObjectByName('tree-crowns-far:0,0/0,0');
  assert.equal(nearMesh.visible, true);
  assert.equal(farMesh.visible, false);
  assert.equal(trunkMesh.visible, false);
  nearMesh.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[13], 5);
  assert.equal(matrix.elements[5], 12);
  assert.equal(built.statistics.visible.nearCells, 1);
  assert.equal(built.statistics.visible.hiddenCells, 1);
  assert.equal(built.statistics.lodCells, 2);

  // 近景榕树用叶卡树冠：实例属性齐全，远景仍是 80 三角形的低模 icosahedron。
  assert.ok(nearMesh.geometry.attributes.aTreeData);
  assert.ok(nearMesh.geometry.attributes.aTreeSway);
  assert.equal(nearMesh.geometry.attributes.aTree.itemSize, 4);
  assert.equal(nearMesh.count, 1);
  assert.equal(farMesh.geometry.attributes.position.count / 3, 80);
  assert.deepEqual(Array.from(built.statistics.crown.species, item => item.name), ['ficus']);
  assert.equal(built.statistics.crown.species[0].seed, 20261110);
  assert.ok(built.statistics.triangles.cardPerTree.ficus > 500);
  assert.equal(built.statistics.crown.headlessAtlas, true);
  assert.equal(built.statistics.visible.cardTrees, 1);
  assert.equal(built.statistics.visible.triangles, built.statistics.triangles.cardPerTree.ficus);

  built.update(new THREE.Vector3(0, 5, 700));
  assert.equal(nearMesh.visible, false);
  assert.equal(farMesh.visible, true);
  assert.equal(trunkMesh.visible, true);
  trunkMesh.getMatrixAt(0, matrix);
  const trunkTop = new THREE.Vector3(0, 1, 0).applyMatrix4(matrix).y;
  farMesh.getMatrixAt(0, matrix);
  farMesh.geometry.computeBoundingBox();
  const crownBottom = farMesh.geometry.boundingBox.min.clone().applyMatrix4(matrix).y;
  assert.ok(crownBottom < trunkTop);
  assert.equal(built.statistics.visible.triangles, 96);
  assert.equal(built.statistics.visible.farCells, 1);
  assert.equal(built.statistics.visible.hiddenCells, 1);

  built.update(new THREE.Vector3(1500, 5, 0));
  assert.equal(nearMesh.visible, false);
  assert.equal(built.group.getObjectByName('tree-crowns-near:1,0/6,0:ficus').visible, true);
  assert.equal(built.statistics.visible.hiddenCells, 1);
  assert.equal(built.statistics.visible.nearCells, 1);
  assert.equal(trunkMesh.visible, false);

  built.update(new THREE.Vector3(0, 5, 5000));
  assert.equal(built.statistics.visible.chunks, 0);
  assert.equal(nearMesh.visible, false);
  assert.equal(farMesh.visible, false);

  built.dispose();
  assert.equal(scene.children.length, 0);
});

test('Chegongmiao frontage clears only simulated street trunks and their colliders', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  const model = loadModule(read('sz-trees.js'), {
    imports: { 'three/webgpu': THREE, './sz-polygon.js': polygonModule, './sz-tree-crown.js': crown }
  });
  const roadFrontage = {
    corridors: [{ id: 'shennan-chegongmiao', bounds: [-3754, 686, -3137, 930],
      crossingAxes: [{ osmId: 'way/1416551427', widthM: 3, points: [[-3634.731, 791.863], [-3633.198, 804.111]] }] }],
    features: [{ id: 'shennan-chegongmiao:sidewalk', kind: 'sidewalk',
      trianglesXZ: [-3500, 810, -3480, 810, -3500, 825] }],
    entrances: [{ osmNodeId: 1491790883, x: -3362.815, z: 851.174 }]
  };
  const payload = makePayload([
    { x: -34995, z: 8098 }, // 树心在边外，树干与铺装相交。
    { x: -34995, z: 8096, species: 'royal-palm' }, // 高冠伸至人行道上方，保留。
    { x: -36340, z: 7980 },
    { x: -33628, z: 8512 },
    { x: -34991, z: 8104, source: 'osm-node', osm: 'node/1' },
    { x: -34990, z: 8105, source: 'osm-row', osm: 'way/1' },
    { x: -34989, z: 8106, source: 'simulated-park' },
    { x: 0, z: 0 },
    { x: -34995, z: 8090, species: 'ficus', height: 50 } // 树干在外，低冠伸入通行带。
  ]);
  const scene = new THREE.Scene();
  const built = model.buildSzTrees(scene, payload, { groundHeight: () => 5, roadFrontage });
  assert.equal(built.statistics.skipped.frontageTrunkConflict, 3);
  assert.equal(built.statistics.skipped.frontageCrownConflict, 1);
  assert.deepEqual(Array.from(built.colliders, row => row.sourceId), ['tree/1', 'node/1', 'way/1', 'tree/6', 'tree/7']);
  for (const name of ['trunks', 'farCrowns', 'cards']) assert.equal(built.statistics.instances[name], built.colliders.length);
  built.dispose();
});

test('missing or empty tree payload leaves scene untouched apart from an empty group', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  const model = loadModule(read('sz-trees.js'), {
    imports: { 'three/webgpu': THREE, './sz-polygon.js': polygonModule,
      './sz-tree-crown.js': { CROWN_SPECIES: crown.CROWN_SPECIES, createCrownLibrary: crown.createCrownLibrary } }
  });
  const scene = new THREE.Scene();
  const built = model.buildSzTrees(scene, undefined, {});
  assert.equal(built.group.children.length, 0);
  assert.equal(built.statistics.placed, 0);
  built.dispose();
  assert.equal(scene.children.length, 0);
  const withCount = model.buildSzTrees(scene, makePayload([{ x: 0, z: 0 }]), {});
  assert.equal(withCount.statistics.skipped.unsupportedGround, 1);
  withCount.dispose();
});

test('every species gets its own card-crown mesh in the near LOD', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  const model = loadModule(read('sz-trees.js'), {
    imports: { 'three/webgpu': THREE, './sz-polygon.js': polygonModule,
      './sz-tree-crown.js': { CROWN_SPECIES: crown.CROWN_SPECIES, createCrownLibrary: crown.createCrownLibrary } }
  });
  const scene = new THREE.Scene();
  const built = model.buildSzTrees(scene, makePayload([
    { x: 0, z: 0, height: 120, crown: 100, species: 'camphor', osm: 'node/2', source: 'osm-node' },
    { x: 30, z: 0, height: 130, crown: 40, species: 'royal-palm', osm: 'node/3', source: 'osm-node' },
    { x: 60, z: 0, height: 110, crown: 90, species: 'phoenix', osm: 'node/4', source: 'osm-node' }
  ]), { groundHeight: () => 0 });
  const names = ['camphor', 'royal-palm', 'phoenix'];
  for (const name of names) {
    assert.ok(built.group.getObjectByName(`tree-crowns-near:0,0/0,0:${name}`), name);
  }
  assert.equal(built.statistics.visible.cardTrees, 3);
  const expected = names.reduce((sum, name) => sum + built.statistics.triangles.cardPerTree[name], 0);
  assert.equal(built.statistics.visible.triangles, expected);
  assert.ok(built.statistics.triangles.cardPerTree['royal-palm'] < 100, 'whole palms use fewer than 100 triangles');
  built.dispose();
});

test('near LOD hysteresis keeps crowns steady across the 180–198 m band', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  const model = loadModule(read('sz-trees.js'), {
    imports: { 'three/webgpu': THREE, './sz-polygon.js': polygonModule,
      './sz-tree-crown.js': { CROWN_SPECIES: crown.CROWN_SPECIES, createCrownLibrary: crown.createCrownLibrary } }
  });
  const scene = new THREE.Scene();
  const built = model.buildSzTrees(scene, makePayload([
    { x: 0, z: 0, height: 120, crown: 100, osm: 'node/3', source: 'osm-node' }
  ]), { groundHeight: () => 0 });
  const cards = built.group.getObjectByName('tree-crowns-near:0,0/0,0:ficus');
  const far = built.group.getObjectByName('tree-crowns-far:0,0/0,0');
  // 初始在原点时是近冠；越过 198 m 才切远冠。
  assert.equal(cards.visible, true);
  built.update(new THREE.Vector3(0, 2, 199));
  assert.equal(cards.visible, false);
  assert.equal(far.visible, true);
  built.update(new THREE.Vector3(0, 2, 185));
  assert.equal(cards.visible, false);
  assert.equal(far.visible, true);
  built.update(new THREE.Vector3(0, 2, 179));
  assert.equal(cards.visible, true);
  assert.equal(far.visible, false);
  // 179 → 190 仍在 180–198 的迟滞带内：保持近冠，不会来回闪。
  built.update(new THREE.Vector3(0, 2, 190));
  assert.equal(cards.visible, true);
  assert.equal(far.visible, false);
  built.update(new THREE.Vector3(0, 2, 197.9));
  assert.equal(cards.visible, true);
  built.update(new THREE.Vector3(0, 2, 198.1));
  assert.equal(cards.visible, false);
  assert.equal(far.visible, true);
  built.dispose();
});
