import * as THREE from 'three/webgpu';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { roofPanelPart } from '../sz-landmarks/parts.js';
import { resamplePolyline } from '../sz-pedestrian-tracks.js';
import { disk, parkParts } from './parts.js';
import { EXPO_SERVICE_WALK } from './sites.js';

// 保留南区花圃附近的 OSM 服务通道及南侧步行线。
const EXPO_PATHS = [
  // way/450262071
  [[-5924.7, 1171.7], ...EXPO_SERVICE_WALK, [-5912.8, 1049.2], [-5905.4, 1033.6], [-5899.7, 1014.7],
    [-5896.6, 996.8], [-5896.1, 979.9], [-5898, 962.8], [-5899.7, 941.6], [-5898.9, 926.8], [-5896.8, 910.4],
    [-5896.9, 895.8], [-5898.9, 880.7], [-5906.2, 857.6]],
  // way/450262060 与 way/1275488523
  [[-5985.5, 1177.3], [-5976.1, 1177.1], [-5967.4, 1176.5], [-5937, 1173.5], [-5924.7, 1171.7],
    [-5899.7, 1168.1], [-5863.3, 1161], [-5831.8, 1150.7]],
  // way/1241802793
  [[-6042.7, 1234.3], [-5991.9, 1227.7], [-5939.7, 1221], [-5788, 1196]]
];

export function nearExpoPath(x, z, radius = 0) {
  for (const path of EXPO_PATHS) {
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1], [bx, bz] = path[i];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 < (4 + radius) ** 2) return true;
    }
  }
  return false;
}
const STONE = 'flowerStone', SOIL = 'flowerSoil', FOLIAGE = 'flowerFoliage';
const CORAL = 0xf26082, CRIMSON = 0xce3b58, PEACH = 0xffad7f, CREAM = 0xffe5aa;
const VIOLET = 0x9875eb, LILAC = 0xdbb8ff, YELLOW = 0xffca47, WHITE = 0xffefdf;
const APEC = [
  ['01110', '11011', '10001', '11111', '11011', '10001', '10001'],
  ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  ['01111', '10000', '10000', '10000', '10000', '10000', '01111']
];

function planter(id, ground) {
  const p = parkParts(id, ground);
  const blooms = [];
  const flower = (x, z, y, tint, size) => {
    const i = blooms.length;
    const jitter = n => Math.sin(i * n + 0.7);
    blooms.push({ x: x + jitter(8.79) * size * 0.16, z: z + jitter(2.89) * size * 0.16,
      y, tint, size: size * (1 + jitter(4.67) * 0.19), angle: i * 2.39996 });
  };
  const patch = (ring, y, spacing, tintAt) => {
    const minX = Math.min(...ring.map(q => q.x)), maxX = Math.max(...ring.map(q => q.x));
    const minZ = Math.min(...ring.map(q => q.z)), maxZ = Math.max(...ring.map(q => q.z));
    const polygon = { outer: ring, holes: [] };
    for (let row = 0, z = minZ + spacing * 0.6; z < maxZ; z += spacing, row++) {
      for (let x = minX + spacing * (row % 2 ? 0.9 : 0.48); x < maxX; x += spacing) {
        if (!polygonContainsInclusive(polygon, x, z) || distanceToRing(ring, x, z) < spacing * 0.35) continue;
        const tint = tintAt(x, z);
        if (tint !== null) flower(x, z, typeof y === 'function' ? y(z) : y, tint, spacing * 0.76);
      }
    }
  };
  return { ...p, id, blooms, flower, patch };
}

function ellipse(x, z, rx, rz, angle = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return disk(0, 0, 1, 24).map(q => ({
    x: x + q.x * rx * c - q.z * rz * s, z: z + q.x * rx * s + q.z * rz * c
  }));
}

function rosette(id, ground, x, z, scale) {
  const p = planter(id, ground);
  const ring = disk(x, z, 1, 60).map((q, i) => {
    const r = scale * (10 + 2.8 * Math.cos(i * Math.PI / 5));
    return { x: x + (q.x - x) * r, z: z + (q.z - z) * r };
  });
  const base = p.footing(ring, 0.52 * scale, STONE);
  const inner = ring.map(q => ({ x: x + (q.x - x) * 0.93, z: z + (q.z - z) * 0.93 }));
  const top = base + 0.35 * scale;
  p.solid(inner, base, top, SOIL);
  const middle = disk(x, z, 4.0 * scale, 24);
  const crown = top + 0.62 * scale;
  p.loft(middle, disk(x, z, 3.7 * scale, 24), top, crown, FOLIAGE);
  p.patch(inner, top, 0.96 * scale, (a, b) => {
    const r = Math.hypot(a - x, b - z);
    if (r < 4.2 * scale) return null;
    return r < 7.9 * scale ? CRIMSON : Math.sin((a + b) * 8) > 0.6 ? PEACH : CORAL;
  });
  p.patch(middle, crown, 0.79 * scale, (a, b) => Math.hypot(a - x, b - z) < 2 * scale ? CREAM : YELLOW);
  return p;
}

function terraces(ground) {
  const x = -5980, z = 890;
  const p = planter('expo-flower-terraces', ground);
  const terraceRing = (rx, rz) => ellipse(x, z, rx * 2.32, rz * 2, -0.25);
  const outer = terraceRing(13.2, 9.8);
  let y = p.footing(outer, 0.58, STONE);
  const layers = [[12.5, 9.1, VIOLET], [9.1, 6.6, LILAC], [5.4, 3.9, WHITE], [2.3, 1.65, YELLOW]];
  for (const [i, [rx, rz, tint]] of layers.entries()) {
    const ring = terraceRing(rx, rz);
    p.solid(ring, y, y + 0.51, FOLIAGE);
    y += 0.51;
    const next = layers[i + 1];
    const covered = next && { outer: terraceRing(next[0] + 0.22, next[1] + 0.22), holes: [] };
    p.patch(ring, y, 1.27, (a, b) => covered && polygonContainsInclusive(covered, a, b) ? null : tint);
  }
  return p;
}

function roadsideBed(id, ground, side, lettering) {
  const p = planter(id, ground);
  const points = resamplePolyline(EXPO_SERVICE_WALK.map(([x, z]) => ({ x, z })), 5);
  const normal = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return [(b.z - a.z) / length, (a.x - b.x) / length];
  };
  const edge = (q, i, distance) => {
    const a = normal(points[Math.max(0, i - 1)], points[Math.max(1, i)]);
    const b = normal(points[Math.min(i, points.length - 2)], points[Math.min(i + 1, points.length - 1)]);
    const shift = side * distance / (1 + a[0] * b[0] + a[1] * b[1]);
    const x = q.x + shift * (a[0] + b[0]), z = q.z + shift * (a[1] + b[1]);
    const y = ground(x, z);
    return { x, z, y: Number.isFinite(y) ? y + 0.43 : NaN };
  };
  const inner = points.map((q, i) => edge(q, i, 6.2));
  const outer = points.map((q, i) => edge(q, i, 19.6));
  if (![...inner, ...outer].every(q => Number.isFinite(q.y))) return p;
  const lengths = [0];
  for (let i = 1; i < inner.length; i++) {
    const a = inner[i - 1], b = inner[i], c = outer[i - 1], d = outer[i];
    lengths.push(lengths.at(-1) + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    // 同一个截面连接相邻两段，花带随坡转弯，侧壁埋入活动地面。
    for (const triangle of [[a, b, d], [a, d, c]]) {
      const depth = triangle.map(q => q.y - Math.min(a.y, b.y, c.y, d.y) + 0.7);
      p.parts.push(roofPanelPart(`${id}:${p.parts.length}`, { id }, triangle, depth, SOIL,
        { baseSource: 'rendered-terrain' }));
    }
  }
  const total = lengths.at(-1);
  let segment = 1;
  for (let s = 0.68; s < total - 0.65; s += 1.15) {
    while (s > lengths[segment]) segment++;
    const t = (s - lengths[segment - 1]) / (lengths[segment] - lengths[segment - 1]);
    const [a, b, c, d] = [inner[segment - 1], inner[segment], outer[segment - 1], outer[segment]];
    for (let u = 0.055; u < 0.98; u += 0.081) {
      const middle = u <= t ? b : c;
      const middleWeight = Math.abs(t - u), tipWeight = Math.min(t, u);
      const x = a.x + (middle.x - a.x) * middleWeight + (d.x - a.x) * tipWeight;
      const z = a.z + (middle.z - a.z) * middleWeight + (d.z - a.z) * tipWeight;
      const y = a.y + (middle.y - a.y) * middleWeight + (d.y - a.y) * tipWeight;
      // 花字按园路的行进方向排布，浅色花冠与紫色底花分层。
      const col = Math.floor((total * 0.5 + 33 - s) / 2.85);
      const row = Math.floor((0.81 - u) / 0.09);
      const letter = lettering && col >= 0 && col < 23 && APEC[Math.floor(col / 6)][row]?.[col % 6] === '1';
      const tint = lettering ? (letter ? CREAM : u < 0.14 || u > 0.86 ? CORAL : VIOLET)
        : Math.sin(u * 14 + s * 0.20) > 0 ? CORAL : YELLOW;
      p.flower(x, z, y, tint, letter ? 1.05 : 0.9);
    }
  }
  return { ...p, footprint: { outer: [...inner, ...outer.slice().reverse()], holes: [] } };
}

export const chinaFlowerBed = ground => rosette('china-flower-peony', ground, -6985, 1434, 1.58);

export function expoFlowerBeds(ground) {
  return [rosette('expo-flower-rosette', ground, -6120, 1035, 2.04), terraces(ground),
    roadsideBed('expo-flower-ribbon', ground, 1, false), roadsideBed('expo-flower-apec', ground, -1, true)];
}

export function createFlowerCrown() {
  const positions = [0, 0.05, 0], indices = [];
  const sides = 20;
  for (let i = 0; i < sides; i++) {
    const a = i / sides * Math.PI * 2;
    const lobe = (1 + Math.cos(a * 5)) / 2;
    const r = 0.33 + 0.23 * lobe;
    positions.push(Math.cos(a) * r, 0.26 + lobe * 0.36, Math.sin(a) * r);
  }
  positions.push(0, -0.43, 0);
  for (let i = 0; i < sides; i++) {
    const a = i + 1, b = (i + 1) % sides + 1;
    indices.push(0, b, a, sides + 1, a, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function addFlowerCrowns(group, bed, geometry, material) {
  const mesh = new THREE.InstancedMesh(geometry, material, bed.blooms.length);
  mesh.name = `${bed.id}:blooms`;
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  for (const [i, bloom] of bed.blooms.entries()) {
    dummy.position.set(bloom.x, bloom.y + bloom.size * 0.18, bloom.z);
    dummy.scale.set(bloom.size, bloom.size * 0.45, bloom.size);
    dummy.rotation.y = bloom.angle;
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, tint.setHex(bloom.tint));
  }
  mesh.computeBoundingSphere();
  group.add(mesh);
}
