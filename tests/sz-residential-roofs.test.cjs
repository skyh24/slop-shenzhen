const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');
const root = join(__dirname, '..');
const read = name => readFileSync(join(root, 'js', `${name}.js`), 'utf8');
const polygon = loadModule(read('sz-polygon'));
const collision = loadModule(read('building-collision'), { imports: { './sz-polygon.js': polygon } });
const contact = loadModule(read('sz-controller-surfaces'));

for (const [kind, seed] of [['gable', 0], ['hipped', 0.002], ['terrace', 0.003]]) {
  test(`${kind} villa roof shares sloped render, support and collision geometry and preserves courtyards`,
    { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
      const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
      const geometry = loadModule(read('sz-geometry'), { imports: { 'three/webgpu': THREE } });
      const outer = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 12 }, { x: 0, z: 12 }];
      const hole = [{ x: 8, z: 5 }, { x: 12, z: 5 }, { x: 12, z: 7 }, { x: 8, z: 7 }];
      const shape = { outer, holes: [hole] };
      const roof = geometry.planResidentialRoof(shape, 8, 19.4, seed);
      assert.equal(roof.kind, kind);
      const batch = new geometry.GeoBuilder();
      for (const triangle of roof.triangles) geometry.addSolidTriangle(batch, triangle);
      const triangles = geometry.readTriangles(batch, 0);
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(batch.build(), new THREE.MeshBasicMaterial()));
      scene.updateMatrixWorld(true);
      const resolver = contact.createSurfaceResolver({ groundHeight: () => 8,
        surfaces: [{ id: 'villa-roof', heightSource: 'estimate', triangles }] });
      let tested = 0;
      for (let x = 0.613; x < 20; x += 1.117) for (let z = 0.619; z < 12; z += 1.073) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObjects(scene.children)[0];
        if (!polygon.polygonContains(shape, x, z)) { assert.equal(hit, undefined); continue; }
        tested++;
        assert.ok(hit);
        assert.ok(Math.abs(resolver.below(x, z, 30).height - hit.point.y) < 1e-5);
        const triangle = triangles.find(t => contact.triangleHeight(t, x, z) !== null);
        const panel = { outer: triangle.map(({ x, z }) => ({ x, z })),
          bottom: triangle.map(() => roof.eaveY), top: triangle.map(p => p.y) };
        const above = collision.roofPanelContactPolygon(panel, hit.point.y, hit.point.y + 0.5);
        assert.ok(!above || !polygon.polygonContains(above, x, z), 'no invisible roof volume above the actual slope');
        if (hit.point.y > roof.eaveY + 0.02) {
          const inside = collision.roofPanelContactPolygon(panel, hit.point.y - 0.02, hit.point.y + 0.02);
          assert.ok(inside && polygon.polygonContains(inside, x, z));
        }
      }
      assert.ok(tested > 150);
      assert.ok(triangles.flat().every(p => p.y >= roof.eaveY - 1e-5 && p.y <= 19.4 + 1e-5));
      assert.equal(resolver.below(10, 6, 30).height, 8);
    });
}

test('ordinary building assembly uses the villa envelope for the roof, body, details and collision',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const geometry = loadModule(read('sz-geometry'), { imports: { 'three/webgpu': THREE } });
    const terrain = loadModule(read('sz-terrain'));
    const layout = loadModule(read('sz-building-layout'), { imports: { './sz-terrain.js': terrain } });
    const { buildCityBlocks } = loadModule(read('sz-buildings'), { imports: {
      'three/webgpu': THREE, './sz-geodata.js': {}, './sz-geometry.js': geometry,
      './sz-materials.js': { createBuildingMaterial: () => new THREE.MeshBasicMaterial() },
      './sz-building-layout.js': layout, './sz-building-plan.js': loadModule(read('sz-building-plan')),
      './sz-facade-profiles.js': loadModule(read('sz-facade-profiles')),
      './sz-building-envelope.js': { createBuildingEnvelopePlan: () => ({ envelopes: new Map(), duplicateIds: new Map() }) },
      './sz-polygon.js': polygon, './sz-retail-frontage.js': {}, './building-collision.js': collision,
      './sz-roads.js': { visitGroundRoadFootprints: () => {} }
    } });
    const outer = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 12 }, { x: 0, z: 12 }];
    const source = { id: 'villa-fixture', cx: 10, cz: 6, minX: 0, maxX: 20, minZ: 0, maxZ: 12,
      height: 11.4, minHeight: 0, heightSource: 'estimate', facade: 'villa', category: 'residential',
      role: 'main', polygons: [{ outer, holes: [] }] };
    const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 0.1, heights: [80, 80, 80, 80] };
    const scene = new THREE.Scene();
    const blocks = buildCityBlocks(scene, { buildings: [source], terrain: grid });
    scene.updateMatrixWorld(true);
    assert.ok(blocks.detailPlan.skipIds.has(source.id));
    const roofPanels = blocks.colliders.filter(row => row.roofPanel);
    assert.ok(roofPanels.length > 0);
    const resolver = contact.createSurfaceResolver({ groundHeight: () => 8, surfaces: blocks.surfaces });
    for (const [x, z] of [[2, 2], [10, 6], [18, 10]]) {
      const hit = new THREE.Raycaster(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0))
        .intersectObjects(blocks.group.children)[0];
      assert.ok(Math.abs(hit.point.y - resolver.below(x, z, 30).height) < 1e-5);
    }
    assert.equal(source.height, 11.4);
    assert.ok(blocks.colliders.find(row => row.type === 'building').maxY < 19.4);
    assert.ok(roofPanels.every(row => row.heightSource === 'design'));
    blocks.dispose();
  });
