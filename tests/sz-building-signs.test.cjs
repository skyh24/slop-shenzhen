const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const SOURCE = read('sz-building-signs.js');
const threeDir = process.env.SZ_THREE_PACKAGE_DIR;

function loadSigns(THREE = {}, TSL = {}) {
  return loadModule(SOURCE, { imports: {
    'three/webgpu': THREE,
    'three/tsl': TSL,
    './sz-materials.js': { sceneUniforms: { night: TSL.uniform ? TSL.uniform(0) : { value: 0 } } }
  } });
}

const signs = loadSigns();

function boxBuilding({ id = 'way/1', name = '测试大厦', cx = 0, cz = 0, halfX = 10, halfZ = 10,
  height = 40, minHeight = 0, category = 'commercial', facade = 'office', levels = -1 } = {}) {
  return {
    id, name, cx, cz, minX: cx - halfX, maxX: cx + halfX, minZ: cz - halfZ, maxZ: cz + halfZ,
    minHeight, height, category, facade, levels,
    polygons: [{ holes: [], outer: [
      { x: cx - halfX, z: cz - halfZ }, { x: cx + halfX, z: cz - halfZ },
      { x: cx + halfX, z: cz + halfZ }, { x: cx - halfX, z: cz + halfZ }
    ] }]
  };
}

// 一条平行 x 轴、位于 z 处的路；以及一条平行 z 轴、位于 x 处的路。
function roadAtZ(z, { half = 300 } = {}) {
  return { nodes: [-half, z, half, z], links: [[0, 1, 0, 10, 2, 1, []]], names: ['test-road'] };
}

function roadAtX(x, { half = 300 } = {}) {
  return { nodes: [x, -half, x, half], links: [[0, 1, 0, 10, 2, 1, []]], names: ['test-road'] };
}

test('normalizeName strips residential unit numbers but skips information-free names', () => {
  const residential = { category: 'residential', facade: 'residential_tower' };
  const commercial = { category: 'commercial', facade: 'office' };
  assert.equal(signs.normalizeName('东海花园1栋', residential), '东海花园');
  assert.equal(signs.normalizeName('幸福里A座', residential), '幸福里');
  assert.equal(signs.normalizeName('中海怡翠第3栋', residential), '中海怡翠');
  assert.equal(signs.normalizeName('万科城1号楼', residential), '万科城');
  assert.equal(signs.normalizeName('汇文楼H4号楼', residential), '汇文楼');
  assert.equal(signs.normalizeName('海滨广场5栋2单元', residential), '海滨广场');
  assert.equal(signs.normalizeName('东海花园 1 栋', residential), '东海花园');
  // 整名只是单元号或纯数字：没有小区名，不出牌也不进 nearestName。
  for (const name of ['1栋', 'A座', '第3栋', '1号楼', '6栋2单元', '3', '12', '4D', '2A', 'T2-A', '9-2', '29D,30-3']) {
    assert.equal(signs.normalizeName(name, residential), null, name);
    assert.equal(signs.normalizeName(name, commercial), null, name);
  }
  // 写字楼/商业用全名，不因为结尾像单元号就删字。
  assert.equal(signs.normalizeName('深纺大厦C座', commercial), '深纺大厦C座');
  assert.equal(signs.normalizeName('长城科技大厦2号楼', commercial), '长城科技大厦2号楼');
  assert.equal(signs.normalizeName('Tower A', commercial), 'Tower A');
  // 纯英文但有可读词的是品牌/楼名，不当门牌号删掉。
  assert.equal(signs.normalizeName('Decathlon', commercial), 'Decathlon');
  assert.equal(signs.normalizeName('Loft A3', commercial), 'Loft A3');
  assert.equal(signs.normalizeName(null, commercial), null);
  assert.equal(signs.normalizeName('   ', commercial), null);
  const truncated = signs.normalizeName('深圳湾超级总部基地一号办公楼群', commercial);
  assert.equal(Array.from(truncated).length, 14);
  assert.equal(truncated.endsWith('…'), true);
});

test('buildingDisplayName skips landmark models and names missing from data', () => {
  assert.equal(signs.buildingDisplayName({ facade: 'landmark', name: '平安金融中心' }), null);
  assert.equal(signs.buildingDisplayName({ facade: 'office', name: null }), null);
  assert.equal(signs.buildingDisplayName({ facade: 'office', name: '招商银行大厦' }), '招商银行大厦');
  assert.equal(signs.buildingDisplayName(null), null);
});

test('entrance sign faces the nearest road and never exceeds its wall', () => {
  const building = boxBuilding({ name: '测试大厦' });
  const spec = signs.planBuildingSigns(building, { roadGraph: roadAtZ(60) });
  assert.equal(spec.kind, 'entrance');
  assert.ok(spec.normalZ > 0.99, `expected +z normal, got ${spec.normalZ}`);
  assert.ok(Math.abs(spec.z - 10.12) < 1e-9);
  assert.ok(spec.width >= 3 && spec.width <= 8);
  assert.ok(spec.height >= 1.2 && spec.height <= 1.6);
  assert.ok(spec.width <= spec.wallLength + 1e-9);
  assert.ok(spec.y >= 3.5 && spec.y <= 5);
  assert.equal(spec.name, '测试大厦');
});

test('road-facing short wall wins over a longer wall away from the road', () => {
  const building = boxBuilding({ name: '临街商铺', halfX: 20, halfZ: 5, facade: 'residential_low', category: 'commercial' });
  const spec = signs.planBuildingSigns(building, { roadGraph: roadAtX(40) });
  assert.ok(spec.normalX > 0.99, `expected east-facing wall, got normal ${spec.normalX}`);
  assert.equal(spec.wallLength, 10);
  assert.ok(spec.width <= spec.wallLength + 1e-9);
  assert.ok(Math.abs(spec.x - 20.12) < 1e-9);
});

test('without roads the longest wall is used, and planning is deterministic', () => {
  const building = boxBuilding({ name: '无路小区', halfX: 30, halfZ: 6 });
  const first = signs.planBuildingSigns(building, { roadGraph: null });
  const second = signs.planBuildingSigns(building, { roadGraph: null });
  assert.deepEqual(first, second);
  assert.equal(first.wallLength, 60);
  assert.ok(first.width <= first.wallLength);
  // 完全没有道路数据时仍可用最长墙出牌，不抛错。
  assert.ok(signs.planBuildingSigns(building, {}));
});

test('tall buildings get a double-sided roof sign sized from the name', () => {
  const building = boxBuilding({ name: '深圳湾一号', height: 120, facade: 'glass_tower', levels: 30 });
  const spec = signs.planBuildingSigns(building, { roadGraph: roadAtZ(80) });
  assert.equal(spec.kind, 'roof');
  assert.ok(spec.width >= 10 && spec.width <= 44);
  assert.ok(spec.height >= 3 && spec.height <= 9);
  assert.ok(spec.width <= spec.wallLength + 1e-9);
  assert.ok(spec.y > 120, 'roof sign stands above the roof');
  assert.ok(Math.abs(spec.y - (120 + 0.35 + spec.height / 2)) < 1e-9);
  // 立在屋面边缘内侧
  assert.ok(Math.abs(spec.z - 9.2) < 1e-9);
});

test('levels refine the entrance sign height when available', () => {
  const withLevels = signs.planBuildingSigns(boxBuilding({ name: '有人口层数', height: 30, levels: 10, facade: 'office' }),
    { roadGraph: roadAtZ(60) });
  const withoutLevels = signs.planBuildingSigns(boxBuilding({ name: '无人层数', height: 30, levels: -1, facade: 'office' }),
    { roadGraph: roadAtZ(60) });
  assert.ok(withLevels.y < withoutLevels.y);
  assert.ok(withLevels.y >= 2.6 && withLevels.y <= 3.8);
});

test('missing names, unit-only names and landmarks never produce signs', () => {
  const missing = signs.planBuildingSigns(boxBuilding({ name: null }), { roadGraph: roadAtZ(60) });
  const unitOnly = signs.planBuildingSigns(boxBuilding({ name: 'B栋' }), { roadGraph: roadAtZ(60) });
  const landmark = signs.planBuildingSigns(boxBuilding({ name: '地标大楼', facade: 'landmark' }),
    { roadGraph: roadAtZ(60) });
  assert.equal(missing, null);
  assert.equal(unitOnly, null);
  assert.equal(landmark, null);
});

function fakeTextureFactory(created, disposed) {
  return (layout, specs) => {
    const record = { layout, specs };
    created.push(record);
    return {
      isTexture: true, colorSpace: null, anisotropy: 0, needsUpdate: false,
      dispose() { disposed.push(record); }
    };
  };
}

function flattenSigns(api) {
  const out = [];
  api.group.traverse(object => {
    if (object.isMesh && Array.isArray(object.userData.signs)) out.push(...object.userData.signs);
  });
  return out;
}

test('planSignAtlas packs one chunk into a deterministic atlas at the original pixel density', () => {
  const specs = [
    { kind: 'roof', name: '高塔', aspect: 5, width: 20, height: 4, rotationY: 0, x: 0, y: 100, z: 0 },
    { kind: 'entrance', name: '测试大厦', aspect: 4, width: 4, height: 1, rotationY: -1.57, x: 10, y: 4, z: 0 },
    { kind: 'compound', name: '测试花园', aspect: 3.5, width: 6, height: 1.7, rotationY: 0, x: 0, y: 3, z: 10 }
  ];
  const layout = signs.planSignAtlas(specs);
  assert.deepEqual(layout, signs.planSignAtlas(specs), 'same input gives the same layout');
  assert.equal(layout.scale, 1);
  assert.equal(layout.tiles.length, specs.length);
  assert.ok(layout.width <= signs.SIGN_ATLAS_MAX_WIDTH);
  assert.ok(layout.height <= signs.SIGN_ATLAS_MAX_HEIGHT);
  const roof = layout.tiles.find(tile => tile.spec.kind === 'roof');
  const entrance = layout.tiles.find(tile => tile.spec.kind === 'entrance');
  assert.equal(roof.width, 1024, 'roof tiles keep the 1024 px canvas width used before batching');
  assert.equal(entrance.width, 640, 'entrance tiles keep the 640 px canvas width used before batching');
  assert.equal(roof.height, Math.max(48, Math.round(1024 / 5)));
  // 牌之间不能重叠：任意两块矩形不相交。
  for (let i = 0; i < layout.tiles.length; i++) {
    for (let j = i + 1; j < layout.tiles.length; j++) {
      const a = layout.tiles[i];
      const b = layout.tiles[j];
      const overlap = a.x < b.x + b.slotWidth && b.x < a.x + a.slotWidth
        && a.y < b.y + b.slotHeight && b.y < a.y + a.slotHeight;
      assert.equal(overlap, false, `tiles ${i} and ${j} overlap`);
    }
  }
});

test('planSignAtlas halves tile resolution instead of opening an oversized texture', () => {
  const specs = Array.from({ length: 12 }, (_, index) => ({
    kind: 'roof', name: `高楼${index}`, aspect: 8, width: 22, height: 2.75,
    rotationY: 0, x: index * 10, y: 80, z: 0
  }));
  const layout = signs.planSignAtlas(specs, { maxHeight: 900 });
  assert.ok(layout.scale < 1, 'layout falls back to a smaller tile scale');
  assert.ok(layout.height <= 900, `height=${layout.height}`);
  assert.equal(layout.tiles.length, specs.length);
});

test('sign night constants keep roof signs brighter than printed entrance signs', () => {
  assert.ok(signs.SIGN_NIGHT.roofGain > signs.SIGN_NIGHT.printedGain);
  assert.ok(signs.SIGN_NIGHT.roofTint.every(value => value > 0.9 && value <= 1));
  assert.ok(signs.SIGN_NIGHT.roofTint[1] < 1 && signs.SIGN_NIGHT.roofTint[2] < 1);
});

test('signs stream by chunk, batch one atlas mesh per chunk, and release them on unload',
  { skip: !threeDir }, async () => {
    const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
    const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
    const runtime = loadSigns(THREE, TSL);
    const created = [];
    const disposed = [];
    const buildings = [
      boxBuilding({ id: 'b1', name: '测试花园1栋', category: 'residential', facade: 'residential_tower', height: 30, cx: -20, cz: -20 }),
      boxBuilding({ id: 'b2', name: '测试花园2栋', category: 'residential', facade: 'residential_tower', height: 30, cx: 20, cz: -20 }),
      boxBuilding({ id: 'b3', name: '测试大厦', height: 40, cx: -20, cz: 20 }),
      boxBuilding({ id: 'b4', name: 'A座', category: 'residential', height: 60, cx: 20, cz: 20 }),
      boxBuilding({ id: 'b5', name: null, height: 80, cx: 60, cz: 60 }),
      boxBuilding({ id: 'b6', name: '高塔', height: 120, facade: 'glass_tower', levels: 30, cx: -60, cz: 60 }),
      boxBuilding({ id: 'b7', name: '地标楼', facade: 'landmark', height: 200, cx: 60, cz: -60 }),
      boxBuilding({ id: 'b8', name: '3单元', category: 'residential', height: 40, cx: 1000, cz: 1000 })
    ];
    const scene = new THREE.Scene();
    const api = runtime.buildBuildingSigns(scene, {
      buildings, roadGraph: roadAtZ(60), createAtlasTexture: fakeTextureFactory(created, disposed),
      maxChunkOps: 16, maxAtlasRebuilds: 16
    });
    assert.equal(api.statistics.signs, 0);
    assert.equal(created.length, 0, 'textures are created lazily by update, not for the whole city');

    for (let i = 0; i < 8; i++) api.update({ x: 0, y: 0, z: 0 });
    const signCount = api.statistics.signs;
    assert.ok(signCount >= 4, `expected several signs, got ${signCount}`);
    assert.ok(api.statistics.chunks >= 1);
    assert.ok(api.statistics.meshes >= 1);
    assert.ok(api.statistics.textures >= 1);
    assert.equal(api.statistics.textures, api.statistics.meshes);
    assert.ok(api.statistics.meshes <= api.statistics.chunks, 'one atlas mesh per chunk at most');
    assert.ok(api.statistics.meshes < signCount, 'several signs share one atlas mesh');
    assert.equal(created.length, api.statistics.meshes, 'one canvas atlas per chunk mesh');
    assert.ok(created.every(record => record.layout.tiles.length >= 1));
    assert.ok(created.every(record => record.layout.tiles.length === record.specs.length));
    assert.ok(api.statistics.updateMs >= 0 && Number.isFinite(api.statistics.updateMs));

    const packed = flattenSigns(api);
    assert.equal(packed.length, signCount);
    const signIds = packed.map(sign => sign.buildingId).filter(Boolean);
    assert.ok(signIds.includes('b1') && signIds.includes('b2') && signIds.includes('b3'));
    assert.ok(!signIds.includes('b4'), 'unit-only names do not get signs');
    assert.ok(!signIds.includes('b5'), 'buildings without names do not get signs');
    assert.ok(!signIds.includes('b7'), 'landmark facades do not get signs');

    // 每个图集网格带 position/uv/signGlow，屋顶牌写 1、入口牌写 0；双面牌每条牌 8 个顶点。
    let meshCount = 0;
    api.group.traverse(object => {
      if (!object.isMesh) return;
      meshCount++;
      assert.ok(object.material.isMeshBasicNodeMaterial, 'atlas material is a node material');
      assert.ok(object.material.colorNode, 'atlas material carries the night color node');
      assert.ok(object.geometry.getAttribute('position'));
      assert.ok(object.geometry.getAttribute('uv'));
      const glow = object.geometry.getAttribute('signGlow');
      assert.ok(glow, 'atlas geometry carries the per-sign night glow attribute');
      assert.equal(glow.count, object.geometry.getAttribute('position').count);
      const kinds = object.userData.signs.map(sign => sign.kind);
      const hasRoof = kinds.includes('roof');
      const glowValues = Array.from(glow.array);
      if (hasRoof) assert.ok(glowValues.includes(1), 'roof signs glow at night');
      const hasPrinted = kinds.includes('entrance') || kinds.includes('compound');
      if (hasPrinted) assert.ok(glowValues.includes(0), 'printed signs do not glow like roof signs');
    });
    assert.equal(meshCount, api.statistics.meshes);

    assert.ok(api.nearestName(0, 0), 'nearestName finds a nearby named building');
    assert.equal(api.nearestName(5000, 5000), null);
    assert.equal(api.nearestName(1000, 1000), null, 'unit-only names are not offered to the HUD');

    // 传送到城市另一头：1.3 倍半径外卸载，图集贴图和几何随之释放。
    for (let i = 0; i < 20; i++) api.update({ x: 5000, y: 0, z: 5000 });
    assert.equal(api.statistics.signs, 0);
    assert.equal(api.statistics.chunks, 0);
    assert.equal(api.statistics.meshes, 0);
    assert.equal(api.statistics.textures, 0);
    assert.equal(disposed.length, created.length);
    assert.equal(api.group.children.length, 0);

    api.dispose();
    assert.equal(scene.children.includes(api.group), false);
  });

test('chunk streaming output is deterministic for the same data and position',
  { skip: !threeDir }, async () => {
    const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
    const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
    const runtime = loadSigns(THREE, TSL);
    const build = () => {
      const api = runtime.buildBuildingSigns(new THREE.Scene(), {
        buildings: [
          boxBuilding({ id: 'd1', name: '东海岸花园1栋', category: 'residential', facade: 'residential_tower', height: 45 }),
          boxBuilding({ id: 'd2', name: '东海岸大厦', height: 90, facade: 'glass_tower', levels: 22, cx: 30, cz: 30 })
        ],
        roadGraph: roadAtZ(60), createAtlasTexture: fakeTextureFactory([], []),
        maxChunkOps: 16, maxAtlasRebuilds: 16
      });
      for (let i = 0; i < 4; i++) api.update({ x: 0, y: 0, z: 0 });
      const meshes = [];
      api.group.traverse(object => {
        if (!object.isMesh) return;
        meshes.push({
          name: object.name,
          position: object.geometry.getAttribute('position').array,
          uv: object.geometry.getAttribute('uv').array,
          glow: object.geometry.getAttribute('signGlow').array,
          signs: object.userData.signs
        });
      });
      return { meshes, statistics: { ...api.statistics, updateMs: 0 } };
    };
    assert.deepEqual(build(), build());
  });

test('atlas material is a node material driven by the shared night uniform and roof/printed gains',
  { skip: !threeDir }, async () => {
    const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
    const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
    const runtime = loadSigns(THREE, TSL);
    const texture = { isTexture: true, colorSpace: null, anisotropy: 0, needsUpdate: false, dispose() {} };
    const material = runtime.createSignAtlasMaterial(texture);
    assert.equal(material.isMeshBasicNodeMaterial, true);
    assert.equal(material.map, texture);
    assert.ok(material.colorNode, 'night gain is expressed as a shader node, not per-frame JS material updates');
    // 纯函数常量：屋顶比入口亮得多，且屋顶夜间略偏暖。
    assert.ok(signs.SIGN_NIGHT.roofGain > signs.SIGN_NIGHT.printedGain);
    assert.ok(signs.SIGN_NIGHT.roofGain < 1 && signs.SIGN_NIGHT.printedGain > 0);
  });

test('baseY from cityBlocks keeps signs at terrain height', () => {
  const entrance = signs.planBuildingSigns({ ...boxBuilding({ name: '山坡小区', height: 40 }), baseY: 12 },
    { roadGraph: roadAtZ(60) });
  assert.ok(entrance.y > 12 && entrance.y < 18, `entrance sign should sit above terrain, got ${entrance.y}`);
  const roof = signs.planBuildingSigns({ ...boxBuilding({ name: '山坡高楼', height: 100, facade: 'glass_tower' }), baseY: 12 },
    { roadGraph: roadAtZ(80) });
  assert.ok(roof.y > 112, `roof sign should stand on the raised roof, got ${roof.y}`);
});

test('compound gate sign needs at least two unit-only siblings and stays on the road-facing wall', () => {
  const anchor = boxBuilding({ id: 'a1', name: '测试花园1栋', category: 'residential', facade: 'residential_tower', height: 40, cx: 0, cz: 0 });
  const memberB = boxBuilding({ id: 'a2', name: '2栋', category: 'residential', facade: 'residential_tower', height: 40, cx: 24, cz: 0 });
  const memberC = boxBuilding({ id: 'a3', name: '3栋', category: 'residential', facade: 'residential_tower', height: 40, cx: 48, cz: 0 });
  const oneMember = signs.planCompoundSign({ name: '测试花园', members: [memberB] }, { roadGraph: roadAtZ(60) });
  assert.equal(oneMember, null, 'a single unit-only building is not a compound');
  const spec = signs.planCompoundSign({ name: '测试花园', members: [memberB, memberC] }, { roadGraph: roadAtZ(60) });
  assert.equal(spec.kind, 'compound');
  assert.equal(spec.variant, 'residential');
  assert.equal(spec.members, 2);
  assert.ok(spec.width >= 6 && spec.width <= spec.wallLength + 1e-9);
  assert.ok(spec.height >= 1.8 && spec.height <= 3.2);
  assert.ok(spec.y > spec.height / 2, 'gate sign stands above its base');
  assert.ok(Number.isFinite(spec.rotationY) && spec.targetId === 'a2', 'nearest member to the road carries the sign');
  assert.equal(signs.planCompoundSign(null, {}), null);
});

test('unit-only residential buildings join a compound name for HUD and a single gate sign',
  { skip: !threeDir }, async () => {
    const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
    const TSL = await import(pathToFileURL(join(threeDir, 'build/three.tsl.js')));
    const runtime = loadSigns(THREE, TSL);
    const created = [];
    const buildings = [
      boxBuilding({ id: 'c1', name: '海边花园1栋', category: 'residential', facade: 'residential_tower', height: 45, cx: -20, cz: 0 }),
      boxBuilding({ id: 'c2', name: '2栋', category: 'residential', facade: 'residential_tower', height: 45, cx: 0, cz: 0 }),
      boxBuilding({ id: 'c3', name: '3栋', category: 'residential', facade: 'residential_tower', height: 45, cx: 22, cz: 0 }),
      boxBuilding({ id: 'c4', name: '4栋', category: 'residential', facade: 'residential_low', height: 24, cx: 44, cz: 0 })
    ];
    const api = runtime.buildBuildingSigns(new THREE.Scene(), {
      buildings, roadGraph: roadAtZ(80), createAtlasTexture: fakeTextureFactory(created, []),
      maxChunkOps: 16, maxAtlasRebuilds: 16
    });
    assert.equal(api.statistics.compoundClusters, 1);
    for (let i = 0; i < 8; i++) api.update({ x: 10, y: 0, z: 0 });
    assert.ok(api.statistics.compounds >= 1, `expected a compound sign, got ${api.statistics.compounds}`);
    const packed = flattenSigns(api);
    const compounds = packed.filter(sign => sign.kind === 'compound');
    assert.equal(compounds.length, 1, 'one gate sign per compound');
    assert.equal(compounds[0].name, '海边花园');
    assert.ok(created.some(record => record.specs.some(spec => spec.kind === 'compound' && spec.name === '海边花园')));
    // 小区内单元楼在 HUD 里也显示小区名
    assert.equal(api.nearestName(22, 0), '海边花园');
    assert.equal(api.nearestName(-20, 0), '海边花园');
    api.dispose();
  });
