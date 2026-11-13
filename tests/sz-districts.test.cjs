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
    return { districts, buildings, colliders, road, groundHeight, contact, blocked, scene, site, chunks, buildSzDistricts };
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
  const preserved = buildings.find(b => b.id === 'way/435827465');
  const loft = districts.colliders.find(c => c.name === 'way/435827465:district:0');
  assert.equal(loft.heightSource, preserved.heightSource);
  assert.equal(loft.maxY, 8 + preserved.height);
  for (const id of ['way/435827461', 'way/435827469', 'way/532810249', 'way/435827467', 'way/532810264', 'way/532810267']) {
    const house = districts.colliders.find(c => c.name === `${id}:district:0`);
    assert.equal(house.heightSource, 'estimate');
    assert.ok(Math.abs(house.maxY - (8 + 12.15)) < 0.001);
  }
  const withoutBasin = buildSzDistricts(scene, { ...site, buildings: buildings.filter(b => b.id === 'way/105683429') },
    { water: [], roads: chunks, carriagewayOccupied: road.contains });
  assert.equal(withoutBasin.skipIds.size, 0);
  withoutBasin.dispose();
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
  const { districts, blocked, contact, road } = await load();
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
  assert.ok(districts.colliders.some(c => c.name === 'minghua:closed-gate'));
  assert.ok(districts.colliders.some(c => c.name === 'oct-loft:closed-stair-gate'));
});

test('open retail bays have clear terrain inside their source footprint and closed upper floors', async () => {
  const { districts, blocked, contact, road } = await load();
  for (const id of ['way/135951438', 'way/492141834', 'way/435827461']) {
    assert.ok(districts.shops.filter(shop => shop.id === id).length >= 3, `${id} has a row of open shops`);
  }
  assert.ok(districts.shops.some(shop => shop.district === 'nantou'), 'Nantou has a public shop bay');
  for (const { id, approach, interior } of districts.shops) {
    let prev = contact(approach.x, approach.z);
    const count = Math.ceil(Math.hypot(interior.x - approach.x, interior.z - approach.z) / 0.2);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = approach.x + (interior.x - approach.x) * t, z = approach.z + (interior.z - approach.z) * t;
      const y = contact(x, z);
      assert.ok(Number.isFinite(y) && Math.abs(y - prev) < 0.13, `${id} is on continuous ground`);
      assert.ok(!road.contains(x, z, 0.48) && !blocked(x, z, y), `${id} is clear at ${x}, ${z}`);
      prev = y;
    }
    assert.ok(blocked(interior.x, interior.z, prev + 3.6), `${id} retains its solid upper shell`);
  }
});
