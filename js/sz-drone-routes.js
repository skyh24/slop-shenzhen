// 无人机航线（正式版硬性要求 3）：端点只用 data/source/air-routes.json 里带来源与核实日期的真实站点；
// 航迹、巡航高度和班次频率都是示意（estimate），不是实测航迹。APEC 低空管控期间按通告停运、无人机停在站点。
import * as THREE from 'three/webgpu';
import { terrainHeight } from './sz-terrain.js';

// 由龙华公开“5 km 9 分钟”反推的均速量级；不是深圳人才公园航线实测速度。
export const DRONE_CRUISE_SPEED_MPS = 9.3;
export const DRONE_FLIGHTS_PER_ROUTE = 2;
export const DRONE_BODY_SIZE_M = Object.freeze({ length: 1.15, width: 1.15, height: 0.32 });
export const SUSPENDED_ALTITUDE_M = 0.6;

function validDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inWindow(day, window) {
  return Boolean(window?.from && window?.to && day >= window.from && day <= window.to);
}

/** APEC 低空管控是否覆盖当前日期；窗口来自深圳市政府 2026-11-03 通告（air-routes.json 记录）。 */
export function isApecAirSuspended(air, now = new Date()) {
  const day = dateOnly(validDate(now));
  return (air?.apecSuspension?.windows ?? []).some(window => inWindow(day, window));
}

function routeFlights(route, index) {
  const count = DRONE_FLIGHTS_PER_ROUTE;
  return Array.from({ length: count }, (_, flightIndex) => ({
    id: `${route.id}:drone-${flightIndex + 1}`,
    routeId: route.id,
    // 同一航线两架错开半程，往返飞行；phase 决定初始时刻在路径上的位置。
    phase: (flightIndex / count + index * 0.17) % 1,
    direction: flightIndex % 2 === 0 ? 1 : -1,
    speedMps: DRONE_CRUISE_SPEED_MPS,
    turnAtEnds: true
  }));
}

/** 纯计划：站点、航线、飞行器与停运状态；不建几何，测试和统计都用它。 */
export function planDroneFlights(air, { now = new Date() } = {}) {
  const stations = new Map((air?.droneStations ?? []).map(station => [station.id, station]));
  const suspended = isApecAirSuspended(air, now);
  const routes = [];
  for (const [index, route] of (air?.droneRoutes ?? []).entries()) {
    const from = stations.get(route.fromStationId);
    const to = stations.get(route.toStationId);
    if (!from || !to) continue;
    const lengthM = Number.isFinite(route.lengthM) && route.lengthM > 0
      ? route.lengthM : Math.hypot(to.x - from.x, to.z - from.z);
    routes.push({
      ...route, from, to, lengthM, suspended,
      altitudeM: Number.isFinite(route.altitudeM) ? route.altitudeM : 100,
      altitudeSource: route.altitudeSource ?? 'estimate',
      flights: routeFlights(route, index)
    });
  }
  return { routes, suspended, stations: [...stations.values()],
    windows: air?.apecSuspension?.windows ?? [], operatorNotice: air?.apecSuspension?.operatorNotice ?? null };
}

function dronePart(geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

function buildDroneModel(materials) {
  const group = new THREE.Group();
  const body = dronePart(new THREE.BoxGeometry(DRONE_BODY_SIZE_M.length, DRONE_BODY_SIZE_M.height,
    DRONE_BODY_SIZE_M.width), materials.body, 0, 0, 0);
  body.castShadow = true;
  const stripe = dronePart(new THREE.BoxGeometry(DRONE_BODY_SIZE_M.length + 0.03, 0.06,
    DRONE_BODY_SIZE_M.width + 0.03), materials.stripe, 0, 0.05, 0);
  group.add(body, stripe);
  const armGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.62, 6).rotateZ(Math.PI / 2).rotateY(Math.PI / 4);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = dronePart(armGeometry, materials.arm, sx * 0.31, 0.02, sz * 0.31);
    arm.rotation.y = Math.atan2(sx, sz);
    const rotor = dronePart(new THREE.CylinderGeometry(0.26, 0.26, 0.02, 12), materials.rotor,
      sx * 0.46, 0.08, sz * 0.46);
    group.add(arm, rotor);
  }
  const lampRed = dronePart(new THREE.SphereGeometry(0.06, 6, 5), materials.lampRed, -0.5, 0.02, 0);
  const lampGreen = dronePart(new THREE.SphereGeometry(0.06, 6, 5), materials.lampGreen, 0.5, 0.02, 0);
  group.add(lampRed, lampGreen);
  return { group, bodies: [body, stripe, ...group.children.filter(child => child.isMesh && child !== body && child !== stripe)] };
}

/** 建场景：站点桩、示意航线、按计划飞行的无人机；停运时全部停在站点。 */
export function buildSzDroneRoutes(scene, { air = null, terrain = null, now = new Date() } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Drone routes require a scene');
  const plan = planDroneFlights(air, { now });
  const group = new THREE.Group();
  group.name = 'shenzhen-drone-routes';
  scene.add(group);
  if (plan.routes.length === 0) {
    return { group, colliders: [], statistics: { routes: 0, stations: plan.stations.length, flights: 0,
      suspended: plan.suspended, altitudeSource: 'estimate' }, routes: [], suspended: plan.suspended,
    update() {}, dispose() { scene.remove(group); } };
  }
  const materials = {
    body: new THREE.MeshStandardNodeMaterial({ color: 0x2c3238, roughness: 0.5, metalness: 0.35 }),
    stripe: new THREE.MeshStandardNodeMaterial({ color: 0xc8102e, roughness: 0.5 }),
    arm: new THREE.MeshStandardNodeMaterial({ color: 0x1d2126, roughness: 0.6, metalness: 0.4 }),
    rotor: new THREE.MeshStandardNodeMaterial({ color: 0x5b656e, roughness: 0.4, metalness: 0.3,
      transparent: true, opacity: 0.55, depthWrite: false }),
    lampRed: new THREE.MeshBasicNodeMaterial({ color: 0xff3b30 }),
    lampGreen: new THREE.MeshBasicNodeMaterial({ color: 0x34c759 }),
    routeLine: new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.22, depthWrite: false }),
    station: new THREE.MeshStandardNodeMaterial({ color: 0x3b4247, roughness: 0.7 })
  };
  const geometries = new Set();
  const keep = geometry => { geometries.add(geometry); return geometry; };

  const groundY = (x, z) => {
    const height = terrain ? terrainHeight(terrain, x, z) : null;
    return Number.isFinite(height) ? height : 0;
  };
  // 站点桩：小圆柱 + 平台，标出“公开来源端点”的位置；高度是估计。
  const stationGeometry = keep(new THREE.CylinderGeometry(0.55, 0.7, 1.1, 10));
  const stationPadGeometry = keep(new THREE.CylinderGeometry(1.5, 1.5, 0.16, 12));
  const stationGroup = new THREE.Group();
  const stationRecords = [];
  for (const station of plan.stations) {
    const y = groundY(station.x, station.z);
    const pad = dronePart(stationPadGeometry, materials.station, 0, 0.08, 0);
    const post = dronePart(stationGeometry, materials.station, 0, 0.63, 0);
    const holder = new THREE.Group();
    holder.position.set(station.x, y, station.z);
    holder.add(pad, post);
    stationGroup.add(holder);
    stationRecords.push({ station, holder, y });
  }
  group.add(stationGroup);

  // 示意航线：100 m 高度细线；明确是示意图，不是实测航迹。
  const droneRecords = [];
  for (const route of plan.routes) {
    const linePoints = [];
    const startY = groundY(route.from.x, route.from.z) + route.altitudeM;
    const endY = groundY(route.to.x, route.to.z) + route.altitudeM;
    for (let index = 0; index <= 24; index++) {
      const t = index / 24;
      linePoints.push(new THREE.Vector3(route.from.x + (route.to.x - route.from.x) * t,
        startY + (endY - startY) * t, route.from.z + (route.to.z - route.from.z) * t));
    }
    const lineGeometry = keep(new THREE.BufferGeometry().setFromPoints(linePoints));
    group.add(new THREE.Line(lineGeometry, materials.routeLine));
    for (const flight of route.flights) {
      const model = buildDroneModel(materials);
      geometries.add(model.group.children[0].geometry);
      for (const child of model.group.children) geometries.add(child.geometry);
      group.add(model.group);
      droneRecords.push({ route, flight, ...model, elapsed: 0 });
    }
  }

  const statistics = {
    routes: plan.routes.length,
    stations: plan.stations.length,
    flights: droneRecords.length,
    suspended: plan.suspended,
    altitudeM: plan.routes.map(route => route.altitudeM),
    altitudeSource: 'estimate',
    trackStatus: 'schematic',
    verifiedAt: plan.routes.map(route => route.verifiedAt),
    operatorNotice: plan.operatorNotice?.text ?? null,
    windows: plan.windows,
    meshes: droneRecords.length * 13 + stationRecords.length * 2,
    limitations: [
      '端点和停运窗口有公开来源；航迹是两端直线示意，不是实测航迹',
      '巡航高度 100 m 是画面估计，无公开来源',
      '站点桩位置按公开描述的近似坐标放置，精确柜位未公开'
    ]
  };

  return {
    group,
    colliders: [],
    statistics,
    routes: plan.routes,
    suspended: plan.suspended,
    update(dt) {
      const step = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.05);
      for (const record of droneRecords) {
        const { route, flight } = record;
        if (plan.suspended) {
          // 会期低空管控：无人机收在起降点地面，旋翼不转。
          record.group.position.set(route.from.x, groundY(route.from.x, route.from.z) + SUSPENDED_ALTITUDE_M, route.from.z);
          record.group.rotation.y = 0;
          continue;
        }
        record.elapsed += step;
        const distance = flight.speedMps * record.elapsed;
        const travel = Math.min(1, (distance / route.lengthM) % 1);
        const t = flight.direction > 0 ? travel : 1 - travel;
        const x = route.from.x + (route.to.x - route.from.x) * t;
        const z = route.from.z + (route.to.z - route.from.z) * t;
        const y = groundY(x, z) + route.altitudeM;
        record.group.position.set(x, y, z);
        const dx = (route.to.x - route.from.x) * flight.direction;
        const dz = (route.to.z - route.from.z) * flight.direction;
        record.group.rotation.y = Math.atan2(dx, dz);
        // 旋翼转速与巡航速度无关，只做视觉旋转。
        for (const child of record.group.children) {
          if (child.geometry?.type === 'CylinderGeometry' && child.position.y > 0.05) child.rotation.y = record.elapsed * 40;
        }
      }
    },
    dispose() {
      scene.remove(group);
      for (const geometry of geometries) geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
      geometries.clear();
      droneRecords.length = 0;
      stationRecords.length = 0;
    }
  };
}
