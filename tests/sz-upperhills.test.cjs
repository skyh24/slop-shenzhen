const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const collision = loadModule(read('building-collision.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const parts = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const sources = new Map(buildings.map(b => [b.id, b]));
const loadUpperhills = (THREE, tsl, materials) => loadModule(read('sz-landmarks/upperhills.js'), { imports: {
  'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': materials, '../sz-terrain.js': terrain,
  '../building-collision.js': collision, './parts.js': parts
} });

test('UpperHills binds only the verified source footprints and keeps an incomplete snapshot eligible for fallback', () => {
  const model = loadUpperhills({}, {}, {});
  const manifest = JSON.parse(readFileSync(join(__dirname, '../data/source/landmarks.json')));
  const { osm } = manifest.landmarks.find(landmark => landmark.id === 'upperhills');
  assert.ok([osm.tower1, osm.tower2, osm.mall].every(id => model.sourceIds.includes(id)));
  assert.equal(model.sourceIds.includes(osm.site), false);
  assert.equal(model.sourceIds.includes('way/1431501352'), false);
  assert.equal(new Set(model.sourceIds).size, model.sourceIds.length);
  assert.ok(model.sourceIds.every(id => sources.has(id)));
  const incomplete = new Map(sources);
  incomplete.delete(osm.tower2);
  assert.equal(model.build(incomplete, geo.terrain).length, 0);
});

const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;
const contains = (part, x, z) => collision.polygonContains(part.polygon, x, z);
const average = (rows, name) => rows.reduce((sum, p) => sum + p[name], 0) / rows.length;
const closes = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} does not match ${expected}`);

test('UpperHills geometry renders its sourced towers and separated public levels', { skip: !threePackageDir }, async t => {
  const packageUrl = pathToFileURL(join(threePackageDir, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const atmosphere = { sceneUniforms: { night: tsl.uniform(0) } };
  const upperhills = loadUpperhills(THREE, tsl, atmosphere);
  const { createLandmarkMaterial } = loadModule(read('sz-landmarks/materials.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': atmosphere,
    './shenzhen-bay-culture-square.js': {}, './upperhills.js': upperhills
  } });
  const { build } = upperhills;
  const model = build(sources, geo.terrain);
  const ground = (x, z) => terrain.terrainHeight(geo.terrain, x, z);
  const named = stem => model.filter(p => p.id.startsWith(`upperhills:${stem}`));
  const [plaza] = named('town-deck');

  await t.test('the 388.1 m and 299.3 m towers keep distinct sections and open crown rims', () => {
    for (const [id, height, label] of [['way/684494961', 388.1, 't1'], ['way/684494959', 299.3, 't2']]) {
      const source = sources.get(id);
      const tower = named(`${label}:`);
      const base = ground(source.cx, source.cz);
      closes(Math.min(...tower.map(p => p.minY)), base);
      closes(Math.max(...tower.map(p => p.maxY)) - base, height);
      assert.ok(tower.every(p => p.sourceId === id && p.sourceHeight === height));
      const [rim] = named(`${label}:open-crown-rim`);
      assert.equal(rim.polygon.holes.length, 1);
      assert.equal(contains(rim, source.cx, source.cz), false);
      const [lobby] = named(`${label}:recessed-lobby`);
      const [curtain] = named(`${label}:curtain:`);
      assert.ok(lobby.maxX < curtain.maxX - 1);
      assert.ok(named(`${label}:louvre:`).length > 10);
      assert.ok(named(`${label}:raised-crown:`).every(p => p.heightSource === source.heightSource));
    }
    assert.equal(named('t1:curtain-recess:').length, 4);
    assert.equal(named('t2:curtain-recess:').length, 3);
    const [recess] = named('t1:curtain-recess:140.5:');
    const [backing] = named('t1:louvre-backing:140.5:3:');
    const x = average(backing.polygon.outer, 'x') + 0.36;
    const z = average(backing.polygon.outer, 'z');
    assert.equal(contains(recess, x, z), false);
    assert.ok(named('t1:curtain:').every(p => contains(p, x, z)));
  });

  await t.test('the loft alleys and southern gallery retain the spaces under their upper bodies', () => {
    const blocks = named('loft:');
    assert.equal(new Set(blocks.map(p => p.sourceId)).size, 34);
    assert.equal(new Set(blocks.filter(p => p.style.startsWith('upperhillsLoft')).map(p => p.style)).size, 4);
    assert.ok(blocks.every(p => p.heightSource === 'estimate' && p.minY >= plaza.maxY));
    const [link] = named('loft-link:0:').filter(p => p.roofContact);
    const x = average(link.roofPanel.outer, 'x'), z = average(link.roofPanel.outer, 'z');
    assert.ok(contains(plaza, x, z));
    assert.ok(blocks.every(p => !contains(p, x, z)));
    assert.equal(collision.roofPanelContactPolygon(link.roofPanel, plaza.maxY + 0.4, plaza.maxY + 2.3), null);
    const opening = named('south-loft-wing:').filter(p => contains(p, 1016, -1385));
    assert.ok(opening.length > 0 && opening.every(p => p.minY > plaza.maxY + 6));
    const northRoof = named('north-loft-wing:').flatMap(p => p.roofPanel.top);
    assert.ok(Math.max(...northRoof) - Math.min(...northRoof) > 15);
    const [northSkirt] = named('north-retail-base');
    assert.ok(northSkirt.minY < ground(1074, -1544.49));
    assert.ok(plaza.minY < ground(1229, -1442));
    const [eastLanding] = named('east-bridge-landing');
    closes(eastLanding.maxY, plaza.maxY);
    closes(eastLanding.maxY - eastLanding.minY, 0.88);
    assert.ok(contains(eastLanding, 1255, -1500) && !contains(plaza, 1255, -1500));
  });

  const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  const { renderLandmark } = loadModule(read('sz-landmarks/render.js'), { imports: {
    'three/webgpu': THREE, '../sz-geometry.js': geometry
  } });
  const { createSurfaceResolver } = loadModule(read('sz-controller-surfaces.js'));
  const materials = new Map();
  const rendered = renderLandmark({ id: 'upperhills', parts: model }, name => {
    if (!materials.has(name)) materials.set(name, createLandmarkMaterial(name));
    return materials.get(name);
  });
  const support = createSurfaceResolver({ groundHeight: ground, surfaces: rendered.surfaces });
  t.after(() => {
    for (const mesh of rendered.group.children) mesh.geometry.dispose();
    for (const material of materials.values()) material.dispose();
  });

  await t.test('the three southern flights meet the plaza through the rendered stairs and landings', () => {
    const stairs = named('south-stair:');
    const landings = named('south-landing:');
    assert.equal(stairs.length, 96);
    assert.equal(landings.length, 2);
    assert.deepEqual([...new Set(stairs.flatMap(p => p.routeSourceIds))], ['way/1393822065', 'way/1393822071', 'way/1393822072']);
    assert.ok(stairs.slice(1).every((p, i) => p.maxY > stairs[i].maxY && p.maxY - stairs[i].maxY < 0.2));
    assert.equal(stairs.at(-1).maxY, plaza.maxY);
    assert.ok(stairs.every(p => p.polygon.outer.every(v => p.minY <= ground(v.x, v.z))));
    const points = [[1127.61, -1382.38], [1128.9, -1390.06], [1130.19, -1397.55], [1131.3, -1404.8],
      [1132.51, -1412.15], [1132.48, -1417.6]];
    const levels = points.map(([x, z]) => support.below(x, z, 50));
    assert.ok(levels.slice(1).every((row, i) => row.height > levels[i].height));
    assert.equal(levels.at(-1).surfaceId, plaza.id);
  });

  await t.test('the pedestrian controller walks both directions between Sungang West Road and the town deck', () => {
    const { createGroundSurfaceSampler } = loadModule(read('sz-ground-surface.js'));
    const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);
    const { ThirdPersonControllerManager } = loadModule(read('controllers.js'), { imports: {
      'three/webgpu': THREE, './sz-city-config.js': { ISLAND_BOUNDS: { minX: 1100, maxX: 1150, minZ: -1440, maxZ: -1330 } },
      './sz-controller-surfaces.js': { createSurfaceResolver }, './sz-park-arrivals.js': {}, './sz-strings.js': {},
      './city-lighting-materials.js': {}, './sz-vehicles.js': { VEHICLE_SPECS: { taxi: { wheelbase: 2.8 } } },
      './pedestrians.js': {}, './vehicle-lights.js': {}, './building-collision.js': collision
    } });
    const retained = buildings.filter(b => !upperhills.sourceIds.includes(b.id)
      && b.minX < 1150 && b.maxX > 1100 && b.minZ < -1330 && b.maxZ > -1430);
    const controller = Object.create(ThirdPersonControllerManager.prototype);
    const start = [1125.492545, -1353.810023];
    const height = groundHeight(...start);
    const person = { type: 'person', position: new THREE.Vector3(start[0], height, start[1]), heading: 3.034,
      speed: 0, verticalVel: 0, jumping: false, jumpPrep: 0, _safePosition: { x: start[0], y: height, z: start[1] },
      _support: { height, surfaceId: 'terrain' } };
    Object.assign(controller, { activeMode: 'person', entities: { person }, keys: {},
      surfaceResolver: createSurfaceResolver({ groundHeight, surfaces: rendered.surfaces }),
      colliders: [...model.map(parts.partCollider), ...retained.flatMap(b => placement.buildingPlacement(b, geo.terrain).colliders)] });
    function walkTo([x, z]) {
      for (let frame = 0; frame < 1500; frame++) {
        const dx = x - person.position.x, dz = z - person.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.12) return;
        const yaw = Math.atan2(dx, dz) - person.heading;
        const difference = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        const turn = Math.max(-1, Math.min(1, difference * 60 / 2.6));
        Object.assign(controller.keys, { left: Math.max(0, turn), right: Math.max(0, -turn),
          forward: Math.abs(difference) < 0.24 ? Math.min(0.28, distance * 0.35) : 0 });
        const previousY = person.position.y;
        controller.updatePerson(1 / 60);
        assert.ok(person.position.y - previousY <= 0.38 + 1e-5);
      }
      assert.fail(`The pedestrian could not reach ${x}, ${z}`);
    }
    const route = [[1127.72, -1374.5], [1127.53, -1387.81], [1130.31, -1392.32], [1130.07, -1402.78],
      [1132.54, -1406.82], [1132.48, -1417.49], [1133.5, -1420.5], [1134.58, -1425.89]];
    for (const point of route) walkTo(point);
    assert.equal(person._support.surfaceId, plaza.id);
    assert.equal(person.position.y, plaza.maxY);
    for (const point of [...route.slice(0, -1).reverse(), start]) walkTo(point);
    assert.equal(person._support.surfaceId, 'terrain');

    // 浏览器实录的第二梯西侧落脚点。直走到圆体真边缘后，沿梯口中线转向。
    const westEdge = { x: 1129.4843828678847, y: 16.991920471191406, z: -1391.9298288766872 };
    person.position.set(westEdge.x, westEdge.y, westEdge.z);
    Object.assign(person, { heading: -9.411469, speed: 0, verticalVel: 0, jumping: false, jumpPrep: 0,
      _safePosition: { ...westEdge }, _support: { height: westEdge.y, surfaceId: 'upperhills:south-stair:1:0' } });
    Object.assign(controller.keys, { left: 0, right: 0, forward: 1 });
    for (let frame = 0; frame < 360; frame++) controller.updatePerson(1 / 60);
    const advance = westEdge.z - person.position.z;
    assert.ok(advance > 0.4 && advance < 0.55, `The circular footprint advanced ${advance} m at the landing`);
    assert.equal(person.speed, 0);
    assert.equal(person._support.surfaceId, 'upperhills:south-stair:1:1');
    closes(person.position.y - westEdge.y, 0.175);
    for (const point of route.slice(2)) walkTo(point);
    assert.equal(person._support.surfaceId, plaza.id);
    assert.equal(person.position.y, plaza.maxY);
  });

  await t.test('the park bridge triangles share rendered vertices and leave the road crossing below', () => {
    const parkBridges = [
      ['west', 838, -1422.6, ['way/775816318', 'way/775816329']],
      ['east', 1363, -1512.92, ['way/709520555']]
    ];
    const mesh = rendered.group.children.find(m => m.name === 'upperhillsPaving');
    const vertices = new Set();
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) vertices.add(`${p.getX(i)}:${p.getY(i)}:${p.getZ(i)}`);
    for (const [bridge, x, z, ids] of parkBridges) {
      const decks = named(`park-bridge:${bridge}:`).filter(p => p.roofContact);
      assert.ok(decks.length >= 16 && decks.every(p => JSON.stringify(p.routeSourceIds) === JSON.stringify(ids)));
      const surface = support.below(x, z, 50);
      const deck = decks.find(p => p.id === surface.surfaceId);
      assert.ok(deck);
      const road = ground(x, z);
      assert.ok(surface.height - road > 5.4);
      assert.equal(collision.roofPanelContactPolygon(parts.partCollider(deck).roofPanel, road, road + 4.2), null);
      const triangles = rendered.surfaces.find(row => row.id === surface.surfaceId).triangles;
      assert.ok(triangles.flat().every(p => vertices.has(`${p.x}:${p.y}:${p.z}`)));
    }
  });
});
