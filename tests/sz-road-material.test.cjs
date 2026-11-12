const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;

// 材质接线用源码断言覆盖不需要 WebGPU 的部分；节点本身用真实 three 验证构造结果。
test('road surfaces and markings use the shared material module', () => {
  assert.match(read('sz-roads.js'), /createSzRoadSurfaceMaterial/, 'ground roads use the shared asphalt material');
  assert.match(read('sz-road-paint.js'), /createSzRoadPaintMaterial/, 'markings use the shared paint material');
  assert.match(readFileSync(join(__dirname, '../index.html'), 'utf8'),
    /modulepreload" href="\.\/js\/sz-road-material\.js"/, 'the new module is preloaded by the entry page');
});

test('road materials keep dry asphalt, clean dash paint and their depth offsets', { skip: !threeDir }, async () => {
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const material = loadModule(read('sz-road-material.js'), { imports });
  const { createSzRoadSurfaceMaterial, createSzRoadPaintMaterial } = material;

  const surface = createSzRoadSurfaceMaterial();
  assert.ok(surface instanceof THREE.MeshStandardNodeMaterial);
  assert.equal(surface.polygonOffset, true);
  assert.equal(surface.polygonOffsetFactor, -1);
  assert.equal(surface.polygonOffsetUnits, -1);
  assert.equal(surface.color.getHex(), 0x3b3d41);
  assert.equal(surface.roughness, 0.95);
  assert.equal(surface.metalness, 0);
  for (const node of ['colorNode', 'roughnessNode', 'metalnessNode', 'normalNode', 'emissiveNode']) {
    assert.equal(surface[node], null, `no procedural asphalt layer: ${node}`);
  }
  assert.equal(createSzRoadSurfaceMaterial(), surface, 'one shared asphalt material for every road chunk');

  const paint = createSzRoadPaintMaterial();
  assert.ok(paint instanceof THREE.MeshStandardNodeMaterial);
  assert.equal(paint.transparent, true);
  assert.equal(paint.depthWrite, false);
  assert.equal(paint.vertexColors, true);
  assert.equal(paint.polygonOffset, true);
  assert.equal(paint.polygonOffsetFactor, -2);
  assert.equal(paint.polygonOffsetUnits, -2);
  for (const node of ['opacityNode', 'mrtNode']) {
    assert.ok(paint[node], `markings expose ${node}`);
  }
  assert.equal(paint.colorNode, null);
  assert.equal(paint.roughnessNode, null);
  assert.equal(paint.positionNode, null, 'markings keep their build-time geometry instead of screen-space widening');
  // 标线是透明叠加层：MRT 必须写零，保持下方沥青的表面通道。
  for (const name of ['normal', 'metalRough']) {
    const output = paint.mrtNode.outputNodes[name];
    assert.ok(output, `markings write the ${name} MRT output`);
    assert.ok(output.isConstNode, `${name} MRT output is a constant`);
    assert.deepEqual([output.value.x, output.value.y, output.value.z, output.value.w], [0, 0, 0, 0],
      `${name} MRT output stays zero`);
  }
  assert.equal(createSzRoadPaintMaterial(), paint, 'one shared markings material for every paint chunk');
  assert.notEqual(surface, paint);
});

test('buildSzRoads draws its chunks with the shared material and the marking depth offset stays tighter', { skip: !threeDir }, async () => {
  const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
  const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
  const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
  const material = loadModule(read('sz-road-material.js'), { imports });
  const roads = loadModule(read('sz-roads.js'), { imports: { ...imports, './sz-road-material.js': material } });

  const grid = { x0: 0, z0: 0, step: 20, nx: 2, nz: 2 };
  const terrain = { version: 1, grid, chunks: [{ id: 'a', origin: [0, 0], indices: [0, 2, 1, 1, 2, 3],
    positions: [0, 5, 0, 20, 5, 0, 0, 5, 20, 20, 5, 20], cellRanges: [0, 0, 6] }] };
  const graph = { nodes: [2, 8, 10, 8], names: ['Source Road'], links: [[0, 1, 0, 8, 2, 0, []]],
    metadata: [{ osmId: 'way/1', heightSource: 'terrain', widthSource: 'osm-width', layer: 0 }] };
  const scene = new THREE.Scene();
  const built = roads.buildSzRoads(scene, graph, terrain);
  assert.equal(built.meshes.length, 1);
  assert.equal(built.meshes[0].material, material.createSzRoadSurfaceMaterial());
  assert.equal(built.meshes[0].receiveShadow, true);
  assert.equal(built.roadHeight(6, 8), 5);
  // 人行道/自行车道通过 options.material 注入自己的材质（js/sz-streetscape.js 依赖）。
  const custom = new THREE.MeshStandardNodeMaterial({ color: 0x123456 });
  const customBuilt = roads.buildSzRoads(new THREE.Scene(), graph, terrain, { material: custom });
  assert.equal(customBuilt.meshes[0].material, custom);
  customBuilt.dispose();
  built.dispose();
  assert.equal(built.group.parent, null);
  assert.equal(material.createSzRoadSurfaceMaterial(), built.meshes[0].material,
    'the shared material outlives one group disposal');
});
