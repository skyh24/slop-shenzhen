const test = require('node:test');
const assert = require('node:assert/strict');
const { CROSS_PROBES, SQUARE_PROBES, SITE_CATEGORIES, createPlacementTally, nearbyObstacle,
  probePoints, probeSite, rotatePoint } = require('./helpers/site-probe.cjs');

test('probe points scale each axis and turn with the site yaw', () => {
  const points = probePoints({ x: 10, z: -4, radius: 2, radiusZ: 1, yaw: Math.PI / 2 });
  assert.equal(points.length, 5);
  assert.equal(points[0].x, 10);
  assert.equal(points[0].z, -4);
  const east = rotatePoint(10, -4, Math.PI / 2, 2, 0);
  assert.ok(Math.abs(points[1].x - east.x) < 1e-12);
  assert.ok(Math.abs(points[1].z - east.z) < 1e-12);
  const north = rotatePoint(10, -4, Math.PI / 2, 0, 1);
  assert.ok(Math.abs(points[3].x - north.x) < 1e-12);
  assert.ok(Math.abs(points[3].z - north.z) < 1e-12);
});

test('probe site takes the lowest ground sample and reports the first failing rule', () => {
  const heights = new Map([['0,0', 8], ['2,0', 7], ['-2,0', 9], ['0,2', 6], ['0,-2', 10]]);
  const site = probeSite({
    x: 0, z: 0, radius: 2, ground: (x, z) => heights.get(`${x},${z}`) ?? 5,
    rules: [{ reason: 'roadConflict', category: 'road', test: point => point.x === 2 }]
  });
  assert.equal(site.y, 6);
  assert.equal(site.reason, 'roadConflict');
  assert.equal(site.category, 'road');
  assert.equal(site.probes.length, 5);
});

test('probe site stops at no-ground before any rule and at the first rule in order', () => {
  const missing = probeSite({ x: 0, z: 0, radius: 1, ground: (x) => (x === 0 ? null : 4),
    rules: [{ reason: 'roadConflict', test: () => true }] });
  assert.equal(missing.reason, 'no-ground');
  assert.equal(missing.category, SITE_CATEGORIES.noGround);
  assert.ok(Number.isNaN(missing.y));
  const ordered = probeSite({ x: 0, z: 0, ground: () => 3, rules: [
    { reason: 'buildingConflict', category: 'building', test: () => false },
    { reason: 'pathConflict', category: 'path', test: () => true },
    { reason: 'roadConflict', category: 'road', test: () => true }
  ] });
  assert.equal(ordered.reason, 'pathConflict');
});

test('probe site resolves the landing height before site rules run', () => {
  const site = probeSite({
    x: 1, z: 2, ground: () => 5, resolveY: (x, z, y) => (x === 1 ? 6.5 : y),
    rules: [{ reason: 'buildingConflict', at: 'site', test: ({ y }) => y === 6.5 }]
  });
  assert.equal(site.y, 6.5);
  assert.equal(site.reason, 'buildingConflict');
  assert.equal(site.category, 'buildingConflict');
});

test('probe site rejects malformed tables and scopes', () => {
  assert.throws(() => probeSite({ x: 0, z: 0, ground: () => 1, probes: [] }), /at least one offset/);
  assert.throws(() => probeSite({ x: 0, z: 0, ground: () => 1, probes: [[0, NaN]] }), /finite \[x, z\] pair/);
  assert.throws(() => probeSite({ x: 0, z: 0, ground: () => 1, radius: -1 }), /non-negative probe radii/);
  assert.throws(() => probeSite({ x: Infinity, z: 0, ground: () => 1 }), /finite site position/);
  assert.throws(() => probeSite({ x: 0, z: 0 }), /ground height sampler/);
  assert.throws(() => probeSite({ x: 0, z: 0, ground: () => 1, rules: [{ at: 'corner' }] }), /requires a test/);
  assert.throws(() => probeSite({ x: 0, z: 0, ground: () => 1, rules: [{ at: 'corner', test: () => false }] }), /Unknown site probe scope/);
});

test('nearby obstacle uses the height band, footprint and polygon', () => {
  const polygon = { outer: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], holes: [] };
  const collider = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 0, maxY: 20, polygon };
  assert.equal(nearbyObstacle([collider], { x: 5, y: 1, z: 5, halfX: 0.5, halfZ: 0.5, height: 2 }), true);
  assert.equal(nearbyObstacle([collider], { x: 5, y: 25, z: 5, halfX: 0.5, halfZ: 0.5, height: 2 }), false);
  assert.equal(nearbyObstacle([], { x: 5, y: 1, z: 5, halfX: 0.5, halfZ: 0.5, height: 2 }), false);
  assert.equal(nearbyObstacle([{ ...collider, minX: NaN }], { x: 5, y: 1, z: 5, halfX: 0.5, halfZ: 0.5, height: 2 }), false);
  const notch = { ...collider, polygon: { outer: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }], holes: [] } };
  assert.equal(nearbyObstacle([notch], { x: 8, y: 1, z: 8, halfX: 0.5, halfZ: 0.5, height: 2 }), false);
});

test('placement tally pre-zeroes reasons and separates categories', () => {
  const tally = createPlacementTally(['roadConflict', 'reservedWalk']);
  tally.place();
  tally.skip('roadConflict', 'road');
  tally.skip('reservedWalk', 'reserved');
  tally.skip('woodlandOverlap', 'overlap');
  assert.deepEqual(JSON.parse(JSON.stringify(tally.skipped)),
    { roadConflict: 1, reservedWalk: 1, woodlandOverlap: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(tally.categories)), { road: 1, reserved: 1, overlap: 1 });
  assert.equal(tally.count('reservedWalk'), 1);
  assert.equal(tally.placed, 1);
});

test('probe tables stay frozen and square probes cover the four corners', () => {
  assert.equal(Object.isFrozen(CROSS_PROBES), true);
  assert.equal(Object.isFrozen(SQUARE_PROBES), true);
  assert.equal(SQUARE_PROBES.length, 5);
  for (const [x, z] of SQUARE_PROBES) assert.ok(Math.abs(x) === Math.abs(z));
});
