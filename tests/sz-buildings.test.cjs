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

test('ordinary towers get estimated parapets and rooftop equipment without new colliders', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const { buildCityBlocks } = loadModule(read('sz-buildings.js'), { imports: {
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
    'roof details must not add colliders');
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(19.9, 300, 0), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(blocks.group.children);
  assert.ok(hits.length > 0 && hits[0].point.y >= 10, 'roof surface remains raycastable');
  blocks.dispose();
});
