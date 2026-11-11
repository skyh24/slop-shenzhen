const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');
const meshUtils = require('./helpers/mesh-utils.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const format = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { geo } = format.decodeCityPayload(raw);
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const metroSource = read('sz-metro-entrances.js');
const stubs = { 'three/webgpu': {}, 'three/tsl': {}, './building-collision.js': collision,
  './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils({}) };
const planning = loadModule(metroSource, { imports: stubs });
const HEX_COLOUR = /^#[0-9A-F]{6}$/i;

test('planMetroEntrances links verified OSM entrances to stations, names and official line colours', () => {
  const plan = planning.planMetroEntrances(geo.metro);
  assert.ok(plan.entrances.length > 250, `linked=${plan.entrances.length}`);
  assert.ok(plan.unresolved.length < 80, `unresolved=${plan.unresolved.length}`);
  assert.deepEqual(plan, planning.planMetroEntrances(geo.metro), 'planning must be deterministic');
  const official = new Map(geo.metro.lines.map(line => [line.ref, line.colour.toUpperCase()]));
  for (const entrance of plan.entrances) {
    assert.ok(Number.isFinite(entrance.x) && Number.isFinite(entrance.z));
    assert.ok(entrance.stationName.length > 0, `station name for ${entrance.id}`);
    assert.deepEqual([...entrance.lineRefs].sort(), [...new Set(entrance.lineRefs)].sort());
    assert.equal(entrance.lineRefs.length, entrance.colours.length);
    entrance.lineRefs.forEach((ref, index) => {
      assert.ok(official.has(ref), `unknown line ${ref} at ${entrance.id}`);
      assert.match(entrance.colours[index], HEX_COLOUR);
      assert.equal(entrance.colours[index], official.get(ref));
    });
    assert.ok(['line-overlap-nearest-station', 'nearest-station', 'entrance-name']
      .includes(entrance.associationSource));
  }
  const ids = plan.entrances.map(entrance => entrance.id);
  assert.equal(ids.join(','), ids.slice().sort((a, b) => a.localeCompare(b, 'en')).join(','), 'entrances sorted by OSM id');
  for (const entry of plan.unresolved) {
    assert.ok(entry.id && entry.reason, 'unresolved entry keeps identity and reason');
  }
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('buildSzMetroEntrances snaps canopies to the rendered ground and maintains colliders, chunks and LOD',
  { skip: !threeDir }, async () => {
    const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
    const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
    const imports = { 'three/webgpu': THREE, 'three/tsl': TSL, './building-collision.js': collision,
      './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils(THREE) };
    const ground = loadModule(read('sz-ground-surface.js'));
    const groundHeight = ground.createGroundSurfaceSampler(geo.terrainSurface);
    const { buildSzMetroEntrances } = loadModule(metroSource, { imports });
    const scene = new THREE.Scene();
    const model = buildSzMetroEntrances(scene, geo.metro, {
      // 和 js/main.js 一致用 1000 m 分块；分块数决定下面的 drawCallsEstimate 预算。
      groundHeight, roadHeight: () => null, pathAt: () => [], colliders: [], chunkSizeM: 1000
    });
    assert.equal(scene.children.length, 1);
    assert.ok(model.statistics.placed > 250, `placed=${model.statistics.placed}`);
    assert.equal(model.colliders.length, model.statistics.placed);
    assert.equal(model.statistics.planned, planning.planMetroEntrances(geo.metro).entrances.length);
    assert.equal(model.statistics.placed + model.statistics.skippedTotal, model.statistics.planned);
    assert.ok(model.statistics.chunks > 0);
    assert.ok(model.statistics.drawCallsEstimate < 150, `drawCalls=${model.statistics.drawCallsEstimate}`);
    assert.ok(model.statistics.signAtlas.stations > 0 && model.statistics.signAtlas.badges > 0);

    // 每个入口的 y 必须等于中心加四角探针的最低值，和渲染地面同一套采样器。
    for (const entrance of model.entrances) {
      const sin = Math.sin(entrance.yaw), cos = Math.cos(entrance.yaw);
      const probes = [[0, 0], [2.55, 1.65], [-2.55, 1.65], [2.55, -1.65], [-2.55, -1.65]].map(([lx, lz]) => ({
        x: entrance.x + lx * cos + lz * sin, z: entrance.z - lx * sin + lz * cos
      }));
      const heights = probes.map(probe => groundHeight(probe.x, probe.z));
      assert.ok(heights.every(Number.isFinite), `ground probe under ${entrance.id}`);
      assert.equal(entrance.y, Math.min(...heights));
    }
    for (const collider of model.colliders) {
      assert.equal(collider.type, 'metro-entrance');
      assert.equal(collider.polygon.outer.length, 4);
      assert.ok(collider.minY < collider.maxY);
      assert.ok(Number.isFinite(collider.minX) && Number.isFinite(collider.maxZ));
      assert.equal(collider.heightSource, 'estimate');
    }
    const chunks = model.group.children.filter(child => child.name.startsWith('metro-entrance-structures:'));
    assert.equal(chunks.length, model.statistics.chunks);
    model.update(new THREE.Vector3(1e9, 0, 1e9));
    assert.ok(chunks.every(chunk => chunk.visible === false), 'far camera hides entrance chunks');
    model.update(new THREE.Vector3(0, 0, 0));
    assert.ok(chunks.some(chunk => chunk.visible === true), 'near camera shows entrance chunks');

    // 玻璃必须和结构一样按块实例化：每块包围球只覆盖一个 chunk，视锥剔除才有意义。
    const glassChunks = model.group.children.filter(child => child.name.startsWith('metro-entrance-glass:'));
    assert.equal(glassChunks.length, model.statistics.chunks);
    let glassInstanceTotal = 0;
    for (const glassChunk of glassChunks) {
      assert.equal(glassChunk.isInstancedMesh, true, `${glassChunk.name} is an InstancedMesh`);
      assert.equal(glassChunk.frustumCulled, true, `${glassChunk.name} keeps frustum culling`);
      assert.ok(glassChunk.boundingSphere, `${glassChunk.name} has a bounding sphere`);
      assert.ok(Number.isFinite(glassChunk.boundingSphere.radius), `${glassChunk.name} radius is finite`);
      // 1000 m 块的对角半径上限约 707 m，取 1500 作为宽松上限，全城包围球会远超这个值。
      assert.ok(glassChunk.boundingSphere.radius <= 1500, `${glassChunk.name} radius=${glassChunk.boundingSphere.radius}`);
      glassInstanceTotal += glassChunk.count;
    }
    assert.equal(glassInstanceTotal, model.statistics.placed);
    model.update(new THREE.Vector3(1e9, 0, 1e9));
    assert.ok(glassChunks.every(chunk => chunk.visible === false), 'far camera hides glass chunks');
    model.update(new THREE.Vector3(0, 0, 0));
    assert.ok(glassChunks.some(chunk => chunk.visible === true), 'near camera shows glass chunks');

    const signMeshes = model.group.children.filter(child => child.name.startsWith('metro-entrance-signs-'));
    assert.equal(signMeshes.length, 2);

    model.dispose();
    assert.equal(scene.children.length, 0);
  });

test('buildSzMetroEntrances reports skip reasons instead of placing on roads, buildings or unsupported ground',
  { skip: !threeDir }, async () => {
    const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
    const [THREE, TSL] = await Promise.all([loadThree('three.webgpu.js'), loadThree('three.tsl.js')]);
    const imports = { 'three/webgpu': THREE, 'three/tsl': TSL, './building-collision.js': collision,
      './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils(THREE) };
    const { buildSzMetroEntrances } = loadModule(metroSource, { imports });
    const subset = {
      stations: geo.metro.stations,
      lines: geo.metro.lines,
      entrances: geo.metro.entrances.slice(0, 24)
    };
    const plan = planning.planMetroEntrances(subset);
    const first = plan.entrances[0];
    const scene = new THREE.Scene();
    const model = buildSzMetroEntrances(scene, subset, {
      groundHeight: () => 6, roadHeight: () => null, pathAt: () => [],
      colliders: [{
        type: 'building', name: 'test-block', minX: first.x - 8, maxX: first.x + 8,
        minZ: first.z - 8, maxZ: first.z + 8, minY: 0, maxY: 30,
        polygon: { outer: [{ x: first.x - 8, z: first.z - 8 }, { x: first.x + 8, z: first.z - 8 },
          { x: first.x + 8, z: first.z + 8 }, { x: first.x - 8, z: first.z + 8 }], holes: [] }
      }]
    });
    assert.equal(model.statistics.planned, plan.entrances.length);
    assert.equal(model.statistics.placed + model.statistics.skippedTotal, plan.entrances.length);
    assert.equal(model.statistics.skipped.buildingConflict, 1);
    assert.equal(model.colliders.length, model.statistics.placed);
    model.dispose();
    assert.equal(scene.children.length, 0);

    const roadScene = new THREE.Scene();
    const roadModel = buildSzMetroEntrances(roadScene, subset, {
      groundHeight: () => 6, roadHeight: () => 6, pathAt: () => [], colliders: []
    });
    assert.equal(roadModel.statistics.placed, 0);
    assert.equal(roadModel.group, null);
    assert.equal(roadModel.statistics.skipped.roadConflict, plan.entrances.length);
    assert.equal(roadScene.children.length, 0);
  });
