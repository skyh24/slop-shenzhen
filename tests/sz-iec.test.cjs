const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const terrain = loadModule(read('sz-terrain.js'));
const placement = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const partsApi = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
// 纯几何/布点测试不需要真实 THREE；材质构造函数只在 THREE 用例里触达。
const iec = loadModule(read('sz-landmarks/iec-xiangmihu.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': {}, '../sz-materials.js': { sceneUniforms: {} },
  '../sz-terrain.js': terrain, './parts.js': partsApi
} });
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const payload = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const { geo, buildings } = decodeCityPayload(payload);
const source = new Map(buildings.map(row => [row.id, row]));
const sites = geo.sites['iec-xiangmihu'];
const sitePolygon = sites.site.polygons[0];
const lakePolygon = sites.lake.polygons[0];
const model = iec.build(source, geo.terrain, { sites });

const segDistance = (p, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
};
const ringDistance = (ring, p) => {
  let distance = Infinity;
  for (let i = 0; i < ring.length; i++) distance = Math.min(distance, segDistance(p, ring[i], ring[(i + 1) % ring.length]));
  return distance;
};
// 外环顶点：普通体量用 polygon.outer，loft 还要检查两圈截面，屋面用三角顶点。
const partVertices = part => {
  const points = [...part.polygon.outer];
  if (part.loft) points.push(...part.loft.lower, ...part.loft.upper);
  if (part.roofPanel) points.push(...part.roofPanel.outer);
  return points;
};
const outsideDistance = (polygon, p) => collision.polygonContains(polygon, p.x, p.z) ? 0 : ringDistance(polygon.outer, p);

test('IEC venue builds deterministic estimate volumes on the reviewed Xiangmi Lake site', () => {
  assert.ok(model.length >= 25, `expected a campus, got ${model.length} parts`);
  assert.ok(model.length < 300, `part budget exceeded: ${model.length}`);
  assert.equal(new Set(model.map(part => part.id)).size, model.length);
  assert.equal(iec.sourceIds.length, 7);
  assert.ok(iec.sourceIds.every(id => source.has(id)));
  assert.ok(iec.optionalSkipIds.length > 0);
  for (const id of iec.optionalSkipIds) assert.equal(source.has(id), !id.startsWith('globfp/'), id);
  const styles = new Set(model.map(part => part.style));
  assert.ok(styles.size < 8, `material budget exceeded: ${[...styles]}`);
  assert.ok([...styles].every(style => iec.IEC_STYLES.includes(style)));
  assert.deepEqual(new Set(model.map(part => part.sourceId)), new Set(iec.sourceIds));
  for (const part of model) {
    assert.ok(['estimate', 'design'].includes(part.heightSource), part.id);
    assert.equal(part.baseSourceId, part.sourceId);
    assert.ok(['osm-footprint', 'derived'].includes(part.layoutSource), part.id);
    assert.ok(Number.isFinite(part.minY) && Number.isFinite(part.maxY) && part.maxY > part.minY, part.id);
    assert.ok(part.polygon.outer.length >= 3);
  }
  // 同一输入两次构建必须完全一致（无随机数，全部由常量与 DSM 采样决定）。
  assert.deepEqual(iec.build(source, geo.terrain, { sites }), model);
});

test('IEC campus stays on the site, off the lake and keeps the reviewed containment', () => {
  let maxOutside = 0;
  for (const part of model) {
    for (const vertex of partVertices(part)) {
      assert.ok(Number.isFinite(vertex.x) && Number.isFinite(vertex.z), `${part.id} has non-finite vertex`);
      // 要求：所有部件落在场地多边形外扩 10 m 以内。
      assert.ok(outsideDistance(sitePolygon, vertex) <= 10, `${part.id} leaves the site by more than 10 m`);
      maxOutside = Math.max(maxOutside, outsideDistance(sitePolygon, vertex));
      // 水面由 sz-sea.js 渲染：任何体量顶点都不能落进香蜜湖。
      assert.equal(collision.polygonContains(lakePolygon, vertex.x, vertex.z), false, `${part.id} enters the lake`);
    }
  }
  assert.ok(maxOutside < 1, `campus should stay inside the site outline, got ${maxOutside.toFixed(2)} m`);
  // 入口广场可以贴岸，但不能起在水里：边界离湖 23 m 以上，广场到湖岸的距离必须为正。
  assert.ok(ringDistance(lakePolygon.outer, iec.entry) > 20);
});

test('IEC massing heights are explicitly estimated and consistent with colliders', () => {
  const heights = model.map(part => {
    const cx = (part.minX + part.maxX) / 2, cz = (part.minZ + part.maxZ) / 2;
    const ground = terrain.terrainHeight(geo.terrain, cx, cz);
    assert.ok(Number.isFinite(ground), `${part.id} has no terrain sample`);
    return part.maxY - ground;
  });
  const tallest = Math.max(...heights);
  assert.ok(tallest <= 107, `tallest estimated volume ${tallest.toFixed(1)} m exceeds 107 m`);
  assert.ok(tallest >= 15, `tallest estimated volume ${tallest.toFixed(1)} m is implausibly low`);
  assert.ok(Math.max(...model.map(part => part.maxY)) < 124);
  for (const part of model) {
    const collider = partsApi.partCollider(part);
    assert.equal(collider.minY, part.minY);
    assert.equal(collider.maxY, part.maxY);
    assert.equal(collider.polygon, part.polygon);
    assert.equal(collider.heightSource, part.heightSource);
    assert.ok(collider.maxY > collider.minY);
  }
});

test('IEC entrance faces Hongli West Road and its columns are grounded outside the closed hall', () => {
  const canopy = model.find(part => part.id.includes('entry:canopy'));
  const columns = model.filter(part => part.id.includes('entry:column'));
  assert.equal(columns.length, 4);
  assert.ok(Math.cos(iec.entry.yaw) > 0.9);
  const portal = iec.entryPoint(0, 8.5);
  assert.ok(collision.polygonContains(canopy.polygon, portal.x, portal.z));
  assert.ok(columns.every(part => !collision.polygonContains(part.polygon, portal.x, portal.z)));
  for (const column of columns) {
    const y = terrain.terrainHeight(geo.terrain, (column.minX + column.maxX) / 2, (column.minZ + column.maxZ) / 2);
    assert.ok(y - column.minY > 0.2 && y - column.minY < 0.3, column.id);
    assert.ok(Math.abs(canopy.minY - column.maxY) < 0.1, column.id);
  }
});

test('IEC venue degrades to an empty plan without site data instead of throwing', () => {
  // loadModule 在 vm 沙箱里求值，空数组是另一个 realm 的 Array，只能比长度。
  assert.equal(iec.build(source, geo.terrain, {}).length, 0);
  assert.equal(iec.build(source, geo.terrain, { sites: {} }).length, 0);
  assert.equal(iec.build(source, geo.terrain, { sites: { site: { polygons: [] } } }).length, 0);
  assert.equal(iec.build(source, null, { sites }).length, 0);
  assert.equal(iec.build(null, geo.terrain).length, 0);
});

const threePackageDir = process.env.SZ_THREE_PACKAGE_DIR;

test('real Three draws the IEC campus within part, triangle and material budgets',
  { skip: !threePackageDir }, async () => {
    const url = pathToFileURL(join(threePackageDir, '/'));
    const THREE = await import(new URL('build/three.webgpu.js', url));
    const tsl = await import(new URL('build/three.tsl.js', url));
    const imports = { 'three/webgpu': THREE, 'three/tsl': tsl };
    const realIec = loadModule(read('sz-landmarks/iec-xiangmihu.js'), { imports: {
      ...imports, '../sz-materials.js': { sceneUniforms: { night: tsl.uniform(0) } },
      '../sz-terrain.js': terrain, './parts.js': partsApi
    } });
    const geometry = loadModule(read('sz-geometry.js'), { imports });
    const render = loadModule(read('sz-landmarks/render.js'), {
      imports: { ...imports, '../sz-geometry.js': geometry }
    });
    assert.throws(() => realIec.createIecMaterial('iecEmblem'), /Unknown IEC material/);
    const { group, surfaces } = render.renderLandmark({ id: 'iec-xiangmihu', parts: model },
      name => realIec.createIecMaterial(name));
    group.updateMatrixWorld(true);
    try {
      assert.equal(group.children.length, new Set(model.map(part => part.style)).size);
      assert.ok(group.children.every(mesh => realIec.IEC_STYLES.includes(mesh.name)));
      assert.equal(surfaces.length, 0);
      let triangles = 0;
      for (const mesh of group.children) {
        assert.ok(mesh.material.isMeshStandardNodeMaterial, `${mesh.name} material`);
        const { index, attributes: { position, normal } } = mesh.geometry;
        assert.ok(position.count > 0 && index.count % 3 === 0);
        assert.ok([...position.array].every(Number.isFinite), `${mesh.name} positions`);
        assert.ok([...normal.array].every(Number.isFinite), `${mesh.name} normals`);
        triangles += index.count / 3;
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        for (let i = 0; i < index.count; i += 3) {
          a.fromBufferAttribute(position, index.getX(i));
          b.fromBufferAttribute(position, index.getX(i + 1)).sub(a);
          c.fromBufferAttribute(position, index.getX(i + 2)).sub(a);
          assert.ok(b.cross(c).lengthSq() > 1e-12, `degenerate triangle in ${mesh.name}`);
        }
      }
      assert.ok(triangles > 500 && triangles < 150000, `triangle budget: ${triangles}`);
    } finally {
      for (const mesh of group.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    }
  });
