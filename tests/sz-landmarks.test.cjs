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
const loadUpperhills = THREE => loadModule(readLandmark('upperhills.js'), { imports: {
  'three/webgpu': THREE, 'three/tsl': {}, '../sz-materials.js': {}, '../sz-terrain.js': terrain,
  '../building-collision.js': collision, './parts.js': parts
} });
const nonferrous = loadModule(readLandmark('nonferrous-tower.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, '../sz-materials.js': {}, './parts.js': parts
} });
const loadIec = (THREE, tsl = {}, materials = {}) => loadModule(readLandmark('iec-xiangmihu.js'), { imports: {
  'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': materials, '../sz-terrain.js': terrain, './parts.js': parts
} });
const iec = loadIec({});
const loadSuperHq = (THREE, tsl = {}, materials = {}) => loadModule(readLandmark('super-hq.js'), { imports: {
  'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': materials, '../sz-terrain.js': terrain,
  '../building-collision.js': collision, './parts.js': parts
} });
const superHq = loadSuperHq({});
const culture = loadCulture({});
const upperhills = loadUpperhills({});
const loadPlan = (cultureModule, upperhillsModule = upperhills, iecModule = iec, superHqModule = superHq) => loadModule(readLandmark('layout.js'), { imports: {
  './tencent-binhai.js': tencent, './dji-sky-city.js': dji, './ping-an.js': pingAn, './chunsun.js': chunsun,
  './civic-center.js': civic, './chunjian.js': stadium, './shenzhen-bay-culture-square.js': cultureModule,
  './convention-center.js': convention, './upperhills.js': upperhillsModule, './nonferrous-tower.js': nonferrous,
  './iec-xiangmihu.js': iecModule, './super-hq.js': superHqModule
} });
const { planSzLandmarks } = loadPlan(culture);
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const fixture = buildings.filter(building => !culture.sourceIds.includes(building.id) && !upperhills.sourceIds.includes(building.id));
const plan = planSzLandmarks(fixture, geo.terrain);
const byId = new Map(buildings.map(building => [building.id, building]));
const byLandmark = new Map(plan.plans.map(landmark => [landmark.id, landmark.parts]));

test('landmarks retire only the explicit source objects and keep the fallback on incomplete snapshots', () => {
  const verifiedDuplicates = [...civic.optionalSkipIds, ...nonferrous.optionalSkipIds].filter(id => byId.has(id));
  assert.deepEqual([...plan.skipIds].sort(), [...tencent.sourceIds, ...dji.sourceIds, ...pingAn.sourceIds, ...chunsun.sourceIds,
    ...civic.sourceIds, ...verifiedDuplicates, ...stadium.sourceIds, ...convention.sourceIds, ...nonferrous.sourceIds].sort());
  assert.ok(byLandmark.has('civic-center'));
  assert.ok(byLandmark.has('chunjian'));
  assert.ok(byLandmark.has('convention-center'));
  assert.ok(byLandmark.has('nonferrous-tower'));
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

test('the Nonferrous pilot retires its verified parent only with the complete sourced model', () => {
  const duplicate = { ...byId.get(nonferrous.sourceIds[0]), id: nonferrous.optionalSkipIds[0] };
  const complete = planSzLandmarks([...fixture, duplicate], geo.terrain);
  assert.ok(complete.skipIds.has(duplicate.id));
  assert.equal(complete.skipIds.has('way/1163682853'), false);
  const missing = fixture.filter(b => b.id !== nonferrous.sourceIds[2]);
  const fallback = planSzLandmarks([...missing, duplicate], geo.terrain);
  assert.equal(fallback.skipIds.has(duplicate.id), false);
  assert.ok(nonferrous.sourceIds.every(id => !fallback.skipIds.has(id)));
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

test('DJI reads as two towers: dark core spine, vertical fins, facade V braces and bridge edge beams', () => {
  const actual = byLandmark.get('dji-sky-city');
  // 核心筒和连接件不再用浅灰 djiCore 立面（那会让地标读成几栋白塔），核心筒高度仍是源值。
  assert.equal(actual.some(part => part.style === 'djiCore'), false);
  const spineIds = ['way/1110477862', 'way/1110477866',
    ...dji.sourceIds.filter(id => /way\/11515963(27|28|29|30)/.test(id))];
  const spine = actual.filter(part => spineIds.includes(part.sourceId) && part.style === 'djiGuard');
  assert.ok(spine.length >= 6);
  const fins = actual.filter(part => part.id.includes(':fin:'));
  assert.ok(fins.length >= 48 && fins.every(part => part.style === 'djiBrace' && part.heightSource === 'estimate'));
  // V 撑贴在悬浮块立面上：两根斜杆 + 一根顶横杆。
  const braces = actual.filter(part => part.id.includes(':v-brace:'));
  const crossbars = actual.filter(part => part.id.includes(':crossbar:'));
  assert.ok(braces.length >= 36 && braces.length % 2 === 0);
  assert.equal(crossbars.length, braces.length / 2);
  assert.ok([...braces, ...crossbars].every(part => part.heightSource === 'estimate'));
  // 连桥按图 3 补的边梁、按图 4 补的桁架/护栏带，逐段与桥面同数。
  assert.equal(actual.filter(part => part.id.includes(':bridge-edge-beam:')).length, 44);
  assert.equal(actual.filter(part => part.id.includes(':bridge-guard:')).length, 44);
});

test('DJI takeover retires exactly the 13 sourced objects and keeps every neighbour and data artifact', () => {
  const actual = byLandmark.get('dji-sky-city');
  assert.ok(actual.length > 0);
  // 只退 13 个源对象，邻楼（含围栏外 OSM 楼）和围栏内非 OSM 低矮足迹都不动。
  for (const id of dji.sourceIds) assert.ok(plan.skipIds.has(id), id);
  for (const id of ['way/1081126155', 'way/1152627769', 'way/1081126156', 'way/1081126166', 'way/1081126161']) {
    assert.equal(plan.skipIds.has(id), false, id);
  }
  for (const id of ['globfp/47955', 'globfp/48108', 'globfp/48101', 'overture/9930e54f-66cc-406b-ac59-80266429e177']) {
    assert.equal(plan.skipIds.has(id), false, id);
  }
  const bridge = actual.filter(part => part.sourceId === 'way/1110959408');
  assert.ok(bridge.length > 0);
  // 桥面两端落在源连接件足迹内，且标高在该连接件的源高度区间里（89.75 m 结构长度两端埋进塔体）。
  const deck = actual.filter(part => part.style === 'djiDeck');
  const ends = [[midpoint(deck[0].polygon.outer[0], deck[0].polygon.outer[3]), 'way/1151596329', deck[0].top[0]],
    [midpoint(deck.at(-1).polygon.outer[1], deck.at(-1).polygon.outer[2]), 'way/1151596328', deck.at(-1).top[0]]];
  for (const [point, id, y] of ends) {
    const connector = byId.get(id);
    assert.ok(collision.polygonContains(connector.polygons[0], point.x, point.z));
    const connectorBase = layout.buildingPlacement(connector, geo.terrain).baseY;
    assert.ok(y >= connectorBase + connector.minHeight && y <= connectorBase + connector.height);
  }
});

// 碰撞射线：显示和碰撞出自同一批 parts，用同一组接触面检查墙、柱、连桥底/桥面。
function contactPolygon(part, bottom, top) {
  if (bottom >= part.maxY || top <= part.minY) return null;
  const collider = parts.partCollider(part);
  if (collider.loft) return collision.loftContactPolygon(collider.loft, bottom, top);
  if (collider.verticalSpan) return collision.spanContactPolygon(collider.polygon, collider.verticalSpan, bottom, top);
  if (collider.roofPanel) return collision.roofPanelContactPolygon(collider.roofPanel, bottom, top);
  return collider.polygon;
}
const horizontalHit = (rows, origin, dir, bottom, top, maxDistance = 200) => {
  const polygons = rows.map(part => ({ part, polygon: contactPolygon(part, bottom, top) })).filter(row => row.polygon);
  for (let distance = 0; distance <= maxDistance; distance += 0.02) {
    const x = origin.x + dir.x * distance, z = origin.z + dir.z * distance;
    const row = polygons.find(({ polygon }) => collision.polygonContains(polygon, x, z));
    if (row) return { distance, part: row.part };
  }
  return null;
};
const verticalHit = (rows, x, z, from, to) => {
  const polygons = rows.map(part => ({ part, polygon: contactPolygon(part, from - 1, to + 1) })).filter(row => row.polygon);
  for (let y = from; y <= to; y += 0.02) {
    const row = polygons.find(({ part, polygon }) => y >= part.minY && y <= part.maxY
      && collision.polygonContains(polygon, x, z));
    if (row) return { y, part: row.part };
  }
  return null;
};

test('landmark collision rays hit the displayed walls, columns and bridge under/over sides', () => {
  const pingAnParts = byLandmark.get('ping-an');
  const djiParts = byLandmark.get('dji-sky-city');
  const tower = byId.get(pingAn.sourceIds[0]);
  const base = terrain.terrainHeight(geo.terrain, tower.cx, tower.cz);
  const wall = horizontalHit(pingAnParts, { x: -520, z: tower.cz }, { x: 1, z: 0 }, base + 100, base + 101);
  assert.ok(wall && /:shaft:\d+$/.test(wall.part.id) && Math.abs(wall.distance - (520 + tower.minX)) < 1);
  const column = horizontalHit(pingAnParts, { x: -380, z: 1037.05 }, { x: -1, z: 0 }, base + 100, base + 101);
  assert.ok(column && column.part.id.includes(':mega-column:'));
  // 零售连桥底：竖直射线先命中连桥，而不是塔身或裙房。
  const retail = verticalHit(pingAnParts, -406.8, 1211.3, 0, 80);
  assert.ok(retail && retail.part.sourceId === 'way/773719241');
  // 大疆连桥底净空与桥面实体。
  const under = horizontalHit(djiParts, { x: -11992.15, z: -3760 }, { x: 0, z: -1 }, 132, 132.1, 60);
  assert.equal(under, null);
  const deck = verticalHit(djiParts, -11992.15, -3779.5, 100, 170);
  assert.ok(deck && deck.part.sourceId === 'way/1110959408' && Math.abs(deck.part.minY - deck.y) < 0.5);
  const through = horizontalHit(djiParts, { x: -11992.15, z: -3760 }, { x: 0, z: -1 }, 137.45, 137.55, 60);
  assert.ok(through && through.part.sourceId === 'way/1110959408');
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
  // 0–120 m 保持满宽，所以各段外包宽只能非递增。
  assert.ok(shaft.every((row, i) => i === 0 || width(shaft[i - 1]) >= width(row)));
  assert.ok(Math.abs(shaft[0].maxX - tower.maxX) < 0.5);
  assert.ok(width(shaft[0]) > 76);
  assert.equal(actual.filter(row => /:mega-column:\d:1$/.test(row.id)).length, 8);
  assert.equal(actual.filter(row => row.id.includes(':crown-leg:')).length, 4);
  assert.equal(actual.filter(row => row.id.includes(':crown-skirt:')).length, 8);
  assert.ok(actual.every(row => !occupies(row, tip.cx, tip.cz, base + 581, base + 586)));
  assert.ok(occupies(crown, tip.cx, tip.cz, base + 591, base + 592));
});

test('Ping An profile keeps the base full width to 120 m and folds the crown from the 579 m ring', () => {
  const actual = byLandmark.get('ping-an');
  const tower = byId.get(pingAn.sourceIds[0]);
  const base = terrain.terrainHeight(geo.terrain, tower.cx, tower.cz);
  const ringWidth = ring => Math.max(...ring.map(p => p.x)) - Math.min(...ring.map(p => p.x));
  const shaft = actual.filter(row => row.id.includes(':shaft:'));
  const segmentAt = y => shaft.find(part => Math.abs(part.minY - Math.fround(base + y)) < 1e-6);
  // 收分折线：0–120 满宽；120→407 62.7；407→467 52.8；467→543.6 47.79；543.6→555.6 47.0；555.6→579 44.35。
  assert.ok(Math.abs(ringWidth(segmentAt(22).loft.lower) - 76.5) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(120).loft.upper) - 62.7) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(467).loft.upper) - 47.79) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(543.6).loft.upper) - 47) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(555.6).loft.upper) - 46.26) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(562.1).loft.upper) - 45.63) < 0.01);
  assert.ok(Math.abs(ringWidth(segmentAt(567.65).loft.upper) - 44.35) < 0.01);
  // 顶冠从 579 m 折面环连续收到 599.1 m 平顶，冠高 20.1 m，不再是 9 m 小钻石。
  const crown = actual.find(row => row.id.endsWith(':diamond-crown'));
  assert.equal(crown.minY, Math.fround(base + 590));
  assert.ok(Math.abs(ringWidth(crown.loft.lower) - 26.59) < 0.01);
  assert.ok(Math.abs(ringWidth(crown.loft.upper) - 11.9) < 0.01);
  const skirts = actual.filter(row => row.id.includes(':crown-skirt:'));
  assert.equal(skirts.length, 8);
  assert.ok(skirts.every(row => Math.abs(row.maxY - Math.fround(base + 590)) < 1e-6
    && Math.abs(row.minY - Math.fround(base + 579 - 1.2)) < 1e-6 && row.roofContact === false));
  // 8 根巨柱分 5 段从地面通到冠底，柱面与塔身同一收分折线。
  const columns = actual.filter(row => row.id.includes(':mega-column:'));
  assert.equal(columns.length, 40);
  assert.equal(columns.filter(row => row.minY === Math.fround(base)).length, 8);
  assert.equal(columns.filter(row => row.maxY === Math.fround(base + 579)).length, 8);
  // 显示与碰撞同源：塔身中段实心、塔外空；巨柱位置可碰撞；桥下街道净空。
  assert.ok(actual.some(row => occupies(row, tower.cx, tower.cz, base + 40, base + 41)));
  assert.ok(actual.every(row => !occupies(row, tower.cx + 60, tower.cz, base + 40, base + 41)));
  const column = columns[0];
  const columnCenter = column.polygon.outer.reduce((sum, p) => ({ x: sum.x + p.x / column.polygon.outer.length,
    z: sum.z + p.z / column.polygon.outer.length }), { x: 0, z: 0 });
  assert.ok(occupies(column, columnCenter.x, columnCenter.z, base + 100, base + 101));
  assert.ok(actual.every(row => !occupies(row, columnCenter.x, columnCenter.z, base + 580, base + 581)));
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
test('UpperHills registration replaces exactly its source footprints and leaves the surroundings', { skip: !threePackageDir }, async () => {
  const THREE = await import(new URL('build/three.webgpu.js', pathToFileURL(join(threePackageDir, '/'))));
  const { planSzLandmarks } = loadPlan(culture, loadUpperhills(THREE));
  const snapshot = buildings.filter(building => !culture.sourceIds.includes(building.id));
  const complete = planSzLandmarks(snapshot, geo.terrain);
  assert.ok(complete.plans.some(row => row.id === 'upperhills' && row.parts.length > 0));
  assert.ok(upperhills.sourceIds.every(id => complete.skipIds.has(id)));
  assert.equal(complete.skipIds.has('way/1431501352'), false);
  assert.equal(complete.skipIds.has('globfp/30143'), false);
  const incomplete = planSzLandmarks(snapshot.filter(building => building.id !== 'way/684494959'), geo.terrain);
  assert.equal(incomplete.plans.some(row => row.id === 'upperhills'), false);
  assert.ok(upperhills.sourceIds.every(id => !incomplete.skipIds.has(id)));
});

test('Culture Square replaces its source box with nine distinct stone volumes and a court-cut landscaped deck',
  { skip: !threePackageDir }, async () => {
    const THREE = await import(new URL('build/three.webgpu.js', pathToFileURL(join(threePackageDir, '/'))));
    const museum = loadCulture(THREE);
    const { planSzLandmarks } = loadPlan(museum, loadUpperhills(THREE));
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

test('site-only landmarks join the plan with their verified sites and retire their stale footprints', () => {
  // fixture 排除 culture/upperhills 源对象，避免用空 THREE stub 触发它们的几何构建。
  const withSites = planSzLandmarks(fixture, geo.terrain, geo.sites);
  const plans = new Map(withSites.plans.map(landmark => [landmark.id, landmark.parts]));
  assert.ok(plans.has('iec-xiangmihu') && plans.get('iec-xiangmihu').length > 0);
  assert.ok(plans.has('super-hq') && plans.get('super-hq').length > 0);
  const iecSkips = iec.optionalSkipIds.filter(id => byId.has(id));
  const superSkips = superHq.optionalSkipIds.filter(id => byId.has(id));
  assert.ok(iecSkips.length > 0 && superSkips.length > 0, 'stale generic footprints exist in the snapshot');
  for (const id of [...iecSkips, ...superSkips]) assert.ok(withSites.skipIds.has(id), id);
  // 没有 sites 时退回空计划，不能凭地标 id 造体量。
  const withoutSites = planSzLandmarks(fixture, geo.terrain);
  assert.equal(withoutSites.plans.some(landmark => landmark.id === 'super-hq'), false);
  assert.equal(withoutSites.plans.some(landmark => landmark.id === 'iec-xiangmihu'), false);
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('new site landmarks build and render through the shared material dispatcher', { skip: !threeDir }, async () => {
  const packageUrl = pathToFileURL(join(threeDir, '/'));
  const THREE = await import(new URL('build/three.webgpu.js', packageUrl));
  const tsl = await import(new URL('build/three.tsl.js', packageUrl));
  const atmosphere = { sceneUniforms: { night: tsl.uniform(0), show: tsl.uniform(0), apec: tsl.uniform(0) } };
  const iecModel = loadIec(THREE, tsl, atmosphere);
  const superModel = loadSuperHq(THREE, tsl, atmosphere);
  const materials = loadModule(readLandmark('materials.js'), { imports: {
    'three/webgpu': THREE, 'three/tsl': tsl, '../sz-materials.js': atmosphere,
    './shenzhen-bay-culture-square.js': { createCulturePavingMask: () => ({}) },
    './upperhills.js': { createUpperhillsMaterial: () => new THREE.MeshBasicMaterial() },
    './nonferrous-tower.js': { createNonferrousMaterial: () => new THREE.MeshBasicMaterial() },
    './iec-xiangmihu.js': iecModel, './super-hq.js': superModel
  } });
  const { renderLandmark } = loadModule(readLandmark('render.js'), { imports: {
    'three/webgpu': THREE, '../sz-geometry.js': loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } })
  } });
  const planWithSites = planSzLandmarks(fixture, geo.terrain, geo.sites);
  for (const landmarkId of ['iec-xiangmihu', 'super-hq']) {
    const plan = planWithSites.plans.find(item => item.id === landmarkId);
    assert.ok(plan, landmarkId);
    const rendered = renderLandmark(plan, materials.createLandmarkMaterial);
    assert.ok(rendered.group.children.length > 0, `${landmarkId} renders meshes`);
    let triangles = 0;
    rendered.group.traverse(mesh => {
      const geometry = mesh.geometry;
      if (!geometry) return;
      const position = geometry.getAttribute('position');
      assert.ok(position.count > 0 && Number.isFinite(position.getX(0)), `${landmarkId} geometry is finite`);
      triangles += (geometry.index ? geometry.index.count : position.count) / 3;
      if (mesh.material?.dispose) mesh.material.dispose();
    });
    assert.ok(triangles > 0 && triangles < 300000, `${landmarkId} triangle budget: ${triangles}`);
    rendered.group.traverse(mesh => mesh.geometry?.dispose());
  }
});
