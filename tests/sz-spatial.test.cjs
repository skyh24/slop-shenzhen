const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const terrainURL = uri(readFileSync(join(root, 'js/sz-ground-surface.js')));
const polygonURL = uri(readFileSync(join(root, 'js/sz-polygon.js')));
const modulePromise = import(uri(readFileSync(join(root, 'js/sz-spatial.js'), 'utf8')
  .replace('./sz-ground-surface.js', terrainURL)
  .replace('./sz-polygon.js', polygonURL)));
const { fixtureTerrainSurface } = require('./helpers/terrain-surface.cjs');
const ring = (a, b, c, d) => [{x:a,z:b},{x:c,z:b},{x:c,z:d},{x:a,z:d}];
const geo = {
  bounds: [-100, -100, 100, 100],
  coverage: [{outer:ring(-100,-100,100,90),holes:[]}],
  land: [{outer:ring(-90,-90,90,90),holes:[ring(-10,-10,10,10)]}],
  water: [{outer:ring(40,40,60,60),holes:[]}],
  terrain: {x0:-100,z0:-100,step:100,nx:3,nz:3,heightScale:0.1,heights:[10,20,30,40,50,60,70,80,90]},
  roadGraph: {nodes:[-80,20,80,20,-80,30,80,30], names:['地面道路','高架道路'],
    links:[[0,1,0,7,2,0,[]],[2,3,1,7,1,1,[]]], metadata:[{heightSource:'terrain'},{heightSource:'unresolved',bridge:true,layer:1}]}
};

geo.terrainSurface = fixtureTerrainSurface(geo.terrain);

test('spatial queries preserve holes, inland water and unknown out-of-coverage heights', async () => {
  const {createCitySpatial}=await modulePromise;
  const city=createCitySpatial(geo);
  assert.equal(city.isOnLand(0,0),false);
  assert.equal(city.isOnLand(50,50),false);
  assert.equal(city.isOnLand(30,30),true);
  assert.equal(city.groundHeight(0,0),null);
  assert.equal(city.groundHeight(101,0),null);
  assert.equal(city.isWater(101,0),null);
  assert.equal(city.isWater(0,95),null, 'outside actual coverage but inside bounding box is unknown');
  assert.equal(city.groundHeight(-50,-50),3);
});

test('nearest road queries use polyline distance and retain unresolved elevated surfaces', async () => {
  const {createCitySpatial}=await modulePromise;
  const city=createCitySpatial(geo);
  const near=city.nearestRoads(0,29,20);
  assert.equal(near.length,2);
  assert.equal(near[0].road.name,'高架道路');
  assert.equal(near[0].distance,1);
  assert.equal(near[0].road.heightSource,'unresolved');
  assert.equal(near[1].road.name,'地面道路');
  assert.equal(city.nearestRoads(0,29,0).length,0);
});

test('reused cells match exact polygons across shorelines, holes and coverage edges', async () => {
  const {createCitySpatial} = await modulePromise;
  const {polygonContainsInclusive} = await import(polygonURL);
  const fixture = { ...geo, bounds: [-1300,-1300,1300,1300],
    coverage: [{outer:ring(-1250,-1250,1250,1250),holes:[ring(-800,-720,-770,-700)]}],
    land: [{outer:ring(-1000,-1000,1000,1000),holes:[ring(29,29,31,31)]}],
    water: [{outer:[{x:-500,z:-500},{x:500,z:500},{x:500,z:515}],holes:[]}] };
  const city = createCitySpatial(fixture);
  const contains = (polys,x,z) => polys.some(poly => polygonContainsInclusive(poly,x,z));
  for (const offset of [0,1,-1,0]) for (const coord of [-1251,-1250,-1000,-770,-500,-250,0,29,30,31,32,249,250,500,900,1001,1250]) {
    const x = coord + offset;
    for (const z of [coord,coord+5,-710,30,750,1250,1251]) {
      const expected = contains(fixture.coverage,x,z) ? !contains(fixture.land,x,z) || contains(fixture.water,x,z) : null;
      assert.equal(city.isOnLand(x,z),expected === false);
      assert.equal(city.isWater(x,z),expected);
    }
  }
});

test('removed ground remains unknown even when the original DSM still has a height', async () => {
  const { createCitySpatial } = await modulePromise;
  const terrainSurface = structuredClone(geo.terrainSurface);
  terrainSurface.chunks = terrainSurface.chunks.filter(chunk => chunk.id !== '-1,-1');
  const city = createCitySpatial({ ...geo, terrainSurface });
  assert.equal(city.isOnLand(-50, -50), true);
  assert.equal(city.isWater(-50, -50), false, 'a removed indoor surface is not a new lake');
  assert.equal(city.groundHeight(-50, -50), null, 'raw DSM must not restore removed geometry');
  assert.equal(city.groundHeight(30, 30), 6.2);
  assert.throws(() => createCitySpatial({ ...geo, terrainSurface: undefined }), /Invalid terrain surface/);
});
