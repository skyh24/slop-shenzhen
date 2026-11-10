const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const parts = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { geo, buildings } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const sites = geo.sites['super-hq'];
const source = new Map(buildings.map(row => [row.id, row]));

const loadModel = (THREE = {}, tsl = {}, atmosphere = {}) => loadModule(read('sz-landmarks/super-hq.js'), {
  imports: { 'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': atmosphere,
    '../sz-terrain.js': terrain, '../building-collision.js': collision, './parts.js': parts }
});
const model = loadModel();
const built = model.build(source, geo.terrain, { sites });
const plan = model.twinTowerPlan(sites.site.polygons[0]);
const towerSource = name => `design/super-hq:c-tower-${name}`;
const bridgeSource = 'design/super-hq:skybridge';
const axesSource = 'estimate/super-hq:cross-axes';
const cmbSource = sites.cmbTower.osmId;
const exhibitionSource = sites.exhibitionHall.osmId;
const stationSource = sites.metroStation.osmId;
const gradeAt = p => terrain.terrainHeight(geo.terrain, p.x, p.z);
const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} differs from ${expected}`);

// 顶点到多边形的距离：内部为 0，外部取最近边距离。
function outsideDistance(polygon, x, z) {
  if (collision.polygonContains(polygon, x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.outer.length; i++) {
    const a = polygon.outer[i], b = polygon.outer[(i + 1) % polygon.outer.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length2 = dx * dx + dz * dz;
    const t = length2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
    best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
  }
  return best;
}

const polygonOf = role => sites[role].polygons[0];
const domains = new Map([
  [towerSource('east'), polygonOf('site')], [towerSource('west'), polygonOf('site')],
  [bridgeSource, polygonOf('site')], [axesSource, polygonOf('site')],
  [cmbSource, polygonOf('cmbTower')], [exhibitionSource, polygonOf('exhibitionHall')],
  [stationSource, polygonOf('metroStation')]
]);

test('super-hq publishes design values and lets the registry retire the generic look-alikes', () => {
  assert.deepEqual(Array.from(model.sourceIds), []);
  for (const id of ['way/1443942675', 'way/1443942676', 'way/1443942677', 'way/1443942678', 'way/1443942679',
    'relation/18564923']) assert.ok(model.optionalSkipIds.includes(id), id);
  assert.deepEqual(Array.from(model.siteRoles), ['site', 'cmbTower', 'exhibitionHall', 'metroStation']);
  assert.equal(model.designHeights.eastTowerM, 400);
  assert.equal(model.designHeights.westTowerM, 336);
  assert.equal(model.designHeights.skybridgeM, 119.15);
  assert.equal(model.designHeights.skybridgeSpanM, 78);
  assert.equal(model.designHeights.hangerM, 33);
  assert.equal(model.designHeights.cmbTowerM, 387);
  assert.ok(model.materials.length < 8);
  const card = model.modelCard();
  assert.equal(card.id, 'super-hq');
  assert.equal(card.osm.site, 'way/336349626');
  assert.equal(card.heightSources.cTower, 'design');
  assert.equal(card.heightSources.cmbTower, 'design');
  assert.ok(card.gaps.length >= 3);
});

test('the site frame finds the cross-axis centre and the long axis from the OSM polygon alone', () => {
  const frame = model.siteFrame(sites.site.polygons[0]);
  assert.ok(frame);
  close(frame.center.x, -8774.5, 3, 'site centroid x');
  close(frame.center.z, 2409.5, 3, 'site centroid z');
  close(frame.area, 153144, 1500, 'site area');
  close(frame.longSpan, 613, 8, 'site long span');
  close(frame.shortSpan, 266, 8, 'site short span');
  assert.ok(Math.abs(frame.longAxis.x) > 0.999, 'long axis points east');
  close(frame.longAxis.x * frame.shortAxis.x + frame.longAxis.z * frame.shortAxis.z, 0, 1e-6,
    'short axis is perpendicular');
  close(Math.hypot(frame.longAxis.x, frame.longAxis.z), 1, 1e-9, 'long axis is unit length');
  assert.equal(model.siteFrame(null), null);
  assert.equal(model.siteFrame({ outer: [{ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 0 }] }), null);
});

test('the twin-tower plan keeps the 78 m skybridge on the cross-axis centre with design heights', () => {
  assert.ok(plan);
  close(plan.east.height, 400, 1e-9, 'east tower design height');
  close(plan.west.height, 336, 1e-9, 'west tower design height');
  const centerToEast = Math.hypot(plan.east.center.x - plan.frame.center.x,
    plan.east.center.z - plan.frame.center.z);
  close(centerToEast, 70, 0.01, 'tower centres sit a plan semi-axis beyond the 39 m half span');
  close(Math.hypot(plan.east.center.x - plan.west.center.x, plan.east.center.z - plan.west.center.z), 140, 0.02,
    'twin tower centre distance');
  for (const point of [plan.bridge.from, plan.bridge.to]) {
    const offset = (point.x - plan.frame.center.x) * plan.frame.longAxis.x
      + (point.z - plan.frame.center.z) * plan.frame.longAxis.z;
    close(Math.abs(offset), 39, 0.02, 'bridge face offset from the crossing');
  }
  close(plan.east.center.x - plan.frame.center.x, 70, 0.05, 'east tower is on the east side');
  assert.ok(plan.east.center.x > plan.frame.center.x);
  // 塔面正好落在连廊两端：净跨 78 m。
  close(plan.offset - 31, 39, 0.01, 'tower face at bridge level');
});

test('missing site data returns an empty model instead of throwing or fabricating a tower', () => {
  assert.deepEqual(Array.from(model.build(source, geo.terrain)), []);
  assert.deepEqual(Array.from(model.build(source, geo.terrain, {})), []);
  assert.deepEqual(Array.from(model.build(source, geo.terrain, { sites: {} })), []);
  assert.deepEqual(Array.from(model.build(source, geo.terrain, { sites: { site: { polygons: [] } } })), []);
  assert.deepEqual(Array.from(model.build(source, null, { sites })), []);
  // 其余角色缺失时仍能建 C 塔和双轴，不伪造招银/展馆/车站。
  const partial = model.build(source, geo.terrain, { sites: { site: sites.site } });
  assert.ok(partial.length > 40);
  assert.ok(partial.every(part => part.sourceId !== cmbSource && part.sourceId !== exhibitionSource
    && part.sourceId !== stationSource));
});

test('the model stays inside the landmark budgets and every part drives display and collision alike', () => {
  assert.ok(built.length > 120 && built.length < 400, `part count ${built.length}`);
  const ids = new Set(built.map(part => part.id));
  assert.equal(ids.size, built.length, 'part ids are unique');
  assert.ok(new Set(built.map(part => part.style)).size < 8);
  assert.ok(built.every(part => model.materials.includes(part.style)), 'every style has a material factory');
  assert.ok(built.every(part => part.heightSource === 'design' || part.heightSource === 'estimate'));
  assert.ok(built.every(part => part.layoutSource === 'derived' && typeof part.baseSource === 'string'));
  assert.ok(built.every(part => part.minY < part.maxY && part.polygon.outer.length >= 3));
  assert.ok(built.every(part => [part.minX, part.maxX, part.minZ, part.maxZ, part.minY, part.maxY]
    .every(Number.isFinite)));
  for (const part of built) {
    const collider = parts.partCollider(part);
    assert.equal(collider.minY, part.minY, part.id);
    assert.equal(collider.maxY, part.maxY, part.id);
    assert.equal(collider.heightSource, part.heightSource, part.id);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(model.build(source, geo.terrain, { sites }))),
    JSON.parse(JSON.stringify(built)), 'build is deterministic');
});

test('C tower crowns reach the 400/336 m design heights on the site terrain', () => {
  for (const [name, height] of [['east', 400], ['west', 336]]) {
    const rows = built.filter(part => part.sourceId === towerSource(name));
    assert.ok(rows.length >= 10, `${name} tower section count`);
    assert.equal(rows.filter(part => part.heightSource === 'design').length, 1);
    const tower = name === 'east' ? plan.east : plan.west;
    const ground = gradeAt(tower.center);
    const top = Math.max(...rows.map(part => part.maxY));
    close(top - ground, height, 2, `${name} tower height above DEM anchor`);
    const crown = rows.find(part => part.maxY === top);
    assert.equal(crown.heightSource, 'design');
    assert.equal(crown.style, 'superHqMetal');
    // 裙摆落在最低地面：塔基不悬空。
    close(Math.min(...rows.map(part => part.minY)), Math.min(ground, top - height), 2, `${name} tower base`);
    // 塔身收分：最顶段截面积明显小于塔基。
    const ringWidth = part => Math.max(...part.polygon.outer.map(p => p.x))
      - Math.min(...part.polygon.outer.map(p => p.x));
    const base = rows.reduce((wide, part) => wide === null || part.minY < wide.minY ? part : wide, null);
    assert.ok(ringWidth(crown) < ringWidth(base) * 0.6, `${name} tower tapers`);
  }
});

test('the skybridge sits at 119.15 m with a 78 m clear span and a 33 m hanging triangle', () => {
  const bridge = built.filter(part => part.sourceId === bridgeSource);
  assert.ok(bridge.length >= 13);
  const ground = gradeAt(plan.frame.center);
  const chord = bridge.find(part => part.id.endsWith(':lower-chord'));
  assert.equal(chord.heightSource, 'design');
  close(chord.minY, ground + 119.15, 0.02, 'skybridge lower chord elevation');
  close(chord.maxY - chord.minY, 1.55, 0.01, 'lower chord depth');
  // 下弦梁横跨双塔塔面：净跨取 78 m，梁端各嵌入塔体 1.5 m。
  const project = p => (p.x - plan.frame.center.x) * plan.frame.longAxis.x
    + (p.z - plan.frame.center.z) * plan.frame.longAxis.z;
  const stations = chord.polygon.outer.map(project);
  close(Math.max(...stations) - Math.min(...stations), 78 + 3, 0.05, 'skybridge structural span');
  close(Math.max(...bridge.map(part => part.maxY)), ground + 119.15 + 9.3, 0.05, 'skybridge roof');
  close(Math.min(...bridge.map(part => part.minY)), ground + 119.15 - 33, 0.05, 'hanger bottom');
  assert.equal(bridge.find(part => part.id.includes(':hanger-vane:')).heightSource, 'design');
  // 桥下净空：中央绿轴从连廊正下方穿过。
  const clearance = chord.minY - gradeAt(plan.frame.center);
  assert.ok(clearance > 100);
});

test('the CMB tower reaches 387 m on its OSM footprint with a stepped crystal crown', () => {
  const cmb = built.filter(part => part.sourceId === cmbSource);
  assert.ok(cmb.length >= 7);
  const base = Math.min(...cmb.map(part => part.minY));
  close(Math.max(...cmb.map(part => part.maxY)) - base, 387, 0.01, 'CMB design height');
  const cap = cmb.find(part => part.id.includes(':crown-cap:'));
  assert.equal(cap.heightSource, 'design');
  assert.ok(cmb.some(part => part.id.includes(':shaft:')));
  assert.ok(cmb.some(part => part.id.endsWith(':entrance-canopy')));
  const cmbPolygon = sites.cmbTower.polygons[0];
  for (const part of cmb) {
    for (const vertex of part.polygon.outer) {
      assert.ok(outsideDistance(cmbPolygon, vertex.x, vertex.z) <= 10, `${part.id} stays on the OSM footprint`);
    }
  }
});

test('every part stays on its own sourced polygon and no part intrudes into mapped water', () => {
  const bounds = built.reduce((box, part) => ({
    minX: Math.min(box.minX, part.minX), maxX: Math.max(box.maxX, part.maxX),
    minZ: Math.min(box.minZ, part.minZ), maxZ: Math.max(box.maxZ, part.maxZ)
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const nearWater = geo.water.filter(polygon => polygon.outer.some(point =>
    point.x >= bounds.minX - 50 && point.x <= bounds.maxX + 50
    && point.z >= bounds.minZ - 50 && point.z <= bounds.maxZ + 50));
  for (const part of built) {
    const domain = domains.get(part.sourceId);
    assert.ok(domain, `unmapped source ${part.sourceId}`);
    const vertices = [...part.polygon.outer, ...(part.loft ? [...part.loft.lower, ...part.loft.upper] : [])];
    for (const vertex of vertices) {
      const distance = outsideDistance(domain, vertex.x, vertex.z);
      assert.ok(distance <= 10, `${part.id} is ${distance.toFixed(2)} m outside ${part.sourceId}`);
      for (const water of nearWater) {
        assert.equal(collision.polygonContains(water, vertex.x, vertex.z), false, `${part.id} intrudes into mapped water`);
      }
    }
  }
});

test('the cross axes hug the terrain and only pave the site', () => {
  const axes = built.filter(part => part.sourceId === axesSource);
  assert.ok(axes.length > 80 && axes.length < 260, `axis part count ${axes.length}`);
  let pavingPlatforms = 0;
  for (const part of axes) {
    assert.ok(Array.isArray(part.top) && Array.isArray(part.bottom), `${part.id} is a terrain-following panel`);
    for (const [index, vertex] of part.polygon.outer.entries()) {
      const ground = terrainHeightAt(vertex);
      assert.ok(Math.abs(part.top[index] - ground) <= 0.3, `${part.id} top hugs terrain`);
      assert.ok(part.bottom[index] < part.top[index]);
    }
    if (part.style === 'superHqPaving') {
      pavingPlatforms++;
      assert.ok(part.roofContact, `${part.id} is a walkable surface`);
    } else {
      assert.equal(part.roofContact, false, `${part.id} green band and drain seam are not walkable surfaces`);
    }
  }
  assert.ok(pavingPlatforms >= 40);
  assert.ok(axes.some(part => part.style === 'superHqGreen'), 'green axis has planting bands');
  assert.ok(axes.some(part => part.id.includes(':seam-')), 'axis has drainage seams');
});

function terrainHeightAt(vertex) {
  const height = terrain.terrainHeight(geo.terrain, vertex.x, vertex.z);
  assert.ok(Number.isFinite(height), `terrain missing at ${vertex.x},${vertex.z}`);
  return height;
}

test('the exhibition hall is a low two-storey pavilion on its parcel', () => {
  const hall = built.filter(part => part.sourceId === exhibitionSource);
  assert.ok(hall.length >= 5);
  const base = Math.min(...hall.map(part => part.minY));
  const top = Math.max(...hall.map(part => part.maxY));
  assert.ok(top - base > 15 && top - base < 26, `exhibition height ${top - base}`);
  assert.ok(hall.every(part => part.heightSource === 'estimate'));
  assert.ok(hall.some(part => part.id.includes(':lantern:')));
  const parcel = sites.exhibitionHall.polygons[0];
  for (const part of hall) {
    for (const vertex of part.polygon.outer) {
      assert.ok(outsideDistance(parcel, vertex.x, vertex.z) <= 10, `${part.id} stays on the parcel`);
    }
  }
});

test('the underground station gets 2-4 surface entrances with canopies and a sign band', () => {
  const station = built.filter(part => part.sourceId === stationSource);
  const entrances = [...new Set(station.filter(part => /^.*:entrance:\d+:/.test(part.id))
    .map(part => part.id.split(':entrance:')[1].split(':')[0]))];
  assert.ok(entrances.length >= 2 && entrances.length <= 4, `entrance count ${entrances.length}`);
  for (const index of entrances) {
    const cabin = station.find(part => part.id === `${stationSource}:entrance:${index}:cabin:0`);
    const sign = station.find(part => part.id === `${stationSource}:entrance:${index}:sign:0`);
    assert.ok(cabin && sign);
    const center = cabin.polygon.outer.reduce((sum, p) => ({ x: sum.x + p.x / 4, z: sum.z + p.z / 4 }),
      { x: 0, z: 0 });
    const ground = gradeAt(center);
    assert.ok(cabin.maxY - ground > 3.5 && cabin.maxY - ground < 6, 'entrance pavilion height');
    close(sign.maxY, cabin.maxY + 0.4, 0.35, 'sign band hangs on the canopy fascia');
    assert.equal(sign.style, 'superHqSign');
    assert.ok(outsideDistance(sites.metroStation.polygons[0], center.x, center.z) < 10);
  }
});

const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;

test('real Three draws the same parts the collision uses, within the triangle and material budgets',
  { skip: !threePackageDir }, async () => {
    const packageUrl = pathToFileURL(join(threePackageDir, '/'));
    const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
    const tsl = await import(new URL('build/three.tsl.js', packageUrl));
    const atmosphere = { sceneUniforms: { night: tsl.uniform(0) } };
    const realModel = loadModel(THREE, tsl, atmosphere);
    const renderSource = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
    const { renderLandmark } = loadModule(read('sz-landmarks/render.js'), {
      imports: { 'three/webgpu': THREE, '../sz-geometry.js': renderSource }
    });
    const realParts = realModel.build(source, geo.terrain, { sites });
    const materialCache = new Map();
    const materialFor = name => {
      if (!materialCache.has(name)) materialCache.set(name, realModel.createSuperHqMaterial(name));
      return materialCache.get(name);
    };
    const { group, surfaces } = renderLandmark({ id: 'super-hq', parts: realParts }, materialFor);
    group.updateMatrixWorld(true);
    try {
      assert.equal(materialCache.size, new Set(realParts.map(part => part.style)).size);
      assert.ok(materialCache.size < 8);
      assert.equal(group.children.length, materialCache.size);
      let triangles = 0;
      for (const mesh of group.children) {
        assert.ok(mesh.geometry.index, `${mesh.name} is indexed`);
        triangles += mesh.geometry.index.count / 3;
        assert.ok(mesh.geometry.attributes.position.count > 0);
      }
      assert.ok(triangles < 200000, `triangle count ${triangles}`);
      assert.ok(triangles > 1000);
      // 可行走面只来自 roofContact 部件，且高程来源已解析。
      const walkable = realParts.filter(part => part.roofContact);
      assert.equal(surfaces.length, walkable.length);
      assert.ok(surfaces.every(surface => ['design', 'estimate'].includes(surface.heightSource)
        && surface.triangles.length > 0));
      const surfaceIds = new Set(surfaces.map(surface => surface.id));
      for (const part of walkable) assert.ok(surfaceIds.has(part.id), `${part.id} has a contact surface`);
      // 显示几何与部件高程一致：塔顶、连廊顶面由射线命中同一高度。
      const ray = new THREE.Raycaster();
      const hitHeight = (x, z) => {
        ray.set(new THREE.Vector3(x, 520, z), new THREE.Vector3(0, -1, 0));
        const [hit] = ray.intersectObjects(group.children);
        return hit?.point.y ?? null;
      };
      for (const name of ['east', 'west']) {
        const tower = name === 'east' ? plan.east : plan.west;
        const top = Math.max(...realParts.filter(part => part.sourceId === towerSource(name)).map(part => part.maxY));
        close(hitHeight(tower.center.x, tower.center.z), top, 0.6, `${name} tower roof matches its part top`);
      }
      const bridgeTop = Math.max(...realParts.filter(part => part.sourceId === bridgeSource).map(part => part.maxY));
      close(hitHeight(plan.frame.center.x, plan.frame.center.z), bridgeTop, 0.6, 'skybridge roof matches its part top');
      // 材质工厂覆盖全部样式且拒绝未知名字。
      for (const name of realModel.materials) {
        const material = realModel.createSuperHqMaterial(name);
        assert.ok(material && typeof material.dispose === 'function');
        material.dispose();
      }
      assert.throws(() => realModel.createSuperHqMaterial('superHqUnknown'), /Unknown Super HQ material/);
    } finally {
      for (const mesh of group.children) mesh.geometry.dispose();
      for (const material of materialCache.values()) material.dispose();
    }
  });
