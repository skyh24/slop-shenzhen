const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadModule } = require('./helpers/module.cjs');

const read = file => readFileSync(join(__dirname, '../js', file), 'utf8');
const load = (name, imports = {}) => loadModule(read(name), { imports });
const terrain = load('sz-terrain.js');
const droneRoutes = load('sz-drone-routes.js', { 'three/webgpu': {}, './sz-terrain.js': terrain });

const air = {
  version: 3,
  verifiedAt: '2026-11-09',
  status: 'source-endpoints-schematic-tracks',
  droneStations: [
    { id: 'a', name: 'A 站', operator: '美团无人机', kind: 'takeoff', x: 0, z: 0,
      coordinateSource: 'test', sourceUrls: ['https://example.com/a'], verifiedAt: '2026-11-09' },
    { id: 'b', name: 'B 站', operator: '美团无人机', kind: 'landing', x: 300, z: 400,
      coordinateSource: 'test', sourceUrls: ['https://example.com/b'], verifiedAt: '2026-11-09' }
  ],
  droneRoutes: [
    { id: 'route-1', name: 'A ⇄ B', operator: '美团无人机', fromStationId: 'a', toStationId: 'b',
      lengthM: 500, trackStatus: 'schematic', altitudeM: 100, altitudeSource: 'estimate',
      sourceUrls: ['https://example.com/a'], sourcePublisher: 'test', sourcePublishedAt: '2023-09-04',
      verifiedAt: '2026-11-09' }
  ],
  apecSuspension: {
    windows: [{ from: '2026-11-07', to: '2026-11-21', areas: 'test', sourceUrl: 'https://example.com/notice' }],
    operatorNotice: { text: '停运', sourceUrl: 'https://example.com/notice' }
  }
};

test('drone plan keeps sourced endpoints and marks schematic tracks', () => {
  const plan = droneRoutes.planDroneFlights(air, { now: new Date('2026-11-01T00:00:00+08:00') });
  assert.equal(plan.routes.length, 1);
  assert.equal(plan.suspended, false);
  const [route] = plan.routes;
  assert.equal(route.from.id, 'a');
  assert.equal(route.to.id, 'b');
  assert.equal(route.lengthM, 500);
  assert.equal(route.altitudeM, 100);
  assert.equal(route.altitudeSource, 'estimate');
  assert.equal(route.flights.length, 2);
  assert.ok(route.flights.every(flight => flight.speedMps > 0 && flight.phase >= 0 && flight.phase < 1));
  assert.ok(droneRoutes.isApecAirSuspended(air, new Date('2026-11-08T12:00:00+08:00')));
  assert.ok(droneRoutes.isApecAirSuspended(air, new Date('2026-11-21T23:00:00+08:00')));
  assert.equal(droneRoutes.isApecAirSuspended(air, new Date('2026-11-22T00:00:00+08:00')), false);
  assert.equal(droneRoutes.isApecAirSuspended(air, new Date('2026-11-06T23:59:00+08:00')), false);
});

test('drone plan drops routes whose station is missing instead of inventing one', () => {
  const broken = { ...air, droneRoutes: [{ ...air.droneRoutes[0], toStationId: 'missing' }] };
  const plan = droneRoutes.planDroneFlights(broken, { now: new Date('2026-11-01T00:00:00+08:00') });
  assert.equal(plan.routes.length, 0);
});

const openNow = new Date('2026-11-01T00:00:00+08:00');
const DT = 0.05;

function openPlan() {
  return droneRoutes.planDroneFlights(air, { now: openNow });
}

// 两个弧度角之间的最小夹角
function headingDelta(a, b) {
  const delta = Math.abs(a - b) % (Math.PI * 2);
  return delta > Math.PI ? Math.PI * 2 - delta : delta;
}

// 按 0.05 秒步长采样一条飞行计划的示意航迹
function sampleTrack(route, flight, steps = 2200) {
  const samples = [];
  for (let step = 0; step <= steps; step++) {
    const elapsed = step * DT;
    const pose = droneRoutes.dronePoseAt(route, flight, elapsed);
    samples.push({ elapsed, ...pose });
  }
  return samples;
}

test('drone pose keeps the initial phase and turns at both endpoints', () => {
  const [route] = openPlan().routes;
  const [outbound, inbound] = route.flights;
  assert.equal(outbound.phase, 0);
  assert.equal(inbound.phase, 0.5);
  assert.equal(outbound.direction, 1);
  assert.equal(inbound.direction, -1);
  const dx = route.to.x - route.from.x;
  const dz = route.to.z - route.from.z;
  const outboundYaw = Math.atan2(dx, dz);
  const inboundYaw = Math.atan2(-dx, -dz);
  const startOut = droneRoutes.dronePoseAt(route, outbound, 0);
  const startIn = droneRoutes.dronePoseAt(route, inbound, 0);
  assert.ok(Math.abs(startOut.travel) < 1e-12, 'outbound starts at the from end');
  assert.ok(Math.abs(startIn.travel - 0.5) < 1e-12, 'inbound starts at its phase point');
  assert.ok(headingDelta(startOut.yaw, outboundYaw) < 1e-9);
  assert.ok(headingDelta(startIn.yaw, inboundYaw) < 1e-9);

  const stepLimit = outbound.speedMps * DT + 1e-9;
  for (const flight of [outbound, inbound]) {
    const samples = sampleTrack(route, flight);
    let maxStep = 0;
    let minToFrom = Infinity;
    let minToTo = Infinity;
    const flips = [];
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1];
      const current = samples[index];
      maxStep = Math.max(maxStep, Math.hypot(current.x - previous.x, current.z - previous.z));
      // 初始时刻就在端点时不算“到达”，从第二段开始统计回到起点端
      if (index > 500) minToFrom = Math.min(minToFrom, Math.hypot(current.x - route.from.x, current.z - route.from.z));
      minToTo = Math.min(minToTo, Math.hypot(current.x - route.to.x, current.z - route.to.z));
      if (current.direction !== previous.direction) flips.push(current);
    }
    assert.ok(maxStep <= stepLimit, `single-frame step ${maxStep} stays within ${stepLimit}`);
    assert.ok(maxStep > stepLimit * 0.9, 'the drone actually cruises instead of standing still');
    assert.ok(minToTo < 0.5, 'the to endpoint is reached');
    assert.ok(minToFrom < 0.5, 'the from endpoint is reached again on the way back');
    assert.equal(flips.length, 2, 'two endpoint turns within 110 s');
    // 第一次过端点后方向反转，第二次过另一端后恢复首段方向
    assert.equal(flips[0].direction, -flight.direction);
    assert.ok(headingDelta(flips[0].yaw, flight.direction > 0 ? inboundYaw : outboundYaw) < 1e-9);
    assert.equal(flips[1].direction, flight.direction);
    assert.ok(headingDelta(flips[1].yaw, flight.direction > 0 ? outboundYaw : inboundYaw) < 1e-9);
  }
});

test('drone without turnAtEnds stops at the destination end', () => {
  const [route] = openPlan().routes;
  const oneWay = { ...route.flights[0], turnAtEnds: false };
  const parked = droneRoutes.dronePoseAt(route, oneWay, route.lengthM / oneWay.speedMps + 5);
  assert.equal(parked.travel, 1);
  assert.equal(parked.direction, 1);
  assert.ok(Math.abs(parked.x - route.to.x) < 1e-9);
  assert.ok(Math.abs(parked.z - route.to.z) < 1e-9);
});

// 从实例矩阵读回位置和绕 Y 轴的朝向，断言不依赖模块内部对象
function readInstance(mesh, THREE) {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  return index => {
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(position, quaternion, scale);
    return { x: position.x, y: position.y, z: position.z, yaw: 2 * Math.atan2(quaternion.y, quaternion.w) };
  };
}

test('real drone module builds, flies when open and parks during APEC control', { skip: !process.env.SZ_THREE_PACKAGE_DIR }, async () => {
  const THREE = await import(pathToFileURL(join(process.env.SZ_THREE_PACKAGE_DIR, 'build/three.webgpu.js')));
  const realModule = loadModule(read('sz-drone-routes.js'), { imports: { 'three/webgpu': THREE, './sz-terrain.js': terrain } });
  const grid = { x0: -100, z0: -100, nx: 2, nz: 2, step: 200, heightScale: 0.1, heights: [100, 100, 100, 100] };
  const scene = new THREE.Scene();
  const openAir = realModule.buildSzDroneRoutes(scene, { air, terrain: grid, now: openNow });
  assert.equal(openAir.statistics.routes, 1);
  assert.equal(openAir.statistics.flights, 2);
  assert.equal(openAir.statistics.suspended, false);
  const instanced = name => {
    const mesh = openAir.group.children.find(child => child.name === name);
    assert.ok(mesh?.isInstancedMesh, `${name} is an InstancedMesh`);
    return mesh;
  };
  const hulls = instanced('drone-hulls');
  const rotors = instanced('drone-rotors');
  const redLamps = instanced('drone-lamps-red');
  const greenLamps = instanced('drone-lamps-green');
  instanced('drone-stations');
  // P10：每架 1 个机身实例、4 个旋翼实例、红/绿各 1 个灯实例，不再建独立网格
  assert.equal(hulls.count, 2);
  assert.equal(rotors.count, 8);
  assert.equal(redLamps.count, 2);
  assert.equal(greenLamps.count, 2);
  assert.equal(openAir.group.children.filter(child => child.isMesh && !child.isInstancedMesh).length, 0,
    'no per-drone meshes remain');
  assert.equal(openAir.group.children.filter(child => child.type === 'Group' && child.children.length > 5).length, 0);
  assert.equal(openAir.statistics.instancedMeshes, 5);
  assert.equal(openAir.statistics.meshes, 6, 'five instanced meshes plus one route line');
  assert.equal(openAir.statistics.instances, 16);
  assert.ok(openAir.statistics.meshes < 2 * 13 + 2 * 2, 'instancing cuts the draw objects');

  const [route] = openAir.routes;
  const [outbound] = route.flights;
  const readHull = readInstance(hulls, THREE);
  openAir.update(0);
  const first = readHull(0);
  const second = readHull(1);
  assert.ok(Math.hypot(first.x - route.from.x, first.z - route.from.z) < 1e-6,
    'first drone waits at the from end at time zero');
  assert.ok(Math.hypot(second.x - (route.from.x + route.to.x) / 2,
    second.z - (route.from.z + route.to.z) / 2) < 1e-6, 'second drone starts at its half-way phase');
  assert.ok(first.y > 100, 'the drone at the from end cruises above terrain');
  assert.ok(first.y >= route.altitudeM && second.y >= route.altitudeM, 'drones keep the schematic altitude');

  // 以真实实例矩阵连续更新 110 秒，跨过两个端点；位置逐帧采样，不允许出现瞬移。
  // 实例矩阵按 float32 存取，读回位置有舍入，给 1% 容差
  const stepLimit = outbound.speedMps * DT * 1.01;
  const rotorBefore = [...rotors.instanceMatrix.array.slice(0, 16)];
  const tracks = [[], []];
  for (let step = 0; step <= 2200; step++) {
    openAir.update(DT);
    tracks.forEach((track, index) => track.push(readHull(index)));
  }
  assert.notDeepEqual([...rotors.instanceMatrix.array.slice(0, 16)], rotorBefore, 'rotors keep spinning while flying');
  for (const [index, track] of tracks.entries()) {
    let maxStep = 0;
    let minToFrom = Infinity;
    let minToTo = Infinity;
    let turns = 0;
    for (let sample = 1; sample < track.length; sample++) {
      const previous = track[sample - 1];
      const current = track[sample];
      maxStep = Math.max(maxStep, Math.hypot(current.x - previous.x, current.z - previous.z));
      if (sample > 500) minToFrom = Math.min(minToFrom, Math.hypot(current.x - route.from.x, current.z - route.from.z));
      minToTo = Math.min(minToTo, Math.hypot(current.x - route.to.x, current.z - route.to.z));
      if (headingDelta(current.yaw, previous.yaw) > 0.5) turns++;
    }
    assert.ok(maxStep <= stepLimit, `drone ${index} single-frame step ${maxStep} stays within ${stepLimit}`);
    assert.ok(minToFrom < 0.5 && minToTo < 0.5, `drone ${index} reaches both endpoints`);
    assert.equal(turns, 2, `drone ${index} turns at two endpoints`);
    assert.ok(track.every(point => point.y >= route.altitudeM - 1e-6), `drone ${index} keeps the schematic cruise altitude`);
  }
  // 返程朝向：0 号机在第一次过端点后应背向 to 端
  const turnIndex = tracks[0].findIndex((point, index) => index > 0
    && headingDelta(point.yaw, tracks[0][index - 1].yaw) > 0.5);
  const dx = route.to.x - route.from.x;
  const dz = route.to.z - route.from.z;
  assert.ok(turnIndex > 0);
  assert.ok(headingDelta(tracks[0][turnIndex].yaw, Math.atan2(-dx, -dz)) < 0.2, 'the return leg faces back');

  // 停运日期：同一批实例收在起降点，旋翼停转
  const suspendedAir = realModule.buildSzDroneRoutes(scene, { air, terrain: grid, now: new Date('2026-11-12T00:00:00+08:00') });
  assert.equal(suspendedAir.statistics.suspended, true);
  const parkedHulls = suspendedAir.group.children.find(child => child.name === 'drone-hulls');
  const parkedRotors = suspendedAir.group.children.find(child => child.name === 'drone-rotors');
  const readParked = readInstance(parkedHulls, THREE);
  suspendedAir.update(0.016);
  const parked = [readParked(0), readParked(1)];
  assert.ok(parked.every(point => Math.abs(point.x - air.droneStations[0].x) < 1e-6
    && Math.abs(point.z - air.droneStations[0].z) < 1e-6), 'suspended drones wait at the takeoff station');
  assert.ok(parked.every(point => point.y < 20), 'suspended drones stay near the ground');
  const readRotor = readInstance(parkedRotors, THREE);
  for (let index = 0; index < parkedRotors.count; index++) {
    const rotor = readRotor(index);
    assert.ok(Math.hypot(rotor.x - air.droneStations[0].x, rotor.z - air.droneStations[0].z) < 0.8,
      'parked rotors stay with the drone');
  }
  const parkedBefore = [...parkedHulls.instanceMatrix.array];
  const parkedRotorsBefore = [...parkedRotors.instanceMatrix.array];
  suspendedAir.update(0.016);
  assert.deepEqual([...parkedHulls.instanceMatrix.array], parkedBefore, 'parked drones do not move');
  assert.deepEqual([...parkedRotors.instanceMatrix.array], parkedRotorsBefore, 'parked rotors do not spin');
  openAir.dispose();
  suspendedAir.dispose();
  assert.equal(openAir.group.parent, null);
});
