const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');
const roads = require('./helpers/roads.cjs');

const { createLanePlan, createMarkingLayout } = loadModule(
  readFileSync(join(__dirname, '../js/sz-road-markings.js'), 'utf8'), { imports: { './sz-roads.js': roads } });

const GROUND = { osmId: 'way/1', highway: 'primary', widthSource: 'estimate-from-class',
  heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 };
const LONGITUDINAL = new Set(['edge-left', 'edge-right', 'center-left', 'center-right', 'lane']);

function graphFor(points, { width = 12, lanes = 0, direction = 0, metadata = {} } = {}) {
  const inner = [];
  for (let i = 1; i < points.length - 1; i++) inner.push(points[i].x, points[i].z);
  return {
    nodes: [points[0].x, points[0].z, points.at(-1).x, points.at(-1).z],
    links: [[0, 1, 0, width, lanes, direction, inner]],
    names: ['test'],
    metadata: [{ ...GROUND, ...metadata }]
  };
}

function nearest(points, point) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length)));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)));
  }
  return best;
}

function properlyCrosses(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
    && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function longitudinal(strips) {
  return strips.filter(strip => LONGITUDINAL.has(strip.kind));
}

test('reviewed corridor replaces overlapping paint while generic markings continue past its boundaries', () => {
  const graph = graphFor([{ x: 0, z: 0 }, { x: 120, z: 0 }], { width: 12, lanes: 3, direction: 1 });
  const frontage = { features: [{ id: 'pilot:paint', sourceIds: ['way/1'], trianglesXZ: [0, 0, 0, 1, 1, 0] },
    { id: 'source-signal-stop-lines', sourceIds: ['node/42'], trianglesXZ: [0, 0, 0, 1, 1, 0] }],
    corridors: [{ id: 'pilot', bounds: [27, -8, 89, 8], roadIds: ['way/1'] }] };
  const approach = { sourceIndex: 0, osmNodeId: 42, group: 0, stopX: 105, stopZ: 0, dx: 1, dz: 0, widthM: 12 };
  const { strips, statistics } = createMarkingLayout(graph, { frontage, intersections: [{ approaches: [approach] }] });
  assert.equal(statistics.reviewedLinks, 1);
  assert.ok(strips.some(strip => strip.bx === 27));
  assert.ok(strips.some(strip => strip.ax === 89));
  assert.ok(strips.every(strip => strip.bx <= 27 || strip.ax >= 89));
  assert.ok(strips.every(strip => LONGITUDINAL.has(strip.kind)));
});

test('edge and lane paint follow a changing asymmetric section after trimming a junction', () => {
  const graph = graphFor([{ x: 0, z: 14 }, { x: 120, z: 14 }], {
    width: 12, lanes: 3, direction: 1,
    metadata: { crossSection: { laneWidthM: 3, points: [0, 14, 2, 120, 14, 4] } }
  });
  const approach = { sourceIndex: 0, group: 0, stopX: 110, stopZ: 14, dx: 1, dz: 0, widthM: 12 };
  const { strips, statistics } = createMarkingLayout(graph, { intersections: [{ approaches: [approach] }] });
  assert.equal(statistics.breakLinks, 1);
  const edges = longitudinal(strips).filter(strip => strip.kind.startsWith('edge'));
  assert.ok(edges.some(strip => strip.kind === 'edge-left'));
  assert.ok(edges.some(strip => strip.kind === 'edge-right'));
  for (const strip of edges) {
    for (const [x, z] of [[strip.ax, strip.az], [strip.bx, strip.bz]]) {
      const edge = 14 - (2 + 2 * x / 120);
      const expected = edge + (strip.kind === 'edge-right' ? 11.62 : 0.38);
      assert.ok(Math.abs(z - expected) < 1e-8);
    }
  }
  const lanes = [...new Set(strips.filter(strip => strip.kind === 'lane' && strip.ax === 0).map(strip => strip.az))];
  assert.deepEqual(lanes.sort((a, b) => a - b), [15, 18]);
});

test('two-way roads get a double-yellow center, dashed lane dividers and solid edge lines', () => {
  const plan = createLanePlan([0, 1, 0, 13, 4, 0, []], GROUND);
  assert.equal(plan.twoWay, true);
  assert.equal(plan.narrow, false);
  assert.equal(plan.laneCount, 4);
  assert.equal(plan.laneSource, 'osm-lanes');
  assert.deepEqual([...plan.internal.filter(item => item.kind === 'double-yellow').map(item => item.offset)], [0]);
  assert.equal(plan.internal.filter(item => item.kind === 'dashed-white').length, 2);

  const points = [{ x: 0, z: 0 }, { x: 200, z: 0 }];
  const { strips } = createMarkingLayout(graphFor(points, { width: 13, lanes: 4, direction: 0 }));
  const yellow = strips.filter(strip => strip.color === 'yellow');
  assert.equal(yellow.length > 0, true);
  assert.deepEqual([...new Set(yellow.map(strip => strip.kind))].sort(), ['center-left', 'center-right']);
  const dashed = strips.filter(strip => strip.kind === 'lane');
  assert.equal(dashed.length > 0, true);
  assert.equal(dashed.every(strip => strip.period === 12 && strip.duty === 0.25), true);
  const edges = strips.filter(strip => strip.kind === 'edge-left' || strip.kind === 'edge-right');
  assert.deepEqual([...new Set(edges.map(strip => Math.sign(strip.offset)))].sort(), [-1, 1]);
  assert.equal(edges.every(strip => strip.period === 1 && strip.duty === 1), true);
});

test('estimated lane counts are tagged apart from OSM lanes', () => {
  const estimated = createLanePlan([0, 1, 0, 13, 0, 0, []], GROUND);
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.laneSource, 'width-estimate');
  assert.equal(estimated.laneCount, 4);
  const sourced = createLanePlan([0, 1, 0, 13, 4, 0, []], GROUND);
  assert.equal(sourced.estimated, false);
  assert.equal(sourced.laneSource, 'osm-lanes');

  const graph = graphFor([{ x: 0, z: 0 }, { x: 200, z: 0 }], { width: 13, lanes: 0, direction: 0 });
  const { statistics } = createMarkingLayout(graph);
  assert.equal(statistics.estimatedLaneLinks, 1);
  assert.equal(statistics.osmLaneLinks, 0);
  assert.deepEqual({ ...statistics.laneSources }, { 'width-estimate': 1 });
});

test('estimated two-way odd lane counts still put the yellow center line on the road centerline', () => {
  const plan = createLanePlan([0, 1, 0, 10, 0, 0, []], GROUND);
  assert.equal(plan.laneCount, 3);
  assert.equal(plan.narrow, false);
  assert.equal(plan.internal[0].kind, 'double-yellow');
  assert.equal(plan.internal[0].offset, 0);
  const { strips } = createMarkingLayout(graphFor([{ x: 0, z: 0 }, { x: 120, z: 0 }], { width: 10, lanes: 0, direction: 0 }));
  const yellow = strips.filter(strip => strip.color === 'yellow');
  assert.equal(yellow.length > 0, true);
  assert.equal(yellow.every(strip => Math.abs(strip.offset) === 0.12), true);
});

test('one-way roads never paint a double yellow', () => {
  for (const direction of [1, -1]) {
    const plan = createLanePlan([0, 1, 0, 10, 3, direction, []], GROUND);
    assert.equal(plan.twoWay, false);
    assert.equal(plan.narrow, false);
    assert.equal(plan.internal.length, 2);
    assert.equal(plan.internal.every(item => item.kind === 'dashed-white'), true);
    const { strips, statistics } = createMarkingLayout(
      graphFor([{ x: 0, z: 0 }, { x: 120, z: 0 }], { width: 10, lanes: 3, direction }));
    assert.equal(strips.some(strip => strip.color === 'yellow'), false);
    assert.equal(strips.filter(strip => strip.kind === 'lane').length > 0, true);
    assert.equal(statistics.oneWayLinks, 1);
  }
});

test('narrow two-way roads keep only the center line and edge lines', () => {
  const points = [{ x: 0, z: 0 }, { x: 120, z: 0 }];
  for (const fixture of [{ width: 6.5, lanes: 2 }, { width: 9, lanes: 0 }, { width: 6.4, lanes: 4 }]) {
    const plan = createLanePlan([0, 1, 0, fixture.width, fixture.lanes, 0, []], GROUND);
    assert.equal(plan.narrow, true);
    assert.deepEqual([...plan.internal.map(item => item.kind)], ['double-yellow']);
    assert.equal(plan.internal[0].offset, 0);
    const { strips, statistics } = createMarkingLayout(graphFor(points, { ...fixture, direction: 0 }));
    assert.equal(strips.some(strip => strip.kind === 'lane'), false);
    assert.equal(strips.filter(strip => strip.color === 'yellow').length > 0, true);
    assert.equal(strips.filter(strip => strip.kind === 'edge-left' || strip.kind === 'edge-right').length > 0, true);
    assert.equal(statistics.narrowLinks, 1);
  }
});

test('an S-curve keeps every offset line on the pavement and free of self-crossings', () => {
  const points = [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 50, z: 15 }, { x: 50, z: 40 },
    { x: 30, z: 55 }, { x: 0, z: 55 }, { x: -20, z: 40 }, { x: -20, z: 15 }];
  const width = 13, halfWidth = width / 2;
  const { strips } = createMarkingLayout(graphFor(points, { width, lanes: 4, direction: 0 }));
  const lines = longitudinal(strips);
  assert.equal(lines.length > 20, true);
  // 偏移线不得偏出路面：折线端点和线段角点都落在半宽内。
  for (const strip of lines) {
    for (const p of [{ x: strip.ax, z: strip.az }, { x: strip.bx, z: strip.bz }]) {
      assert.ok(nearest(points, p) <= halfWidth + 0.02, 'offset line left the pavement');
    }
  }
  // 同一根线的相邻采样片必须共用端点，斜接处不能断开。
  const grouped = new Map();
  for (const strip of lines) {
    const key = `${strip.kind}:${strip.offset}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(strip);
  }
  for (const [key, pieces] of grouped) {
    for (let i = 1; i < pieces.length; i++) {
      const gap = Math.hypot(pieces[i].ax - pieces[i - 1].bx, pieces[i].az - pieces[i - 1].bz);
      assert.ok(gap < 1e-6, `miter joint gap on ${key}: ${gap}`);
    }
  }
  // 任何两根纵向线都不能真交叉。
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      assert.equal(properlyCrosses({ x: a.ax, z: a.az }, { x: a.bx, z: a.bz },
        { x: b.ax, z: b.az }, { x: b.bx, z: b.bz }), false, 'longitudinal lines cross');
    }
  }
});

test('sharp bends bevel the outer line instead of letting it leave the pavement or cross', () => {
  const points = [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 60, z: 60 }, { x: 120, z: 60 }];
  const width = 13, halfWidth = width / 2;
  const { strips } = createMarkingLayout(graphFor(points, { width, lanes: 4, direction: 0 }));
  const lines = longitudinal(strips);
  for (const strip of lines) {
    for (const p of [{ x: strip.ax, z: strip.az }, { x: strip.bx, z: strip.bz }]) {
      assert.ok(nearest(points, p) <= halfWidth + 0.02, 'sharp bend left the pavement');
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      assert.equal(properlyCrosses({ x: a.ax, z: a.az }, { x: a.bx, z: a.bz },
        { x: b.ax, z: b.az }, { x: b.bx, z: b.bz }), false, 'sharp bend lines cross');
    }
  }
});

test('signalled approaches cut longitudinal markings before the stop line and draw the crossing', () => {
  const points = [{ x: 0, z: 0 }, { x: 120, z: 0 }];
  const graph = graphFor(points, { width: 9.8, lanes: 3, direction: 1 });
  const approach = { sourceIndex: 0, to: 1, osmNodeId: 7, group: 0,
    stopX: 117, stopZ: 0, dx: 1, dz: 0, widthM: 9.8 };
  const { strips, statistics } = createMarkingLayout(graph, { intersections: [{ id: 'junction', bounds: [-1, -1, 121, 1], approaches: [approach] }] });
  const lines = longitudinal(strips);
  assert.equal(lines.length > 0, true);
  const furthest = Math.max(...lines.flatMap(strip => [strip.ax, strip.bx]));
  assert.ok(furthest <= 117 - 5.1 + 1e-6, `marking ran through the stop line at ${furthest}`);
  assert.equal(strips.filter(strip => strip.kind === 'stop').length, 1);
  assert.ok(strips.filter(strip => strip.kind === 'crosswalk').length > 0);
  assert.equal(statistics.stopLines, 1);
  assert.equal(statistics.crosswalks, 1);
  assert.equal(statistics.breakLinks, 1);
});

test('unsignalised crossings paint no zebra unless the crossing is verified', () => {
  const points = [{ x: 0, z: 0 }, { x: 120, z: 0 }];
  const graph = graphFor(points, { width: 9.8, lanes: 3, direction: 1 });
  const approach = { sourceIndex: 0, to: 1, osmNodeId: 7,
    stopX: 117, stopZ: 0, dx: 1, dz: 0, widthM: 9.8 };
  const plain = createMarkingLayout(graph, { intersections: [{ id: 'junction', bounds: [-1, -1, 121, 1], approaches: [approach] }] });
  assert.equal(plain.strips.some(strip => strip.kind === 'crosswalk' || strip.kind === 'stop'), false);
  assert.equal(plain.statistics.breakLinks, 0);
  assert.ok(Math.max(...longitudinal(plain.strips).flatMap(strip => [strip.ax, strip.bx])) > 117);

  const verified = createMarkingLayout(graph, { intersections: [{ id: 'junction', bounds: [-1, -1, 121, 1], approaches: [{ ...approach, crosswalk: true }] }] });
  assert.ok(verified.strips.filter(strip => strip.kind === 'crosswalk').length > 0);
  assert.equal(verified.strips.some(strip => strip.kind === 'stop'), false);
  assert.equal(verified.statistics.breakLinks, 0);
});

test('bridges, tunnels and layered links stay unpainted', () => {
  const graph = graphFor([{ x: 0, z: 0 }, { x: 120, z: 0 }], { width: 13, lanes: 4, direction: 0 });
  for (const metadata of [{ bridge: true }, { tunnel: true }, { layer: 1 }]) {
    graph.metadata[0] = { ...GROUND, ...metadata };
    const { strips, statistics } = createMarkingLayout(graph);
    assert.equal(strips.length, 0);
    assert.equal(statistics.paintedLinks, 0);
  }
});

test('both ends of a two-way link are cut when both directions have a signal approach', () => {
  const points = [{ x: 0, z: 0 }, { x: 200, z: 0 }];
  const graph = graphFor(points, { width: 13, lanes: 4, direction: 0 });
  const at = (stopX, to, dx) => ({ sourceIndex: 0, to, osmNodeId: 10 + to, group: 0,
    stopX, stopZ: 0, dx, dz: 0, widthM: 13 });
  const { strips, statistics } = createMarkingLayout(graph, { intersections: [{ id: 'both', bounds: [-1, -1, 201, 1],
    approaches: [at(4, 0, -1), at(196, 1, 1)] }] });
  const lines = longitudinal(strips);
  const xs = lines.flatMap(strip => [strip.ax, strip.bx]);
  assert.ok(Math.min(...xs) >= 4 + 5.1 - 1e-6, 'approach end was not cut');
  assert.ok(Math.max(...xs) <= 196 - 5.1 + 1e-6, 'exit end was not cut');
  assert.equal(strips.filter(strip => strip.kind === 'stop').length, 2);
  assert.ok(strips.filter(strip => strip.kind === 'crosswalk').length > 0);
  assert.equal(statistics.breakLinks, 1);
});

test('the narrow-road boundary follows the 7 m rule and the estimated lane count', () => {
  const plan = (width, lanes) => createLanePlan([0, 1, 0, width, lanes, 0, []], GROUND);
  assert.equal(plan(6.99, 2).narrow, true);
  assert.equal(plan(7, 2).narrow, true);
  // 7 m 的 OSM 三车道双向路已够拆线，不再按窄路处理。
  assert.equal(plan(7, 3).narrow, false);
  assert.deepEqual([...plan(7, 3).internal.map(item => item.kind)], ['double-yellow', 'dashed-white']);
  assert.equal(plan(10, 0).narrow, false);
});
