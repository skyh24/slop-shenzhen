const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const read = file => readFileSync(join(root, 'js', file), 'utf8');
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
const SPECIES = ['ficus', 'camphor', 'phoenix', 'bauhinia', 'kapok', 'royal-palm'];

// 近景叶卡树冠：几何、图集、材质。需要真实 three 0.187.0；未设置 SZ_THREE_PACKAGE_DIR 时跳过。
async function loadCrown() {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
  const crown = loadModule(read('sz-tree-crown.js'), { imports: { 'three/webgpu': THREE, 'three/tsl': TSL } });
  return { THREE, crown };
}

function bounds(geometry) {
  const pos = geometry.attributes.position;
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    minX = Math.min(minX, pos.getX(i));
    maxX = Math.max(maxX, pos.getX(i));
    minY = Math.min(minY, pos.getY(i));
    maxY = Math.max(maxY, pos.getY(i));
    minZ = Math.min(minZ, pos.getZ(i));
    maxZ = Math.max(maxZ, pos.getZ(i));
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

test('shrubs and distant trees use open leaf cards within the distant crown budget', { skip: !threeDir }, async () => {
  const { crown } = await loadCrown();
  const foliage = crown.createCompactFoliage();
  const library = crown.createCrownLibrary(['ficus']);
  try {
    for (const name of ['shrub', 'crown']) {
      const geometry = foliage.geometryFor(name);
      assert.ok(geometry.attributes.uv.count > 100);
      assert.ok(geometry.index.count / 3 <= crown.COMPACT_CROWN_TRIANGLES);
      assert.ok(geometry.attributes.aTree.array.every((value, i) => i % 4 !== 0 || value === 1));
    }
    assert.equal(foliage.material.alphaTest, library.material.alphaTest);
    assert.ok(bounds(foliage.geometryFor('shrub')).minY >= -0.05);
  } finally {
    foliage.dispose();
    library.dispose();
  }
});

test('every whole tree is deterministic, rooted and within the triangle budget', { skip: !threeDir }, async () => {
  const { crown } = await loadCrown();
  assert.deepEqual(Object.keys(crown.CROWN_SPECIES).sort(), [...SPECIES].sort());
  for (const name of SPECIES) {
    const built = crown.buildCrownGeometry(name);
    const again = crown.buildCrownGeometry(name);
    assert.equal(built.geometry.attributes.position.count, again.geometry.attributes.position.count, name);
    assert.deepEqual(Array.from(built.geometry.attributes.position.array),
      Array.from(again.geometry.attributes.position.array), `${name} must grow the same tree twice`);
    assert.deepEqual(Array.from(built.geometry.index.array), Array.from(again.geometry.index.array), name);

    // 整棵树以树脚为原点，树顶 y=1。
    const b = bounds(built.geometry);
    assert.ok(Math.abs(b.maxY - 1) < 1e-4, `${name} crown top ${b.maxY}`);
    const width = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    assert.ok(Math.abs(width - 1) < 1e-4, `${name} crown width ${width}`);
    assert.equal(b.minY, 0, name);

    // 原近冠 5 个 icosahedron(detail=2) = 5 × 180 = 900 三角形；叶卡样板允许比它高，
    // 但单棵必须远低于每帧 600 万的城市预算，才不压缩叶卡数。
    assert.ok(built.triangles > 20 && built.triangles < 1700, `${name} triangles ${built.triangles}`);
    assert.ok(built.barkTriangles > 0, `${name} has a trunk`);
    assert.ok(name === 'royal-palm' ? built.cards >= 12 && built.cards <= 24 : built.cards >= 150, name);

    // 属性：叶卡和树皮共用一份几何，靠 aTree.x 区分。
    assert.equal(built.geometry.attributes.aTree.itemSize, 4);
    assert.equal(built.geometry.attributes.uv.itemSize, 2);
    assert.equal(built.geometry.attributes.normal.itemSize, 3);
    let leafVertices = 0;
    let barkVertices = 0;
    const tree = built.geometry.attributes.aTree;
    for (let i = 0; i < tree.count; i++) {
      if (tree.getX(i) > 0.5) leafVertices += 1;
      else barkVertices += 1;
    }
    assert.ok(leafVertices > 0, `${name} leaf cards`);
    assert.ok(barkVertices > 0, `${name} bark tubes`);
    assert.equal(built.geometry.userData.species, name);
    assert.equal(built.geometry.userData.kind, name === 'royal-palm' ? 'palm' : 'broadleaf');
  }
});

test('the tree stem reaches the leader or frond anchors without a separate transform', { skip: !threeDir }, async () => {
  const { crown } = await loadCrown();
  for (const name of SPECIES) {
    const { geometry } = crown.buildCrownGeometry(name);
    const { position, aTree } = geometry.attributes;
    const { trunkRatio, trunkRadiusRatio } = crown.CROWN_SPECIES[name];
    const root = [];
    const edges = Array.from({ length: position.count }, () => []);
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) !== 0) continue;
      assert.equal(aTree.getX(i), 0);
      assert.ok(Math.abs(Math.hypot(position.getX(i), position.getZ(i)) - trunkRadiusRatio) < 1e-6);
      root.push(i);
    }
    assert.equal(root.length, 9, name);
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i += 3) {
      const [a, b, c] = index.subarray(i, i + 3);
      if ([a, b, c].some(vertex => aTree.getX(vertex) > 0)) continue;
      edges[a].push(b, c);
      edges[b].push(a, c);
      edges[c].push(a, b);
    }
    const connected = new Set(root);
    for (const vertex of connected) for (const next of edges[vertex]) connected.add(next);
    assert.ok([...connected].some(vertex => position.getY(vertex) > trunkRatio + 0.005), name);
    if (name === 'royal-palm') {
      for (let i = 0; i < 16 * 4; i += 4) {
        assert.ok(Math.abs(position.getX(i) + position.getX(i + 1)) < 1e-6);
        assert.ok(Math.abs(position.getZ(i) + position.getZ(i + 1)) < 1e-6);
        assert.ok(Math.abs((position.getY(i) + position.getY(i + 1)) / 2 - trunkRatio) < 1e-6);
      }
    } else {
      assert.ok(connected.has(0), `${name} lower stem shares the leader ring`);
      assert.ok(Math.abs(position.getX(0) + position.getX(4)) < 1e-6);
      assert.ok(Math.abs(position.getZ(0) + position.getZ(4)) < 1e-6);
    }
  }
});

test('crown atlas and shared material expose leaf coverage, wind and translucency', { skip: !threeDir }, async () => {
  const { THREE, crown } = await loadCrown();
  // node --test 没有 document，图集走程序化占位图；UV 和材质结构不变。
  const library = crown.createCrownLibrary();
  assert.equal(library.statistics.headlessAtlas, true);
  assert.equal(library.atlas.texture.image.width, 64);
  assert.deepEqual(Array.from(library.statistics.species, item => item.name), SPECIES);
  for (const name of SPECIES) {
    assert.ok(library.geometryFor(name), name);
    assert.ok(library.statistics.triangles[name] > 0, name);
    assert.ok(library.statistics.triangles[name] < 1700, name);
  }
  assert.throws(() => library.geometryFor('no-such-tree'), /not built/);

  const material = library.material;
  assert.equal(material.type, 'TreeCrownMaterial');
  assert.equal(material.name, 'shenzhen-tree-crown');
  assert.equal(material.alphaTest, 0.5);
  assert.equal(material.side, THREE.DoubleSide);
  assert.ok(material.positionNode, 'wind position node');
  assert.ok(material.colorNode, 'leaf/bark colour node');
  assert.ok(material.normalNode, 'crown shell normals');
  assert.ok(material.aoNode, 'crown interior occlusion');
  assert.ok(material.translucencyNode, 'light through leaves');
  assert.equal(material.alphaToCoverage, true);
  // 图集四格：榕树 / 阔叶 / 棕榈 / 凤凰木，各格 UV 都在 [0,1] 内。
  for (const tile of [crown.TILE_FICUS, crown.TILE_BROAD, crown.TILE_PALM, crown.TILE_FEATHER]) {
    assert.ok(tile >= 0 && tile < 4);
  }
  library.dispose();
});
