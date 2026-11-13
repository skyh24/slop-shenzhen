import * as THREE from 'three/webgpu';
import { roadLinkPoints } from './sz-roads.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';

const STATION_SIZE = 8;
const CHUNK_M = 240;
const PALETTE = { asphalt: 0x34393b, concrete: 0xb3bbb8, lining: 0x686d70, light: 0xf4f8ff };

export function graphWithRoadStructures(graph, plan) {
  if (!plan?.records.length) return graph;
  const approaches = new Set(plan.records.filter(record => record.kind === 'tunnel').map(record => record.index));
  return { ...graph, metadata: graph.metadata.map((meta, i) =>
    approaches.has(i) && !meta.tunnel ? { ...meta, heightSource: 'structure-approach' } : meta) };
}

function readFrames(stations) {
  const frames = [];
  for (let i = 0; i < stations.length; i += STATION_SIZE) {
    const [d, x, y, z, lx, lz, rx, rz] = stations.slice(i, i + STATION_SIZE);
    frames.push({ d, x, y, z, left: { x: lx, y, z: lz }, right: { x: rx, y, z: rz } });
  }
  return frames;
}

function matchGroundEdge(graph, frame, node, approach) {
  const link = graph.links[approach];
  if (!link) return;
  const points = roadLinkPoints(graph, link);
  const atStart = link[0] === node;
  const [a, b] = atStart ? points.slice(0, 2) : points.slice(-2);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length <= 1e-6) return;
  let nx = (b.z - a.z) / length * link[3] / 2, nz = (a.x - b.x) / length * link[3] / 2;
  if ((frame.left.x - frame.x) * nx + (frame.left.z - frame.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  frame.left = { x: frame.x + nx, y: frame.y, z: frame.z + nz };
  frame.right = { x: frame.x - nx, y: frame.y, z: frame.z - nz };
}

function offset(p, y) {
  return { x: p.x, y: p.y + y, z: p.z };
}

function between(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function inset(edge, across, distance) {
  return between(edge, across, distance / Math.hypot(across.x - edge.x, across.z - edge.z));
}

function quad([a, b, c, d]) {
  return [[a, b, c], [a, c, d]];
}

function collider(type, name, outer, bottom, top) {
  return { type, name, minX: Math.min(...outer.map(p => p.x)), maxX: Math.max(...outer.map(p => p.x)),
    minZ: Math.min(...outer.map(p => p.z)), maxZ: Math.max(...outer.map(p => p.z)),
    minY: Math.min(...bottom), maxY: Math.max(...top),
    polygon: { outer, holes: [] }, roofPanel: { outer, bottom, top } };
}

function solid(draw, colliders, type, name, footprint, lower, upper, roadAccess = false, drawTop = true) {
  // 顶、底及侧壁按同一对角线拆分，实体碰撞体直接引用显示平面。
  const top = footprint.map((point, i) => offset(point, upper[i]));
  const bottom = footprint.map((point, i) => offset(point, lower[i]));
  if (drawTop) draw.push(...quad(top));
  draw.push(...quad(bottom).map(triangle => triangle.reverse()));
  for (let i = 0; i < footprint.length; i++) {
    const next = (i + 1) % footprint.length;
    draw.push(...quad([bottom[i], bottom[next], top[next], top[i]]));
  }
  for (const indices of [[0, 1, 2], [0, 2, 3]]) {
    colliders.push({ ...collider(type, name, indices.map(i => footprint[i]),
      indices.map(i => bottom[i].y), indices.map(i => top[i].y)), roadAccess });
  }
}

function makeMesh(triangles, material, name) {
  if (triangles.length === 0) return null;
  const positions = new Float32Array(triangles.length * 9);
  let i = 0;
  for (const triangle of triangles) for (const p of triangle) {
    positions[i++] = p.x;
    positions[i++] = p.y;
    positions[i++] = p.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = name !== 'light';
  mesh.receiveShadow = name !== 'light';
  return mesh;
}

export function buildSzRoadStructures(scene, graph, plan, { groundHeight, pierAllowed = () => false } = {}) {
  const group = new THREE.Group();
  group.name = 'shenzhen-reviewed-road-structures';
  const links = [], surfaces = [], colliders = [];
  const tunnelRoutes = new Map();
  if (!plan?.records.length) return { group, links, surfaces, colliders, heightAt: () => null, constrainCamera() {}, dispose() {} };
  const materials = {
    asphalt: new THREE.MeshStandardNodeMaterial({ color: PALETTE.asphalt, roughness: 0.94, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    concrete: new THREE.MeshStandardNodeMaterial({ color: PALETTE.concrete, roughness: 0.9, side: THREE.DoubleSide }),
    lining: new THREE.MeshStandardNodeMaterial({ color: PALETTE.lining, roughness: 0.9, side: THREE.DoubleSide,
      emissive: 0x292e35, emissiveIntensity: 0.58 }),
    light: new THREE.MeshBasicNodeMaterial({ color: PALETTE.light, side: THREE.DoubleSide })
  };
  const groundAt = new Map();
  const endpointNodes = new Set(plan.records.flatMap(row => {
    const link = graph.links[row.index];
    return [row.sharedStart ? link[0] : null, row.sharedEnd ? link[1] : null].filter(node => node !== null);
  }));
  for (let index = 0; index < graph.links.length; index++) {
    const [a, b] = graph.links[index];
    if (graph.metadata[index].heightSource !== 'terrain') continue;
    for (const node of [a, b]) {
      if (!endpointNodes.has(node)) continue;
      const edges = groundAt.get(node) ?? [];
      edges.push(index);
      groundAt.set(node, edges);
    }
  }
  const framesByIndex = new Map(plan.records.map(record => [record.index, readFrames(record.stations)]));
  for (let i = 1; i < plan.records.length; i++) {
    const a = plan.records[i - 1], b = plan.records[i];
    if (a.route !== b.route) continue;
    const before = framesByIndex.get(a.index).at(-1), after = framesByIndex.get(b.index)[0];
    // 同一源节点两侧合用一条截面边，弯坡在共同边的两端同时对齐。
    const left = between(before.left, after.left, 0.5), right = between(before.right, after.right, 0.5);
    before.left = after.left = left;
    before.right = after.right = right;
  }
  const partsByRoute = new Map();
  const batches = new Map();
  for (const record of plan.records) {
    const { index, route, widthM, lanes, kind, sharedStart, sharedEnd, stationOffsetM, coverM, openApronM } = record;
    const link = graph.links[index];
    const frames = framesByIndex.get(index);
    const [first, last] = [frames[0], frames.at(-1)];
    for (const [frame, node, shared, incoming] of [[first, link[0], sharedStart, true], [last, link[1], sharedEnd, false]]) {
      if (!shared) continue;
      const tangent = incoming ? frames[1] : frames.at(-2);
      const dx = tangent.x - frame.x, dz = tangent.z - frame.z;
      const adjacent = (groundAt.get(node) ?? []).flatMap(i => {
        const ground = graph.links[i];
        if (ground[5] !== 0 && ground[Number((ground[5] === 1) === incoming)] !== node) return [];
        const points = roadLinkPoints(graph, ground);
        const inner = ground[0] === node ? points[1] : points.at(-2);
        const ux = inner.x - frame.x, uz = inner.z - frame.z;
        const dot = (dx * ux + dz * uz) / (Math.hypot(dx, dz) * Math.hypot(ux, uz));
        return [{ i, dot }];
      }).sort((a, b) => a.dot - b.dot);
      const match = adjacent[0];
      if (match?.dot < -0.8 && !graph.metadata[match.i].crossSection) matchGroundEdge(graph, frame, node, match.i);
    }
    const id = `sz-road-structure:${index}`;
    const tunnel = kind === 'tunnel';
    const sideAllowance = tunnel ? 0.6 : 0.35;

    const topTriangles = [];
    const roofTriangles = [];
    const cameraTriangles = [];
    const accessTriangles = [];
    let nextLight = Math.ceil(stationOffsetM / 18) * 18 - stationOffsetM;
    let nextPier = Math.ceil(stationOffsetM / 42) * 42 + 21 - stationOffsetM;

    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      const chunkId = `${route}:${Math.floor((stationOffsetM + a.d) / CHUNK_M)}`;
      let batch = batches.get(chunkId);
      if (!batch) batches.set(chunkId, batch = { asphalt: [], concrete: [], lining: [], light: [] });
      const footprint = [a.left, a.right, b.right, b.left];
      const floor = quad([a.left, a.right, b.right, b.left]);
      topTriangles.push(...floor);
      batch.asphalt.push(...floor);
      const entry = sharedStart && a.d < 13;
      const exit = sharedEnd && b.d > last.d - 13;
      if (entry || exit) accessTriangles.push(...floor);

      if (tunnel) {
        const cameraInset = plan.tunnelWallM + 0.55;
        cameraTriangles.push(...quad([inset(a.left, a.right, cameraInset), inset(a.right, a.left, cameraInset),
          inset(b.right, b.left, cameraInset), inset(b.left, b.right, cameraInset)]));
        const covered = a.d >= coverM[0] - 1e-5 && b.d <= coverM[1] + 1e-5;
        const trench = (!sharedStart || b.d > openApronM + 1e-5) && (!sharedEnd || a.d < last.d - openApronM - 1e-5);
        const clearance = plan.tunnelClearanceM;
        if (covered) {
          solid(batch.lining, colliders, 'tunnel-roof', id, footprint, Array(4).fill(clearance),
            Array(4).fill(clearance + plan.tunnelRoofM));
          roofTriangles.push(...floor.map(triangle => triangle.map(p => offset(p, clearance))));
        }
        if (covered || trench) {
          for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
            const wall = [a[side], b[side], inset(b[side], b[opposite], plan.tunnelWallM), inset(a[side], a[opposite], plan.tunnelWallM)];
            const height = p => covered ? clearance + plan.tunnelRoofM : Math.max(0, (groundHeight?.(p.x, p.z) ?? p.y) - p.y);
            const ha = height(a[side]), hb = height(b[side]);
            if (Math.max(ha, hb) > 0.02) solid(batch.lining, colliders, 'tunnel-wall', id, wall, [0, 0, 0, 0], [ha, hb, hb, ha]);
          }
        }
        while (nextLight < b.d) {
          if (covered && nextLight >= a.d && nextLight + 0.75 <= coverM[1]) {
            const section = d => {
              const t = (d - a.d) / (b.d - a.d);
              const left = between(a.left, b.left, t), right = between(a.right, b.right, t);
              return [between(left, right, 0.39), between(left, right, 0.61)];
            };
            const [la, ra] = section(nextLight);
            // 灯具短于站距，跨站时用下一站的实际断面。
            const end = Math.min(nextLight + 0.75, b.d);
            const [lb, rb] = section(end);
            const lower = clearance - plan.tunnelLightDepthM;
            solid(batch.light, colliders, 'tunnel-light', id, [la, lb, rb, ra], Array(4).fill(lower), Array(4).fill(clearance));
          }
          nextLight += 18;
        }
      } else {
        solid(batch.concrete, colliders, 'bridge-slab', id, footprint, Array(4).fill(-plan.bridgeSlabM), [0, 0, 0, 0], entry || exit, false);
        if (!entry && !exit) for (const [side, opposite] of [['left', 'right'], ['right', 'left']]) {
          solid(batch.concrete, colliders, 'elevated-barrier', id,
            [a[side], b[side], inset(b[side], b[opposite], sideAllowance), inset(a[side], a[opposite], sideAllowance)],
            [0, 0, 0, 0], Array(4).fill(0.95));
        }
        if (nextPier < b.d) {
          const center = between(a, b, (nextPier - a.d) / (b.d - a.d));
          const baseY = groundHeight?.(center.x, center.z);
          const rise = center.y - plan.bridgeSlabM - baseY;
          if (rise > 2 && pierAllowed(center.x, center.z, 1.2)) {
            const pier = [[-1.2, -1], [1.2, -1], [1.2, 1], [-1.2, 1]]
              .map(([x, z]) => ({ x: center.x + x, y: baseY, z: center.z + z }));
            solid(batch.concrete, colliders, 'elevated-pier', id, pier, [0, 0, 0, 0], Array(4).fill(rise));
          }
          nextPier += 42;
        }
      }
    }
    const surface = { id, heightSource: 'estimate', triangles: topTriangles, accessTriangles,
      modes: ['car'], driveSuccessors: [], structured: true };
    const road = { index, osmId: record.way, name: graph.names[link[2]], direction: link[5], layer: tunnel ? -1 : 1,
      width: widthM, lanes, laneSource: lanes && !link[4] ? 'municipal-design' : undefined,
      barrierWidthM: sideAllowance, frames, points: roadLinkPoints(graph, link),
      topTriangles, surfaceId: id, startNode: link[0], endNode: link[1], sharedStart, sharedEnd,
      startDeckY: first.y, endDeckY: last.y, tunnel, structured: true,
      stationOffsetM, lengthM: last.d, maxGrade: record.maxGrade };
    surfaces.push(surface);
    links.push(road);
    const parts = partsByRoute.get(route) ?? [];
    parts.push({ road, surface });
    partsByRoute.set(route, parts);
    if (tunnel) tunnelRoutes.set(id, { route, roofTriangles, cameraTriangles });
  }
  for (const parts of partsByRoute.values()) for (let i = 0; i < parts.length; i++) {
    const { surface, road } = parts[i];
    surface.driveSuccessors = [parts[i - 1]?.surface.id, parts[i + 1]?.surface.id].filter(Boolean);
    if (road.sharedStart || road.sharedEnd) surface.driveSuccessors.push('terrain');
    road.structureNeighbors = surface.driveSuccessors;
  }
  for (const [id, batch] of batches) {
    const route = new THREE.Group();
    route.name = id;
    for (const [name, triangles] of Object.entries(batch)) {
      const mesh = makeMesh(triangles, materials[name], name);
      if (mesh) route.add(mesh);
    }
    group.add(route);
  }
  scene.add(group);
  const heightAt = createSurfaceHeightAt(surfaces);
  const cameraFloorAt = createSurfaceHeightAt([...tunnelRoutes].map(([id, data]) => ({ id, triangles: data.cameraTriangles })));
  const roofAt = createSurfaceHeightAt([...tunnelRoutes].map(([id, data]) => ({ id, triangles: data.roofTriangles })));

  function constrainCamera(entity, position, look) {
    const id = entity._support?.surfaceId;
    const tunnel = tunnelRoutes.get(id);
    if (!tunnel) return;
    const adjacent = links.find(link => link.surfaceId === id)?.structureNeighbors ?? [];
    const candidates = [id, ...adjacent.filter(next => tunnelRoutes.get(next)?.route === tunnel.route)];
    const eye = { x: entity.position.x, y: entity.position.y + 1.52, z: entity.position.z };
    const safe = point => candidates.some(candidate => {
      const floor = cameraFloorAt(point.x, point.z, candidate);
      const roof = roofAt(point.x, point.z, candidate);
      return floor !== null && point.y > floor + 0.35 && (roof === null || point.y < roof - 0.65);
    });
    const steps = Math.min(80, Math.max(1, Math.ceil(Math.hypot(position.x - eye.x, position.y - eye.y, position.z - eye.z) / 0.25)));
    let accepted = eye;
    for (let i = 1; i <= steps; i++) {
      const sample = between(eye, position, i / steps);
      if (!safe(sample)) break;
      accepted = sample;
    }
    position.set(accepted.x, accepted.y, accepted.z);
    if (!safe(look)) look.set(eye.x + Math.sin(entity.heading) * 1.5, eye.y, eye.z + Math.cos(entity.heading) * 1.5);
  }

  return { group, links, surfaces, colliders, heightAt, constrainCamera,
    dispose() {
      group.removeFromParent();
      group.traverse(node => node.geometry?.dispose());
      for (const material of Object.values(materials)) material.dispose();
    } };
}
