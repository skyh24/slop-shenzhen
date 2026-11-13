const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { gunzipSync } = require('node:zlib');
const { loadModule } = require('./helpers/module.cjs');
const polygonModule = require('./helpers/polygon.cjs');
const roadsModule = require('./helpers/roads.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');

// 真实样本：塔楼 way/269974957 南侧紧邻中心七路 way/270044912，
// 当前自动裙房的外扩环在这条车行道上压过约 58.6 m，修复后必须为 0。
const SAMPLE_BUILDING_ID = 'way/269974957';
const SAMPLE_ROAD_OSM_ID = 'way/270044912';

const terrain = loadModule(read('sz-terrain.js'));
const layout = loadModule(read('sz-building-layout.js'), { imports: { './sz-terrain.js': terrain } });
const collision = loadModule(read('building-collision.js'), { imports: { './sz-polygon.js': polygonModule } });
const roads = loadModule(read('sz-roads.js'), { imports: { 'three/webgpu': {}, './sz-road-material.js': {} } });
const { createRoadBuildingClearance } = loadModule(read('sz-road-building-clearance.js'), { imports: {
  './sz-roads.js': roads, './building-collision.js': collision, './sz-road-section.js': loadModule(read('sz-road-section.js'))
} });
const { polygonContains } = collision;

// 离线 stub：sz-geometry 只用到这些能力，注意三角化按扇形生成，足以覆盖任意外环顶点数。
function stubThree() {
  class Group {
    constructor() { this.children = []; this.name = ''; }
    add(object) { object.parent = this; this.children.push(object); }
    traverse(visit) {
      visit(this);
      for (const child of this.children) {
        if (child.traverse) child.traverse(visit);
        else visit(child);
      }
    }
  }
  class Mesh {
    constructor(geometry, material) { this.geometry = geometry; this.material = material; this.name = ''; this.isMesh = true; }
    traverse(visit) { visit(this); }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    setIndex(index) { this.index = index; }
    computeBoundingSphere() {}
    computeBoundingBox() {}
    dispose() {}
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  }
  class Vector2 {
    constructor(x, y) { Object.assign(this, { x, y }); }
  }
  const ShapeUtils = {
    triangulateShape: outer => {
      const faces = [];
      for (let i = 1; i + 1 < outer.length; i++) faces.push([0, i, i + 1]);
      return faces;
    }
  };
  return { Group, Mesh, BufferGeometry, BufferAttribute, Vector2, ShapeUtils };
}

function makeScene() {
  return { add() {}, remove() {} };
}

// 模块一律显式 stub；额外多给的 import 键不会被 loadModule 使用，留给修复时新增依赖。
function loadCityBlocks(THREE) {
  const geometry = loadModule(read('sz-geometry.js'), { imports: { 'three/webgpu': THREE } });
  return loadModule(read('sz-buildings.js'), { imports: {
    'three/webgpu': THREE,
    './sz-geodata.js': {},
    './sz-geometry.js': geometry,
    './sz-facade-profiles.js': loadModule(read('sz-facade-profiles.js')),
    './sz-materials.js': { createBuildingMaterial: () => ({ dispose() {} }) },
    './sz-building-layout.js': layout, './sz-polygon.js': polygonModule, './sz-roads.js': roadsModule,
    './building-collision.js': collision,
    './sz-terrain.js': terrain
  } });
}

const EMPTY_ROAD_GRAPH = () => ({ nodes: [], links: [], metadata: [], names: [] });

// 道路图与 GEO.roadGraph 同形：links 为 [a, b, name, width, lanes, direction, inner]。
function straightRoadGraph(ax, az, bx, bz, width = 8) {
  return {
    nodes: [ax, az, bx, bz],
    links: [[0, 1, 0, width, 1, 0, []]],
    metadata: [{ osmId: 'way/900000001', highway: 'unclassified', layer: 0, bridge: false, tunnel: false,
      widthSource: 'visual-estimate', heightSource: 'terrain', lengthM: Math.hypot(bx - ax, bz - az) }],
    names: ['Test Road']
  };
}

// 只有地面车行道算路：terrain 高程、非桥、非隧道、非分层。
function groundRoadCentrelines(roadGraph) {
  const roads = [];
  for (const [index, link] of roadGraph.links.entries()) {
    const meta = roadGraph.metadata[index];
    if (!meta || meta.heightSource !== 'terrain' || meta.bridge || meta.tunnel || meta.layer) continue;
    const [a, b] = link;
    const points = [{ x: roadGraph.nodes[a * 2], z: roadGraph.nodes[a * 2 + 1] }];
    const inner = link[6] ?? [];
    for (let i = 0; i + 1 < inner.length; i += 2) points.push({ x: inner[i], z: inner[i + 1] });
    points.push({ x: roadGraph.nodes[b * 2], z: roadGraph.nodes[b * 2 + 1] });
    roads.push({ osmId: meta.osmId, width: link[3], points });
  }
  return roads;
}

// 逐段按 width/2 外扩成四边形；契约允许逐段四边形近似走廊。
function roadCorridors(roadGraph) {
  const corridors = [];
  for (const { points, width } of groundRoadCentrelines(roadGraph)) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length === 0) continue;
      const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
      const half = width / 2;
      corridors.push({ holes: [], outer: [
        { x: a.x + nx * half, z: a.z + nz * half }, { x: b.x + nx * half, z: b.z + nz * half },
        { x: b.x - nx * half, z: b.z - nz * half }, { x: a.x - nx * half, z: a.z - nz * half }] });
    }
  }
  return corridors;
}

function polylineLengthInside(polygon, points, steps = 2000) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length === 0) continue;
    const step = length / steps;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      if (polygonContains(polygon, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) total += step;
    }
  }
  return total;
}

function distanceToRing(polygon, x, z) {
  let best = Infinity;
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
    }
  }
  return best;
}

// 环上最近顶点到折线的平面距离，用来在失败信息里说明裙房外环离中心线还剩多少。
function distanceRingToPolyline(polygon, points) {
  let best = Infinity;
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (const point of ring) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t));
      }
    }
  }
  return best;
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

function polygonEdges(polygon) {
  return [polygon.outer, ...polygon.holes].flatMap(ring =>
    ring.map((point, index) => [point, ring[(index + 1) % ring.length]]));
}

// 任意相交或一个环落在另一个多边形内都算重叠；纯共边不算，避免浮点相切的误报。
function polygonsOverlap(a, b) {
  for (const [p, q] of polygonEdges(a)) {
    for (const [r, s] of polygonEdges(b)) if (segmentsCross(p, q, r, s)) return true;
  }
  if (a.outer.some(point => polygonContains(b, point.x, point.z))) return true;
  return b.outer.some(point => polygonContains(a, point.x, point.z));
}

// 显示几何在指定高度上的平面顶点，用来核对碰撞环是否就是显示用的那一份。
function displayRingPoints(group, y) {
  const points = [];
  for (const mesh of group.children) {
    const position = mesh.geometry.attributes.position.array;
    for (let i = 0; i + 2 < position.length; i += 3) {
      if (Math.abs(position[i + 1] - y) <= 1e-3) points.push({ x: position[i], z: position[i + 2] });
    }
  }
  return points;
}

function uniquePlanPoints(points) {
  const seen = new Map();
  for (const point of points) {
    const key = `${Math.round(point.x * 100)}:${Math.round(point.z * 100)}`;
    if (!seen.has(key)) seen.set(key, point);
  }
  return [...seen.values()];
}

function assertDisplayRingMatches(collider, group) {
  const displayed = uniquePlanPoints(displayRingPoints(group, collider.maxY));
  const expected = uniquePlanPoints([...collider.polygon.outer, ...collider.polygon.holes.flat()]);
  assert.ok(displayed.length > 0, `podium ${collider.name} is not in the display geometry at ${collider.maxY}`);
  assert.equal(displayed.length, expected.length,
    `podium ${collider.name} display ring reuses every collider vertex`);
  for (const point of expected) {
    assert.ok(displayed.some(other => Math.abs(other.x - point.x) < 1e-3 && Math.abs(other.z - point.z) < 1e-3),
      `podium ${collider.name} display ring vertex (${point.x}, ${point.z}) matches the collider ring`);
  }
}

const FLAT_GRID = () => ({ x0: -3000, z0: -3000, nx: 200, nz: 200, step: 50,
  heightScale: 0.1, heights: new Array(200 * 200).fill(0) });

function ringSquare(x, z, half) {
  return [{ x: x - half, z: z - half }, { x: x + half, z: z - half },
    { x: x + half, z: z + half }, { x: x - half, z: z + half }];
}

function makeTower({ id, height, minHeight = 0, outer, holes = [], facade = 'office' }) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of outer) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { id, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, minX, maxX, minZ, maxZ,
    height, minHeight, heightSource: 'osm-height', category: 'commercial', facade,
    landmark: null, name: null, levels: -1, polygons: [{ outer, holes }] };
}

// 120 m、40×40 m 的控制塔楼，平面面积 1600 m²，外扩 6.4 m，裙房高 19.2 m。
const CONTROL_OUTER = ringSquare(0, 0, 20);
const controlTower = (id = 'way/900001') => makeTower({ id, height: 120, outer: CONTROL_OUTER.map(point => ({ ...point })) });

const raw = JSON.parse(gunzipSync(readFileSync(join(__dirname, '../js/sz-city.json.gz'))));
const { decodeCityPayload } = loadModule(read('sz-data-format.js').replace('export async function', 'async function'));
const { buildings: realBuildings, geo } = decodeCityPayload(raw);
const sampleBuilding = realBuildings.find(building => building.id === SAMPLE_BUILDING_ID);
const realEntrances = (geo.roadFrontage?.entrances ?? []).map(({ x, z }) => ({ x, z }));
const sampleRoads = groundRoadCentrelines(geo.roadGraph).filter(road => road.osmId === SAMPLE_ROAD_OSM_ID);

test('rendered Chegongmiao ramp clearance removes the phantom footprint and its collider', () => {
  const elevated = loadModule(read('sz-elevated-roads.js'), { imports: {
    'three/webgpu': {}, 'three/tsl': {}, './sz-roads.js': roads, './sz-ground-surface.js': loadModule(read('sz-ground-surface.js')),
    './sz-controller-surfaces.js': loadModule(read('sz-controller-surfaces.js'))
  } });
  const building = realBuildings.find(item => item.id === 'globfp/5784');
  const deckPlan = elevated.planElevatedRoads(geo.roadGraph, geo.terrainSurface);
  const roadClearance = createRoadBuildingClearance(EMPTY_ROAD_GRAPH(), () => null, deckPlan.links);
  const placement = layout.buildingPlacement(building, geo.terrain);
  assert.match(roadClearance(building.polygons[0], building, placement.minY, placement.maxY), /^sz-elevated-road:/);
  assert.equal(roadClearance(building.polygons[0], building, -30, -25), null);
  assert.equal(roadClearance(building.polygons[0], building, 90, 95), null);

  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const blocks = buildCityBlocks(makeScene(), { buildings: [building], terrain: geo.terrain, roadClearance });
  assert.equal(blocks.roadConflicts[0].buildingId, building.id);
  assert.equal(blocks.allBlocks.length, 0);
  assert.equal(blocks.colliders.length, 0);
  assert.equal(blocks.group.children.length, 0);
});

test('ground road clearance checks the drivable path, courtyards and underpasses', () => {
  const graph = straightRoadGraph(-20, 0, 20, 0);
  const intersects = createRoadBuildingClearance(graph, () => 0);
  const building = makeTower({ id: 'globfp/1', height: 12, outer: ringSquare(0, 0, 5) });
  const raised = makeTower({ id: 'globfp/2', height: 12, minHeight: 6, outer: ringSquare(0, 0, 5) });
  const near = makeTower({ id: 'globfp/3', height: 12, outer: ringSquare(0, 6, 4) });
  const passage = makeTower({ id: 'globfp/4', height: 12, outer: ringSquare(0, 0, 8),
    holes: [ringSquare(0, 0, 7)] });
  assert.match(intersects(building.polygons[0], building, 0, 12), /^ground:/);
  assert.equal(intersects(raised.polygons[0], raised, 6, 12), null);
  assert.equal(intersects(near.polygons[0], near, 0, 12), null);
  assert.equal(intersects(passage.polygons[0], passage, 0, 12), null);
  const osm = { ...building, id: 'way/900000006' };
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const blocks = buildCityBlocks(makeScene(), { buildings: [building, osm, raised, near, passage],
    terrain: FLAT_GRID(), roadClearance: intersects });
  assert.deepEqual(Array.from(blocks.colliders, collider => collider.sourceId), [osm.id, raised.id, near.id, passage.id]);
});

test('real sample tower keeps the ground carriageway of way/270044912 clear of estimated podiums', () => {
  assert.ok(sampleBuilding, 'shared payload still carries the sample tower');
  assert.ok(sampleRoads.length > 0, 'sample road is still a ground carriageway in the shared payload');
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [sampleBuilding], terrain: geo.terrain, roadGraph: geo.roadGraph,
    entrances: realEntrances, renderChunkSize: 1000
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  // 量出每个裙房压住的中心线长度和外环净距，失败信息直接给米数，不写死样本数值。
  const covered = podiums.map(podium => sampleRoads
    .reduce((sum, road) => sum + polylineLengthInside(podium.polygon, road.points), 0));
  const samplePodiums = podiums.filter(podium => podium.sourceId === SAMPLE_BUILDING_ID);
  const diagnosis = samplePodiums.map(podium => {
    const clearance = Math.min(...sampleRoads.map(road => distanceRingToPolyline(podium.polygon, road.points)));
    const half = Math.min(...sampleRoads.map(road => road.width / 2));
    return `${podium.name} covers ${covered[podiums.indexOf(podium)].toFixed(3)} m of ${SAMPLE_ROAD_OSM_ID}, `
      + `podium ring is ${clearance.toFixed(3)} m from the centreline (carriageway half-width ${half})`;
  });
  assert.equal(samplePodiums.length, 0,
    `estimated podium must not be added when the free band is under 4 m: ${diagnosis.join('; ')}`);
  for (const [index, podium] of podiums.entries()) {
    assert.ok(covered[index] <= 1e-6,
      `podium ${podium.name} covers ${covered[index].toFixed(3)} m of the real carriageway`);
  }
});

test('real sample podiums clear the carriageway and never overlap a neighbour footprint', () => {
  assert.ok(sampleBuilding, 'shared payload still carries the sample tower');
  const neighbours = realBuildings.filter(building => building.id !== SAMPLE_BUILDING_ID
    && building.minX < sampleBuilding.maxX && building.maxX > sampleBuilding.minX
    && building.minZ < sampleBuilding.maxZ && building.maxZ > sampleBuilding.minZ);
  assert.ok(neighbours.length > 0, 'sample tower bbox has at least one real neighbour');
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [sampleBuilding, ...neighbours], terrain: geo.terrain, roadGraph: geo.roadGraph,
    entrances: realEntrances, renderChunkSize: 1000
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  for (const podium of podiums) {
    for (const road of sampleRoads) {
      const covered = polylineLengthInside(podium.polygon, road.points);
      assert.ok(covered <= 1e-6,
        `podium ${podium.name} covers ${covered.toFixed(3)} m of ${SAMPLE_ROAD_OSM_ID}`);
    }
  }
  const verticalRange = building => {
    const baseY = terrain.terrainHeight(geo.terrain, building.cx, building.cz);
    return [baseY + building.minHeight, baseY + building.height];
  };
  for (const podium of podiums) {
    for (const obstacle of [sampleBuilding, ...neighbours]) {
      if (obstacle.id === podium.sourceId) continue;
      const [minY, maxY] = verticalRange(obstacle);
      // 完全在裙房之上或之下的体量不参与平面避让。
      if (maxY <= podium.minY || minY >= podium.maxY) continue;
      assert.equal(polygonsOverlap(podium.polygon, obstacle.polygons[0]), false,
        `podium ${podium.name} overlaps the source footprint of ${obstacle.id}`);
    }
  }
  assert.equal(podiums.some(podium => podium.sourceId === SAMPLE_BUILDING_ID), false,
    'the sample tower keeps the tower alone: a real neighbouring record overlaps its own footprint');
});

test('synthetic podium stays clear of a ground road one metre outside the tower', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  // 8 m 宽车行道，路缘距塔楼南墙 1 m（走廊 z 21..29），落在 6.4 m 的外扩带里。
  const roadGraph = straightRoadGraph(-60, 25, 60, 25, 8);
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [controlTower()], terrain: FLAT_GRID(), roadGraph, entrances: []
  });
  const corridors = roadCorridors(roadGraph);
  assert.ok(corridors.length > 0, 'synthetic ground link produces a corridor');
  const roads = groundRoadCentrelines(roadGraph);
  for (const podium of blocks.colliders.filter(collider => collider.type === 'building-podium')) {
    for (const corridor of corridors) {
      assert.equal(polygonsOverlap(podium.polygon, corridor), false,
        `podium ${podium.name} overlaps the 8 m ground carriageway`);
    }
    for (const road of roads) {
      const covered = polylineLengthInside(podium.polygon, road.points);
      assert.ok(covered <= 1e-6, `podium ${podium.name} covers ${covered.toFixed(3)} m of the centreline`);
    }
  }
});

test('synthetic podium stays clear of the rendered asphalt at a bent road', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  // 与 sz-roads.js 的弯道斜接一致：width 17、在 (0,16) 折向 +z 时补的沥青三角形是 [(0,16),(0,7.5),(8.5,16)]。
  // 只看逐段中心线四边形会漏掉这块三角形，塔楼外扩后压在上面仍会被判为“可用”。
  const roadGraph = {
    nodes: [-50, 16, 0, 66],
    links: [[0, 1, 0, 17, 1, 0, [0, 16]]],
    metadata: [{ osmId: 'way/900000002', highway: 'unclassified', layer: 0, bridge: false, tunnel: false,
      widthSource: 'visual-estimate', heightSource: 'terrain', lengthM: 130 }],
    names: ['Bent Road']
  };
  const mitre = { holes: [], outer: [{ x: 0, z: 16 }, { x: 0, z: 7.5 }, { x: 8.5, z: 16 }] };
  const tower = makeTower({ id: 'way/900002', height: 150, outer: ringSquare(30, -10, 20) });
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [tower], terrain: FLAT_GRID(), roadGraph, entrances: []
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  for (const podium of podiums) {
    assert.equal(polygonsOverlap(podium.polygon, mitre), false,
      `podium ${podium.name} overlaps the rendered bend mitre`);
    for (const corridor of roadCorridors(roadGraph)) {
      assert.equal(polygonsOverlap(podium.polygon, corridor), false, 'podium overlaps the rendered road surface');
    }
  }
  // 弯道斜接吃掉外扩带的一角，但仍留得下一圈缩小后的裙房；关键是不能再压在沥青上。
  assert.equal(podiums.filter(podium => podium.sourceId === tower.id).length, 1,
    'the bend leaves one reduced but valid estimated podium');
});

test('synthetic tower with a distant road keeps a podium matching the display ring', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const roadGraph = straightRoadGraph(-400, 200, 400, 200, 8);
  const tower = controlTower();
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [tower], terrain: FLAT_GRID(), roadGraph, entrances: []
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  assert.equal(podiums.length, 1, 'a free 6.4 m band still produces one estimated podium');
  const podium = podiums[0];
  assert.ok(podium.minX < tower.minX && podium.maxX > tower.maxX
    && podium.minZ < tower.minZ && podium.maxZ > tower.maxZ, 'podium extends past the tower footprint');
  assert.ok(podium.maxY - podium.minY >= 6 && podium.maxY - podium.minY <= 20,
    'podium height stays inside the estimate budget');
  assertDisplayRingMatches(podium, blocks.group);
  // 走廊离塔楼 180 m，不参与避让。
  for (const corridor of roadCorridors(roadGraph)) {
    assert.equal(polygonsOverlap(podium.polygon, corridor), false, 'distant road is untouched');
  }
});

test('synthetic podium clears a low neighbour inside the expansion band', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const neighbour = makeTower({ id: 'way/900011', height: 12, outer: ringSquare(0, 32, 10) });
  const tower = controlTower();
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [tower, neighbour], terrain: FLAT_GRID(), roadGraph: EMPTY_ROAD_GRAPH(), entrances: []
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  for (const podium of podiums) {
    assert.equal(polygonsOverlap(podium.polygon, neighbour.polygons[0]), false,
      `podium ${podium.name} overlaps the 12 m neighbour footprint`);
  }
  assert.equal(podiums.some(podium => podium.sourceId === tower.id), false,
    'the tower keeps the tower alone: the 12 m neighbour owns the expansion band');
});

test('synthetic podium keeps clear of a real entrance point', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const entrance = { x: 0, z: 21.5 };
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [controlTower()], terrain: FLAT_GRID(), roadGraph: EMPTY_ROAD_GRAPH(), entrances: [entrance]
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  for (const podium of podiums) {
    assert.equal(polygonContains(podium.polygon, entrance.x, entrance.z), false,
      `podium ${podium.name} must not cover a real entrance point`);
    const clearance = distanceToRing(podium.polygon, entrance.x, entrance.z);
    assert.ok(clearance >= 1.5,
      `podium ${podium.name} keeps only ${clearance.toFixed(3)} m clear of a real entrance point`);
  }
  assert.equal(podiums.some(podium => podium.sourceId === 'way/900001'), false,
    'the entrance sits 1.5 m outside the wall, so even the 4 m band would cover it');
});

test('synthetic courtyard and L-shaped podium keeps holes open and clears the open-side road', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  // L 形外环：横向臂 60×20，纵向臂 20×40，内院挖在横向臂里。
  const outer = [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 60, z: 20 },
    { x: 20, z: 20 }, { x: 20, z: 60 }, { x: 0, z: 60 }];
  const courtyard = ringSquare(10, 10, 6);
  const tower = makeTower({ id: 'way/900021', height: 150, outer, holes: [courtyard] });
  // 开放侧（南侧）的车行道：路缘距 L 形南墙 6 m，4 m 外扩仍能留出空隙。
  const roadGraph = straightRoadGraph(-40, -10, 100, -10, 8);
  const blocks = buildCityBlocks(makeScene(), {
    buildings: [tower], terrain: FLAT_GRID(), roadGraph, entrances: []
  });
  const podiums = blocks.colliders.filter(collider => collider.type === 'building-podium');
  for (const podium of podiums) {
    assert.deepEqual(podium.polygon.holes, tower.polygons[0].holes,
      `podium ${podium.name} keeps the source courtyard rings untouched`);
    assert.equal(polygonContains(podium.polygon, 10, 10), false,
      `podium ${podium.name} must not fill the courtyard`);
    for (const corridor of roadCorridors(roadGraph)) {
      assert.equal(polygonsOverlap(podium.polygon, corridor), false,
        `podium ${podium.name} overlaps the open-side carriageway`);
    }
  }
});

test('podium display mesh and collider ring agree under real Three raycasts',
  { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
    const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
    const { buildCityBlocks } = loadCityBlocks(THREE);
    const scene = new THREE.Scene();
    const tower = controlTower();
    const blocks = buildCityBlocks(scene, {
      buildings: [tower], terrain: FLAT_GRID(), roadGraph: EMPTY_ROAD_GRAPH(), entrances: []
    });
    scene.updateMatrixWorld(true);
    const podium = blocks.colliders.find(collider => collider.type === 'building-podium');
    assert.ok(podium, 'control tower generates an estimated podium');
    assertDisplayRingMatches(podium, blocks.group);
    const y = (podium.minY + podium.maxY) / 2;
    const reach = 200;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const origin = new THREE.Vector3(-dx * reach, y, -dz * reach);
      const hits = new THREE.Raycaster(origin, new THREE.Vector3(dx, 0, dz)).intersectObjects(blocks.group.children);
      assert.ok(hits.length > 0, `raycast from (${dx}, ${dz}) reaches the city blocks mesh`);
      const hit = hits[0].point;
      assert.ok(Math.abs(hit.y - y) < 1e-3, `first hit on (${dx}, ${dz}) is at podium mid height`);
      const offset = distanceToRing(podium.polygon, hit.x, hit.z);
      assert.ok(offset < 1e-3,
        `first hit on (${dx}, ${dz}) is ${offset.toFixed(4)} m away from the collider podium ring`);
      // 碰撞环声明的位置必须有显示几何挡住，反之亦然；射线沿 (dx, dz) 前进，所以内侧是 +0.5 m。
      assert.equal(polygonContains(podium.polygon, hit.x + dx * 0.5, hit.z + dz * 0.5), true,
        `podium wall at (${dx}, ${dz}) sits exactly where the collider ring says`);
    }
    // 塔楼足迹之外、裙房环之内的位置向下打射线，第一命中就是裙房屋面。
    const roofX = (tower.maxX + podium.maxX) / 2;
    const down = new THREE.Raycaster(new THREE.Vector3(roofX, 300, 0), new THREE.Vector3(0, -1, 0))
      .intersectObjects(blocks.group.children);
    assert.ok(down.length > 0, 'podium roof exists where the collider bounds say it does');
    assert.ok(Math.abs(down[0].point.y - podium.maxY) < 1e-3,
      `podium roof hit at ${down[0].point.y} instead of ${podium.maxY}`);
    blocks.dispose();
  });

test('podium generation is deterministic for identical options', () => {
  const { buildCityBlocks } = loadCityBlocks(stubThree());
  const options = { buildings: [controlTower()], terrain: FLAT_GRID(),
    roadGraph: straightRoadGraph(-400, 200, 400, 200, 8), entrances: [] };
  const first = buildCityBlocks(makeScene(), options);
  const second = buildCityBlocks(makeScene(), options);
  assert.deepEqual(second.colliders, first.colliders);
  const podiums = blocks => blocks.allBlocks.filter(block => block.isPodium);
  assert.ok(podiums(first).length > 0, 'control tower still generates one podium block');
  assert.deepEqual(podiums(second), podiums(first));
});
