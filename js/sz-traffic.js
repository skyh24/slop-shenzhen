import * as THREE from 'three/webgpu';
import { isGroundRoad, roadLinkPoints } from './sz-roads.js';
import { createTrafficVehicleGeometry, VEHICLE_SPECS } from './sz-vehicles.js';
import { polygonBoxOverlaps } from './building-collision.js';
import { vehicleContact } from './vehicle-physics.js';

const SPAWN_CELL = 100;
const SEARCH_RADIUS = 360;
const DESPAWN_RADIUS = 430;
const BODY_CELL = 32;
const FLEET = [
  { type: 'taxi', count: 6, speed: 10 },
  { type: 'sedan', color: 0xc7ced2, count: 12, speed: 11 },
  { type: 'suv', color: 0x344653, count: 10, speed: 10 },
  { type: 'bus', count: 2, speed: 8 }
];
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

export function createTrafficGraph(graph) {
  const edges = [];
  const outgoing = new Map();
  const cells = new Map();
  for (let i = 0; i < graph.links.length; i++) {
    const metadata = graph.metadata[i];
    if (!isGroundRoad(metadata)) continue;
    const link = graph.links[i];
    const [a, b, name, width, lanes, direction] = link;
    const points = roadLinkPoints(graph, link);
    if (points.length < 2) continue;
    for (const sign of direction === 0 ? [1, -1] : [direction]) {
      const from = sign === 1 ? a : b;
      const to = sign === 1 ? b : a;
      const path = sign === 1 ? points : [...points].reverse();
      const edge = { from, to, sign, width, lanes, direction, name: graph.names[name],
        osmId: metadata.osmId, sourceIndex: i, segments: [], next: [] };
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
  // 只按源节点身份连边，不把平面交叉、反向掉头和未解析桥隧拼进路线。
  for (const edge of edges) {
    const last = edge.segments.at(-1);
    edge.next = (outgoing.get(edge.to) ?? []).filter(next => {
      const first = next.segments[0];
      return next.sourceIndex !== edge.sourceIndex && next.to !== edge.from
        && last.dx * first.dx + last.dz * first.dz > -0.45;
    });
  }
  return { edges, cells };
}

function usableWidth(edge, halfWidth) {
  return edge.width >= (edge.direction === 0 ? 4 : 2) * halfWidth + 0.16;
}

function routeSegments(marker, model, random) {
  const segments = [];
  const used = new Set();
  let edge = marker.edge;
  let index = marker.segment;
  let start = Math.max(0, marker.distance - 16);
  let remaining = 560;
  while (edge && remaining > 0 && segments.length < 80) {
    used.add(edge.sourceIndex);
    const offset = edge.direction === 0 ? Math.min(edge.width / 4, 2.3) : 0;
    for (; index < edge.segments.length && remaining > 0; index++) {
      const segment = edge.segments[index];
      const length = Math.min(segment.length - start, remaining);
      if (length > 0) segments.push({ ...segment, length,
        x: segment.x + segment.dx * start - segment.dz * offset,
        z: segment.z + segment.dz * start + segment.dx * offset, edge });
      remaining -= length;
      start = 0;
    }
    const choices = edge.next.filter(next => !used.has(next.sourceIndex) && usableWidth(next, model.hx));
    edge = choices[Math.floor(random() * choices.length)];
    index = 0;
  }
  return segments;
}

function laneRoute(segments) {
  const samples = [];
  const bend = (a, b) => a && b ? Math.min(3.2, a.length * 0.36, b.length * 0.36) : 0;
  function add(x, z, dx, dz, edge) {
    const previous = samples.at(-1);
    const step = previous ? Math.hypot(x - previous.x, z - previous.z) : 0;
    if (previous && step <= 1e-6) return;
    samples.push({ x, z, dx, dz, edge, s: (previous?.s ?? 0) + step });
  }
  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    const start = bend(segments[i - 1], current);
    const gap = bend(current, next);
    const end = current.length - gap;
    const steps = Math.max(1, Math.ceil((end - start) / 2));
    for (let k = 0; k <= steps; k++) {
      const distance = interpolate(start, end, k / steps);
      add(current.x + distance * current.dx, current.z + distance * current.dz, current.dx, current.dz, current.edge);
    }
    if (!next) continue;
    // 过弯只在连接点的短范围内平滑，生成后按实际沥青网格逐步复核。
    const a = samples.at(-1);
    const b = { x: a.x + current.dx * gap * 0.62, z: a.z + current.dz * gap * 0.62 };
    const c = { x: next.x + next.dx * gap * 0.38, z: next.z + next.dz * gap * 0.38 };
    const d = { x: next.x + next.dx * gap, z: next.z + next.dz * gap };
    const subdivisions = Math.max(3, Math.ceil(Math.hypot(d.x - a.x, d.z - a.z)));
    for (let k = 1; k <= subdivisions; k++) {
      const t = k / subdivisions;
      const u = 1 - t;
      const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
      const z = u ** 3 * a.z + 3 * u * u * t * b.z + 3 * u * t * t * c.z + t ** 3 * d.z;
      const dx = u * u * (b.x - a.x) + 2 * u * t * (c.x - b.x) + t * t * (d.x - c.x);
      const dz = u * u * (b.z - a.z) + 2 * u * t * (c.z - b.z) + t * t * (d.z - c.z);
      const length = Math.hypot(dx, dz) || 1;
      add(x, z, dx / length, dz / length, t < 0.5 ? current.edge : next.edge);
    }
  }
  return samples;
}

function poseOnRoute(samples, s, model, roadHeight, pose) {
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (s - a.s) / (b.s - a.s);
  const x = interpolate(a.x, b.x, t);
  const z = interpolate(a.z, b.z, t);
  const heading = Math.atan2(interpolate(a.dx, b.dx, t), interpolate(a.dz, b.dz, t));
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const heightAt = (px, pz) => roadHeight(x + px * cos + pz * sin, z - px * sin + pz * cos);
  const center = heightAt(0, 0);
  if (!Number.isFinite(center)) return false;
  const { halfTrack, halfWheelbase } = model;
  const leftFront = heightAt(-halfTrack, halfWheelbase);
  const rightFront = heightAt(halfTrack, halfWheelbase);
  const leftRear = heightAt(-halfTrack, -halfWheelbase);
  const rightRear = heightAt(halfTrack, -halfWheelbase);
  if (![leftFront, rightFront, leftRear, rightRear].every(Number.isFinite)) return false;
  for (const corner of model.corners) {
    if (!Number.isFinite(heightAt(corner[0], corner[1]))) return false;
  }
  const pitch = Math.atan2(leftRear + rightRear - leftFront - rightFront, 4 * halfWheelbase);
  const roll = Math.atan2(rightFront + rightRear - leftFront - leftRear, 4 * halfTrack);
  const y = (leftFront + rightFront + leftRear + rightRear) / 4;
  if (Math.abs(pitch) > 0.28 || Math.abs(roll) > 0.2 || Math.abs(center - y) > 0.26
    || Math.abs(leftFront + rightRear - rightFront - leftRear) > 0.44) return false;
  Object.assign(pose, { x, y, z, heading, pitch, roll, sin, cos, edge: t < 0.5 ? a.edge : b.edge });
  return true;
}

function boxDimensions(box) {
  const { min, max } = box;
  return { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2,
    hx: (max.x - min.x) / 2, hy: (max.y - min.y) / 2, hz: (max.z - min.z) / 2 };
}

export function trafficModelBounds(box, spec) {
  const { min, max } = box;
  return { ...boxDimensions(box),
    halfTrack: spec.track / 2, halfWheelbase: spec.wheelbase / 2,
    corners: [[min.x, min.z], [min.x, max.z], [max.x, min.z], [max.x, max.z]] };
}

export function writeTrafficCollider(body, model, pose) {
  const { sin, cos, pitch, roll } = pose;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const bx = cr * model.x - sr * model.y;
  const tilted = sr * model.x + cr * model.y;
  const by = cp * tilted - sp * model.z;
  const bz = sp * tilted + cp * model.z;
  const tiltedRadius = Math.abs(sr) * model.hx + Math.abs(cr) * model.hy;
  const halfW = Math.abs(cr) * model.hx + Math.abs(sr) * model.hy;
  const halfL = Math.abs(sp) * tiltedRadius + Math.abs(cp) * model.hz;
  const halfY = Math.abs(cp) * tiltedRadius + Math.abs(sp) * model.hz;
  const x = pose.x + cos * bx + sin * bz;
  const z = pose.z - sin * bx + cos * bz;
  const y = pose.y + by;
  const radiusX = Math.abs(cos) * halfW + Math.abs(sin) * halfL;
  const radiusZ = Math.abs(sin) * halfW + Math.abs(cos) * halfL;
  Object.assign(body, { x, y, z, heading: pose.heading, sin, cos, halfW, halfL,
    minX: x - radiusX, maxX: x + radiusX, minZ: z - radiusZ, maxZ: z + radiusZ, minY: y - halfY, maxY: y + halfY });
  Object.assign(body.obb ??= {}, { cx: x, cz: z, cs: cos, sn: sin, hx: halfW, hz: halfL });
  return body;
}

function intersects(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ && a.minY < b.maxY && a.maxY > b.minY;
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
          if (!intersects(body, candidate)) continue;
          if (!candidate.polygon || polygonBoxOverlaps(candidate.polygon, body.x, body.z,
            body.halfW, body.halfL, body.cos, body.sin)) return true;
        }
      }
    }
    return false;
  };
}

function playerBodies(entities) {
  return entities.filter(entity => entity.position && entity.type !== 'helicopter').map(entity => {
    const { x, y, z } = entity.position;
    const sin = Math.sin(entity.heading);
    const cos = Math.cos(entity.heading);
    const model = entity.collisionBounds ? boxDimensions(entity.collisionBounds) : { x: 0, y: 0.9, z: 0, hx: 0.48, hy: 0.9, hz: 0.48 };
    return writeTrafficCollider({}, model, { x, y: y + (entity.chassisPivot?.position.y ?? 0), z, sin, cos,
      pitch: entity.chassisPivot?.rotation.x ?? 0, roll: entity.chassisPivot?.rotation.z ?? 0 });
  });
}

export function createSzTraffic(scene, graph, { roadHeight, colliders = [] } = {}) {
  if (typeof roadHeight !== 'function') throw new Error('Traffic requires rendered road height');
  const network = createTrafficGraph(graph);
  const blockedByBuilding = makeObstacleIndex(colliders);
  const group = new THREE.Group();
  group.name = 'shenzhen-ground-traffic';
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.53 });
  const vehicles = [];
  const batches = FLEET.map(entry => {
    const geometry = createTrafficVehicleGeometry(entry);
    geometry.computeBoundingBox();
    const model = trafficModelBounds(geometry.boundingBox, VEHICLE_SPECS[entry.type]);
    const mesh = new THREE.InstancedMesh(geometry, material, entry.count);
    mesh.name = `traffic:${entry.type}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
    const actors = Array.from({ length: entry.count }, () => {
      const id = vehicles.length;
      const random = seededRandom(id);
      const actor = { id, type: entry.type, model, random, desiredSpeed: entry.speed * (0.88 + 0.22 * random()),
        route: null, pose: {}, collider: { type: 'vehicle', id: `traffic:${id}` }, speed: 0, stalled: 0 };
      vehicles.push(actor);
      return actor;
    });
    return { mesh, actors };
  });
  scene.add(group);

  const scratch = {};
  const probe = {};
  const contact = {};
  const transform = new THREE.Object3D();
  const statistics = { directedEdges: network.edges.length, active: 0, spawned: 0 };
  let refill = 0;
  let spawnKey = null;
  let candidates = [];
  let players = [];

  function collides(body, actor) {
    for (const candidate of players) {
      if (intersects(body, candidate) && vehicleContact(body, candidate, contact)) return true;
    }
    for (const other of vehicles) {
      if (other !== actor && other.route && intersects(body, other.collider)
        && vehicleContact(body, other.collider, contact)) return true;
    }
    return false;
  }

  function startRoute(actor, focus) {
    const { model, random } = actor;
    for (let attempt = 0; attempt < 5 && candidates.length > 0; attempt++) {
      const marker = candidates[Math.floor(random() * candidates.length)];
      const distance = squareDistance(marker.x, marker.z, focus);
      if (distance < 44 ** 2 || distance > SEARCH_RADIUS ** 2 || !usableWidth(marker.edge, model.hx)) continue;
      const samples = laneRoute(routeSegments(marker, model, random));
      const first = Math.max(6, model.hz + 1);
      const limit = (samples.at(-1)?.s ?? 0) - model.hz - 1;
      if (limit < first + 42 || !poseOnRoute(samples, first, model, roadHeight, actor.pose)) continue;
      writeTrafficCollider(actor.collider, model, actor.pose);
      if (blockedByBuilding(actor.collider) || collides(actor.collider, actor)) continue;
      let last = first;
      for (let s = first + 1; s <= limit; s++) {
        if (!poseOnRoute(samples, s, model, roadHeight, scratch)) break;
        if (blockedByBuilding(writeTrafficCollider(probe, model, scratch))) break;
        last = s;
      }
      if (last - first < 42) continue;
      actor.route = samples;
      actor.s = first;
      actor.end = last;
      actor.speed = Math.min(4, actor.desiredSpeed);
      actor.stalled = 0;
      statistics.spawned++;
      return;
    }
  }

  function advance(actor, dt) {
    const { model, route } = actor;
    const speed = Math.min(actor.desiredSpeed, actor.speed + 2.2 * dt);
    const next = Math.min(actor.end, actor.s + speed * dt);
    const steps = Math.ceil((next - actor.s) / 0.25);
    let s = actor.s;
    for (let step = 1; step <= steps; step++) {
      const target = interpolate(actor.s, next, step / steps);
      if (!poseOnRoute(route, target, model, roadHeight, scratch)
        || blockedByBuilding(writeTrafficCollider(probe, model, scratch)) || collides(probe, actor)) break;
      s = target;
      Object.assign(actor.pose, scratch);
      writeTrafficCollider(actor.collider, model, actor.pose);
    }
    actor.stalled = s === actor.s ? actor.stalled + dt : 0;
    actor.speed = steps > 0 && s === next ? speed : 0;
    actor.s = s;
  }

  function update(dt, focus, entities = []) {
    if (!Number.isFinite(focus?.x) || !Number.isFinite(focus?.z)) return;
    dt = Math.max(0, Math.min(dt, 0.05));
    players = playerBodies(entities);
    for (const actor of vehicles) {
      if (!actor.route) continue;
      const distance = squareDistance(actor.pose.x, actor.pose.z, focus);
      if (distance > DESPAWN_RADIUS ** 2 || (actor.stalled > 5 && distance > 130 ** 2)) actor.route = null;
      else if (dt) advance(actor, dt);
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
        for (let x = ix - reach; x <= ix + reach; x++) {
          for (let z = iz - reach; z <= iz + reach; z++) {
            candidates.push(...(network.cells.get(cellKey(x, z)) ?? []));
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
    for (const { mesh, actors } of batches) {
      let count = 0;
      for (const { route, pose } of actors) {
        if (!route) continue;
        transform.position.set(pose.x, pose.y, pose.z);
        transform.rotation.set(pose.pitch, pose.heading, pose.roll, 'YXZ');
        transform.updateMatrix();
        mesh.setMatrixAt(count++, transform.matrix);
      }
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
      mesh.count = count;
      active += count;
    }
    statistics.active = active;
  }

  function nearColliders(x, z, radius) {
    const result = [];
    for (const { route, collider } of vehicles) {
      if (route && collider.minX <= x + radius && collider.maxX >= x - radius
        && collider.minZ <= z + radius && collider.maxZ >= z - radius) result.push(collider);
    }
    return result;
  }

  return { group, update, nearColliders, vehicles, statistics,
    dispose() {
      scene.remove(group);
      for (const { mesh } of batches) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      material.dispose();
    } };
}
