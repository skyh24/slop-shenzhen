const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');
const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const terrain = loadModule(read('sz-terrain.js'));
const { buildingPlacement, buildingSeed } = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const { GeoBuilder, addWalls } = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': {} } });
const collision = loadModule(read('building-collision.js'));
const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 0.1, heights: [100,100,100,100] };
const outer = [{x:-20,z:-20},{x:20,z:-20},{x:20,z:20},{x:-20,z:20}];
const hole = [{x:-5,z:-5},{x:5,z:-5},{x:5,z:5},{x:-5,z:5}];
const building = { id:'way/123', cx:0, cz:0, minX:-20,maxX:20,minZ:-20,maxZ:20,
  height:100,minHeight:40,heightSource:'osm-height',polygons:[{outer,holes:[hole]}] };

test('building walls and colliders share source part heights and retain open courtyards', () => {
  const placement = buildingPlacement(building, grid);
  const builder = new GeoBuilder(true);
  addWalls(builder, [outer,hole].map(r=>r.flatMap(p=>[p.x,p.z])), placement.minY, placement.maxY, [0,0,0,100], placement.baseY);
  const positions = builder.pos.view();
  const ys = Array.from(positions).filter((_,i)=>i%3===1);
  assert.equal(Math.min(...ys),50);
  assert.equal(Math.max(...ys),110);
  assert.equal(placement.colliders[0].minY,Math.min(...ys));
  assert.equal(placement.colliders[0].maxY,Math.max(...ys));
  assert.equal(collision.polygonContains(placement.colliders[0].polygon,0,0),false);
  assert.equal(collision.polygonContains(placement.colliders[0].polygon,10,0),true);
  assert.equal(Math.min(...Array.from(builder.uv.view()).filter((_,i)=>i%2===1)),40);
});

test('building placement fails when terrain is unknown and facade seed uses identity', () => {
  assert.throws(()=>buildingPlacement({...building,cx:1000},grid),/Missing building terrain/);
  assert.equal(buildingSeed('way/123'),buildingSeed('way/123'));
  assert.notEqual(buildingSeed('way/123'),buildingSeed('way/124'));
});
