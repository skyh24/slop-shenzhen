const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const { createDetailResidency } = loadModule(read('sz-detail-residency.js'));

// 单位替身：创建计数和释放计数分开，便于断言「只创建一次」「只释放一次」。
function unit(counts) {
  return { dispose() { counts.releases++; } };
}

test('malformed thresholds, schedules and updates fail loudly', () => {
  assert.throws(() => createDetailResidency(), /finite enter distance/);
  assert.throws(() => createDetailResidency({ enterM: 100, exitM: 50 }), /cannot be shorter than its enter distance/);
  assert.throws(() => createDetailResidency({ enterM: 100, schedule: 'later' }), /requires a schedule function/);
  const residency = createDetailResidency({ enterM: 100 });
  assert.throws(() => residency.update(Number.NaN, () => unit({ releases: 0 })), /finite distance/);
  assert.throws(() => residency.update(10), /requires a build function/);
  residency.dispose();
  assert.throws(() => residency.update(10, () => unit({ releases: 0 })), /cannot update after dispose/);
});

test('enters at the enter radius and only leaves past the exit radius', () => {
  const counts = { builds: 0, releases: 0 };
  const residency = createDetailResidency({ enterM: 210, exitM: 265 });
  const build = () => { counts.builds++; return unit(counts); };
  assert.equal(residency.active, false);
  const first = residency.update(210, build);
  assert.ok(first, 'the enter boundary is inclusive');
  assert.equal(counts.builds, 1);
  assert.equal(residency.update(265, build), first, 'the exit band still holds the unit');
  assert.equal(counts.builds, 1);
  assert.equal(counts.releases, 0);
  assert.equal(residency.update(265.001, build), null);
  assert.equal(counts.releases, 1);
  // 释放后回到 210–265 m 带内不重建，只有再进 210 m 才重建一次。
  assert.equal(residency.update(264, build), null);
  assert.equal(counts.builds, 1);
  const reentered = residency.update(210, build);
  assert.ok(reentered);
  residency.update(205, build);
  assert.equal(counts.builds, 2);
});

test('movement around the thresholds never churns create and release', () => {
  const counts = { builds: 0, releases: 0 };
  const residency = createDetailResidency({ enterM: 210, exitM: 265 });
  const build = () => { counts.builds++; return unit(counts); };
  for (let i = 0; i < 8; i++) { residency.update(209, build); residency.update(211, build); }
  assert.deepEqual(counts, { builds: 1, releases: 0 });
  for (let i = 0; i < 8; i++) { residency.update(264, build); residency.update(266, build); }
  assert.deepEqual(counts, { builds: 1, releases: 1 });
  for (let i = 0; i < 8; i++) { residency.update(212, build); residency.update(264, build); }
  assert.deepEqual(counts, { builds: 1, releases: 1 });
  residency.update(210, build);
  assert.deepEqual(counts, { builds: 2, releases: 1 });
});

test('a queued build that outlives the stay is never mounted', () => {
  const tasks = [];
  const counts = { builds: 0, releases: 0 };
  const residency = createDetailResidency({ enterM: 210, exitM: 265, schedule: task => tasks.push(task) });
  const build = () => { counts.builds++; return unit(counts); };
  residency.update(200, build);
  assert.equal(tasks.length, 1);
  residency.update(400, build);
  assert.equal(tasks.length, 1, 'leaving does not queue a second task');
  tasks.shift()();
  assert.equal(counts.builds, 0);
  assert.equal(residency.active, false);
  residency.update(200, build);
  assert.equal(tasks.length, 1);
  tasks.shift()();
  assert.equal(counts.builds, 1);
  assert.equal(residency.active, true);
});

test('re-entry creates once even when several frames queue before the build runs', () => {
  const tasks = [];
  const counts = { builds: 0, releases: 0 };
  const residency = createDetailResidency({ enterM: 210, exitM: 265, schedule: task => tasks.push(task) });
  const build = () => { counts.builds++; return unit(counts); };
  for (let i = 0; i < 6; i++) residency.update(200, build);
  assert.equal(tasks.length, 1, 'one in-flight build per residency');
  tasks.shift()();
  assert.equal(counts.builds, 1);
  for (let i = 0; i < 4; i++) residency.update(250, build);
  assert.equal(tasks.length, 0, 'the exit band does not queue another build');
  residency.update(266, build);
  assert.equal(counts.releases, 1);
  residency.update(200, build);
  residency.update(200, build);
  assert.equal(tasks.length, 1);
  tasks.shift()();
  assert.equal(counts.builds, 2);
  assert.equal(counts.releases, 1);
});

test('releasing one unit leaves the shared resources to their owner', () => {
  const shared = { material: { disposed: 0, dispose() { this.disposed++; } },
    geometry: { disposed: 0, dispose() { this.disposed++; } } };
  const residency = createDetailResidency({ enterM: 100, exitM: 140 });
  const live = residency.update(50, () => ({ dispose() {} }));
  assert.ok(live);
  assert.equal(shared.material.disposed, 0);
  residency.update(200, () => ({ dispose() {} }));
  assert.equal(shared.material.disposed, 0, 'the unit only releases what it created');
  residency.dispose();
  assert.equal(shared.geometry.disposed, 0);
  shared.material.dispose();
  shared.geometry.dispose();
  assert.equal(shared.material.disposed, 1);
});

test('dispose releases once, drops queued work and refuses later updates', () => {
  const tasks = [];
  const counts = { builds: 0, releases: 0 };
  const residency = createDetailResidency({ enterM: 100, exitM: 140, schedule: task => tasks.push(task) });
  residency.update(50, () => { counts.builds++; return unit(counts); });
  assert.equal(tasks.length, 1);
  residency.dispose();
  tasks.shift()();
  assert.equal(counts.builds, 0);
  assert.equal(residency.active, false);
  residency.dispose();
  assert.throws(() => residency.update(10, () => unit(counts)), /cannot update after dispose/);

  const liveCounts = { builds: 0, releases: 0 };
  const other = createDetailResidency({ enterM: 100 });
  other.update(10, () => { liveCounts.builds++; return unit(liveCounts); });
  other.dispose();
  other.dispose();
  assert.equal(liveCounts.releases, 1);
});

test('both shoreline close-up consumers use one residency rule', () => {
  const bay = read('sz-bay-waterfront.js');
  const regional = read('sz-regional-scene.js');
  assert.match(bay, /createDetailResidency\(\{ enterM: 210, exitM: 265, schedule: scheduleDetail \}\)/);
  assert.match(regional, /createDetailResidency\(\{ enterM: 275, exitM: 335,\s*schedule: build => stream\.visual\(build, row\) \}\)/);
  // 旧的闭包状态不再由调用方维护。
  assert.doesNotMatch(bay, /wantsDetails|d2 > 265/);
  assert.doesNotMatch(regional, /desired = d < 275|if \(live && d > 335\)/);
});
