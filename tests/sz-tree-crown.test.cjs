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

test('every crown species is deterministic, normalised and within the triangle budget', { skip: !threeDir }, async () => {
  const { crown } = await loadCrown();
  assert.deepEqual(Object.keys(crown.CROWN_SPECIES).sort(), [...SPECIES].sort());
  for (const name of SPECIES) {
    const built = crown.buildCrownGeometry(name);
    const again = crown.buildCrownGeometry(name);
    assert.equal(built.geometry.attributes.position.count, again.geometry.attributes.position.count, name);
    assert.deepEqual(Array.from(built.geometry.attributes.position.array),
      Array.from(again.geometry.attributes.position.array), `${name} must grow the same tree twice`);
    assert.deepEqual(Array.from(built.geometry.index.array), Array.from(again.geometry.index.array), name);

    // 归一化：冠底 y=0、冠顶 y≈1、水平半宽 0.5；下垂叶卡允许略低于 0。
    const b = bounds(built.geometry);
    assert.ok(Math.abs(b.maxY - 1) < 1e-4, `${name} crown top ${b.maxY}`);
    assert.ok(b.minX >= -0.53 && b.maxX <= 0.53, `${name} x range`);
    assert.ok(b.minZ >= -0.53 && b.maxZ <= 0.53, `${name} z range`);
    assert.ok(b.minY > -0.5 && b.minY <= 0.02, `${name} crown bottom ${b.minY}`);

    // 原近冠 5 个 icosahedron(detail=2) = 5 × 180 = 900 三角形；叶卡样板允许比它高，
    // 但单棵必须远低于每帧 600 万的城市预算，才不压缩叶卡数。
    assert.ok(built.triangles > 20 && built.triangles < 1700, `${name} triangles ${built.triangles}`);
    if (name === 'royal-palm') {
      assert.ok(built.cards >= 12 && built.cards <= 24, `palm fronds ${built.cards}`);
      assert.equal(built.barkTriangles, 0, 'palm uses the trunk cylinder, no bark tubes in the crown');
    } else {
      assert.ok(built.cards >= 150, `${name} cards ${built.cards}`);
      assert.ok(built.barkTriangles > 0, `${name} has branch bark`);
    }

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
    if (name === 'royal-palm') assert.equal(barkVertices, 0);
    else assert.ok(barkVertices > 0, `${name} bark tubes`);
    assert.equal(built.geometry.userData.species, name);
    assert.equal(built.geometry.userData.kind, name === 'royal-palm' ? 'palm' : 'broadleaf');
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
