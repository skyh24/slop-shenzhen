// 香蜜湖一期外部空间。公共模拟只覆盖红荔西路市政路侧；会场前场及规划园路不接入行人网络。
import * as THREE from 'three/webgpu';
import { color, fract, mix, smoothstep, time, uv } from 'three/tsl';
import { polygonContains } from '../building-collision.js';
import { createPavingMaterial, pavingMesh } from '../sz-paving.js';
import { GeoBuilder } from '../sz-geometry.js';
import { createRoadHeightSampler, createRoadPolygonLayout } from '../sz-roads.js';
import { buildSzSea } from '../sz-sea.js';
import { terrainHeight } from '../sz-terrain.js';
import { createIecMaterial, entry, entryPoint, siteId } from './iec-xiangmihu.js';

const prefix = siteId + ':';
const coordinates = pairs => pairs.map(([x, z]) => ({ x, z }));

function stripRing(points, halfWidth) {
  const offset = side => points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: p.x - side * halfWidth * (b.z - a.z) / length,
      z: p.z + side * halfWidth * (b.x - a.x) / length };
  });
  return [...offset(1), ...offset(-1).reverse()];
}

function ellipse(x, z, rx, rz) {
  return Array.from({ length: 32 }, (_, i) => {
    const angle = 2 * Math.PI * i / 32;
    return { x: x + rx * Math.cos(angle), z: z + rz * Math.sin(angle) };
  });
}

function roundedBed(pairs) {
  const ring = coordinates(pairs);
  return ring.flatMap((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return [0.2, 0.8].map(t => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }));
  });
}

function drawGround(group, terrain, id, sourceIds, ring, material, exclusionChunks) {
  const projected = ring.map(({ x, z }) => new THREE.Vector2(x, z));
  const trianglesXZ = THREE.ShapeUtils.triangulateShape(projected, [])
    .flatMap(indices => indices.flatMap(i => [ring[i].x, ring[i].z]));
  const layout = createRoadPolygonLayout({ id, sourceIds, trianglesXZ }, terrain, null, exclusionChunks);
  for (const chunk of layout.chunks) group.add(pavingMesh(chunk.positions, chunk.origin, material, chunk.id));
  return createRoadHeightSampler(layout.chunks, terrain.grid);
}

// 相对半径、落水范围和水柱高度为场景设计。喷头落在原圆池内，材质上的流光沿水柱移动。
function drawFountain(group, shore, waterY, material) {
  const center = shore.outer.reduce((p, q) => ({ x: p.x + q.x / shore.outer.length,
    z: p.z + q.z / shore.outer.length }), { x: 0, z: 0 });
  const batch = new GeoBuilder();
  const addJet = (angle, from, to, arc, rise, radius) => {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const steps = 24, sides = 6, start = batch.count;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, r = from + (to - from) * t;
      const y = waterY + 4 * arc * t * (1 - t) + rise * t - 0.06;
      const slope = 4 * arc * (1 - 2 * t) + rise;
      const length = Math.hypot(to - from, slope);
      for (let j = 0; j < sides; j++) {
        const phase = j * 2 * Math.PI / sides;
        const u = Math.cos(phase), v = Math.sin(phase);
        const nx = dz * u + dx * v * slope / length;
        const nz = -dx * u + dz * v * slope / length;
        const ny = -v * (to - from) / length;
        batch.vertex(center.x + dx * r + nx * radius, y + ny * radius, center.z + dz * r + nz * radius,
          nx, ny, nz, j / sides, t);
        if (i === 0) continue;
        const a = start + (i - 1) * sides + j;
        const b = start + (i - 1) * sides + (j + 1) % sides;
        batch.tri(a, b, a + sides);
        batch.tri(b, b + sides, a + sides);
      }
    }
  };
  addJet(0, 0, 0.18, 0, 5.6, 0.19);
  for (let i = 0; i < 12; i++) addJet(i * Math.PI / 6, 2.6, 8.2, 2.6, 0, 0.095);
  const mesh = new THREE.Mesh(batch.build(), material);
  mesh.name = prefix + 'fountain-jets';
  group.add(mesh);
}

function plantFlowers(group, beds, material) {
  const positions = [];
  // 固定格点错列，花色和株高按株号确定，整片花圃各用一次实例绘制。
  for (const [cx, cz, rx, rz, colors, heightAt] of beds) {
    for (let row = -Math.floor(rz / 0.62); row <= Math.floor(rz / 0.62); row++) {
      for (let col = -Math.floor(rx / 0.62); col <= Math.floor(rx / 0.62); col++) {
        const u = (col + 0.28 * Math.sin(row * 4.9)) * 0.62, v = row * 0.62;
        if ((u / rx) ** 2 + (v / rz) ** 2 > 0.94) continue;
        const x = cx + u, z = cz + v, y = heightAt(x, z);
        if (!Number.isFinite(y)) continue;
        const t = 0.5 + 0.5 * Math.sin(col * 3.42 + row * 4.21);
        const lane = Math.min(2, Math.floor((v / rz + 1) * 1.5));
        positions.push({ x, y, z, t, tint: colors[lane] });
      }
    }
  }
  const foliage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), material, positions.length);
  const blossoms = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), material, positions.length);
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  const set = (mesh, i, x, y, z, w, h, shade) => {
    mesh.setMatrixAt(i, matrix.makeScale(w, h, w).setPosition(x, y, z));
    mesh.setColorAt(i, tint.setHex(shade));
  };
  positions.forEach(({ x, y, z, t, tint }, i) => {
    set(foliage, i, x, y + 0.24, z, 0.42, 0.36 + t * 0.17, i % 2 ? 0x485e31 : 0x627939);
    set(blossoms, i, x, y + 0.62 + t * 0.18, z, 0.28 + t * 0.12, 0.15, tint);
  });
  foliage.name = prefix + 'flower-leaves';
  blossoms.name = prefix + 'flower-blooms';
  for (const mesh of [foliage, blossoms]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  group.add(foliage, blossoms);
}

function drawShore(group, polygon, terrain, waterY, material, name) {
  const batch = new GeoBuilder();
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.01) continue;
      const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
      // 细分到小于地形网格，岸壁略伸入土体并没入水面，覆盖源地形裁边。
      const steps = Math.ceil(length / 3);
      const start = batch.count;
      for (let j = 0; j <= steps; j++) {
        const x = a.x + (b.x - a.x) * j / steps, z = a.z + (b.z - a.z) * j / steps;
        const top = terrainHeight(terrain, x, z);
        batch.vertex(x, Math.max(top ?? waterY, waterY) + 0.02, z, nx, 0, nz, j, 1);
        batch.vertex(x, waterY - 0.15, z, nx, 0, nz, j, 0);
        if (j === 0) continue;
        const k = start + j * 2;
        batch.tri(k - 2, k - 1, k);
        batch.tri(k, k - 1, k + 1);
      }
    }
  }
  const mesh = new THREE.Mesh(batch.build(), material);
  mesh.name = name;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function buildIecGrounds(scene, { terrain, terrainSurface, groundHeight, roadHeight, roadSurfaces, sites, water, paths = [] }) {
  const { site, lake, lakePark, reflectingPool } = sites?.[siteId] ?? {};
  if (!site?.polygons?.length || !lake?.polygons?.length || !lakePark?.polygons?.length) return null;
  const group = new THREE.Group();
  group.name = 'ShenzhenLandmarkGrounds:' + siteId;
  const paved = createIecMaterial('iecPlaza');
  paved.polygonOffset = true;
  paved.polygonOffsetFactor = -2;
  paved.polygonOffsetUnits = -2;
  const green = createIecMaterial('iecGreen');
  green.polygonOffset = true;
  green.polygonOffsetFactor = -1;
  green.polygonOffsetUnits = -1;
  const sidewalkMaterial = createPavingMaterial('light-stone', {
    color: 0xc2bdb2, variation: 0xd6d0c4, jointColor: 0x9e998e,
    tileSizeM: 0.8, roughness: 0.84, depthBias: -3
  });
  const bank = new THREE.MeshStandardNodeMaterial({ color: 0x7b8065, roughness: 0.96, side: THREE.DoubleSide });
  const coping = new THREE.MeshStandardNodeMaterial({ color: 0xccc5b6, roughness: 0.72, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const soil = new THREE.MeshStandardNodeMaterial({ color: 0x536035, roughness: 1,
    polygonOffset: true, polygonOffsetFactor: -1.6, polygonOffsetUnits: -2 });
  const flowers = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.9 });
  const jets = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.05, side: THREE.DoubleSide });
  const surge = smoothstep(0.46, 0.88, fract(uv().y.mul(3).sub(time.mul(1.8))));
  jets.colorNode = mix(color(0x86c2cf), color(0xf0ffff), surge);
  jets.emissiveNode = color(0xafdbed).mul(surge.mul(0.38).add(0.38));
  const walkPath = paths.find(path => path.access === 'public-roadside');
  const parkPath = paths.find(path => path.access === 'unverified');
  const sidewalk = walkPath && coordinates(walkPath.points);
  const buildPath = (path, name) => path
    ? drawGround(group, terrainSurface, prefix + name, [path.osmId],
      stripRing(coordinates(path.points), path.widthM / 2), sidewalkMaterial, roadSurfaces)
    : () => null;
  const ground = (name, source, ring, material = paved) =>
    drawGround(group, terrainSurface, prefix + name, [source.osmId], ring, material, roadSurfaces);
  const path = (name, source, points, width) =>
    ground(name, source, stripRing(coordinates(points), width / 2), sidewalkMaterial);
  const walkHeight = buildPath(walkPath, 'hongli-sidewalk');
  const forecourt = ground('entry-forecourt', site,
    [entryPoint(-27, -3), entryPoint(28, -3), entryPoint(36, 13), entryPoint(27, 23), entryPoint(-24, 23)]);
  const parkHeight = buildPath(parkPath, 'park-path');
  // 铺装与绿地在原地形三角面上裁切，圆池及湖面仍使用原有水域裁口。
  const lakeCourt = ground('lake-court', site, roundedBed([
    [-3029, -122], [-3008, -144], [-2984, -173], [-2968, -173], [-2952, -167],
    [-2941, -153], [-2940, -134], [-2951, -114], [-2974, -106], [-3005, -105]
  ]));
  const shoreWalk = path('shore-walk', lakePark, [
    [-2973, -221], [-2951, -201], [-2935, -174], [-2928, -146],
    [-2922, -121], [-2912, -104], [-2898.9, -90]
  ], 4.7);
  const courtWalk = path('court-walk', site, [[-2944, -142], [-2936, -139], [-2926, -137]], 5.5);
  const frontWalk = path('venue-walk', site, [
    [-3038, 55], [-3008, 52], [-2975, 43], [-2948, 31], [-2941, 2],
    [-2941, -28], [-2945, -56], [-2953, -82], [-2968, -116]
  ], 5.3);
  ground('lakeside-lawn', lakePark, roundedBed([
    [-3015, -181], [-2991, -220], [-2967, -226], [-2935, -197], [-2910, -166],
    [-2906, -126], [-2889, -96], [-2899, -62], [-2912, -16], [-2923, 14],
    [-2960, 43], [-3002, 57], [-3040, 65], [-3051, 45], [-2997, 29],
    [-2990, -20], [-2989, -63], [-3015, -91], [-3032, -126]
  ]), green);
  ground('entry-lawn', site, roundedBed([
    [-3131, 52], [-3100, 46], [-3076, 53], [-3074, 64], [-3092, 74], [-3132, 82]
  ]), green);

  const warm = [0xe5ac41, 0xd43f59, 0xeb6b59];
  const pale = [0x8a70a9, 0xf1e0ca, 0xe49c49];
  const beds = [
    [-2982, -176, 12, 2.6, warm], [-2946, -172, 3.2, 7, pale], [-2952, -106, 7.5, 2.8, warm],
    [-3092, 63, 12.5, 3.1, pale], [-2957, 7, 2.2, 12, pale]
  ].map(([x, z, rx, rz, colors], i) =>
    [x, z, rx, rz, colors, ground('flower-bed:' + i, site, ellipse(x, z, rx, rz), soil)]);
  plantFlowers(group, beds, flowers);
  const lawn = { x: -3018, z: 53 };

  // 用裁地时的同一水体环。两处缺竣工水位，各自按岸线最低地面派生。
  const waters = [];
  for (const [name, feature, insetM] of [['lake', lake, 0.3], ['reflecting-pool', reflectingPool, 0.16]]) {
    if (!feature?.polygons?.length) continue;
    const first = feature.polygons[0].outer[0];
    const shore = water?.find(polygon => polygon.outer.some(p => p.x === first.x && p.z === first.z))
      ?? feature.polygons[0];
    const levels = shore.outer.map(p => terrainHeight(terrain, p.x, p.z)).filter(Number.isFinite);
    if (!levels.length) continue;
    const pool = name === 'reflecting-pool';
    const heightM = Math.min(...levels) + (pool ? 0.16 : -insetM);
    waters.push(buildSzSea(group, { polygons: [shore], heightM, source: { osmId: feature.osmId, heightSource: 'estimate' } },
      { name: prefix + name, coastal: false, cityReflection: !pool }));
    drawShore(group, shore, terrain, heightM, pool ? coping : bank, prefix + name + ':shore');
    if (pool) {
      drawFountain(group, shore, heightM, jets);
      const { outer } = shore;
      const cx = outer.reduce((sum, p) => sum + p.x, 0) / outer.length;
      const cz = outer.reduce((sum, p) => sum + p.z, 0) / outer.length;
      ground('fountain-coping', feature, outer.map(p => ({ x: cx + (p.x - cx) * 1.075, z: cz + (p.z - cz) * 1.075 })), coping);
    }
  }
  scene.add(group);

  const publicHeight = (x, z) => {
    const y = walkHeight(x, z);
    return y === null || Number.isFinite(roadHeight(x, z)) ? null : y;
  };
  function relocateLamp(lamp) {
    if (lamp.median || !Number.isFinite(walkHeight(lamp.x, lamp.z))) return lamp;
    // 合成路灯移到路侧净通行带外，保持灯臂朝向车行道。
    const dx = -Math.cos(lamp.yaw), dz = Math.sin(lamp.yaw);
    for (const distance of [1.8, 2.4, 3, 3.6]) {
      const x = lamp.x + dx * distance, z = lamp.z + dz * distance;
      if (!Number.isFinite(groundHeight(x, z))) continue;
      if (Number.isFinite(walkHeight(x - dx * 0.4, z - dz * 0.4))) continue;
      return { ...lamp, x, z };
    }
    return null;
  }
  const pathHeight = (x, z) => x < -3100 || x > -2770 || z < -230 || z > 142 ? null
    : publicHeight(x, z) ?? frontWalk(x, z)
      ?? courtWalk(x, z) ?? shoreWalk(x, z) ?? parkHeight(x, z) ?? lakeCourt(x, z) ?? forecourt(x, z);
  const sceneryAt = (x, z) => Number.isFinite(pathHeight(x, z))
    || beds.some(([cx, cz, rx, rz]) => ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 <= 1);
  const sign = { x: lawn.x - Math.sin(entry.yaw) * 1.6, z: lawn.z - Math.cos(entry.yaw) * 1.6 };
  const groundAnchor = point => ({ ...point, baseY: groundHeight(point.x, point.z) });
  const anchors = {
    iecGate: { ...groundAnchor(sign), yaw: entry.yaw, widthM: 24, heightM: 2.65, mountM: 0.32 },
    iecFlowerSea: { ...groundAnchor(lawn), yaw: entry.yaw, radiusXM: 14.5, radiusZM: 4.8, conform: true },
    iecFlags: [-10, -6, 6, 10].map(u => groundAnchor(entryPoint(u, 13))),
    iecRobotSites: {
      iecGate: { ...groundAnchor(entryPoint(18, 16)), radiusXM: 1.8, radiusZM: 1.0 },
      iecFlowerSea: { ...groundAnchor({ x: lawn.x - 18, z: lawn.z }), radiusXM: 1.7, radiusZM: 1.0 }
    }
  };

  return {
    group, anchors, sceneryAt, relocateLamp, heightAt: pathHeight,
    walk: sidewalk && { id: walkPath.osmId, points: sidewalk, heightAt: publicHeight },
    blockGenericWalk: (x, z) => x >= -3400 && x <= -2760 && z >= -337 && z <= 145
      && (site.polygons.some(polygon => polygonContains(polygon, x, z))
      || Number.isFinite(pathHeight(x, z))),
    dispose() {
      for (const surface of waters) surface.dispose();
      group.traverse(object => {
        if (object.isMesh) object.geometry.dispose();
        if (object.isInstancedMesh) object.dispose();
      });
      for (const material of [paved, green, sidewalkMaterial, bank, coping, soil, flowers, jets]) material.dispose();
      group.removeFromParent();
    }
  };
}
