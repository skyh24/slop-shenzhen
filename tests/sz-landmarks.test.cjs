const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const readLandmark = file => read(`sz-landmarks/${file}`);
const collision = loadModule(read('building-collision.js'));
const terrain = loadModule(read('sz-terrain.js'));
const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const parts = loadModule(readLandmark('parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': layout
} });
const tencent = loadModule(readLandmark('tencent-binhai.js'), { imports: { './parts.js': parts } });
const dji = loadModule(readLandmark('dji-sky-city.js'), { imports: { '../building-collision.js': collision, './parts.js': parts } });
const pingAn = loadModule(readLandmark('ping-an.js'), { imports: { './parts.js': parts } });
const chunsun = loadModule(readLandmark('chunsun.js'), { imports: { './parts.js': parts } });
const civic = loadModule(readLandmark('civic-center.js'), { imports: {
  '../building-collision.js': collision, './parts.js': parts
} });
const stadium = loadModule(readLandmark('chunjian.js'), { imports: {
  '../building-collision.js': collision, './parts.js': parts
} });
const convention = loadModule(readLandmark('convention-center.js'), { imports: { '../sz-terrain.js': terrain, './parts.js': parts } });
const loadCulture = THREE => loadModule(readLandmark('shenzhen-bay-culture-square.js'), { imports: {
  'three/webgpu': THREE, '../building-collision.js': collision, '../sz-terrain.js': terrain, './parts.js': parts
} });
const culture = loadCulture({});
const loadPlan = cultureModule => loadModule(readLandmark('layout.js'), { imports: {
  './tencent-binhai.js': tencent, './dji-sky-city.js': dji, './ping-an.js': pingAn, './chunsun.js': chunsun,
  './civic-center.js': civic, './chunjian.js': stadium, './shenzhen-bay-culture-square.js': cultureModule,
  './convention-center.js': convention
} });
const { planSzLandmarks } = loadPlan(culture);
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const fixture = buildings.filter(building => !culture.sourceIds.includes(building.id));
const plan = planSzLandmarks(fixture, geo.terrain);
const byId = new Map(buildings.map(building => [building.id, building]));
const byLandmark = new Map(plan.plans.map(landmark => [landmark.id, landmark.parts]));

test('landmarks retire only the explicit source objects and keep the fallback on incomplete snapshots', () => {
  const verifiedDuplicates = civic.optionalSkipIds.filter(id => byId.has(id));
  assert.deepEqual([...plan.skipIds].sort(), [...tencent.sourceIds, ...dji.sourceIds, ...pingAn.sourceIds, ...chunsun.sourceIds,
    ...civic.sourceIds, ...verifiedDuplicates, ...stadium.sourceIds, ...convention.sourceIds].sort());
  assert.ok(byLandmark.has('civic-center'));
  assert.ok(byLandmark.has('chunjian'));
  assert.ok(byLandmark.has('convention-center'));
  assert.equal(plan.skipIds.has('globfp/3517'), false);
  assert.equal(plan.skipIds.has('globfp/47955'), false);
  const partial = planSzLandmarks(fixture.filter(building => building.id !== 'way/694152193'), geo.terrain);
  assert.equal(partial.skipIds.has('way/694152192'), false);
  assert.equal(partial.skipIds.has('way/1110959408'), true);
  const missingSpire = planSzLandmarks(fixture.filter(building => building.id !== 'way/1472466096'), geo.terrain);
  assert.ok(pingAn.sourceIds.every(id => !missingSpire.skipIds.has(id)));
  assert.equal(plan.skipIds.has('way/775171565'), false);
  assert.equal(plan.skipIds.has('way/1253254379'), false);
  assert.equal(plan.skipIds.has('way/529272469'), false);
  assert.equal(plan.skipIds.has('way/1441599159'), false);
});

test('Tencent preserves both tower heights and source intervals for all three links', () => {
  const actual = byLandmark.get('tencent-binhai');
  for (const [id, relativeBottom, relativeTop] of [
    ['way/694152192', 0, 245.8], ['way/694152193', 0, 194.8],
    ['way/775462996', 0, 14], ['way/601101655', 14, 35],
    ['way/775462995', 95.8, 121.8], ['way/775462997', 152.8, 175.8]
  ]) {
    const part = actual.find(row => row.sourceId === id);
    assert.equal(part.polygon, byId.get(id).polygons[0]);
    assert.equal(part.sourceHeight, relativeTop);
    assert.ok(Math.abs(part.maxY - part.minY - (relativeTop - relativeBottom)) < 0.001);
  }
  const upper = actual.find(row => row.sourceId === 'way/601101655');
  const lower = actual.find(row => row.sourceId === 'way/775462996');
  assert.equal(upper.minY, lower.maxY);
  const between = { x: -12766, z: 2267, y: 70 };
  assert.ok(actual.every(part => between.y < part.minY || between.y > part.maxY
    || !collision.polygonContains(part.polygon, between.x, between.z)));
});

test('DJI retains source core heights and splits each wing into two lifted solids', () => {
  const actual = byLandmark.get('dji-sky-city');
  for (const [id, height] of [['way/1110477862', 211.6], ['way/1110477866', 193.1]]) {
    const part = actual.find(row => row.sourceId === id);
    assert.equal(part.sourceHeight, height);
    assert.equal(part.polygon, byId.get(id).polygons[0]);
    assert.ok(Math.abs(part.maxY - part.minY - height) < 0.001);
  }
  const wings = actual.filter(row => row.style === 'djiWing');
  assert.equal(wings.length, 12);
  for (const id of new Set(wings.map(wing => wing.sourceId))) {
    const [lower, upper] = wings.filter(wing => wing.sourceId === id);
    const source = byId.get(id);
    assert.equal(lower.polygon, source.polygons[0]);
    assert.equal(upper.polygon, source.polygons[0]);
    assert.equal(upper.sourceHeight, source.height);
    assert.ok(lower.minY >= source.minHeight && lower.maxY + 4 < upper.minY);
    assert.equal(upper.layoutSource, 'derived');
  }
  assert.ok(actual.some(part => part.style === 'djiBrace'));
});

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
test('DJI bridge alignment, tapered deck and open span agree with the source and engineering section', () => {
  const actual = byLandmark.get('dji-sky-city');
  const deck = actual.filter(row => row.style === 'djiDeck');
  assert.equal(deck.length, 22);
  const start = midpoint(deck[0].polygon.outer[0], deck[0].polygon.outer[3]);
  const end = midpoint(deck.at(-1).polygon.outer[1], deck.at(-1).polygon.outer[2]);
  const center = midpoint(start, end);
  assert.ok(Math.abs(Math.hypot(end.x - start.x, end.z - start.z) - 89.75) < 1e-8);
  for (const [p, id] of [[start, 'way/1151596329'], [end, 'way/1151596328'], [center, 'way/1110959408']]) {
    assert.ok(collision.polygonContains(byId.get(id).polygons[0], p.x, p.z));
  }
  const getWidth = (part, i, j) => Math.hypot(part.polygon.outer[i].x - part.polygon.outer[j].x,
    part.polygon.outer[i].z - part.polygon.outer[j].z);
  assert.ok(Math.abs(getWidth(deck[0], 0, 3) - 4.024) < 1e-8);
  assert.ok(Math.abs(getWidth(deck[10], 1, 2) - 2.126) < 1e-8);
  assert.ok(Math.abs(deck[10].top[1] - deck[0].top[0] - 2.7) < 1e-8);
  assert.ok(actual.every(part => !collision.polygonContains(part.polygon, center.x, center.z)
    || part.minY > deck[10].top[1] - 8));
});

test('sloped contact clips the prism to its visible section at the player height', () => {
  const source = byId.get('way/1110959408');
  const part = parts.spanPart('sloped-test', source, { x: 0, y: 10, z: 0 }, { x: 10, y: 20, z: 0 }, 3, 3, 1, 'djiDeck');
  const collider = parts.partCollider(part);
  assert.equal(collision.spanContactPolygon(collider.polygon, collider.verticalSpan, 0, 5), null);
  const slice = collision.spanContactPolygon(collider.polygon, collider.verticalSpan, 13.5, 14.5);
  assert.ok(collision.polygonContains(slice, 4.2, 0));
  assert.ok(!collision.polygonContains(slice, 1, 0));
  assert.ok(!collision.polygonContains(slice, 8, 0));
});

test('roof panel clips two slopes and leaves the air below the visible surface open', () => {
  const source = byId.get('way/1110959408');
  const panel = parts.roofPanelPart('pitched-roof', source,
    [{ x: 0, y: 10, z: 0 }, { x: 10, y: 20, z: 0 }, { x: 0, y: 30, z: 10 }], 1, 'djiDeck');
  const { roofPanel } = parts.partCollider(panel);
  assert.equal(collision.roofPanelContactPolygon(roofPanel, 0, 9), null);
  assert.equal(collision.roofPanelContactPolygon(roofPanel, 30, 40), null);
  const slice = collision.roofPanelContactPolygon(roofPanel, 15, 16);
  assert.ok(collision.polygonContains(slice, 2, 2));
  assert.ok(!collision.polygonContains(slice, 8, 0));
  assert.ok(!collision.polygonContains(slice, 2, 1));
  const variable = parts.roofPanelPart('thickened-roof', source,
    [{ x: 0, y: 10, z: 0 }, { x: 0, y: 30, z: 10 }, { x: 10, y: 20, z: 0 }], [1, 4, 3], 'djiDeck');
  assert.deepEqual(Array.from(variable.roofPanel.top, (y, i) => y - variable.roofPanel.bottom[i]), [3, 4, 1]);
});

function occupies(part, x, z, bottom, top) {
  if (bottom >= part.maxY || top <= part.minY) return false;
  const collider = parts.partCollider(part);
  const polygon = collider.loft ? collision.loftContactPolygon(collider.loft, bottom, top)
    : collider.verticalSpan ? collision.spanContactPolygon(collider.polygon, collider.verticalSpan, bottom, top) : collider.polygon;
  return polygon !== null && collision.polygonContains(polygon, x, z);
}

test('Ping An retains the mapped tower axis, double corner columns and open diamond crown', () => {
  const actual = byLandmark.get('ping-an');
  const tower = byId.get(pingAn.sourceIds[0]);
  const tip = byId.get('way/1472466096');
  const base = terrain.terrainHeight(geo.terrain, tower.cx, tower.cz);
  const crown = actual.find(row => row.id.endsWith(':diamond-crown'));
  assert.equal(crown.maxY, Math.fround(base + 599.1));
  assert.equal(crown.sourceHeight, 599.1);
  assert.equal(crown.heightSource, 'osm-height');
  assert.equal(crown.baseSourceId, tower.id);
  const shaft = actual.filter(row => row.id.includes(':shaft:'));
  const width = row => row.maxX - row.minX;
  assert.ok(shaft.every((row, i) => i === 0 || width(shaft[i - 1]) > width(row)));
  assert.ok(Math.abs(shaft[0].maxX - tower.maxX) < 0.5);
  assert.equal(actual.filter(row => /:mega-column:\d:1$/.test(row.id)).length, 8);
  assert.equal(actual.filter(row => row.id.includes(':crown-leg:')).length, 4);
  assert.ok(actual.every(row => !occupies(row, tip.cx, tip.cz, base + 581, base + 586)));
  assert.ok(occupies(crown, tip.cx, tip.cz, base + 591, base + 592));
});

test('Ping An keeps the west portico and crossing under the mapped retail bridge clear at street height', () => {
  const actual = byLandmark.get('ping-an');
  const tower = byId.get(pingAn.sourceIds[0]);
  const west = { x: tower.minX + 2.7, z: tower.cz };
  const sidewalkY = terrain.terrainHeight(geo.terrain, west.x, west.z);
  assert.ok(actual.every(row => !occupies(row, west.x, west.z, sidewalkY, sidewalkY + 1.9)));
  assert.ok(actual.some(row => occupies(row, west.x + 3, west.z, sidewalkY, sidewalkY + 1.9)));
  const bridge = actual.find(row => row.sourceId === 'way/773719241');
  const source = byId.get(bridge.sourceId);
  const street = { x: -406.8, z: 1211.3 };
  const y = terrain.terrainHeight(geo.terrain, street.x, street.z);
  assert.equal(bridge.polygon, source.polygons[0]);
  assert.ok(Math.abs(bridge.maxY - bridge.minY - 40) < 1e-4);
  assert.ok(actual.every(row => !occupies(row, street.x, street.z, y, y + 1.8)));
  assert.ok(occupies(bridge, street.x, street.z, bridge.minY + 1, bridge.minY + 2));
});

test('China Resources Tower follows the design radii and the measured tower height on its unchanged DSM anchor', () => {
  const actual = byLandmark.get('chunsun');
  const core = byId.get('way/1270310100');
  const base = terrain.terrainHeight(geo.terrain, core.cx, core.cz);
  assert.ok(base < 0);
  const skins = actual.filter(part => part.id.includes(':skin:'));
  const ringRadius = ring => Math.max(...ring.map(p => Math.hypot(p.x - core.cx, p.z - core.cz)));
  assert.equal(skins[0].minY, Math.fround(base));
  assert.equal(skins.at(-1).maxY, Math.fround(base + 392.5));
  assert.equal(skins.at(-1).heightSource, 'osm-height');
  assert.ok(Math.abs(ringRadius(skins[0].loft.lower) - (31 - 2.8)) < 0.002);
  for (const [y, r] of [[127.5, 33.75], [258, 28], [327, 18.578], [400, 0.055]]) {
    const row = skins.find(part => part.maxY === Math.fround(base + 392.5 * y / 400));
    assert.ok(Math.abs(ringRadius(row.loft.upper) - r) < 0.002);
  }
  assert.ok(skins.slice(1).every((part, i) => part.minY === skins[i].maxY));
  assert.equal(actual.filter(row => /:vertical-rib:\d+:-?1:1$/.test(row.id)).length, 56);
  assert.equal(actual.filter(row => /:peak-rib:\d+:1$/.test(row.id)).length, 28);
});

test('China Resources Tower contact preserves the radial entrance band and does not hit the tapered crown envelope', () => {
  const actual = byLandmark.get('chunsun');
  const source = byId.get('way/1270310100');
  const east = source.polygons[0].outer.reduce((a, b) => a.x > b.x ? a : b);
  const angle = Math.atan2(east.z - source.cz, east.x - source.cx) + Math.PI / 28;
  const pos = r => [source.cx + Math.cos(angle) * r, source.cz + Math.sin(angle) * r];
  const base = terrain.terrainHeight(geo.terrain, source.cx, source.cz);
  assert.ok(actual.every(row => !occupies(row, ...pos(29.85), base + 1, base + 2.9)));
  assert.ok(actual.some(row => occupies(row, ...pos(27), base + 1, base + 2.9)));
  assert.ok(actual.every(row => !occupies(row, ...pos(24), base + 352, base + 355)));
  assert.ok(actual.some(row => occupies(row, ...pos(4), base + 352, base + 355)));
});

const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;
test('Culture Square replaces its source box with nine distinct stone volumes and a court-cut landscaped deck',
  { skip: !threePackageDir }, async () => {
    const THREE = await import(new URL('build/three.webgpu.js', pathToFileURL(join(threePackageDir, '/'))));
    const museum = loadCulture(THREE);
    const { planSzLandmarks } = loadPlan(museum);
    const withCulture = planSzLandmarks(buildings, geo.terrain);
    assert.equal(culture.sourceIds.length, 6);
    assert.ok(culture.sourceIds.every(id => withCulture.skipIds.has(id)));
    const model = withCulture.plans.find(p => p.id === 'shenzhen-bay-culture-square');
    const source = byId.get('way/1441599159');
    const stone = model.parts.filter(p => p.loft);
    assert.equal(new Set(stone.map(p => p.id.split(':')[1])).size, 9);
    assert.equal(new Set(stone.map(p => p.sourceId)).size, 6);
    assert.ok(stone.every(p => p.heightSource === 'estimate' && p.smoothSides));
    assert.ok(stone.every(p => p.polygon.outer.every(v => collision.polygonContains(source.polygons[0], v.x, v.z))));
    const roof = model.parts.filter(p => p.roofPanel);
    assert.ok(roof.length > 200 && roof.every(p => p.style === 'culturePark' && !p.roofContact && p.baseSource === 'dem-roof-point-samples'));
    assert.ok(roof.every(p => {
      const outer = p.polygon.outer;
      return collision.polygonContains(source.polygons[0], outer.reduce((a, b) => a + b.x, 0) / 3,
        outer.reduce((a, b) => a + b.z, 0) / 3);
    }));
    const north = stone.filter(p => p.id.includes(':north-monolith:'));
    assert.ok(Math.abs(north.at(-1).maxY - north[0].minY - 52.1) < 1e-4);
    assert.ok(north.length >= 20 && north.every(p => p.style === 'cultureMonolith'));
    for (let i = 1; i < north.length; i++) {
      const previous = north[i - 1], current = north[i];
      assert.equal(previous.maxY, current.minY);
      assert.deepEqual(previous.loft.upper, current.loft.lower);
      assert.equal(previous.loftSkin.upper, current.loftSkin.lower);
      assert.equal(previous.loftSkin.top, false);
      assert.equal(current.loftSkin.bottom, false);
    }
    const courtyard = { x: -11782.04, z: 3560.06 };
    assert.ok(roof.every(p => !collision.polygonContains(p.polygon, courtyard.x, courtyard.z)));
    const roofNormals = new Map();
    for (const part of roof) {
      assert.equal(parts.partCollider(part).roofPanel, part.roofPanel);
      for (const [i, p] of part.roofPanel.outer.entries()) {
        const key = `${p.x},${part.roofPanel.top[i]},${p.z}`;
        const normal = part.roofSkin.normals[i];
        assert.ok(normal.y > 0);
        if (roofNormals.has(key)) assert.equal(roofNormals.get(key), normal);
        else roofNormals.set(key, normal);
      }
    }
    assert.ok(roofNormals.size < roof.length);
    assert.ok(roof.flatMap(p => p.roofSkin.walls).filter(Boolean).length < roof.length);
    const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
    const { renderLandmark } = loadModule(readLandmark('render.js'), {
      imports: { 'three/webgpu': THREE, '../sz-geometry.js': geometry }
    });
    const material = new THREE.MeshStandardMaterial();
    const rendered = renderLandmark(model, () => material);
    const park = rendered.group.children.find(mesh => mesh.name === 'culturePark');
    const { position, normal } = park.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
      const expected = roofNormals.get(key);
      if (expected && normal.getY(i) > 0) {
        assert.ok(Math.hypot(expected.x - normal.getX(i), expected.y - normal.getY(i), expected.z - normal.getZ(i)) < 1e-6);
        roofNormals.delete(key);
      }
    }
    assert.equal(roofNormals.size, 0);
    assert.equal(rendered.surfaces.length, 0);
    for (const mesh of rendered.group.children) mesh.geometry.dispose();
    material.dispose();
    const paving = museum.createCulturePavingMask();
    const coverage = paving.image.data.filter(value => value > 200).length / paving.image.data.length;
    assert.ok(coverage > 0.02 && coverage < 0.06);
    paving.dispose();
  });

test('actual roof triangles share the render vertices and collision elevation', { skip: !threePackageDir }, async () => {
  const THREE = await import(new URL('build/three.webgpu.js', pathToFileURL(join(threePackageDir, '/'))));
  const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  const { renderLandmark } = loadModule(readLandmark('render.js'), {
    imports: { 'three/webgpu': THREE, '../sz-geometry.js': geometry }
  });
  const { createSurfaceResolver } = loadModule(read('sz-controller-surfaces.js'));
  const material = new THREE.MeshStandardMaterial();
  const tencentModel = renderLandmark(plan.plans.find(model => model.id === 'tencent-binhai'), () => material);
  const djiModel = renderLandmark(plan.plans.find(model => model.id === 'dji-sky-city'), () => material);
  const pingAnModel = renderLandmark(plan.plans.find(model => model.id === 'ping-an'), () => material);
  assert.equal(tencentModel.surfaces.length, 2);
  assert.equal(djiModel.surfaces.length, 0);
  const towerMesh = tencentModel.group.children.find(mesh => mesh.name === 'tencentTower');
  const position = towerMesh.geometry.attributes.position;
  const vertices = new Set();
  for (let i = 0; i < position.count; i++) vertices.add(`${position.getX(i)},${position.getY(i)},${position.getZ(i)}`);
  const support = createSurfaceResolver({ groundHeight: (x, z) => terrain.terrainHeight(geo.terrain, x, z), surfaces: tencentModel.surfaces });
  for (const surface of tencentModel.surfaces) {
    for (const p of surface.triangles.flat()) assert.ok(vertices.has(`${p.x},${p.y},${p.z}`));
    const [a, b, c] = surface.triangles[0];
    const x = (a.x + b.x + c.x) / 3;
    const z = (a.z + b.z + c.z) / 3;
    const roof = support.below(x, z, 500);
    const part = byLandmark.get('tencent-binhai').find(part => part.id === surface.id);
    assert.equal(roof.height, parts.partCollider(part).maxY);
    assert.equal(support.resolve(x, z).surfaceId, 'terrain');
  }
  const deck = djiModel.group.children.find(mesh => mesh.name === 'djiDeck');
  const normals = deck.geometry.attributes.normal.array;
  assert.ok(normals.some((n, i) => i % 3 === 1 && n > 0.9));
  assert.ok(normals.some((n, i) => i % 3 === 1 && n < -0.9));
  assert.equal(pingAnModel.surfaces.length, 1);
  const roof = pingAnModel.surfaces[0];
  const bridge = byLandmark.get('ping-an').find(part => part.id === roof.id);
  const pingAnSupport = createSurfaceResolver({ groundHeight: (x, z) => terrain.terrainHeight(geo.terrain, x, z),
    surfaces: pingAnModel.surfaces });
  assert.ok(Math.abs(pingAnSupport.below(-406.8, 1211.3, 80).height - parts.partCollider(bridge).maxY) < 1e-9);
  const crown = pingAnModel.group.children.find(mesh => mesh.name === 'pingAnCrown');
  assert.equal(crown.geometry.boundingBox.max.y, byLandmark.get('ping-an').find(row => row.style === 'pingAnCrown').maxY);
  const panel = parts.roofPanelPart('test-roof', byId.get('way/1110959408'),
    [{ x: 0, y: 10, z: 0 }, { x: 12, y: 22, z: 0 }, { x: 0, y: 16, z: 12 }], [1, 2, 3], 'civicRoofBlue', { roofContact: true });
  const panelModel = renderLandmark({ id: 'test-roof', parts: [panel] }, () => material);
  const panelSupport = createSurfaceResolver({ groundHeight: () => 0, surfaces: panelModel.surfaces });
  assert.equal(panelSupport.below(4, 4, 30).height, 16);
  const panelNormals = panelModel.group.children[0].geometry.attributes.normal;
  assert.ok(panelNormals.getY(panelNormals.count - 1) > 0);
});
