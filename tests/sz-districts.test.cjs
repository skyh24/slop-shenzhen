const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { registerHooks } = require('node:module');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');

const threeDir = process.env.SZ_THREE_PACKAGE_DIR ?? resolve(__dirname, '../.agents/three-0.187.0');
registerHooks({ resolve(specifier, context, next) {
  const name = { 'three/webgpu': 'three.webgpu.js', 'three/tsl': 'three.tsl.js' }[specifier];
  return name ? { url: pathToFileURL(resolve(threeDir, 'build', name)).href, shortCircuit: true } : next(specifier, context);
} });

let fixture;
function load() {
  return fixture ??= (async () => {
    const { Scene } = await import('three/webgpu');
    const { decodeCityPayload } = await import('../js/sz-data-format.js');
    const { createGroundSurfaceSampler } = await import('../js/sz-ground-surface.js');
    const { createRoadSurfaceLayout } = await import('../js/sz-roads.js');
    const { createCarriagewayBarrier } = await import('../js/sz-pedestrian-tracks.js');
    const { buildingPlacement } = await import('../js/sz-building-layout.js');
    const { buildSzDistricts } = await import('../js/sz-districts/index.js');
    const { polygonBoxOverlaps } = await import('../js/building-collision.js');
    const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../js/sz-city.json.gz')))));
    const groundHeight = createGroundSurfaceSampler(geo.terrainSurface);
    const road = createCarriagewayBarrier(geo.roadGraph);
    const { chunks } = createRoadSurfaceLayout(geo.roadGraph, geo.terrainSurface);
    const site = { buildings, terrain: geo.terrain, terrainSurface: geo.terrainSurface, groundHeight, heightAt: groundHeight };
    const scene = new Scene();
    const districts = buildSzDistricts(scene, site, { water: geo.water, roads: chunks, carriagewayOccupied: road.contains });
    const colliders = [...districts.colliders, ...buildings.filter(b => !districts.skipIds.has(b.id))
      .flatMap(b => buildingPlacement(b, geo.terrain).colliders)];
    const contact = (x, z) => districts.heightAt(x, z) ?? groundHeight(x, z);
    const blocked = (x, z, y, r = 0.48) => colliders.some(b => b.minX < x + r && b.maxX > x - r
      && b.minZ < z + r && b.maxZ > z - r && b.minY < y + 1.9 && b.maxY > y + 0.02
      && polygonBoxOverlaps(b.polygon, x, z, r, r));
    return { districts, buildings, colliders, road, groundHeight, contact, blocked, scene, site, chunks, buildSzDistricts, geo };
  })();
}

test('district replacements use reviewed OSM objects and retain sourced neighboring heights', async () => {
  const { districts, buildings, buildSzDistricts, scene, site, chunks, road } = await load();
  const manifest = require('../data/source/landmarks.json').landmarks;
  for (const id of ['sea-world', 'oct-loft', 'nantou-ancient-city']) {
    const { modelSource } = manifest.find(lm => lm.id === id).sceneReview;
    assert.ok(districts.skipIds.has(modelSource));
    assert.ok(districts.heights.get(id).roof > 14);
  }
  assert.ok(!districts.skipIds.has('way/493722121'), 'mapped 20-story waterfront tower remains');
  for (const id of ['way/333871652', 'way/435827465', 'way/435827466', 'way/532810260', 'way/532810266']) {
    const preserved = buildings.find(b => b.id === id);
    const loft = districts.colliders.find(c => c.name === `${id}:district:0`);
    assert.equal(loft.heightSource, preserved.heightSource);
    assert.equal(loft.maxY, 8 + preserved.height);
  }
  const withoutBasin = buildSzDistricts(scene, { ...site, buildings: buildings.filter(b => b.id === 'way/105683429') },
    { water: [], roads: chunks, carriagewayOccupied: road.contains });
  assert.equal(withoutBasin.skipIds.size, 0);
  withoutBasin.dispose();
});

test('the Xiangmihu interchange outlines render as plain one-story solids with matching collision', async () => {
  const { districts, buildings, site } = await load();
  const { buildingPlacement } = await import('../js/sz-building-layout.js');
  const group = districts.group.getObjectByName('xiangmihu-interchange-blocks');
  const meshes = group.children.filter(child => child.isMesh);
  assert.equal(meshes.length, 1);
  assert.equal(group.getObjectByName('xiangmihu-interchange-blocks:detail').children.length, 0);
  const positions = meshes[0].geometry.attributes.position;
  for (const id of ['overture/9c8df500-092b-4917-ac95-1186f5e8e604', 'overture/2ed49f3c-8f4f-46e3-a2a3-32cb709bd37e']) {
    assert.ok(districts.skipIds.has(id));
    const building = buildings.find(b => b.id === id);
    const { baseY } = buildingPlacement(building, site.terrain);
    const collider = districts.colliders.find(c => c.sourceId === id);
    assert.equal(collider.polygon, building.polygons[0]);
    assert.equal(collider.maxY, Math.fround(baseY + 3.2));
    const ys = [];
    for (let i = 0; i < positions.count; i++) {
      if (positions.getX(i) >= building.minX - 0.001 && positions.getX(i) <= building.maxX + 0.001
        && positions.getZ(i) >= building.minZ - 0.001 && positions.getZ(i) <= building.maxZ + 0.001) ys.push(positions.getY(i));
    }
    assert.ok(ys.length > 0);
    assert.equal(Math.max(...ys), collider.maxY);
  }
});

test('reviewed toll roofs keep the ramps and Qianhai decks open beneath the source footprint', async () => {
  const { Scene } = await import('three/webgpu');
  const { buildSzElevatedRoads } = await import('../js/sz-elevated-roads.js');
  const { createRoadHeightSampler, roadSectionPoints } = await import('../js/sz-roads.js');
  const { createSurfaceHeightAt } = await import('../js/sz-controller-surfaces.js');
  const { polygonContainsInclusive } = await import('../js/sz-polygon.js');
  const { buildSzDistricts, site, road, chunks, geo, buildings } = await load();
  const scene = new Scene();
  const roadGraph = geo.roadGraph, terrainSurface = geo.terrainSurface;
  const roadHeight = createRoadHeightSampler(chunks, terrainSurface.grid);
  const elevated = buildSzElevatedRoads(scene, { graph: roadGraph, terrainSurface, water: geo.water });
  const districts = buildSzDistricts(scene, { ...site, roadGraph, roadHeight },
    { water: geo.water, roads: chunks, carriagewayOccupied: road.contains, decks: elevated.links });
  const roofs = districts.colliders.filter(c => c.name.startsWith('toll:') && c.name.endsWith(':roof'));
  assert.equal(roofs.length, 13);
  assert.ok(!districts.skipIds.has('way/482249522'), 'Huanggang has no verified through edge in this pack');
  assert.ok(!districts.skipIds.has('way/1212748044'), 'the road noise cover is a separate structure');
  for (const roof of roofs) {
    assert.ok(districts.skipIds.has(roof.sourceId));
    assert.equal(roof.polygon, buildings.find(b => b.id === roof.sourceId).polygons[0]);
    assert.equal(roof.heightSource, 'estimate');
    assert.ok(districts.group.getObjectByName(`ShenzhenToll:${roof.sourceId}:silver`).geometry.index.count > 0);
    const parts = districts.colliders.filter(c => c.sourceId === roof.sourceId && c.maxY <= roof.minY);
    if (roof.sourceId === 'way/482234119') {
      assert.ok(parts.filter(c => c.name.includes(':deck-column:')).length >= 2);
      continue;
    }
    assert.ok(parts.some(c => c.name.includes(':booth:')));
    for (const part of parts) {
      const { minX, maxX, minZ, maxZ } = part;
      const x = (minX + maxX) / 2, z = (minZ + maxZ) / 2;
      const radius = Math.max(...part.polygon.outer.map(p => Math.hypot(p.x - x, p.z - z)));
      assert.ok(!road.contains(x, z, radius));
    }
  }
  function checkRoute(roofId, points, heightAt) {
    const roof = roofs.find(c => c.sourceId === roofId);
    let checked = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
      for (let j = 0; j <= steps; j++) {
        const x = a.x + (b.x - a.x) * j / steps, z = a.z + (b.z - a.z) * j / steps;
        if (!polygonContainsInclusive(roof.polygon, x, z)) continue;
        const y = heightAt(x, z);
        assert.ok(Number.isFinite(y) && roof.minY - y >= 5.5);
        checked++;
      }
    }
    assert.ok(checked > 8);
  }
  const ramp = roadGraph.metadata.findIndex(r => r.osmId === 'way/25588751');
  checkRoute('way/482249531', roadSectionPoints(roadGraph, roadGraph.links[ramp], roadGraph.metadata[ramp]), roadHeight);
  const qianhaiDecks = elevated.links.filter(d => /^way\/121274804[0-3]$/.test(d.osmId));
  assert.equal(qianhaiDecks.length, 4);
  for (const deck of qianhaiDecks) {
    const sample = createSurfaceHeightAt([{ id: deck.surfaceId, triangles: deck.topTriangles }]);
    checkRoute('way/482234119', deck.frames, (x, z) => sample(x, z, deck.surfaceId));
  }
  districts.dispose();
});

test('six reviewed OCT blocks use a two-story burgundy brick design over their source footprints', async () => {
  const { districts, buildings } = await load();
  for (const id of ['way/435827461', 'way/435827469', 'way/532810249', 'way/435827467', 'way/532810264', 'way/532810267']) {
    const source = buildings.find(b => b.id === id);
    const house = districts.colliders.find(c => c.name === `${id}:district:0`);
    assert.equal(house.heightSource, 'estimate');
    assert.equal(house.layoutSource, 'scene-design-height');
    assert.deepEqual(house.polygon, source.polygons[0]);
    assert.ok(Math.abs(house.maxY - (8 + 8.1)) < 0.001);
  }
  for (const style of ['burgundyBrick', 'darkBurgundyBrick']) {
    const mesh = districts.group.getObjectByName(`oct-loft:${style}`);
    assert.ok(mesh.isMesh && mesh.geometry.getAttribute('position').count > 0 && mesh.material.colorNode);
  }
});

test('three OCT blocks have street-facing display windows over solid walls', async () => {
  const { districts, buildings, blocked, contact } = await load();
  const { Matrix4 } = await import('three/webgpu');
  const detail = districts.group.getObjectByName('oct-loft:detail');
  const matrix = new Matrix4();
  const shutters = [];
  for (const mesh of detail.children.filter(mesh => mesh.isInstancedMesh && mesh.material.color.getHex() === 0xa7b2b1)) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const m = matrix.elements;
      if (Math.abs(m[5] - 0.21) > 0.001 || Math.abs(Math.hypot(m[8], m[10]) - 0.22) > 0.001) continue;
      shutters.push({ x: m[12], z: m[14], nx: m[8] / 0.22, nz: m[10] / 0.22 });
    }
  }
  for (const [id, facing] of [['way/435827467', 'north'], ['way/532810264', 'east'], ['way/532810267', 'north']]) {
    const source = buildings.find(b => b.id === id);
    const windows = shutters.filter(p => p.x >= source.minX - 0.2 && p.x <= source.maxX + 0.2
      && p.z >= source.minZ - 0.2 && p.z <= source.maxZ + 0.2);
    assert.ok(windows.length >= 2, `${id} has multiple closed display windows`);
    assert.ok(!districts.shops.some(shop => shop.id === id), `${id} has no new entrance`);
    for (const { x, z, nx, nz } of windows) {
      assert.ok(facing === 'east' ? nx > 0.85 : nz < -0.85, `${id} display faces the selected street`);
      const outside = [x + nx * 0.65, z + nz * 0.65];
      const inside = [x - nx * 0.65, z - nz * 0.65];
      const outsideY = contact(...outside);
      assert.ok(Number.isFinite(outsideY) && !blocked(...outside, outsideY), `${id} keeps clear ground outside the display`);
      assert.ok(blocked(...inside, contact(...inside)), `${id} retains its wall behind the display`);
    }
  }
  for (const [id, count] of [['way/435827461', 8], ['way/435827469', 1], ['way/532810249', 1]]) {
    assert.equal(districts.shops.filter(shop => shop.id === id).length, count, `${id} keeps its walk-in shops`);
  }
});

test('B10 keeps its source footprint and a clear street approach below the balcony', async () => {
  const { districts, buildings, blocked, contact, road } = await load();
  const source = buildings.find(b => b.id === 'way/435827468');
  const { base, roof } = districts.heights.get('oct-loft');
  const [lower, upper] = ['oct-b10:white-box', 'oct-b10:screen'].map(name =>
    districts.colliders.find(part => part.name === name));
  for (const part of [lower, upper]) {
    assert.equal(part.sourceId, source.id);
    assert.deepEqual(part.polygon, source.polygons[0]);
    assert.equal(part.heightSource, 'estimate');
  }
  assert.equal(lower.maxY, upper.minY);
  assert.equal(upper.maxY, roof);
  assert.ok(Math.abs(roof - base - 10.95) < 0.001);
  const canopy = districts.colliders.find(part => part.name === 'oct-b10:south-balcony');
  const x = (canopy.minX + canopy.maxX) / 2, z = (canopy.minZ + canopy.maxZ) / 2;
  assert.ok(!road.contains(x, z, 0.48));
  assert.ok(!blocked(x, z, contact(x, z)));
  assert.ok(blocked(source.cx, source.cz, base));
  assert.ok(!districts.shops.some(shop => shop.id === source.id));
  const screen = districts.group.getObjectByName('oct-loft:b10Screen');
  assert.ok(screen.geometry.getAttribute('uv').count > 0 && screen.material.colorNode);
});

test('the ring, creative court and old-city lanes provide supported pedestrian tracks and clear arrivals', async () => {
  const { districts, blocked, road, colliders, contact, groundHeight } = await load();
  const tracks = districts.publicRoutes(colliders, road, contact);
  const sea = tracks.find(r => r.id === 'sea-world-quay:0');
  assert.deepEqual(sea.points[0], sea.points.at(-1));
  for (const id of ['sea-world-quay:0', 'sea-world-plaza:0', 'oct-loft-court:0', 'nantou-east-alley:0']) {
    const route = tracks.find(r => r.id === id);
    assert.ok(route, id);
    for (const p of route.points) {
      assert.ok(route.walkAt(p.x, p.z), id);
      assert.ok(Math.abs(route.publicHeight(p.x, p.z) - groundHeight(p.x, p.z)) < 0.005, id);
      assert.ok(!blocked(p.x, p.z, p.y), id);
    }
  }
  assert.equal(Object.keys(districts.arrivals).length, 3);
  for (const { x, z } of Object.values(districts.arrivals)) {
    const y = contact(x, z);
    assert.ok(Number.isFinite(y) && !road.contains(x, z, 0.58) && !blocked(x, z, y, 0.58));
  }
});

test('the old gate stays open at walking height while the two new walls stand clear of roads', async () => {
  const { districts, buildings, blocked, contact, road } = await load();
  const { polygonContainsInclusive } = await import('../js/sz-polygon.js');
  const wings = districts.colliders.filter(c => c.name.startsWith('nantou:design-wall:'));
  assert.equal(wings.length, 2);
  for (const wall of wings) {
    assert.equal(wall.heightSource, 'estimate');
    assert.ok(wall.polygon.outer.every(p => !road.contains(p.x, p.z, 0.05)));
  }
  for (let i = 0; i <= 20; i++) {
    const t = i / 20, x = -14277.93 - 2.24 * t, z = 164.8 - 9.05 * t;
    assert.ok(!blocked(x, z, contact(x, z)), `Gate blocked at ${i}`);
  }
  const gate = buildings.find(b => b.id === 'way/1183877518');
  const { base, roof } = districts.heights.get('nantou-ancient-city');
  const tower = districts.colliders.filter(part => part.name.startsWith('nantou:south-gate:tower'));
  assert.equal(tower.length, 5);
  for (const part of tower) {
    assert.equal(part.sourceId, gate.id);
    assert.equal(part.heightSource, 'estimate');
    assert.ok(part.minY > base + 6.9);
    assert.ok(part.polygon.outer.every(p => polygonContainsInclusive(gate.polygons[0], p.x, p.z)));
  }
  assert.ok(Math.abs(Math.max(...tower.map(part => part.maxY)) - roof) < 0.001);
  assert.ok(Math.abs(contact(gate.cx, gate.cz) - base) < 0.005);
  assert.ok(districts.colliders.some(c => c.name === 'minghua:closed-gate'));
  assert.ok(districts.colliders.some(c => c.name === 'oct-loft:closed-stair-gate'));
});

test('open retail bays have clear terrain inside their source footprint and closed upper floors', async () => {
  const { districts, blocked, contact, road } = await load();
  for (const id of ['way/135951438', 'way/492141834', 'way/435827461']) {
    assert.ok(districts.shops.filter(shop => shop.id === id).length >= 3, `${id} has a row of open shops`);
  }
  assert.ok(districts.shops.some(shop => shop.district === 'nantou'), 'Nantou has a public shop bay');
  const checkPath = (id, from, to) => {
    let prev = contact(from.x, from.z);
    const count = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.2);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      const y = contact(x, z);
      assert.ok(Number.isFinite(y) && Math.abs(y - prev) < 0.13, `${id} is on continuous ground`);
      assert.ok(!road.contains(x, z, 0.48) && !blocked(x, z, y), `${id} is clear at ${x}, ${z}`);
      prev = y;
    }
    return prev;
  };
  for (const { id, approach, interior } of districts.shops) {
    const y = checkPath(id, approach, interior);
    assert.ok(blocked(interior.x, interior.z, y + 3.6), `${id} retains its solid upper shell`);
  }
  const a5 = districts.shops.filter(shop => shop.id === 'way/435827461').sort((a, b) => a.approach.x - b.approach.x);
  const walk = districts.routes.oct[0];
  const street = a5.map(({ id, approach }) => {
    const end = walk.findIndex((p, i) => i > 0 && p.x <= approach.x && walk[i - 1].x >= approach.x);
    assert.ok(end > 0);
    const [a, b] = walk.slice(end - 1, end + 1);
    const t = (approach.x - a.x) / (b.x - a.x);
    const pathPoint = { x: approach.x, z: a.z + (b.z - a.z) * t };
    checkPath(id, pathPoint, approach);
    return pathPoint;
  });
  for (let i = 1; i < street.length; i++) {
    checkPath(a5[i].id, street[i - 1], street[i]);
  }
});

test('district balcony door and fixed window share one bay and clear the slab and planter', async () => {
  const { buildings, site } = await load();
  const { restyleBlock } = await import('../js/sz-districts/facades.js');
  const building = buildings.find(b => b.id === 'way/435827461');
  const pieces = [], slabs = [];
  const kit = {
    part() {},
    piece(p, y, w, h, d, f, style) { pieces.push({ p, y, w, h, d, f, style }); },
    box(p, lo, hi, w, d, f) { slabs.push({ p, hi, w, d, f }); }
  };
  restyleBlock(kit, building, site.terrain, () => 8, 'oct', { balconies: true, floors: 2 });
  assert.ok(slabs.length > 0);
  for (const { p, hi, w, d, f } of slabs) {
    const along = q => (q.x - p.x) * f.c + (q.z - p.z) * f.s;
    const normal = q => -(q.x - p.x) * f.s + (q.z - p.z) * f.c;
    const inBay = pieces.filter(v => v.f === f && Math.abs(along(v.p)) < w / 2 && Math.abs(normal(v.p)) < d / 2
      && v.y > hi && v.y < hi + 3);
    const panes = inBay.filter(v => v.style === 'glass' || v.style === 'darkGlass')
      .sort((a, b) => along(a.p) - along(b.p));
    assert.equal(panes.length, 2);
    const [fixed, door] = panes;
    assert.ok(Math.abs(door.y - door.h / 2 - hi - 0.04) < 0.001);
    assert.ok(fixed.y - fixed.h / 2 > hi + 0.5);
    assert.ok(Math.abs((door.y + door.h / 2) - (fixed.y + fixed.h / 2)) < 0.001);
    const planter = inBay.find(v => v.style === 'terra');
    assert.ok(planter && along(planter.p) + planter.w / 2 < along(door.p) - door.w / 2);
  }
});
