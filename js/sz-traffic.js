import * as THREE from 'three/webgpu';
import { routeSignalStops } from './sz-intersection-control.js';
import { createJunctionParticipant } from './sz-junction-participant.js';
import { isGroundRoad, roadTravelPoints } from './sz-roads.js';
import { getDeckSection, getRoadSection, laneOffsets, usableWidth } from './sz-road-section.js';
import {
  carStyleCode, createTrafficCarBody, createTrafficVehicleGeometry, createTrafficWheels, VEHICLE_SPECS
} from './sz-vehicles.js';
import { polygonBoxOverlaps, roofPanelContactPolygon, spanContactPolygon,
  SURFACE_CONTACT_EPSILON_M } from './building-collision.js';
import { vehicleContact } from './vehicle-physics.js';
import { contactTime, followingReach, routeLeader, sameTrafficLevel,
  writeEntityCollider, writeTrafficCollider } from './sz-driving-motion.js';
import { isTrunkRamp, laneRoute, poseOnRoute, routeModelBounds } from './sz-road-trajectory.js';

export { writeTrafficCollider };

const SPAWN_CELL = 100;
const SEARCH_RADIUS = 360;
const DESPAWN_RADIUS = 430;
const NEAR_ROUTE_END_RADIUS = 160;
const BODY_CELL = 32;
const SIGNAL_EXIT_BUFFER = 12;
const ROUTE_RANGE = 560;
const REVIEWED_MAINLINE_RANGE = 1500;
// 路线不再有终点：剩余不足该距离时从当前位姿续接，车辆在视野内不会因路线用完而停住。
const EXTEND_AHEAD = 140;
const TERMINAL_RETRY_NEAR_M = 16;
const TERMINAL_RETRY_INTERVAL_S = 0.75;
// 换道用五次曲线整段完成；一次换道约 2 秒，跨段时收回到本车道。
const LANE_CHANGE_SECONDS = 2;
const LANE_CHANGE_MIN_EDGE = 45;
const TURN = Math.PI * 2;
const WHEEL_SPIN_STEP = 0.6;
// 玩家车逼近时环境车的反应：先观察 0.3 s，再按撞击点在车头还是车尾决定急刹或加速逃开。
const PLAYER_NOTICE_S = 1.1;
const PLAYER_REACTION_S = 0.3;
const PLAYER_HOLD_S = 0.9;
// 高架链路进入车流后多给一段续行预算，让“地面→匝道→桥面→地面”能在一段路线内走完。
const ELEVATED_ROUTE_RANGE = 1200;
const ELEVATED_ROUTE_SEGMENTS = 260;
// 同一节点两条桥面链路的估计桥面高差超过该值时视为未核实连接，不强行拼接。
// 与 sz-elevated-roads.js 的桥面接缝高差阈值保持一致（surface 层带交接容差）。
const ELEVATED_HEIGHT_TOLERANCE = 0.35;
// 深圳车队约 30 辆：出租车 6、轿车 9、SUV 8、MPV 3、物流面包 2、公交 2（docs/07 的车型配比按 30 辆折算）。
const FLEET = [
  { type: 'taxi', count: 6, speed: 10 },
  { type: 'sedan', count: 9, speed: 11 },
  { type: 'suv', count: 8, speed: 10 },
  { type: 'minivan', count: 3, speed: 10 },
  { type: 'van', count: 2, speed: 9 },
  { type: 'bus', count: 2, speed: 8 }
];
// 涂装按车型轮换；出租车固定天蓝 + livery 1（空车）/ 5（载客），其余为白/银/灰/黑为主的私家车色。
const FLEET_PAINTS = {
  taxi: [
    { color: 0x1f8fe0, style: carStyleCode({ livery: 1, metallic: 0, trim: 0, wheel: 1 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 5, metallic: 0, trim: 0, wheel: 0 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 1, metallic: 0, trim: 1, wheel: 2 }) },
    { color: 0x1f8fe0, style: carStyleCode({ livery: 5, metallic: 0, trim: 1, wheel: 1 }) }
  ],
  sedan: [
    { color: 0xf2f4f7, style: carStyleCode({ livery: 0, metallic: 0, trim: 1, wheel: 0 }) },
    { color: 0xc8d0d8, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x525a63, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x1c2026, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0x1d3b6c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x8a1c22, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) },
    { color: 0xe8ebee, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }
  ],
  suv: [
    { color: 0xeef1f3, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
    { color: 0x9aa2ac, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x3a434d, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x15181c, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0x27405c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
    { color: 0x2c3a30, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) },
    { color: 0xb9c0c7, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) }
  ],
  minivan: [
    { color: 0xf0f2f5, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
    { color: 0x4a5058, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 2 }) },
    { color: 0x1a1d22, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
    { color: 0xaab2bb, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }
  ],
  van: [
    { color: 0xf4f5f6, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) },
    { color: 0xeef0f2, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 1 }) },
    { color: 0xb9c0c7, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 0 }) },
    { color: 0x8e959c, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 2 }) }
  ]
};
const squareDistance = (x, z, point) => (x - point.x) ** 2 + (z - point.z) ** 2;
const interpolate = (a, b, t) => a + (b - a) * t;
const cellKey = (x, z) => `${x},${z}`;

function seededRandom(id) {
  let state = Math.imul(id + 1, 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function createTrafficGraph(graph, { canTurn = () => true, elevated = null } = {}) {
  const edges = [];
  const outgoing = new Map();
  const cells = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const metadata = graph.metadata[i];
    if (!isGroundRoad(metadata)) continue;
    const link = graph.links[i];
    const [a, b, name] = link;
    const section = getRoadSection(graph, i);
    const points = roadTravelPoints(graph, link, metadata, section.travelWidthM);
    if (points.length < 2) continue;
    for (const sign of section.twoWay ? [1, -1] : [section.direction]) {
      const from = sign === 1 ? a : b;
      const to = sign === 1 ? b : a;
      const path = sign === 1 ? points : [...points].reverse();
      const edge = { from, to, sign, section, name: graph.names[name],
        osmId: metadata.osmId, highway: metadata.highway, sourceIndex: i, segments: [], next: [] };
      for (let j = 1; j < path.length; j++) {
        const start = path[j - 1];
        const end = path[j];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        const dx = (end.x - start.x) / length;
        const dz = (end.z - start.z) / length;
        edge.segments.push({ x: start.x, z: start.z, dx, dz, length });
        if (length < 6) continue;
        const markers = Math.ceil(length / 36);
        for (let k = 0; k < markers; k++) {
          const distance = (k + 0.5) / markers * length;
          const x = start.x + dx * distance;
          const z = start.z + dz * distance;
          const key = cellKey(Math.floor(x / SPAWN_CELL), Math.floor(z / SPAWN_CELL));
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push({ edge, segment: j - 1, distance, x, z });
        }
      }
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      edges.push(edge);
    }
  }
  // 高架链路带表面身份进入同一张车流图：桥面高度来自渲染桥面计划，未知高程链路根本不在这里。
  for (const record of elevated?.links ?? []) {
    if (!Array.isArray(record.points) || record.points.length < 2) continue;
    if (record.osmId === undefined || record.surfaceId === undefined) continue;
    const section = getDeckSection(graph, record);
    for (const sign of section.twoWay ? [1, -1] : [section.direction]) {
      const path = sign === 1 ? record.points : [...record.points].reverse();
      const from = sign === 1 ? record.startNode : record.endNode;
      const to = sign === 1 ? record.endNode : record.startNode;
      const edge = { from, to, sign, section, groundFork: record.groundFork,
        name: record.name ?? '', osmId: record.osmId, highway: null, sourceIndex: record.index,
        structureNeighbors: record.structureNeighbors, tunnel: record.tunnel === true, rampSpeed: record.ramp ? 6.5 : undefined,
        segments: [], next: [], surfaceId: section.surfaceId, elevated: true,
        startDeckY: sign === 1 ? record.startDeckY : record.endDeckY,
        endDeckY: sign === 1 ? record.endDeckY : record.startDeckY,
        sharedStart: sign === 1 ? record.sharedStart : record.sharedEnd,
        sharedEnd: sign === 1 ? record.sharedEnd : record.sharedStart };
      for (let j = 1; j < path.length; j++) {
        const start = path[j - 1];
        const end = path[j];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        if (length < 1e-8) continue;
        const dx = (end.x - start.x) / length;
        const dz = (end.z - start.z) / length;
        edge.segments.push({ x: start.x, z: start.z, dx, dz, length });
        if (length < 6) continue;
        const markers = Math.ceil(length / 36);
        for (let k = 0; k < markers; k++) {
          const distance = (k + 0.5) / markers * length;
          const x = start.x + dx * distance;
          const z = start.z + dz * distance;
          const key = cellKey(Math.floor(x / SPAWN_CELL), Math.floor(z / SPAWN_CELL));
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push({ edge, segment: j - 1, distance, x, z });
        }
      }
      if (edge.segments.length === 0) continue;
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      edges.push(edge);
    }
  }
  // 只按源节点身份连边，不把平面交叉、反向掉头和未解析桥隧拼进路线。
  for (const edge of edges) {
    const last = edge.segments.at(-1);
    edge.next = (outgoing.get(edge.to) ?? []).filter(next => {
      const first = next.segments[0];
      if (next.sourceIndex === edge.sourceIndex || next.to === edge.from
        || last.dx * first.dx + last.dz * first.dz <= -0.45 || !canTurn(edge, next)) return false;
      // 高程衔接：地面↔桥面只走链路的落地端；两条桥面链路则要求共享节点估计桥面高差在容差内。
      if (edge.structureNeighbors && !edge.structureNeighbors.includes(next.surfaceId ?? 'terrain')) return false;
      if (next.structureNeighbors && !next.structureNeighbors.includes(edge.surfaceId ?? 'terrain')) return false;
      if (next.elevated || edge.elevated) {
        if (next.elevated && edge.elevated) {
          return Math.abs(edge.endDeckY - next.startDeckY) <= ELEVATED_HEIGHT_TOLERANCE;
        }
        return next.elevated ? next.sharedStart === true : edge.sharedEnd === true;
      }
      return true;
    });
  }
  function nearSegments(x, z, radius) {
    const segments = new Map();
    for (let ix = Math.floor((x - radius) / SPAWN_CELL); ix <= Math.floor((x + radius) / SPAWN_CELL); ix++) {
      for (let iz = Math.floor((z - radius) / SPAWN_CELL); iz <= Math.floor((z + radius) / SPAWN_CELL); iz++) {
        for (const { edge, segment } of cells.get(cellKey(ix, iz)) ?? []) {
          segments.set(edge.segments[segment], { edge, segment });
        }
      }
    }
    return [...segments.values()];
  }
  return { edges, cells, nearSegments };
}

export function routeSegments(marker, model, random, detailedRoads, laneChoice, preferred = null) {
  const segments = [];
  const used = new Set();
  let edge = marker.edge;
  let index = marker.segment;
  let start = Math.max(0, marker.distance - 16);
  let remaining = ROUTE_RANGE;
  let reviewed = false;
  let elevatedSeen = false;
  // 跨路段时沿用离上一条车道最近的车道，避免在路口为了“同一比例车道”横甩 3 米。
  let followOffset = preferred;
  let forcedLane = false;
  while (edge && remaining > 0
    && segments.length < (elevatedSeen ? ELEVATED_ROUTE_SEGMENTS : reviewed ? 160 : 80)) {
    if (edge.section.reviewed && !reviewed) {
      // 复核快速路多保留一段续行预算，避免按通用街区预算截停在主线上。
      remaining += REVIEWED_MAINLINE_RANGE - ROUTE_RANGE;
      reviewed = true;
    }
    if (edge.elevated && !elevatedSeen) {
      // 高架段同样是已复核链路：给整条“上桥—桥面—下桥”留足续行预算，车流不会停在桥面上。
      remaining += ELEVATED_ROUTE_RANGE;
      elevatedSeen = true;
    }
    used.add(edge.sourceIndex);
    // 高架链路没有地面分幅横断面，统一走桥面中心线（方向 0 时取桥面半宽的居中车道）。
    // 车道可信（已核实断面或 OSM 明确标注）才按车道取偏移；纯宽度估计沿用保守单偏移。
    const useLanes = !edge.elevated && (laneOffsets(edge.section) !== null || detailedRoads.has(edge.osmId));
    const offsets = useLanes ? edge.section.routeOffsetsM : edge.section.defaultOffsetsM;
    const halfWidth = edge.section.travelWidthM / 2;
    const lanes = offsets.filter(offset => Math.abs(offset) + model.hx + 0.08 <= halfWidth);
    let offset = lanes[Math.min(lanes.length - 1, Math.floor(laneChoice * lanes.length))] ?? 0;
    if (followOffset !== null && !forcedLane && lanes.length) {
      offset = lanes.reduce((best, lane) => Math.abs(lane - followOffset) < Math.abs(best - followOffset) ? lane : best, lanes[0]);
    }
    forcedLane = false;
    followOffset = offset;
    for (; index < edge.segments.length && (remaining > 0 || edge.tunnel); index++) {
      const segment = edge.segments[index];
      const length = edge.tunnel ? segment.length - start : Math.min(segment.length - start, remaining);
      if (length > 0) segments.push({ ...segment, length, laneOffset: offset,
        x: segment.x + segment.dx * start - segment.dz * offset,
        z: segment.z + segment.dz * start + segment.dx * offset, edge });
      remaining -= length;
      start = 0;
    }
    // 已复核分幅的右侧匝道只与最外车道衔接，避免在分岔鼻端横穿内侧车道。
    const outerLane = offset === offsets.at(-1);
    const choices = edge.next.filter(next => !used.has(next.sourceIndex) && usableWidth(next, model.hx)
      && (!edge.section.reviewed || outerLane || !isTrunkRamp(next)));
    const next = choices[Math.floor(random() * choices.length)];
    if (isTrunkRamp(edge) && next?.section.reviewed) { laneChoice = 1; forcedLane = true; }
    if (edge.tunnel && next) remaining = Math.max(remaining, next.tunnel ? 1 : 55);
    edge = next;
    index = 0;
  }
  return segments;
}

function intersects(a, b) {
  // 与控制器共用 1 mm 表面容差：NPC 车底与桥面顶面齐平时不算侧撞。
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
    && a.minY < b.maxY - SURFACE_CONTACT_EPSILON_M
    && a.maxY > b.minY + SURFACE_CONTACT_EPSILON_M;
}

function touchesObstacle(body, candidate) {
  if (!intersects(body, candidate)) return false;
  if ((candidate.type === 'bridge-slab' || candidate.type === 'elevated-slab')
    && body.supportedSlabs?.has(candidate.name)) return false;
  // 与玩家一致：坡上车体低端可能略低于前方梁底，保留底下较低车辆的墩身碰撞。
  if (candidate.type === 'elevated-pier' && candidate.topClearance
    && body.minY >= candidate.maxY - candidate.topClearance) return false;
  if (candidate.type === 'bridge-slab'
    && ((body.supportedSlabs?.size && body.minY >= candidate.maxY - 0.02)
      || (candidate.roadAccess && body.minY >= candidate.maxY - 0.28))) return false;
  if (!candidate.polygon) return true;
  let polygon = candidate.polygon;
  if (candidate.roofPanel) polygon = roofPanelContactPolygon(candidate.roofPanel, body.minY, body.maxY);
  else if (candidate.verticalSpan) polygon = spanContactPolygon(polygon, candidate.verticalSpan, body.minY, body.maxY);
  return polygon && polygonBoxOverlaps(polygon, body.x, body.z,
    body.halfW, body.halfL, body.cos, body.sin);
}

function makeObstacleIndex(colliders) {
  const cells = new Map();
  for (const collider of colliders) {
    for (let x = Math.floor(collider.minX / BODY_CELL); x <= Math.floor(collider.maxX / BODY_CELL); x++) {
      for (let z = Math.floor(collider.minZ / BODY_CELL); z <= Math.floor(collider.maxZ / BODY_CELL); z++) {
        const key = cellKey(x, z);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(collider);
      }
    }
  }
  return body => {
    for (let x = Math.floor(body.minX / BODY_CELL); x <= Math.floor(body.maxX / BODY_CELL); x++) {
      for (let z = Math.floor(body.minZ / BODY_CELL); z <= Math.floor(body.maxZ / BODY_CELL); z++) {
        for (const candidate of cells.get(cellKey(x, z)) ?? []) {
          if (touchesObstacle(body, candidate)) return candidate;
        }
      }
    }
    return null;
  };
}

// 玩家车与本车按当前速度是否即将接触；time 为首次接触秒数，ahead 为撞击点在本车纵轴上的位置（车头为正）。
// 环境车据此决定让行方式：撞击点在车尾就加速让开，在车头就急刹。
export function playerImpact(car, player, seconds = PLAYER_NOTICE_S) {
  if (!player || !sameTrafficLevel(player, car)) return null;
  const time = contactTime(player, car, seconds);
  if (!Number.isFinite(time)) return null;
  const along = (player.x - car.x) * car.sin + (player.z - car.z) * car.cos;
  const closing = (player.vx - car.vx) * car.sin + (player.vz - car.vz) * car.cos;
  return { time, ahead: along + closing * time };
}

export function createSzTraffic(scene, graph, { roadHeight, elevated = null, colliders = [], nearRegional, signals = null, detailedRoadIds = [], canTurn } = {}) {
  if (typeof roadHeight !== 'function') throw new Error('Traffic requires rendered road height');
  const network = createTrafficGraph(graph, { canTurn, elevated });
  // 轮胎跨接缝时由调用方依次试相邻路段。单条高架边查不到三角面时保留空值，
  // 避免用同一 XZ 的桥下沥青截断相邻桥面的查询。
  const heightAtDeck = typeof elevated?.heightAt === 'function' ? elevated.heightAt : null;
  const heightFor = (x, z, edge) => {
    if (!edge?.surfaceId) return roadHeight(x, z);
    const height = heightAtDeck?.(x, z, edge.surfaceId);
    return Number.isFinite(height) ? height : null;
  };
  const detailedRoads = new Set(detailedRoadIds);
  const staticObstacle = makeObstacleIndex(colliders);
  const blockedByBuilding = body => staticObstacle(body) || nearRegional?.(body.x, body.z, Math.max(body.halfW, body.halfL) * 1.42)
    .find(candidate => touchesObstacle(body, candidate));
  const group = new THREE.Group();
  group.name = 'shenzhen-ground-traffic';
  const busMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.53 });
  const vehicles = [];
  const batches = FLEET.map(entry => {
    const car = entry.type === 'bus' ? null : createTrafficCarBody(entry.type);
    const geometry = car ? car.geometry : createTrafficVehicleGeometry({ type: entry.type });
    if (car) {
      // 每实例涂装与灯光状态（paintColor / carState）由 createLoftedCarMaterial 读取。
      geometry.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(entry.count * 3), 3));
      geometry.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(entry.count * 4), 4));
    }
    geometry.computeBoundingBox();
    // 轿车几何不含车轮，包围盒落到地面后碰撞盒才和可见轮胎一致。
    if (car) geometry.boundingBox.min.y = 0;
    const model = routeModelBounds(geometry.boundingBox, VEHICLE_SPECS[entry.type]);
    const mesh = new THREE.InstancedMesh(geometry, car ? car.material : busMaterial, entry.count);
    mesh.name = `traffic:${entry.type}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
    const paints = car ? FLEET_PAINTS[entry.type] : null;
    const actors = Array.from({ length: entry.count }, () => {
      const id = vehicles.length;
      const random = seededRandom(id);
      const palette = paints ? paints[id % paints.length] : null;
      const actor = { id, type: entry.type, model, random, desiredSpeed: entry.speed * (0.88 + 0.22 * random()),
        route: null, pose: {}, collider: { type: 'vehicle', id: `traffic:${id}` }, speed: 0, stalled: 0,
        paint: palette ? new THREE.Color(palette.color) : null, style: palette ? palette.style : 0,
        wheelSpin: 0, steer: 0, blinkPhase: (id * 0.37) % 0.8, prevX: 0, prevZ: 0, prevHeading: 0 };
      actor.junction = createJunctionParticipant(signals, id);
      // reservation 继续作为车辆对外状态发布：换道判断和 QA 读同一份占用，不另存副本。
      Object.defineProperty(actor, 'reservation', { get: () => actor.junction.reservation, enumerable: true });
      vehicles.push(actor);
      return actor;
    });
    return { mesh, actors, wheels: Boolean(car) };
  });
  // 环境车轮子单独实例化：左右各一份 InstancedMesh，前轴随路线弯道转向、四轮按车速滚动。
  const wheelCapacity = batches.reduce((sum, batch) => sum + (batch.wheels ? batch.actors.length : 0), 0);
  const wheelSetup = createTrafficWheels();
  const wheelStyles = new THREE.InstancedBufferAttribute(new Float32Array(wheelCapacity * 2), 1);
  wheelSetup.left.setAttribute('wheelStyle', wheelStyles);
  wheelSetup.right.setAttribute('wheelStyle', wheelStyles);
  const wheelLeft = new THREE.InstancedMesh(wheelSetup.left, wheelSetup.material, wheelCapacity * 2);
  const wheelRight = new THREE.InstancedMesh(wheelSetup.right, wheelSetup.material, wheelCapacity * 2);
  for (const [mesh, name] of [[wheelLeft, 'traffic:wheels-left'], [wheelRight, 'traffic:wheels-right']]) {
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
  }
  scene.add(group);

  const scratch = {};
  const probe = {};
  const contact = {};
  const transform = new THREE.Object3D();
  const wheelTransform = new THREE.Object3D();
  const statistics = { directedEdges: network.edges.length, active: 0, spawned: 0, signalEntries: 0, signalWaits: 0,
    signalExitRejects: 0, nearEndRejects: 0, mainlineEndRejects: 0, offscreenRecycled: 0,
    stalledRecycled: 0, routeExtensions: 0, laneChanges: 0, laneChangeAborts: 0, laneChangeIneligible: 0,
    spawnThrottled: 0,
    stoppedOver8s: 0, maxQueue: 0 };
  let refill = 0;
  let spawnKey = null;
  let candidates = [];
  let approachCandidates = [];
  let players = [];
  let walkers = [];
  const frameBodies = [];
  let clock = 0;
  let simulationTime = 0;

  // 每实例涂装与灯光：出租车 livery 1 空车 / 5 载客；刹车点亮尾灯，转向时闪烁同侧转向灯（carState.x/y/z）。
  function writeCarState(batch, actor, slot) {
    const { paintColor, carState } = batch.mesh.geometry.attributes;
    const paint = paintColor.array;
    const o3 = slot * 3;
    paint[o3] = actor.paint.r;
    paint[o3 + 1] = actor.paint.g;
    paint[o3 + 2] = actor.paint.b;
    const state = carState.array;
    const o4 = slot * 4;
    const turning = Math.abs(actor.steer) > 0.06 ? Math.sign(actor.steer) : 0;
    const blinkOn = turning !== 0 && (clock + actor.blinkPhase) % 0.8 <= 0.4;
    state[o4] = actor.blocker || actor.speed < 0.4 ? 1 : 0;
    state[o4 + 1] = blinkOn && turning > 0 ? 1 : 0;
    state[o4 + 2] = blinkOn && turning < 0 ? 1 : 0;
    state[o4 + 3] = actor.style;
  }

  // 轮子按实际位移滚动（角速度 = 位移 / 轮胎半径），前轴转向角由航向变化率换算。
  // 车身实例用 Euler(pitch, heading, roll, 'YXZ') 贴合路面，车轮位置按同一旋转摆到车身坐标系里，
  // 上坡和下坡时轮胎仍落在路面平面上（否则前后轮会与轮拱错开）。
  function placeCarWheels(actor, wheelIndex, dt) {
    const { pose } = actor;
    const spec = VEHICLE_SPECS[actor.type];
    const sinY = Math.sin(pose.heading);
    const cosY = Math.cos(pose.heading);
    const forward = (pose.x - actor.prevX) * sinY + (pose.z - actor.prevZ) * cosY;
    const rawStep = forward / spec.radius;
    actor.wheelSpin = (actor.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), WHEEL_SPIN_STEP)) % TURN;
    const turn = Math.atan2(Math.sin(pose.heading - actor.prevHeading), Math.cos(pose.heading - actor.prevHeading));
    actor.steer += (Math.max(-0.5, Math.min(0.5, turn * 2.4)) - actor.steer) * Math.min(1, dt * 8);
    actor.prevX = pose.x;
    actor.prevZ = pose.z;
    actor.prevHeading = pose.heading;
    const styles = wheelStyles.array;
    styles[wheelIndex * 2] = actor.style;
    styles[wheelIndex * 2 + 1] = actor.style;
    const scale = spec.radius / wheelSetup.baseRadius;
    wheelTransform.scale.set(scale, scale, scale);
    const halfTrack = spec.track / 2;
    const halfBase = spec.wheelbase / 2;
    const lift = wheelSetup.groundOffset * scale;
    // Euler(pitch, heading, roll, 'YXZ') 的三列（three Matrix4.makeRotationFromEuler 的同款公式）
    const a = Math.cos(pose.pitch), b = Math.sin(pose.pitch);
    const c = cosY, d = sinY;
    const e = Math.cos(pose.roll), f = Math.sin(pose.roll);
    const col0 = [c * e + d * f * b, a * f, c * f * b - d * e];
    const col1 = [d * e * b - c * f, a * e, d * f + c * e * b];
    const col2 = [a * d, -b, a * c];
    for (let w = 0; w < 2; w++) {
      const wz = w === 0 ? halfBase : -halfBase;
      wheelTransform.rotation.set(pose.pitch + actor.wheelSpin + w * 0.55, pose.heading + (w === 0 ? actor.steer : 0),
        pose.roll, 'YXZ');
      for (const side of [-1, 1]) {
        const x = side * halfTrack;
        wheelTransform.position.set(
          pose.x + col0[0] * x + col1[0] * lift + col2[0] * wz,
          pose.y + col0[1] * x + col1[1] * lift + col2[1] * wz,
          pose.z + col0[2] * x + col1[2] * lift + col2[2] * wz
        );
        wheelTransform.updateMatrix();
        (side < 0 ? wheelLeft : wheelRight).setMatrixAt(wheelIndex * 2 + w, wheelTransform.matrix);
      }
    }
  }

  function collides(body, actor) {
    for (const candidate of players) {
      if (intersects(body, candidate) && vehicleContact(body, candidate, contact)) return candidate;
    }
    for (const candidate of walkers) {
      if (intersects(body, candidate) && vehicleContact(body, candidate, contact)) return candidate;
    }
    for (const other of vehicles) {
      if (other !== actor && other.route && intersects(body, other.collider)
        && vehicleContact(body, other.collider, contact)) return other.collider;
    }
    return null;
  }

  function blockerOnRoute(actor, route, s, includeTraffic) {
    if (!poseOnRoute(route, s, actor.model, heightFor, scratch)) return { kind: 'road-contact', atS: s };
    applyLaneShift(actor, scratch);
    const body = writeTrafficCollider(probe, actor.model, scratch);
    body.supportedSlabs = scratch.supportedSlabs;
    const blocker = blockedByBuilding(body) || (includeTraffic ? collides(body, actor) : null);
    return blocker ? { kind: blocker.type ?? 'static', id: blocker.id ?? blocker.sourceId ?? blocker.name ?? null,
      part: blocker.part ?? null, atS: s } : null;
  }

  function junctionExitBlocker(actor, stop, fresh = false) {
    if (!fresh && actor.exitProbe?.stop === stop && actor.exitProbe.until > simulationTime) return actor.exitProbe.blocker;
    const last = Math.min(actor.end, stop.clearS + SIGNAL_EXIT_BUFFER);
    let blocker = null;
    // 当前路线先通过精细静态检查，绿灯放行前再确认整个出口没有排队车辆。
    for (let s = Math.max(actor.s, stop.s); s <= last; s += 1.75) {
      blocker = blockerOnRoute(actor, actor.route, s, true);
      if (blocker) break;
    }
    blocker ??= blockerOnRoute(actor, actor.route, last, true);
    actor.exitProbe = { stop, until: simulationTime + 0.18, blocker };
    return blocker;
  }

  // 车道偏移是相对路线中心线的横向量，正=行驶方向右侧；换道期间叠加在路线上，不改路线几何。
function applyLaneShift(actor, pose) {
  if (!actor.shift) return;
  pose.x -= pose.cos * actor.shift;
  pose.z += pose.sin * actor.shift;
}

// 把车体投影到本车路线上，返回沿线位置与相对本车道的横向偏移（正=右）。
function projectOnRoute(samples, index, s, x, z, reach) {
  let best = null;
  for (let i = Math.max(0, index - 2); i < samples.length - 1 && samples[i].s <= s + reach; i++) {
    const a = samples[i], b = samples[i + 1], length = b.s - a.s;
    if (length <= 1e-6) continue;
    const fx = (b.x - a.x) / length, fz = (b.z - a.z) / length;
    const t = Math.max(0, Math.min(length, (x - a.x) * fx + (z - a.z) * fz));
    const px = a.x + fx * t, pz = a.z + fz * t;
    const along = a.s + t;
    if (along < s - 14 || along > s + reach) continue;
    const offset = (x - px) * -fz + (z - pz) * fx;
    const error = Math.abs(offset);
    if (!best || error < best.error) best = { s: along, offset, error };
  }
  return best;
}

// 目标车道在本车后方 8 米、前方 22 米内没有车才允许并过去；正在并线的车按实际位置参与判定。
function laneGapOk(actor, delta, out = null) {
  for (const body of frameBodies) {
    if (body.id === actor.collider.id) continue;
    // 路线投影对远离本车的主体没有意义：先按直线距离排除，避免已回收车辆的残留碰撞盒挡住并线。
    if (Math.hypot(body.x - actor.pose.x, body.z - actor.pose.z) > 40) continue;
    const hit = projectOnRoute(actor.route, actor.pose.index, actor.s, body.x, body.z, 30);
    if (!hit || Math.abs(hit.offset - delta) > 2.4) continue;
    if (hit.s > actor.s - 8 - body.halfL && hit.s < actor.s + 22 + body.halfL) {
      if (out) out.push({ kind: body.type ?? 'vehicle', id: body.id ?? null,
        ahead: +(hit.s - actor.s).toFixed(1), offset: +hit.offset.toFixed(2) });
      return false;
    }
  }
  return true;
}

function startLaneChange(actor) {
  const sample = actor.route[actor.pose.index];
  const edge = sample?.edge;
  actor.laneTries = (actor.laneTries ?? 0) + 1;
  // 路段没有可靠车道数据时不算并线失败，只记为不具备条件。
  const reject = why => { actor.laneAbort = { reject: why }; statistics.laneChangeIneligible++; };
  if (!edge) return reject('no-edge');
  if (actor.junction.reservation) return reject('reservation');
  const lanes = laneOffsets(edge.section);
  if (!lanes) return reject('no-lanes');
  if (lanes.length < 2) return reject('single-lane');
  const usable = lanes.filter(offset => Math.abs(offset) + actor.model.hx + 0.08 <= edge.section.travelWidthM / 2);
  if (usable.length < 2) return reject('narrow');
  const current = sample.laneOffset ?? 0;
  let index = -1, best = 0.6;
  for (let i = 0; i < usable.length; i++) {
    const delta = Math.abs(usable[i] - current);
    if (delta < best) { best = delta; index = i; }
  }
  if (index < 0) return reject('lane-mismatch');
  // 只在当前路段还剩足够长度时换道；接近路口或匝道鼻端不并线。
  for (let i = actor.pose.index; i < actor.route.length && actor.route[i].s <= actor.s + LANE_CHANGE_MIN_EDGE; i++) {
    if (actor.route[i].edge !== edge) return reject('near-junction');
  }
  const tried = [];
  const why = [];
  for (const step of [-1, 1]) {
    const target = usable[index + step];
    if (target === undefined) { tried.push(['none', step]); continue; }
    const delta = target - current;
    const gap = Math.abs(delta) < 0.6 ? false : laneGapOk(actor, delta, why);
    tried.push([gap ? 'ok' : 'blocked', +delta.toFixed(2)]);
    if (!gap) continue;
    actor.laneChange = { from: actor.shift, to: delta, t: 0, duration: LANE_CHANGE_SECONDS,
      edge, lane: index + step, lanes: usable.length };
    statistics.laneChanges++;
    return;
  }
  actor.laneAbort = { current, usable: [...usable], tried, why };
  statistics.laneChangeAborts++;
}

function updateLaneChange(actor, dt) {
  const change = actor.laneChange;
  if (change) {
    if (change.edge !== actor.pose.edge) {
      // 跨到下一路段时基准车道变了，把还没走完的横向偏移收回来。
      change.from = actor.shift;
      change.to = 0;
      change.t = 0;
      change.duration = 0.8;
      change.edge = actor.pose.edge;
    }
    change.t = Math.min(1, change.t + dt / change.duration);
    const t = change.t;
    actor.shift = change.from + (change.to - change.from) * t * t * t * (10 - 15 * t + 6 * t * t);
    if (t >= 1) {
      actor.shift = change.to;
      actor.laneChange = null;
      if (change.to !== 0) actor.laneChoice = (change.lane + 0.5) / change.lanes;
    }
    return;
  }
  if (actor.shift) {
    const decay = Math.min(Math.abs(actor.shift), dt * 4);
    actor.shift -= Math.sign(actor.shift) * decay;
  }
  if (actor.speed > 2.5) { actor.blockedFor = 0; return; }
  const leader = routeLeader({ samples: actor.route, index: actor.pose.index, s: actor.s, reach: 16,
    ego: actor.collider, bodies: frameBodies, roadHeight: heightFor });
  actor.blockedFor = leader.gap < 14 && leader.limit < 1.2 ? (actor.blockedFor ?? 0) + dt : 0;
  if (actor.blockedFor > 2) { actor.blockedFor = 0; startLaneChange(actor); }
}

// 从当前位姿所在的路段反推 routeSegments 需要的 marker。
function markerAt(actor) {
  const edge = actor.pose.edge;
  if (!edge?.segments?.length) return null;
  let best = null;
  for (let i = 0; i < edge.segments.length; i++) {
    const segment = edge.segments[i];
    const t = Math.max(0, Math.min(segment.length,
      (actor.pose.x - segment.x) * segment.dx + (actor.pose.z - segment.z) * segment.dz));
    const error = Math.hypot(actor.pose.x - (segment.x + segment.dx * t), actor.pose.z - (segment.z + segment.dz * t));
    if (!best || error < best.error) best = { edge, segment: i, distance: t, error, x: actor.pose.x, z: actor.pose.z };
  }
  return best && best.error < edge.section.travelWidthM ? best : null;
}

// 剩余路线不足时从当前位置续接；先按出生同样的静态规则截断，避免续进建筑。
function extendRoute(actor, recovering = false) {
  const marker = markerAt(actor);
  if (!marker) { actor.dead = true; return; }
  // 续接时以车辆实际横向位置（路线车道 + 换道偏移）为准，避免换道完成后又被新路线拽回原车道。
  const lane = (actor.route[actor.pose.index]?.laneOffset ?? 0) + (actor.shift ?? 0);
  const samples = laneRoute(routeSegments(marker, actor.model, actor.random, detailedRoads, actor.laneChoice, lane));
  if (samples.length < 2) { actor.dead = true; return; }
  const start = Math.max(0, marker.distance - 16);
  const s = marker.distance - start;
  if (!poseOnRoute(samples, s, actor.model, heightFor, scratch)) { actor.dead = true; return; }
  // 新路线接不上当前位姿时不要每帧静默重试：连续失败半秒就判死，交给远距回收。
  if (Math.hypot(scratch.x - actor.pose.x, scratch.z - actor.pose.z) > 5) {
    actor.extendFails = (actor.extendFails ?? 0) + 1;
    if (actor.extendFails > 30) actor.dead = true;
    return;
  }
  const reach = samples.at(-1).s;
  const limit = Math.min(reach, s + 320);
  let last = s;
  while (last < limit) {
    // 从卡住的位姿重选转弯时，先细查车身出口，避免粗采样跨过短小的承托缺口。
    const step = recovering && last - s < 12 ? 0.5 : 4;
    const next = Math.min(limit, last + step);
    if (blockerOnRoute(actor, samples, next, false)) break;
    last = next;
  }
  const required = recovering ? 12 : actor.extendShort ? Math.max(12, actor.end - actor.s + 6) : 60;
  if (last - s < required) {
    if (!actor.extendShort || actor.end - actor.s < 0.5) actor.dead = true;
    return;
  }
  const rearMargin = Math.hypot(actor.model.hx, actor.model.hz) + Math.abs(actor.model.z) + 0.5;
  actor.route = samples;
  actor.s = s;
  actor.end = last;
  // 静态检查后的实际末端短于预取距离时，在临近末端后按间隔尝试其他合法续接。
  actor.extendShort = last < s + EXTEND_AHEAD;
  actor.retryAfter = 0;
  actor.stops = routeSignalStops(samples, signals, rearMargin).filter(stop => stop.clearS > s);
  actor.stopIndex = 0;
  actor.junction.suspend();
  actor.exitProbe = null;
  actor.laneChange = null;
  actor.shift = 0;
  actor.dead = false;
  actor.deadSince = 0;
  actor.extendFails = 0;
  statistics.routeExtensions++;
}

// 出生时挑一条 80 米内同路段车最少的车道，避免同一车道连排投放。
function chooseLaneChoice(marker, model, random) {
  const edge = marker.edge;
  const lanes = laneOffsets(edge.section);
  if (!lanes?.length) return detailedRoads.size ? random() : 0.5;
  const usable = lanes.filter(offset => Math.abs(offset) + model.hx + 0.08 <= edge.section.travelWidthM / 2);
  if (!usable.length) return 0.5;
  const counts = usable.map(offset => {
    let count = 0;
    for (const actor of vehicles) {
      if (!actor.route || actor.pose.edge !== edge) continue;
      const sample = actor.route[actor.pose.index];
      if (Math.abs((sample?.laneOffset ?? 0) - offset) > 1.8) continue;
      if (squareDistance(actor.pose.x, actor.pose.z, marker) < 80 ** 2) count++;
    }
    return count;
  });
  const fewest = Math.min(...counts);
  const options = counts.flatMap((count, index) => count === fewest ? [index] : []);
  return (options[Math.floor(random() * options.length)] + 0.5) / usable.length;
}

// 沿路段累计的里程；路线续接后 actor.s 会从 16 米重新开始，不能直接用来量车间距。
function edgeAlong(edge, x, z) {
  let best = null;
  let base = 0;
  for (const segment of edge.segments) {
    const t = Math.max(0, Math.min(segment.length, (x - segment.x) * segment.dx + (z - segment.z) * segment.dz));
    const error = Math.hypot(x - (segment.x + segment.dx * t), z - (segment.z + segment.dz * t));
    if (!best || error < best.error) best = { error, along: base + t };
    base += segment.length;
  }
  return best ? best.along : 0;
}

// 拥堵统计：按“路段+车道”分组，连续车间距小于 12 米算排队。
let queueTimer = 0;
function sampleStatistics(dt) {
  queueTimer += dt;
  if (queueTimer < 0.5) return;
  queueTimer = 0;
  const groups = new Map();
  let stopped = 0;
  for (const actor of vehicles) {
    if (!actor.route) continue;
    if (!actor.dead && actor.stalled > 8 && !actor.waitingForSignal) stopped++;
    const sample = actor.route[actor.pose.index];
    const key = `${sample.edge.sourceIndex}:${Math.round((sample.laneOffset ?? 0) * 10)}`;
    const list = groups.get(key) ?? [];
    list.push(edgeAlong(sample.edge, actor.pose.x, actor.pose.z));
    groups.set(key, list);
  }
  let longest = 0;
  for (const list of groups.values()) {
    list.sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < list.length; i++) {
      run = list[i] - list[i - 1] < 12 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
  }
  statistics.stoppedOver8s = stopped;
  statistics.maxQueue = Math.max(statistics.maxQueue, longest);
}

function startRoute(actor, focus) {
    const { model, random } = actor;
    // 高架链路不在桥面中途凭空生成车辆：约一半环境车从已核实高架的落地引道出发，
    // 让桥面车流有真实的地面来源，其余仍按普通路网随机，避免车辆只在桥上概率性出现。
    const approachOnly = actor.id % 2 === 0 && approachCandidates.length > 0;
    const pool = approachOnly ? approachCandidates : candidates;
    for (let attempt = 0; attempt < 5 && pool.length > 0; attempt++) {
      const marker = pool[Math.floor(random() * pool.length)];
      const distance = squareDistance(marker.x, marker.z, focus);
      if (distance < 44 ** 2 || distance > SEARCH_RADIUS ** 2 || !usableWidth(marker.edge, model.hx)) continue;
      const laneChoice = chooseLaneChoice(marker, model, random);
      const samples = laneRoute(routeSegments(marker, model, random, detailedRoads, laneChoice));
      if (samples.at(-1)?.edge.section.reviewed || samples.at(-1)?.edge.surfaceId) {
        statistics.mainlineEndRejects++;
        continue;
      }
      const first = Math.max(6, model.hz + 1);
      const limit = (samples.at(-1)?.s ?? 0) - model.hz - 1;
      if (limit < first + 42 || !poseOnRoute(samples, first, model, heightFor, actor.pose)) continue;
      if (signals?.contains(actor.pose.x, actor.pose.z, model.hz + 0.5)) continue;
      writeTrafficCollider(actor.collider, model, actor.pose);
      actor.collider.surfaceId = actor.pose.edge?.surfaceId;
      actor.collider.supportedSlabs = actor.pose.supportedSlabs;
      if (blockedByBuilding(actor.collider) || collides(actor.collider, actor)) continue;
      // 与既有车保持 25 米：同车道 2 秒内不重复投放，避免出生就连成一串。
      if (vehicles.some(other => other.route && other !== actor
        && squareDistance(other.pose.x, other.pose.z, actor.pose) < 25 ** 2)) {
        statistics.spawnThrottled++;
        continue;
      }
      const rearMargin = Math.hypot(model.hx, model.hz) + Math.abs(model.z) + 0.5;
      const routeStops = routeSignalStops(samples, signals, rearMargin).filter(stop => stop.s >= first);
      let last = first;
      while (last < limit) {
        const inJunction = routeStops.some(stop => last + 1 >= stop.s - rearMargin && last <= stop.clearS + SIGNAL_EXIT_BUFFER);
        const next = Math.min(limit, last + (inJunction ? 0.125 : 1));
        if (blockerOnRoute(actor, samples, next, false)) break;
        last = next;
      }
      if (last - first < 42) continue;
      const stops = routeStops.filter(stop => stop.s <= last + model.z + model.hz);
      const exitsBlocked = stops.some(stop => stop.clearS + SIGNAL_EXIT_BUFFER > last);
      if (!poseOnRoute(samples, last, model, heightFor, scratch)) continue;
      // 行程必须驶离桥面回到地面，避免环境车停在桥面上形成永久队尾。
      if (scratch.edge.section.reviewed || scratch.edge.surfaceId) {
        statistics.mainlineEndRejects++;
        continue;
      }
      if (exitsBlocked || signals?.contains(scratch.x, scratch.z, rearMargin + SIGNAL_EXIT_BUFFER)) {
        statistics.signalExitRejects++;
        continue;
      }
      // 路面验证截短的行程同样检查终点，避免在玩家附近制造永久队尾。
      if (squareDistance(scratch.x, scratch.z, focus) < NEAR_ROUTE_END_RADIUS ** 2) {
        statistics.nearEndRejects++;
        continue;
      }
      actor.junction.abandon();
      actor.route = samples;
      actor.stops = stops;
      actor.stopIndex = 0;
      actor.exitProbe = null;
      actor.blocker = null;
      actor.waitingForSignal = false;
      actor.s = first;
      actor.end = last;
      actor.laneChoice = laneChoice;
      actor.shift = 0;
      actor.laneChange = null;
      actor.blockedFor = 0;
      actor.dead = false;
      actor.deadSince = 0;
      actor.extendFails = 0;
      actor.extendShort = false;
      actor.retryAfter = 0;
      actor.speed = Math.min(4, actor.desiredSpeed);
      actor.collider.vx = actor.pose.sin * actor.speed;
      actor.collider.vz = actor.pose.cos * actor.speed;
      actor.stalled = 0;
      actor.wheelSpin = 0;
      actor.steer = 0;
      actor.prevX = actor.pose.x;
      actor.prevZ = actor.pose.z;
      actor.prevHeading = actor.pose.heading;
      statistics.spawned++;
      return;
    }
  }

  function dropRoute(actor) {
    actor.junction.abandon();
    actor.route = null;
  }

  function advance(actor, dt, elapsedSeconds) {
    const { model, route } = actor;
    const stop = actor.stops[actor.stopIndex];
    const stoppingAt = stop ? stop.s - (model.hz + model.z) - 0.16 : Infinity;
    const remaining = Math.max(0, stoppingAt - actor.s);
    const awaiting = Boolean(stop) && actor.junction.reservation === null;
    const atQueue = awaiting && remaining <= 4;
    const queueBlocker = atQueue ? junctionExitBlocker(actor, stop) : null;
    // 4 米内排队请求随出口状态刷新；绿灯但出口未清空时同样停在停止线前。
    const gate = actor.junction.wait(stop?.approach ?? null, elapsedSeconds,
      { distance: stop ? stoppingAt - actor.s : Infinity, exitBlocked: Boolean(queueBlocker) });
    const phaseHeld = gate.phaseHeld;
    const checkingExit = awaiting && !phaseHeld && remaining <= Math.max(12, actor.speed ** 2 / 7.2 + 2);
    const exitBlocker = queueBlocker ?? (checkingExit ? junctionExitBlocker(actor, stop) : null);
    const held = gate.held || Boolean(exitBlocker);
    actor.blocker = exitBlocker ? { ...exitBlocker, atExit: true }
      : phaseHeld ? { kind: 'signal-or-owner', id: stop.approach.id } : null;
    const brakingSpeed = held ? Math.sqrt(2 * 3.6 * remaining) : Infinity;
    const leader = routeLeader({ samples: route, index: actor.pose.index, s: actor.s,
      reach: followingReach(actor.speed), ego: actor.collider,
      bodies: frameBodies, roadHeight: heightFor });
    if (!actor.blocker && leader.blocker && leader.limit < actor.desiredSpeed) {
      actor.blocker = { kind: leader.blocker.type, id: leader.blocker.id };
    }
    let rampSpeed = Infinity;
    for (let i = actor.pose.index; i < route.length && route[i].s <= actor.s + 22; i++) {
      rampSpeed = Math.min(rampSpeed, route[i].edge.rampSpeed ?? Infinity);
    }
    let desired = Math.min(actor.desiredSpeed, leader.limit, rampSpeed);
    let deceleration = leader.gap < 4 ? 7.5 : 3.6;
    let acceleration = 2.2;
    // 玩家从后方追上来时不要只会亮刹车灯：撞击点在本车后半段就地板油让开，在车头则全力刹停。
    const player = players.find(body => body.type === 'player');
    const impact = playerImpact(actor.collider, player);
    actor.alarm = impact ? (actor.alarm ?? 0) + dt : Math.max(0, (actor.alarm ?? 0) - dt);
    if (actor.alarm >= PLAYER_REACTION_S) {
      actor.panicUntil = clock + PLAYER_HOLD_S;
      actor.panicAhead = impact?.ahead ?? 0;
    }
    if (clock < (actor.panicUntil ?? 0)) {
      if ((actor.panicAhead ?? 0) >= 0) {
        desired = 0;
        deceleration = 9;
        actor.blocker ??= { kind: 'player', id: 'player' };
      } else {
        const escape = Math.min(actor.desiredSpeed * 1.4, actor.speed + 9);
        desired = Math.min(Math.max(desired, escape), leader.limit, rampSpeed);
        acceleration = 6;
      }
    }
    const speed = Math.min(brakingSpeed, actor.speed + Math.max(-deceleration * dt, Math.min(acceleration * dt, desired - actor.speed)));
    const next = Math.min(actor.end, actor.s + speed * dt, held ? Math.max(actor.s, stoppingAt) : Infinity);
    const steps = Math.ceil((next - actor.s) / 0.25);
    let s = actor.s;
    for (let step = 1; step <= steps; step++) {
      const target = interpolate(actor.s, next, step / steps);
      const entering = stop && actor.junction.reservation === null && target > stoppingAt;
      if (entering) {
        const blocker = junctionExitBlocker(actor, stop, true);
        if (blocker) {
          // 越过停止线前出口仍被占：请求保持未就绪，车辆不占用冲突区。
          actor.junction.enter(elapsedSeconds, true);
          actor.blocker = { ...blocker, atExit: true };
          break;
        }
      }
      const movementBlocker = blockerOnRoute(actor, route, target, true);
      if (movementBlocker) { actor.blocker = movementBlocker; break; }
      if (entering) {
        const entered = actor.junction.enter(elapsedSeconds);
        if (!entered.ok) break;
        if (entered.entered) statistics.signalEntries++;
      }
      s = target;
      Object.assign(actor.pose, scratch);
      applyLaneShift(actor, actor.pose);
      writeTrafficCollider(actor.collider, model, actor.pose);
    }
    if (actor.junction.reservation && s >= stop.clearS) {
      actor.junction.release(true);
      actor.stopIndex++;
    }
    const waiting = Boolean(held && remaining < 1.1);
    if (waiting && !actor.waitingForSignal) statistics.signalWaits++;
    actor.waitingForSignal = waiting;
    actor.stalled = s === actor.s && !waiting ? actor.stalled + dt : 0;
    // 路面接触检查失败说明这条车道在当前位置真的过不去（弯道外缘/路口缺口），别让它永久杵在那里。
    if (actor.stalled > 6 && actor.blocker?.kind === 'road-contact') actor.dead = true;
    // 短路段在合法续接失败时交给远距回收；近处仍按间隔继续检查出口。
    if (actor.extendShort && actor.end - actor.s < 0.5) actor.dead = true;
    actor.speed = steps > 0 && s === next ? speed : 0;
    actor.s = s;
    actor.collider.vx = actor.pose.sin * actor.speed;
    actor.collider.vz = actor.pose.cos * actor.speed;
  }

  function update(dt, focus, entities = [], elapsedSeconds = null, isVisible = null, pedestrians = []) {
    if (!Number.isFinite(focus?.x) || !Number.isFinite(focus?.z)) return;
    dt = Math.max(0, Math.min(dt, 0.05));
    simulationTime += dt;
    clock = Number.isFinite(elapsedSeconds) ? elapsedSeconds : clock + dt;
    players = entities.filter(entity => entity.position && entity.type !== 'helicopter')
      .map(entity => writeEntityCollider({}, entity));
    walkers = pedestrians;
    // 所有跟车决策读取帧首速度；实际推进仍按当前占用逐子步核验。
    frameBodies.length = 0;
    frameBodies.push(...players, ...walkers);
    for (const actor of vehicles) if (actor.route) frameBodies.push({ ...actor.collider });
    for (const actor of vehicles) {
      if (!actor.route) continue;
      const distance = squareDistance(actor.pose.x, actor.pose.z, focus);
      const inBore = actor.pose.edge?.tunnel === true;
      const outside = !inBore && distance > DESPAWN_RADIUS ** 2;
      // 路线会续接：只有真卡死（8 秒不动或续接失败）且远离玩家时才回收，视野内保留。
      const blocked = !inBore && actor.stalled > 8 && distance > 160 ** 2;
      const dead = !inBore && actor.dead && distance > 120 ** 2;
      if (actor.dead && !actor.deadSince) actor.deadSince = simulationTime;
      // 视锥内保留实体和碰撞；判死且远离玩家的车最多再留 3 秒，避免视野边缘留下永久停驶的车。
      const deadExpired = dead && simulationTime - actor.deadSince > 3;
      if ((outside || blocked || dead) && (isVisible ? !isVisible(actor.collider) || deadExpired : outside)) {
        dropRoute(actor);
        statistics.offscreenRecycled++;
        if (blocked || dead) statistics.stalledRecycled++;
      } else if (dt) {
        updateLaneChange(actor, dt);
        const remaining = actor.end - actor.s;
        const canExtend = !actor.laneChange && !actor.junction.reservation;
        const recovering = actor.dead && actor.stalled > 6;
        const shortEnd = actor.extendShort && remaining < TERMINAL_RETRY_NEAR_M;
        if (canExtend && (recovering || shortEnd) && simulationTime >= (actor.retryAfter ?? 0)) {
          actor.retryAfter = simulationTime + TERMINAL_RETRY_INTERVAL_S;
          extendRoute(actor, recovering);
        } else if (canExtend && !recovering && !actor.extendShort && remaining < EXTEND_AHEAD) {
          extendRoute(actor);
        }
        advance(actor, dt, clock);
      }
    }
    refill -= dt;
    if (refill <= 0 && vehicles.some(actor => !actor.route)) {
      refill = 0.17;
      const ix = Math.floor(focus.x / SPAWN_CELL), iz = Math.floor(focus.z / SPAWN_CELL);
      const key = cellKey(ix, iz);
      if (key !== spawnKey) {
        const reach = Math.ceil(SEARCH_RADIUS / SPAWN_CELL);
        spawnKey = key;
        candidates = [];
        approachCandidates = [];
        for (let x = ix - reach; x <= ix + reach; x++) {
          for (let z = iz - reach; z <= iz + reach; z++) {
            for (const marker of network.cells.get(cellKey(x, z)) ?? []) {
              // 桥面中途不生成车辆，避免车在桥上凭空出现；桥面车流只从落地引道驶入。
              if (marker.edge.elevated) continue;
              candidates.push(marker);
              if (marker.edge.next.some(next => next.elevated)) approachCandidates.push(marker);
            }
          }
        }
      }
      let attempts = 0;
      for (const actor of vehicles) {
        if (actor.route) continue;
        startRoute(actor, focus);
        if (++attempts >= 4) break;
      }
    }
    let active = 0;
    let wheelSlots = 0;
    for (const batch of batches) {
      const { mesh, actors } = batch;
      let count = 0;
      for (const actor of actors) {
        if (!actor.route) continue;
        const { pose } = actor;
        transform.position.set(pose.x, pose.y, pose.z);
        transform.rotation.set(pose.pitch, pose.heading, pose.roll, 'YXZ');
        transform.updateMatrix();
        mesh.setMatrixAt(count, transform.matrix);
        if (batch.wheels) {
          writeCarState(batch, actor, count);
          placeCarWheels(actor, wheelSlots, dt);
          wheelSlots++;
        }
        count++;
      }
      if (count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (batch.wheels) {
          mesh.geometry.attributes.paintColor.needsUpdate = true;
          mesh.geometry.attributes.carState.needsUpdate = true;
        }
      }
      mesh.count = count;
      active += count;
    }
    const wheelCount = wheelSlots * 2;
    if (wheelCount > 0) {
      wheelLeft.instanceMatrix.needsUpdate = true;
      wheelRight.instanceMatrix.needsUpdate = true;
      wheelStyles.needsUpdate = true;
    }
    wheelLeft.count = wheelCount;
    wheelRight.count = wheelCount;
    statistics.active = active;
    sampleStatistics(dt);
  }

  function nearColliders(x, z, radius) {
    const result = [];
    for (const { route, collider } of vehicles) {
      if (route && collider.minX <= x + radius && collider.maxX >= x - radius
        && collider.minZ <= z + radius && collider.maxZ >= z - radius) result.push(collider);
    }
    return result;
  }

  return { group, update, nearColliders, vehicles, statistics, network, roadHeight: heightFor,
    dispose() {
      for (const actor of vehicles) dropRoute(actor);
      scene.remove(group);
      const geometries = new Set();
      for (const { mesh } of batches) {
        geometries.add(mesh.geometry);
        mesh.dispose();
      }
      geometries.add(wheelSetup.left);
      geometries.add(wheelSetup.right);
      for (const geometry of geometries) geometry.dispose();
      wheelSetup.material.dispose();
      busMaterial.dispose();
      wheelLeft.dispose();
      wheelRight.dispose();
    } };
}
