const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
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
const doc = readFileSync(join(__dirname, '../docs/landmarks/civic-center.md'), 'utf8');
const { roofDetail, colonnadeSpec } = civic;

function heightAt(part, x, z) {
  const { outer, top } = part.roofPanel;
  return triangleHeight(outer.map((p, i) => ({ ...p, y: top[i] })), x, z);
}

function canopyAt(x, z) {
  return canopy.find(row => x >= row.minX && x <= row.maxX && z >= row.minZ && z <= row.maxZ
    && heightAt(row, x, z) !== null);
}

// 与渲染三角面同源的屋面高度查询：肋和柱顶的贴合检查直接量最终会画出来的那片曲面。
const canopyTriangles = canopy.map(row => ({
  outer: row.roofPanel.outer, top: row.roofPanel.top, bottom: row.roofPanel.bottom,
  minX: row.minX, maxX: row.maxX, minZ: row.minZ, maxZ: row.maxZ
}));

function canopySurfaceAt(x, z) {
  for (const triangle of canopyTriangles) {
    if (x < triangle.minX || x > triangle.maxX || z < triangle.minZ || z > triangle.maxZ) continue;
    const vertices = triangle.outer.map((p, i) => ({ x: p.x, z: p.z, top: triangle.top[i], bottom: triangle.bottom[i] }));
    const [a, b, c] = vertices;
    const determinant = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(determinant) < 1e-10) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / determinant;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / determinant;
    const w = 1 - u - v;
    if (Math.min(u, v, w) < -1e-7) continue;
    return { top: u * a.top + v * b.top + w * c.top, bottom: u * a.bottom + v * b.bottom + w * c.bottom };
  }
  return null;
}

// 斜梁/肋两端的中心点与上表面高度：spanPart 的 outer 顺序是 [a-宽/2, b-宽/2, b+宽/2, a+宽/2]。
function spanCenters(part) {
  const [a0, b0, b1, a1] = part.polygon.outer;
  return [{ x: (a0.x + a1.x) / 2, z: (a0.z + a1.z) / 2, y: part.top[0] },
    { x: (b0.x + b1.x) / 2, z: (b0.z + b1.z) / 2, y: part.top[1] }];
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

test('Civic Center roof ribs and eave fascia hug the rendered canopy below the 80 m apex', () => {
  const ribs = model.filter(row => row.id.includes(':rib:'));
  const eaves = model.filter(row => row.id.includes(':eave:'));
  assert.ok(ribs.length > 0);
  assert.ok(eaves.length > 0);
  // 新增细部的宽深/间距是照片判读估计，不是实测。
  assert.ok(ribs.every(row => row.heightSource === 'estimate' && row.layoutSource === 'derived'));
  assert.ok(eaves.every(row => row.heightSource === 'estimate' && row.layoutSource === 'derived'));
  // 屋盖最高点仍由 base+80 的曲面决定；肋只抬高 6 cm，含肋也不越 0.15 m 容差。
  const apex = Math.max(...canopy.map(row => row.maxY));
  assert.ok(Math.abs(apex - (base + 80)) < 0.15);
  assert.ok(Math.max(...ribs.map(row => row.maxY)) <= base + 80 + 0.15);
  // 纵肋的等 v 线数量和横肋间距必须等于模块常量，模型卡写同一组数。
  const longitudinal = [...new Set(ribs.filter(row => row.id.includes(':rib:long:'))
    .map(row => Number(row.id.split(':')[3])))].sort((a, b) => a - b);
  assert.deepEqual(longitudinal, [...roofDetail.longitudinalV].sort((a, b) => a - b));
  const stations = [...new Set(ribs.filter(row => row.id.includes(':rib:cross:'))
    .map(row => Number(row.id.split(':')[3])))].sort((a, b) => a - b);
  assert.ok(stations.length >= 10);
  for (let i = 1; i < stations.length; i++) {
    assert.equal(stations[i] - stations[i - 1], roofDetail.transverseSpacing);
  }
  // 每根肋的两个端点按渲染三角面取高，只留 2 cm 的浮点/采样余量。
  let checked = 0;
  for (const rib of ribs) {
    for (const end of spanCenters(rib)) {
      const surface = canopySurfaceAt(end.x, end.z);
      assert.ok(surface, `rib endpoint off canopy: ${rib.id}`);
      assert.ok(Math.abs(end.y - (surface.top + roofDetail.ribLift)) < 0.02, rib.id);
      checked++;
    }
  }
  assert.ok(checked > 500);
  // 通长檐口：断面宽深与常量一致，且压在屋盖边缘（外轮廓与四处采光开口）上。
  for (const eave of eaves) {
    eave.polygon.outer.forEach((point, i) => {
      assert.ok(Math.abs(eave.top[i] - eave.bottom[i] - roofDetail.eaveDepth) < 1e-3, eave.id);
    });
    const width = Math.hypot(eave.polygon.outer[0].x - eave.polygon.outer[3].x,
      eave.polygon.outer[0].z - eave.polygon.outer[3].z);
    assert.ok(Math.abs(width - roofDetail.eaveWidth) < 1e-3, eave.id);
  }
  assert.ok(new Set(eaves.map(row => row.sourceId)).size >= 9);
  assert.ok(doc.includes(`横肋间距 ${roofDetail.transverseSpacing} m`));
  assert.ok(doc.includes(`檐口收边板宽 ${roofDetail.eaveWidth} m`));
  assert.ok(doc.includes(`深 ${roofDetail.eaveDepth} m`));
});

test('Civic Center colonnade stands on both wings and meets the canopy underside', () => {
  const stems = model.filter(row => row.id.includes(':colonnade:') && row.id.endsWith(':stem'));
  const branches = model.filter(row => row.id.includes(':colonnade:') && row.id.includes(':branch:'));
  assert.equal(stems.length, colonnadeSpec.groupsPerWing * 2);
  // 柱位/断面/分枝为估计；显示与碰撞同源。
  assert.ok(stems.every(row => row.heightSource === 'estimate' && row.layoutSource === 'derived' && row.loft));
  assert.ok(branches.every(row => row.heightSource === 'estimate' && Array.isArray(row.top)));
  for (const wingId of ['relation/10837976', 'relation/10837977']) {
    const wing = sources.get(wingId);
    const wingY = placement.buildingPlacement(wing, geo.terrain).baseY + wing.height;
    const wingStems = stems.filter(row => row.sourceId === wingId);
    assert.equal(wingStems.length, colonnadeSpec.groupsPerWing);
    for (const stem of wingStems) {
      // 柱底落在翼楼屋面结构面上，不悬空。
      assert.ok(Math.abs(stem.minY - wingY) < 0.02, stem.id);
      const cx = stem.loft.lower.reduce((sum, point) => sum + point.x, 0) / stem.loft.lower.length;
      const cz = stem.loft.lower.reduce((sum, point) => sum + point.z, 0) / stem.loft.lower.length;
      assert.ok(wing.polygons.some(polygon => collision.polygonContains(polygon, cx, cz)), stem.id);
      const surface = canopySurfaceAt(cx, cz);
      assert.ok(surface, stem.id);
      // 翼楼屋面到屋盖下皮必须留出分枝空间；主干顶在空隙中部，低于屋盖下皮。
      assert.ok(surface.bottom - wingY >= colonnadeSpec.minClearance - 0.01, stem.id);
      assert.ok(stem.maxY < surface.bottom, stem.id);
      assert.ok(stem.maxY > wingY + 1, stem.id);
      const prefix = stem.id.replace(/:stem$/, ':branch:');
      assert.ok(branches.filter(row => row.id.startsWith(prefix)).length >= 2, stem.id);
    }
  }
  // 分枝顶与屋盖下皮相接：contact 约定 0.10 m，容差取 0.11 m（只留浮点余量，渲染与接触同源）。
  for (const branch of branches) {
    const end = spanCenters(branch)[1];
    const surface = canopySurfaceAt(end.x, end.z);
    assert.ok(surface, branch.id);
    assert.ok(Math.abs(end.y - surface.bottom) <= 0.11, branch.id);
  }
  // 中跨保持通透：新增的柱廊、肋、檐口都不在中跨形成实心体。
  const x = 1.2, z = 4.5;
  const plaza = model.find(row => row.sourceId === platform.id);
  const added = model.filter(row => row.id.includes(':colonnade:') || row.id.includes(':rib:')
    || row.id.includes(':eave:'));
  assert.ok(added.every(row => row.minY > plaza.maxY + 1.9
    || !collision.polygonContains(row.polygon, x, z)));
  assert.ok(doc.includes(`${colonnadeSpec.groupsPerWing} 组`));
  assert.ok(doc.includes(`接触量 ${colonnadeSpec.contact} m`));
});
