const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');
const roadsModule = require('./helpers/roads.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const { buildingPlacement, buildingSeed } = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const { GeoBuilder, addWalls } = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': {} } });
const { createSurfaceResolver } = loadModule(read('sz-controller-surfaces.js'));
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 0.1, heights: [100,100,100,100] };
const outer = [{x:-20,z:-20},{x:20,z:-20},{x:20,z:20},{x:-20,z:20}];
const hole = [{x:-5,z:-5},{x:5,z:-5},{x:5,z:5},{x:-5,z:5}];
const building = { id:'way/123', cx:0, cz:0, minX:-20,maxX:20,minZ:-20,maxZ:20,
  height:100,minHeight:40,heightSource:'osm-height',polygons:[{outer,holes:[hole]}] };

test('building walls and colliders share source part heights and retain open courtyards', () => {
  const placement = buildingPlacement(building, grid);
  const builder = new GeoBuilder(true);
  addWalls(builder, [outer,hole].map(r=>r.flatMap(p=>[p.x,p.z])), placement.minY, placement.maxY, [0,0,0,100], placement.baseY);
  const positions = builder.pos.view();
  const ys = Array.from(positions).filter((_,i)=>i%3===1);
  assert.equal(Math.min(...ys),50);
  assert.equal(Math.max(...ys),110);
  assert.equal(placement.colliders[0].minY,Math.min(...ys));
  assert.equal(placement.colliders[0].maxY,Math.max(...ys));
  assert.equal(collision.polygonContains(placement.colliders[0].polygon,0,0),false);
  assert.equal(collision.polygonContains(placement.colliders[0].polygon,10,0),true);
  assert.equal(Math.min(...Array.from(builder.uv.view()).filter((_,i)=>i%2===1)),40);
});

test('building placement fails when terrain is unknown and facade seed uses identity', () => {
  assert.throws(()=>buildingPlacement({...building,cx:1000},grid),/Missing building terrain/);
  assert.equal(buildingSeed('way/123'),buildingSeed('way/123'));
  assert.notEqual(buildingSeed('way/123'),buildingSeed('way/124'));
});

test('raised building soffits face the passage and preserve courtyard holes and side collisions',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
      './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
      './building-collision.js': {},
      './sz-retail-frontage.js': {},
      'three/webgpu': THREE,
      './sz-geodata.js': {},
      './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } }),
      './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
      './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
      './sz-building-layout.js': { buildingPlacement, buildingSeed }, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
    } });
    const scene = new THREE.Scene();
    const blocks = buildCityBlocks(scene, { buildings: [{ ...building, facade: 'office' }], terrain: grid });
    scene.updateMatrixWorld(true);
    const ray = (x, y, z, dx, dy, dz) => new THREE.Raycaster(new THREE.Vector3(x, y, z),
      new THREE.Vector3(dx, dy, dz)).intersectObjects(blocks.group.children);
    const bottom = ray(10, 20, 0, 0, 1, 0)[0];
    assert.equal(bottom.point.y, blocks.colliders[0].minY);
    assert.equal(bottom.face.normal.y, -1);
    assert.equal(ray(0, 20, 0, 0, 1, 0).length, 0);
    assert.equal(ray(30, 20, 0, -1, 0, 0).length, 0);
    assert.equal(ray(30, 60, 0, -1, 0, 0)[0].point.x, building.maxX);
    assert.equal(ray(10, 120, 0, 0, -1, 0)[0].point.y, blocks.colliders[0].maxY);
    assert.equal(collision.polygonContains(blocks.colliders[0].polygon, 0, 0), false);
    assert.ok(blocks.surfaces?.length > 0, 'ordinary roofs expose rendered contact triangles');
    const resolver = createSurfaceResolver({ groundHeight: () => 10, surfaces: blocks.surfaces });
    assert.equal(resolver.below(10, 0, 120).height, 110);
    assert.equal(resolver.below(0, 0, 120).height, 10, 'courtyard stays open');
    assert.equal(resolver.resolve(10, 0).height, 10, 'ground arrivals do not snap to roofs');
    blocks.dispose();
  });

test('one-kilometre building batches preserve every triangle attribute and collider', () => {
  const THREE = {
    Vector2: class { constructor(x, y) { Object.assign(this, { x, y }); } },
    ShapeUtils: { triangulateShape: () => [[0, 1, 2], [0, 2, 3]] },
    BufferAttribute: class { constructor(array, itemSize) { Object.assign(this, { array, itemSize }); } },
    BufferGeometry: class {
      attributes = {};
      setAttribute(name, attribute) { this.attributes[name] = attribute; }
      setIndex(index) { this.index = index; }
      computeBoundingSphere() {}
      computeBoundingBox() {}
    },
    Group: class { children = []; add(mesh) { this.children.push(mesh); } },
    Mesh: class { constructor(geometry) { this.geometry = geometry; } }
  };
  const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
    './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
    './building-collision.js': {},
    './sz-retail-frontage.js': {},
    'three/webgpu': THREE,
    './sz-geodata.js': {},
    './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } }),
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
    './sz-materials.js': { createBuildingMaterial: () => ({}) },
    './sz-building-layout.js': { buildingPlacement, buildingSeed }, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
  } });
  const buildings = [250, 750].map(x => ({
    ...building, id: `building/${x}`, facade: 'office', cx: x, cz: 30,
    minX: x - 20, maxX: x + 20, minZ: 10, maxZ: 50,
    polygons: [{ outer: outer.map(point => ({ x: point.x + x, z: point.z + 30 })), holes: [] }]
  }));
  const scene = { add() {} };
  const options = { buildings, terrain: { ...grid, x0: 0, z0: 0, step: 1000 } };
  const fine = buildCityBlocks(scene, { ...options, renderChunkSize: 500 });
  const coarse = buildCityBlocks(scene, options);
  assert.equal(fine.group.children.length, 2);
  assert.equal(coarse.group.children.length, 1);
  assert.deepEqual(coarse.colliders, fine.colliders);
  assert.deepEqual(coarse.allBlocks, fine.allBlocks);

  function triangles(group) {
    const result = [];
    for (const { geometry } of group.children) {
      const indices = geometry.index.array;
      const attributes = Object.values(geometry.attributes);
      for (let offset = 0; offset < indices.length; offset += 3) {
        const triangle = Array.from(indices.subarray(offset, offset + 3), index => attributes.map(({ array, itemSize }) =>
          Array.from(array.subarray(index * itemSize, (index + 1) * itemSize))));
        result.push(JSON.stringify(triangle));
      }
    }
    return result.sort();
  }
  assert.deepEqual(triangles(coarse.group), triangles(fine.group));
});

test('tall ordinary towers gain an estimated podium with matching display and collision', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
    './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
    './building-collision.js': {},
    './sz-retail-frontage.js': {},
    'three/webgpu': THREE,
    './sz-geodata.js': {},
    './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } }),
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
    './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
    './sz-building-layout.js': { buildingPlacement, buildingSeed }, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
  } });
  const scene = new THREE.Scene();
  const tower = { ...building, id: 'way/999', height: 120, minHeight: 0, polygons: [{ outer, holes: [] }] };
  const blocks = buildCityBlocks(scene, { buildings: [{ ...tower, facade: 'office' }], terrain: grid });
  const podium = blocks.colliders.find(collider => collider.type === 'building-podium');
  assert.ok(podium, 'podium collider exists');
  assert.ok(podium.minX < building.minX && podium.maxX > building.maxX, 'podium extends past the tower footprint');
  assert.ok(podium.maxY - podium.minY >= 6 && podium.maxY - podium.minY <= 20, 'podium height is inside the budget');
  assert.ok(podium.minY + (podium.maxY - podium.minY) < 120 - 30, 'tower still reads above the podium');
  // 架空或矮建筑不生成裙房
  const elevated = buildCityBlocks(scene, { buildings: [{ ...tower, id: 'way/1000', minHeight: 20, facade: 'office' }], terrain: grid });
  assert.equal(elevated.colliders.some(collider => collider.type === 'building-podium'), false);
  blocks.dispose();
  elevated.dispose();
});

test('ordinary roof equipment and parapets share rendered contact geometry', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
    './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
    './building-collision.js': {},
    './sz-retail-frontage.js': {},
    'three/webgpu': THREE,
    './sz-geodata.js': {},
    './sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } }),
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
    './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
    './sz-building-layout.js': { buildingPlacement, buildingSeed }, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
  } });
  const scene = new THREE.Scene();
  const tower = { ...building, id: 'way/2001', height: 150, minHeight: 0, polygons: [{ outer, holes: [] }] };
  const blocks = buildCityBlocks(scene, { buildings: [{ ...tower, facade: 'office' }], terrain: grid });
  assert.equal(blocks.roofs, 1);
  assert.equal(blocks.colliders.filter(collider => collider.type === 'building').length, 1,
    'tower body retains its identity');
  const equipment = blocks.colliders.filter(c => c.type === 'roof-equipment');
  assert.ok(equipment.length > 0, 'visible rooftop units block walking and landing');
  assert.ok(blocks.colliders.some(c => c.type === 'roof-parapet'));
  const resolver = createSurfaceResolver({ groundHeight: () => 10, surfaces: blocks.surfaces });
  for (const c of equipment) {
    const x = (c.minX + c.maxX) / 2, z = (c.minZ + c.maxZ) / 2;
    assert.equal(resolver.below(x, z, 300).height, c.maxY);
  }
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(19.9, 300, 0), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(blocks.group.children);
  assert.ok(hits.length > 0 && hits[0].point.y >= 10, 'roof surface remains raycastable');
  blocks.dispose();
});

test('retail walls replace only street-facing lower geometry and retain the closed collider',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const TSL = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.tsl.js')));
    const imports = { 'three/webgpu': THREE, 'three/tsl': TSL };
    const geometry = loadModule(read('sz-geometry.js'), { imports });
    const layout = { buildingPlacement, buildingSeed };
    const cityUniforms = { cityUniforms: {
      uSkyHorizonColor: TSL.color(0x8899aa), uSkyTopColor: TSL.color(0x667788), uInteriorGlow: TSL.float(1)
    } };
    const signs = loadModule(read('sz-retail-signs.js'), { imports: {
      ...imports, './city-lighting-materials.js': cityUniforms, './sz-strings.js': loadModule(read('sz-strings.js'))
    } });
    const retail = loadModule(read('sz-retail-frontage.js'), { imports: {
      ...imports, './sz-geometry.js': geometry, './sz-building-layout.js': layout, './sz-roads.js': roadsModule,
      './sz-polygon.js': polygonModule, './city-lighting-materials.js': cityUniforms,
      './sz-spatial.js': { spatialIndex: items => () => items }, './sz-retail-signs.js': signs
    } });
    const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
      './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
      './building-collision.js': {},
      ...imports, './sz-retail-frontage.js': retail, './sz-geodata.js': {}, './sz-geometry.js': geometry,
      './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
      './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
      './sz-building-layout.js': layout, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
    } });
    const tower = { ...building, height: 25.3, minHeight: 0, retailFloors: 1,
      facade: 'office', polygons: [{ outer, holes: [] }] };
    const scene = new THREE.Scene();
    const blocks = buildCityBlocks(scene, { buildings: [tower], terrain: grid, retail: {
      pavementAt: (_x, z) => z < -20 ? 10 : null,
      nearRoads: (x, z) => [{ road: { heightSource: 'terrain' }, x, z: -30, distance: Math.abs(z + 30) }]
    } });
    scene.updateMatrixWorld(true);
    const firstHit = y => new THREE.Raycaster(new THREE.Vector3(1, y, -30), new THREE.Vector3(0, 0, 1))
      .intersectObjects(blocks.group.children).filter(hit => hit.distance < 12);
    assert.equal(firstHit(11).length, 1);
    assert.match(firstHit(11)[0].object.name, /^ShenzhenRetail:/);
    assert.match(firstHit(16)[0].object.name, /^ShenzhenBuildings:/);
    assert.ok(blocks.retailDoors.length > 0 && blocks.retailDoors.every(door => !door.open && door.y === 10));
    const door = blocks.retailDoors[0];
    assert.equal(collision.polygonContains(blocks.colliders[0].polygon, door.x, door.z + 0.5), true);
    assert.equal(collision.polygonContains(blocks.colliders[0].polygon, door.x, door.z - 0.5), false);
    assert.equal(blocks.colliders[0].maxY, blocks.surfaces[0].triangles[0][0].y);

    // 雨棚是悬空构件：任何雨棚顶点都不低于人行净空，也不越过首层顶。
    const retailMesh = blocks.group.children.find(child => /^ShenzhenRetail:/.test(child.name));
    const meta = retailMesh.geometry.attributes.bmeta;
    const position = retailMesh.geometry.attributes.position;
    const canopyHeights = [];
    for (let i = 0; i < meta.count; i++) if (meta.getX(i) < 0) canopyHeights.push(position.getY(i));
    assert.ok(canopyHeights.length > 0, 'street frontage generates at least one suspended canopy');
    assert.ok(Math.min(...canopyHeights) >= 10 + 3.05 - 1e-6, 'canopy soffit keeps 3.05m clearance');
    assert.ok(Math.max(...canopyHeights) <= 10 + 4.1 * 0.958 + 1e-6, 'canopy stays below the first-floor top');
    assert.ok(retailMesh.geometry.attributes.bground, 'first-floor height feeds the stone plinth band');

    // 预算账：店招每块 2 三角形、雨棚每段 4 三角形（顶板 + 楔形底板）。
    // 从索引与顶点数反推，确保几何没有隐藏加面，整城规模才能守住 8k 预算。
    let canopyVertices = 0;
    for (let i = 0; i < meta.count; i++) if (meta.getX(i) < 0) canopyVertices++;
    assert.equal(canopyVertices % 8, 0, 'each canopy contributes exactly two quads');
    const canopySegments = canopyVertices / 8;
    assert.equal(retailMesh.geometry.index.count,
      (position.count - canopyVertices) / 4 * 6 + canopySegments * 12,
      'retail index count equals two triangles per wall bay plus four per canopy');
    for (const mesh of blocks.group.children.filter(child => /^ShenzhenRetailSigns:/.test(child.name))) {
      const vertices = mesh.geometry.attributes.position.count;
      assert.equal(vertices % 4, 0, 'each shop sign contributes exactly four vertices');
      assert.equal(mesh.geometry.index.count, vertices / 4 * 6, 'each shop sign contributes two triangles');
      assert.equal(mesh.geometry.attributes.signGlow.count, vertices, 'every shop sign vertex carries its glow flag');
    }

    // 零售材质节点预算：首层三档夜灯与雨棚不能把 TSL 图撑到冷编译超时。
    const countNodes = roots => {
      const seen = new Set(), stack = [...roots];
      while (stack.length) {
        const node = stack.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        for (const child of node.getChildren ? node.getChildren() : []) stack.push(child);
      }
      return seen.size;
    };
    const retailMaterial = retail.createRetailMaterial();
    const colorNodes = countNodes([retailMaterial.colorNode]);
    assert.ok(colorNodes <= 600, `retail colorNode must stay within 600 nodes (got ${colorNodes})`);
    const totalNodes = countNodes([retailMaterial.colorNode, retailMaterial.roughnessNode, retailMaterial.emissiveNode]);
    assert.ok(totalNodes <= 700, `retail material graph must stay within 700 nodes (got ${totalNodes})`);
    const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const signMaterial = signs.createShopSignMaterial(map);
    assert.ok(signMaterial.emissiveNode, 'shop signs keep an independent emissive node');
    assert.ok(countNodes([signMaterial.colorNode, signMaterial.emissiveNode]) <= 120);

    blocks.dispose();
  });

test('reviewed envelopes keep partial wall ownership, exposed roofs and raised clearance across batches',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const imports = { 'three/webgpu': THREE };
    const geometry = loadModule(read('sz-geometry.js'), { imports });
    const envelopes = loadModule(read('sz-building-envelope.js'), { imports: {
      './sz-geometry.js': geometry, './sz-polygon.js': polygonModule,
      './sz-building-envelope-relations.js': loadModule(read('sz-building-envelope-relations.js'))
    } });
    const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
      ...imports, './sz-building-envelope.js': envelopes, './building-collision.js': collision,
      './sz-retail-frontage.js': {}, './sz-geodata.js': {}, './sz-geometry.js': geometry,
      './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
      './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
      './sz-building-layout.js': { buildingPlacement, buildingSeed },
      './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule
    } });
    const ring = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const volume = (id, minX, minZ, maxX, maxZ, height, minHeight = 0, holes = []) => ({
      id, minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, height, minHeight,
      facade: 'office', heightSource: 'osm-height', polygons: [{ outer: ring(minX, minZ, maxX, maxZ), holes }]
    });
    const base = volume('base', -20, -10, 20, 20, 8, 0, [ring(-16, 3, -12, 9)]);
    const tower = volume('tower', -4, -10, 10, 6, 18, 3);
    const raised = volume('raised', 12, -10, 18, 6, 19, 12);
    const buildings = [tower, raised, base];
    const scene = new THREE.Scene();
    const blocks = buildCityBlocks(scene, { buildings, terrain: grid, renderChunkSize: 4,
      envelopeGroups: [[base.id, tower.id, raised.id]] });
    scene.updateMatrixWorld(true);
    const wall = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, -14),
      new THREE.Vector3(0, 0, 1), 0, 4.001).intersectObjects(blocks.group.children);
    const seed = hit => hit.object.geometry.attributes.bmeta.getY(hit.face.a);
    for (const [x, y, owner] of [[1, 11, base], [1, 16, base], [1, 23, tower], [-8, 16, base], [15, 16, base], [15, 24, raised]]) {
      const hits = wall(x, y);
      assert.equal(hits.length, 1, `wall at ${x},${y}`);
      assert.equal(seed(hits[0]), Math.fround(buildingSeed(owner.id) * 10));
    }
    assert.notEqual(wall(1, 16)[0].object, wall(1, 23)[0].object);
    assert.equal(wall(15, 20).length, 0, 'vertical separation retains the opening');
    const roof = createSurfaceResolver({ groundHeight: () => 10, surfaces: blocks.surfaces });
    assert.equal(roof.below(1, 1, 19).height, 10, 'roof inside the tower is omitted');
    assert.equal(roof.below(1, 1, 29).height, 28);
    assert.equal(roof.below(-8, 1, 19).height, 18);
    assert.equal(roof.below(-14, 6, 19).height, 10, 'courtyard retains its opening');
    assert.equal(roof.below(15, 1, 21).height, 18, 'roof under an elevated part remains exposed');
    const soffit = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, 1),
      new THREE.Vector3(0, 1, 0), 0, 3).intersectObjects(blocks.group.children);
    assert.equal(soffit(1, 12).length, 0, 'embedded underside is removed');
    assert.equal(soffit(15, 19)[0].face.normal.y, -1, 'elevated underside is visible');
    assert.deepEqual(Array.from(blocks.colliders, item => [item.sourceId, item.minY, item.maxY]),
      [['tower', 13, 28], ['raised', 22, 29], ['base', 10, 18]]);
    assert.equal(blocks.allBlocks.length, buildings.length);
    blocks.dispose();
  });

test('a reviewed duplicate shares one solid only while its footprint, holes and placement match', () => {
  const relation = loadModule(read('sz-building-envelope-relations.js')).BUILDING_ENVELOPE_RELATIONS
    .find(row => row.kind === 'duplicate-volume');
  const { createBuildingEnvelopePlan } = loadModule(read('sz-building-envelope.js'), { imports: {
    './sz-geometry.js': {}, './sz-polygon.js': polygonModule,
    './sz-building-envelope-relations.js': { BUILDING_ENVELOPE_RELATIONS: [relation] }
  } });
  const [ownerId, aliasId] = relation.sourceIds;
  const owner = { ...building, id: ownerId };
  const alias = { ...building, id: aliasId, polygons: [{ outer: [...outer].reverse(), holes: [[...hole].reverse()] }] };
  const plan = (b = alias, skips = new Set()) => createBuildingEnvelopePlan([b, owner],
    row => buildingPlacement(row, grid), skips);
  assert.equal(plan().duplicateIds.get(aliasId), ownerId);
  assert.equal(plan().envelopes.size, 0);
  assert.equal(plan({ ...alias, minHeight: alias.minHeight + 1 }).duplicateIds.size, 0);
  assert.equal(plan({ ...alias, polygons: [{ outer, holes: [] }] }).duplicateIds.size, 0);
  assert.equal(plan(alias, new Set([ownerId])).duplicateIds.size, 0);
});

// 店招是纯规划 + 纯几何：不依赖 DOM 就能验证图集单元格、uv 越界和名字确定性。
const signStubs = () => loadModule(read('sz-retail-signs.js'), { imports: {
  'three/webgpu': {},
  'three/tsl': { attribute: () => null, mix: () => null, smoothstep: () => null, texture: () => null },
  './city-lighting-materials.js': { cityUniforms: {} },
  './sz-strings.js': loadModule(read('sz-strings.js'))
} });

test('shop sign atlas keeps every panel inside its own cell with deterministic positions', () => {
  const signs = signStubs();
  const seed = 0.371;
  assert.equal(signs.shopSignName(seed), signs.shopSignName(seed), 'names repeat for the same seed');
  assert.notEqual(signs.shopSignName(seed), signs.shopSignName(seed + 0.02), 'different seeds pick different counters');
  const words = loadModule(read('sz-strings.js')).STR.retailShops;
  for (const word of words) assert.ok(word.length >= 2 && word.length <= 4, `${word} must be 2-4 characters`);

  const entries = Array.from({ length: 9 }, (_, i) => {
    const entrySeed = seed + i * 0.071;
    return { width: 2.4 + (i % 4) * 0.2, height: 0.6, seed: entrySeed, name: signs.shopSignName(entrySeed) };
  });
  const plan = signs.planShopSignAtlas(entries);
  assert.ok(plan, 'nine signs fit in one 2048x1024 atlas');
  assert.ok(plan.width <= 2048 && plan.height <= 1024);
  for (const tile of plan.tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0);
    assert.ok(tile.x + tile.width <= plan.width && tile.y + tile.height <= plan.height, 'cell stays inside the atlas');
  }
  for (let i = 0; i < plan.tiles.length; i++) {
    for (let j = i + 1; j < plan.tiles.length; j++) {
      const a = plan.tiles[i], b = plan.tiles[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `sign cells ${i} and ${j} must not overlap`);
    }
  }

  const built = signs.buildShopSignGeometry(plan, entries);
  assert.equal(built.positions.length, entries.length * 12);
  assert.equal(built.uvs.length, entries.length * 8);
  for (const value of built.uvs) assert.ok(value >= 0 && value <= 1, 'sign uv stays inside [0,1]');
  const uvRects = [];
  for (let i = 0; i < entries.length; i++) {
    const uv = built.uvs.slice(i * 8, i * 8 + 8);
    uvRects.push({ u0: Math.min(uv[0], uv[2], uv[4], uv[6]), u1: Math.max(uv[0], uv[2], uv[4], uv[6]),
      v0: Math.min(uv[1], uv[3], uv[5], uv[7]), v1: Math.max(uv[1], uv[3], uv[5], uv[7]) });
  }
  for (let i = 0; i < uvRects.length; i++) {
    assert.ok(uvRects[i].u1 > uvRects[i].u0 && uvRects[i].v1 > uvRects[i].v0);
    for (let j = i + 1; j < uvRects.length; j++) {
      const a = uvRects[i], b = uvRects[j];
      const apart = a.u1 <= b.u0 || b.u1 <= a.u0 || a.v1 <= b.v0 || b.v1 <= a.v0;
      assert.ok(apart, `sign uv ${i} and ${j} must not overlap`);
    }
  }
  for (const glow of built.glows) assert.ok(glow === 0 || glow === 1);

  const again = signs.planShopSignAtlas(entries);
  assert.deepEqual(again.tiles.map(tile => [tile.x, tile.y, tile.width, tile.height, tile.name]),
    plan.tiles.map(tile => [tile.x, tile.y, tile.width, tile.height, tile.name]));
});

test('shop signs stay above 2.9m and lit share stays inside the 55-75% night band', () => {
  const signs = signStubs();
  for (const height of [3.6, 4.1, 4.8, 5.2]) {
    const rect = signs.shopSignRect(0, height, 7.2);
    assert.ok(rect, `storefront ${height}m carries a sign`);
    assert.ok(rect.bottom >= 2.9 - 1e-9, 'sign bottom clears 2.9m');
    assert.ok(rect.height >= 0.5 - 1e-9 && rect.height <= 0.72 + 1e-9);
    assert.ok(rect.top <= height * 0.958 + 1e-9, 'sign top stays inside the fascia band');
    assert.ok(rect.width >= 2.0 - 1e-9 && rect.width <= 3.2 + 1e-9);
  }
  for (const seed of [0.13, 0.37, 0.62, 0.88]) {
    const share = signs.shopSignLitShare(seed);
    assert.ok(share >= 0.55 - 1e-9 && share <= 0.75 + 1e-9, 'lit share stays within 55-75%');
    let lit = 0;
    for (let bay = 0; bay < 240; bay++) lit += signs.shopSignLit(seed, bay) ? 1 : 0;
    assert.ok(lit > 0 && lit < 240, 'a sign run mixes lit and dark panels');
  }
});
