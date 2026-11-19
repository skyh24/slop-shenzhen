const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');
const { fixtureTerrainSurface } = require('./helpers/terrain-surface.cjs');
const { prepareRoadJunctions, clipRoadJunctionOverlap } = require('./helpers/road-junctions.cjs');
const { prepareRoadJoinSections, applyRoadJoinFrames } = loadModule(readFileSync(join(__dirname, '../js/sz-road-section.js'), 'utf8'));
const { sectionSpine } = require('./helpers/section-frame.cjs');

function city(nodes, links, metadata) {
  const grid = { x0: -400, z0: -400, nx: 5, nz: 5, step: 200, heightScale: 1, heights: Array(25).fill(8) };
  return { terrain: grid, terrainSurface: fixtureTerrainSurface(grid), roadGraph: {
    nodes, nodeIds: nodes.filter((_, i) => !(i % 2)).map((_, i) => i), names: ['main'], links,
    metadata: metadata.map((meta, i) => ({ heightSource: 'terrain', highway: 'primary', osmId: `way/${i}`, ...meta }))
  } };
}
const link = (a, b, lanes = 3) => [a, b, 0, 10, lanes, 1, []];

test('shared grades propagate through short bridge links into the ground approach', () => {
  const source = city([-100, 0, 0, 0, 10, 0, 200, 30, 350, 30],
    [link(0, 1), link(1, 2), link(2, 3), link(3, 4)],
    [{ bridge: true, layer: 1, highwayProfile: [12, 12, true, true] }, { bridge: true, layer: 1 }, {}, {}]);
  const graph = prepareRoadJunctions(source).roadGraph;
  const a = graph.metadata[1].junctionProfile, b = graph.metadata[2].junctionProfile;
  assert.equal(a[0], 12);
  assert.equal(a[1], b[0]);
  assert.equal(b[1], 8);
  assert.ok(graph.metadata[2].junctionApproach);
  assert.equal(graph.junctionRepair.conflicts.length, 0);
  for (const p of [a, b]) for (let i = 1; i < p[4].length; i++) {
    const run = (p[4][i][0] - p[4][i - 1][0]) * (p === a ? 10 : Math.hypot(190, 30));
    assert.ok(Math.abs(p[4][i][1] - p[4][i - 1][1]) <= run * 0.115 + 1e-6);
  }
});

test('curved bridge and tunnel joins share a full three-lane clear section', () => {
  const graph = prepareRoadJoinSections(city([0, 0, 80, 0, 140, 45], [link(0, 1), link(1, 2)],
    [{ bridge: true, layer: 1 }, { tunnel: true, layer: -1 }]).roadGraph);
  const frameAt = (i, points) => applyRoadJoinFrames(sectionSpine(points, { widthM: 11.45 }).map(f => ({ ...f, d: f.station,
    left: { x: f.x + f.nx * 11.45 / 2, z: f.z + f.nz * 11.45 / 2 },
    right: { x: f.x - f.nx * 11.45 / 2, z: f.z - f.nz * 11.45 / 2 } })), graph.metadata[i]);
  const a = frameAt(0, [{ x: 0, z: 0 }, { x: 80, z: 0 }]).at(-1);
  const b = frameAt(1, [{ x: 80, z: 0 }, { x: 140, z: 45 }])[0];
  for (const side of ['left', 'right']) assert.ok(Math.hypot(a[side].x - b[side].x, a[side].z - b[side].z) < 1e-8);
  assert.ok(Math.hypot(b.left.x - b.right.x, b.left.z - b.right.z) >= 3 * 3.25 + 1.7 - 1e-8);
});

test('cut soil closes the terrain outside the full roadway and preserves the tunnel clearance', () => {
  const result = prepareRoadJunctions(city([0, 0, 100, 0], [link(0, 1)],
    [{ tunnel: true, layer: -1, highwayProfile: [0, 0, true, true], tunnelCorridor: { coverM: [50, 100], clearanceM: 4.5 } }]));
  const walls = result.terrainSurface.cutWalls;
  assert.ok(walls.triangles > 20);
  assert.ok(walls.colliders.length);
  for (const c of walls.colliders) {
    assert.ok(c.minZ > 11.45 / 2 || c.maxZ < -11.45 / 2);
    if (c.minX >= 52) assert.ok(c.minY >= 5.4);
  }
});

test('junction overlap clips the extra pavement while preserving its slope', () => {
  const source = city([-100, 0, 0, 0, 100, 0], [link(0, 1), link(1, 2)],
    [{ bridge: true, layer: 1, highwayProfile: [8, 8, true, true] }, { bridge: true, layer: 1 }]);
  const graph = prepareRoadJunctions(source).roadGraph;
  const tris = [[{ x: 0, y: 8, z: -4 }, { x: 4, y: 8.4, z: 4 }, { x: 4, y: 8.4, z: -4 }]];
  assert.equal(clipRoadJunctionOverlap(graph, 0, 1, tris).length, 0);
});

test('a tunnel fork aligns the through carriageway and opens the shared side wall', () => {
  const graph = prepareRoadJunctions(city([0, 0, 80, 0, 160, 20, 120, 60],
    [link(0, 1), link(1, 2, 2), link(1, 3, 2)],
    [{ highway: 'motorway', tunnel: true, layer: -1, highwayProfile: [0, 0, true, true] },
      { highway: 'motorway', tunnel: true, layer: -1, highwayProfile: [0, 0, true, true] },
      { highway: 'motorway_link', tunnel: true, layer: -1, highwayProfile: [0, 0, true, true] }])).roadGraph;
  const fullWidth = graph.links[0][3] + 2 * (0.5 + 0.35);
  assert.equal(graph.metadata[0].junctionSections[1].widthM, fullWidth);
  assert.equal(graph.metadata[1].junctionSections[0].widthM, fullWidth);
  const { roadJunctionWallIntervals } = require('./helpers/road-junctions.cjs');
  const kept = roadJunctionWallIntervals(graph, 1, { x: 80, z: 0 }, { x: 90, z: 2.5 },
    { x: 79, z: 5.6 }, { x: 89, z: 8.1 });
  assert.ok(kept.reduce((sum, [a, b]) => sum + b - a, 0) < 0.8, 'the exit opening cannot retain a wall across its pavement');
});
