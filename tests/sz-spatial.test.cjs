const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const terrainURL = uri(readFileSync(join(root, 'js/sz-terrain.js')));
const modulePromise = import(uri(readFileSync(join(root, 'js/sz-spatial.js'), 'utf8').replace('./sz-terrain.js', terrainURL)));
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
