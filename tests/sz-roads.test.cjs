const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');
const roadMaterialStub = { createSzRoadSurfaceMaterial: () => ({}) };
const { createRoadHeightSampler, createRoadSurfaceLayout, createRoadPolygonLayout, createRoadsideSurfaceTreatment,
  planStreetTreeSides } = loadModule(readFileSync(join(__dirname, '../js/sz-roads.js'), 'utf8'),
  { imports: { 'three/webgpu': {}, './sz-road-material.js': roadMaterialStub } });

const grid = { x0: 0, z0: 0, step: 20, nx: 2, nz: 2 };

function surface(positions, indices) {
  return { version: 1, grid, chunks: [{ id: 'a', origin: [0, 0], indices, positions, cellRanges: [0, 0, indices.length] }] };
}

function groundRoad(osmId) {
  return { osmId, heightSource: 'terrain', widthSource: 'osm-width', layer: 0 };
}

const flat = surface([0, 5, 0, 20, 5, 0, 0, 5, 20, 20, 5, 20], [0, 2, 1, 1, 2, 3]);

test('roadside ramps subtract the shared asphalt and form curbs from the rendered top edge', () => {
  const graph = { nodes: [0, 10, 20, 10], names: ['Source Road'],
    links: [[0, 1, 0, 4, 2, 0, []]], metadata: [groundRoad('way/1')] };
  const feature = { id: 'ramp', sourceIds: ['way/2'], clipToRoadComplement: true,
    trianglesXZ: [2, 5, 10, 5, 2, 15, 10, 5, 10, 15, 2, 15],
    vertexRisesM: [0, 0.12, 0, 0.12, 0.12, 0] };
  const treatment = createRoadsideSurfaceTreatment(graph, grid, [feature]);
  const layout = createRoadPolygonLayout(feature, flat, treatment);
  assert.ok(Math.abs(layout.statistics.areaM2 - 48) < 0.000001);
  const sample = createRoadHeightSampler(layout.chunks, grid);
  const roadHeight = createRoadHeightSampler(createRoadSurfaceLayout(graph, flat).chunks, grid);
  assert.equal(sample(6, 10), null);
  assert.equal(roadHeight(6, 10), 5);
  assert.ok(Math.abs(sample(6, 7) - 5.06) <= 0.001);
  assert.ok(Math.abs(sample(6, 13) - 5.06) <= 0.001);
  const { positions, wallPositions } = layout.chunks[0];
  const vertices = new Set();
  for (let i = 0; i < positions.length; i += 3) vertices.add(positions.slice(i, i + 3).join(','));
  assert.ok(wallPositions.length > 0);
  for (let i = 0; i < wallPositions.length; i += 3) {
    if (wallPositions[i + 1] > 5) assert.ok(vertices.has(wallPositions.slice(i, i + 3).join(',')));
  }
  for (let i = 0; i < wallPositions.length; i += 9) {
    const triangle = Array.from({ length: 3 }, (_, j) => wallPositions.slice(i + j * 3, i + j * 3 + 3));
    assert.ok(triangle.every(p => p[2] === 8) || triangle.every(p => p[2] === 12)
      || triangle.every(p => p[2] === 5) || triangle.every(p => p[2] === 15) || triangle.every(p => p[0] === 10));
  }
});

test('simulated side trees keep one physical curb within the pilot and preserve unmatched points', () => {
  const graph = { nodes: [0, 0, 100, 0, 0, 30, 100, 30], links: [[1, 0, 0, 8, 2, 0, []], [2, 3, 0, 8, 2, 0, []]],
    metadata: [{ ...groundRoad('way/1'), highway: 'secondary' }, { ...groundRoad('way/2'), highway: 'primary' }] };
  const allowed = planStreetTreeSides(graph, [[0, -15, 75, 45]]);
  assert.equal(allowed(25, -6.5), true);
  assert.equal(allowed(25, 6.5), false);
  assert.equal(allowed(25, 23.5), true);
  assert.equal(allowed(25, 36.5), true);
  assert.equal(allowed(25, 9), true);
  assert.equal(allowed(90, 6.5), true);
});

test('road clipping preserves the rendered terrain plane and its cut boundary', () => {
  const graph = {
    nodes: [0, 3, 10, 3], names: ['Source Road'], links: [[0, 1, 0, 2, 1, 0, []]],
    metadata: [groundRoad('way/1')]
  };
  const source = surface([0, 10, 0, 10, 20, 0, 0, 30, 10], [0, 2, 1]);
  const { chunks, statistics } = createRoadSurfaceLayout(graph, source);
  assert.ok(statistics.triangles > 0);
  const vertices = chunks[0].positions;
  assert.equal(Object.prototype.toString.call(vertices), '[object Float32Array]');
  for (let i = 0; i < vertices.length; i += 3) {
    const [x, y, z] = vertices.subarray(i, i + 3);
    assert.ok(z >= 2 - 1e-8 && z <= 4 + 1e-8);
    assert.ok(x + z <= 10 + 1e-8);
    assert.ok(Math.abs(y - (10 + x + 2 * z)) < 1e-8);
  }
  const height = createRoadHeightSampler(chunks, source.grid);
  assert.equal(height(2, 3), 18);
  assert.equal(height(8, 3), null);
  assert.equal(height(2, 5), null);
});

test('road surfaces omit unresolved bridges and cannot fill missing terrain', () => {
  const graph = {
    nodes: [0, 3, 10, 3], names: ['Source Road'], links: [[0, 1, 0, 2, 1, 0, []], [0, 1, 0, 2, 1, 0, []]],
    metadata: [groundRoad('way/1'), { osmId: 'way/2', heightSource: 'unresolved', bridge: true, layer: 1 }]
  };
  const result = createRoadSurfaceLayout(graph, flat);
  assert.equal(result.statistics.groundLinks, 1);
  assert.equal(result.statistics.unresolvedLinks, 1);
  assert.equal(result.chunks[0].sources.length, 1);
  assert.equal(result.chunks[0].sources[0].osmId, 'way/1');
  const dryHole = createRoadSurfaceLayout(graph, { ...flat, chunks: [] });
  assert.equal(dryHole.statistics.triangles, 0);
  assert.equal(dryHole.statistics.linksWithoutSurface, 1);
});

test('road strips fill the outer bevel across a polyline bend and a shared source junction', () => {
  const geometry = { nodes: [2, 8, 10, 8, 10, 16, 10, 8], names: ['Bend'] };
  const path = createRoadSurfaceLayout({
    ...geometry, links: [[0, 2, 0, 4, 1, 0, [10, 8]]], metadata: [groundRoad('way/1')]
  }, flat);
  const junction = createRoadSurfaceLayout({
    ...geometry, links: [[0, 1, 0, 4, 1, 0, []], [1, 2, 0, 4, 1, 0, []]],
    metadata: [groundRoad('way/1'), groundRoad('way/1')]
  }, flat);
  const separate = createRoadSurfaceLayout({
    ...geometry, links: [[0, 1, 0, 4, 1, 0, []], [3, 2, 0, 4, 1, 0, []]],
    metadata: [groundRoad('way/1'), groundRoad('way/2')]
  }, flat);
  assert.equal(path.statistics.areaM2, 62);
  assert.equal(junction.statistics.areaM2, 62);
  assert.equal(junction.chunks[0].sources.length, 2);
  assert.equal(separate.statistics.areaM2, 60);
});

test('crossings and coincident source segments produce one layer of asphalt', () => {
  const geometry = {
    nodes: [0, 10, 20, 10, 10, 0, 10, 20], names: ['Horizontal', 'Vertical'],
    links: [[0, 1, 0, 4, 2, 0, []], [2, 3, 1, 4, 2, 0, []], [1, 0, 0, 4, 2, 1, []]],
    metadata: [groundRoad('way/1'), groundRoad('way/2'), groundRoad('way/3')]
  };
  const { statistics, chunks } = createRoadSurfaceLayout(geometry, flat);
  assert.equal(statistics.areaM2, 144);
  assert.equal(statistics.renderedLinks, 3);
  assert.equal(chunks[0].sources.length, 3);
});

test('reviewed asymmetric carriageways preserve a planted median on the source terrain', () => {
  const graph = {
    nodes: [2, 14, 18, 14, 18, 4, 2, 4], names: ['North Ring'],
    links: [[0, 1, 0, 7, 2, 1, []], [2, 3, 0, 7, 2, 1, []]],
    metadata: [
      { ...groundRoad('way/1'), crossSection: { laneWidthM: 3, points: [2, 14, 2, 10, 14, 3, 18, 14, 4] } },
      { ...groundRoad('way/2'), crossSection: { laneWidthM: 3, points: [18, 4, 2, 2, 4, 2] } }
    ]
  };
  const { chunks } = createRoadSurfaceLayout(graph, flat);
  const height = createRoadHeightSampler(chunks, flat.grid);
  assert.equal(height(10, 5.5), 5);
  assert.equal(height(10, 9.5), null);
  assert.equal(height(10, 11.5), 5);
  assert.equal(height(10, 17), 5);
  assert.equal(height(10, 18.5), null);
});
