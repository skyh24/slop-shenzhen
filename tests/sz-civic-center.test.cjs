const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const collision = loadModule(read('building-collision.js'));
const terrain = loadModule(read('sz-terrain.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const parts = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
const { triangleHeight } = loadModule(read('sz-controller-surfaces.js'));
const civic = loadModule(read('sz-landmarks/civic-center.js'), { imports: {
  '../building-collision.js': collision, './parts.js': parts
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const sources = new Map(buildings.map(row => [row.id, row]));
const model = civic.build(sources, geo.terrain);
const canopy = model.filter(row => row.style === 'civicRoofBlue');
const platform = sources.get('relation/10837978');
const base = terrain.terrainHeight(geo.terrain, platform.cx, platform.cz);

function heightAt(part, x, z) {
  const { outer, top } = part.roofPanel;
  return triangleHeight(outer.map((p, i) => ({ ...p, y: top[i] })), x, z);
}

function canopyAt(x, z) {
  return canopy.find(row => x >= row.minX && x <= row.maxX && z >= row.minZ && z <= row.maxZ
    && heightAt(row, x, z) !== null);
}

test('Civic Center binds the complete OSM roof and preserves the four wing courtyards', () => {
  assert.ok(civic.sourceIds.every(id => sources.has(id)));
  assert.ok(civic.sourceIds.every(id => model.some(part => part.sourceId === id)));
  const maxRoofY = Math.max(...canopy.map(row => row.maxY));
  assert.ok(Math.abs(maxRoofY - (base + 80)) < 0.15);
  const west = sources.get('way/783584162');
  const east = sources.get('way/783584159');
  const wingTrough = canopyAt(-174, 49);
  const wingTip = canopyAt(west.minX + 2, 15);
  const saddle = canopyAt(0, 13);
  assert.ok(heightAt(wingTip, west.minX + 2, 15) > heightAt(wingTrough, -174, 49) + 9);
  assert.ok(heightAt(saddle, 0, 13) > heightAt(wingTrough, -174, 49) + 35);
  assert.equal(Math.min(...canopy.map(row => row.minX)), Math.fround(west.minX));
  assert.equal(Math.max(...canopy.map(row => row.maxX)), Math.fround(east.maxX));
  for (const x of [-201, -147, 154, 209]) assert.equal(canopyAt(x, 0), undefined);
});

test('Civic Center has two source-aligned slanted tower crowns and an open central span', () => {
  for (const [id, style, outside] of [
    ['way/616988599', 'civicTowerYellow', 'minX'], ['way/616988601', 'civicTowerRed', 'maxX']
  ]) {
    const source = sources.get(id);
    const tower = model.filter(row => row.sourceId === id);
    assert.ok(tower.every(row => row.style === style && row.sourceHeight === 91.5 && row.heightSource === 'estimate'));
    assert.ok(tower.some(row => row[outside] === Math.fround(source[outside])
      && row.maxY === Math.fround(base + 84.7)));
    const vertices = tower.flatMap(row => row.roofPanel.top);
    assert.ok(Math.max(...vertices) - Math.min(...vertices) > 15.9);
  }
  const x = 1.2, z = 4.5;
  const roof = canopyAt(x, z);
  const { roofPanel } = parts.partCollider(roof);
  const top = heightAt(roof, x, z);
  const plaza = model.find(row => row.sourceId === platform.id);
  assert.equal(collision.roofPanelContactPolygon(roofPanel, plaza.maxY, plaza.maxY + 1.9), null);
  const solid = collision.roofPanelContactPolygon(roofPanel, top - 0.9, top - 0.2);
  assert.ok(collision.polygonContains(solid, x, z));
  assert.ok(model.every(row => row.minY > plaza.maxY + 1.9 || row.maxY <= plaza.maxY
    || !collision.polygonContains(row.polygon, x, z)));
});
