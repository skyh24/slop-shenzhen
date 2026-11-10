const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');

// 离线 stub：只实现细节模块用到的 THREE 能力，避免测试依赖 WebGPU。
function stubThree() {
  const created = { materials: [] };
  class Group {
    constructor() { this.children = []; this.name = ''; }
    add(object) { object.parent = this; this.children.push(object); }
    remove(object) {
      const index = this.children.indexOf(object);
      if (index >= 0) this.children.splice(index, 1);
      object.parent = null;
    }
  }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.name = ''; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; this.disposed = false; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    setIndex(index) { this.index = index; }
    computeBoundingSphere() {}
    computeBoundingBox() {}
    dispose() { this.disposed = true; }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  }
  class MeshStandardNodeMaterial {
    constructor(parameters = {}) { Object.assign(this, parameters); this.disposed = false; created.materials.push(this); }
    dispose() { this.disposed = true; }
  }
  return { Group, Mesh, BufferGeometry, BufferAttribute, MeshStandardNodeMaterial, DoubleSide: 2, created };
}

const terrain = loadModule(read('sz-terrain.js'));
const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const collision = loadModule(read('building-collision.js'));

function loadDetails(THREE, materials = {}) {
  const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  return loadModule(read('sz-building-details.js'), {
    imports: {
      'three/webgpu': THREE,
      './sz-geometry.js': geometry,
      './sz-building-layout.js': layout,
      './building-collision.js': collision,
      './sz-materials.js': materials
    }
  });
}

const FLAT_GRID = () => ({
  x0: -3000, z0: -3000, nx: 200, nz: 200, step: 50,
  heightScale: 0.1, heights: new Array(200 * 200).fill(0)
});

function ring(x, z, half) {
  return [{ x: x - half, z: z - half }, { x: x + half, z: z - half },
    { x: x + half, z: z + half }, { x: x - half, z: z + half }];
}

function makeBuilding({ id, x, z, half = 14, height = 40, minHeight = 0, facade = 'office',
  category = 'commercial', levels = -1, hole = null, holes = null } = {}) {
  const polygonHoles = holes ?? (hole ? [ring(x, z, hole)] : []);
  return {
    id, cx: x, cz: z, minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half,
    height, minHeight, heightSource: 'osm-height', levels, facade, category, landmark: null,
    name: null, polygons: [{ outer: ring(x, z, half), holes: polygonHoles }]
  };
}

function makeScene() {
  const added = [];
  return {
    added,
    add(object) { added.push(object); },
    remove(object) {
      const index = added.indexOf(object);
      if (index >= 0) added.splice(index, 1);
    }
  };
}

function drain(result, position, limit = 400) {
  let guard = 0;
  do {
    result.update(position);
  } while (result.statistics.pending > 0 && guard++ < limit);
  assert.ok(guard < limit, 'streaming did not settle');
  return result.statistics;
}

function geometrySnapshot(group) {
  const chunks = group.children.filter(object => Array.isArray(object.children)
    && object.name.startsWith('ShenzhenBuildingDetails:') && !object.name.includes('AerialLights'));
  const snapshot = [];
  for (const chunk of chunks) {
    for (const mesh of chunk.children) {
      snapshot.push({
        name: mesh.name,
        position: Array.from(mesh.geometry.attributes.position.array),
        index: Array.from(mesh.geometry.index.array)
      });
    }
  }
  snapshot.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return snapshot;
}

test('streams 200 m detail chunks in and out around the player', () => {
  const THREE = stubThree();
  const details = loadDetails(THREE);
  const buildings = [
    makeBuilding({ id: 'way/1', x: 0, z: 0 }),
    makeBuilding({ id: 'way/2', x: 250, z: 0 }),
    makeBuilding({ id: 'way/3', x: 500, z: 0 }),
    makeBuilding({ id: 'way/4', x: 2600, z: 0 })
  ];
  const scene = makeScene();
  const result = details.buildBuildingDetails(scene, { buildings, terrain: FLAT_GRID() });
  const perUpdate = [];
  let guard = 0;
  do {
    const before = result.statistics.generated;
    result.update({ x: 0, z: 0 });
    perUpdate.push(result.statistics.generated - before);
  } while (result.statistics.pending > 0 && guard++ < 50);

  // 650 m 内只有 3 块；每帧最多生成 2 块。
  assert.deepEqual(perUpdate, [2, 1]);
  assert.equal(result.statistics.chunks, 3);
  assert.equal(result.statistics.pending, 0);
  assert.equal(scene.added[0], result.group);
  assert.ok(result.statistics.triangles > 0);
  assert.ok(result.statistics.chunksDetail.every(chunk => chunk.meshes >= 1 && chunk.meshes <= 4));
  assert.ok(result.statistics.chunksDetail.every(chunk => chunk.triangles > 0));
  assert.deepEqual(Array.from(result.statistics.chunksDetail, chunk => chunk.x), [100, 300, 500]);

  // 传送到远处：>850 m 的块全部卸载，新位置周围只剩 1 块。
  const disposedBefore = result.statistics.disposed;
  result.update({ x: 2600, z: 0 });
  drain(result, { x: 2600, z: 0 });
  assert.equal(result.statistics.chunks, 1);
  assert.deepEqual(Array.from(result.statistics.chunksDetail, chunk => chunk.x), [2700]);
  assert.ok(result.statistics.disposed - disposedBefore >= 3);
  assert.equal(result.statistics.pending, 0);
});

test('detail geometry is deterministic for the same input and update sequence', () => {
  const buildings = [
    makeBuilding({ id: 'way/100', x: 0, z: 0, half: 16, height: 96, facade: 'residential_tower', levels: 32, category: 'residential' }),
    makeBuilding({ id: 'way/101', x: 70, z: 10, half: 12, height: 60, facade: 'office' }),
    makeBuilding({ id: 'way/102', x: 140, z: 30, half: 9, height: 21, facade: 'village', category: 'residential' }),
    makeBuilding({ id: 'way/103', x: 210, z: -40, half: 20, height: 120, facade: 'glass_tower', hole: 6 })
  ];
  function run() {
    const details = loadDetails(stubThree());
    const result = details.buildBuildingDetails(makeScene(), { buildings, terrain: FLAT_GRID() });
    const sequence = [{ x: 0, z: 0 }, { x: 150, z: 10 }, { x: 700, z: -200 }, { x: 0, z: 0 }];
    for (const position of sequence) drain(result, position);
    const statistics = result.statistics;
    return {
      geometry: geometrySnapshot(result.group),
      summary: {
        chunks: statistics.chunks, meshes: statistics.meshes, triangles: statistics.triangles,
        buildings: statistics.buildings, balconies: statistics.balconies,
        acUnits: statistics.acUnits, roofParts: statistics.roofParts,
        parapetParts: statistics.parapetParts, generated: statistics.generated
      }
    };
  }
  const first = run();
  const second = run();
  assert.ok(first.geometry.length > 0);
  assert.deepEqual(first.geometry, second.geometry);
  assert.deepEqual(first.summary, second.summary);
  assert.ok(first.summary.balconies > 0);
});

test('rooftop equipment stays inside the roof polygon and clear of courtyards', () => {
  const details = loadDetails(stubThree());
  const grid = FLAT_GRID();
  const outer = ring(0, 0, 30);
  const hole = ring(0, 0, 8);
  const building = {
    id: 'way/roof-1', cx: 0, cz: 0, minX: -30, maxX: 30, minZ: -30, maxZ: 30,
    height: 80, minHeight: 0, heightSource: 'osm-height', levels: -1, facade: 'office',
    category: 'commercial', landmark: null, name: null, polygons: [{ outer, holes: [hole] }]
  };
  const placement = layout.buildingPlacement(building, grid);
  const plan = details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } });
  assert.ok(plan.roofParts.length >= 1, 'expected at least one rooftop part');
  const polygon = building.polygons[0];
  for (const part of plan.roofParts) {
    assert.ok(part.y >= placement.maxY - 1e-9, 'roof parts must sit on the roof');
    if (part.kind === 'tank') {
      for (let k = 0; k < 8; k++) {
        const angle = (Math.PI * 2 * k) / 8;
        assert.equal(collision.polygonContains(polygon, part.x + Math.cos(angle) * part.radius,
          part.z + Math.sin(angle) * part.radius), true);
      }
      continue;
    }
    const cs = Math.cos(part.yaw);
    const sn = -Math.sin(part.yaw);
    const corners = [[-part.w / 2, -part.d / 2], [part.w / 2, -part.d / 2], [part.w / 2, part.d / 2], [-part.w / 2, part.d / 2]]
      .map(([u, v]) => ({ x: part.x + u * cs + v * sn, z: part.z - u * sn + v * cs }));
    for (const corner of corners) {
      assert.equal(collision.polygonContains(polygon, corner.x, corner.z), true,
        `${part.kind} corner fell outside the roof or into the courtyard`);
    }
  }
  // 同种子同规划，不依赖数据顺序。
  assert.deepEqual(details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } }), plan);
});

test('balconies stay near, never at ground level, and AC units are nearer than balconies', () => {
  const details = loadDetails(stubThree());
  const grid = FLAT_GRID();
  const building = makeBuilding({
    id: 'way/tower-9', x: 0, z: 0, half: 16, height: 90, facade: 'residential_tower',
    levels: 30, category: 'residential'
  });
  const placement = layout.buildingPlacement(building, grid);
  const near = details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } });
  assert.ok(near.balconies.length > 0 && near.balconies.length <= 30);
  assert.ok(near.acUnits.length > 0 && near.acUnits.length <= 16);
  assert.ok(near.canopy);
  assert.ok(near.parapet.parts.length > 0);
  for (const balcony of near.balconies) {
    assert.ok(balcony.y >= placement.minY + near.floorHeight - 1e-9, 'ground floor must not cantilever');
    assert.ok(balcony.y < placement.maxY);
  }
  for (const unit of near.acUnits) {
    assert.ok(unit.y > placement.minY + near.floorHeight, 'AC units sit above the ground floor');
    assert.ok(unit.y < placement.maxY);
  }

  const mid = details.planBuildingDetails(building, placement, { playerPosition: { x: 240, z: 0 } });
  assert.ok(mid.balconies.length > 0);
  assert.equal(mid.acUnits.length, 0);
  const far = details.planBuildingDetails(building, placement, { playerPosition: { x: 300, z: 0 } });
  assert.equal(far.balconies.length, 0);
  assert.equal(far.acUnits.length, 0);
  assert.equal(far.canopy, null);
  assert.ok(far.parapet.parts.length > 0, 'roof detail is kept outside the facade detail radius');
});

test('levels drive floor rhythm without changing the building height', () => {
  const details = loadDetails(stubThree());
  const building = makeBuilding({ id: 'way/levels', x: 0, z: 0, half: 12, height: 60, facade: 'residential_low', levels: 20, category: 'residential' });
  const grid = FLAT_GRID();
  const placement = layout.buildingPlacement(building, grid);
  const plan = details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } });
  assert.equal(plan.floors, 20);
  assert.equal(plan.floorHeight, 3);
  assert.equal(plan.roofY, placement.maxY);
  assert.equal(placement.maxY - placement.minY, building.height);
});

test('raised (架空) buildings start all details above minY', () => {
  const details = loadDetails(stubThree());
  const grid = FLAT_GRID();
  const building = makeBuilding({ id: 'way/raised', x: 0, z: 0, half: 15, height: 70, minHeight: 6, facade: 'residential_tower', levels: 21, category: 'residential' });
  const placement = layout.buildingPlacement(building, grid);
  assert.ok(placement.minY > 0);
  const plan = details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } });
  assert.ok(plan.balconies.every(balcony => balcony.y >= placement.minY));
  assert.ok(plan.acUnits.every(unit => unit.y >= placement.minY));
  assert.ok(plan.parapet.parts.length > 0);
  assert.ok(plan.canopy && plan.canopy.y >= placement.minY);
});

test('landmark buildings and skipIds produce no detail geometry', () => {
  const details = loadDetails(stubThree());
  const buildings = [
    makeBuilding({ id: 'way/plain', x: 0, z: 0 }),
    makeBuilding({ id: 'way/landmark-facade', x: 60, z: 0, facade: 'landmark' }),
    makeBuilding({ id: 'way/skip-me', x: 120, z: 0 }),
    { ...makeBuilding({ id: 'way/landmark-id', x: 180, z: 0 }), landmark: 'civic-center' }
  ];
  const result = details.buildBuildingDetails(makeScene(), {
    buildings, terrain: FLAT_GRID(), skipIds: new Set(['way/skip-me']), maxChunksPerUpdate: 8
  });
  result.update({ x: 0, z: 0 });
  assert.equal(result.statistics.buildings, 1);
  assert.equal(result.statistics.generated, 1);
  assert.ok(result.statistics.triangles > 0);
});

test('thin roofs stay inside the per-chunk mesh and triangle budgets', () => {
  const details = loadDetails(stubThree());
  const buildings = [];
  for (let ix = 0; ix < 5; ix++) {
    for (let iz = 0; iz < 5; iz++) {
      buildings.push(makeBuilding({
        id: `way/dense-${ix}-${iz}`, x: 20 + ix * 20, z: 20 + iz * 20, half: 8,
        height: 15, facade: 'village', category: 'residential'
      }));
    }
  }
  const result = details.buildBuildingDetails(makeScene(), {
    buildings, terrain: FLAT_GRID(), maxChunksPerUpdate: 8, maxChunkTriangles: 120
  });
  result.update({ x: 0, z: 0 });
  assert.equal(result.statistics.chunks, 1);
  const detail = result.statistics.chunksDetail[0];
  assert.ok(detail.meshes <= 4);
  assert.ok(detail.triangles <= 120);
  assert.ok(detail.triangles > 0);
  assert.ok(detail.buildings < buildings.length, 'budget must trim less prominent buildings');
  assert.equal(detail.meshes >= 1, true);
});

test('statistics stay stable while the player does not move; dispose releases everything', () => {
  const THREE = stubThree();
  const details = loadDetails(THREE);
  const buildings = [
    makeBuilding({ id: 'way/stable-a', x: 0, z: 0, half: 16, height: 96, facade: 'residential_tower', levels: 32, category: 'residential' }),
    makeBuilding({ id: 'way/stable-b', x: 100, z: 20, height: 200, facade: 'glass_tower' })
  ];
  const scene = makeScene();
  const result = details.buildBuildingDetails(scene, { buildings, terrain: FLAT_GRID() });
  drain(result, { x: 0, z: 0 });
  const snapshot = {
    chunks: result.statistics.chunks, meshes: result.statistics.meshes,
    triangles: result.statistics.triangles, buildings: result.statistics.buildings,
    generated: result.statistics.generated, aerialLights: result.statistics.aerialLights
  };
  assert.ok(snapshot.aerialLights >= 1, '150 m+ towers get an aviation obstruction light');
  for (let i = 0; i < 6; i++) result.update({ x: 0, z: 0 });
  assert.deepEqual({
    chunks: result.statistics.chunks, meshes: result.statistics.meshes,
    triangles: result.statistics.triangles, buildings: result.statistics.buildings,
    generated: result.statistics.generated, aerialLights: result.statistics.aerialLights
  }, snapshot);
  assert.equal(result.statistics.pending, 0);

  const chunkGroups = result.group.children.filter(object => object.name !== 'ShenzhenBuildingDetails:AerialLights');
  const meshes = chunkGroups.flatMap(chunk => chunk.children);
  assert.ok(meshes.length > 0);
  const materials = THREE.created.materials;
  assert.ok(materials.length >= 5);
  result.dispose();
  assert.equal(result.group.children.length, 0);
  assert.equal(scene.added.length, 0);
  assert.equal(result.statistics.chunks, 0);
  assert.equal(result.statistics.meshes, 0);
  assert.equal(result.statistics.triangles, 0);
  assert.equal(result.statistics.aerialMeshes, 0);
  assert.ok(meshes.every(mesh => mesh.geometry.disposed));
  assert.ok(materials.every(material => material.disposed));
  result.dispose();
});

test('invalid update positions and missing terrain fail loudly', () => {
  const details = loadDetails(stubThree());
  assert.throws(() => details.buildBuildingDetails(makeScene(), { buildings: [] }), /Missing terrain/);
  const result = details.buildBuildingDetails(makeScene(), { buildings: [], terrain: FLAT_GRID() });
  assert.throws(() => result.update({}), /finite x\/z/);
  assert.throws(() => result.update({ x: Number.NaN, z: 0 }), /finite x\/z/);
  assert.throws(() => details.buildBuildingDetails(makeScene(), {
    buildings: [], terrain: FLAT_GRID(), generateRadius: 800, disposeRadius: 700
  }), /Dispose radius/);
});

test('reuses FACADE_PROFILES from sz-materials when it is available', () => {
  const shared = [{
    name: 'village', bayWidth: 3.3, floorHeight: 3.7
  }];
  const details = loadDetails(stubThree(), { FACADE_PROFILES: shared });
  const building = makeBuilding({ id: 'way/shared-profile', x: 0, z: 0, half: 12, height: 37, facade: 'village' });
  const grid = FLAT_GRID();
  const placement = layout.buildingPlacement(building, grid);
  const plan = details.planBuildingDetails(building, placement, { playerPosition: { x: 0, z: 0 } });
  assert.equal(plan.floorHeight, 3.7);
  assert.equal(plan.floors, 10);
  assert.equal(plan.roofY, placement.maxY);
});

test('real three smoke: merged meshes, finite vertices, unload and dispose',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const details = loadDetails(THREE);
    const buildings = [
      makeBuilding({ id: 'way/smoke-a', x: 0, z: 0, half: 16, height: 96, facade: 'residential_tower', levels: 32, category: 'residential' }),
      makeBuilding({ id: 'way/smoke-b', x: 120, z: 40, half: 14, height: 210, facade: 'office', hole: 4 })
    ];
    const scene = new THREE.Scene();
    const result = details.buildBuildingDetails(scene, { buildings, terrain: FLAT_GRID() });
    drain(result, { x: 0, z: 0 });
    assert.ok(result.statistics.chunks >= 1);
    assert.ok(result.statistics.triangles > 0);
    assert.ok(result.statistics.meshes <= result.statistics.chunks * 4);
    for (const object of result.group.children) {
      if (!object.isMesh) continue;
      const position = object.geometry.attributes.position.array;
      assert.ok(position.length > 0);
      for (let i = 0; i < position.length; i++) assert.ok(Number.isFinite(position[i]));
      assert.ok(object.geometry.boundingSphere);
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      assert.ok(box.min.y >= -1e-6);
    }
    result.update({ x: 3000, z: 0 });
    assert.equal(result.statistics.chunks, 0);
    result.dispose();
    assert.equal(result.group.children.length, 0);
    assert.equal(scene.getObjectByName('ShenzhenBuildingDetails'), undefined);
  });
