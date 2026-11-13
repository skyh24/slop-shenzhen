import * as THREE from 'three/webgpu';
import { distanceToRing, polygonContainsInclusive } from '../sz-polygon.js';
import { disk, parkParts, rectangle, sampleFootprint } from './parts.js';

export const FLOWER_EXPO_ID = 'osm:way/207170378';
// OSM way/450262071 穿过南区花圃之间，沿原通道预留空间。
const EXPO_SERVICE_PATH = [
  [-5924.7, 1171.7], [-5934.5, 1151.2], [-5943.6, 1129.8], [-5945.3, 1118.3], [-5944.4, 1106.8],
  [-5940.5, 1094.4], [-5932.4, 1080.2], [-5921, 1064.2], [-5912.8, 1049.2], [-5905.4, 1033.6], [-5899.7, 1014.7]
];

function nearExpoServicePath(x, z) {
  for (let i = 1; i < EXPO_SERVICE_PATH.length; i++) {
    const [ax, az] = EXPO_SERVICE_PATH[i - 1], [bx, bz] = EXPO_SERVICE_PATH[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) < 4) return true;
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
  const x = -5951, z = 1048;
  const p = planter('expo-flower-terraces', ground);
  const terraceRing = (rx, rz) => ellipse(x, z, rx * 1.72, rz * 1.43, -0.25);
  const outer = terraceRing(13.2, 9.8);
  let y = p.footing(outer, 0.58, STONE);
  const layers = [[12.5, 9.1, VIOLET], [9.1, 6.6, LILAC], [5.4, 3.9, WHITE], [2.3, 1.65, YELLOW]];
  for (const [i, [rx, rz, tint]] of layers.entries()) {
    const ring = terraceRing(rx, rz);
    p.solid(ring, y, y + 0.51, FOLIAGE);
    y += 0.51;
    const next = layers[i + 1];
    const covered = next && { outer: terraceRing(next[0] + 0.22, next[1] + 0.22), holes: [] };
    p.patch(ring, y, 1.08, (a, b) => covered && polygonContainsInclusive(covered, a, b) ? null : tint);
  }
  return p;
}

function ribbon(ground) {
  const x = -5968, z = 1136, length = 55;
  const p = planter('expo-flower-ribbon', ground);
  const center = t => x + 3.75 * Math.sin(t * 2 * Math.PI);
  const band = (left, right) => {
    const side = offset => Array.from({ length: 21 }, (_, i) => {
      const t = i / 20;
      return { x: center(t) + offset * 1.9, z: z - length / 2 + length * t };
    });
    return [...side(right), ...side(left).reverse()];
  };
  const base = p.footing(band(-6.2, 6.2), 0.56, STONE);
  for (const [a, b, height, first, second] of [[-5.6, -2, 0.38, PEACH, YELLOW],
    [-2, 2, 1.15, YELLOW, CREAM], [2, 5.6, 0.56, CRIMSON, CORAL]]) {
    const ring = band(a, b);
    p.solid(ring, base, base + height, SOIL);
    p.patch(ring, base + height, 1.16, (x, z) => Math.sin(z * 0.64 + x * 0.21) > 0.26 ? second : first);
  }
  return p;
}

function apecBed(ground) {
  const x = -5904, z = 1140;
  const widthScale = 1.39, depthScale = 1.48;
  const outline = (u, v, w, d) => rectangle(x + u * widthScale, z + v * depthScale, w * widthScale, d * depthScale);
  const p = planter('expo-flower-apec', ground);
  const base = p.footing(outline(0, 0, 33.4, 17), 0.66, STONE);
  const north = z - 7.8 * depthScale, south = z + 7.8 * depthScale;
  const yAt = b => base + 1.36 - 0.92 * (b - north) / (south - north);
  p.span({ x, z: north, y: yAt(north) }, { x, z: south, y: yAt(south) }, 32 * widthScale, 1.38, FOLIAGE);
  // 字母用两排花冠组成每个笔画，面向南侧游人。
  const cell = 1.12;
  for (const [i, rows] of APEC.entries()) for (const [row, cells] of rows.entries()) {
    for (let col = 0; col < cells.length; col++) {
      if (cells[col] !== '1') continue;
      for (const dx of [-0.25, 0.25]) for (const dz of [-0.25, 0.25]) {
        const a = x + ((i * 6 + col - 11) * cell + dx) * widthScale;
        const b = z + ((row - 3) * cell + dz) * depthScale;
        p.flower(a, b, yAt(b), i % 2 ? WHITE : CREAM, 0.90);
      }
    }
  }
  for (const side of [-1, 1]) {
    p.patch(outline(0, side * 6.1, 30, 2.15), yAt, 0.86,
      (a, b) => Math.sin(a * 0.27 + b * 0.4) > 0 ? VIOLET : CORAL);
    p.patch(outline(side * 14.1, 0, 2.6, 9.6), yAt, 0.87, () => YELLOW);
  }
  return p;
}

export const chinaFlowerBed = ground => rosette('china-flower-peony', ground, -6985, 1434, 1.58);

export function planExpoFlowerBeds({ mapRegions, groundHeight, isWater }, buildings, barrier) {
  const boundary = mapRegions?.regions.find(r => r.id === FLOWER_EXPO_ID)?.polygons[0];
  if (!boundary) return { beds: [], rejected: [] };
  const beds = [], rejected = [];
  for (const p of [rosette('expo-flower-rosette', groundHeight, -5962, 1085, 1.56), terraces(groundHeight),
    ribbon(groundHeight), apecBed(groundHeight)]) {
    const fits = p.parts.every(part => sampleFootprint(part.polygon.outer, (x, z) =>
      polygonContainsInclusive(boundary, x, z) && !barrier.contains(x, z, 2) && !isWater(x, z) && !nearExpoServicePath(x, z)
        && !buildings.some(b => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ
          && polygonContainsInclusive(b.polygon, x, z)), 1.25));
    if (fits) beds.push(p);
    else rejected.push(p.id);
  }
  return { beds, rejected };
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
