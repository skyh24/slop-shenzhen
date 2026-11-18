const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');

class Group {
  constructor() { this.children = []; this.name = ''; }
  add(...objects) { for (const object of objects) { object.parent = this; this.children.push(object); } }
  removeFromParent() { this.parent = null; }
  updateMatrixWorld() {}
}

// 用桩替掉区域流和所有非岸线资源，只让 sz-regional-scene 的岸线挂载逻辑真实运行。
function loadShore() {
  const stream = { options: null, visuals: [], mounts: 0, releases: 0, disposed: 0, lights: [] };
  const geo = {
    regionalScene: { cells: [], drone: { stations: [], routes: [] } },
    air: {},
    shenzhenBay: { walkRoute: [], shore: [] },
    waterfront: { dasha: { banks: [] } },
    water: []
  };
  const deps = {
    site: { heightAt: () => 0, nearObstacles: () => [], isWater: () => false, colliders: [] },
    talentPark: { mount: () => ({ dispose() {} }), visualObjects: 0 },
    trees: { flightObstacles: () => [] },
    vegetation: { flightObstacles: () => [] },
    elevatedRoads: { surfaces: [] },
    bayPaths: [],
    waterfrontPaths: { routes: [] }
  };
  const scene = { children: [], add(...objects) { this.children.push(...objects); }, remove() {} };
  const regional = loadModule(read('sz-regional-scene.js'), { imports: {
    'three/webgpu': { Group },
    './sz-detail-residency.js': loadModule(read('sz-detail-residency.js')),
    './sz-metro-entrances.js': {
      buildSzMetroEntrances: () => ({ group: new Group(), entrances: [], update() {}, dispose() {} }),
      createMetroStructureResources: () => ({ dispose() {} }),
      metroEntranceCollider: () => ({})
    },
    './sz-bay-waterfront.js': {
      appendBayShoreFace() {}, bayFixtureCollider: () => ({}), bayShoreSections: () => [],
      createBayWaterfrontResources: () => ({ dispose() {} }), createBayPublicRoutes: () => [],
      mountBayWaterfrontBatch: () => ({ update() {}, dispose() {} })
    },
    './sz-waterfront.js': {
      createWaterfrontPublicRoutes: () => [], mountWaterfrontBank: () => ({ dispose() {} }),
      mountWaterfrontBatch(group, batch, material) {
        stream.mounts++;
        return { update() {}, dispose() { stream.releases++; } };
      },
      waterfrontFixtureCollider: () => ({})
    },
    './sz-drone-routes.js': {
      buildSzDroneRoutes: () => ({ previewRoute: null, followedRoute: null, isFlying: () => false,
        group: new Group(), mountStation: () => ({ dispose() {} }), mountRoute: () => ({ dispose() {} }),
        mountLine: () => ({ dispose() {} }), dispose() {} }),
      droneStationColliders: () => []
    },
    './sz-site-fixtures.js': {
      createGreenwayLightMaterial: () => {
        const material = { disposed: 0, dispose() { this.disposed++; } };
        stream.lights.push(material);
        return material;
      },
      unpackFixtureRows: rows => rows,
      unpackGreenwayLightPools() {}
    },
    './sz-controller-surfaces.js': { createSurfaceHeightAt: () => () => 0 },
    './sz-sea.js': { buildSzSea: () => ({ mesh: { updateMatrixWorld() {} }, dispose() {} }) },
    './sz-regional-format.js': { compatibleRegionalScene: () => true },
    './sz-regional-stream.js': {
      createRegionalStream(manifest, options) {
        stream.options = options;
        return { statistics: {}, prepare: () => null, colliders: () => [], failedRoute: () => false,
          start() {}, update() {}, routes: () => [],
          visual(build, row) { stream.visuals.push({ build, row }); },
          dispose() { stream.disposed++; } };
      }
    }
  } });
  return { layer: regional.createRegionalScene(scene, geo, deps, () => false), scene, stream };
}

test('shoreline residency drops stale queued builds and releases only its own instances', () => {
  const { layer, stream } = loadShore();
  const batch = { x: 0, z: 0, steel: [], lamp: [], poolPositions: [0, 1, 2], pools: [] };
  const live = stream.options.mount({ kind: 'shore', id: 'shore-0' }, { batch, colliders: [] });

  // 进入 275 m 内只排一次创建。
  live.update({ x: 200, z: 0 });
  live.update({ x: 201, z: 0 });
  assert.equal(stream.visuals.length, 1);

  // 离开后排队结果作废：先走到 400 m，再执行已入队的创建。
  live.update({ x: 400, z: 0 });
  assert.equal(stream.visuals.length, 1);
  stream.visuals.shift().build();
  assert.equal(stream.mounts, 0);

  // 重新进入只创建一次。
  live.update({ x: 200, z: 0 });
  stream.visuals.shift().build();
  assert.equal(stream.mounts, 1);

  // 275–335 m 迟滞带内保持，超过 335 m 释放。
  live.update({ x: 335, z: 0 });
  assert.equal(stream.releases, 0);
  live.update({ x: 335.001, z: 0 });
  assert.equal(stream.releases, 1);

  // 释放后重进同样只创建一次。
  live.update({ x: 200, z: 0 });
  live.update({ x: 200, z: 0 });
  assert.equal(stream.visuals.length, 1);
  stream.visuals.shift().build();
  assert.equal(stream.mounts, 2);

  // 释放这一个岸线消费者不销毁共享路面灯材质。
  live.dispose();
  assert.equal(stream.releases, 2);
  assert.equal(stream.lights.length, 1);
  assert.equal(stream.lights[0].disposed, 0);

  // 共享材质归区域场景，随场景释放。
  layer.dispose();
  assert.equal(stream.lights[0].disposed, 1);
  assert.equal(stream.disposed, 1);
});
