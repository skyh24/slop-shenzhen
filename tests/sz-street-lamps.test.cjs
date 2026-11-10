const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const roads = loadModule(read('sz-roads.js'), { imports: { 'three/webgpu': {} } });
const lamps = loadModule(read('sz-street-lamps.js'), { imports: {
  'three/webgpu': {}, 'three/tsl': { color: () => ({}), uniform: () => ({ value: 0 }) },
  './sz-roads.js': roads
} });

function graph(links, metadata) {
  return { nodes: [0, 0, 300, 0, 300, 300], nodeIds: ['node/1', 'node/2', 'node/3'],
    names: [''], links, metadata };
}

const ground = () => ({ heightSource: 'terrain', bridge: false, tunnel: false, layer: 0, highway: 'primary' });

test('street lamps are spaced along both sides of ground primary roads', () => {
  const link = [0, 1, 0, 12, 3, 0, []];
  const plan = lamps.planLampSites(graph([link], [ground()]));
  assert.ok(plan.sites.length >= 22 && plan.sites.length <= 28, `sites=${plan.sites.length}`);
  const sides = new Set(plan.sites.map(site => site.side));
  assert.deepEqual([...sides].sort(), [-1, 1]);
  for (const site of plan.sites) {
    assert.ok(Number.isFinite(site.x) && Number.isFinite(site.z) && Number.isFinite(site.yaw));
    assert.equal(site.class, 'primary');
  }
  const north = plan.sites.filter(site => site.side === 1).map(site => site.x).sort((a, b) => a - b);
  for (let i = 1; i < north.length; i++) assert.ok(Math.abs(north[i] - north[i - 1] - 22) < 1.5);
  // 灯臂必须朝路中心：灯头比灯杆更靠近中心线。
  const site = plan.sites[0];
  const headX = site.x + Math.cos(site.yaw) * 2.2;
  const headZ = site.z - Math.sin(site.yaw) * 2.2;
  assert.ok(Math.abs(headZ) < Math.abs(site.z), 'arm points back towards the centre line');
  assert.ok(Math.abs(headX - site.x) < 1e-9, 'arm is perpendicular to an east-west link');
});

test('street lamps skip bridges, tunnels, layered and minor roads', () => {
  const links = [[0, 1, 0, 12, 3, 0, []], [1, 2, 0, 12, 3, 0, []], [0, 1, 0, 12, 3, 0, []], [1, 2, 0, 12, 3, 0, []]];
  const metadata = [
    { ...ground(), bridge: true },
    { ...ground(), tunnel: true },
    { ...ground(), layer: 1 },
    { ...ground(), highway: 'residential' }
  ];
  const plan = lamps.planLampSites(graph(links, metadata));
  assert.equal(plan.sites.length, 0);
  assert.ok(plan.rejected.bridgeOrTunnelOrLayer >= 3);
  assert.ok(plan.rejected.unsupportedClass >= 1);
});

test('street lamp planning is deterministic and chunk grouping keeps every site', () => {
  const links = [[0, 1, 0, 16, 4, 0, []], [1, 2, 0, 12, 3, 0, []]];
  const metadata = [ground(), { ...ground(), highway: 'trunk' }];
  const first = lamps.planLampSites(graph(links, metadata));
  const second = lamps.planLampSites(graph(links, metadata));
  assert.deepEqual(first, second);
  assert.ok(first.sites.length > 0);
  const chunks = lamps.groupLampSites(first.sites, 500);
  const total = [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
  assert.equal(total, first.sites.length);
  for (const key of chunks.keys()) assert.match(key, /^-?\d+,-?\d+$/);
});

test('street lamp planner rejects malformed road graphs', () => {
  assert.throws(() => lamps.planLampSites(null), /Road graph/);
  assert.throws(() => lamps.planLampSites({ links: [], metadata: [], nodes: [] }), /Road graph/);
});
