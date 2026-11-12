import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { abs, color, fract, positionWorld, smoothstep } from 'three/tsl';
import { GeoBuilder, addFlatPolygon } from './sz-geometry.js';
import { distanceToRing, polygonContainsInclusive } from './sz-polygon.js';
import { triangleHeight } from './sz-controller-surfaces.js';

export const LIANHUASHAN_PLATFORM = 'lianhuashan-summit';
// 铜像与观景点分别取锁定 OSM node/1722037599、node/2750494256。
const STATUE = { x: -18.01, z: -1068.40 };
const ARRIVAL = { x: -20, z: -1031, heading: -0.037 };
const PARK_ID = 'way/41281446';

// 山顶南北铺装取 OSM way/269925476、way/269925473，间段按 way/269925485
// 与铜像坐标估计为一体前场；厘米小数是投影结果，不能解释为测绘精度。
const ring = [
  [-49.30, -1061.73], [-43.49, -1057.94], [-38, -1054.47], [-38, -1084], [-33.97, -1084],
  [-34.06, -1091.43], [-38.48, -1091.31], [-38.55, -1095.81], [-22.26, -1095.96], [1.53, -1096.3],
  [1.57, -1091.95], [-2.68, -1091.96], [-2.55, -1082.52], [-8, -1082.46], [-8, -1049.3],
  [-2.01, -1051.93], [6.1, -1058.89], [12.07, -1064], [12.96, -1055.31], [12.35, -1050.09],
  [10.73, -1044.64], [7.60, -1038.79], [4.58, -1034.99], [-0.38, -1030.70], [-5.55, -1027.77],
  [-12.79, -1025.54], [-21.47, -1025.18], [-27.84, -1026.47], [-34.19, -1029.26], [-38, -1031.85],
  [-42.62, -1036.37], [-45.64, -1040.72], [-47.66, -1044.92], [-49.19, -1050.10], [-49.79, -1056.84]
].map(([x, z]) => ({ x, z }));
const plaza = { outer: ring, holes: [] };

// 莲花西径现有台阶源线的末段，宽度和最后接入广场的踏步为估计。
const westPath = [[-65.89, -1047.29], [-57.50, -1060.18], [-49.79, -1056.84]];

export function summitBuildingOverrides(buildings, parks) {
  const boundary = parks.find(park => park.id === 'lianhuashan')?.areas.find(area => area.osmId === PARK_ID)?.polygon;
  if (!boundary) return new Set();
  const xs = boundary.outer.map(p => p.x), zs = boundary.outer.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return new Set(buildings.filter(building =>
    building.minX >= minX && building.maxX <= maxX && building.minZ >= minZ && building.maxZ <= maxZ
    && polygonContainsInclusive(boundary, building.cx, building.cz)
    && building.polygons.every(polygon => polygon.outer.every((p, i, points) => {
      const q = points[(i + 1) % points.length];
      return polygonContainsInclusive(boundary, p.x, p.z)
        && polygonContainsInclusive(boundary, (p.x + q.x) / 2, (p.z + q.z) / 2);
    }))).map(building => building.id));
}

function addTopTriangle(builder, points) {
  const ids = points.map(p => builder.vertex(p.x, p.y, p.z, 0, 1, 0, p.x, p.z));
  const [a, b, c] = points;
  if ((b.z - a.z) * (c.x - a.x) < (b.x - a.x) * (c.z - a.z)) ids.reverse();
  builder.tri(...ids);
}

function retainingWall(builder, a, b, bottomA, bottomB, y) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const nx = (a.z - b.z) / length, nz = (b.x - a.x) / length;
  const first = builder.vertex(a.x, bottomA, a.z, nx, 0, nz, 0, 0);
  builder.vertex(b.x, bottomB, b.z, nx, 0, nz, length, 0);
  builder.vertex(b.x, y, b.z, nx, 0, nz, length, 1);
  builder.vertex(a.x, y, a.z, nx, 0, nz, 0, 1);
  builder.tri(first, first + 2, first + 1);
  builder.tri(first, first + 3, first + 2);
}

function extractTriangles(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const point = i => ({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
  return Array.from({ length: index.count / 3 }, (_, i) => [0, 1, 2].map(j => point(index.getX(i * 3 + j))));
}

function collider(name, points, minY, maxY) {
  return { name, type: 'summit-fixture', polygon: { outer: points, holes: [] },
    minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
    minZ: Math.min(...points.map(p => p.z)), maxZ: Math.max(...points.map(p => p.z)),
    minY, maxY, heightSource: 'estimate' };
}

function statue(group, y, colliders) {
  const granite = new THREE.MeshStandardMaterial({ color: 0x4e4950, roughness: 0.81 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x625547, metalness: 0.48, roughness: 0.53 });
  const stone = (w, h, d, lift) => {
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), granite);
    block.position.set(STATUE.x, y + lift + h / 2, STATUE.z);
    group.add(block);
    colliders.push(collider('deng-statue-pedestal', [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) =>
      ({ x: STATUE.x + x * w / 2, z: STATUE.z + z * d / 2 })), y + lift, y + lift + h));
  };
  stone(5.5, 0.25, 4.4, 0);
  stone(4.5, 2.35, 3.4, 0.25);
  stone(4.7, 0.22, 3.6, 2.60);
  const body = new THREE.Group();
  body.position.set(STATUE.x, y + 2.82, STATUE.z);
  body.rotation.y = ARRIVAL.heading;
  group.add(body);
  const ellipsoid = new THREE.SphereGeometry(1, 16, 12);
  const lump = (x, height, z, sx, sy, sz) => {
    const mesh = new THREE.Mesh(ellipsoid, bronze);
    mesh.position.set(x, height, z);
    mesh.scale.set(sx, sy, sz);
    body.add(mesh);
    return mesh;
  };
  const limb = (a, b, r0, r1) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const axis = to.clone().sub(from);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, axis.length(), 12), bronze);
    mesh.position.copy(from.addScaledVector(axis, 0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    body.add(mesh);
  };
  // 参照铜像迈步的剪影：两腿错步，衣摆分片，两手自然前后错开。
  lump(-0.37, 0.23, 0.92, 0.30, 0.23, 0.56);
  lump(0.40, 0.24, -0.67, 0.28, 0.24, 0.53);
  limb([-0.35, 0.37, 0.68], [-0.41, 1.50, 0.47], 0.22, 0.32);
  limb([-0.41, 1.42, 0.47], [-0.36, 2.80, 0.00], 0.31, 0.43);
  limb([0.40, 0.40, -0.70], [0.44, 1.45, -0.49], 0.22, 0.31);
  limb([0.44, 1.41, -0.49], [0.42, 2.81, -0.11], 0.30, 0.43);
  // 以连贯的大衣体块包住肩、髋与膝上裤管，避免圆关节切断衣着剪影。
  const coat = new THREE.Mesh(new THREE.LatheGeometry([
    [0, 2.05], [0.77, 2.05], [0.84, 2.34], [0.79, 3.22], [0.94, 3.98],
    [0.91, 4.25], [0.74, 4.48], [0.37, 4.57], [0, 4.57]
  ].map(p => new THREE.Vector2(...p)), 24), bronze);
  coat.scale.z = 0.61;
  body.add(coat);
  lump(0, 4.58, 0.10, 0.33, 0.33, 0.33);
  lump(0, 5.27, 0.14, 0.43, 0.73, 0.43);
  lump(0, 5.12, 0.47, 0.25, 0.32, 0.17);
  lump(-0.45, 5.18, 0.13, 0.10, 0.17, 0.12);
  lump(0.45, 5.18, 0.13, 0.10, 0.17, 0.12);
  lump(-0.76, 4.10, 0.02, 0.34, 0.35, 0.36);
  lump(0.76, 4.09, 0.06, 0.34, 0.35, 0.36);
  limb([-0.74, 4.17, 0.02], [-1.07, 3.30, -0.30], 0.31, 0.24);
  limb([-1.07, 3.34, -0.29], [-1.04, 2.66, -0.55], 0.25, 0.16);
  limb([0.74, 4.14, 0.06], [1.12, 3.31, 0.34], 0.31, 0.25);
  limb([1.11, 3.36, 0.32], [1.01, 2.79, 0.71], 0.25, 0.17);
  lump(-1.04, 2.58, -0.57, 0.17, 0.22, 0.17);
  lump(1.01, 2.71, 0.73, 0.18, 0.22, 0.18);
  lump(0.28, 4.22, 0.48, 0.13, 0.37, 0.08).rotation.z = 0.40;
  lump(-0.22, 4.19, 0.48, 0.13, 0.37, 0.08).rotation.z = -0.40;
  for (const height of [2.67, 3.00, 3.35, 3.70]) lump(0.05, height, 0.54, 0.065, 0.07, 0.036);
  const parts = body.children.map(mesh => {
    mesh.updateMatrix();
    return mesh.geometry.clone().applyMatrix4(mesh.matrix);
  });
  const figure = new THREE.Mesh(mergeGeometries(parts), bronze);
  figure.castShadow = true;
  for (const part of parts) part.dispose();
  const inputs = new Set(body.children.map(mesh => mesh.geometry));
  for (const geometry of inputs) geometry.dispose();
  body.clear();
  body.add(figure);
}

export function buildLianhuashanSummit(scene, groundHeight) {
  // 平台高程贴近当前表面包的山顶台基，不改山体数据。量化后让显示与接触共用精确顶高。
  const y = Math.fround(Math.max(...ring.map(p => groundHeight(p.x, p.z)), groundHeight(STATUE.x, STATUE.z)) + 0.12);
  if (!Number.isFinite(y)) throw new Error('Summit terrain is unavailable');
  const group = new THREE.Group();
  group.name = LIANHUASHAN_PLATFORM;
  const colliders = [];
  const tops = new GeoBuilder();
  addFlatPolygon(tops, [ring.flatMap(p => [p.x, p.z])], y);
  const platformGeometry = tops.build();
  const platformTriangleCount = platformGeometry.index.count / 3;
  platformGeometry.dispose();
  const walls = new GeoBuilder();
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    retainingWall(walls, a, b, Math.min(y, groundHeight(a.x, a.z) - 0.18),
      Math.min(y, groundHeight(b.x, b.z) - 0.18), y);
  }

  const approach = westPath.map(([x, z], i) => ({ x, z, y: i === 2 ? y - 0.12 : groundHeight(x, z) + 0.06 }));
  for (let i = 0; i < approach.length - 1; i++) {
    const a = approach[i], b = approach[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const rise = b.y - a.y;
    const divisions = Math.max(1, Math.ceil(Math.abs(rise) / 0.16));
    const side = { x: (b.z - a.z) / length * 1.15, z: (a.x - b.x) / length * 1.15 };
    const at = (t, sign, y) => ({ x: a.x + (b.x - a.x) * t + side.x * sign, z: a.z + (b.z - a.z) * t + side.z * sign, y });
    let previous = a.y;
    for (let j = 0; j < divisions; j++) {
      const start = j / divisions, end = (j + 1) / divisions;
      const ground = [start, (start + end) / 2, end].flatMap(t => [-1, 0, 1].map(sign => {
        const p = at(t, sign, 0);
        return groundHeight(p.x, p.z);
      }));
      // 中间地形不保证沿两端线性变化；踏面取横断面最高点，避免埋进原地形。
      const height = Math.max(a.y + rise * start, ...ground.map(sample => sample + 0.04));
      const p = at(start, -1, height), q = at(start, 1, height);
      const r = at(end, 1, height), s = at(end, -1, height);
      addTopTriangle(tops, [p, q, r]);
      addTopTriangle(tops, [p, r, s]);
      if (Math.abs(height - previous) > 0.001) {
        retainingWall(walls, p, q, Math.min(height, previous), Math.min(height, previous), Math.max(height, previous));
      }
      previous = height;
    }
  }
  const geometry = tops.build();
  const triangles = extractTriangles(geometry);
  const tile = new THREE.MeshStandardNodeMaterial({ roughness: 0.87 });
  const seam = value => smoothstep(0.465, 0.5, abs(fract(value.mul(0.57)).sub(0.5)));
  tile.colorNode = color(0x827c76).mul(seam(positionWorld.x).max(seam(positionWorld.z)).mul(-0.17).add(1));
  const floor = new THREE.Mesh(geometry, tile);
  floor.receiveShadow = true;
  group.add(floor, new THREE.Mesh(walls.build(), new THREE.MeshStandardMaterial({ color: 0x6f6860, side: THREE.DoubleSide })));

  const railMaterial = new THREE.MeshStandardMaterial({ color: 0x807b74, metalness: 0.25, roughness: 0.56 });
  const railBox = new THREE.BoxGeometry(1, 1, 1);
  const railParts = [];
  for (let i = 21; i < 31; i++) {
    const a = ring[i], b = ring[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const rail = new THREE.Mesh(railBox, railMaterial);
    rail.scale.set(length, 0.15, 0.24);
    rail.rotation.y = -Math.atan2(dz, dx);
    rail.position.set((a.x + b.x) / 2, y + 1.05, (a.z + b.z) / 2);
    railParts.push(rail);
    const nx = dz / length * 0.12, nz = -dx / length * 0.12;
    colliders.push(collider('summit-railing', [
      { x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz },
      { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }
    ], y + 0.98, y + 1.12));
    for (let k = 0; k < Math.ceil(length / 2); k++) {
      const t = k / Math.ceil(length / 2);
      const x = a.x + dx * t, z = a.z + dz * t;
      const post = new THREE.Mesh(railBox, railMaterial);
      post.scale.set(0.18, 1.05, 0.18);
      post.position.set(x, y + 0.525, z);
      railParts.push(post);
      colliders.push(collider('summit-rail-post', [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([px, pz]) =>
        ({ x: x + px * 0.09, z: z + pz * 0.09 })), y, y + 1.05));
    }
  }
  const railing = new THREE.InstancedMesh(railBox, railMaterial, railParts.length);
  railParts.forEach((part, i) => { part.updateMatrix(); railing.setMatrixAt(i, part.matrix); });
  railing.computeBoundingSphere();
  group.add(railing);
  statue(group, y, colliders);
  scene.add(group);
  const pathAt = (x, z) => x >= -69 && x <= 15 && z >= -1099 && z <= -1023
    && (polygonContainsInclusive(plaza, x, z) || distanceToRing(ring, x, z) < 1.7
      || triangles.some(triangle => triangleHeight(triangle, x, z) !== null));
  // 只整理模拟树，保留实际树点；南向很短的视线通道避免树冠盖住观演画面。
  const simulatedTreeAllowed = (x, z) => !(x > -31 && x < -7 && z > -1028 && z < -990);
  return { group, pathAt, simulatedTreeAllowed, colliders,
    surfaces: [{ id: LIANHUASHAN_PLATFORM, heightSource: 'estimate', climbableFromGround: true,
      triangles: triangles.slice(0, platformTriangleCount) },
    ...triangles.slice(platformTriangleCount).filter((_, i) => i % 2 === 0).map((triangle, i) => ({
      id: `${LIANHUASHAN_PLATFORM}:step:${i}`, heightSource: 'estimate', climbableFromGround: true,
      triangles: [triangle, triangles[platformTriangleCount + i * 2 + 1]]
    }))],
    arrival: { ...ARRIVAL, y, surfaceId: LIANHUASHAN_PLATFORM }
  };
}
