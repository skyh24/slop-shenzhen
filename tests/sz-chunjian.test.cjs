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
const parts = loadModule(read('sz-landmarks/parts.js'), { imports: {
  '../building-collision.js': collision, '../sz-building-layout.js': placement
} });
const chunjian = loadModule(read('sz-landmarks/chunjian.js'), { imports: {
  './parts.js': parts, '../building-collision.js': collision, '../sz-terrain.js': terrain
} });
const groundSurface = loadModule(read('sz-ground-surface.js'));
const { triangleHeight } = loadModule(read('sz-controller-surfaces.js'));
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings, geo } = decodeCityPayload(JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz')))));
const review = JSON.parse(readFileSync(join(__dirname, '../data/source/terrain-exclusions.json'), 'utf8')).chunjian;
const sources = new Map(buildings.map(row => [row.id, row]));
const model = chunjian.build(sources, geo.terrain, { sites: geo.sites.chunjian });
const stadium = sources.get('relation/9244350');
const concourse = sources.get('relation/9244351');
const base = terrain.terrainHeight(geo.terrain, stadium.cx, stadium.cz);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const asPoint = ([x, z]) => ({ x, z });
const maskCenter = ({ boundsXZ: [west, north, east, south] }) => midpoint(asPoint([west, north]), asPoint([east, south]));
const polygonEdges = ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);

function hallSolid(sourceId) {
  const hull = model.find(part => part.id === `chunjian:hull:${sourceId}:0`);
  const dome = model.filter(part => part.id.startsWith(`chunjian:dome:${sourceId}:`));
  return { hull, dome };
}

function roofAt(panels, { x, z }) {
  return panels.map(({ outer, top }) => triangleHeight(outer.map((p, i) => ({ ...p, y: top[i] })), x, z))
    .find(y => y !== null);
}

function occupies(part, x, z, lo, hi) {
  if (hi <= part.minY || lo >= part.maxY) return false;
  const collider = parts.partCollider(part);
  let polygon = collider.polygon;
  if (collider.loft) polygon = collision.loftContactPolygon(collider.loft, lo, hi);
  else if (collider.roofPanel) polygon = collision.roofPanelContactPolygon(collider.roofPanel, lo, hi);
  else if (collider.verticalSpan) polygon = collision.spanContactPolygon(polygon, collider.verticalSpan, lo, hi);
  return polygon !== null && collision.polygonContains(polygon, x, z);
}

test('Chunjian ties the four sourced shell pieces to the open field datum', () => {
  assert.ok(chunjian.sourceIds.every(id => model.some(part => part.sourceId === id)));
  const sourced = model.filter(row => chunjian.sourceIds.includes(row.sourceId));
  assert.ok(sourced.every(row => row.baseSourceId === stadium.id
    && row.sourceHeight === sources.get(row.sourceId).height && row.heightSource === 'estimate'));
  // 园区广场和西入口以 OSM 场地 way/542049855 为源，不冒充四栋建筑的源高。
  const site = model.filter(row => row.sourceId === 'way/542049855');
  assert.ok(site.length > 100);
  assert.ok(site.every(row => row.baseSourceId === stadium.id
    && row.sourceHeight === 0 && row.heightSource === 'estimate'));
  const crest = Math.max(...model.map(part => part.maxY));
  assert.ok(Math.abs(crest - base - 42.3) < 0.05);
  for (const hall of ['way/665408866', 'way/665408865']) {
    const source = sources.get(hall);
    const hull = model.find(part => part.style === 'stadiumGlazing' && part.sourceId === hall);
    const dome = model.filter(part => part.id.startsWith(`chunjian:dome:${hall}:`));
    assert.ok(hull.polygon.outer.every(p => collision.polygonContains(source.polygons[0], p.x, p.z)));
    assert.equal(hull.minY, Math.fround(base));
    assert.ok(Math.max(...dome.map(part => part.maxY)) - Math.min(...dome.map(part => part.maxY)) > 4);
  }
});

test('Chunjian leaves both apertures clear and crosses real diagonal ribs', () => {
  for (const hole of [stadium, concourse].map(source => source.polygons[0].holes[0])) {
    const center = hole.reduce((p, q) => ({ x: p.x + q.x / hole.length, z: p.z + q.z / hole.length }), { x: 0, z: 0 });
    assert.ok(model.every(part => !occupies(part, center.x, center.z, base + 0.25, base + 43)));
  }
  const ribs = model.filter(part => part.id.startsWith('chunjian:rib:'));
  const directions = new Set(ribs.map(part => {
    const ring = part.polygon.outer;
    const a = midpoint(ring[0], ring[3]), b = midpoint(ring[1], ring[2]);
    return Math.round((b.z - a.z) / (b.x - a.x));
  }));
  assert.ok(ribs.length > 1000);
  assert.deepEqual([...directions].sort(), [-1, 1]);
  const rib = ribs.find(part => Math.abs(part.top[0] - part.top[1]) > 1);
  const ring = rib.polygon.outer;
  const center = midpoint(ring[0], ring[2]);
  const top = (rib.top[0] + rib.top[1]) / 2;
  assert.ok(occupies(rib, center.x, center.z, top - 0.3, top - 0.1));
  assert.ok(!occupies(rib, center.x, center.z, top - 2, top - 1));
});

test('Chunjian retains a climb-free span over the Sea Gate and the visible bridge deck collider', () => {
  const deck = model.filter(part => part.id.startsWith('chunjian:sea-gate-deck:'));
  assert.equal(deck.length, 14);
  assert.ok(deck.every(part => part.roofContact));
  const piers = model.filter(part => part.id.startsWith('chunjian:sea-gate-pier:'));
  assert.ok(Math.abs(piers[1].minZ - piers[0].maxZ - 103) < 0.001);
  const bridge = deck[6];
  const center = midpoint(bridge.polygon.outer[0], bridge.polygon.outer[2]);
  const height = (bridge.top[0] + bridge.top[1]) / 2;
  assert.ok(height > base + 29.5);
  assert.ok(occupies(bridge, center.x, center.z, height - 0.7, height - 0.2));
  const ground = terrain.terrainHeight(geo.terrain, center.x, center.z);
  assert.ok(model.every(part => !occupies(part, center.x, center.z, ground, ground + 2)));
});

test('Chunjian can decline replacement when a source opening is missing', () => {
  const partial = new Map(sources);
  partial.set(stadium.id, { ...stadium, polygons: [{ outer: stadium.polygons[0].outer, holes: [] }] });
  assert.equal(chunjian.build(partial, geo.terrain).length, 0);
});

test('Chunjian DSM cuts lie strictly inside the enclosed collision hulls and capped roof projections', () => {
  const { exclusions, heightSource } = geo.terrainSurface;
  assert.equal(heightSource, geo.terrain.processing.heightSource);
  assert.equal(geo.terrain.processing.urbanDatum?.sourceHeightSource ?? heightSource, 'copernicus-glo30-dsm');
  assert.deepEqual(exclusions.map(mask => mask.sourceId), [...chunjian.sourceIds].slice(0, 2));
  for (const mask of exclusions) {
    assert.equal(mask.interiorGround, 'unknown');
    assert.ok(mask.nearestSourceRoute.distanceM > 8);
    const { hull, dome } = hallSolid(mask.sourceId);
    const volume = parts.partCollider(hull);
    const roof = dome.map(part => parts.partCollider(part).roofPanel);
    const hall = review.halls.find(row => row.sourceId === mask.sourceId);
    const source = sources.get(mask.sourceId);
    const width = source.maxX - source.minX, depth = source.maxZ - source.minZ;
    const cx = source.cx + width * hall.centerOffsetXFraction;
    const [rx, rz] = [width, depth].map((dimension, index) => dimension * hall.glazingRadiiFractions[index]);
    assert.equal(volume.polygon.outer.length, 36);
    volume.polygon.outer.forEach(({ x, z }, index) => {
      const angle = 2 * Math.PI * index / 36;
      assert.ok(Math.abs(x - (cx + rx * Math.cos(angle))) < 1e-7);
      assert.ok(Math.abs(z - (source.cz + rz * Math.sin(angle))) < 1e-7);
    });
    assert.equal(volume.minY, Math.fround(base));
    assert.equal(volume.polygon.holes.length, 0);
    assert.ok(roof.every(panel => panel.bottom.every(y => y === volume.maxY)));
    assert.ok([hull, ...dome].every(part => !part.roofContact));

    const edgeKey = edge => edge.map(p => `${Math.fround(p.x)},${Math.fround(p.z)}`).sort().join('/');
    const outerEdges = new Set(polygonEdges(volume.polygon.outer).map(edgeKey));
    const capEdges = new Map();
    for (const panel of roof) {
      for (const edge of polygonEdges(panel.outer)) {
        const key = edgeKey(edge);
        capEdges.set(key, (capEdges.get(key) ?? 0) + 1);
      }
    }
    for (const edge of outerEdges) assert.equal(capEdges.get(edge), 1);
    for (const [edge, use] of capEdges) assert.equal(use, outerEdges.has(edge) ? 1 : 2);

    for (const { x, z } of mask.polygonXZ.map(asPoint)) {
      assert.ok(collision.polygonContains(volume.polygon, x, z));
      for (const [a, b] of polygonEdges(volume.polygon.outer)) {
        const dx = b.x - a.x, dz = b.z - a.z;
        const distance = (dx * (z - a.z) - dz * (x - a.x)) / Math.hypot(dx, dz);
        assert.ok(distance > review.minGlazingMarginM, 'cut must lie inside every convex wall plane');
      }
      assert.ok(roofAt(roof, { x, z }) > volume.maxY);
    }
  }
});

test('Chunjian interior cuts remove ground and road support while keeping the public apertures', () => {
  const surface = geo.terrainSurface;
  const { groundHeight, isOnLand } = loadModule(read('sz-spatial.js'), { imports: {
    './sz-ground-surface.js': groundSurface, './sz-polygon.js': polygonModule
  } }).createCitySpatial(geo);
  const { createRoadSurfaceLayout, createRoadHeightSampler } = loadModule(read('sz-roads.js'), { imports: {
    'three/webgpu': {}, './sz-road-material.js': { createSzRoadSurfaceMaterial: () => ({}) }
  } });
  const gridHeight = ({ x, z }) => terrain.terrainHeight(geo.terrain, x, z);
  const checkGround = ({ x, z }) => assert.ok(Math.abs(groundHeight(x, z) - gridHeight({ x, z })) < 1e-4
    && Number.isFinite(groundHeight(x, z)));
  for (const mask of surface.exclusions) {
    const center = maskCenter(mask);
    assert.ok(isOnLand(center.x, center.z));
    assert.ok(mask.dsmGridSamples.maxM > 30, 'the source DSM contains the roof echo');
    assert.equal(groundHeight(center.x, center.z), null);
    for (const [x, z] of mask.polygonXZ) {
      const dx = x - center.x, dz = z - center.z;
      assert.equal(groundHeight(x - dx * 0.025, z - dz * 0.025), null);
      checkGround({ x: x + dx * 0.025, z: z + dz * 0.025 });
    }

    const [west, , east] = mask.boundsXZ;
    const { chunks } = createRoadSurfaceLayout({
      nodes: [west - 12, center.z, east + 12, center.z], names: ['Fixture'], links: [[0, 1, 0, 3, 1, 0, []]],
      metadata: [{ osmId: 'way/1', heightSource: 'terrain', widthSource: 'osm-width', layer: 0 }]
    }, surface);
    const roadHeight = createRoadHeightSampler(chunks, surface.grid);
    assert.equal(roadHeight(center.x, center.z), null);
    const outside = gridHeight({ x: west - 6, z: center.z });
    assert.ok(Math.abs(roadHeight(west - 6, center.z) - outside) < 1e-4 && Number.isFinite(roadHeight(west - 6, center.z)));
  }
  for (const hole of [stadium, concourse].map(source => source.polygons[0].holes[0])) {
    checkGround(hole.reduce((p, q) => ({ x: p.x + q.x / hole.length, z: p.z + q.z / hole.length }), { x: 0, z: 0 }));
  }
  const bridge = model.find(part => part.id === 'chunjian:sea-gate-deck:6');
  checkGround(midpoint(bridge.polygon.outer[0], bridge.polygon.outer[2]));
});

const skyline = chunjian.sourceIds.map(id => sources.get(id));
const profile = chunjian.shellProfile(skyline, base);
const triangleTop = (part, x, z) => triangleHeight(part.polygon.outer.map((p, i) => ({ ...p, y: part.top[i] })), x, z);
const containsAny = (polygon, x, z) => collision.polygonContains(polygon, x, z);

test('Chunjian shell infill closes the lattice without cutting through the DSM roof echo', () => {
  const shell = model.filter(part => part.id.startsWith('chunjian:shell:'));
  assert.ok(shell.length > 400, 'shell infill must cover a useful part of the grid shell');
  for (const id of chunjian.sourceIds) assert.ok(shell.some(part => part.sourceId === id), `no infill under ${id}`);
  assert.ok(shell.every(part => part.style === 'stadiumRoof' && part.heightSource === 'estimate' && !part.roofContact));
  const { panelDrop, groundMargin } = chunjian.shellDetail;
  for (const part of shell) {
    for (const [i, corner] of part.polygon.outer.entries()) {
      assert.ok(Math.abs(part.top[i] - (profile(corner.x, corner.z) - panelDrop)) < 0.01,
        'panel top must follow the lattice profile below the ribs');
      const ground = terrain.terrainHeight(geo.terrain, corner.x, corner.z);
      assert.ok(ground === null || ground <= part.top[i] - groundMargin + 1e-6,
        'panel must stay above the terrain echo so the ground cannot poke through the shell');
    }
  }
  // 面层低于肋顶，肋仍凸出成白色格线；实面与肋用同一份 profile 取值。
  const ribs = model.filter(part => part.id.startsWith('chunjian:rib:'));
  assert.ok(ribs.some(rib => rectangleOverlap(rib, shell)));
  const crestRib = Math.max(...ribs.map(part => part.maxY));
  assert.ok(crestRib - Math.max(...shell.map(part => part.maxY)) > panelDrop - 0.2);

  function rectangleOverlap(a, list) {
    return list.some(b => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ);
  }
});

test('Chunjian stands rise in the annulus between pitch and eave and leave the Sea Gate open', () => {
  const tiers = model.filter(part => part.id.startsWith('chunjian:stand:tier:'));
  assert.equal(tiers.length, chunjian.standSpec.tiers);
  assert.ok(tiers.every(part => part.style === 'stadiumSeats'));
  const tops = tiers.map(part => part.maxY);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1] + 0.2, 'stand tiers must rise outward');
  const field = stadium.polygons[0].holes[0];
  const fieldPolygon = { outer: field, holes: [] };
  const pitchCenter = field.reduce((p, q) => ({ x: p.x + q.x / field.length, z: p.z + q.z / field.length }), { x: 0, z: 0 });
  const footprint = { outer: stadium.polygons[0].outer, holes: [] };
  for (const part of tiers) {
    assert.ok(part.polygon.outer.length > 40, 'stand bands keep the pitch opening shape');
    for (const corner of part.polygon.outer) {
      assert.ok(!containsAny(fieldPolygon, corner.x, corner.z), 'stand must stay outside the pitch aperture');
      assert.ok(containsAny(footprint, corner.x, corner.z), 'stand must stay inside the source footprint');
      assert.ok(part.maxY <= profile(corner.x, corner.z) - 2 + 1e-6, 'stand must stay under the roof shell');
    }
  }
  assert.ok(model.every(part => !occupies(part, pitchCenter.x, pitchCenter.z, base + 0.25, base + 43)));
  // 海之门一侧没有看台：从场心向正东抽三个半径点。
  const east = Math.max(...field.map(p => p.x));
  for (const f of [0.2, 0.45, 0.75]) {
    const x = pitchCenter.x + (east - pitchCenter.x) * (1 + f * 0.5);
    assert.ok(tiers.every(part => !occupies(part, x, pitchCenter.z, base + 0.3, base + 12)), 'Sea Gate side must stay open');
  }
});

test('Chunjian west stand carries eight tree columns up to the shell underside', () => {
  const columns = model.filter(part => part.id.startsWith('chunjian:stand:tree:'));
  assert.equal(columns.length, chunjian.standSpec.treeColumns);
  for (const column of columns) {
    assert.equal(column.style, 'stadiumDeck');
    assert.ok(Math.abs(column.minY - base) < 1e-6);
    const x = (column.minX + column.maxX) / 2, z = (column.minZ + column.maxZ) / 2;
    const pitchX = stadium.polygons[0].holes[0].reduce((sum, q) => sum + q.x / stadium.polygons[0].holes[0].length, 0);
    assert.ok(x < pitchX, 'tree columns stand on the west main stand');
    assert.ok(Math.abs(column.maxY - (profile(x, z) - chunjian.shellDetail.panelDrop + 0.05)) < 0.01);
  }
});

test('Chunjian plaza and lawns follow the DSM ground and stay off the halls', () => {
  const paving = model.filter(part => part.style === 'stadiumPaving');
  const lawn = model.filter(part => part.style === 'stadiumLawn');
  assert.ok(paving.length > 100 && lawn.length > 20);
  assert.ok(paving.every(part => part.roofContact && part.heightSource === 'estimate'));
  assert.ok(lawn.every(part => !part.roofContact && part.heightSource === 'estimate'));
  const siteRing = { outer: geo.sites.chunjian.site.polygons[0].outer, holes: [] };
  const { lift } = chunjian.plazaDetail;
  const weights = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]];
  for (const part of [...paving, ...lawn]) {
    const expected = part.style === 'stadiumPaving' ? lift.paving : lift.lawn;
    const ring = part.polygon.outer;
    for (const [i, corner] of ring.entries()) {
      const ground = terrain.terrainHeight(geo.terrain, corner.x, corner.z);
      assert.ok(ground !== null);
      assert.ok(Math.abs(part.top[i] - (ground + expected)) < 1e-3, 'plaza top follows the rendered DSM ground');
      assert.ok(containsAny(siteRing, corner.x, corner.z), 'plaza must stay inside the sourced site polygon');
      assert.ok(skyline.every(source => !containsAny({ outer: source.polygons[0].outer, holes: [] }, corner.x, corner.z)),
        'plaza must not run over a hall footprint');
    }
    // 三角形内部也不许被地面穿出：3 个顶点之外再抽重心和三条边的中点。
    for (const [a, b, c] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
      const x = ring[0].x * a + ring[1].x * b + ring[2].x * c;
      const z = ring[0].z * a + ring[1].z * b + ring[2].z * c;
      const ground = terrain.terrainHeight(geo.terrain, x, z);
      assert.ok(ground === null || ground <= triangleTop(part, x, z) + 1e-6, 'ground must not poke through the lawn or paving');
    }
  }
  // 草坪和铺装不重叠（同一块地只有一种面层）。
  for (const grass of lawn) {
    assert.ok(paving.every(stone => grass.maxX <= stone.minX || grass.minX >= stone.maxX
      || grass.maxZ <= stone.minZ || grass.minZ >= stone.maxZ), 'lawn and paving cells must not overlap');
  }
});

test('Chunjian site gate stands on the plaza edge and the paving reaches its opening', () => {
  const gate = model.filter(part => part.id.startsWith('chunjian:site-gate:'));
  const piers = gate.filter(part => part.id.includes(':pier:'));
  assert.equal(piers.length, 2);
  assert.equal(gate.length, 4);
  const lintel = gate.find(part => part.id.endsWith(':lintel'));
  const sign = gate.find(part => part.id.endsWith(':sign'));
  assert.ok(lintel.minY - Math.max(...piers.map(part => part.maxY)) < 1e-3, 'lintel sits on the piers');
  assert.ok(lintel.minY - Math.max(...piers.map(part => part.minY)) > 4.2, 'gate keeps a walkable headroom');
  assert.ok(sign.maxY < lintel.maxY && sign.minY > Math.max(...piers.map(part => part.minY)) + 4.5,
    'sign band sits under the lintel above the walkable opening');
  const gateZ = (Math.min(...skyline.map(source => source.minZ)) + Math.max(...skyline.map(source => source.maxZ))) / 2;
  const west = Math.min(...skyline.map(source => source.minX));
  const reach = chunjian.plazaDetail.apron + chunjian.plazaDetail.lawn + chunjian.plazaDetail.promenade;
  // 门廊两柱落在广场外缘的地面上，柱底按地面采样下沉，不悬空。
  for (const pier of piers) {
    const x = (pier.minX + pier.maxX) / 2, z = (pier.minZ + pier.maxZ) / 2;
    const ground = terrain.terrainHeight(geo.terrain, x, z);
    assert.ok(ground !== null && Math.abs(pier.minY - (ground - 0.5)) < 1e-3, 'gate pier must stand on the terrain');
  }
  // 从门廊向里 20 m 是连续的铺装/草坪，能实际走进广场；再往里是 DSM 回波陡坡（见模型卡缺口）。
  const paving = model.filter(part => part.style === 'stadiumPaving');
  const lawn = model.filter(part => part.style === 'stadiumLawn');
  for (let x = west - reach + 2; x <= west - reach + 18; x += 4) {
    assert.ok([...paving, ...lawn].some(part => containsAny(part.polygon, x, gateZ)),
      `missing plaza surface east of the gate at x=${x}`);
  }
  assert.ok(paving.some(part => containsAny(part.polygon, west - reach + 2, gateZ)), 'paving starts at the gate');
});

const threeDir = process.env.SZ_THREE_PACKAGE_DIR;
test('Chunjian rendered hall roof shields the exact ground raycast cut', { skip: !threeDir }, async () => {
  const THREE = await import(pathToFileURL(join(threeDir, 'build/three.webgpu.js')));
  const imports = { 'three/webgpu': THREE };
  const { buildSzGround } = loadModule(read('sz-ground.js'), { imports: { ...imports, './sz-ground-surface.js': groundSurface } });
  const { renderLandmark } = loadModule(read('sz-landmarks/render.js'), { imports: {
    ...imports, '../sz-geometry.js': loadModule(read('sz-geometry.js'), { imports })
  } });
  const surface = geo.terrainSurface;
  const chunks = surface.chunks.filter(chunk => surface.exclusions.some(({ boundsXZ: [west, north, east, south] }) =>
    west <= chunk.origin[0] + surface.chunkSize && east >= chunk.origin[0]
    && north <= chunk.origin[1] + surface.chunkSize && south >= chunk.origin[1]));
  const scene = new THREE.Scene();
  const ground = buildSzGround(scene, { ...surface, chunks });
  const material = new THREE.MeshBasicMaterial();
  const halls = surface.exclusions.flatMap(mask => {
    const { hull, dome } = hallSolid(mask.sourceId);
    return [hull, ...dome];
  });
  const landmark = renderLandmark({ id: 'chunjian', parts: halls }, () => material);
  scene.add(landmark.group);
  scene.updateMatrixWorld(true);
  function hit(group, { x, z }) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 90, z), new THREE.Vector3(0, -1, 0));
    return ray.intersectObject(group, true)[0]?.point.y ?? null;
  }
  for (const mask of surface.exclusions) {
    const center = maskCenter(mask);
    const roof = hallSolid(mask.sourceId).dome.map(part => parts.partCollider(part).roofPanel);
    for (const point of [center, ...mask.polygonXZ.map(p => midpoint(center, asPoint(p)))]) {
      assert.equal(hit(ground.group, point), null);
      const visibleRoof = hit(landmark.group, point);
      assert.ok(Number.isFinite(visibleRoof) && Math.abs(visibleRoof - roofAt(roof, point)) < 1e-6);
    }
    const outside = { x: mask.boundsXZ[0] - 2, z: center.z };
    // 渲染地面按 2.4 km 合并后，分块原点被烘焙进 float32 顶点，10 km 处约 1 mm 舍入；10 号文档 QA-G02 的默认
    // 共面阈值就是 1 mm，接触仍由未合并的 groundHeight 采样器提供，所以这里按 1 mm 校验而不是 1 µm。
    assert.ok(Math.abs(hit(ground.group, outside) - ground.groundHeight(outside.x, outside.z)) < 1e-3
      && Number.isFinite(hit(ground.group, outside)));
  }
  ground.dispose();
  landmark.group.traverse(mesh => mesh.geometry?.dispose());
  material.dispose();
});
