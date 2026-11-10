// 无人机航线（正式版硬性要求 3）：端点只用 data/source/air-routes.json 里带来源与核实日期的真实站点；
// 航迹、巡航高度和班次频率都是示意（estimate），不是实测航迹。APEC 低空管控期间按通告停运、无人机停在站点。
// 飞行按航线长度做连续往返：到端点翻转方向和朝向，不在端点瞬移回另一端。
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

/** 解析：判定当前日期是否落在 APEC 低空管控窗口内。
 *  输入：air 段（apecSuspension.windows 来自深圳市政府 2026-11-03 通告）与日期。
 *  输出：布尔值；只按日期比较，不区分区县（现有两条航线都在管控范围内）。
 *  说明：管制窗口是真实来源；停运后的行为（停在起降点）是展示约定。 */
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

/** 解析：把 air 段的公开站点/航线解析成可执行的飞行计划（纯函数，不建几何）。
 *  输入：air（4 站点/2 航线，每条带 sourceUrls+verifiedAt）。
 *  输出：{ routes, suspended, stations, windows }；缺失站点或非法的航线直接丢弃，不补造数据。
 *  来源纪律：端点来自公开来源；航迹、高度、班次都是示意（trackStatus='schematic'）。 */
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

/** 解析：给定航线、飞行计划和累计飞行时间，算出无人机在示意航迹上的位置与朝向。
 *  输入：route（from/to 平面坐标与 lengthM）、flight（phase/direction/speedMps/turnAtEnds）、elapsed 秒。
 *  输出：{ travel, direction, x, z, yaw }；travel 是 from→to 的路径比例。
 *  行为：turnAtEnds 为真时按 2 倍航线长度做三角波连续往返，端点处翻转方向；
 *       为假时单程走到端点后停在目标端。phase 是初始路径比例，direction 决定首段往哪端飞。
 *  说明：这是示意航迹上的运动学，不代表真实飞行轨迹已核实。 */
export function dronePoseAt(route, flight, elapsed) {
  if (!route || !flight) throw new Error('Drone pose requires route and flight');
  const direction = flight.direction < 0 ? -1 : 1;
  const along = (flight.speedMps * Math.max(0, Number.isFinite(elapsed) ? elapsed : 0)) / route.lengthM;
  const raw = flight.phase + direction * along;
  let travel;
  let moving;
  if (flight.turnAtEnds === false) {
    travel = Math.min(1, Math.max(0, raw));
    moving = direction;
  } else {
    // 模 2 后 0→1 是去程、1→2 是返程，端点处路径比例与方向同时连续翻转。
    const cycle = ((raw % 2) + 2) % 2;
    const outbound = cycle < 1;
    travel = outbound ? cycle : 2 - cycle;
    // cycle 在 (1,2) 段时路径比例随 raw 减小而增大，所以运动方向与首段相反。
    moving = outbound ? direction : -direction;
  }
  const dx = route.to.x - route.from.x;
  const dz = route.to.z - route.from.z;
  return {
    travel,
    direction: moving,
    x: route.from.x + dx * travel,
    z: route.from.z + dz * travel,
    yaw: Math.atan2(dx * moving, dz * moving)
  };
}

// 无人机部件按材质合并后再实例化：所有无人机共用 1 个机身网格、1 个旋翼网格、红/绿航行灯各 1 个，
// 站点平台和桩合并后同样实例化。改前每架 12 个网格、每站 2 个，现在只剩 5 个实例网格加航线。
const DRONE_HULL_COLORS = Object.freeze({ body: 0x2c3238, stripe: 0xc8102e, arm: 0x1d2126 });
// 四旋翼局部位置，单位米；顺序固定，实例索引由它决定。
const DRONE_ROTOR_OFFSETS = Object.freeze([[1, 1], [-1, 1], [1, -1], [-1, -1]]);
const DRONE_ROTOR_SPIN_RAD_PER_S = 40;

// 合并多个几何：只保留位置、法线和索引；每个部件都带 color 时写入顶点色。
// 位置、法线、索引直接拼接，不引入额外依赖；调用方负责释放合并前的临时几何。
function mergeParts(parts) {
  const entries = parts.map(part => ({ geometry: part.geometry ?? part, color: part.color }));
  const coloured = entries.every(entry => entry.color !== undefined);
  let vertexCount = 0;
  let indexCount = 0;
  for (const { geometry } of entries) {
    const position = geometry.getAttribute('position');
    vertexCount += position.count;
    indexCount += geometry.index ? geometry.index.count : position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colours = coloured ? new Float32Array(vertexCount * 3) : null;
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const colour = new THREE.Color();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const { geometry, color } of entries) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    positions.set(position.array, vertexOffset * 3);
    if (normal) normals.set(normal.array, vertexOffset * 3);
    if (colours) {
      colour.setHex(color);
      for (let vertex = 0; vertex < position.count; vertex++) {
        const base = (vertexOffset + vertex) * 3;
        colours[base] = colour.r;
        colours[base + 1] = colour.g;
        colours[base + 2] = colour.b;
      }
    }
    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = index.getX(i) + vertexOffset;
      indexOffset += index.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += position.count;
    }
    vertexOffset += position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colours) merged.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

// 机身（机身、红色条纹、四条机臂）合并为一个带顶点色的几何；旋翼和两种航行灯仍各自单独一个几何，
// 因为旋翼是半透明材质、航行灯是不受光材质，混进同一个材质会改变画面。
function buildDroneGeometries() {
  const body = new THREE.BoxGeometry(DRONE_BODY_SIZE_M.length, DRONE_BODY_SIZE_M.height, DRONE_BODY_SIZE_M.width);
  const stripe = new THREE.BoxGeometry(DRONE_BODY_SIZE_M.length + 0.03, 0.06, DRONE_BODY_SIZE_M.width + 0.03);
  stripe.translate(0, 0.05, 0);
  const armTemplate = new THREE.CylinderGeometry(0.035, 0.035, 0.62, 6).rotateZ(Math.PI / 2).rotateY(Math.PI / 4);
  const arms = DRONE_ROTOR_OFFSETS.map(([sx, sz]) => {
    const arm = armTemplate.clone().rotateY(Math.atan2(sx, sz));
    arm.translate(sx * 0.31, 0.02, sz * 0.31);
    return arm;
  });
  armTemplate.dispose();
  const hull = mergeParts([
    { geometry: body, color: DRONE_HULL_COLORS.body },
    { geometry: stripe, color: DRONE_HULL_COLORS.stripe },
    ...arms.map(geometry => ({ geometry, color: DRONE_HULL_COLORS.arm }))
  ]);
  for (const geometry of [body, stripe, ...arms]) geometry.dispose();
  const rotor = new THREE.CylinderGeometry(0.26, 0.26, 0.02, 12);
  const lampRed = new THREE.SphereGeometry(0.06, 6, 5).translate(-0.5, 0.02, 0);
  const lampGreen = new THREE.SphereGeometry(0.06, 6, 5).translate(0.5, 0.02, 0);
  return { hull, rotor, lampRed, lampGreen };
}

// 实例矩阵每帧改写，包围球会过期；数量很小，直接关掉视锥剔除。
function createInstancedMesh(name, geometry, material, count, dynamic) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** 解析：在场景里建无人机航线：实例化站点桩 + 100 m 示意航线 + 实例化四旋翼。
 *  输入：air 段、地形网格；可选 now 用于停运判定。
 *  行为：APEC 管控窗口内无人机收在起降点地面不飞；其余时间沿两端直线往返，端点翻转方向和朝向。
 *  输出：{ group, surfaces(空), statistics, routes, suspended, update, dispose }。 */
export function buildSzDroneRoutes(scene, { air = null, terrain = null, now = new Date() } = {}) {
  if (!scene || typeof scene.add !== 'function') throw new Error('Drone routes require a scene');
  const plan = planDroneFlights(air, { now });
  const group = new THREE.Group();
  group.name = 'shenzhen-drone-routes';
  scene.add(group);
  if (plan.routes.length === 0) {
    return { group, colliders: [], statistics: { routes: 0, stations: plan.stations.length, flights: 0,
      suspended: plan.suspended, altitudeSource: 'estimate', meshes: 0, instancedMeshes: 0 }, routes: [],
    suspended: plan.suspended, update() {}, dispose() { scene.remove(group); } };
  }
  const materials = {
    // 机身、条纹和机臂已合并并写入顶点色，共用一个标准材质；仍沿用各自的原色。
    hull: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 }),
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
  // 只绕 Y 轴转的实例矩阵；无人机没有俯仰或横滚。暂存对象在闭包内复用，避免每帧分配。
  const yAxis = new THREE.Vector3(0, 1, 0);
  const instancePosition = new THREE.Vector3();
  const instanceQuaternion = new THREE.Quaternion();
  const instanceScale = new THREE.Vector3(1, 1, 1);
  const instanceMatrix = new THREE.Matrix4();
  const writeInstance = (mesh, index, x, y, z, yaw) => {
    instancePosition.set(x, y, z);
    instanceQuaternion.setFromAxisAngle(yAxis, yaw);
    instanceMatrix.compose(instancePosition, instanceQuaternion, instanceScale);
    mesh.setMatrixAt(index, instanceMatrix);
  };

  // 站点桩：平台 + 小圆柱合并成一份几何，按站实例化；高度是估计。
  const stationPad = new THREE.CylinderGeometry(1.5, 1.5, 0.16, 12).translate(0, 0.08, 0);
  const stationPost = new THREE.CylinderGeometry(0.55, 0.7, 1.1, 10).translate(0, 0.63, 0);
  const stationGeometry = keep(mergeParts([stationPad, stationPost]));
  stationPad.dispose();
  stationPost.dispose();
  const stationMesh = createInstancedMesh('drone-stations', stationGeometry, materials.station,
    plan.stations.length, false);
  plan.stations.forEach((station, index) => {
    writeInstance(stationMesh, index, station.x, groundY(station.x, station.z), station.z, 0);
  });
  stationMesh.instanceMatrix.needsUpdate = true;
  group.add(stationMesh);

  // 示意航线：100 m 高度细线；明确是示意图，不是实测航迹。
  const flights = [];
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
    for (const flight of route.flights) flights.push({ route, flight, elapsed: 0 });
  }

  // 所有无人机共用的实例网格：机身 1 实例/架，旋翼 4 实例/架，红/绿灯各 1 实例/架。
  const droneGeometries = buildDroneGeometries();
  for (const geometry of Object.values(droneGeometries)) keep(geometry);
  const hullMesh = createInstancedMesh('drone-hulls', droneGeometries.hull, materials.hull, flights.length, true);
  const rotorMesh = createInstancedMesh('drone-rotors', droneGeometries.rotor, materials.rotor,
    flights.length * DRONE_ROTOR_OFFSETS.length, true);
  const lampRedMesh = createInstancedMesh('drone-lamps-red', droneGeometries.lampRed, materials.lampRed,
    flights.length, true);
  const lampGreenMesh = createInstancedMesh('drone-lamps-green', droneGeometries.lampGreen, materials.lampGreen,
    flights.length, true);
  hullMesh.castShadow = true;
  group.add(hullMesh, rotorMesh, lampRedMesh, lampGreenMesh);

  const statistics = {
    routes: plan.routes.length,
    stations: plan.stations.length,
    flights: flights.length,
    suspended: plan.suspended,
    altitudeM: plan.routes.map(route => route.altitudeM),
    altitudeSource: 'estimate',
    trackStatus: 'schematic',
    verifiedAt: plan.routes.map(route => route.verifiedAt),
    operatorNotice: plan.operatorNotice?.text ?? null,
    windows: plan.windows,
    // meshes 是可绘制对象数（实例网格加航线），不是实例数；instances 才是实例总数。
    meshes: 5 + plan.routes.length,
    instancedMeshes: 5,
    instances: flights.length * (1 + DRONE_ROTOR_OFFSETS.length + 2) + plan.stations.length,
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
      let hullIndex = 0;
      let rotorIndex = 0;
      let lampIndex = 0;
      for (const record of flights) {
        const { route, flight } = record;
        let x;
        let y;
        let z;
        let yaw;
        let spin;
        if (plan.suspended) {
          // 会期低空管控：无人机收在起降点地面，旋翼不转。
          x = route.from.x;
          z = route.from.z;
          y = groundY(x, z) + SUSPENDED_ALTITUDE_M;
          yaw = 0;
          spin = 0;
        } else {
          record.elapsed += step;
          // 连续往返：位置和朝向都由 dronePoseAt 给出，端点处翻转而不是瞬移。
          const pose = dronePoseAt(route, flight, record.elapsed);
          x = pose.x;
          z = pose.z;
          y = groundY(x, z) + route.altitudeM;
          yaw = pose.yaw;
          // 旋翼转速与巡航速度无关，只做视觉旋转。
          spin = record.elapsed * DRONE_ROTOR_SPIN_RAD_PER_S;
        }
        writeInstance(hullMesh, hullIndex, x, y, z, yaw);
        writeInstance(lampRedMesh, lampIndex, x, y, z, yaw);
        writeInstance(lampGreenMesh, lampIndex, x, y, z, yaw);
        // 旋翼局部偏移随朝向旋转；旋翼轴竖直，自转角与朝向叠加即可。
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        for (const [sx, sz] of DRONE_ROTOR_OFFSETS) {
          const offsetX = sx * 0.46;
          const offsetZ = sz * 0.46;
          writeInstance(rotorMesh, rotorIndex, x + offsetX * cos + offsetZ * sin, y + 0.08,
            z - offsetX * sin + offsetZ * cos, yaw + spin);
          rotorIndex++;
        }
        hullIndex++;
        lampIndex++;
      }
      hullMesh.instanceMatrix.needsUpdate = true;
      rotorMesh.instanceMatrix.needsUpdate = true;
      lampRedMesh.instanceMatrix.needsUpdate = true;
      lampGreenMesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      scene.remove(group);
      group.traverse(object => {
        if (object.isInstancedMesh) object.dispose();
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
      geometries.clear();
      flights.length = 0;
    }
  };
}
