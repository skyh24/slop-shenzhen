const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/sz-polygon.js'), 'utf8');
const {
  ringArea, ringPerimeter, ringCentroid, sampleRing, distanceToRing, largestRing, outerRings,
  finitePoint, landmarkCenter, ringContains, polygonContains, ringContainsInclusive,
  polygonContainsInclusive
} = loadModule(source);
// vm 沙箱里创建的对象原型和主上下文不同，assert/strict 的深度比较前先转成普通对象。
const plain = value => JSON.parse(JSON.stringify(value));

const rectangle = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 20 }, { x: 0, z: 20 }];
const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
// 凹多边形：10×10 的 L 形，去掉右上 6×6 的缺口。
const concave = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 }, { x: 4, z: 4 }, { x: 4, z: 10 }, { x: 0, z: 10 }];
const courtyard = {
  outer: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }],
  holes: [[{ x: 3, z: 3 }, { x: 7, z: 3 }, { x: 7, z: 7 }, { x: 3, z: 7 }]]
};

test('ring measures handle rectangles, triangles and concave rings', () => {
  assert.equal(ringArea(rectangle), 200);
  assert.equal(ringPerimeter(rectangle), 60);
  assert.deepEqual(plain(ringCentroid(rectangle)), { x: 5, z: 10 });
  assert.equal(ringArea(concave), 64);
  assert.equal(ringPerimeter(concave), 40);
  assert.deepEqual(plain(ringCentroid(concave)), { x: 3.875, z: 3.875 });
  assert.ok(Math.abs(ringArea([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }]) - 50) < 1e-9);
  assert.ok(Math.abs(ringCentroid([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }]).x - 10 / 3) < 1e-9);
  assert.equal(ringArea(rectangle.slice().reverse()), 200, 'winding direction does not change area');
});

test('degenerate rings stay finite instead of throwing', () => {
  assert.equal(ringArea([]), 0);
  assert.equal(ringArea([{ x: 1, z: 1 }]), 0);
  assert.equal(ringArea([{ x: 0, z: 0 }, { x: 10, z: 0 }]), 0);
  assert.equal(ringPerimeter([]), 0);
  assert.deepEqual(plain(ringCentroid([{ x: 0, z: 0 }, { x: 10, z: 0 }])), { x: 5, z: 0 });
  assert.deepEqual(plain(ringCentroid([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }])), { x: 5, z: 0 });
  assert.equal(ringContains([], 0, 0), false);
  assert.equal(ringContains([{ x: 0, z: 0 }, { x: 10, z: 0 }], 5, 0), false);
  assert.equal(ringContainsInclusive([], 0, 0), false);
  assert.equal(polygonContains({ outer: [], holes: [] }, 0, 0), false);
  assert.equal(polygonContainsInclusive({ outer: [], holes: [] }, 0, 0), false);
  assert.equal(distanceToRing([], 0, 0), Infinity);
});

test('ring sampling walks the perimeter with the local tangent', () => {
  assert.deepEqual(plain(sampleRing(rectangle, 0)), { x: 0, z: 0, dx: 1, dz: 0 });
  assert.deepEqual(plain(sampleRing(rectangle, 0.25)), { x: 10, z: 5, dx: 0, dz: 1 });
  assert.deepEqual(plain(sampleRing(rectangle, 0.5)), { x: 10, z: 20, dx: 0, dz: 1 });
  assert.deepEqual(plain(sampleRing(rectangle, -0.25)), { x: 0, z: 15, dx: 0, dz: -1 });
  assert.deepEqual(plain(sampleRing(rectangle, 1)), { x: 0, z: 0, dx: 1, dz: 0 });
});

test('distance to ring measures the nearest edge, inside or outside', () => {
  assert.equal(distanceToRing(rectangle, 5, 10), 5);
  assert.equal(distanceToRing(rectangle, -5, 10), 5);
  assert.equal(distanceToRing(rectangle, 0, 7), 0);
  assert.equal(distanceToRing(rectangle, -3, -4), 5);
  assert.equal(distanceToRing(concave, 8, 8), 4);
});

test('largestRing picks the biggest ring and keeps the first on ties', () => {
  const small = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }];
  const first = rectangle;
  const bigger = [{ x: 100, z: 100 }, { x: 120, z: 100 }, { x: 120, z: 120 }, { x: 100, z: 120 }];
  const sameSize = [{ x: 200, z: 200 }, { x: 210, z: 200 }, { x: 210, z: 220 }, { x: 200, z: 220 }];
  assert.equal(largestRing([small, first, bigger]), bigger);
  assert.equal(largestRing([first, sameSize]), first, 'equal area keeps the earlier ring');
});

test('outerRings keeps only usable polygon exteriors in source order', () => {
  const valid = rectangle;
  const tiny = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
  const broken = [{ x: 0, z: 0 }, { x: 1, z: Number.NaN }, { x: 1, z: 1 }];
  const other = square;
  assert.deepEqual(plain(outerRings({ polygons: [{ outer: valid }, { outer: tiny }, { outer: broken }, { outer: other }] })),
    plain([valid, other]));
  assert.deepEqual(plain(outerRings({ polygons: [] })), []);
  assert.deepEqual(plain(outerRings(null)), []);
  assert.deepEqual(plain(outerRings({ polygons: [{ holes: [] }] })), []);
});

test('finitePoint and landmarkCenter reject unknown coordinates', () => {
  assert.equal(finitePoint({ x: 0, z: 0 }), true);
  assert.equal(finitePoint({ x: -1.5, z: 2 }), true);
  assert.equal(finitePoint({ x: Number.NaN, z: 0 }), false);
  assert.equal(finitePoint({ x: 0, z: Infinity }), false);
  assert.equal(finitePoint(null), false);
  assert.equal(finitePoint(undefined), false);
  const landmarks = [{ id: 'a', x: 1, z: 2, height: 30 }, { id: 'b', x: Number.NaN, z: 2 }];
  assert.deepEqual(plain(landmarkCenter(landmarks, 'a')), { x: 1, z: 2 });
  assert.equal(landmarkCenter(landmarks, 'b'), null);
  assert.equal(landmarkCenter(landmarks, 'missing'), null);
  assert.equal(landmarkCenter(undefined, 'a'), null);
});

test('even-odd containment rejects the concave notch and trims holes', () => {
  assert.equal(ringContains(concave, 2, 8), true);
  assert.equal(ringContains(concave, 8, 2), true);
  assert.equal(ringContains(concave, 8, 8), false);
  assert.equal(polygonContains(courtyard, 1, 1), true);
  assert.equal(polygonContains(courtyard, 5, 5), false);
  assert.equal(ringContains(courtyard.outer, 5, 5), true);
  const twoHoles = {
    outer: square,
    holes: [
      [{ x: 3, z: 3 }, { x: 7, z: 3 }, { x: 7, z: 7 }, { x: 3, z: 7 }],
      [{ x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 2 }, { x: 1, z: 2 }]
    ]
  };
  assert.equal(polygonContains(twoHoles, 8, 8), true);
  assert.equal(polygonContains(twoHoles, 1.5, 1.5), false);
  assert.equal(polygonContains({ outer: square }, 5, 5), true, 'missing holes means no holes');
  assert.equal(polygonContains({ outer: square, holes: [[]] }, 5, 5), true);
});

test('inclusive containment counts the outer boundary but not the hole boundary', () => {
  assert.equal(ringContainsInclusive(square, 5, 0), true);
  assert.equal(ringContainsInclusive(square, 0, 5), true);
  assert.equal(ringContainsInclusive(square, 10, 5), true);
  assert.equal(ringContainsInclusive(square, 5, 10), true);
  assert.equal(ringContainsInclusive(square, 10.001, 5), false);
  assert.equal(polygonContainsInclusive(courtyard, 1, 1), true);
  assert.equal(polygonContainsInclusive(courtyard, 5, 5), false);
  assert.equal(polygonContainsInclusive(courtyard, 5, 3), false, 'hole edge belongs to the hole');
  assert.equal(polygonContainsInclusive(courtyard, 5, 0), true, 'outer edge belongs to the polygon');
  assert.equal(polygonContainsInclusive({ outer: square }, 5, 5), true, 'missing holes means no holes');
});

test('the two containment semantics differ on outer edges', () => {
  // 奇偶规则是半开区间：底边和左边算内，顶边和右边算外；边界点结果依赖边的方向。
  assert.equal(ringContains(square, 5, 0), true);
  assert.equal(ringContains(square, 0, 5), true);
  assert.equal(ringContains(square, 5, 10), false);
  assert.equal(ringContains(square, 10, 5), false);
  assert.equal(ringContainsInclusive(square, 5, 10), true);
  assert.equal(ringContainsInclusive(square, 10, 5), true);
});
