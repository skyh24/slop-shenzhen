import * as THREE from 'three/webgpu';
import { attribute, color } from 'three/tsl';
import { createRoadPolygonLayout } from './sz-roads.js';
import { createSurfaceHeightAt } from './sz-controller-surfaces.js';
import { createSzWaterMaterial } from './sz-water-material.js';
import { addFlatPolygon, GeoBuilder } from './sz-geometry.js';
import { sceneUniforms } from './sz-materials.js';
import { polygonBoxOverlaps } from './building-collision.js';

export const TALENT_WALK_ID = 'talent-park:waterfront';
const UP = new THREE.Vector3(0, 1, 0);
const rowsToPoints = rows => rows.map(([x, z]) => ({ x, z }));
const bounds = points => ({ minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
  minZ: Math.min(...points.map(p => p.z)), maxZ: Math.max(...points.map(p => p.z)) });
const inBounds = (b, x, z, r = 0) => x >= b.minX - r && x <= b.maxX + r && z >= b.minZ - r && z <= b.maxZ + r;
const segmentLength = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const lerp = (a, b, t) => a + (b - a) * t;
const pointOn = (a, b, t) => ({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });

export function createWaterfrontLine(points) {
  const segments = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], size = segmentLength(a, b);
    if (size < 0.01) continue;
    segments.push({ a, b, start: length, size, dx: (b.x - a.x) / size, dz: (b.z - a.z) / size });
    length += size;
  }
  const center = s => {
    s = Math.max(0, Math.min(length, s));
    const e = segments.find(row => s <= row.start + row.size) ?? segments.at(-1);
    return { ...pointOn(e.a, e.b, (s - e.start) / e.size), e };
  };
  function at(s, offset = 0) {
    const p = center(s), a = center(s - 0.7), b = center(s + 0.7);
    const size = segmentLength(a, b);
    const dx = size > 0.01 ? (b.x - a.x) / size : p.e.dx;
    const dz = size > 0.01 ? (b.z - a.z) / size : p.e.dz;
    return { x: p.x + dz * offset, z: p.z - dx * offset, dx, dz };
  }
  function nearest(x, z) {
    let best = null;
    for (const e of segments) {
      const m = Math.max(0, Math.min(e.size, (x - e.a.x) * e.dx + (z - e.a.z) * e.dz));
      const distance = Math.hypot(x - e.a.x - e.dx * m, z - e.a.z - e.dz * m);
      if (!best || distance < best.distance) best = { distance, s: e.start + m };
    }
    return best;
  }
  return { length, at, nearest, segments };
}

function makeAggregate() {
  // 固定噪声分为石粒和砂浆，颜色与凹凸共用粒形；GPU mip 负责远景收敛。
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  const relief = new Uint8Array(data.length);
  const hash = (x, y) => {
    const n = Math.sin(x * 51.17 + y * 19.83) * 32711.27;
    return n - Math.floor(n);
  };
  const mod = x => (x + 24) % 24;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / 4, v = j / 4;
    const ix = Math.floor(u), iz = Math.floor(v);
    let near = Infinity, tone = 0;
    for (let a = ix - 1; a <= ix + 1; a++) for (let b = iz - 1; b <= iz + 1; b++) {
      const x = a + hash(mod(a), mod(b)), z = b + hash(mod(a) + 2, mod(b) - 7);
      const d = Math.hypot(u - x, v - z);
      if (d < near) { near = d; tone = hash(mod(a) + 7, mod(b) + 2); }
    }
    const stone = near < 0.43;
    const k = (j * size + i) * 4;
    const light = stone ? 130 + tone * 103 : 88 + hash(i, j) * 21;
    data.set([light, light * 0.94, light * 0.84, 255], k);
    const h = stone ? 80 + 170 * (1 - near / 0.43) : 15;
    relief.set([h, h, h, 255], k);
  }
  return [data, relief].map((array, i) => {
    const map = new THREE.DataTexture(array, size, size);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = i ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.needsUpdate = true;
    return map;
  });
}

function groundMesh(group, triangles, material, name) {
  if (!triangles.length) return;
  const values = [], uv = [];
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    const cross = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    for (const p of cross > 0 ? triangle : [a, c, b]) {
      values.push(p.x, p.y, p.z);
      uv.push(p.x / 0.85, p.z / 0.85);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function boxCorners(x, z, length, width, dx, dz) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
    ({ x: x + a * length / 2 * dx + b * width / 2 * dz, z: z + a * length / 2 * dz - b * width / 2 * dx }));
}

function boxBatch(group, material, items, name) {
  if (!items.length) return;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
  mesh.name = name;
  const pose = new THREE.Object3D();
  for (const [i, row] of items.entries()) {
    const { a, b, width, height } = row;
    pose.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    if (segmentLength(a, b) < 0.001) {
      pose.scale.set(width, Math.abs(b.y - a.y), height);
      pose.quaternion.identity();
    } else {
      const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
      const right = new THREE.Vector3().crossVectors(UP, dir).normalize();
      const length = dir.length();
      dir.normalize();
      pose.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,
        new THREE.Vector3().crossVectors(dir, right), dir));
      pose.scale.set(width, height, length);
    }
    pose.updateMatrix();
    mesh.setMatrixAt(i, pose.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function buildTalentWaterfront(scene, source, lake, site) {
  if (!source || !lake) return null;
  const group = new THREE.Group();
  group.name = TALENT_WALK_ID;
  const { groundHeight, terrainSurface, isWater } = site;
  const colliders = [], surfaces = [];
  const map = makeAggregate();
  const terrainMaterial = new Map(Object.entries({ greenway: 0x477987, promenade: 0x9c9888,
    gravel: 0xd8ccbd, steps: 0x888173 }).map(([kind, tint]) => {
    const material = new THREE.MeshStandardNodeMaterial({ color: tint, roughness: 0.94,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      ...(kind === 'gravel' ? { map: map[0], bumpMap: map[1], bumpScale: 0.019 } : {}) });
    material.emissiveNode = color(tint).mul(sceneUniforms.night).mul(kind === 'greenway' ? 0.16 : 0.11);
    if (kind !== 'steps') material.emissiveNode = material.emissiveNode.add(
      color(0xffca8a).mul(sceneUniforms.night).mul(attribute('lanternFalloff', 'float')).mul(0.24));
    return [kind, material];
  }));
  for (const surface of source.surfaces) {
    const id = `${TALENT_WALK_ID}:${surface.material}`;
    const { chunks } = createRoadPolygonLayout({ id, trianglesXZ: surface.trianglesXZ }, terrainSurface);
    const triangles = chunks.flatMap(({ origin, positions }) => {
      const rows = [];
      for (let i = 0; i < positions.length; i += 9) rows.push([i, i + 3, i + 6].map(j =>
        ({ x: Math.fround(positions[j] + origin[0]), y: positions[j + 1], z: Math.fround(positions[j + 2] + origin[1]) })));
      return rows;
    });
    surfaces.push({ id, triangles, heightSource: 'terrain', climbableFromGround: true });
    groundMesh(group, triangles, terrainMaterial.get(surface.material), id);
  }
  const walkHeight = createSurfaceHeightAt(surfaces);
  const pathHeightAt = (x, z) => {
    for (const row of surfaces) {
      const y = walkHeight(x, z, row.id);
      if (Number.isFinite(y)) return y;
    }
    return null;
  };

  const stepRoute = source.entrances.find(row => row.kind === 'steps');
  const [start, end] = rowsToPoints(stepRoute.points);
  const stepLength = segmentLength(start, end);
  const dx = (end.x - start.x) / stepLength, dz = (end.z - start.z) / stepLength;
  const width = stepRoute.widthM;
  const risers = [];
  const stepSurfaces = [];
  const stepCount = 12;
  for (let i = 0; i < stepCount; i++) {
    const p = pointOn(start, end, (i + 0.5) / stepCount);
    const corners = boxCorners(p.x, p.z, stepLength / stepCount, width, dx, dz);
    const ground = corners.map(c => groundHeight(c.x, c.z));
    const top = Math.fround(Math.max(...ground) + 0.025);
    const bottom = Math.min(...ground) - 0.06;
    const id = `${TALENT_WALK_ID}:tread:${i}`;
    const [a, b, c, d] = corners.map(corner => ({ ...corner, y: top }));
    const triangles = [[a, b, c], [a, c, d]];
    stepSurfaces.push({ id, triangles, heightSource: 'terrain-derived-estimate', climbableFromGround: true });
    // 实际标绘的是台阶，宽和踏高从附近可见地形推导；每块顶面与可站立三角面同源。
    risers.push({ a: { ...p, y: bottom }, b: { ...p, y: top }, width: stepLength / stepCount, height: width, dx, dz, top });
  }
  const treads = new THREE.InstancedMesh(new THREE.BoxGeometry(), terrainMaterial.get('steps'), risers.length);
  treads.name = `${TALENT_WALK_ID}:steps`;
  const pose = new THREE.Object3D();
  for (const [i, row] of risers.entries()) {
    pose.position.set(row.a.x, (row.a.y + row.b.y) / 2, row.a.z);
    pose.rotation.y = Math.atan2(-row.dz, row.dx);
    pose.scale.set(row.width, row.b.y - row.a.y, row.height);
    pose.updateMatrix();
    treads.setMatrixAt(i, pose.matrix);
  }
  treads.instanceMatrix.needsUpdate = true;
  treads.computeBoundingSphere();
  treads.receiveShadow = true;
  group.add(treads);

  const route = createWaterfrontLine(rowsToPoints(source.route.flatMap((row, i) => i ? row.points.slice(1) : row.points)));
  const extent = bounds(route.segments.flatMap(({ a, b }) => [a, b]));
  const [vx, vz] = source.view;
  const { x: ax, y: ay, z: az } = source.simulation.airspaceCenter;
  const arrival = { x: vx, z: vz, y: pathHeightAt(vx, vz), heading: Math.atan2(ax - vx, az - vz),
    surfaceId: `${TALENT_WALK_ID}:gravel` };
  const edge = createWaterfrontLine(rowsToPoints(source.retainingEdge));
  const steel = [], wall = [], timber = [], lamps = [], pilotTrees = [];
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0x777669, roughness: 0.96 });
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x506169, roughness: 0.66, metalness: 0.21 });
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x855e40, roughness: 0.81 });
  const lamp = new THREE.MeshStandardNodeMaterial({ color: 0xc7b390, roughness: 0.49 });
  lamp.emissiveNode = color(0xffcf91).mul(sceneUniforms.night).mul(1.65);

  function obstacle(name, x, z, length, width, dx, dz, minY, maxY) {
    const outer = boxCorners(x, z, length, width, dx, dz);
    colliders.push({ name, type: 'building', ...bounds(outer), minY, maxY, polygon: { outer, holes: [] } });
  }
  function rail(a, b, index) {
    const size = segmentLength(a, b);
    if (size < 0.01) return;
    const center = pointOn(a, b, 0.5);
    const floor = Math.min(a.y, b.y), top = Math.max(a.y, b.y) + 1.18;
    obstacle(`${TALENT_WALK_ID}:rail:${index}`, center.x, center.z, size + 0.12, 0.18,
      (b.x - a.x) / size, (b.z - a.z) / size, Math.min(floor, source.simulation.lakeHeightM), top);
    for (const h of [0.21, 0.63, 1.13]) steel.push({ a: { ...a, y: a.y + h }, b: { ...b, y: b.y + h },
      width: h > 1 ? 0.13 : 0.05, height: h > 1 ? 0.10 : 0.05 });
    // 岸石只沿同一段防护边缘；其余岸坡保持源地形，不做整湖护栏。
    if (floor > source.simulation.lakeHeightM + 0.15) {
      const base = source.simulation.lakeHeightM - 0.25;
      const height = Math.min(0.82, floor - base);
      wall.push({ a: { ...a, y: a.y - height / 2 }, b: { ...b, y: b.y - height / 2 }, width: 0.18, height });
    }
  }
  let postIndex = 0;
  for (const s of edge.segments) {
    const count = Math.ceil(s.size / 2.45);
    for (let i = 0; i < count; i++) {
      const a = pointOn(s.a, s.b, i / count), b = pointOn(s.a, s.b, (i + 1) / count);
      a.y = groundHeight(a.x, a.z); b.y = groundHeight(b.x, b.z);
      if (![a.y, b.y].every(Number.isFinite)) continue;
      rail(a, b, postIndex++);
      steel.push({ a: { ...a, y: a.y - 0.08 }, b: { ...a, y: a.y + 1.19 }, width: 0.11, height: 0.11 });
    }
  }
  const lastPost = edge.at(edge.length);
  const lastY = groundHeight(lastPost.x, lastPost.z);
  if (Number.isFinite(lastY)) steel.push({ a: { ...lastPost, y: lastY - 0.08 },
    b: { ...lastPost, y: lastY + 1.19 }, width: 0.11, height: 0.11 });

  const viewS = route.nearest(vx, vz).s;
  const pathAt = (x, z) => inBounds(extent, x, z, 25) && (pathHeightAt(x, z) !== null
    || stepSurfaces.some(row => row.triangles.some(t => inBounds(bounds(t), x, z, 0.15))))
    ? [TALENT_WALK_ID] : [];
  const closeToSight = (x, z, radius) => {
    const towardX = Math.sin(arrival.heading), towardZ = Math.cos(arrival.heading);
    const rx = x - vx, rz = z - vz;
    const forward = rx * towardX + rz * towardZ;
    return forward > -radius && forward < 37 + radius
      && Math.abs(rx * towardZ - rz * towardX) < 5 + forward * 0.39 + radius;
  };
  function fixtureAt(s, side) {
    const p = route.at(s, side);
    if (isWater(p.x, p.z) !== false || site.roadHeight(p.x, p.z) !== null
      || pathAt(p.x, p.z).length || closeToSight(p.x, p.z, 1.8)) return null;
    const y = groundHeight(p.x, p.z);
    if (!Number.isFinite(y) || site.colliders.some(c => inBounds(c, p.x, p.z, 1.3)
        && c.minY < y + 5 && c.maxY > y && polygonBoxOverlaps(c.polygon, p.x, p.z, 1.3, 1.3))) return null;
    return { ...p, y };
  }
  for (let s = 13, i = 0; s < route.length - 6; s += 17, i++) {
    if (i % 3 !== 1) {
      const p = fixtureAt(s, s > viewS - 12 && s < viewS + 12 ? -6.7 : -3.6);
      if (!p) continue;
      const a = { ...p, y: p.y - 0.09 }, b = { ...p, y: p.y + 3.5 };
      steel.push({ a, b, width: 0.14, height: 0.14 });
      lamps.push({ a: { ...p, y: b.y - 0.18 }, b, width: 0.32, height: 0.32 });
      obstacle(`${TALENT_WALK_ID}:lamp:${i}`, p.x, p.z, 0.15, 0.15, p.dx, p.dz, p.y - 0.1, b.y);
    } else {
      const p = fixtureAt(s, s > viewS - 12 && s < viewS + 12 ? -6.7 : -3.5);
      if (!p) continue;
      const seatEnds = h => [-1, 1].map(v => ({ x: p.x + v * p.dx * 0.94,
        y: p.y + h, z: p.z + v * p.dz * 0.94 }));
      const [a, b] = seatEnds(0.47);
      timber.push({ a, b, width: 0.5, height: 0.12 });
      const [backA, backB] = seatEnds(0.75).map(q => ({ ...q, x: q.x - p.dz * 0.22, z: q.z + p.dx * 0.22 }));
      timber.push({ a: backA, b: backB, width: 0.085, height: 0.39 });
      for (const end of seatEnds(0)) steel.push({ a: { ...end, y: p.y - 0.09 },
        b: { ...end, y: p.y + 0.46 }, width: 0.1, height: 0.32 });
      obstacle(`${TALENT_WALK_ID}:bench:${i}`, p.x, p.z, 2.05, 0.56, p.dx, p.dz, p.y - 0.1, p.y + 0.96);
    }
    if (i % 3 === 0) {
      const tree = fixtureAt(s + 6, -6.3);
      if (tree) pilotTrees.push({ id: `${TALENT_WALK_ID}:tree:${i}`, x: tree.x, z: tree.z,
        crown: 4.5 + i % 3, height: 5.9 + i % 4, speciesName: 'camphor' });
    }
  }
  // 将灯下的暖色光斑烘焙到已存在的铺装顶点，夜间显示，不增加场景点光源。
  for (const mesh of group.children) {
    if (!surfaces.some(surface => surface.id === mesh.name)) continue;
    const positions = mesh.geometry.attributes.position;
    const values = new Float32Array(positions.count);
    for (let i = 0; i < values.length; i++) {
      const x = positions.getX(i), z = positions.getZ(i);
      const distance = Math.min(...lamps.map(({ a }) => Math.hypot(x - a.x, z - a.z)));
      values[i] = Math.max(0, 1 - distance / 6.5) ** 2;
    }
    mesh.geometry.setAttribute('lanternFalloff', new THREE.BufferAttribute(values, 1));
  }
  boxBatch(group, stone, wall, 'talent-park:shore-stone');
  boxBatch(group, metal, steel, 'talent-park:edge-and-fixtures');
  boxBatch(group, wood, timber, 'talent-park:seating');
  boxBatch(group, lamp, lamps, 'talent-park:lanterns');

  const lakeBatch = new GeoBuilder();
  addFlatPolygon(lakeBatch, [lake.outer, ...lake.holes].map(ring => ring.flatMap(p => [p.x, p.z])),
    source.simulation.lakeHeightM);
  const water = new THREE.Mesh(lakeBatch.build(), createSzWaterMaterial({ coastal: false, cityReflection: false }));
  water.name = 'talent-park:inner-lake';
  group.add(water);
  scene.add(group);

  function reserves(x, z, radius = 0) {
    if (!inBounds(extent, x, z, radius + 40)) return false;
    return route.nearest(x, z).distance < 2.45 + radius || Math.hypot(x - vx, z - vz) < 5.9 + radius
      || pathAt(x, z).length > 0 || closeToSight(x, z, radius);
  }
  return { group, colliders, surfaces: [...surfaces, ...stepSurfaces], arrival, route, pathHeightAt, pathAt,
    pilotTrees, reserves, extent, viewS, airspace: { x: ax, y: ay, z: az, heading: arrival.heading },
    statistics: { lengthM: source.lengthM, lakeWaterIndex: source.lakeWaterIndex, steps: stepCount,
      railLengthM: edge.length, lanterns: lamps.length, benches: timber.length / 2, sourceNode: source.viewNode } };
}
