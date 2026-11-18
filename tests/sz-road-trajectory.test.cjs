const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const driving = require('./helpers/driving.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
// 只装载足迹探针支撑和轨迹模块：不创建车流场景、车型网格或 three 上下文。
const trajectory = loadModule(read('sz-road-trajectory.js'), { imports: driving });
const { isTrunkRamp, laneRoute, poseOnRoute, routeModelBounds } = trajectory;

const SPEC = { track: 1.6, wheelbase: 2.8 };
const bounds = { min: { x: -0.95, y: 0, z: -2.4 }, max: { x: 0.95, y: 1.8, z: 2.4 } };
const model = routeModelBounds(bounds, SPEC);
const round = value => Math.round(value * 1e6) / 1e6;
const at = (samples, index) => {
  const p = samples[index];
  return [round(p.x), round(p.z), round(p.dx), round(p.dz), round(p.s), p.laneOffset ?? null];
};
const line = (edge, z = 0) => Array.from({ length: 101 }, (_, i) =>
  ({ x: i * 2, z, dx: 1, dz: 0, s: i * 2, edge }));

test('road trajectory module declares no rendering, vehicle or traffic dependencies', () => {
  const specifiers = [...read('sz-road-trajectory.js').matchAll(/^import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)]
    .map(match => match[1]);
  assert.deepEqual(specifiers, ['./sz-driving-motion.js']);
});

test('planner and traffic consume the same road trajectory implementation', () => {
  for (const file of ['sz-traffic.js', 'sz-drive-route.js']) {
    const source = read(file);
    assert.match(source, /from '\.\/sz-road-trajectory\.js'/);
    assert.doesNotMatch(source, /function (?:laneRoute|poseOnRoute)\b/);
  }
});

test('routeModelBounds derives the probe model from collision bounds and vehicle spec', () => {
  // vm 沙箱对象与宿主的原型不同，逐字段比较，避免跨 realm 的严格原型检查。
  assert.deepEqual([model.x, model.y, model.z, model.hx, model.hy, model.hz, model.halfTrack, model.halfWheelbase],
    [0, 0.9, 0, 0.95, 0.9, 2.4, 0.8, 1.4]);
  assert.deepEqual(Array.from(model.corners, corner => Array.from(corner)),
    [[-0.95, -2.4], [-0.95, 2.4], [0.95, -2.4], [0.95, 2.4]]);
});

test('laneRoute keeps fixed samples across a right-angle bend', () => {
  const a = { osmId: 'way/a', section: {} };
  const b = { osmId: 'way/b', section: {} };
  const samples = laneRoute([
    { x: 0, z: 0, dx: 1, dz: 0, length: 100, edge: a, laneOffset: 2 },
    { x: 100, z: 0, dx: 0, dz: 1, length: 100, edge: b, laneOffset: -2 }
  ], 3.2);
  assert.equal(samples.length, 104);
  assert.deepEqual([0, 1, 49, 50, 51, 52, 53, 103].map(index => at(samples, index)), [
    [0, 0, 1, 0, 0, 2],
    [1.97551, 0, 1, 0, 1.97551, 2],
    [96.8, 0, 1, 0, 96.8, 2],
    [97.894656, 0.142336, 0.96236, 0.271778, 97.903871, 2],
    [98.783488, 0.555008, 0.821433, 0.570305, 98.88383, 2],
    [99.444992, 1.216512, 0.570305, 0.821433, 99.819338, -2],
    [99.857664, 2.105344, 0.271778, 0.96236, 100.799298, -2],
    [100, 100, 0, 1, 198.703169, -2]
  ]);
  // 急弯仍须连续：里程严格递增，相邻点距离与里程增量一致，方向从 x 轴转到 z 轴。
  for (let i = 1; i < samples.length; i++) {
    const step = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    assert.ok(samples[i].s > samples[i - 1].s);
    assert.ok(Math.abs(step - (samples[i].s - samples[i - 1].s)) < 1e-9);
  }
  assert.ok(Math.abs(samples[0].dx - 1) < 1e-9 && Math.abs(samples[0].dz) < 1e-9);
  assert.ok(Math.abs(samples.at(-1).dx) < 1e-9 && Math.abs(samples.at(-1).dz - 1) < 1e-9);
});

test('laneRoute keeps fixed samples when a reviewed trunk ramp blends into the mainline', () => {
  const main = { osmId: 'way/m', highway: 'primary', section: { reviewed: true, pavementWidthM: 8 } };
  const ramp = { osmId: 'way/r', highway: 'trunk_link', section: { reviewed: false, pavementWidthM: 6 } };
  const next = { osmId: 'way/n', highway: 'primary', section: { reviewed: true, pavementWidthM: 8 } };
  assert.equal(isTrunkRamp(ramp), true);
  assert.equal(isTrunkRamp(main), false);
  const samples = laneRoute([
    { x: 0, z: 0, dx: 1, dz: 0, length: 50, edge: main, laneOffset: 3.5 },
    { x: 50, z: 0, dx: 1, dz: 0, length: 50, edge: main, laneOffset: 3.5 },
    { x: 100, z: 0, dx: 0.8, dz: 0.6, length: 25, edge: ramp, laneOffset: 0 },
    { x: 120, z: 15, dx: 0.8, dz: 0.6, length: 25, edge: ramp, laneOffset: 0 },
    { x: 140, z: 30, dx: 1, dz: 0, length: 100, edge: next, laneOffset: -3.5 }
  ]);
  assert.equal(samples.length, 166);
  assert.deepEqual([0, 55, 56, 57, 165].map(index => at(samples, index)), [
    [0, 0, 1, 0, 0, 3.5],
    [99.47008, 0.10496, 0.975654, 0.219317, 99.476113, 3.5],
    [100.36096, 0.40192, 0.912113, 0.409939, 100.415183, null],
    [101.152, 0.864, 0.8, 0.6, 101.331295, null],
    [240, 30, 1, 0, 249.78259, -3.5]
  ]);
});

test('laneRoute keeps fixed samples when a bridge deck splits toward a ground fork', () => {
  const deck = { osmId: 'way/d1', section: { pavementWidthM: 8 }, groundFork: { 'way/d2': 1 } };
  const branch = { osmId: 'way/d2', section: { pavementWidthM: 8 } };
  const samples = laneRoute([
    { x: 0, z: 0, dx: 1, dz: 0, length: 100, edge: deck, laneOffset: 0 },
    { x: 100, z: 0, dx: 0, dz: 1, length: 100, edge: branch, laneOffset: 3 }
  ]);
  assert.equal(samples.length, 125);
  assert.deepEqual([0, 48, 52, 124].map(index => at(samples, index)), [
    [0, 0, 1, 0, 0, null],
    [78.56, -1.440878, 0.987785, -0.155823, 78.644332, null],
    [82.561868, -2.093259, 0.986503, -0.163741, 82.69904, null],
    [100, 100, 0, 1, 203.102877, 3]
  ]);
});

test('poseOnRoute follows the deck for elevated edges and keeps ground height underneath', () => {
  const deckEdge = { osmId: 'way/e1', elevated: true, surfaceId: 'sz-elevated-road:300' };
  const groundEdge = { osmId: 'way/g1', elevated: false };
  // 高度函数按边的表面身份取高度：高架边只能拿到桥面，地面边只能拿到地面。
  const height = (x, z, edge) => edge?.surfaceId ? 12.5 : 6;
  const pose = {};
  assert.equal(poseOnRoute(line(deckEdge), 100, model, height, pose), true);
  assert.equal(pose.edge, deckEdge);
  assert.ok(Math.abs(pose.y - 12.5) < 1e-9, `elevated pose y ${pose.y}`);
  assert.equal(poseOnRoute(line(groundEdge), 100, model, height, pose), true);
  assert.equal(pose.edge, groundEdge);
  assert.ok(Math.abs(pose.y - 6) < 1e-9, `ground pose keeps its own height ${pose.y}`);
  assert.equal(poseOnRoute(line(deckEdge), 100, model, () => null, pose), false);
});

test('route support case flush seam: a pose spans both segments and records both identities', () => {
  const a = { osmId: 'way/a', surfaceId: 'sz-elevated-road:1' };
  const b = { osmId: 'way/b', surfaceId: 'sz-elevated-road:2' };
  const samples = Array.from({ length: 101 }, (_, i) => {
    const s = i * 2;
    return { x: s, z: 0, dx: 1, dz: 0, s, edge: s <= 100 ? a : b };
  });
  const height = (x, z, edge) => x <= 100 ? (edge === a ? 5 : null) : (edge === b ? 5 : null);
  const pose = {};
  assert.equal(poseOnRoute(samples, 100, model, height, pose), true);
  assert.equal(pose.y, 5);
  assert.equal(pose.edge, a);
  assert.deepEqual([...pose.supportedSlabs].sort(), ['sz-elevated-road:1', 'sz-elevated-road:2']);
});

test('route support case stacked levels: the route edge identity decides the level', () => {
  const deck = { osmId: 'way/deck', surfaceId: 'deck' };
  const ground = { osmId: 'way/ground' };
  const height = (x, z, edge) => edge?.surfaceId ? 8 : 4;
  const pose = {};
  assert.equal(poseOnRoute(line(deck), 100, model, height, pose), true);
  assert.deepEqual([pose.y, pose.edge], [8, deck]);
  assert.deepEqual([...pose.supportedSlabs], ['deck']);
  assert.equal(poseOnRoute(line(ground), 100, model, height, pose), true);
  assert.deepEqual([pose.y, pose.edge], [4, ground], 'the ground line keeps its own height under the deck');
  assert.equal(pose.supportedSlabs.size, 0, 'a ground edge without an identity clears the previous slab');
});

test('route support case: wheels on the strip but corners beyond it fail the pose', () => {
  const pose = {};
  const deckEndsEarly = (x, z) => x <= 101 ? 5 : null;
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, deckEndsEarly, pose), false,
    'front wheels past the deck end leave no support');
  const cornersBeyond = (x, z) => x <= 101.5 ? 5 : null;
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, cornersBeyond, pose), false,
    'wheels on the strip are not enough when a corner is off it');
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, x => x <= 103 ? 5 : null, pose), true);
});

test('route support case slopes: 10 percent is accepted, 25 percent cross slope exceeds the roll limit', () => {
  const pose = {};
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, (x, z) => 5 + 0.1 * z, pose), true);
  assert.ok(Math.abs(pose.roll) < 0.2);
  assert.ok(Math.abs(pose.y - 5) < 1e-9);
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, (x, z) => 5 + 0.1 * x, pose), true);
  assert.ok(Math.abs(pose.pitch) < 0.28, 'a 10 percent grade stays inside the pitch limit');
  assert.equal(poseOnRoute(line({ surfaceId: 'deck' }), 100, model, (x, z) => 5 + 0.25 * z, pose), false,
    'a 25 percent cross slope is rejected even though every probe has a surface');
});

test('lateral movement samples support and heading at the actual vehicle footprint', () => {
  const pose = {};
  const samples = line({ surfaceId: 'deck' });
  const pavement = (x, z) => Math.abs(z) < 2 ? 5 : null;
  assert.equal(poseOnRoute(samples, 100, model, pavement, pose), true);
  assert.equal(poseOnRoute(samples, 100, model, pavement, pose, 3.5), false);
  assert.equal(poseOnRoute(samples, 100, model, () => 5, pose, 3.5, -0.12), true);
  assert.ok(Math.abs(pose.z - 3.5) < 1e-9);
  assert.ok(Math.abs(pose.heading - (Math.PI / 2 - 0.12)) < 1e-9);
});
