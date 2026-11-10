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
const stationSource = read('sz-station-sites.js');
const stubs = { 'three/webgpu': {}, './building-collision.js': collision,
  './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils({}) };
const emptyModule = loadModule(stationSource, { imports: stubs });

test('station builders return empty results without throwing when the shared site is missing', () => {
  const futian = emptyModule.buildFutianStation(null, undefined, {});
  assert.equal(futian.group, null);
  assert.equal(futian.statistics.entrances, 0);
  assert.equal(futian.colliders.length, 0);
  futian.update();
  futian.dispose();
  const xili = emptyModule.buildXiliConstruction(null, null, {});
  assert.equal(xili.group, null);
  assert.equal(xili.statistics.hoardingLengthM, 0);
  assert.equal(xili.colliders.length, 0);
  xili.update();
  xili.dispose();
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('Futian station ground pavilions and skylights stay inside the real OSM station footprint',
  { skip: !threeDir }, async () => {
    const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
    const [THREE] = await Promise.all([loadThree('three.webgpu.js')]);
    const imports = { 'three/webgpu': THREE, './building-collision.js': collision,
      './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils(THREE) };
    const ground = loadModule(read('sz-ground-surface.js'));
    const { buildFutianStation } = loadModule(stationSource, { imports });
    const stationSite = geo.sites['futian-station'].station;
    const polygon = { outer: stationSite.polygons[0].outer, holes: [] };
    const groundHeight = ground.createGroundSurfaceSampler(geo.terrainSurface);
    const scene = new THREE.Scene();
    const model = buildFutianStation(scene, stationSite, { groundHeight, colliders: [] });
    assert.equal(scene.children.length, 1);
    assert.ok(model.entrances.length >= 4 && model.entrances.length <= 8, `entrances=${model.entrances.length}`);
    assert.equal(model.skylights.length, 2);
    assert.equal(model.statistics.entrances, model.entrances.length);
    assert.equal(model.statistics.skylights, model.skylights.length);
    assert.equal(model.colliders.length, model.entrances.length + model.skylights.length);
    assert.equal(model.statistics.siteOsmId, 'way/800275814');
    for (const entrance of model.entrances) {
      assert.ok(collision.polygonContains(polygon, entrance.x, entrance.z), `pavilion inside footprint: ${entrance.x},${entrance.z}`);
      assert.ok(Number.isFinite(entrance.y) && Number.isFinite(entrance.yaw));
      const sizes = [[-3.5, -2.5], [3.5, -2.5], [3.5, 2.5], [-3.5, 2.5]].map(([lx, lz]) => {
        const sin = Math.sin(entrance.yaw), cos = Math.cos(entrance.yaw);
        return { x: entrance.x + lx * cos + lz * sin, z: entrance.z - lx * sin + lz * cos };
      });
      for (const corner of sizes) {
        assert.ok(collision.polygonContains(polygon, corner.x, corner.z), 'pavilion corners inside footprint');
      }
    }
    for (const skylight of model.skylights) {
      assert.ok(collision.polygonContains(polygon, skylight.x, skylight.z), 'skylight inside footprint');
      assert.ok(Number.isFinite(skylight.y));
    }
    assert.ok(model.parts.every(part => part.heightSource === 'estimate'));
    for (const collider of model.colliders) {
      assert.ok(['futian-station-entrance', 'futian-station-skylight'].includes(collider.type));
      assert.ok(collider.minY < collider.maxY);
      assert.equal(collider.heightSource, 'estimate');
    }
    model.update(new THREE.Vector3(0, 100, 0));
    model.dispose();
    assert.equal(scene.children.length, 0);
  });

test('Xili station site is an honest construction site: hoarding, two cranes and a pit, all estimate',
  { skip: !threeDir }, async () => {
    const loadThree = file => import(pathToFileURL(join(threeDir, 'build', file)));
    const [THREE] = await Promise.all([loadThree('three.webgpu.js')]);
    const imports = { 'three/webgpu': THREE, './building-collision.js': collision,
      './sz-polygon.js': polygonModule, './sz-mesh-utils.js': meshUtils(THREE) };
    const ground = loadModule(read('sz-ground-surface.js'));
    const { buildXiliConstruction } = loadModule(stationSource, { imports });
    const xiliSite = geo.sites['xili-station'].site;
    const polygon = { outer: xiliSite.polygons[0].outer, holes: [] };
    const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    for (const point of polygon.outer) {
      bounds.minX = Math.min(bounds.minX, point.x);
      bounds.maxX = Math.max(bounds.maxX, point.x);
      bounds.minZ = Math.min(bounds.minZ, point.z);
      bounds.maxZ = Math.max(bounds.maxZ, point.z);
    }
    // 只检查西丽站附近的湖/水体，避免扫描全城 622 个水面。
    const nearbyWater = geo.water.filter(water => water.outer.some(point =>
      point.x > bounds.minX - 800 && point.x < bounds.maxX + 800
      && point.z > bounds.minZ - 800 && point.z < bounds.maxZ + 800));
    const isWater = (x, z) => nearbyWater.some(water => collision.polygonContains(water, x, z));
    const groundHeight = ground.createGroundSurfaceSampler(geo.terrainSurface);
    const perimeter = (() => {
      let length = 0;
      for (let i = 0; i < polygon.outer.length; i++) {
        const a = polygon.outer[i], b = polygon.outer[(i + 1) % polygon.outer.length];
        length += Math.hypot(b.x - a.x, b.z - a.z);
      }
      return length;
    })();
    const scene = new THREE.Scene();
    const model = buildXiliConstruction(scene, xiliSite, { groundHeight, isWater });
    assert.equal(scene.children.length, 1);
    assert.equal(model.statistics.siteOsmId, 'way/402048868');
    assert.ok(model.statistics.hoardingLengthM > 0);
    assert.ok(Math.abs(model.statistics.hoardingLengthM - perimeter) / perimeter < 0.15,
      `hoarding=${model.statistics.hoardingLengthM} perimeter=${perimeter}`);
    assert.ok(model.statistics.hoardingSegments > 20);
    assert.equal(model.cranes.length, 2);
    assert.equal(model.statistics.cranes, 2);
    for (const crane of model.cranes) {
      assert.ok(collision.polygonContains(polygon, crane.x, crane.z), `crane inside site: ${crane.x},${crane.z}`);
      assert.ok(crane.towerM >= 55 && crane.towerM <= 65, `tower=${crane.towerM}`);
      assert.ok(crane.jibM >= 40 && crane.jibM <= 50, `jib=${crane.jibM}`);
      assert.ok(!isWater(crane.x, crane.z), 'crane base not in water');
      assert.equal(crane.heightSource, 'estimate');
    }
    assert.ok(model.statistics.pitAreaM2 > 0);
    assert.ok(model.statistics.pitDepthM === 6);
    assert.ok(model.statistics.temporaryRoadLengthM > 0);
    assert.equal(model.statistics.colliders, model.colliders.length);
    assert.ok(model.parts.every(part => part.heightSource === 'estimate'));
    // 场地、围挡、塔吊、基坑和临时道路都不落进湖/水里。
    for (const collider of model.colliders) {
      const x = (collider.minX + collider.maxX) / 2;
      const z = (collider.minZ + collider.maxZ) / 2;
      assert.ok(!isWater(x, z), `collider in water: ${collider.name}`);
    }
    const first = {
      hoardingLengthM: model.statistics.hoardingLengthM,
      pitAreaM2: model.statistics.pitAreaM2,
      cranes: model.cranes.map(crane => [crane.x, crane.z, crane.towerM, crane.jibM])
    };
    model.dispose();
    assert.equal(scene.children.length, 0);

    const repeat = buildXiliConstruction(new THREE.Scene(), xiliSite, { groundHeight, isWater });
    assert.equal(repeat.statistics.hoardingLengthM, first.hoardingLengthM);
    assert.equal(repeat.statistics.pitAreaM2, first.pitAreaM2);
    assert.deepEqual(repeat.cranes.map(crane => [crane.x, crane.z, crane.towerM, crane.jibM]), first.cranes);
    repeat.dispose();
  });
